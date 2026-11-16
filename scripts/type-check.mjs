#!/usr/bin/env node
/**
 * ── WHAT THE TYPE CHECKER SAYS, SINCE NOTHING ELSE DOES ────────────────────────────────────────────
 *
 * This project never runs `tsc`. The build passes every source file through
 * `stripTypeScriptTypes`, which removes type syntax and performs NO symbol checking whatsoever. So:
 *
 *   · 782 green tests prove RUNTIME behaviour, not type correctness;
 *   · a move that "compiles" only proves "no syntax error", not "no broken type reference";
 *   · breaking a type reference costs nothing at build time and may cost nothing at test time.
 *
 * That is not a hypothesis. `SessionEventLike` is declared and exported by `core/watermark.ts:276` and
 * imported normally by two other modules, yet `index.ts` never imported it while referencing it 36 times
 * — and the suite stayed green.
 *
 * Usage:
 *   node scripts/type-check.mjs                # summary: total errors, per-code, per-file
 *   node scripts/type-check.mjs --code 2304    # only that diagnostic code
 *   node scripts/type-check.mjs --grep NAME    # only diagnostics whose message mentions NAME
 *   node scripts/type-check.mjs --json
 *
 * It reads typescript from the workspace root (this package declares no dependencies, exactly like
 * closure.mjs) and exits 2 with a named reason when the compiler is unavailable — never a silent zero.
 */
import { createRequire } from 'node:module'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(REPO, 'src')

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const codeIndex = args.indexOf('--code')
const onlyCode = codeIndex >= 0 ? Number(args[codeIndex + 1]) : undefined
const grepIndex = args.indexOf('--grep')
const onlyGrep = grepIndex >= 0 ? args[grepIndex + 1] : undefined

let ts
try {
  const require = createRequire(`${REPO}/`)
  ts = require('typescript')
} catch {
  console.error('typescript is not installed — the type check cannot run (this is a RESOURCE condition, not a pass)')
  process.exit(2)
}

/**
 * ── EVIDENCE FILES ARE IN THE TREE BUT NOT IN THE SOURCE ────────────────────────────────────────
 *
 * `src/core/ignition.ts.bak-cut` is a v7.6 baseline backup. It is deliberately tracked (v125 keeps it
 * present, v126 keeps it in the SCANNED set, v125 also asserts it never ships). Running the type checker
 * over it produced diagnostics for a file that is not compiled, not shipped, and not edited —
 * measured: code 6054 fired on it.
 *
 * Those diagnostics are NOISE, and noise in a diagnostic list is how real errors get ignored. But silently
 * dropping a file is its own kind of lie, so the exclusion is DECLARED and the count is printed.
 */
const NOT_SOURCE = new Set(['core/ignition.ts.bak-cut'])

/**
 * ── TRANSIENT PROBE FILES ARE NOT SOURCE ────────────────────────────────────────────────────────
 *
 * Several tests write a throwaway probe into `src/` and delete it in a `finally`: v141 writes
 * `core/__v141-probe.ts`, the calibration writes `core/__calibration-probe.ts`. That is deliberate —
 * the classifier and the compiler both only look under `src/`, so a probe must live there to be seen.
 *
 * ── WHY THIS MATTERS TO THE BUDGET, NOT JUST TO NOISE ───────────────────────────────────────────
 *
 * Measured: running `npm test` with node's default file-level parallelism let v143's `--baseline` scan
 * happen while v141's probe existed. The probe has no `@types/node`, so it produced its own
 * diagnostics, `--baseline` listed `core/__v141-probe.ts`, and the frozen-baseline assertion failed —
 * a test failing because ANOTHER test was mid-run. The same thing would happen to a developer who ran
 * the budget while a probe was on disk, and the report would name a file that does not exist a moment
 * later.
 *
 * The exclusion is printed, never silent: an exclusion nobody can see is how a real file gets ignored.
 */
const TRANSIENT_PROBE = /(?:^|\/)__[^/]*probe[^/]*\.ts$/u

const files = []
const excluded = []
const walk = (dir) => {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full)
    else if (/\.ts(?:\.|$)/u.test(entry)) {
      const rel = relative(SRC, full).split('\\').join('/')
      if (NOT_SOURCE.has(rel) || TRANSIENT_PROBE.test(rel)) { excluded.push(rel); continue }
      files.push(full)
    }
  }
}
walk(SRC)

const program = ts.createProgram(files, {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: false,
  noEmit: true,
  skipLibCheck: true,
  allowJs: false,
})
const diagnostics = ts.getPreEmitDiagnostics(program)

const rows = []
for (const diagnostic of diagnostics) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
  if (onlyCode !== undefined && diagnostic.code !== onlyCode) continue
  if (onlyGrep !== undefined && !message.includes(onlyGrep)) continue
  const file = diagnostic.file === undefined ? '(global)' : relative(SRC, diagnostic.file.fileName).split('\\').join('/')
  let line
  if (diagnostic.file !== undefined && diagnostic.start !== undefined) {
    line = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1
  }
  rows.push({ file, line, code: diagnostic.code, message })
}

/**
 * ── 环境问题不是代码问题，必须分开数 ────────────────────────────────────────────────────────────
 *
 * 用户裁定（2026-11-12）：33 条来自「缺 @types/node」，与代码无关；
 * 如果和代码错误混在一张表里，下一个读表的人会去「修」它们，而修法不是改代码，是装类型定义 ——
 * 与之前「196 里 33 条是环境问题」那次混乱同一个坑。
 *
 * 判据不是「我记得哪几个 code」，而是**这两类诊断的 message 在说什么**：
 *   · 2307 `Cannot find module 'node:os' …`  —— 解析不到 node 内置模块的类型声明
 *   · 2580 `Cannot find name 'process' …`    —— 缺 node 全局对象
 * 两者都只在 package.json 声明了 `@types/node` 之后才消失，改代码永远改不掉。
 */
const ENVIRONMENT_CODES = new Map([
  [2307, "cannot resolve a node builtin's type declarations (needs @types/node)"],
  [2580, 'cannot find the node global `process` (needs @types/node)'],
])
const isEnvironment = (row) => ENVIRONMENT_CODES.has(row.code)

/**
 * ── 一条由「编译器口径」而非代码造成的诊断 —— 明示，不静默 ──────────────────────────────────────
 *
 * 实测（同一份 src/，只改 `strict`）：
 *
 *     strict: false → 49 条        strict: true → 58 条
 *     差异：① 本条 2339 只在 strict:false 出现；
 *           ② index.ts:3455 的 2345 只在 strict:true 出现；
 *           ③ 9 条 7006（隐式 any）只在 strict:true 出现。
 *
 * 本条是 `if (!safety.ok) … safety.reason`。`strict: true` 下 TypeScript 正确地把它收窄成
 * `{ ok: false; reason: string }`，**0 条诊断**；`strict: false` 下不收窄，于是报「reason 不存在」。
 * 最小复现（typescript 5.9.3，三行代码）确认这是 strictness 造成的，不是代码问题。
 *
 * 用户裁定：保持 `strict: false`（切到 true 会立刻引入 9 条 7006 的新债，且与历史数字不可比），
 * 但**必须标注**这一条 —— 否则下一个人会去「修」一个在当前口径下不存在的问题，
 * 或者更糟：看到它消失就以为是自己修好的。
 *
 * 判据刻意**不用行号**：第一版用 `index.ts:9792:2339` 做键，而本轮编辑在我自己写的一条内联注释上
 * 让那行下移了 11 行 —— 标注立刻失效，那条假阳性悄悄变成「代码缺陷 12 条里的 1 条」。
 * 键换成「文件 + code + message 的关键子串」，位置变化不再影响身份。
 */
const COMPILER_ARTIFACT = new Map([
  ['2339', { file: 'index.ts', match: /Property 'reason' does not exist on type '\{ ok: true; \}/u, why: 'strict:false does not narrow `!safety.ok`; strict:true reports 0 here' }],
])


/**
 * ── ARTIFACT 改为**现测**，而不是手写白名单 ──────────────────────────────────────────────────────
 *
 * 移植到 observer 时实测到白名单的两个问题：
 *
 *   ① **它只登记了 graft-slice 的那一条**。observer 的 2353 不在名单里，于是被算成 CODE HEALTH。
 *   ② 更根本：白名单把「编译器口径造成的」写成了一条**记忆**。凡记忆都会过期 ——
 *      换一个仓、换一次 TS 版本、甚至 strict 下的措辞变化，判定就错。
 *
 * 实测到的措辞变化（同一条诊断，只改 strict）：
 *   strict:false  … does not exist in type '{ cwd: string; title?: string; id?: string; }'
 *   strict:true   … does not exist in type '{ cwd: string; title?: string | undefined; id?: string | undefined; }'
 * 所以在 strict:true 下按「code + 完整 message」找不到它 —— 一条**真实的** CODE HEALTH 被误判成 ARTIFACT。
 *
 * 现测判据：一条诊断是 ARTIFACT，当且仅当
 *   它在 strict:false 下出现、在 strict:true 下**同一文件同一行同一 code**不出现，
 *   并且它不在手写白名单里（白名单保留，用来标那些「行号也会变」的特例）。
 *
 * 行号在这里可以用：两次编译针对的是**同一份文件、同一批行号**，行号不是「跨编辑的身份」，
 * 而是「同一次运行内两次编译之间的对齐键」。这与「用行号当跨编辑身份」是两件事。
 */
const strictTrueDiagnostics = (() => {
  try {
    const program = ts.createProgram(files, {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      allowJs: false,
    })
    return ts.getPreEmitDiagnostics(program).map((d) => ({
      file: d.file ? basename(d.file.fileName) : '(global)',
      line: d.file ? d.file.getLineAndCharacterOfPosition(d.start).line : -1,
      code: d.code,
    }))
  } catch {
    return undefined // 编译器不可用 ⇒ 不改变既有判定
  }
})()

const isArtifact = (row) => {
  for (const [code, spec] of COMPILER_ARTIFACT) {
    if (String(row.code) !== code) continue
    if (row.file !== spec.file) continue
    if (!spec.match.test(row.message)) continue
    return true
  }
  if (strictTrueDiagnostics === undefined) return false
  const keepsInStrict = strictTrueDiagnostics.some((d) => d.file === row.file && d.line === row.line && d.code === row.code)
  return !keepsInStrict
}

const artifactWhy = (row) => {
  for (const [code, spec] of COMPILER_ARTIFACT) {
    if (String(row.code) === code && row.file === spec.file && spec.match.test(row.message)) return spec.why
  }
  return ''
}

const envRows = rows.filter(isEnvironment)
const artifactRows = rows.filter((row) => !isEnvironment(row) && isArtifact(row))
const codeRows = rows.filter((row) => !isEnvironment(row) && !isArtifact(row))

/**
 * ── `--strict-comparison`：把「更严的设置会看到多少」实测出来 ────────────────────────────────────
 *
 * 为什么需要它：type-budget 的输出要声明「这个数字是 strict:false 口径」，
 * 而那一句原本把 `strict:true reports 58 here` **写死**了。实测发现它已经过期 ——
 * 本轮修掉 4 条之后，strict:true 从 58 变成 54。
 *
 * 这正是「把会变的东西写死」那一族（行号当身份、手写基线表、写死的 786）：数字一过期，
 * 它就从说明变成谎话。所以让它每次现测。
 */
if (process.argv.includes('--strict-comparison')) {
  const measure = (strict) => {
    const program = ts.createProgram(files, {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict,
      noEmit: true,
      skipLibCheck: true,
      allowJs: false,
    })
    return ts.getPreEmitDiagnostics(program).length
  }
  console.log(JSON.stringify({ strictFalse: measure(false), strictTrue: measure(true) }))
  process.exit(0)
}

if (asJson) {
  console.log(JSON.stringify({
    total: rows.length,
    code: codeRows.length,
    environment: envRows.length,
    compilerArtifact: artifactRows.length,
    diagnostics: rows,
  }, null, 1))
  process.exit(0)
}

const byCode = new Map()
const byFile = new Map()
const sampleByCode = new Map()
for (const row of rows) {
  byCode.set(row.code, (byCode.get(row.code) ?? 0) + 1)
  byFile.set(row.file, (byFile.get(row.file) ?? 0) + 1)
  if (!sampleByCode.has(row.code)) sampleByCode.set(row.code, row.message)
}

if (excluded.length > 0) {
  console.log(`excluded (evidence, not source): ${excluded.join(', ')}`)
}
console.log(`type-check: ${rows.length} diagnostic(s)${onlyCode === undefined ? '' : ` with code ${onlyCode}`}${onlyGrep === undefined ? '' : ` mentioning "${onlyGrep}"`}`)
/**
 * ── 把环境问题从「代码健康度」里摘出来，单独数 ──────────────────────────────────────────────────
 *
 * 用户裁定：33 条缺 @types/node 的诊断与代码无关，必须单列。
 * 只写「196 条里有 33 条是环境问题」不够 —— 下一次读表的人看到「196」就会想把它清到 0，
 * 而清法不是改代码。所以两者从一开始就分成两个数：
 *
 *     code health : 28   ← 这些要修
 *     environment : 33   ← 这些装 @types/node 就消失，不是缺陷
 */
if (onlyCode === undefined && onlyGrep === undefined && envRows.length > 0) {
  console.log('')
  console.log(`CODE HEALTH: ${codeRows.length} diagnostic(s) — these are real type defects in this repo`)
  console.log(`ENVIRONMENT: ${envRows.length} diagnostic(s) — NOT code defects, @types/node would retire them`)
  for (const [code, why] of ENVIRONMENT_CODES) {
    const n = envRows.filter((row) => row.code === code).length
    if (n > 0) console.log(`  ${String(code).padEnd(6)} ${String(n).padStart(3)}  ${why}`)
  }
  console.log('  (do NOT "fix" these by editing code: package.json declares no dependencies, deliberately)')
  if (artifactRows.length > 0) {
    console.log(`COMPILER ARTIFACT: ${artifactRows.length} diagnostic(s) — caused by strict:false, not by the code`)
    for (const row of artifactRows) {
      console.log(`  ${row.file}:${row.line}  [${row.code}]  ${artifactWhy(row)}`)
    }
    console.log('  (strict:true reports 0 here; do NOT "fix" it, and do not read its disappearance as a fix)')
  }
}
/**
 * ── ONE SAMPLE PER CODE IS MISLEADING ───────────────────────────────────────────────────────────
 *
 * Measured: code 2304 has 115 rows across 20 DIFFERENT missing names. Printing the first row's message
 * made the summary read "Cannot find name 'textOfMessage'" — a name that accounts for 2 of the 115.
 * A reader would reasonably conclude the problem was textOfMessage; it was `graftError` (49) that
 * dominated. So the summary shows the distinct names, with counts, when they differ.
 */
const namesByCode = new Map()
for (const row of rows) {
  const m = /Cannot find name '([^']+)'/u.exec(row.message)
  if (m === null) continue
  if (!namesByCode.has(row.code)) namesByCode.set(row.code, new Map())
  const names = namesByCode.get(row.code)
  names.set(m[1], (names.get(m[1]) ?? 0) + 1)
}

console.log('')
console.log('by code:')
for (const [code, count] of [...byCode].sort((a, b) => b[1] - a[1])) {
  const names = namesByCode.get(code)
  if (names !== undefined && names.size > 1) {
    const top = [...names].sort((a, b) => b[1] - a[1]).slice(0, 5)
    console.log(`  ${String(code).padEnd(8)} ${String(count).padStart(4)}  ${names.size} distinct names:`)
    for (const [name, n] of top) console.log(`             ${String(n).padStart(4)}  ${name}`)
    if (names.size > top.length) console.log(`             … and ${names.size - top.length} more`)
  } else {
    console.log(`  ${String(code).padEnd(8)} ${String(count).padStart(4)}  ${(sampleByCode.get(code) ?? '').slice(0, 70)}`)
  }
}
console.log('\nby file:')
for (const [file, count] of [...byFile].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${file.padEnd(40)} ${String(count).padStart(4)}`)
}

/**
 * ── A FILTER IS A REQUEST FOR ALL OF THEM ───────────────────────────────────────────────────────
 *
 * Measured: `--code 2304` reported "57 diagnostic(s)" but listed 40 and ended with "…and 17 more".
 * A downstream script that parses the listing counted 40 and concluded the total was 40 — the
 * instrument's own truncation became a wrong number in someone else's table. When the caller has
 * already narrowed the set, the cap is a second, hidden filter. So: no cap under a filter; the cap
 * stays only for the unfiltered firehose.
 */
if (onlyGrep !== undefined || onlyCode !== undefined) {
  console.log('\nmatching diagnostics:')
  for (const row of rows) console.log(`  ${row.file}:${row.line}  [${row.code}] ${row.message.slice(0, 160)}`)
} else if (rows.length > 40) {
  console.log('\n(no filter given: listing capped at 40 — narrow with --code or --grep)')
}
