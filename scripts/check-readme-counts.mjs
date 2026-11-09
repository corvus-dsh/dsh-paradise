/**
 * README COUNT GUARD — the mechanism, not another stale number.
 *
 * `node scripts/check-readme-counts.mjs` → exit 0 when every checkable fact matches reality, 1 when not.
 *
 * ── WHY (2026-11-09 audit) ──────────────────────────────────────────────────────────────────────
 *
 * Eight facts in four READMEs were stale — a test count three releases old, a version that no longer
 * exists, a line count copied from an archived snapshot — and one document contradicted another.
 * Correcting the numbers leaves the hole open: nothing reads them, so they drift again on the next
 * commit. This script reads them.
 *
 * ── THE READING METHOD IS PART OF THE CONTRACT ─────────────────────────────────────────────────
 *
 * MEASURED HERE: `Get-Content` in a Chinese Windows console decodes UTF-8 as ANSI(936); multi-byte
 * sequences are misread, lines merge, and a 549-line LF file reports 364. That is the physical reason
 * a document says "edit line 105" and an edit lands elsewhere. So:
 *
 *   READ .md / .ts / .json WITH readFileSync(p, 'utf8'). NEVER WITH A BARE `Get-Content`.
 *   Test: (Get-Content $f).Count -ne (ReadAllLines $f).Length  ⇒ the READER is wrong, not the file.
 *
 * ── WHAT IT CHECKS — only facts with ONE correct answer ────────────────────────────────────────
 *
 *   FACT 1  the declared test count equals `node --test`'s pass count;
 *   FACT 2  a declared current version equals package.json's version;
 *   FACT 3  a declared `src/index.ts` line count equals the file's `wc -l`.
 *
 * It does not check prose: "已完成" is a judgement, "415 / 415" is a fact.
 *
 * ── COEXISTENCE ────────────────────────────────────────────────────────────────────────────────
 *
 * `dsh-graft-slice/scripts/check-docs.mjs` already verifies 27 documentation facts (tool table,
 * manifest, keyword coverage). This script does NOT replace it: check-docs owns "is the document
 * complete", this one owns "is the number current".
 *
 * ── 行数口径 (stated once, used everywhere) ────────────────────────────────────────────────────
 *
 *   行数   = content.split(/\r?\n/).length - 1   when the content ends with '\n'   (== `wc -l`)
 *   非空行 = that split's entries with trim().length > 0
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const root = process.cwd()
const read = (rel) => readFileSync(join(root, rel), 'utf8')

/** `wc -l`: a trailing newline does not start a line. */
const wcLines = (text) => {
  const parts = text.split(/\r?\n/u)
  return text.endsWith('\n') ? parts.length - 1 : parts.length
}

const readme = read('README.md')
const pkg = JSON.parse(read('package.json'))

const passes = []
const failures = []
const ok = (label) => passes.push(label)
const fail = (label) => failures.push(label)

// ── FACT 1: the test count ────────────────────────────────────────────────────────────────────
/**
 * THE COMMAND MATTERS, AND THIS WAS MEASURED THE HARD WAY: `node --test test/` on Windows treats the
 * directory as ONE file specifier and reports `test at test:1:1` with **1 test, 0 pass** — so a naive
 * guard compares the README against zero and reports a false failure on every repository. The suites
 * are run through the package's own test script (`node --test test/*.test.mjs`), which is the command
 * the repository actually uses and the one whose count the READMEs quote.
 */
let actualTests
const script = JSON.parse(read('package.json')).scripts?.test
if (typeof script !== 'string') {
  fail('package.json 没有 test 脚本，无法测得测试数')
} else {
  try {
    const out = execFileSync(script, {
      cwd: root,
      shell: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 900_000,
    })
    actualTests = /pass (\d+)/u.exec(out)?.[1]
  } catch (error) {
    const out = `${error?.stdout ?? ''}`
    actualTests = /pass (\d+)/u.exec(out)?.[1]
    if (actualTests === undefined) fail('测试数无法测得：test 脚本失败且输出不可解析')
  }
}
if (actualTests !== undefined) {
  const expected = Number(actualTests)

  /**
   * A declared current count looks like `415 / 415` or `204 / 204`. Two rules keep historical prose
   * from failing the gate: the pair must be self-equal (a real "N of N green" claim), and the 60
   * characters before it must not mark it as historical (`historical` / `重构时` / `当时` / a
   * version tag). The audit's defect was a CURRENT claim that was wrong, not an old one that stayed.
   */
  /**
   * WHICH COUNT IS "OURS"? — the simple rule, after three complicated ones failed.
   *
   * A line can carry several counts (`| graft **591/591**、memory **415/415** |`). Deciding ownership by
   * proximity to a repository name was tried and was wrong three times: the name may be implicit, the
   * offset basis may differ, the line may be a table row. Complexity in a gate is not thoroughness —
   * it is a place for a false failure to hide, and a false failure on a correct number is how a gate
   * ends up disabled.
   *
   * THE RULE NOW: per line, take the FIRST self-equal `N/N` pair that is NOT marked historical, and
   * require it to equal the measured count. One claim per line, decided the same way every time.
   *
   * `graft **591/591**、memory **415/415**` in THIS repository's README: the first pair is 591 (ours),
   * so the line passes — and if someone edits 591 to 500, the gate fails. The second pair is another
   * repository's number and is not this gate's business.
   */
  const lines = readme.split(/\r?\n/u)
  const claims = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/historical|重构时|当时|v\d+\.\d+\s*起|历史/u.test(line)) continue
    const match = /(\d{3,4})\s*\/\s*(\d{3,4})/u.exec(line)
    if (match === null) continue
    if (Number(match[1]) !== Number(match[2])) continue
    claims.push({ left: Number(match[1]), raw: match[0], lineNumber: index + 1 })
  }

  if (claims.length === 0) {
    ok(`README 未声明当前测试数（实测 ${expected}），无断言可做`)
  } else {
    for (const claim of claims) {
      if (claim.left === expected) ok(`L${claim.lineNumber} 测试数 ${claim.raw} 与实测一致`)
      else fail(`L${claim.lineNumber} README 声明测试数 ${claim.raw}，实测 ${expected}`)
    }
  }
}

// ── FACT 2: a declared current version ───────────────────────────────────────────────────────
const versionClaims = [...readme.matchAll(/当前版本\s*\*\*([0-9][0-9A-Za-z.\-]*)/gu)].map((match) => match[1])
if (versionClaims.length === 0) {
  ok(`README 未声明当前版本（package.json ${pkg.version}），无断言可做`)
} else {
  for (const claimed of versionClaims) {
    if (claimed === pkg.version) ok(`版本声明 ${claimed} 与 package.json 一致`)
    else fail(`README 声明当前版本 ${claimed}，package.json 是 ${pkg.version}`)
  }
}

// ── FACT 3: a declared src/index.ts line count ───────────────────────────────────────────────
let actualLines
try {
  actualLines = wcLines(read('src/index.ts'))
} catch {
  actualLines = undefined
}
if (actualLines === undefined) {
  ok('本仓无 src/index.ts，跳过行数断言')
} else {
  /**
   * Claims are `13,271 行` / `13,271 行 / 12,742 非空`. Only a claim whose magnitude matches the real
   * file is treated as a claim about it — otherwise a README mentioning "5,000 行" of some other thing
   * would fail a gate it has nothing to do with.
   */
  const claims = [...readme.matchAll(/([0-9][0-9,]{2,})\s*行/gu)]
    .map((match) => ({
      value: Number(match[1].replace(/,/gu, '')),
      raw: match[0],
      line: readme.slice(readme.lastIndexOf('\n', match.index) + 1, readme.indexOf('\n', match.index)),
    }))
    .filter((claim) => Math.round(claim.value / 1000) === Math.round(actualLines / 1000))
    // Same historical exemption as the test count: a sentence about the v1.3 refactor quotes v1.3's
    // numbers on purpose, and "correcting" it would destroy the record it exists to keep.
    .filter((claim) => !/historical|重构时|当时|历史/u.test(claim.line))
  if (claims.length === 0) {
    ok(`README 未声明 src/index.ts 行数（实测 ${actualLines}），无断言可做`)
  } else {
    for (const claim of claims) {
      if (claim.value === actualLines) ok(`行数声明 ${claim.raw} 与实测一致（wc -l）`)
      else fail(`README 声明 ${claim.raw}，实测 ${actualLines}（wc -l）`)
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────────────────────────
for (const line of passes) console.log(`  ok   ${line}`)
for (const line of failures) console.log(`  FAIL ${line}`)
if (failures.length > 0) {
  console.log(`\n${failures.length} false claim(s). 文档与代码不一致。`)
  process.exit(1)
}
console.log(`\nall ${passes.length} checkable fact(s) match.`)
