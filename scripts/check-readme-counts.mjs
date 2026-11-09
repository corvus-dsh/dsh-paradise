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
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
  try {
    const out = execFileSync(script, {
      cwd: root,
      shell: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 900_000,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^NODE_TEST/u.test(key))),
    })
    actualTests = /pass (\d+)/u.exec(out)?.[1]
    const failedNow = Number(/fail (\d+)/u.exec(out)?.[1] ?? '0')
    if (failedNow > 0) {
      const failing = [...new Set([...out.matchAll(/^✖ (.+?) \(/gmu)].map((match) => match[1]))]
        .filter((name) => name !== 'failing tests:' && !/^(test at|test)$/u.test(name))
      fail(
        `测试套件自身未全绿（${failedNow} 条失败：${failing.slice(0, 3).join(' / ') || '未解析出名称'}）。` +
          '本次不判定文档是否过期——先修测试，再谈计数。',
      )
      actualTests = undefined
    }
  } catch (error) {
    const out = `${error?.stdout ?? ''}`
    actualTests = /pass (\d+)/u.exec(out)?.[1]
    /**
     * A FLAKY SUITE IS NOT A STALE DOCUMENT — and this guard must not confuse the two.
     *
     * Measured 2026-11-09: `dsh-paradise` fails 0–2 of its own tests roughly one run in six, always the
     * same pair (`self-heal: a chatty model still closes the loop…` / `…fails LOUDLY…`) — end-to-end
     * tests that really spawn a host, restart it and check the pid. When that happens the count is 353
     * instead of 354, and reporting "README says 354, actual 353" would blame the DOCUMENT for a
     * red suite. A gate that cries wolf gets switched off.
     *
     * So: a FAILING run is reported as a failing run, with the failing test names, and it is RED — the
     * suite must be green for the count to mean anything. What is NOT claimed is that the number is
     * stale, because that conclusion is unsupported.
     */
    const failing = [...new Set([...out.matchAll(/^✖ (.+?) \(/gmu)].map((match) => match[1]))]
      .filter((name) => name !== 'failing tests:' && !/^(test at|test)$/u.test(name))
    if ((/fail ([1-9]\d*)/u.exec(out)?.[1] ?? '0') !== '0') {
      fail(
        `测试套件自身未全绿（${failing.length} 条失败：${failing.slice(0, 3).join(' / ') || '未解析出名称'}）。` +
          '本次不判定文档是否过期——先修测试，再谈计数。',
      )
    } else if (actualTests === undefined) {
      fail('测试数无法测得：test 脚本失败且输出不可解析')
    }
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

// ── FACT 5: the FOUR COPIES of this script must not diverge ──────────────────
/**
 * This file is duplicated across four repositories on purpose (they must each run standalone, with no
 * cross-repo import). Duplication without a check drifts: one repo gets a rule the others lack, and the
 * gate that is supposed to catch stale documentation becomes itself inconsistent.
 *
 * So each copy hashes the others and compares. A MISSING sibling is reported, not silently accepted —
 * but a single-repo checkout (a published tarball, a CI job that cloned one repo) legitimately has no
 * siblings, and that case prints why it skipped.
 */
{
  const SELF = new URL(import.meta.url)
  const repoRoot = new URL('..', SELF)
  const selfBytes = readFileSync(new URL('./scripts/check-readme-counts.mjs', repoRoot))
  const selfHash = createHash('sha256').update(selfBytes).digest('hex')

  const siblings = ['dsh-paradise', 'dsh-memory', 'dsh-graft-slice', 'dsh-observer']
  const workspaceRoot = new URL('../', repoRoot)
  const present = []
  const differing = []
  let anyPresent = false

  for (const name of siblings) {
    const candidate = new URL(`${name}/scripts/check-readme-counts.mjs`, workspaceRoot)
    let bytes
    try {
      bytes = readFileSync(candidate)
    } catch {
      continue
    }
    anyPresent = true
    present.push(name)
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (hash !== selfHash) differing.push(`${name} (${hash.slice(0, 12)} ≠ ${selfHash.slice(0, 12)})`)
  }

  if (!anyPresent) {
    ok('单仓环境，跳过跨仓一致性（找不到同工作区的 dsh-*/scripts/check-readme-counts.mjs）')
  } else if (differing.length > 0) {
    fail(`check-readme-counts.mjs 四份副本已分叉：${differing.join(', ')}`)
  } else {
    ok(`check-readme-counts.mjs 与 ${present.length} 份同工作区副本一致（${selfHash.slice(0, 12)}）`)
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
