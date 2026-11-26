/**
 * ── v361：S9 / D3 —— 租约判据是「我是否还持有」，不是「它是否过期」────────────────────────────────
 *
 * 病（`src/lease.ts` 的旧判定）：
 *
 *     if (isLeaseExpired(current, Date.now()) && current?.owner !== lease.owner) → LEASE_LOST
 *
 * 两件事**同时成立**才报丢失。于是最常见的那一路反而漏了：正文跑完之后，租约**已被继任者取得、
 * 且尚未过期** —— 那正是「另一个进程已经在改我们刚改过的状态」，而 `isLeaseExpired` 返回 false，
 * 整条判定短路，函数返回 `ok: true`。**丢更新被报成成功。**
 *
 * 判据用**内存租约适配器**（`exclusive: true`），因为这里要量的是 `withLease` 的判定，不是存储层。
 *
 *   ① 继任者在正文执行期间接管（未过期）⇒ `LEASE_LOST`，而不是 ok
 *   ② 同一 owner + 同一 epoch ⇒ 仍然是我们 ⇒ `ok`（成功的自我续期不许被报成丢失）
 *   ③ 同一个 owner、**不同 epoch** ⇒ 也必须是丢失（id 复用 / torn write 的那条 fence）
 *   ④ 键在正文期间消失 ⇒ `ok` + 一条 warning（「不存在」不是「被抢」）
 *   ⑤ 正文抛错 ⇒ `BODY_FAILED`，且仍然尝试释放（finally）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
/**
 * paradise 的产物就是**仓库根**的 `index.js`（不是 `lib/`）—— `package.json` 的 `main` 是 `index.js`，
 * 而 `build.mjs` 输出到根。第一版写 `../lib/...` 连撞两次 ERR_MODULE_NOT_FOUND（先猜
 * `lib/protocol/lease.js`、再猜 `lib/index.js`）；本仓其它测试一律 `from '../index.js'`。
 */
const { withLease, LEASE_RELEASE, leaseOwnedBy, isLeaseExpired } = await import('../index.js')

/**
 * An in-memory exclusive adapter. `inspect` returns whatever `current` holds at the time it is called,
 * which is how a test reproduces "someone took it while the body ran" without sleeping.
 */
const memoryAdapter = () => {
  const state = { current: undefined, releases: [], acquisitions: 0 }
  const adapter = {
    name: 'memory-test',
    exclusive: true,
    async acquire(key, request = {}) {
      state.acquisitions += 1
      const now = Number(request.now ?? Date.now())
      if (state.current !== undefined && !isLeaseExpired(state.current, now)) {
        return { ok: false, stage: 'acquire', holder: state.current, warnings: [], reason: 'held' }
      }
      state.current = {
        key,
        owner: String(request.owner ?? 'test-owner'),
        epoch: Number(state.current?.epoch ?? 0) + 1,
        acquiredAt: now,
        expiresAt: now + Number(request.ttlMs ?? 30_000),
      }
      return { ok: true, stage: 'acquire', lease: state.current, warnings: [] }
    },
    async renew(lease, request = {}) {
      const now = Number(request.now ?? Date.now())
      if (!leaseOwnedBy(state.current, lease)) return { ok: false, stage: 'renew', warnings: [], reason: 'stale' }
      state.current = { ...lease, expiresAt: now + Number(request.ttlMs ?? 30_000) }
      return { ok: true, stage: 'renew', lease: state.current, warnings: [] }
    },
    async release(lease) {
      state.releases.push(lease)
      if (!leaseOwnedBy(state.current, lease)) return { ok: false, stage: 'release', warnings: [], error: { code: 'STALE', message: 'not mine' } }
      state.current = undefined
      return { ok: true, stage: 'release', warnings: [] }
    },
    async inspect() {
      return state.current
    },
  }
  return { adapter, state }
}

test('v361 ①: a SUCCESSOR that takes over mid-body (not expired) is LEASE_LOST, not ok', async () => {
  const { adapter, state } = memoryAdapter()
  const result = await withLease(adapter, 'k', { owner: 'me', waitMs: 0, ttlMs: 30_000 }, async (lease) => {
    /**
     * The successor takes over WHILE the body runs, and its lease is FRESH (expiresAt far in the future).
     * The old condition required `isLeaseExpired(current) === true`, so this path returned ok.
     */
    state.current = { ...lease, owner: 'successor', epoch: lease.epoch + 1, expiresAt: Date.now() + 60_000 }
    return 'body-finished'
  })
  assert.equal(result.ok, false, '① 继任者接管后不许返回 ok —— 那是把丢更新报成成功')
  assert.equal(result.code, 'LEASE_LOST', `① 必须是 LEASE_LOST，实测 ${result.code}`)
  assert.ok(result.warnings.some((line) => line.includes('易主')),
    `① warning 必须说清是易主，实测：${result.warnings.join(' | ')}`)
})

test('v361 ②: the SAME owner and epoch is still us — a self-renewal is not a loss', async () => {
  const { adapter, state } = memoryAdapter()
  const result = await withLease(adapter, 'k', { owner: 'me', waitMs: 0 }, async (lease) => {
    /** Same owner, same epoch: nothing was taken, so nothing was lost. */
    state.current = { ...state.current, expiresAt: Date.now() + 60_000 }
    void lease
    return 'value'
  })
  assert.equal(result.ok, true, '② 同一 owner/epoch 必须仍然 ok')
  assert.equal(result.value, 'value')
  assert.equal(result.code, undefined, '② 成功路径不得带 code')
})

test('v361 ③: the SAME owner with a DIFFERENT epoch is a loss (id reuse / torn write)', async () => {
  const { adapter, state } = memoryAdapter()
  const result = await withLease(adapter, 'k', { owner: 'me', waitMs: 0 }, async (lease) => {
    /**
     * Same owner string but a newer epoch: a process that restarted with a recycled id, or a torn
     * write that produced the same owner with a bumped fence. `leaseOwnedBy` requires BOTH, which is
     * exactly why this must be a loss even though the owner name matches.
     */
    state.current = { ...lease, epoch: lease.epoch + 1, expiresAt: Date.now() + 60_000 }
    return 'value'
  })
  assert.equal(result.ok, false, '③ owner 相同但 epoch 不同 ⇒ 不是我们 ⇒ 必须丢失')
  assert.equal(result.code, 'LEASE_LOST')
})

test('v361 ④: a key that VANISHED mid-body is ALSO LEASE_LOST (cannot prove we held it)', async () => {
  /**
   * ── F2（S13）：这条期望本身曾经是回归 ──────────────────────────────────────────────────────────
   *
   * 上一版这里断言 `ok: true` + 一条 warning，理由写作「不存在 ≠ 被抢」。执行者按那句话改了代码
   * （`&& current !== undefined`），于是 `withLease` 在**键消失**时报告成功。
   *
   * 为什么那是 fail-open：`current === undefined` **无法区分**这两种事实——
   *   a) 存储被清理 / 键过期删除（真的没人抢）；
   *   b) 继任者接管、做完活、释放了键（**丢更新**，且是我们报告成功的那一种）。
   * 而 fence 的语义是「整个正文期间我是否一直持有」。判不出来的时候，安全侧只能报丢失。
   *
   * 一个只在「能证明持有」时才报成功的 gate，是 gate；只在「能证明被抢」时才报失败，是审查。
   */
  const { adapter, state } = memoryAdapter()
  const result = await withLease(adapter, 'k', { owner: 'me', waitMs: 0 }, async () => {
    state.current = undefined
    return 'value'
  })
  assert.equal(result.ok, false, '④ 键消失 ⇒ 无法证明仍持有 ⇒ 必须 fail-closed')
  assert.equal(result.code, 'LEASE_LOST', `④ 实测 ${result.code}`)
  assert.ok(result.warnings.some((line) => line.includes('已不存在')),
    `④ warning 必须点名「键已不存在」这一种，实测：${result.warnings.join(' | ')}`)
  /**
   * 两种丢失必须**可分辨**：一句通用的「租约丢失」会让读日志的人分不清是「被抢」还是「键没了」，
   * 而这两种事实的处置完全不同（前者要报警，后者要查存储）。
   */
  assert.ok(!result.warnings.some((line) => line.includes('易主')),
    `④ 「键消失」不得被写成「易主」，实测：${result.warnings.join(' | ')}`)
})

test('v361 ⑤: a throwing body is BODY_FAILED, and the release is still attempted', async () => {
  const { adapter, state } = memoryAdapter()
  const result = await withLease(adapter, 'k', { owner: 'me', waitMs: 0 }, async () => {
    throw new Error('body exploded')
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'BODY_FAILED', `⑤ 实测 ${result.code}`)
  assert.equal(state.releases.length, 1, '⑤ finally 必须仍然尝试释放（一次）')
})

test('v361 ⑥: an ADVISORY adapter is refused, never used', async () => {
  const { adapter } = memoryAdapter()
  const advisory = { ...adapter, exclusive: false }
  const result = await withLease(advisory, 'k', { owner: 'me', waitMs: 0 }, async () => 'value')
  assert.equal(result.ok, false, '⑥ 只读适配器不得提供互斥保证')
  assert.equal(result.code, 'LEASE_UNAVAILABLE', `⑥ 实测 ${result.code}`)
})