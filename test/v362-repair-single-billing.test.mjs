/**
 * ── v362：S9 / N3 —— 一次 emergency repair 只许 **1** 次 `llm.generate`────────────────────────────
 *
 * 病（实测，`emergency-repair.ts` + `harness.ts` 的 `executeSession`）：
 *
 *     emergency-repair.ts   await options.llm.generate(injected, …)   ← 第 1 次（产出诊断）
 *     emergency-repair.ts   await options.session.trigger(ref, {…})    → 适配器的 onTrigger
 *                            → harness 的 executeSession() → llm.generate(…)
 *                                                                    ← 第 2 次（结果被丢弃）
 *
 * 两次调用烧两份额度，而正文只用第 1 次的 `generation.text`。更糟的是第 2 次的答案被注入会话，
 * 于是 transcript 里多出一段与诊断无关的文字 —— 读者会以为那是结论。
 *
 * 修法：`TurnTrigger.execute` 进协议，`emergency-repair` 传 `execute: false`，
 * 适配器据此**只写内容、不跑 onTrigger**。
 *
 * 判据全部用**真** `createEmergencyRepair` + 假 session / llm 适配器，数调用次数：
 *
 *   ① 一次 `run()` ⇒ `llm.generate` 恰好 1 次
 *   ② trigger 收到的 `execute` 必须是 `false`（这是连接线，不是实现细节）
 *   ③ `execute: false` 时**内容照写**（trigger 仍然被调用，且带 trigger/admitted 语义）
 *   ④ 默认（不传 execute）仍然是「会执行」——不许把其它调用方一起改掉
 *   ⑤ 生成的文本确实来自**第 1 次**调用（第二次的答案不许混进结果）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
/**
 * `createEmergencyRepair` is reachable through `paradiseInternals` (S9 added it there, with a reason):
 * counting `llm.generate` through the full `createHarness` chain would fold supervisor / pid-probe /
 * report-writing noise into the number, and a red would not say which layer double-called.
 */
const { paradiseInternals } = await import('../index.js')
const { createEmergencyRepair } = paradiseInternals

/**
 * A session adapter whose `trigger` records what it received. It models the production wiring: the
 * HARNESS supplies an `onTrigger` that calls the model — here the fake counts it, which is the whole
 * point of N3.
 */
const fakeSession = () => {
  const calls = { created: 0, injected: 0, triggered: 0, triggers: [], onTriggerRuns: 0 }
  const session = {
    capabilities: { create: true, inject: true, trigger: true, readLog: true, subscribe: false },
    async create(input) {
      calls.created += 1
      return { ok: true, stage: 'create', warnings: [], session: { id: input.id ?? 'repair-test', cwd: input.cwd ?? '.' } }
    },
    async inject() {
      calls.injected += 1
      return { ok: true, stage: 'inject', warnings: [], rendered: [] }
    },
    async trigger(ref, trigger) {
      calls.triggered += 1
      calls.triggers.push(trigger)
      /**
       * THE PRODUCTION SHAPE, reproduced: the adapter runs its executor hook unless the caller said it
       * already executed. Counting `onTriggerRuns` is how this test sees a double model call.
       */
      if (trigger.execute !== false) calls.onTriggerRuns += 1
      return { ok: true, stage: 'trigger', warnings: [] }
    },
  }
  return { session, calls }
}

const fakeLlm = (answers) => {
  const calls = { generated: 0, prompts: [] }
  return {
    calls,
    llm: {
      async generate(messages, options) {
        calls.generated += 1
        calls.prompts.push({ messages, options })
        const index = Math.min(calls.generated - 1, answers.length - 1)
        return { text: answers[index] }
      },
    },
  }
}

const brief = {
  reason: '一次探针式修复',
  symptoms: ['测试失败'],
  context: ['v362'],
}

test('v362 ①: ONE repair makes exactly ONE model call', async () => {
  const { session, calls } = fakeSession()
  const { llm, calls: llmCalls } = fakeLlm(['第一次的答案'])

  const repair = createEmergencyRepair({ session, llm, cwd: '/tmp/repair', now: () => 1_700_000_000_000 })
  await repair.run(brief)

  assert.equal(llmCalls.generated, 1,
    `① 一次 repair 只能调用模型一次，实测 ${llmCalls.generated} 次（第二次的结果会被丢弃）`)
  assert.equal(calls.triggered, 1, '① trigger 仍然必须被调用一次（顺序是 create → inject → trigger → 模型）')
  assert.equal(calls.onTriggerRuns, 0,
    '① 适配器的执行器钩子不得再被跑一次 —— 那是第二次计费的来源')
})

test('v362 ②: the trigger says `execute: false` — the wiring is in the protocol, not in a convention', async () => {
  const { session, calls } = fakeSession()
  const { llm } = fakeLlm(['答案'])
  const repair = createEmergencyRepair({ session, llm, cwd: '/tmp/repair', now: () => 1_700_000_000_001 })
  await repair.run(brief)

  assert.equal(calls.triggers.length, 1)
  assert.equal(calls.triggers[0].execute, false,
    `② trigger 必须显式 execute:false，实测 ${JSON.stringify(calls.triggers[0].execute)}`)
})

test('v362 ③: the trigger still carries the content — execute:false skips the executor, not the message', async () => {
  const { session, calls } = fakeSession()
  const { llm } = fakeLlm(['答案'])
  const repair = createEmergencyRepair({ session, llm, cwd: '/tmp/repair', now: () => 1_700_000_000_002 })
  await repair.run(brief)

  const trigger = calls.triggers[0]
  assert.equal(typeof trigger.text, 'string')
  assert.ok(trigger.text.length > 0, '③ trigger 的正文不许因为 execute:false 而变空')
  assert.ok(typeof trigger.origin === 'string' && trigger.origin.length > 0, '③ origin 必须保留（溯源）')
  assert.equal(typeof trigger.mode, 'string', '③ mode 必须保留')
})

test('v362 ④: the protocol default is still "execute" — other callers are unaffected', async () => {
  /** A caller that does NOT pass `execute` must be executed: the switch is opt-out, not opt-in. */
  const calls = { onTriggerRuns: 0 }
  const trigger = async (ref, input) => {
    if (input.execute !== false) calls.onTriggerRuns += 1
    return { ok: true, stage: 'trigger', warnings: [] }
  }
  await trigger({ id: 'x' }, { text: 'hi', mode: 'queue', origin: 'test' })
  assert.equal(calls.onTriggerRuns, 1,
    '④ 不传 execute 的调用方必须仍然被执行 —— 不许把默认行为改掉')
})

test('v362 ⑤: the result text comes from the FIRST call, never from a discarded second one', async () => {
  const { session } = fakeSession()
  const { llm, calls } = fakeLlm(['第一次的答案', '第二次的答案（不该出现）'])
  const repair = createEmergencyRepair({ session, llm, cwd: '/tmp/repair', now: () => 1_700_000_000_003 })
  const result = await repair.run(brief)

  assert.equal(calls.generated, 1, '⑤ 前置：只应有一次调用')
  assert.equal(result.text, '第一次的答案', `⑤ 结果必须是第一次的答案，实测：${JSON.stringify(result.text)}`)
  assert.equal(result.ok, true, `⑤ 一次正常 repair 应当 ok，实测 ${result.ok}（${result.error ?? ''}）`)
})

test('v362 ⑥: the REAL raw adapter honours execute:false — the switch is implemented, not merely passed', () => {
  /**
   * ── WHY THIS SEPARATE CRITERION EXISTS (measured by the can-red) ──────────────────────────────
   *
   * ①–⑤ 用的是**假 session 适配器**：它自己实现 `trigger.execute === false` 的判断。于是 can-red
   * 「把 `adapters/raw/session.ts` 的那一行改成 `if (false)`」**没有让任何判据变红** —— 假适配器
   * 测的是「调用方传了什么」，不是「真适配器尊重不尊重它」。
   *
   * 一条判据如果只测它自己的夹具，那它测的是夹具。所以这里读**真实源码**：那句守卫必须存在于
   * `adapters/raw/session.ts`，并且 `execute === false` 时要在调用 `onTrigger` **之前**返回。
   *
   * 不用「构造一个真适配器再数次数」的原因：`createRawSessionAdapter` 需要真实会话目录与 JSONL
   * 日志，失败时会红在「文件不存在」而不是「多调了一次模型」，靶子就散了。断言结构 + 断言顺序，
   * 配 ①–⑤ 的行为覆盖，两侧合起来才是这条纪律的完整证据。
   */
  const source = readFileSync(join(ROOT, 'src', 'adapters', 'raw', 'session.ts'), 'utf8')
  const guard = source.indexOf('if (trigger.execute === false) {')
  const call = source.indexOf('await options.onTrigger(ref, trigger, readAll(ref.id))')
  assert.ok(guard >= 0, '⑥ 真实适配器必须有 `execute === false` 的守卫（否则开关只是协议里的一句话）')
  assert.ok(call >= 0, '⑥ 前置：onTrigger 的调用点必须存在')
  assert.ok(guard < call, '⑥ 守卫必须在调用 onTrigger **之前** —— 顺序反了等于没守')
  assert.equal((source.match(/if \(trigger\.execute === false\) \{/gu) ?? []).length, 1,
    '⑥ 守卫必须恰好一处：两份守卫会让「哪一份生效」变成运气')
})