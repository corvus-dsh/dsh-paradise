/**
 * THE STORAGE ADAPTER FOR THIS RUNTIME.
 *
 * WHAT IT IS: small durable state, keyed, atomic, scoped to this plugin's own data directory.
 *
 * WHAT IT DELIBERATELY IS NOT: a general filesystem. `write` takes a KEY, not a path. A caller that
 * could name an absolute path would immediately start writing outside its own namespace, which is
 * how plugins corrupt each other's state — and the functional layer has no legitimate need to.
 *
 * TWO PROPERTIES MATTER, AND THE SECOND ONE WAS MISSING UNTIL v0.4.
 *
 *   1. ATOMICITY. Every write goes to a temp file in the same directory and is renamed into place, so
 *      a reader never observes a half-written document. This host has been killed mid-write before; a
 *      torn binding table is how a pair "disappears".
 *
 *   2. RECOVERABILITY. Atomicity protects against a reader seeing a torn file; it does NOT protect
 *      against a torn file that is already there — a kill around `rename` on a filesystem that does
 *      not guarantee it, a full disk, or a hand-edited file. The previous version answered a corrupt
 *      document with `undefined`, which is the SAME answer it gives for "never stored". A caller could
 *      therefore not tell "your data is gone" from "you never wrote it", and would start from empty and
 *      overwrite the wreckage. Now every write keeps a SNAPSHOT of what it wrote, and a read that finds
 *      a corrupt primary ROLLS BACK to that snapshot and repairs the primary in place. The loss is
 *      bounded to the torn write, and it is REPORTED rather than hidden.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import type { MutationReceipt, StorageAdapter, StorageReadReport } from '../../protocol/index.js'
import { LEASE_RELEASE } from '../../protocol/lease.js'
import { service } from './services.js'

function ok(stage: string, warnings: string[] = []): MutationReceipt {
  return { ok: true, stage, warnings }
}

function failed(stage: string, message: string): MutationReceipt {
  return { ok: false, stage, warnings: [], error: { code: 'STORAGE_FAILED', stage, message } }
}

/** Keys become file names, so they are validated rather than escaped: a bad key is a caller bug. */
const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/iu

/** How long an exclusive-update guard may sit before it is treated as abandoned. */
const GUARD_STALE_MS = 5_000

/** What a `keys()` listing must never show: our own bookkeeping files. */
const INTERNAL_SUFFIX = /\.(bak|guard)$/iu

export function createDshStorageAdapter(ctx: any, config: { dataDir?: string } = {}): StorageAdapter {
  /**
   * WHERE THE FILES GO.
   *
   * An explicit `dataDir` wins (a plugin that owns its namespace passes one). Otherwise this host's
   * paths service, otherwise the process working directory — and the last one is reported as a
   * warning by whoever calls `write`, never silently used as if it were right.
   */
  const baseDir = ((): { dir: string; source: string } => {
    if (typeof config.dataDir === 'string' && config.dataDir.trim().length > 0) {
      return { dir: config.dataDir.trim(), source: 'config' }
    }
    const paths = service(ctx, 'paths')
    if (typeof paths?.data === 'string' && paths.data.length > 0) return { dir: paths.data, source: 'paths.data' }
    const env = process.env.DSH_PROFILE_DIR
    if (typeof env === 'string' && env.trim().length > 0) {
      return { dir: join(env.trim(), 'data', 'dsh-paradise'), source: 'DSH_PROFILE_DIR' }
    }
    return { dir: join(process.cwd(), 'data', 'dsh-paradise'), source: 'cwd-fallback' }
  })()

  const pathOf = (key: string): string => join(baseDir.dir, `${key}.json`)
  /** The last known-good value, written AFTER the primary so a tear can be rolled back. */
  const snapshotOf = (key: string): string => `${pathOf(key)}.bak`
  /** One serialization for both copies, so they cannot drift. */
  const serialize = (value: unknown): string => JSON.stringify(value ?? null, null, 2)

  /** Write text to `target` atomically: same-directory temp file, then rename over the target. */
  function atomicWriteText(target: string, text: string): void {
    mkdirSync(dirname(target), { recursive: true })
    const temp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`
    try {
      writeFileSync(temp, text, 'utf8')
      renameSync(temp, target)
    } catch (error) {
      try {
        rmSync(temp, { force: true })
      } catch {
        // A leftover temp file is noise that `keys()` hides; failing to remove it must not mask the
        // real error.
      }
      throw error
    }
  }

  /** Parse a file. `found` distinguishes "missing" from "present but unreadable". */
  function parseFile(path: string): { found: boolean; ok: boolean; value?: unknown } {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch (error) {
      // SAME DISTINCTION AS THE LEASE SYNC DRIVER. A missing file is "not found"; a transient sharing
      // violation is "present but unreadable". For compareAndSet those must not lead to the same
      // decision, or a racing writer is granted a lock somebody else already holds.
      if (String((error as any)?.code ?? '') === 'ENOENT') return { found: false, ok: false }
      return { found: true, ok: false }
    }
    try {
      return { found: true, ok: true, value: JSON.parse(text) }
    } catch {
      return { found: true, ok: false }
    }
  }

  function readDetailed(key: string): StorageReadReport {
    if (!KEY_PATTERN.test(key)) {
      return { value: undefined, status: 'missing', warnings: [`非法 key：${JSON.stringify(key)}`] }
    }
    const primary = parseFile(pathOf(key))
    if (primary.ok) return { value: primary.value, status: 'ok', warnings: [] }

    /**
     * THE PRIMARY IS UNREADABLE (or absent). Consult the snapshot.
     *
     * `missing` and `corrupt` are DIFFERENT ANSWERS on purpose: a caller that lost data must be able to
     * say so, and a caller that never stored anything must not be told its data was damaged.
     */
    const snapshot = parseFile(snapshotOf(key))
    if (!snapshot.ok) {
      return primary.found
        ? { value: undefined, status: 'corrupt', warnings: [`${key}.json 无法解析，且没有可用快照`] }
        : { value: undefined, status: 'missing', warnings: [] }
    }
    const warnings = [
      primary.found
        ? `${key}.json 已损坏（半截或不合法 JSON），已回滚到上一个快照`
        : `${key}.json 不存在但快照仍在，已从快照恢复`,
    ]
    try {
      // Repair the primary so the NEXT read is a plain `ok` and the recovery is durable.
      atomicWriteText(pathOf(key), serialize(snapshot.value))
    } catch (error) {
      /**
       * A failed repair is NOT a failed read: the caller still gets its data. Saying so matters,
       * because an unrepaired primary recovers again on every read — a cost, not a lie.
       */
      warnings.push(`快照已读出，但主文件修复失败：${String((error as any)?.message ?? error)}`)
    }
    return { value: snapshot.value, status: 'recovered', warnings }
  }

  const adapter: StorageAdapter = {
    name: 'dsh-storage',

    async read(key: string): Promise<unknown> {
      return readDetailed(key).value
    },

    /**
     * The same read, WITH the diagnosis. Optional in the protocol (see `StorageReadReport`), so a
     * naive host can implement `read` alone and stay conformant.
     */
    async readDetailed(key: string): Promise<StorageReadReport> {
      return readDetailed(key)
    },

    async write(key: string, value: unknown): Promise<MutationReceipt> {
      if (!KEY_PATTERN.test(key)) return failed('write', `非法 key：${JSON.stringify(key)}`)
      const target = pathOf(key)
      const warnings: string[] = []
      if (baseDir.source === 'cwd-fallback') {
        warnings.push(`数据目录回落到 process.cwd()（${baseDir.dir}），宿主没有提供 paths 服务`)
      }
      try {
        const text = serialize(value)
        atomicWriteText(target, text)
        /**
         * THE SNAPSHOT IS A COPY OF WHAT WAS JUST WRITTEN, not of what was there before.
         *
         * Taking it AFTER the primary is what makes the pair safe: the primary is then always at least
         * as new as the snapshot, and the snapshot is a known-good document by construction (a copy of
         * a successful write). Snapshotting the PREVIOUS value would mean writing the snapshot first,
         * and a tear there would be indistinguishable from a tear in the primary — losing the only
         * good copy.
         *
         * The cost is one extra small write per `write`. For keyed durable state that is the right
         * trade: the alternative is a silent empty restart.
         */
        try {
          atomicWriteText(snapshotOf(key), text)
        } catch (error) {
          warnings.push(`主文件已写入，但快照失败（本次数据是安全的）：${String((error as any)?.message ?? error)}`)
        }
        return ok('write', warnings)
      } catch (error) {
        return { ...failed('write', String((error as any)?.message ?? error)), warnings }
      }
    },

    async remove(key: string): Promise<MutationReceipt> {
      if (!KEY_PATTERN.test(key)) return failed('remove', `非法 key：${JSON.stringify(key)}`)
      try {
        // Idempotent by construction: `force` makes a missing file a success.
        rmSync(pathOf(key), { force: true })
        /**
         * THE SNAPSHOT GOES WITH IT. Leaving it behind would let a later corrupt write "recover" data
         * the caller deliberately deleted — a resurrection, which is worse than a loss because it
         * looks like a successful read.
         */
        rmSync(snapshotOf(key), { force: true })
        return ok('remove')
      } catch (error) {
        return failed('remove', String((error as any)?.message ?? error))
      }
    },

    async keys(prefix?: string): Promise<string[]> {
      try {
        return readdirSync(baseDir.dir)
          .filter((name) => name.endsWith('.json'))
          .filter((name) => !INTERNAL_SUFFIX.test(name))
          .map((name) => name.slice(0, -'.json'.length))
          .filter((key) => (prefix === undefined ? true : key.startsWith(prefix)))
      } catch {
        return []
      }
    },

    /**
     * COMPARE-AND-SET — the primitive a lease is built from.
     *
     * WHY IT NEEDS A GUARD FILE rather than just read-then-write: `read` and `write` are each atomic,
     * but the PAIR is not. Two processes can both read "no lease", both decide they may take it, and
     * both write — precisely the lost update a lease exists to prevent.
     *
     * The guard is created with `wx` (atomic exclusive create), so exactly one caller wins it. A guard
     * left behind by a killed process is STOLEN after `GUARD_STALE_MS`, because the alternative is a
     * permanently locked key — a deadlock no timeout can rescue, since the holder will never return.
     *
     * `verify` receives the current value (or `undefined`) and returns the next value, or `undefined`
     * to refuse. It runs INSIDE the guard, so its decision cannot interleave with another writer.
     */
    async compareAndSet(
      key: string,
      verify: (current: unknown) => unknown | undefined,
    ): Promise<{ ok: boolean; value?: unknown; warnings: string[] }> {
      if (!KEY_PATTERN.test(key)) {
        return { ok: false, warnings: [`非法 key：${JSON.stringify(key)}`] }
      }
      const guard = `${pathOf(key)}.guard`
      const warnings: string[] = []
      let guardFd: number | undefined
      try {
        mkdirSync(dirname(guard), { recursive: true })
        const deadline = Date.now() + 2_000
        for (;;) {
          try {
            guardFd = openSync(guard, 'wx')
            break
          } catch (error) {
            if ((error as any)?.code !== 'EEXIST') throw error
            let age = 0
            try {
              age = Date.now() - statSync(guard).mtimeMs
            } catch {
              age = GUARD_STALE_MS + 1
            }
            if (age > GUARD_STALE_MS) {
              warnings.push(`回收了过期的更新守卫（${Math.round(age)}ms），上一持有者可能已崩溃`)
              try {
                unlinkSync(guard)
              } catch {
                // Someone else won the steal; the loop retries.
              }
              continue
            }
            if (Date.now() > deadline) {
              return { ok: false, warnings: [...warnings, '更新守卫繁忙，未在期限内取得'] }
            }
            // Bounded, tiny pause: this is a short critical section, not a queue.
            try {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
            } catch {
              // Without `Atomics.wait` (rare) the loop simply spins; the deadline still bounds it.
            }
          }
        }

        /**
         * DECIDE ONLY AGAINST A CLEANLY READ VALUE.
         *
         * `readDetailed` reports `recovered` when the primary was unreadable and the value came from
         * the snapshot, and `corrupt` when neither could be read. Either way the value may be older
         * than what another writer is committing right now, and deciding against a STALE value is
         * how a compare-and-set grants something it should have refused. Refusing costs a retry.
         */
        const observation = readDetailed(key)
        if (observation.status === 'recovered' || observation.status === 'corrupt') {
          return { ok: false, warnings: [...warnings, `${key} 当前记录未能干净读出（${observation.status}），拒绝在不干净的值上做 CAS`] }
        }
        const current = observation.value
        const next = verify(current)
        if (next === undefined) return { ok: false, warnings }
        /**
         * A RELEASE IS A READ-MODIFY-WRITE WHOSE RESULT IS ABSENCE. The sentinel keeps it inside this
         * one primitive instead of adding a second, subtly different, compare-and-remove — and, like
         * any other CAS decision, it was made INSIDE the guard, against the value that decision was
         * made about.
         */
        if (next === LEASE_RELEASE) {
          const receipt = await adapter.remove(key)
          return { ok: receipt.ok, warnings: [...warnings, ...receipt.warnings] }
        }
        const receipt = await adapter.write(key, next)
        if (!receipt.ok) {
          return { ok: false, warnings: [...warnings, ...receipt.warnings] }
        }
        /**
         * VERIFY-AFTER-WRITE — the same discipline the lease sync driver applies.
         *
         * `write` is a rename, so a writer that shared our guard would silently overwrite us. Re-reading
         * the value and comparing it to what we just wrote detects that, and turning it into a refusal is
         * what keeps "two writers shared the guard" from becoming "one of them silently lost".
         */
        const confirmed = JSON.stringify(readDetailed(key).value) === JSON.stringify(next)
        if (!confirmed) {
          return { ok: false, warnings: [...warnings, `${key} 写入后校验失败：磁盘上的值不是本次写入的（可能是守卫被抢占）`] }
        }
        return { ok: true, value: next, warnings: [...warnings, ...receipt.warnings] }
      } catch (error) {
        return { ok: false, warnings: [...warnings, String((error as any)?.message ?? error)] }
      } finally {
        if (guardFd !== undefined) {
          try {
            closeSync(guardFd)
          } catch {
            // Closing an already-closed descriptor is not a failure.
          }
        }
        try {
          rmSync(guard, { force: true })
        } catch {
          // A guard that outlives its holder is stolen by the age check above.
        }
      }
    },
  }

  return adapter
}
