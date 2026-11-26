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

test('v374 ④ (N3): the move account closes — 77 moved, 72 net, and the 5 explained', () => {
  /**
   * 判据读 ARCHITECTURE.md 的进度段，要求**两个数字都在**且差额被点明。
   *
   * 第一版只看**单行**，而文档把「搬 77 行」与「净 −72」写在相邻两行（一是登记行、一是账目段）。
   * 那是判据的读法太窄：N3 要的是**这一簇的账**能对上，不是「这两个数必须在同一行」。
   * 所以改成读那一簇的**段落窗口**（登记行 + 其后三行）。
   */
  const arch = readFileSync(join(ROOT, '..', 'dsh-graft-slice', 'ARCHITECTURE.md'), 'utf8')
  const lines = arch.split('\n')
  const rowAt = lines.findIndex((text) => /open-background-work/u.test(text) && /登记|core\//u.test(text))
  assert.ok(rowAt >= 0, '④ ARCHITECTURE 必须有一行登记新模块')

  const window = lines.slice(rowAt, rowAt + 4).join('\n')
  const moved = Number((window.match(/(\d+)\s*行/u) ?? [])[1] ?? NaN)
  assert.ok(Number.isFinite(moved),
    `④ 必须写出搬了多少行，实测窗口：${window.slice(0, 220)}`)

  assert.ok(/净\s*[−-]?\s*\d+|−\s*\d+/u.test(window),
    `④ 必须写出净变化，实测窗口：${window.slice(0, 220)}`)

  assert.ok(/import|分隔|re-export|空行/u.test(window),
    `④ 差额必须被解释（import / 分隔 / re-export / 空行中的至少一项）—— 两个数字并置而不解释，正是 N3 那处误导：${window.slice(0, 300)}`)
})
