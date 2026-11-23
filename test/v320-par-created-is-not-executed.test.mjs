/**
 * ── v320 / G-7 (P0, PAR-01): 「创建」不是「执行」，未执行不得解锁下游 ──────────────────────────────
 *
 * 外部报告 v3.2 §7.2 的指控，lead 在当前 HEAD 上复现：
 *
 *     A、B 两条 receipt 都是 `ok: true`；**A 从未执行（no runner）**，B 照样被放行。
 *
 * 而 A 的 output 自己写着「节点已创建（portable），未执行」——**同一份对象里，一句话说「没执行」，
 * 一个布尔说「成功」，而消费者只读那个布尔。**
 *
 * 判据（四条，含两条负向）：
 *   ① A→B、无 runner ⇒ **B 不得 `ok:true`**（必须 `skipped`，且原因含「未执行」/`created`）
 *   ② **负向**：A→B、**有** runner 且 A 成功 ⇒ B **必须**被执行（不许「一律不解锁」也能过 ①）
 *   ③ A 的 receipt 必须区分「已创建/未执行」与「执行成功」——`phase` 是 `created`，不是 `executed`
 *   ④ `ok` 的语义**没有被改坏**：no-runner 时 `ok` 仍是 `true`（那是「调度器做成了它被要求做的事」）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = join(import.meta.dirname, '..', '..')

async function loadDispatcher() {
  return import(pathToFileURL(join(ROOT, 'dsh-paradise', 'index.js')).href)
}

const ticket = (id, dependsOn) => ({ id, goal: `目标 ${id}`, ...(dependsOn === undefined ? {} : { dependsOn }) })

const withWorkspace = async (fn) => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-v320-par-'))
  try {
    return await fn(workspace)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

test('v320 ① (P0): no runner ⇒ the dependent is SKIPPED, not ok', async () => {
  const { dispatch } = await loadDispatcher()
  await withWorkspace(async (workspace) => {
    const report = await dispatch([ticket('A'), ticket('B', ['A'])], { workspace })
    const a = report.receipts.find((r) => r.ticketId === 'A')
    const b = report.receipts.find((r) => r.ticketId === 'B')
    assert.ok(a !== undefined, '前提：A 必须有 receipt')
    assert.equal(a.ok, true, '④ 前提确认：no-runner 的 ok 仍是 true（调度器确实创建了节点）')
    assert.equal(a.phase, 'created', '③ A 的 phase 必须是 created，不是 executed')

    assert.equal(b, undefined,
      `无 runner 时 B 不得有 receipt（它根本没跑）；实测 ${JSON.stringify(report.receipts.map((r) => r.ticketId))}`)
    const skippedB = report.skipped.find((entry) => entry.ticketId === 'B')
    assert.ok(skippedB !== undefined, 'B 必须出现在 skipped 里（不许静默丢弃）')
    assert.match(skippedB.reason, /A=created/u,
      `原因必须说清 A 是 created（创建未执行）；实测：${skippedB.reason}`)
  })
})

test('v320 ② (negative half): WITH a runner, the dependent MUST run — not 「never unlock」', async () => {
  /**
   * Without this half, ① is satisfied by never unlocking anything, which would turn the dispatcher into a
   * single-ticket tool and pass every criterion above.
   */
  const { dispatch } = await loadDispatcher()
  await withWorkspace(async (workspace) => {
    const executed = []
    const report = await dispatch([ticket('A'), ticket('B', ['A'])], {
      workspace,
      runner: async ({ ticket: current }) => {
        executed.push(current.id)
        return { ok: true, output: `已执行 ${current.id}` }
      },
    })
    assert.deepEqual(executed, ['A', 'B'],
      `有 runner 且 A 成功时 B 必须被执行；实测执行顺序 ${JSON.stringify(executed)}`)
    for (const id of ['A', 'B']) {
      const receipt = report.receipts.find((r) => r.ticketId === id)
      assert.equal(receipt.phase, 'executed', `${id} 的 phase 必须是 executed`)
      assert.equal(receipt.ok, true, `${id} 必须 ok`)
    }
    assert.equal(report.skipped.length, 0, '不该有任何 skipped')
  })
})

test('v320 ③: `created` and `executed` are distinguishable on the receipt itself', async () => {
  const { dispatch } = await loadDispatcher()
  await withWorkspace(async (workspace) => {
    const noRunner = await dispatch([ticket('A')], { workspace })
    const withRunner = await dispatch([ticket('A')], {
      workspace,
      runner: async () => ({ ok: true, output: 'done' }),
    })
    const created = noRunner.receipts.find((r) => r.ticketId === 'A')
    const executed = withRunner.receipts.find((r) => r.ticketId === 'A')
    assert.equal(created.phase, 'created')
    assert.equal(executed.phase, 'executed')
    /**
     * `ok` alone cannot tell them apart — that is the whole defect — so the phase must. If a future edit
     * collapses the two phases back into `ok`, this assertion is what catches it.
     */
    assert.equal(created.ok, executed.ok, '前提：两种情形下 ok 相同 —— 所以 ok 分不开它们')
  })
})

test('v320 ④: a FAILED runner still fails, and its dependent is skipped with the real reason', async () => {
  /**
   * The other direction of 「未执行」: a runner that returns `ok: false` is an execution that FAILED, and
   * its reason must survive rather than being flattened into 「created」.
   */
  const { dispatch } = await loadDispatcher()
  await withWorkspace(async (workspace) => {
    const report = await dispatch([ticket('A'), ticket('B', ['A'])], {
      workspace,
      runner: async () => ({ ok: false, error: 'runner 说这次执行失败了' }),
    })
    const a = report.receipts.find((r) => r.ticketId === 'A')
    assert.equal(a.ok, false, 'A 必须失败')
    assert.equal(a.phase, 'executed', '失败的是「执行」，不是「创建」')
    const skippedB = report.skipped.find((entry) => entry.ticketId === 'B')
    assert.ok(skippedB !== undefined, 'B 必须被跳过')
    assert.match(skippedB.reason, /A=failed/u, `原因必须点名 A=failed；实测：${skippedB.reason}`)
  })
})