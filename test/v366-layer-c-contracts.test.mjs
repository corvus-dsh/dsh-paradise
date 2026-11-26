/**
 * ── v366：S12 / 层 C 契约与 DEFER 登记（四仓同源）────────────────────────────────────────────────
 *
 * 工单的出口条件：「六条契约齐全；`O27–O47` 全 `DEFER`，**文件内零 `PASS`**」。
 *
 * 为什么要一条判据而不是靠人读：这份文件的**唯一用途**是阻止「还没做」被读成「不需要做」，
 * 或者被读成「下一步做它」。所以它最危险的退化不是写错字，是**有人把 DEFER 改成 PASS**
 * —— 那一改让冻结名单看起来像完成清单，而完成清单是可以继续推进的。
 *
 * 判据：
 *   ① 六条契约齐全（O27 / O28 / O29 / O30 / O31 + O32–O47 的启动门槛）
 *   ② `O27`–`O47` 的**每一项**都被点名（不许只写一个范围就以为覆盖了全部）
 *   ③ **零完成态断言**：这些项不得出现 PASS / DONE / 已完成 / 已实现 / 已验收
 *   ④ 三条启动门槛齐全（长期会话 / 先决契约 / OT）
 *   ⑤ 「DEFER 不是 PASS 也不是 TODO」的三行对照必须在（这是本文件的核心命题，不是装饰）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PATH = join(ROOT, 'ARCHITECTURE-INVARIANTS.md')
const text = readFileSync(PATH, 'utf8')

test('v366 ①: the six layer-C contracts are all present', () => {
  /** O27–O31 是五条接口契约；O32–O47 的**启动门槛**是本文件的第六条。 */
  for (const [id, title] of [
    ['O27', 'Core Node Contract'],
    ['O28', 'BeiAn Extension'],
    ['O29', 'Spark Coordination'],
    ['O30', 'Dashboard Query Layer'],
    ['O31', '跨节点 Trace'],
  ]) {
    assert.ok(text.includes(id), `① 缺少 ${id}`)
    assert.ok(text.includes(title), `① ${id} 的标题必须出现（${title}）`)
  }
  assert.ok(/O32[–\-]O47/u.test(text), '① 第六条契约（O32–O47 的启动门槛）必须出现')
})

test('v366 ②: EVERY item O27..O47 is named — a range is not a coverage claim', () => {
  /**
   * 「O27–O47 全 DEFER」这句话本身**不点名任何一项**。一个只写了范围的清单，无法阻止其中某一项
   * 被悄悄实现：读者看到的是范围，实现者动的是编号。所以逐项点名。
   */
  const missing = []
  for (let n = 27; n <= 47; n += 1) {
    const id = `O${n}`
    if (!text.includes(id)) missing.push(id)
  }
  assert.deepEqual(missing, [], `② 这些项没有被点名：${missing.join(', ')}`)
})

test('v366 ③: ZERO completion assertions for O27..O47 — DEFER is not PASS', () => {
  /**
   * 判据的方向是**负向**的：本文件最危险的退化是把冻结名单写成完成清单。
   *
   * 扫描范围限定在提到 O27–O47 的行，并排除两类**不是断言**的行（都是实测撞出来的）：
   *
   *   ① §三 的词义对照表 —— 它**故意**把 PASS 这些词列出来作为反例；
   *   ② 启动门槛句 —— 「先决契约：O27–O31 加 … 全 **PASS 且独立验收**」描述的是**将来要满足的条件**，
   *      不是「现在已经 PASS」。第一版判据把它误判成完成态断言，而它恰恰是**门槛**本身。
   *
   * 区分办法：门槛句里带有「门槛 / 先决 / 全 … 且独立验收 / 需同时满足」这类**条件词**。
   * 一个只靠词表判定的判据，会在它最该保护的句子上误报 —— 那会教人把门槛句删掉。
   */
  const lines = text.split('\n')
  const offenders = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!/O(?:2[7-9]|3[0-9]|4[0-7])\b/u.test(line)) continue
    /** §三 的词义对照：它点名这些词是为了禁止它们。 */
    if (/禁止|不得|不是|含义|词义/u.test(line)) continue
    /** 启动门槛：描述「将来必须满足」，不是「现在已完成」。 */
    if (/门槛|先决|需\*\*同时\*\*满足|全 \*\*PASS 且独立验收\*\*/u.test(line)) continue
    if (/\bPASS\b|已完成|已实现|已验收|DONE/u.test(line)) offenders.push(`L${index + 1}: ${line.trim().slice(0, 120)}`)
  }
  assert.deepEqual(offenders, [],
    `③ 冻结名单里出现了完成态断言（DEFER 不是 PASS）：\n  ${offenders.join('\n  ')}`)
})

test('v366 ④: the three start gates are written as DECIDABLE conditions', () => {
  assert.match(text, /长期会话门槛[\s\S]{0,120}14[–-]30 天/u, '④ 门槛一：长期会话（14–30 天 L4）')
  assert.match(text, /先决契约[\s\S]{0,160}O27[–-]O31/u, '④ 门槛二：先决契约（O27–O31 + 五项）')
  assert.match(text, /OT 特别门槛[\s\S]{0,120}物理设备/u, '④ 门槛三：OT（只在接真实物理设备时成为 P0）')
})

test('v366 ⑤: the DEFER / PASS / TODO distinction is stated, because that distinction IS the file', () => {
  assert.ok(text.includes('`DEFER` 不是 `PASS`') || text.includes('**DEFER**'),
    '⑤ 必须显式陈述 DEFER 的三义区分')
  for (const word of ['PASS', 'DEFER', 'TODO']) {
    assert.ok(text.includes(word), `⑤ 词义对照必须同时出现 ${word}`)
  }
  assert.match(text, /越界/u, '⑤ 必须写明「启动 DEFER 项是越界，不是推进」')
})