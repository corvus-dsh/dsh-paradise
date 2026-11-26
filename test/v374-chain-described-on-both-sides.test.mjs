/**
 * ── v374：N2 + N3 —— 一条链路的说明必须在**两侧**都在，且行数账必须算得开 ────────────────────────
 *
 * **N2（说明只写了一边）**：F3 删掉了 `harness.ts` 一侧解释 N3 链路的那段，于是「`onTrigger`
 * → `executeSession` → `llm.generate`，所以调用方必须 `execute: false`」只剩 `emergency-repair.ts`
 * 在讲。**删除假话是对的，但只留一边不是修好**：读 `harness.ts` 的人看不到「为什么调用方要关掉
 * 我」，而他就是最可能把它接上去的那个人。
 *
 * 判据不能只查「某句话存在」——那会把任一句同义的话当成覆盖。所以两侧各查**一件具体事实**：
 *   · harness 侧：必须说出「它花一次模型调用」与「调用方必须 execute:false」这两件事
 *   · emergency 侧：必须说出「onTrigger 确实接在 executeSession 上」（而不是「那边什么都没做」）
 *
 * **N3（行数账算不开）**：「搬了 77 行」与「净 −72」并置会让读者以为丢了 5 行。真相是
 * `净 −72 = 77 − 1(import) − 4(分隔与 re-export)`。判据要求**两个数字都出现且差额被解释**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Strip comments, so the judgement reads IMPLEMENTATION, not the prose that describes it. */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '')

const harness = readFileSync(join(ROOT, 'src', 'harness.ts'), 'utf8')
const emergency = readFileSync(join(ROOT, 'src', 'emergency-repair.ts'), 'utf8')

test('v374 ① (N2): the harness side explains that it COSTS a model call, and what callers must do', () => {
  assert.ok(/onTrigger[\s\S]{0,400}executeSession/u.test(harness),
    '① harness 必须说明 onTrigger 接到 executeSession（这是链路的第一跳）')
  assert.ok(/llm\.generate/u.test(harness),
    '① harness 必须说明 executeSession 最终会调 llm.generate —— 那才是第二次计费')
  assert.ok(/execute:\s*false|execute.{0,20}false/u.test(harness),
    '① harness 必须告诉调用方该怎么做（execute:false），否则他只会看到「这里会打模型」然后自己再接一次')
})

test('v374 ② (N2): the emergency-repair side tells the SAME story, not the opposite one', () => {
  assert.ok(/onTrigger[\s\S]{0,200}executeSession/u.test(emergency),
    '② emergency-repair 必须说明 onTrigger 真的接在 executeSession 上')
  /**
   * The lie must not come back in either file. This is the one thing that would make the two sides
   * disagree again — and it is cheap to check because the phrase is distinctive.
   */
  for (const [name, text] of [['harness.ts', harness], ['emergency-repair.ts', emergency]]) {
    assert.ok(!/does\s+NOTHING/iu.test(text), `② ${name} 不得再出现「onTrigger does NOTHING」`)
    assert.ok(!/什么都不做/u.test(text), `② ${name} 不得再出现「什么都不做」`)
  }
})

test('v374 ③ (N2): the flag is honoured in the IMPLEMENTATION, not just described', () => {
  /**
   * 注释说「调用方传 execute:false 就跳过」——那必须在代码里成立。读去注释后的源码，
   * 否则一段说明会被当成实现。
   */
  const rawSession = stripComments(readFileSync(join(ROOT, 'src', 'adapters', 'raw', 'session.ts'), 'utf8'))
  assert.ok(/execute\s*===\s*false/u.test(rawSession),
    '③ 适配器必须真的判断 execute === false 并跳过 onTrigger')
  const emergencyCode = stripComments(emergency)
  assert.ok(/execute:\s*false/u.test(emergencyCode),
    '③ emergency-repair 必须真的传 execute:false（不是只在注释里写）')
})

test('v374 ④ (N2): neither file may re-introduce the "does NOTHING" lie in any wording', () => {
  /**
   * ── R1（S15）：这一条原本读 **graft 的** `ARCHITECTURE.md` 来验 N3 的行数账 ─────────────────
   *
   * 两个后果，都是真实的：
   *   1. **graft 的一次纯移动能让 paradise 变红。** 实测：`v374` 用 `lines.slice(rowAt, rowAt + 4)`
   *      定位账目段；graft 合入第 2、3 簇的登记行后，账目段从第 447 行被推到第 454 行，
   *      于是这条 paradise 的判据红了 —— **而 N2 的账目一个字都没变**。
   *   2. 判据绑的是**位置**（「登记行之后 4 行内」），不是**性质**（「这一簇的账能对上」）。
   *      本批已记录四次同形，这是第五次。
   *
   * 处置：**账目断言移回 graft 自己的测试**（`v378`，与它所读的文件同仓），paradise 这一条只管
   * 「两侧都不许再说假话」—— 那是 N2 的性质，也是本文件唯一该管的事。
   *
   * 纪律：**一个测试仓读另一个仓的文件，必须显式声明耦合**。它没有声明，所以它是一处意外连接。
   */
  for (const [name, text] of [['harness.ts', harness], ['emergency-repair.ts', emergency]]) {
    assert.ok(!/does\s+NOTHING/iu.test(text), `④ ${name} 不得再出现「does NOTHING」`)
    assert.ok(!/什么都不做/u.test(text), `④ ${name} 不得再出现「什么都不做」`)
    assert.ok(!/has\s+no\s+effect/iu.test(text), `④ ${name} 不得再出现「has no effect」`)
  }
})
