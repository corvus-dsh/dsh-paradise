/**
 * THE STORAGE TIER FACTORY — `src/storage-tiers.ts`.
 *
 * WHY A FACTORY AND NOT A CONSTRUCTOR CALL AT EACH SITE
 *
 * The user's requirement is "按需抗压": a profile picks a tier, and the plugins instantiate whichever
 * adapter that tier names WITHOUT importing a concrete class. That only works if the choice, the
 * fallback, and the reporting live in one place — otherwise each plugin re-implements "memory, but fall
 * back to file if it breaks", and they drift.
 *
 * THE TWO TIERS, AND WHAT EACH ONE PROMISES
 *
 *   'file'   durable on every write. Atomic rename + snapshot recovery. Bounded by the filesystem's own
 *            concurrency limits — the boundary documented as TD-M8.
 *
 *   'memory' mutexes are objects, so exclusion costs no I/O and there is no read-modify-write window to
 *            lose. Durability is WRITE-BEHIND: a crash between a write and its flush loses those writes.
 *            It loads the L0 snapshot on start, so a crashed memory tier comes back with the last durable
 *            state rather than an empty store.
 *
 * THE FALLBACK IS THE INTERESTING PART
 *
 * A memory tier that cannot even LOAD from disk is worse than useless: it looks healthy and writes into a
 * void. So construction PROBES the backing store, and on failure returns the FILE adapter with a warning
 * that names what happened. The caller never gets a silent downgrade — it gets the real adapter plus the
 * reason.
 */

import type { StorageAdapter, MutationReceipt } from './protocol/index.js'
import { createMemoryStorageAdapter, type MemoryStorageAdapter } from './storage-memory.js'

export type StorageTier = 'file' | 'memory'

export interface StorageTierChoice {
  /** The adapter the caller should use. NEVER null: a failed memory tier degrades to the file one. */
  readonly adapter: StorageAdapter
  /** Which tier is ACTUALLY live — not which one was requested. */
  readonly tier: StorageTier
  /** Non-empty when the request was downgraded, or when a tier reported a concern. */
  readonly warnings: readonly string[]
  /** Present when the memory tier was built, so a caller can force durability at a boundary. */
  readonly memory?: MemoryStorageAdapter
}

/**
 * Build the storage adapter for a tier.
 *
 * `fileAdapter` is REQUIRED even when `tier` is `'memory'`: it is the durability anchor (the memory tier
 * flushes through it) and the fallback (a memory tier that cannot load degrades to it).
 */
export async function chooseStorageTier(
  tier: StorageTier,
  fileAdapter: StorageAdapter,
  options: { flushDelayMs?: number; onFlushError?: (error: unknown, keys: readonly string[]) => void } = {},
): Promise<StorageTierChoice> {
  if (tier !== 'memory') {
    return { adapter: fileAdapter, tier: 'file', warnings: [] }
  }

  /** PROBE BEFORE TRUSTING: a memory layer over an unreadable anchor would silently lose everything. */
  const probe: MutationReceipt = await (async () => {
    try {
      await fileAdapter.keys()
      return { ok: true, stage: 'probe', warnings: [] }
    } catch (error) {
      return {
        ok: false,
        stage: 'probe',
        warnings: [`L0 存储不可读：${String((error as any)?.message ?? error)}`],
      }
    }
  })()

  if (!probe.ok) {
    return {
      adapter: fileAdapter,
      tier: 'file',
      warnings: [
        ...probe.warnings,
        '请求的是 memory 层，但它的持久锚点不可用，已降级为 file 层（数据不会丢，只是慢）',
      ],
    }
  }

  const memory = createMemoryStorageAdapter({
    backing: fileAdapter,
    ...(options.flushDelayMs === undefined ? {} : { flushDelayMs: options.flushDelayMs }),
    ...(options.onFlushError === undefined ? {} : { onFlushError: options.onFlushError }),
  })

  /** Force the initial load NOW, so a broken anchor degrades here rather than at first read. */
  const loaded = await memory.reloadFromBacking()
  if (!loaded.ok) {
    return {
      adapter: fileAdapter,
      tier: 'file',
      warnings: [
        ...loaded.warnings,
        'memory 层无法从 L0 加载，已降级为 file 层（继续用磁盘，避免在半空状态上写入）',
      ],
    }
  }

  return { adapter: memory, tier: 'memory', warnings: [], memory }
}

/** The tiers this layer implements, for a config validator to accept. */
export const STORAGE_TIERS: readonly StorageTier[] = ['file', 'memory']

/** Parse a configured value, defaulting to the SAFE tier rather than the fast one. */
export function parseStorageTier(value: unknown): StorageTier {
  return value === 'memory' ? 'memory' : 'file'
}
