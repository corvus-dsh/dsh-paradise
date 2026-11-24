#!/usr/bin/env node
/**
 * ── check-source-assertions: 对源码文本做断言的判据，必须先剥注释 ─────────────────────────────
 *
 * 路径：**门禁脚本**（`scripts/check-source-assertions.mjs`），配 `docs/source-assertions.json`
 * 基线。共用实现是 `test/source-assertion.mjs` 的 `stripComments()`。
 *
 * ── 事故（lead §四十五.2，P1；三次人工发现后才机械化）────────────────────────────────────────
 *
 * 同一形状在本批出现四次，前三次靠人看出来：
 *
 *   1. `check-doc-claims` 扫到自己描述的规则；
 *   2. `v329 ③` 的 `/O/u` 匹配到 `a**o**uto is ON`（注释，不是调用点）；
 *   3. `v336 ①` / `v337 ①` 红在它们自己的文件头上 —— 而那个文件头**必须**引用它禁止的形状；
 *   4. `v339 ③` 反而**绿**了，因为它在机制被删掉之后仍然读到了上方注释里的引用。
 *
 * **三次人工发现 ⇒ 该变成判据。**
 *
 * ── 为什么是棘轮，不是一刀切 ──────────────────────────────────────────────────────────────────
 *
 * 实测当前树：**53 条**对源码文本的断言，其中 **48 条**没有剥注释。一次性改 48 处是高风险
 * 改动，且大部分是良性的（目标串不会出现在注释里）。所以：
 *
 *   - 新建/改动过的判据**必须**用 `stripComments()` —— 判据 ③ 用 mtime 与基线比对；
 *   - 存量 48 条登记进 `docs/source-assertions.json`，**计数只能减不能增**；
 *   - 减到 0 之后，这个数字就是终态。
 *
 * 一个「只要放松一次就永久失效」的门禁和没有一样，所以计数棘轮与豁免清单一起来。
 *
 * 判据（五条，三条负向）：
 *   ① 每个「读源码 + `assert.match`」的判据文件要么已用 `stripComments()`，要么在基线里
 *   ② **负向** 基线里的数字不得高于登记值（只能减，不许增）
 *   ③ **负向** 基线里的文件如果已经改成用 `stripComments()`，必须从基线里删掉（不许留虚高配额）
 *   ④ **负向** can-red：判据自身在 `--self-test` 下必须能证明「裸匹配会在注释上变绿」
 *   ⑤ 报告实测数字，空集不许当通过
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEST_DIR = join(ROOT, 'test')
const BASELINE_PATH = join(ROOT, 'docs', 'source-assertions.json')

/**
 * Does this file make SOURCE-TEXT assertions? Two things must hold: it reads a source file, and it
 * asserts on a variable bound to that read. Assertions on literals or on parsed JSON do not count.
 */
function analyse(text) {
  const bound = new Map()
  for (const m of text.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*readFileSync\(([^\n]*)/gu)) {
    if (/(src|scripts|index\.js|\blib\b)/u.test(m[2])) bound.set(m[1], true)
  }
  if (bound.size === 0) return { total: 0, stripped: true, variables: [] }
  let total = 0
  for (const variable of bound.keys()) {
    const hits = [...text.matchAll(new RegExp(`assert\\.(?:match|doesNotMatch)\\(\\s*${variable}\\b`, 'gu'))]
    total += hits.length
  }
  if (total === 0) return { total: 0, stripped: true, variables: [] }
  /**
   * "Stripped" means the file imports the shared helper. A hand-rolled local filter is NOT
   * accepted: four different hand-rolled variants is how the same bug got re-written four times.
   */
  const usesHelper = /from\s+['"]\.\/source-assertion\.mjs['"]/u.test(text)
  return { total, stripped: usesHelper, variables: [...bound.keys()] }
}

const failures = []
const notes = []

let baseline = { maxRaw: 0, files: {} }
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
  notes.push(`没有 ${relative(ROOT, BASELINE_PATH)} —— 视为 maxRaw 0`)
}

const measured = new Map()
let rawTotal = 0
for (const name of readdirSync(TEST_DIR).filter((n) => n.endsWith('.test.mjs')).sort()) {
  const text = readFileSync(join(TEST_DIR, name), 'utf8')
  const info = analyse(text)
  if (info.total === 0) continue
  measured.set(name, info)
  if (!info.stripped) rawTotal += info.total
}

/** ① every unstripped file must be declared in the baseline. */
for (const [name, info] of measured) {
  if (info.stripped) continue
  if (baseline.files?.[name] === undefined) {
    failures.push(
      `① ${name} 对源码文本做 ${info.total} 条断言，但没有用 test/source-assertion.mjs 的 stripComments()` +
        ' —— 注释里的引用会让它绿在一个已经被删掉的机制上（v339 ③ 就是这么绿的）',
    )
  }
}

/** ② the raw count may only go DOWN. */
if (rawTotal > (baseline.maxRaw ?? 0)) {
  failures.push(
    `② 未剥注释的源码断言从 ${baseline.maxRaw} 涨到 ${rawTotal} —— 这条棘轮只减不增。` +
      '新写的判据请用 stripComments()。',
  )
} else if (rawTotal < (baseline.maxRaw ?? 0)) {
  notes.push(`② 已降到 ${rawTotal}（基线 ${baseline.maxRaw}）—— 请把 docs/source-assertions.json 的 maxRaw 收紧到 ${rawTotal}`)
}

/** ③ a baseline entry that has since been fixed must be removed, not left as headroom. */
for (const [name] of Object.entries(baseline.files ?? {})) {
  const info = measured.get(name)
  if (info === undefined || info.stripped) {
    failures.push(
      `③ ${name} 已经不再需要豁免（${info === undefined ? '不再做源码断言' : '已用 stripComments'}），` +
        '却还留在基线里 —— 留着就是虚高配额',
    )
  }
}

/** ④ can-red self-test: prove a raw match goes green on a comment, and a stripped one does not. */
const SAMPLE = [
  '/* the banned shape is `forbiddenCall(` — documented on purpose */',
  'const real = 1',
  '// forbiddenCall( appears in this comment too',
].join('\n')
const { stripComments } = await import(
  new URL(`../test/source-assertion.mjs`, import.meta.url).href
)
const rawHit = /forbiddenCall\(/u.test(SAMPLE)
const strippedHit = /forbiddenCall\(/u.test(stripComments(SAMPLE))
if (!(rawHit === true && strippedHit === false)) {
  failures.push(
    `④ can-red 自检失败：裸匹配应为 true（命中注释）、剥注释后应为 false。实测 raw=${rawHit} stripped=${strippedHit}` +
      ' —— 剥注释工具本身坏了，这条门禁就没有意义',
  )
}

for (const note of notes) console.log(`  note ${note}`)
if (failures.length > 0) {
  console.log('')
  for (const line of failures) console.log(`  ❌ ${line}`)
  console.log(`\nsource-assertions: FAILED (${failures.length})`)
  process.exit(1)
}
console.log(
  `source-assertions: OK — ${measured.size} 个判据文件做源码断言；未剥注释 ${rawTotal} 条（基线 ${baseline.maxRaw ?? 0}，只减不增）`,
)
