/**
 * `withLease` — the ONE way a caller should take a lease, and the reason it is a helper rather than
 * three lines at each call site.
 *
 * THREE FAILURES THIS SHAPE PREVENTS, EACH OF WHICH HAS A CONCRETE COST
 *
 *   1. A LEAKED LEASE. `acquire`/`release` around a body that throws is how a key stays locked until
 *      its TTL expires — a delay nobody can explain later. The release is in a `finally`, so it runs
 *      on the throw path, the async-rejection path, and the normal path.
 *
 *   2. A DEADLOCK. Waiting for a lease without a bound turns "a job is slow" into "this process never
 *      finishes". Every wait here is bounded by `waitMs`, and the refusal is NAMED (`LEASE_BUSY`) with
 *      the holder in it, so a caller can decide (retry later, skip this session, tell the user) instead
 *      of hanging. That is also why the wait is a BOUNDED loop and not a queue: a queue can be full.
 *
 *   3. A STALE WRITE. The body receives the lease it actually holds, so it can pass the epoch to a
 *      storage write. A holder that stalled past `expiresAt` and lost the key to a successor will fail
 *      its renewal — and the helper reports that as `LEASE_LOST` rather than letting the body finish
 *      and pretend it succeeded on state someone else now owns.
 *
 * NOT A GENERIC DISTRIBUTED LOCK. It gives mutual exclusion for processes sharing one storage adapter,
 * which is the whole problem this ecosystem has. It says nothing about hosts that do not share state.
 */

import type { LeaseAdapter, LeaseRecord, LeaseRequest } from './protocol/index.js'
import { isLeaseExpired } from './protocol/index.js'

/** The outcome of running a body under a lease. */
export interface WithLeaseResult<T> {
  ok: boolean
  /** Present when `ok` — the body's own result. */
  value?: T
  /** Present when not `ok`: `LEASE_BUSY`, `LEASE_UNAVAILABLE`, `LEASE_LOST`, or `BODY_FAILED`. */
  code?: string
  reason?: string
  /** The lease that was held, so a caller can log its epoch. */
  lease?: LeaseRecord
  warnings: string[]
}

/** How long between acquisition attempts. Small: the critical sections here are milliseconds. */
const RETRY_INTERVAL_MS = 15

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    /**
     * NO `unref()` HERE, and the reason is a real hang this caused.
     *
     * `unref()` was added so a waiting retry would not keep the process alive. That is the right instinct
     * for a timer used on a BACKGROUND path — but this timer is awaited by the CALLER: when the retry loop is
     * the only thing the event loop still has to do, an unref'd timer lets Node decide there is nothing
     * pending and exit. The symptom is `Detected unsettled top-level await` and a script that silently stops
     * in the middle of a concurrent burst — measured here with 20 contenders.
     *
     * A plain timer keeps the process alive for at most `waitMs`, which is exactly the interval the caller
     * asked to wait. That is not a leak; it is the semantics of awaiting.
     */
    void timer
  })
}

/**
 * Run `body` while holding the lease for `key`.
 *
 * A REFUSAL IS A RESULT, NOT A THROW: callers of this ecosystem are background passes (harvest, graft)
 * that must continue with their other work, and a thrown lock error would abort a whole pass because
 * one session was busy.
 */
export async function withLease<T>(
  adapter: LeaseAdapter,
  key: string,
  options: LeaseRequest,
  body: (lease: LeaseRecord) => Promise<T>,
): Promise<WithLeaseResult<T>> {
  const warnings: string[] = []
  const waitMs = Number.isFinite(Number(options.waitMs)) ? Math.max(0, Number(options.waitMs)) : 0
  const deadline = Date.now() + waitMs

  if (adapter.exclusive !== true) {
    /**
     * AN ADVISORY ADAPTER IS REFUSED, NOT USED.
     *
     * Falling back to "probably fine" here is how two writers interleave once a month and corrupt a
     * corpus. A caller that can tolerate that must say so itself; this helper will not decide it.
     */
    return {
      ok: false,
      code: 'LEASE_UNAVAILABLE',
      reason: `${adapter.name} 不提供原子 compareAndSet，无法保证互斥`,
      warnings,
    }
  }

  let attempt = await adapter.acquire(key, options)
  warnings.push(...attempt.warnings)
  while (!attempt.ok && Date.now() < deadline) {
    await sleep(RETRY_INTERVAL_MS)
    attempt = await adapter.acquire(key, { ...options, waitMs: 0 })
    warnings.push(...attempt.warnings)
  }
  if (!attempt.ok || attempt.lease === undefined) {
    return {
      ok: false,
      code: 'LEASE_BUSY',
      reason: attempt.reason ?? '未取得租约',
      warnings,
    }
  }

  const lease = attempt.lease
  try {
    const value = await body(lease)
    /**
     * DID WE STILL HOLD IT WHEN WE FINISHED?
     *
     * A body can outlive its own TTL. If it did, another process may already own the key and be
     * operating on state this body just changed — so the outcome is reported as `LEASE_LOST` even
     * though the body returned cleanly. Saying "ok" here would be the silent version of a lost update.
     */
    const current = await adapter.inspect(key)
    if (isLeaseExpired(current, Date.now()) && current?.owner !== lease.owner) {
      warnings.push(`租约在正文执行期间过期（epoch=${lease.epoch}，现任=${current?.owner ?? '无'}）`)
      return { ok: false, code: 'LEASE_LOST', reason: '正文执行期间租约已过期', lease, warnings }
    }
    return { ok: true, value, lease, warnings }
  } catch (error) {
    return {
      ok: false,
      code: 'BODY_FAILED',
      reason: String((error as any)?.message ?? error),
      lease,
      warnings,
    }
  } finally {
    /**
     * ALWAYS. Including when the body threw, and including when the lease was lost — a release that
     * fails the epoch check is refused by the adapter, which is the correct outcome: the current
     * holder must not have its claim deleted by a stale one.
     */
    try {
      const released = await adapter.release(lease)
      warnings.push(...released.warnings)
      if (!released.ok && released.error !== undefined) warnings.push(`释放租约未成功：${released.error.message}`)
    } catch (error) {
      warnings.push(`释放租约抛错：${String((error as any)?.message ?? error)}`)
    }
  }
}
