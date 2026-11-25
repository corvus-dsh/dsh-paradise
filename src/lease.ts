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
import { isLeaseExpired, leaseOwnedBy } from './protocol/index.js'

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
    /**
     * ── D3：判据是「**我们是否还持有**」，不是「它是否过期」──────────────────────────────────────
     *
     * 旧条件 `isLeaseExpired(current) && current?.owner !== lease.owner` 要求**两件事同时成立**才报
     * `LEASE_LOST`。于是最常见的那一路反而漏了：正文跑完之后租约**已被继任者取得、且尚未过期**——
     * 这正是「另一个进程已经在改我们刚改过的状态」，而 `isLeaseExpired` 返回 false，整条判定短路，
     * 函数返回 `ok: true`。**丢更新被报成了成功。**
     *
     * 而且「过期」这个理由本身是多余的：`leaseOwnedBy` 已经同时比较 owner 与 epoch（那条 fence 的
     * 注释写着两个理由：id 复用、以及 torn write 下的同 epoch 不同 owner）。所有权不成立 ⇒ 我们不
     * 再持有，无论它过没过期。
     *
     * 自我接管的情况必须仍然为真：同一 owner、同一 epoch ⇒ 仍然是我们 ⇒ 不算丢失。
     */
    if (!leaseOwnedBy(current, lease) && current !== undefined) {
      warnings.push(
        `租约在正文执行期间易主（epoch=${lease.epoch}，现任=${current.owner ?? '无'}@${current.epoch ?? '?'}）`,
      )
      return { ok: false, code: 'LEASE_LOST', reason: '正文执行期间租约已被其它持有者接管', lease, warnings }
    }
    /**
     * `current === undefined`（键已消失）是**另一种**事实：没有人持有，也就没有人抢。旧代码把
     * undefined 交给 `isLeaseExpired`（它对 undefined 返回 true），于是「键被删掉」被读成「过期」——
     * 那是把「不存在」与「过期」混成一句。这里显式分开，并记一条 warning 而不是失败。
     */
    if (current === undefined) {
      warnings.push('租约在正文执行期间已不存在（键被删除或存储被清理）')
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
