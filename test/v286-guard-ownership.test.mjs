/**
 * ── v286 / B4-B B13 (P0): 守卫必须知道「这是我建的」，否则 finally 删掉的是别人的 ────────────────────
 *
 * 用户原话（派工单 §十四 B13）：**「guard 带 owner token（新建时写入，删除前校验）；`finally` 只删自己拥有
 * 的 guard（被偷的 ⇒ 不删）；负向：guard 正常释放时确实被删除；`LEASE_RELEASE` 分支的删除也走同一校验。」**
 *
 * 缺陷（`src/adapters/dsh/storage.ts`）：守卫文件是一个**裸名字** —— 存在即「有人持有」，没有任何地方记录
 * 「谁」持有。于是持有者在 `finally` 里无法区分：
 *
 *   ① 我自己建的守卫；② 过期检查把守卫偷走后，**窃取者**新建的守卫。
 *
 * 后果是真正的互斥失效：A 的守卫过期 → B 偷走 → B 进入临界区 → A 的 `finally` 删掉 B 的守卫 →
 * 第三个写入者立刻拿到一个「没人持有」的名字 ⇒ **两个写入者在同一个临界区里**，正是这个原语要防的事。
 * 同一个 `finally` 在**取守卫失败**时（`guardFd === undefined`）也会删 — 超时的调用方把持有者的活守卫删了。
 *
 * 判据（写在最坏的那一半上，各配负向半边）：
 *   ① 守卫文件里写着持有者 token ⇒「是不是我的」由文件回答，而不是一个本地布尔；
 *   ② 被抢占后，`finally` **不删** 那条守卫（窃取者的守卫必须留下）；
 *   ③ 被抢占后，本次调用**拒绝写入**（`LEASE_RELEASE` 的删除也一样）—— 别人的临界区里不做破坏性动作；
 *   ④ 负向：正常释放时守卫**确实被删**（不许「永不删除」也能过 ②）。
 *
 * 注入是确定性的：`verify` 就在守卫**内部**同步执行，所以它自己完成「删掉守卫 + 用别人的 token 重建」，
 * 不需要靠 sleep 去赌时序。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDshAdapters, LEASE_RELEASE } from '../index.js'

function diskStorage() {
  const dir = mkdtempSync(join(tmpdir(), 'paradise-b13-'))
  const adapter = createDshAdapters({ paths: { data: dir } }).storage
  return { dir, adapter, guard: (key) => join(dir, `${key}.json.guard`) }
}

/** Replace the guard with one a DIFFERENT holder created — the steal, done synchronously. */
function steal(guardPath) {
  rmSync(guardPath, { force: true })
  writeFileSync(guardPath, 'other-process:deadbeef', 'utf8')
}

test('v286 B13 ①: the guard file records WHO holds it', async () => {
  const { adapter, guard } = diskStorage()
  let seen = ''
  const result = await adapter.compareAndSet('alpha', (current) => {
    assert.equal(current, undefined)
    seen = readFileSync(guard('alpha'), 'utf8')
    return { n: 1 }
  })
  assert.equal(result.ok, true)
  assert.equal(seen.length > 0, true, '守卫文件必须写着持有者 token，否则「被偷」无从判定')
  assert.equal(existsSync(guard('alpha')), false, 'and it is released afterwards')
})

test('v286 B13 ②: a STOLEN guard is not deleted by the original holder', async () => {
  const { adapter, guard } = diskStorage()
  const result = await adapter.compareAndSet('beta', () => {
    steal(guard('beta'))
    return { n: 2 }
  })

  // ③ the destructive action is REFUSED: our observation is no longer authoritative.
  assert.equal(result.ok, false, '被抢占后不许写入')
  assert.equal(
    result.warnings.some((w) => w.includes('守卫已被抢占')),
    true,
    `拒绝必须点名原因；实测 ${JSON.stringify(result.warnings)}`,
  )
  assert.equal(readFileSync(guard('beta'), 'utf8'), 'other-process:deadbeef',
    '窃取者的守卫必须还在 —— 原持有者的 finally 删掉它，就是让第三个写入者进同一条临界区')
})

test('v286 B13 ②b: a stolen guard does not let the RELEASE path delete either', async () => {
  const { adapter, guard, dir } = diskStorage()
  await adapter.write('gamma', { keep: 'this' })

  const result = await adapter.compareAndSet('gamma', () => {
    steal(guard('gamma'))
    return LEASE_RELEASE
  })

  assert.equal(result.ok, false, 'LEASE_RELEASE 也必须走同一校验，而不是在别人的临界区里删数据')
  assert.equal(readFileSync(guard('gamma'), 'utf8'), 'other-process:deadbeef', '守卫仍然不被删')
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'gamma.json'), 'utf8')), { keep: 'this' },
    '被抢占时数据必须原样不动')
})

test('v286 B13 ④ (negative half): a NORMAL release really does remove the guard', async () => {
  /**
   * Without this, ② is satisfied by 「never remove the guard」 — which would leave every key blocked
   * for a full staleness window after every write.
   */
  const { adapter, guard } = diskStorage()
  const result = await adapter.compareAndSet('delta', () => ({ n: 4 }))
  assert.equal(result.ok, true)
  assert.equal(existsSync(guard('delta')), false, '正常释放必须真的删掉守卫')
})

test('v286 B13 ④b: a CALLER THAT NEVER GOT THE GUARD does not delete the holder\'s', async () => {
  /**
   * The second half of the same defect: `finally` used to `rmSync` even when `guardFd === undefined`,
   * i.e. the acquisition FAILED. Simulate a live holder by creating the guard with a foreign token and
   * a FRESH mtime (so the age check cannot steal it), then let a second caller time out against it.
   */
  const { adapter, guard } = diskStorage()
  writeFileSync(guard('epsilon'), 'live-holder:sometoken', 'utf8')

  const result = await adapter.compareAndSet('epsilon', () => ({ n: 5 }))
  assert.equal(result.ok, false, 'a busy guard means this call fails, not that it proceeds')
  assert.equal(readFileSync(guard('epsilon'), 'utf8'), 'live-holder:sometoken',
    '取不到守卫的调用方不得删掉持有者的守卫')
})
