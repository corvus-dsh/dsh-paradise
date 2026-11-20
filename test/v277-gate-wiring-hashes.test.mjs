/**
 * ── v277 (B4-0b-2 W3-2): A DOCUMENTED HASH MUST BE MEASURED, NOT COPIED ─────────────────────────
 *
 * `docs/gate-wiring.md` listed 「实测哈希」 and gave `type-budget.mjs 9793ED9E01D59CB8 == memory`.
 * That value is **neither** repository's file: paradise is `00452631762B0E5D`, memory is
 * `40F8E5C0092658E0`. It had thus never been equal to any measurement, and it sat directly under the
 * words 「实测哈希」.
 *
 * The reason it survived is the shape this batch keeps finding: **the number had exactly one source,
 * the author**. Other hashes in that block were right for the same reason they could have been wrong —
 * nothing compared them.
 *
 * And the claim was doubly wrong: `type-budget.mjs` carries PER-REPOSITORY baselines
 * (`BASELINE` / `BASELINE_IDENTITIES` describe that repository's own defects), so its file CANNOT be
 * byte-identical across repositories. The document says this two paragraphs later — one sentence
 * contradicts another, and only one of them was ever read.
 *
 * ── WHAT THIS FILE PINS ─────────────────────────────────────────────────────────────────────────
 *
 *   It PARSES the document and re-measures. A line claiming `== memory` must be equal; the
 *   `type-budget` line must state `≠` and must actually differ. Hand-editing either the doc or a
 *   script turns this red.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const MEMORY = join(REPO, '..', 'dsh-memory')
const DOC = join(REPO, 'docs', 'gate-wiring.md')

/** SHA-256, first 16 hex characters — the same truncation the document uses. */
function digestOf(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase().slice(0, 16)
}

const doc = readFileSync(DOC, 'utf8')

test('v277 ①: 文档里每个 `== memory` 的哈希都等于两边实测', (t) => {
  if (!existsSync(join(MEMORY, 'scripts'))) {
    /** Rule ⑤ of this house: a missing resource is a SKIP, not a pass. */
    t.skip('dsh-memory 不在工作区（单仓 CI）—— 无法比对，跳过不是通过')
    return
  }
  const lines = doc
    .split(/\r?\n/u)
    .map((line) => /^(\S+\.mjs)\s+([0-9A-F]{16})\s+==\s+memory$/u.exec(line.trim()))
    .filter((match) => match !== null)

  assert.ok(lines.length >= 5, `必须解析到至少 5 行实测哈希（解析失败等于这条测试失效）；actual: ${lines.length}`)

  const seen = new Set()
  for (const [, name, claimed] of lines) {
    const here = join(REPO, 'scripts', name)
    const there = join(MEMORY, 'scripts', name)
    assert.ok(existsSync(here), `${name} 必须存在于 paradise/scripts`)
    assert.ok(existsSync(there), `${name} 必须存在于 memory/scripts 才能声称 == memory`)
    assert.equal(digestOf(here), claimed, `${name}: 文档写 ${claimed}，paradise 实测 ${digestOf(here)}`)
    assert.equal(digestOf(there), claimed, `${name}: 文档写 ${claimed}，memory 实测 ${digestOf(there)}`)
    seen.add(name)
  }
  /** The exception must NOT be in this block: it cannot be byte-identical, so `== memory` is a false claim. */
  assert.ok(!seen.has('type-budget.mjs'), 'type-budget.mjs 不许出现在 `== memory` 表里 —— 它的基线是每仓各自的')
})

test('v277 ②: type-budget 一行说「≠」，且实测确实不相等（结构与基线分开说）', () => {
  const match = /type-budget\.mjs\s+paradise\s+([0-9A-F]{16})\s+≠\s+memory\s+([0-9A-F]{16})/u.exec(doc)
  assert.ok(match !== null, '文档必须有一行明确写「paradise X ≠ memory Y」')
  const [, claimedHere, claimedThere] = match

  assert.equal(digestOf(join(REPO, 'scripts', 'type-budget.mjs')), claimedHere, 'paradise 侧哈希必须等于实测')
  assert.notEqual(claimedHere, claimedThere, '文档自己必须承认两边不同')

  if (existsSync(join(MEMORY, 'scripts', 'type-budget.mjs'))) {
    assert.equal(digestOf(join(MEMORY, 'scripts', 'type-budget.mjs')), claimedThere, 'memory 侧哈希必须等于实测')
    assert.notEqual(
      digestOf(join(REPO, 'scripts', 'type-budget.mjs')),
      digestOf(join(MEMORY, 'scripts', 'type-budget.mjs')),
      '实测也必须真的不相等 —— 相等说明基线表被复制了，那是另一个缺陷',
    )
  }
})

test('v277 ③: 那个「两边都不是」的旧哈希不许以声明形式回来', () => {
  /**
   * The defect itself, pinned as a negative: `9793ED9E01D59CB8` matched no file in either repository.
   *
   * IT IS STILL ALLOWED IN PROSE, ON PURPOSE. The document records the mistake where the mistake was
   * (「这行原来写的是 …」) — deleting that would remove the only evidence a reader has that the number
   * was wrong. What must never return is the DECLARATION form: a `<name>.mjs <hash> == memory` line
   * carrying a number nothing measures.
   *
   * So the test forbids the CLAIM, not the memory of it. A check that forbade the string outright
   * would force the receipt to be deleted — and a document that cannot say "this was wrong" is how the
   * next reader trusts the next number.
   */
  assert.doesNotMatch(doc, /^\S+\.mjs\s+9793ED9E01D59CB8/mu, '旧哈希不许再出现在「实测哈希」的声明位置')
  assert.match(doc, /9793ED9E01D59CB8/u, '但这段缺陷的记录必须留在原处 —— 这是它曾经错的唯一证据')
})