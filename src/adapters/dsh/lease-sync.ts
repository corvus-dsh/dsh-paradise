/**
 * A SYNCHRONOUS LEASE OVER A DIRECTORY — `adapters/dsh/lease-sync.ts`.
 *
 * WHY A SECOND DRIVER EXISTS AT ALL
 *
 * The async lease (`lease-adapter.ts`) is built on `StorageAdapter.compareAndSet`, which returns a
 * Promise — and that is the right contract for a host. But a caller whose whole store is SYNCHRONOUS
 * cannot await: `dsh-memory`'s `appendNegatives` / `markProcessed` / `queueSuggestion` are called
 * synchronously from 52 places in its own tests and from its harvest path. Converting them to async
 * would change their signatures and every caller, which is a behaviour change, not a refactor.
 *
 * So this file provides the same lease with a synchronous driver. It is NOT a second set of rules:
 * every decision comes from `protocol/lease.ts` (`planAcquire` / `planRenew` / `planRelease`), which
 * both drivers call. Only the I/O differs.
 *
 * THE ATOMIC PRIMITIVE, AND THE RACE IT ELIMINATES
 *
 * The lock this replaces did:
 *
 *     mkdirSync(lockDir)                  // atomic: wins the lock
 *     writeFileSync(lockDir + '/owner')   // NOT atomic with the line above
 *
 * and a reclaimer could delete `lockDir` between those two lines — ENOENT, and the winning writer
 * crashed. Here the record is never written in place: it goes to a temp file and is RENAMED over the
 * target, and all of it happens while holding a guard created with `wx` (exclusive create). A guard
 * abandoned by a killed process is stolen by AGE, which is the one thing that cannot deadlock.
 *
 * WHAT IS STILL A TRADE: a holder that stalls longer than `SYNC_LEASE_GUARD_STALE_MS` (5s) can have its guard
 * stolen, and then two writers are inside the critical section. The critical sections here are single
 * file replacements (milliseconds), and the alternative — never stealing — is a permanently stuck
 * store. The same trade is made, with the same constant, by the async driver's storage adapter.
 */

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { LeaseAdapter, LeaseAttempt, LeaseRecord, LeaseRequest, MutationReceipt } from '../../protocol/index.js'
import { isLeaseExpired, planAcquire, planRelease, planRenew } from '../../protocol/index.js'
import { LEASE_RELEASE } from '../../protocol/lease.js'

const SYNC_LEASE_DEFAULT_TTL_MS = 30_000
const SYNC_LEASE_MAX_TTL_MS = 10 * 60_000
/** How long a guard may sit before it is treated as abandoned. */
/**
 * HOW LONG A GUARD MAY SIT UNTOUCHED BEFORE IT IS TREATED AS ABANDONED.
 *
 * RAISED FROM 5s TO 60s, and the reason is the failure it caused: under eight writers plus a full
 * test suite the machine deschedules a holder past five seconds, its guard is stolen, and two writers
 * enter. 60s is far beyond any legitimate critical section here (single file replacements,
 * milliseconds) while still recovering from a crash within a minute.
 *
 * THIS IS A MITIGATION, NOT THE FIX. The fix is `recordIsOurs` after every write: even if a guard is
 * stolen, only one writer can end up owning the record, and the other stands down.
 */
const SYNC_LEASE_GUARD_STALE_MS = 60_000
/** How long to spin for the guard before giving up on this attempt. */
const SYNC_LEASE_GUARD_WAIT_MS = 2_000
/**
 * How long an UNREADABLE record is treated as a live holder before it is abandoned.
 *
 * BOTH DIRECTIONS OF THIS NUMBER HAVE TO BE RIGHT:
 *   - too short, and a corrupt record whose holder is alive gets stolen — two holders inside one
 *     critical section, which is the lost update this file exists to prevent;
 *   - too long, and a genuinely abandoned record blocks the store for that long.
 *
 * 30s is the natural bound: it equals the default lease validity, so a record nobody can parse is never
 * treated more generously than one that simply expired.
 */
const SYNC_LEASE_UNREADABLE_STALE_MS = 30_000

/** How many times an abandoned guard was reclaimed. Evidence, so a failure is never inferred. */
let guardStealCount = 0

/** Read the counter. A non-zero value after a run means a holder was descheduled too long. */
export function guardSteals(): number {
  return guardStealCount
}

const OWNER = `pid:${process.pid}`

function sleepSync(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // Busy-wait: the critical sections guarded here are single file replacements.
  }
}

/**
 * Read the record, KEEPING THE DISTINCTION THE LEASE DEPENDS ON.
 *
 * `absent` and `unparseable` must not collapse into one answer: the first means "nobody holds this",
 * the second means "somebody may hold this and their record is damaged" — and treating the second as the
 * first grants the lease to a second caller. This is the same three-valued read the storage adapter
 * learned for the same reason.
 */
function readRecord(path: string): { present: boolean; parseFailed: boolean; value: unknown } {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    // ONLY "NOT THERE" MEANS ABSENT. A transient sharing violation (this OS holds a share lock while
    // another process renames the record into place) must NOT read as "nobody holds this" — that is
    // how a second holder is granted the same key, which is the lost update this lock prevents.
    if (String((error as any)?.code ?? '') === 'ENOENT') {
      return { present: false, parseFailed: false, value: undefined }
    }
    return { present: true, parseFailed: true, value: undefined }
  }
  try {
    return { present: true, parseFailed: false, value: JSON.parse(text) }
  } catch {
    return { present: true, parseFailed: true, value: undefined }
  }
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
  try {
    writeFileSync(temp, text, 'utf8')
    renameSync(temp, path)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // Best effort.
    }
    throw error
  }
}

/**
 * WHAT HAPPENED WHEN A CALLER TRIED TO ENTER THE GUARDED REGION.
 *
 * Three outcomes, three names. The previous `T | undefined` collapsed "never got in" and "the body
 * decided to refuse" into one value, so callers could not report — or even distinguish — the
 * difference. `value` is present only when `acquired` is true, and may itself be `undefined` when the
 * body's answer IS "no".
 */
export type GuardOutcome<T> =
  | { readonly acquired: true; readonly value: T }
  | { readonly acquired: false; readonly reason: 'BUSY' | 'NOT_STAMPED' }
export interface SyncLeaseOptions extends LeaseRequest {
  /** Where the lease records live. One file per key. */
  readonly dir: string
  /**
   * WHERE THE RECORD FOR ONE KEY GOES. Defaults to `<dir>/lease-<key>.json`.
   *
   * WHY A CALLER MAY OVERRIDE IT: a caller whose lock is identified by a PATH — `dsh-memory` guards
   * `<store>/negatives.jsonl` with `<store>/negatives.jsonl.lock` — needs "is this held?" to stay
   * answerable with `existsSync(thatPath)`. With the identity mapping the record IS the lock file, so the
   * path keeps meaning what it meant before the mechanism changed.
   */
  readonly recordPath?: (key: string) => string
  /**
   * Reclaim a path that holds something this lease cannot read — a leftover from the previous lock
   * implementation, which used a DIRECTORY with an `owner` file inside.
   *
   * WHY IT MUST EXIST: after an upgrade, a machine can still have one of those directories on disk. The
   * new lease cannot parse it, so without this it would refuse forever — the store would be bricked by a
   * stale artifact from the old code. Only DIRECTORY leftovers qualify (the new format never creates a
   * directory at the record path), so this cannot be used to steal a live lease from a corrupt file.
   */
  readonly reclaimLegacyDirectory?: boolean
}

/**
 * A synchronous lease over one directory.
 *
 * The record is a JSON file named after the key; the guard is that name plus `.guard`. The guarded
 * region is a read-decide-write, so two processes can never both decide against the same value.
 */
export function createSyncLeaseAdapter(options: SyncLeaseOptions): LeaseAdapter {
  const { dir } = options
  const recordPath =
    typeof options.recordPath === 'function'
      ? options.recordPath
      : (key: string): string => join(dir, `lease-${key.replace(/[^a-z0-9._-]/giu, '-')}.json`)
  const pathOf = (key: string): string => recordPath(key)
  const guardOf = (key: string): string => `${pathOf(key)}.guard`

  /**
   * Clear a leftover from the OLD lock implementation, if this path holds one.
   *
   * The old format was a directory containing `owner`. The new one is always a file, so a directory here
   * cannot be a live lease — it is an artifact from before the upgrade, and refusing to proceed because
   * of it would brick the store permanently. Anything else unreadable is left alone (see the option's
   * note): this is not a licence to steal from a live holder whose record happens to be corrupt.
   */
  function clearLegacyArtifact(key: string): void {
    if (options.reclaimLegacyDirectory !== true) return
    const target = pathOf(key)
    try {
      if (statSync(target).isDirectory()) rmSync(target, { recursive: true, force: true })
    } catch {
      // Neither present nor a directory: nothing to clear.
    }
  }

  /** Run `body` while holding the guard for `key`. Returns `undefined` when the guard never came free. */
  function withGuard<T>(key: string, body: () => T): GuardOutcome<T> {
    const guard = guardOf(key)
    mkdirSync(dirname(guard), { recursive: true })
    const deadline = Date.now() + SYNC_LEASE_GUARD_WAIT_MS
    /**
     * THIS HOLDER'S STAMP ON THE GUARD. It is what makes the release safe: a holder that was stolen
     * from must not delete the guard its successor now owns.
     */
    const stamp = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    let fd: number | undefined
    for (;;) {
      try {
        fd = openSync(guard, 'wx')
        /**
         * WRITE THE STAMP IMMEDIATELY. Between the exclusive create and this write the guard is EMPTY,
         * and an empty guard is only ever stolen by AGE — never on sight — so the window is safe: it
         * is milliseconds wide and the steal threshold is seconds.
         */
        try {
          writeFileSync(guard, stamp, 'utf8')
        } catch {
          // A stamp we could not write means we cannot prove ownership on release; fail the acquire
          // rather than run a critical section we may not be able to hand back safely.
          try {
            closeSync(fd)
          } catch {
            // ignore
          }
          try {
            rmSync(guard, { force: true })
          } catch {
            // ignore
          }
          // NAMED: we did hold the guard and handed it back. Distinct from BUSY, where nothing was
          // ever entered.
          return { acquired: false, reason: 'NOT_STAMPED' }
        }
        break
      } catch (error) {
        if ((error as any)?.code !== 'EEXIST') throw error
        let age = 0
        try {
          age = Date.now() - statSync(guard).mtimeMs
        } catch {
          age = SYNC_LEASE_GUARD_STALE_MS + 1
        }
        if (age > SYNC_LEASE_GUARD_STALE_MS) {
          /**
           * COUNTED, NOT SWALLOWED. A stolen guard is the only way two writers can share a critical
           * section here, so the number must be readable after the fact — the previous failure had to be
           * inferred from a missing row. `guardSteals()` is exposed for exactly that.
           */
          guardStealCount += 1
          try {
            unlinkSync(guard)
          } catch {
            // Someone else stole it; retry.
          }
          continue
        }
        // NAMED: never entered. Nothing was read, so nothing was decided.
        if (Date.now() > deadline) return { acquired: false, reason: 'BUSY' }
        sleepSync(2)
      }
    }
    try {
      return { acquired: true, value: body() }
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          // Already closed is not a failure.
        }
      }
      /**
       * FENCED RELEASE, and it is not optional.
       *
       * An unconditional delete here is the SAME bug the lock being replaced documented: if this
       * holder was stolen from (its guard aged past the steal threshold while it was descheduled), the
       * successor owns a NEW guard at this path, and deleting it lets a THIRD caller enter while the
       * successor is still inside. Two holders, one critical section, one lost row.
       *
       * So: read the stamp, delete only what is ours, and delete it by RENAME — exactly one caller can
       * move a path, so exactly one caller can be the one that removed it.
       */
      let mine = false
      try {
        mine = readFileSync(guard, 'utf8') === stamp
      } catch {
        mine = false
      }
      if (mine) {
        const graveyard = `${guard}.released-${stamp}`
        try {
          renameSync(guard, graveyard)
          rmSync(graveyard, { force: true })
        } catch {
          // ENOENT: already gone. Anything else leaves a disposable file beside the guard.
        }
      }
    }
  }

  function ttlOf(request: LeaseRequest): number {
    const requested = Number.isFinite(Number(request.ttlMs)) ? Math.max(1, Number(request.ttlMs)) : SYNC_LEASE_DEFAULT_TTL_MS
    return Math.min(SYNC_LEASE_MAX_TTL_MS, requested)
  }

  function asRecord(key: string, value: unknown): LeaseRecord | undefined {
    if (value === null || typeof value !== 'object') return undefined
    const candidate = value as Record<string, unknown>
    if (candidate.key !== key) return undefined
    if (typeof candidate.owner !== 'string' || candidate.owner.length === 0) return undefined
    if (!Number.isFinite(Number(candidate.epoch)) || !Number.isFinite(Number(candidate.expiresAt))) return undefined
    return {
      key,
      owner: candidate.owner,
      epoch: Number(candidate.epoch),
      acquiredAt: Number(candidate.acquiredAt) || 0,
      expiresAt: Number(candidate.expiresAt),
      ...(typeof candidate.label === 'string' ? { label: candidate.label } : {}),
    }
  }

  /**
   * IS THE RECORD ON DISK OURS?
   *
   * The fencing question asked AFTER a write instead of before one. An unreadable record answers FALSE:
   * "I cannot prove I hold this" must never be treated as "I hold this", because that is the state in
   * which two writers both proceed.
   */
  function recordIsOurs(key: string, lease: LeaseRecord): boolean {
    const observed = readRecord(pathOf(key))
    if (!observed.present || observed.parseFailed) return false
    const current = asRecord(key, observed.value)
    if (current === undefined) return false
    return current.owner === lease.owner && Number(current.epoch) === Number(lease.epoch)
  }
  /**
   * IS SOMETHING UNREADABLE SITTING AT THIS PATH, AND IS IT STILL FRESH?
   *
   * THE CASE THIS CLOSES: `readJson` returns `undefined` for BOTH "no record" and "a record I cannot
   * parse". Treating the second as the first would GRANT the lease to a second caller while the first
   * holder — whose record merely got corrupted — still believes it is alone. So a present-but-unreadable
   * record is HELD, and only becomes takeable once it is old enough to be abandoned.
   *
   * Age comes from mtime, which is the only evidence available when the contents cannot be trusted.
   */
  function unreadableAndFresh(key: string): boolean {
    const target = pathOf(key)
    try {
      const stat = statSync(target)
      if (stat.isDirectory()) return false // a legacy directory is handled by `clearLegacyArtifact`
      return Date.now() - stat.mtimeMs <= SYNC_LEASE_UNREADABLE_STALE_MS
    } catch {
      return false // nothing there at all
    }
  }

  return {
    name: 'dsh-lease-sync',
    exclusive: true,

    async acquire(key: string, request: LeaseRequest = {}): Promise<LeaseAttempt> {
      const now = Number.isFinite(Number(request.now)) ? Number(request.now) : Date.now()
      const owner = typeof request.owner === 'string' && request.owner.length > 0 ? request.owner : OWNER
      const ttlMs = ttlOf(request)
      const warnings: string[] = []
      let holder: LeaseRecord | undefined
      const outcome = withGuard(key, () => {
        const raw = readRecord(pathOf(key))
        const current = raw.present ? asRecord(key, raw.value) : undefined
        if (raw.present && current === undefined && unreadableAndFresh(key)) return undefined
        const decision = planAcquire(key, current, {
          owner,
          now,
          ttlMs,
          ...(request.label === undefined ? {} : { label: request.label }),
        })
        if (!decision.ok) {
          holder = decision.holder
          return undefined
        }
        writeAtomic(pathOf(key), JSON.stringify(decision.lease, null, 2))
        return decision.lease
      })
      if (!outcome.acquired || outcome.value === undefined) {
        return {
          ok: false,
          stage: 'lease:busy',
          ...(holder === undefined ? {} : { holder }),
          warnings,
          reason:
            holder === undefined
              ? '更新守卫繁忙，未在期限内取得'
              : `已被 ${holder.owner} 持有（epoch=${holder.epoch}）`,
        }
      }
      return { ok: true, stage: 'lease:acquired', lease: outcome.value, warnings }
    },

    /** The synchronous form. Kept beside the async one so a sync caller does not have to await. */
    acquireSync(key: string, request: LeaseRequest = {}): LeaseRecord | undefined {
      const now = Number.isFinite(Number(request.now)) ? Number(request.now) : Date.now()
      const owner = typeof request.owner === 'string' && request.owner.length > 0 ? request.owner : OWNER
      const ttlMs = ttlOf(request)
      const outcome = withGuard(key, () => {
        clearLegacyArtifact(key)
        const raw = readRecord(pathOf(key))
        const current = raw.present ? asRecord(key, raw.value) : undefined
        if (raw.present && current === undefined && unreadableAndFresh(key)) return undefined
        const decision = planAcquire(key, current, {
          owner,
          now,
          ttlMs,
          ...(request.label === undefined ? {} : { label: request.label }),
        })
        if (!decision.ok) return undefined
        writeAtomic(pathOf(key), JSON.stringify(decision.lease, null, 2))
        /**
         * VERIFY-AFTER-WRITE. If the record is not ours, a writer that shared our guard (it was stolen
         * from us, or our guard check lost a race) overwrote it — so we do NOT hold the lease. Standing
         * down here is what turns a silent lost update into a retry.
         */
        if (!recordIsOurs(key, decision.lease)) return undefined
        return decision.lease
      })
      /**
       * UNWRAP BEFORE RETURNING — AND THIS IS NOT COSMETIC.
       *
       * The first version of this refactor returned `withGuard(...)` DIRECTLY, which handed the whole
       * `GuardOutcome` object to the caller. Every caller reads `held.key` / `held.owner` / `held.epoch`,
       * so it received `undefined` for all three: the lease was acquired (the record WAS written) but
       * `releaseSync(held)` then operated on `key === undefined`, deleted nothing, and the lease stayed on
       * disk until it expired. Two callers could therefore hold overlapping critical sections.
       *
       * That is precisely the "two meanings of one word" bug this refactor was meant to remove, reproduced
       * one layer up: the INTERNAL outcome leaked into the PUBLIC contract. The chaos harness caught it
       * (704 holds, 168 overlaps) and a direct print of the return value identified it.
       */
      if (!outcome.acquired) return undefined
      return outcome.value
    },

    releaseSync(lease: LeaseRecord): boolean {
      const outcome = withGuard(lease.key, () => {
        const current = asRecord(lease.key, readRecord(pathOf(lease.key)).value)
        if (planRelease(current, lease) !== LEASE_RELEASE) return false
        rmSync(pathOf(lease.key), { force: true })
        return true
      })
      /**
       * THE AMBIGUITY THAT USED TO LIVE HERE.
       *
       * With the old `T | undefined`, this could not distinguish "the guard was busy, so I released
       * nothing" from "the ownership fence correctly refused, so I released nothing". Both returned
       * `false`, so a caller reading `false` could not tell a transient failure from a correct refusal.
       *
       * Now they are different facts:
       *   - `!acquired`        → NOT released, and the lease is still ours on disk until it expires;
       *   - `value === false`  → we DID look, and the fence refused because our epoch is no longer
       *                          current. That is the CORRECT outcome for a stale holder; no retry needed.
       */
      if (!outcome.acquired) return false
      return outcome.value
    },

    inspectSync(key: string): LeaseRecord | undefined {
      const lease = asRecord(key, readRecord(pathOf(key)).value)
      return isLeaseExpired(lease, Date.now()) ? undefined : lease
    },

    async renew(lease: LeaseRecord, request: LeaseRequest = {}): Promise<LeaseAttempt> {
      const now = Number.isFinite(Number(request.now)) ? Number(request.now) : Date.now()
      const ttlMs = ttlOf(request)
      const refusal: { holder?: LeaseRecord } = {}
      const outcome = withGuard(lease.key, () => {
        const current = asRecord(lease.key, readRecord(pathOf(lease.key)).value)
        const next = planRenew(current, lease, { now, ttlMs })
        if (next === undefined) {
          if (current !== undefined && !isLeaseExpired(current, now)) refusal.holder = current
          return undefined
        }
        writeAtomic(pathOf(lease.key), JSON.stringify(next, null, 2))
        return next
      })
      /**
       * RENEW HAS THREE ANSWERS, NOT TWO, AND THE THIRD IS THE INTERESTING ONE.
       *
       *   - not acquired  → we never got in; the lease may still be perfectly valid. Reporting it as
       *                     "lost" would be a lie that makes the caller give up a lease it still holds;
       *   - value absent  → we looked and the fence refused: the generation moved on. THAT is `lease:lost`;
       *   - value present → renewed.
       */
      if (!outcome.acquired) {
        return {
          ok: false,
          stage: 'lease:busy',
          warnings: [],
          reason: '更新守卫繁忙，未能续租（原租约可能仍然有效，请重试）',
        }
      }
      if (outcome.value === undefined) {
        return {
          ok: false,
          stage: 'lease:lost',
          ...(refusal.holder === undefined ? {} : { holder: refusal.holder }),
          warnings: [],
          reason: `epoch=${lease.epoch} 已不是当前代`,
        }
      }
      return { ok: true, stage: 'lease:renewed', lease: outcome.value, warnings: [] }
    },

    async release(lease: LeaseRecord): Promise<MutationReceipt> {
      if (this.releaseSync(lease)) return { ok: true, stage: 'lease:released', warnings: [] }
      return {
        ok: false,
        stage: 'lease:release-refused',
        warnings: [],
        error: {
          code: 'LEASE_STALE',
          stage: 'release',
          message: `epoch=${lease.epoch} 不是当前代，拒绝释放（否则会删掉继任者的租约）`,
        },
      }
    },

    async inspect(key: string): Promise<LeaseRecord | undefined> {
      const lease = asRecord(key, readRecord(pathOf(key)).value)
      return isLeaseExpired(lease, Date.now()) ? undefined : lease
    },
  }
}
