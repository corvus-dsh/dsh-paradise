/**
 * ── v278 (B4-0b-2 W3-3): `gave-up` MUST BE ABLE TO END ──────────────────────────────────────
 *
 * The launcher kept probing after giving up — deliberately, so a recovery would still be noticed — and
 * then discarded the notice, because the healthy branch only transitioned out of `degraded`:
 *
 *     if (state === 'degraded') transition('hosted', '探针恢复健康')
 *
 * So a host that spent its repair budget and then healed BY ITSELF stayed `gave-up` forever. The state
 * said 「需要人介入」 about a situation nobody had to touch, and the only exit was a restart — the
 * failure class this package exists to remove, produced by the recovery path itself.
 *
 * The second half is the reason string: with `maxRepairAttempts: 0` the budget is exhausted on the
 * first failing tick, `attempts` is empty, and the sentence read
 *
 *     0 次修复尝试后仍未恢复：未知
 *
 * — which describes an UNKNOWN fault when the actual situation is a DELIBERATE configuration. Those
 * two send the reader to different places (`修 repair 工具` vs `看配置`), so they must read differently.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createLauncher } from '../index.js'

/** A probe whose answer the test flips by hand. Never throws (that is the probe contract). */
function controllableProbe(initial) {
  const box = { ok: initial, reason: initial ? 'fine' : 'harness 无响应', detail: 'v278' }
  return {
    box,
    probe: {
      name: 'v278',
      async check() {
        return { ok: box.ok, reason: box.reason, detail: box.detail }
      },
    },
  }
}

const NO_TIMERS = { setIntervalImpl: () => ({}), clearIntervalImpl: () => {} }

// ── ① gave-up → (probe heals) → hosted, and the reason is cleared ───────────────────────────

test('v278 ①: 放弃后探针自己恢复 ⇒ 回到 hosted，且 gaveUpReason 被清掉', async () => {
  const { box, probe } = controllableProbe(false)
  const launcher = createLauncher({
    probes: [probe],
    /**
     * Zero repair budget on purpose: this is the exact configuration the dispatch names, and it also
     * exercises the reason string without needing an LLM or a tool factory.
     */
    maxRepairAttempts: 0,
    failureThreshold: 1,
    intervalMs: 10,
    ...NO_TIMERS,
  })

  await launcher.tick()
  assert.equal(launcher.getState(), 'gave-up', '预算 0 + 探针失败 ⇒ 立刻放弃')
  const reason = launcher.report().gaveUpReason
  assert.ok(reason !== undefined)
  assert.match(reason ?? '', /未尝试修复（上限 0）/u, `原因必须说是「没试过」而不是「试过失败了」；actual: ${reason}`)
  /**
   * The OLD sentence, forbidden verbatim: `0 次修复尝试后仍未恢复：未知`. My own text contains the
   * word 未知 on purpose (「不是未知故障」), so the assertion targets the SHAPE, not the word — an
   * assertion that forbade the character would force the explanation out of the message.
   */
  assert.doesNotMatch(reason ?? '', /\d+ 次修复尝试后仍未恢复：未知/u, '不许把一个配置事实说成「试过、失败了、原因未知」')

  /** THE POINT: the world gets better on its own. No repair, no restart, no human. */
  box.ok = true
  await launcher.tick()

  assert.equal(launcher.getState(), 'hosted', '探针健康而状态仍不是 hosted ⇒ 这就是那个「永远放弃」的缺陷')
  assert.equal(launcher.report().gaveUpReason, undefined, '恢复后不许留下过期的理由')
  const last = launcher.report().transitions.at(-1)
  assert.equal(last?.to, 'hosted')
  assert.match(String(last?.reason), /自行恢复/u, '必须说清是「自己好的」，不是「修复生效」')
})

// ── ② the old behaviour, pinned: `degraded` still recovers (the fix did not reroute it) ──────

test('v278 ②: degraded 仍然能回 hosted（改动没有把原路径改坏）', async () => {
  const { box, probe } = controllableProbe(false)
  const launcher = createLauncher({
    probes: [probe],
    /** One repair allowed, but no LLM: the attempt is recorded as a failure and state becomes degraded. */
    maxRepairAttempts: 1,
    failureThreshold: 1,
    intervalMs: 10,
    ...NO_TIMERS,
  })
  await launcher.tick()
  assert.equal(launcher.getState(), 'degraded', `没有 LLM ⇒ 修复编译不了，应停在 degraded；actual: ${launcher.getState()}`)

  box.ok = true
  await launcher.tick()
  assert.equal(launcher.getState(), 'hosted')
  assert.equal(launcher.report().gaveUpReason, undefined)
})

// ── ③ healthy while already hosted is a no-op, not a transition storm ──────────────────────

test('v278 ③: 一直健康 ⇒ 不产生任何迁移（不是「每到一拍就记一次恢复」）', async () => {
  const { probe } = controllableProbe(true)
  const launcher = createLauncher({ probes: [probe], maxRepairAttempts: 0, failureThreshold: 1, intervalMs: 10, ...NO_TIMERS })
  for (let round = 0; round < 3; round += 1) await launcher.tick()
  assert.equal(launcher.getState(), 'hosted')
  assert.equal(launcher.report().transitions.length, 0, `健康的系统不该留下迁移记录；actual: ${JSON.stringify(launcher.report().transitions)}`)
})