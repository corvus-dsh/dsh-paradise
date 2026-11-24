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
 *   FACT 3  a declared `src/index.ts` line count equals the file's `wc -l`;
 *   FACT 4  ARCHITECTURE.md: `现状` numbers match; an undated number is refused;
 *   FACT 5  the four copies of this script in the workspace have not diverged;
 *   FACT 6  README.en.md (when present): no UNDATED CURRENT claim (it is a frozen translation).
 *
 * ── WHAT IT DOES NOT CHECK — stated, because a gate that looks like it guards everything is more
 *    dangerous than one that says what it guards ─────────────────────────────────────────────────
 *
 *   1. **Other files' sizes.** Only the number attached to `src/index.ts` is verified. `host-shape.ts
 *      （996 行）`, `core/stores.ts（≤ 800 行）` and similar are NOT checked: they are other artifacts,
 *      and a design document legitimately tracks several at once. Today most are additionally exempted
 *      by `约` / `≤` markers, which means removing those markers would ALSO not turn this gate red —
 *      that is the honest limit, not a hidden behaviour.
 *   2. **README.en.md's historical numbers.** It is a frozen translation; only an UNDATED current claim
 *      is refused (the shape that was wrong on 2026-11-09: "the current suite is 95"). A figure inside a
 *      `historical` / `vX.Y` frame is left alone.
 *   3. **RELEASE_NOTES*.md, REPORT-*.md, POSTMORTEM-*.md, ANALYSIS-BRIEF.md, FIX-REPORT-*.md** and every
 *      other dated document. History is allowed to be old; checking them would force rewriting records
 *      whose purpose is to say what was true then.
 *   4. **Prose.** "已完成" / "稳定" / "支持 X" are judgements. This gate reads numbers only.
 *   5. **Whether the suite is FLAKY.** It reports a red suite as red; it does not decide whether the
 *      cause is the code or the machine. (See dsh-paradise README 已知边界第 6 条 for the one known case.)
 *   6. **Encoding.** A file full of GBK-decoded artifacts (鈥 / 鈫 / 鈹 / 瑙) has no wrong NUMBER, so this
 *      gate is blind to it.
 *
 *      AND THIS GATE ALSO DOES NOT DECIDE WHETHER THOSE CHARACTERS MEAN A BROKEN FILE. On this project
 *      that mistake was made FOUR times: three false alarms (observer README, graft README, publish.ts —
 *      all clean under `readFileSync(…,'utf8')`) and ONE real corruption (graft README.en.md, 11 genuine
 *      GBK artifacts). The discriminator is not the characters, it is the replacement marker:
 *
 *          见 到 鈥 / 鈫 / 鈹 / 瑙 这 类 字 符 时，先 判「文 件 坏 了」还 是「读 法 错 了」：
 *            U+FFFD > 0                  → 文件真的坏了（字节已不可逆丢失）
 *            U+FFFD = 0 但 字 符 仍 在    → 文件合法，是读取方按 ANSI(936) 解码的假象
 *
 *      Why that works: a real GBK↔UTF-8 double conversion destroys the byte sequence, so the decoder has
 *      to substitute U+FFFD somewhere. A clean UTF-8 file read with the WRONG decoder produces 鈥-类
 *      characters but no U+FFFD, because the wrong decoder is inventing them, not missing bytes. So the
 *      marker tells you which side is at fault — the file, or the reader.
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
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { observeSuite } from './suite-observation.mjs'

const root = process.cwd()
const read = (rel) => readFileSync(join(root, rel), 'utf8')

/** `wc -l`: a trailing newline does not start a line. */
const wcLines = (text) => {
  const parts = text.split(/\r?\n/u)
  return text.endsWith('\n') ? parts.length - 1 : parts.length
}

/**
 * ── 非空行, VERIFIED BECAUSE IT IS CLAIMED (N6b) ─────────────────────────────────────────────────
 *
 * The 口径 comment above defines BOTH numbers, and TD-1's 现状 row prints both:
 *
 *     `src/index.ts` 12,722 行 / 12,264 非空
 *
 * Measured: the non-empty value was **12,259** — off by five, on a line whose other number was being
 * checked on every run. A reader who sees `行 / 非空` beside a verified `wc -l` has every reason to
 * assume both are verified; nothing said otherwise, which is the same "no gate ⇒ it rots" failure this
 * gate exists to prevent — committed by this gate's own subject line.
 *
 * So the rule is now: if a 现状 claim names `src/index.ts … N 行 / M 非空`, BOTH are compared.
 */
const nonEmptyLines = (text) => text.split(/\r?\n/u).filter((line) => line.trim().length > 0).length

const readme = read('README.md')
const pkg = JSON.parse(read('package.json'))

const passes = []
const failures = []
const ok = (label) => passes.push(label)
const fail = (label) => failures.push(label)

/**
 * The ONE place that turns `node --test` output into "how many tests does this repository HAVE".
 *
 * Both the success path and the `catch` path call this — a file whose two paths measure different
 * things is the very defect this repository keeps writing down. See the `pass + skipped` argument
 * where the suite is run below; `t.skip` counts toward `tests` (verified: one passing test + one
 * `t.skip` ⇒ tests 2 / pass 1 / skipped 1), so `pass + skipped` is environment-independent.
 */
const countOf = (out) => {
  const pass = /pass (\d+)/u.exec(out)
  if (pass === null) return undefined
  const skipped = /skipped (\d+)/u.exec(out)
  return String(Number(pass[1]) + Number(skipped?.[1] ?? '0'))
}

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
  /**
   * MEASUREMENT POLLUTION — measured, not guessed.
   *
   * Running the suite from INSIDE this guard reported 352 for `dsh-paradise` while `npm test` in a shell
   * reported 354, reproducibly. The guard's own Node process is the difference: it is the parent of the
   * test process AND is itself running a script, so anything the suite derives from the process tree
   * (`--test` file discovery under a script parent, a pid-derived temp name, a concurrency default that
   * depends on load) can differ by exactly the two tests that spawn subprocesses.
   *
   * A gate must not report a number its own presence changed. So the suite is measured in a SEPARATE,
   * clean process — the same command a developer runs — and this process only reads the outcome.
   */
  /**
   * ── WHY `pass + skipped`, NOT `pass` ────────────────────────────────────────────────────────────
   *
   * Measured 2026-11-17 (CI run 44006262441): this gate was RED on every push and could not have
   * been green. It compared the README's `546 / 546` against `node --test`'s `pass` count.
   *
   *   dev machine : `typescript` resolves upwards from the workspace root, all 546 run
   *                 → pass 546  skipped 0
   *   CI          : `npm install` installs the DECLARED devDependency (`typescript`, exact pin — see
   *                 `check-runtime-deps.mjs`), so since that declaration landed the 13
   *                 compiler-dependent tests no longer skip for lack of a compiler
   *                 → pass 546  skipped 0      (TD-M15 enumerates the 13 either way)
   *
   * The sentence here used to read 「this package declares no RUNTIME dependencies, `npm install` installs
   * nothing」. That became FALSE the moment `devDependencies.typescript` was added, and it was false in
   * the silent direction: the paragraph still described a 533/13 split that could no longer happen.
   * `check-doc-claims.mjs` now fails a push when an unqualified 「declares no RUNTIME dependencies」 /
   * 「installs only the declared devDependency」 survives beside a non-empty `devDependencies`.
   *
   * The README's claim is "this repository HAS 546 tests". That is environment-independent, and
   * `pass + skipped` is 546 in BOTH environments. What IS environment-dependent is how many of them
   * could actually run — and that is not what the README claims.
   *
   * `t.skip` counting toward `tests` was verified directly, not assumed:
   *   $ node --test  (one passing test + one `t.skip`)   →   tests 2 / pass 1 / fail 0 / skipped 1
   *
   * The "the suite is green" half is asserted independently below (`fail > 0` ⇒ RED, with the
   * failing test names printed). So this does NOT weaken the gate: it removes a comparison that
   * could only ever be true in one of the two environments.
   *
   * The SAME reading must be used in the `catch` branch: a file whose two paths measure different
   * things is the very defect this repository keeps writing down.
   */
  try {
    /**
     * ── W4-1: ONE OBSERVATION, THREE GATES ─────────────────────────────────────────────────────────
     *
     * This block used to spawn the whole suite through the package's own `test` script. Measured
     * 2026-11-20: `check-readme-counts` 79.8 s + `check-docs` 79.1 s + `check-readme-tally` 78.1 s +
     * the final `node --test` 77.2 s — the same suite four times, ~314 s of a ~313 s check.
     *
     * `suite-observation.mjs` now serves all three from ONE TAP run. The JUDGEMENTS stay separate:
     * this gate still refuses to judge a document while the suite is red, and still names the failing
     * tests. Only the OBSERVATION is shared, so a bug in one gate cannot hide behind another's answer.
     */
    const { index } = observeSuite({ root })
    actualTests = (index.pass ?? 0) + (index.skipped ?? 0)
    if ((index.fail ?? 0) > 0) {
      fail(
        `测试套件自身未全绿（${index.fail} 条失败：${index.failing.slice(0, 3).join(' / ') || '未解析出名称'}）。` +
          '本次不判定文档是否过期——先修测试，再谈计数。',
      )
      actualTests = undefined
    }
  } catch (error) {
    actualTests = undefined
    fail(`测试数无法测得：${String(error?.message ?? error)}`)
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
   * WHICH COUNT IS "OURS"? — and now: which of ours are ALL checked.
   *
   * THE BACKDOOR THIS CLOSES (measured twice, by the gate's own author). The previous rule took the
   * FIRST self-equal `N/N` pair per line and checked only that one. So a README could say 604 in the
   * status table at the top and 598 in the body further down, and the gate was green — because the
   * body line's claim was never compared. That is exactly what happened in this repository
   * (`README.md:808` and `:1475` still said 598 while `:416` said 604), and the same shape recurred in
   * `dsh-memory` (415 in two places).
   *
   * A gate with a "fix one occurrence and you pass" shape does not check a document; it checks one
   * line of it. EVERY self-equal pair must now be accounted for.
   *
   * THE ONE REAL COMPLICATION, from data rather than imagination: some lines carry another
   * repository's count — `| graft **604/604**、memory **418/418** |`. Requiring both to equal THIS
   * repository's count would be a false failure, and a false failure is how a gate gets switched off.
   * So ownership is decided by the NEAREST repository word BEFORE the pair on that line:
   *
   *   - a word naming this repository (its short name, e.g. `graft` for `dsh-graft-slice`) → OURS;
   *   - a word naming a DIFFERENT repository → not ours, skipped;
   *   - no word at all → OURS. An unqualified `418 / 418` in this repository's README is a claim
   *     about this repository; there is nothing else it could mean.
   *
   * Proximity was tried before and reverted because it was used to decide *whether* a number was a
   * claim at all. It is used here only to attribute a claim that is already established — the pair
   * must still be self-equal and unmarked historical. Both directions are tested in
   * `test/v094-gate-selfclaims.test.mjs`, including the "top correct, body wrong" README that used to
   * pass.
   */
  const SHORT_NAMES = { 'dsh-graft-slice': 'graft', 'dsh-memory': 'memory', 'dsh-paradise': 'paradise', 'dsh-observer': 'observer' }
  const REPO_WORDS = ['graft', 'memory', 'paradise', 'observer']
  const ours = SHORT_NAMES[pkg.name?.replace(/^@[^/]+\//u, '')] ?? undefined
  const lines = readme.split(/\r?\n/u)
  const claims = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/historical|重构时|当时|v\d+\.\d+\s*起|历史/u.test(line)) continue
    for (const match of line.matchAll(/(\d{3,4})\s*\/\s*(\d{3,4})/gu)) {
      if (Number(match[1]) !== Number(match[2])) continue
      // Attribute by the nearest repository word BEFORE this pair on the line.
      const before = line.slice(0, match.index)
      const named = [...before.matchAll(new RegExp(`\\b(${REPO_WORDS.join('|')})\\b`, 'gu'))]
      const nearest = named.length > 0 ? named[named.length - 1][1] : undefined
      const isOurs = nearest === undefined || ours === undefined || nearest === ours
      claims.push({ left: Number(match[1]), raw: match[0], lineNumber: index + 1, nearest, isOurs })
    }
  }

  const mine = claims.filter((claim) => claim.isOurs)
  const foreign = claims.filter((claim) => !claim.isOurs)
  if (mine.length === 0) {
    ok(`README 未声明当前测试数（实测 ${expected}），无断言可做`)
  } else {
    for (const claim of mine) {
      if (claim.left === expected) ok(`L${claim.lineNumber} 测试数 ${claim.raw} 与实测一致`)
      else fail(`L${claim.lineNumber} README 声明测试数 ${claim.raw}，实测 ${expected}`)
    }
    // Say out loud how many were skipped, so "0 failures" cannot hide "0 comparisons".
    if (foreign.length > 0) {
      ok(
        `${foreign.length} 处自等 N/N 属于其他仓，不参与本仓断言（L${[
          ...new Set(foreign.map((claim) => claim.lineNumber)),
        ].join(', L')}）`,
      )
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
  /**
   * ── ONLY A COUNT THAT NAMES `src/index.ts` IS A CLAIM ABOUT ITS SIZE ──────────────────────────
   *
   * This rule has now been through FOUR versions, each corrected by a FALSE result — which is the
   * argument for keeping a proof script next to it:
   *
   *   1. "any `N 行`" → compared `observer-inject.ts（1,314 行）` against this repo's `src/index.ts`;
   *   2. "same thousands" → missed a fat-fingered 99,999 (different thousands, so ignored);
   *   3. "attached to a backticked `src/index.ts`" → still let `（1,314 行）` through when the file was
   *      named ELSEWHERE on a long table row (`原 observer-inject.ts（1,314 行）…`), because the sliding
   *      window found the next number on the line;
   *   4. THIS: the number must come from a `src/index.ts` mention **and** no other `.ts` filename may
   *      sit between that mention and the number.
   *
   * A README legitimately quotes many file sizes. A gate that cannot tell them apart must not guess.
   */
  const claims = [...readme.matchAll(/([0-9][0-9,]{2,})\s*行/gu)]
    .map((match) => {
      const lineStart = readme.lastIndexOf('\n', match.index) + 1
      const lineEnd = readme.indexOf('\n', match.index)
      const line = readme.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
      const ownAt = line.indexOf('src/index.ts')
      const numberAt = match.index - lineStart
      const between = ownAt === -1 ? '' : line.slice(ownAt + 'src/index.ts'.length, numberAt)
      return {
        value: Number(match[1].replace(/,/gu, '')),
        raw: match[0],
        line,
        namesOurFile: ownAt !== -1 && numberAt > ownAt,
        // Another `.ts` file named between ours and the number means the number is about THAT file.
        otherFileInBetween: /[\w-]+\.ts/u.test(between),
      }
    })
    .filter((claim) => claim.namesOurFile && !claim.otherFileInBetween)
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

// ── FACT 4: ARCHITECTURE.md — a number must be a CURRENT fact or an explicitly dated one ──────
/**
 * WHY ARCHITECTURE.md IS COVERED SEPARATELY (and why the rule is different)
 *
 * A design document is mostly HISTORY: "410 条测试 (v7.7 当时)" is a correct statement about v7.7 and
 * must never be "corrected" to today's number. So the rule is not "every number must match reality".
 * It is:
 *
 *   - a line that says 现状 must match reality (that word claims "this is true now");
 *   - a line carrying a count WITHOUT 现状 and WITHOUT a time marker (`vX.Y` / 当时 / historical …)
 *     is RED, with the instruction "either date it or mark it 现状" — because an undated number in a
 *     design doc is the exact shape that went stale last time.
 *
 * That keeps the historical record intact while making "undated claim" impossible to add by accident.
 */
const ARCH = 'ARCHITECTURE.md'
let arch
try {
  arch = read('ARCHITECTURE.md')
} catch {
  arch = undefined
}

if (arch === undefined) {
  ok('本仓无 ARCHITECTURE.md，跳过设计文档断言')
} else {
  const TIME_MARKER = /(v\d+\.\d+)|当时|historical|历史|重构时|起/u
  /**
   * A BUDGET IS NOT A CLAIM. "每个模块 ≤ 800 行", "搬进 core/stores.ts（≤ 800 行）", "预算 8000 字符" are
   * targets for work not yet done. Demanding a time marker on them would be wrong twice: there is no
   * moment to date them to, and "fixing" them to today's size would destroy the plan.
   */
  const BUDGET_MARKER = /（\s*≤|≤|上限|预算|不超过|目标/u
  const lines = arch.split(/\r?\n/u)
  const actualLinesForArch = (() => {
    try {
      return wcLines(read('src/index.ts'))
    } catch {
      return undefined
    }
  })()
  const actualNonEmptyForArch = (() => {
    try {
      return nonEmptyLines(read('src/index.ts'))
    } catch {
      return undefined
    }
  })()

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const numbers = [...line.matchAll(/([0-9][0-9,]{2,})\s*(?:行|条测试|条)/gu)]
      .map((match) => ({ value: Number(match[1].replace(/,/gu, '')), raw: match[0] }))
    if (numbers.length === 0) continue

    const claimsCurrent = /现状/u.test(line)
    const dated = TIME_MARKER.test(line)

    if (claimsCurrent && actualLinesForArch !== undefined) {
      /**
       * ONLY THE COUNT ATTACHED TO `src/index.ts` IS A CLAIM ABOUT ITS SIZE.
       *
       * Two earlier rules were wrong in opposite directions, and both were caught by this file's own
       * proof (which is the only reason to have a proof):
       *
       *   - a MAGNITUDE guard (only compare numbers in the same thousands) went GREEN on 99,999 —
       *     it ignored exactly the fat-finger error a gate exists to catch;
       *   - no guard at all went RED on `host-shape.ts（996 行）` — numbers about OTHER files.
       *
       * The precise rule: take the number that follows `src/index.ts` within a short window on the same
       * line. That is the only count on an ARCHITECTURE line that describes src/index.ts's own size.
       */
      /**
       * AN APPROXIMATION IS NOT A MEASUREMENT — but only the marker ATTACHED to the number counts.
       *
       * `约 1,300 行` (TD-9: a rough size for a file to be extracted) must be exempt. Checking the whole
       * line for 约 was too coarse: TD-1's 现状 row mentions 约 much later in its 口径 explanation, and the
       * exemption swallowed a REAL claim. So the marker is matched immediately before the digits.
       */
      const attachedApprox = /`src\/index\.ts`[^|]{0,40}?(约\s*|≈\s*|大约\s*)([0-9][0-9,]{2,})\s*行/u.exec(line)
      const attachedExact = /`src\/index\.ts`[^|]{0,40}?([0-9][0-9,]{2,})\s*行/u.exec(line)
      const attached = attachedExact
      if (attachedApprox !== null) {
        ok(`ARCHITECTURE L${index + 1} 现状行是估算（${attachedApprox[1].trim()} ${attachedApprox[2]} 行），不参与断言`)
      } else if (attached !== null) {
        const value = Number(attached[1].replace(/,/gu, ''))
        if (value === actualLinesForArch) ok(`ARCHITECTURE L${index + 1} 现状行数 ${attached[1]} 行 与实测一致`)
        else fail(`ARCHITECTURE L${index + 1} 现状写 ${attached[1]} 行，实测 ${actualLinesForArch}（wc -l）`)

        /**
         * ── THE NON-EMPTY HALF OF THE SAME CLAIM ────────────────────────────────────────────────
         *
         * `… 12,722 行 / 12,264 非空` printed two numbers; only the first was checked. Measured: the
         * second was wrong by five. If a claim prints it, it is asserted here — otherwise the 口径
         * note that DEFINES 非空行 reads as documentation for something nobody verifies.
         */
        const nonEmptyAt = /\/\s*([0-9][0-9,]{2,})\s*非空/u.exec(line)
        if (nonEmptyAt !== null) {
          const claimedNonEmpty = Number(nonEmptyAt[1].replace(/,/gu, ''))
          if (claimedNonEmpty === actualNonEmptyForArch) {
            ok(`ARCHITECTURE L${index + 1} 现状非空 ${nonEmptyAt[1]} 与实测一致`)
          } else {
            fail(`ARCHITECTURE L${index + 1} 现状写 ${nonEmptyAt[1]} 非空，实测 ${actualNonEmptyForArch}`)
          }
        }
      } else if (attached !== null) {
        ok(`ARCHITECTURE L${index + 1} 现状行是估算/目标（约 N 行），不参与断言`)
      } else {
        ok(`ARCHITECTURE L${index + 1} 现状行只描述其他文件的规模，无 src/index.ts 声明`)
      }
    } else if (BUDGET_MARKER.test(line)) {
      // A target, not an assertion — nothing to verify and nothing to date.
      ok(`ARCHITECTURE L${index + 1} 预算/目标类数字（不参与断言）`)
    } else if (!dated) {
      fail(
        `ARCHITECTURE L${index + 1} 有数字但既无「现状」也无时点限定（vX.Y / 当时 / historical）：` +
          `${numbers[0].raw} —— 要么标时点，要么标现状`,
      )
    }
  }
  if (!failures.some((entry) => entry.startsWith('ARCHITECTURE'))) {
    ok('ARCHITECTURE.md 的每个数字都有 现状 或时点限定')
  }
}

// ── FACT 6: README.en.md — a frozen translation may not assert a CURRENT number ──────────────
/**
 * THE SHAPE THIS CATCHES (measured 2026-11-09): `43 tests passed  # v5.1 snapshot, historical — the
 * current suite is 95`. The historical half is fine; "the current suite is 95" is a claim about TODAY
 * inside a historical frame — the most dangerous combination there is, because a reader cannot tell
 * which half to distrust. The real count was 591.
 *
 * README.en.md is a FROZEN TRANSLATION (its header says so), so the rule is narrower than for README.md:
 * an English file may quote history freely, but a present-tense count must not appear.
 */
let englishReadme
try {
  englishReadme = read('README.en.md')
} catch {
  englishReadme = undefined
}

if (englishReadme === undefined) {
  ok('本仓无 README.en.md，跳过英文文档断言')
} else {
  let found = 0
  const lines = englishReadme.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const claim = /current(?:ly)?\s+(?:suite|count|total)?\s*(?:is\s+)?\d+|currently\s+\d+|现在\s*\d+|当前\s*\d+/iu.exec(line)
    if (claim === null) continue
    found += 1
    fail(
      `README.en.md L${index + 1} 断言了「现值」：${claim[0].trim()} —— 该文件是冻结译本，` +
        '现值事实只放 README.md（或写成 historical / vX.Y 框内的历史数字）',
    )
  }
  if (found === 0) ok('README.en.md 无现值数字断言（冻结译本口径）')
}

// ── FACT 5: every file that CLAIMS to be identical across the four repos ─────
/**
 * This script is duplicated across four repositories on purpose (each must run standalone, with no
 * cross-repo import). Duplication without a check drifts: one repo gets a rule the others lack, and
 * the gate that is supposed to catch stale documentation becomes itself inconsistent.
 *
 * ── WHY A LIST AND NOT JUST THIS FILE ───────────────────────────────────────────────────────────
 *
 * `run-gate.mjs` guards itself with its own `--check-copies`. Anything else that claims to be the
 * same file in four repositories has to be listed here — otherwise the claim is only a comment.
 * Measured 2026-11-17: `test/run-gate-resource.test.mjs` says "THE SAME FILE IN FOUR REPOSITORIES,
 * ON PURPOSE" in its own header, and existed in TWO versions (239 lines with a shallow-clone
 * fallback in `dsh-memory`, 177 without it in the other three). Nothing compared them, and
 * `dsh-observer`'s CI went red on the stale copy (run 44014143688, `Test` step).
 *
 * ── WHY CI DEGRADES THIS TO A NOTE, AND A DEV MACHINE DOES NOT ──────────────────────────────────
 *
 * This check compares SELF against each sibling IT CAN SEE. On CI those siblings are separate
 * checkouts at their DEFAULT BRANCH — whatever was last pushed — not at this commit. So on CI a
 * difference usually means "a sibling has not been pushed yet": a fact about ordering, not about
 * divergence. Asserting it red makes every push depend on the push order of the other repositories
 * (measured 2026-11-17: four CI rounds spent on exactly that).
 *
 * Locally, all four repos sit in one workspace at the same commit, so a difference IS a real
 * divergence and must fail — and `npm run check` is what a developer runs before committing.
 *
 * The CI form still PRINTS the difference and says why it is not asserted. A note that reads
 * "everything is consistent" when it is not would be the silent-mismatch failure this repository
 * keeps recording; this says the opposite, out loud.
 */
const IDENTICAL_ACROSS_REPOS = [
  'scripts/check-readme-counts.mjs',
  'test/run-gate-resource.test.mjs',
]
{
  const repoRoot = new URL('..', import.meta.url)
  const workspaceRoot = new URL('../', repoRoot)
  const siblings = ['dsh-paradise', 'dsh-memory', 'dsh-graft-slice', 'dsh-observer']
  const inCI = process.env.CI === 'true' || process.env.CI === '1'

  for (const relative of IDENTICAL_ACROSS_REPOS) {
    let selfBytes
    try {
      selfBytes = readFileSync(new URL(`./${relative}`, repoRoot))
    } catch {
      // A throwaway fixture repository may not carry the file at all — say it, never crash.
      ok(`本仓没有 ${relative}，跳过其跨仓一致性`)
      continue
    }
    const selfHash = createHash('sha256').update(selfBytes).digest('hex')
    const present = []
    const differing = []
    for (const name of siblings) {
      let bytes
      try {
        bytes = readFileSync(new URL(`${name}/${relative}`, workspaceRoot))
      } catch {
        continue
      }
      present.push(name)
      const hash = createHash('sha256').update(bytes).digest('hex')
      if (hash !== selfHash) differing.push(`${name} (${hash.slice(0, 12)} ≠ ${selfHash.slice(0, 12)})`)
    }

    if (present.length === 0) {
      ok(`单仓环境，跳过 ${relative} 的跨仓一致性（同工作区没有 dsh-* 兄弟仓）`)
    } else if (differing.length === 0) {
      ok(`${relative} 与 ${present.length} 份同工作区副本一致（${selfHash.slice(0, 12)}）`)
    } else if (inCI) {
      ok(`[CI] ${relative} 版本不一致：${differing.join('; ')} —— CI 上兄弟仓取的是默认分支已推送版本，`
        + '推送时序不同就会不同。这不是分叉的证明；本地 `npm run check` 会 FAIL。')
    } else {
      fail(`同源文件已分叉：${relative} —— ${differing.join('; ')}。`
        + '同源文件必须逐字节相同（四仓一起改、一起提交）。')
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
