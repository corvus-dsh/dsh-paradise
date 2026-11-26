/**
 * ── v367：能力声明的诚实性 —— 注释不许与它同一文件里的代码矛盾 ────────────────────────────────────
 *
 * 病（F3，`src/harness.ts`，实测 2026-11-26）：
 *
 *   :330-336  「The session adapter is created with an `onTrigger` that does NOTHING here on purpose …
 *              Wiring the model into `onTrigger` as well would call it twice per repair.」
 *   :365-370  onTrigger: async (ref) => { await executeSession(ref) }
 *   :352-358  executeSession 里 `await llm.generate(conversation, …)` —— **就是那次模型调用**
 *
 * 注释说「这里什么都不做」，而 20 行之后它就在打模型。这不是笔误：它是**能力声明**。
 * S9/N3 修好双计费之后，这段注释留着的唯一效果，是让下一个读它的人以为「模型不在这里」，
 * 从而在别处再接一次 —— 那会把 N3 修掉的缺陷按注释的指示重新造出来。
 *
 * ── 为什么这条判据要同时读两侧 ──────────────────────────────────────────────────────────────
 *
 * 只查注释里有没有「does NOTHING」⇒ 任何人换一句同义的话就绕过去了，而且会惩罚一句诚实的
 * 「它并不做 X」。只查代码 ⇒ 看不见矛盾。
 *
 * 所以判据是**条件式**的：**先证明代码事实**（onTrigger 真的会走到模型），**再要求文件里不存在
 * 声称「onTrigger 什么都不做」的注释**。两条都成立才是绿；代码变了判据自己会失效（第一侧红），
 * 注释回来了第二侧红。**判据不假设哪一侧是对的 —— 它要求两侧说的是同一件事。**
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const HARNESS = join(ROOT, 'src', 'harness.ts')
const source = readFileSync(HARNESS, 'utf8')

/**
 * 把注释从代码里分出来，两侧分别审。
 *
 * 一个只在整份文本上 grep 的判据，会**同时**命中「注释里说的」和「代码里写的」—— 那正是这轮要
 * 分开的两件事。所以先切开：注释归注释，代码归代码。
 */
const comments = [...source.matchAll(/\/\*\*[\s\S]*?\*\/|\/\/[^\n]*/gu)].map((m) => m[0])
const code = source.replace(/\/\*\*[\s\S]*?\*\/|\/\/[^\n]*/gu, '')

test('v367 ①: the code fact — onTrigger really does reach the model', () => {
  /**
   * 第一侧：**证明**「注释若说它什么都不做，那就是假话」。
   *
   * 这一侧若红，说明代码被改成了真的不调用模型 —— 那时第二侧（注释）就不再是缺陷，
   * 而这个判据已经失效，应当由注意到 ① 红的人重新裁定，不是把 ② 放宽。
   */
  assert.ok(/onTrigger\s*:\s*async/u.test(code),
    '① 找不到 onTrigger 的实现 —— 判据的前提（它存在）不成立')
  assert.ok(/onTrigger\s*:\s*async\s*\([^)]*\)\s*=>\s*\{[\s\S]{0,200}?executeSession\s*\(/u.test(code),
    '① onTrigger 必须真的调用 executeSession —— 否则「它什么都不做」这句反而是真的')
  assert.ok(/executeSession[\s\S]{0,2000}?llm\.generate\s*\(/u.test(code),
    '① executeSession 必须真的调用 llm.generate —— 否则它的「执行」不是模型调用')
})

test('v367 ②: no comment may claim onTrigger does NOTHING, because ① proves it does', () => {
  /**
   * 第二侧：注释不许声称一个**被判据①证明为假**的事实。
   *
   * 允许的写法：「onTrigger 负责执行」「模型调用在 harness 侧」。禁止的写法是**否定式断言的绝对句**
   * ——「does NOTHING」「does nothing here」「has no effect」。
   *
   * 刻意不收窄成某一个具体句式：**这里要禁的是「说它不做」这个意思**，
   * 而只禁一句话会让下一句同义的话溜过去（本仓已记过三次：判据绑在名字/句子上就会漏掉性质）。
   */
  const denials = [
    /onTrigger[^.]{0,120}does\s+NOTHING/iu,
    /onTrigger[^.]{0,120}does\s+nothing/iu,
    /onTrigger[^.]{0,120}has\s+no\s+effect/iu,
    /onTrigger[^.]{0,120}什么\s*都不做/u,
  ]
  const offenders = []
  for (const comment of comments) {
    for (const denial of denials) {
      if (denial.test(comment)) {
        offenders.push(comment.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4).join(' / '))
        break
      }
    }
  }
  assert.deepEqual(offenders, [],
    `② 这些注释声称 onTrigger 什么都不做，而 ① 证明它就在打模型：\n  ${offenders.join('\n  ')}`)
})

test('v367 ③: the surviving comment must say what actually happens (not merely delete the lie)', () => {
  /**
   * ③ 防的是「把注释删干净就算修好」。删掉假话是必要的，但下一步读这段代码的人仍然需要知道
   * **执行在哪一侧**——否则他会在 adapter 里再接一次，那是同一个缺陷的另一种到达路径。
   *
   * 这条只要求在 harness.ts 里**存在**一句说明「模型由 harness 侧供给」的话（不是特定措辞）。
   */
  const statesWhoSupplies = comments.some((c) =>
    /(harness\s+(supplies|provides)|模型调用.*harness|harness.*(supplies|provides).*model|THE MODEL IS THE HARNESS)/iu.test(c))
  assert.ok(statesWhoSupplies,
    '③ 删掉假话之后，文件里必须仍有一句说明「模型由 harness 侧供给」—— 否则下一个读的人会在 adapter 里再接一次')
})
