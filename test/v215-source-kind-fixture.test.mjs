/**
 * ── v215: `source.kind` 全集快照（B0.8）────────────────────────────────────────────────────────
 *
 * ── 这个文件是什么，不是什么 ──────────────────────────────────────────────────────────────────
 *
 * 它**不是** classifier（那是 B1.1）。它是一个**夹具的守卫**：证明
 *   `test/fixtures/source-kinds.json` 里存在 19 种 kind、每种都有可识别的样本、
 *   总数与实测对得上。
 *
 * B1.1 要写 `content-classifier`，把每条 `user/message` 按 `source.kind` 分成
 * 「人写的 / 插件写的 / 时间上下文 / 系统注入」。分类器最怕的不是逻辑错，
 * 是**它只认识自己写测试时想到的那几种 kind**。这个夹具就是那份「全集」。
 *
 * ── 数据从哪来（重要，写在文件里而不是口头）─────────────────────────────────────────────────
 *
 * 19 种 kind 与 `observedCount` 是**实测值**：扫 227 个真实日志、5,967 条 `user/message` 的
 * `source.kind` 聚合而来（B0 派工单 §8）。
 *
 * `sampleText` 是**按 kind 的语义构造的最小样本**，不是语料原文 —— 原文受会话内容约束，
 * 且分类器需要的是「每种 kind 的最小可识别形态」。这一点在夹具的 `_provenance` 里也写了。
 *
 * ── ⚠ 新 kind 出现会怎样（这一节必须看）───────────────────────────────────────────────────────
 *
 * **本文件不会自动发现新 kind。** 它读的是一个冻结的 JSON，而机器上的会话日志每天在增长。
 * 也就是说：
 *
 *   · 明天出现第 20 种 `source.kind`（比如某个新插件 `plugin:foo`），
 *     **本测试仍然绿** —— 它只知道夹具里那 19 种。
 *   · 后果不是「测试坏了」，而是 **B1.1 的分类器会静默把它归进"未知"桶**，
 *     而那个桶如果被当作「不重要」处理，新插件的上下文就再也不会进 prompt。
 *
 * 所以新 kind 的**发现**不能靠这个测试，要靠一条**重扫**（B1.1 或 B4 的巡检）：
 * 重扫语料 → 与 `source-kinds.json` 的 kind 集合比对 → 多出来的必须有人决定它属于哪一类。
 *
 * 本文件能做的是把「新增」变成一次**显式的编辑**：`totalObserved` 与 `kinds.length`
 * 都被钉死，改夹具就得改这里，而改这里会出现在 diff 里 —— 一个需要人点头的动作，
 * 而不是一次静默的漂移。这与 `check-readme-counts` 的做法是同一个思路。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const FIXTURE = join(ROOT, 'test', 'fixtures', 'source-kinds.json')

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))
const kinds = fixture.kinds ?? []

/**
 * 19 种，逐字来自 B0 派工单 §8 的实测表。
 * 顺序与那张表一致（按 observedCount 降序），这样 diff 时能一眼看出谁变了位置。
 */
const EXPECTED_KINDS = [
  'user',
  'time-context',
  'plugin:graft-replay',
  'runtime-context',
  'subagent-settled',
  'agent-message',
  'skill-catalog',
  'model-selection',
  'tool-jobs',
  'user-approval',
  'agent-instructions',
  'plugin:dsh-memory',
  'goal',
  'compact-checkpoint',
  'repeat-tool-reminder',
  'plugin:chat-import',
  'working-directory',
  'tool-goal',
  'plugin:observer-briefing',
]

/** 实测计数，逐字来自同一张表。 */
const EXPECTED_COUNTS = {
  'user': 2224,
  'time-context': 1715,
  'plugin:graft-replay': 615,
  'runtime-context': 338,
  'subagent-settled': 276,
  'agent-message': 227,
  'skill-catalog': 208,
  'model-selection': 153,
  'tool-jobs': 89,
  'user-approval': 27,
  'agent-instructions': 25,
  'plugin:dsh-memory': 22,
  'goal': 19,
  'compact-checkpoint': 11,
  'repeat-tool-reminder': 5,
  'plugin:chat-import': 4,
  'working-directory': 4,
  'tool-goal': 4,
  'plugin:observer-briefing': 1,
}

test('v215 ①: 夹具含 19 种 kind，与实测表逐字一致', () => {
  const actual = kinds.map((k) => k.kind)
  assert.deepEqual(actual, EXPECTED_KINDS,
    `夹具的 kind 集合与实测表不一致。\n`
    + `  夹具独有（多了）：${actual.filter((k) => !EXPECTED_KINDS.includes(k)).join(', ') || '无'}\n`
    + `  实测独有（少了）：${EXPECTED_KINDS.filter((k) => !actual.includes(k)).join(', ') || '无'}\n`
    + '若确实出现了新 kind，请更新实测表与 EXPECTED_KINDS（并在夹具 _provenance 记一行），'
    + '不要只改一边 —— 两边都改才是「有人决定过」。')
})

test('v215 ②: 每种 kind 都有非空的 sampleText（空样本等于没有样本）', () => {
  const empty = kinds
    .filter((k) => typeof k.sampleText !== 'string' || k.sampleText.trim().length === 0)
    .map((k) => k.kind)
  assert.deepEqual(empty, [],
    `这些 kind 的 sampleText 是空的（或不是字符串）：${empty.join(', ')}。`
    + 'B1.1 的分类器需要一个可识别的最小形态；空串会让「分类成功」和「没喂进去」看起来一样。')
})

test('v215 ③: sampleText 不重复 —— 同一条样本不能代表两种 kind', () => {
  /**
   * 若两种 kind 共用同一个 sampleText，那么夹具就无法证明分类器能**区分**它们：
   * 一条输入对应两个正确答案，分类器怎么答都有一半是错的。
   */
  const seen = new Map()
  const duplicates = []
  for (const k of kinds) {
    const key = String(k.sampleText).trim()
    if (seen.has(key)) duplicates.push(`${seen.get(key)} 与 ${k.kind}`)
    else seen.set(key, k.kind)
  }
  assert.deepEqual(duplicates, [],
    `这些 kind 共用了同一个 sampleText，分类器无法据此区分它们：\n  ${duplicates.join('\n  ')}`)
})

test('v215 ④: 总数与实测一致（5967），不是「≥5000」就算过', () => {
  /**
   * 派工单允许放宽为 `≥5000`，但**这里不放宽**，理由是：放宽会把
   * 「我少算了一大块语料」变成一个仍然绿的测试。5967 是实测数，
   * 与 `kinds` 各条的 observedCount 之和必须同时对得上 ——
   * 两条断言互相校验，任何一边写错都会露出来。
   */
  const sum = kinds.reduce((s, k) => s + Number(k.observedCount ?? 0), 0)

  assert.equal(sum, fixture.totalObserved,
    `各 kind 的 observedCount 之和（${sum}）与 totalObserved（${fixture.totalObserved}）不一致`)
  assert.equal(fixture.totalObserved, 5967,
    `totalObserved 应为实测的 5967，实测 ${fixture.totalObserved}。`
    + '若语料重扫后数字变了，请一并更新夹具与本文的 EXPECTED_COUNTS，并说明重扫范围。')
})

test('v215 ⑤: 每个 observedCount 与实测表逐项相等', () => {
  const mismatches = kinds
    .filter((k) => Number(k.observedCount) !== EXPECTED_COUNTS[k.kind])
    .map((k) => `${k.kind}: 夹具 ${k.observedCount} vs 实测 ${EXPECTED_COUNTS[k.kind]}`)
  assert.deepEqual(mismatches, [],
    `这些 kind 的计数与实测表不一致：\n  ${mismatches.join('\n  ')}`)
})

test('v215 ⑥: observedCount 降序排列（让 diff 一眼看出谁动了）', () => {
  /**
   * 不是为了美观：夹具是给人读的，按频次排序意味着
   * 「加了一条 kind」会立刻在末尾出现，而「某条计数暴增」会看到它往上移。
   * 无序的夹具每次编辑都是全文件 diff。
   */
  const counts = kinds.map((k) => Number(k.observedCount))
  const sorted = [...counts].sort((a, b) => b - a)
  assert.deepEqual(counts, sorted,
    `observedCount 必须降序：实测 ${JSON.stringify(counts)}`)
})

test('v215 ⑦: 夹具声明了它的来源与「新 kind 出现会怎样」', () => {
  /**
   * 一个没有出处的数据快照，半年后没人知道它是实测的、还是某人拍的。
   * 那条 `_provenance` 与「新 kind 不会被本测试发现」的说明都属于**数据的一部分**：
   * 它们决定了这份夹具能不能被信任。
   */
  const p = fixture._provenance
  assert.ok(p !== undefined, '夹具必须带 _provenance：没有出处的快照无法被信任')
  assert.ok(typeof p.measuredAt === 'string' && p.measuredAt.length > 0, '_provenance.measuredAt 必须写明')
  assert.ok(typeof p.corpus === 'string' && p.corpus.includes('227'), `_provenance.corpus 应写明语料规模，实测 ${JSON.stringify(p.corpus)}`)
  assert.ok(typeof p.whyCountsAreFrozen === 'string' && p.whyCountsAreFrozen.length > 40,
    '_provenance 必须说明「计数为什么要冻结」，否则下一个人会以为直接改数字就行')
})
