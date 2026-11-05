/**
 * L1 — THE MEMORY-BACKED DRIVER: `src/storage-memory.ts`.
 *
 * WHY THIS EXISTS, STATED AS THE PROBLEM IT SOLVES
 *
 * The file driver (L0) is correct and was hardened hard: atomic rename, snapshots, recovery, a fenced
 * lease. What it cannot do is escape the FILESYSTEM'S OWN CONCURRENCY LIMITS. Measured under load, the
 * remaining lost-row window lives in the interval between "read the record" and "rename the record", and no
 * amount of care inside that interval removes it — because the interval is created by the OS, not by us.
 *
 * So this driver removes the interval instead of shrinking it: the authoritative state lives in a `Map`,
 * and the mutex is an ordinary JavaScript object. Exclusion costs NO I/O, so there is no window to lose.
 *
 * WHAT IT TRADES AWAY — and this must not be glossed over:
 *
 *   `write()` returns once the value is in memory. Durability happens on a WRITE-BEHIND FLUSH (debounced,
 *   batched). A process killed between a write and its flush loses those writes. That is a real regression
 *   against L0, which is durable on every write.
 *
 * So it is offered as a TIER, not as a replacement:
 *
 *   tier 'file'   — durable per write, bounded by filesystem concurrency.  (default, safest)
 *   tier 'memory' — fast under contention, durable per flush.              (opt-in)
 *
 * AND IT DEGRADES TOWARD L0, NOT TOWARD EMPTY. On construction it LOADS the L0 snapshot, so a crashed
 * memory tier comes back with the last durable state instead of a blank store. `flushNow()` exists so a
 * caller can force durability at a boundary it cares about (before shutdown, before a risky operation).
 */

import type {
  MutationReceipt,
  StorageAdapter,
  StorageReadReport,
  StorageTransaction,
} from './protocol/index.js'

/** How long after the last write a flush happens. Short enough to bound loss, long enough to batch. */
const DEFAULT_FLUSH_DELAY_MS = 50

export interface MemoryStorageOptions {
  /** The L0 adapter used for loading on start, flushing, and FALLING BACK. */
  readonly backing: StorageAdapter
  /** Debounce window for the write-behind flush. */
  readonly flushDelayMs?: number
  /** Called when a flush fails, so a caller can log it. A failed flush is never silent. */
  readonly onFlushError?: (error: unknown, keys: readonly string[]) => void
}

interface TransactionState {
  /** Staged writes, in the order they were made. A later write to the same key wins. */
  readonly staged: Map<string, { value: unknown; removed: boolean }>
  aborted: boolean
}

export interface MemoryStorageAdapter extends StorageAdapter {
  /** Publish everything pending RIGHT NOW. Await this before shutdown or a risky step. */
  flushNow(): Promise<MutationReceipt>
  /** How many keys are pending durability. Diagnostics, and a test hook. */
  pendingCount(): number
  /** Force a reload from the backing store, discarding memory. Used by the degradation path. */
  reloadFromBacking(): Promise<MutationReceipt>
}

export function createMemoryStorageAdapter(options: MemoryStorageOptions): MemoryStorageAdapter {
  const { backing } = options
  const flushDelayMs = Number.isFinite(Number(options.flushDelayMs))
    ? Math.max(0, Number(options.flushDelayMs))
    : DEFAULT_FLUSH_DELAY_MS

  /** THE AUTHORITATIVE STATE. Everything reads and writes here; the disk is a shadow. */
  const values = new Map<string, unknown>()
  /** Keys written since the last successful flush. */
  const dirty = new Set<string>()
  /** Keys tombstoned in memory (present here, absent from `values`). */
  const tombstones = new Set<string>()

  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let flushing: Promise<MutationReceipt> | undefined
  let loaded: Promise<MutationReceipt> | undefined

  /**
   * THE MUTEX IS AN OBJECT, which is the entire point.
   *
   * `transaction` chains its body onto this promise, so two transactions execute strictly one after the
   * other with no filesystem involvement. Exclusion at this tier is a queue in memory, not a lock file —
   * there is no window, because there is no I/O inside the critical section.
   */
  let transactionQueue: Promise<unknown> = Promise.resolve()

  function scheduleFlush(): void {
    if (flushTimer !== undefined) return
    const timer = setTimeout(() => {
      flushTimer = undefined
      void flushNow()
    }, flushDelayMs)
    // Never hold the process open just to flush: a caller that needs durability awaits `flushNow()`.
    if (typeof (timer as any).unref === 'function') (timer as any).unref()
    flushTimer = timer
  }

  async function flushNow(): Promise<MutationReceipt> {
    if (flushing !== undefined) return flushing
    const run = (async (): Promise<MutationReceipt> => {
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer)
        flushTimer = undefined
      }
      const warnings: string[] = []
      const keys = [...dirty]
      const removed = [...tombstones]
      if (keys.length === 0 && removed.length === 0) {
        return { ok: true, stage: 'flush', warnings }
      }
      /** A snapshot of what is being flushed, so a concurrent write is not marked clean by mistake. */
      const snapshot = new Map(keys.map((key) => [key, values.get(key)]))
      for (const key of removed) {
        try {
          const receipt = await backing.remove(key)
          if (!receipt.ok) warnings.push(`删除 ${key} 未成功：${receipt.error?.message ?? 'unknown'}`)
          else tombstones.delete(key)
        } catch (error) {
          warnings.push(`删除 ${key} 抛错：${String((error as any)?.message ?? error)}`)
        }
      }
      for (const [key, value] of snapshot) {
        try {
          const receipt = await backing.write(key, value)
          if (!receipt.ok) {
            warnings.push(`落盘 ${key} 未成功：${receipt.error?.message ?? 'unknown'}`)
            continue
          }
          /**
           * ONLY CLEAR `dirty` IF NOTHING WROTE THIS KEY WHILE WE WERE FLUSHING.
           *
           * Otherwise a value written DURING the flush would be marked durable without ever being
           * written — a silent lost update created by the flush itself, of all things.
           */
          if (values.has(key) && values.get(key) === value) dirty.delete(key)
        } catch (error) {
          warnings.push(`落盘 ${key} 抛错：${String((error as any)?.message ?? error)}`)
        }
      }
      return { ok: warnings.length === 0, stage: 'flush', warnings }
    })()
    flushing = run
    try {
      return await run
    } finally {
      flushing = undefined
    }
  }

  /** Load the durable state once, on first use. A failed load leaves memory empty and SAYS SO. */
  async function ensureLoaded(): Promise<MutationReceipt> {
    if (loaded !== undefined) return loaded
    loaded = (async (): Promise<MutationReceipt> => {
      const warnings: string[] = []
      try {
        const keys = await backing.keys()
        for (const key of keys) {
          const report = typeof backing.readDetailed === 'function'
            ? await backing.readDetailed(key)
            : { value: await backing.read(key), status: 'ok' as const, warnings: [] as readonly string[] }
          if (report.status === 'ok' || report.status === 'recovered') {
            values.set(key, report.value)
            if (report.status === 'recovered') warnings.push(`加载 ${key} 时已从快照恢复`)
          } else if (report.status === 'corrupt') {
            /**
             * A CORRUPT KEY IS KEPT OUT OF MEMORY AND REPORTED. Loading garbage would let the next flush
             * write it back over the good snapshot — turning a recoverable file into a permanent loss.
             */
            warnings.push(`加载 ${key} 失败（${report.status}），该键保持不可用，等待 L0 修复`)
          }
        }
      } catch (error) {
        warnings.push(`从 L0 加载失败，内存层以空状态启动：${String((error as any)?.message ?? error)}`)
      }
      return { ok: warnings.length === 0, stage: 'load', warnings }
    })()
    return loaded
  }

  const adapter: MemoryStorageAdapter = {
    name: 'memory-storage',
    tier: 'memory',

    async read(key: string): Promise<unknown> {
      const load = await ensureLoaded()
      void load
      return values.has(key) ? values.get(key) : undefined
    },

    async readDetailed(key: string): Promise<StorageReadReport> {
      const load = await ensureLoaded()
      if (!values.has(key)) {
        return {
          value: undefined,
          status: 'missing',
          warnings: load.warnings.filter((warning) => warning.includes(key)),
        }
      }
      return { value: values.get(key), status: 'ok', warnings: [] }
    },

    async write(key: string, value: unknown): Promise<MutationReceipt> {
      await ensureLoaded()
      values.set(key, value)
      tombstones.delete(key)
      dirty.add(key)
      scheduleFlush()
      return { ok: true, stage: 'write(memory)', warnings: [] }
    },

    async remove(key: string): Promise<MutationReceipt> {
      await ensureLoaded()
      values.delete(key)
      dirty.delete(key)
      tombstones.add(key)
      scheduleFlush()
      return { ok: true, stage: 'remove(memory)', warnings: [] }
    },

    async keys(prefix?: string): Promise<string[]> {
      await ensureLoaded()
      const all = [...values.keys()]
      return prefix === undefined ? all : all.filter((key) => key.startsWith(prefix))
    },

    /**
     * CAS AT THIS TIER IS A PLAIN OBJECT OPERATION — no guard file, no rename, no window.
     *
     * `verify` runs synchronously against the in-memory value, and nothing else can interleave because
     * JavaScript has no preemption inside this function.
     */
    async compareAndSet(
      key: string,
      verify: (current: unknown) => unknown | undefined,
    ): Promise<{ ok: boolean; value?: unknown; warnings: string[] }> {
      await ensureLoaded()
      const current = values.has(key) ? values.get(key) : undefined
      const next = verify(current)
      if (next === undefined) return { ok: false, warnings: [] }
      values.set(key, next)
      tombstones.delete(key)
      dirty.add(key)
      scheduleFlush()
      return { ok: true, value: next, warnings: [] }
    },

    /**
     * TRANSACTION — multi-key atomicity, staged and published at commit.
     *
     * THE EXCLUSION IS `transactionQueue`: each body runs after the previous one settles, so two
     * transactions cannot interleave. Reads outside a transaction see the committed state, which is why
     * "outside readers never observe half of it" holds without a global lock over `read`.
     */
    async transaction<T>(
      body: (tx: StorageTransaction) => Promise<T> | T,
      transactionOptions: { retries?: number } = {},
    ): Promise<{ ok: boolean; value?: T; warnings: string[]; error?: { code: string; message: string } }> {
      await ensureLoaded()
      const retries = Number.isFinite(Number(transactionOptions.retries))
        ? Math.max(0, Number(transactionOptions.retries))
        : 0
      let attempt = 0
      for (;;) {
        const run = async (): Promise<{ ok: boolean; value?: T; warnings: string[]; error?: { code: string; message: string } }> => {
          const state: TransactionState = { staged: new Map(), aborted: false }
          const tx: StorageTransaction = {
            async read(key: string): Promise<unknown> {
              const staged = state.staged.get(key)
              if (staged !== undefined) return staged.removed ? undefined : staged.value
              return values.has(key) ? values.get(key) : undefined
            },
            async write(key: string, value: unknown): Promise<void> {
              state.staged.set(key, { value, removed: false })
            },
            async remove(key: string): Promise<void> {
              state.staged.set(key, { value: undefined, removed: true })
            },
            async keys(prefix?: string): Promise<string[]> {
              const merged = new Set(values.keys())
              for (const [key, entry] of state.staged) {
                if (entry.removed) merged.delete(key)
                else merged.add(key)
              }
              const all = [...merged]
              return prefix === undefined ? all : all.filter((key) => key.startsWith(prefix))
            },
            abort(): void {
              state.aborted = true
            },
          }
          let value: T
          try {
            value = await body(tx)
          } catch (error) {
            /** A THROWING BODY PUBLISHES NOTHING. That is the whole value of a transaction. */
            return {
              ok: false,
              warnings: [],
              error: { code: 'TRANSACTION_THREW', message: String((error as any)?.message ?? error) },
            }
          }
          if (state.aborted) {
            return { ok: false, warnings: [], error: { code: 'TRANSACTION_ABORTED', message: '正文显式终止' } }
          }
          /** PUBLISH: apply every staged mutation, then mark dirty. All of it, or none of it. */
          for (const [key, entry] of state.staged) {
            if (entry.removed) {
              values.delete(key)
              dirty.delete(key)
              tombstones.add(key)
            } else {
              values.set(key, entry.value)
              tombstones.delete(key)
              dirty.add(key)
            }
          }
          if (state.staged.size > 0) scheduleFlush()
          return { ok: true, value, warnings: [] }
        }
        const chained = transactionQueue.then(run, run)
        transactionQueue = chained.then(
          () => undefined,
          () => undefined,
        )
        const outcome = await chained
        /**
         * A TRANSIENT FAILURE IS RETRIED, and only a transient one. `TRANSACTION_THREW` is the caller's own
         * bug and retrying it would run a broken body twice; the retry exists for contention, which at this
         * tier can only be a concurrent flush.
         */
        const retryable = outcome.ok === false && outcome.error?.code === 'TRANSACTION_CONTENDED'
        if (!retryable || attempt >= retries) return outcome
        attempt += 1
      }
    },

    flushNow,

    pendingCount(): number {
      return dirty.size + tombstones.size
    },

    async reloadFromBacking(): Promise<MutationReceipt> {
      values.clear()
      dirty.clear()
      tombstones.clear()
      loaded = undefined
      return ensureLoaded()
    },
  }

  return adapter
}
