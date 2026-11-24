#!/usr/bin/env node
/**
 * ── MOVE GATE: the four tiers that must ALL pass before a cluster may move ─────────────────────────
 *
 * User ruling 2026-11-11. A move is admitted only when every tier says YES; any NO stops the move and
 * the reason is reported. The point of putting this in a script is that "I checked it" is not a result:
 * each tier prints the MEASUREMENT it was decided from, so a reader can disagree with the verdict.
 *
 *   A  模块大小   module size ≤ 800 lines (declaration span)                       ← TD-1's original meaning
 *   B  依赖总和   closure size — REPORTED ONLY, never a veto                        ← the old misreading
 *   C  可拆分性   four questions, all must be YES (see below)
 *   D  性能不退   efficiency / safety / stability / concurrency, all must hold
 *
 * ── C: THE FOUR QUESTIONS ───────────────────────────────────────────────────────────────────────────
 *
 * C1 一句话说清   can the cluster be described in one sentence WITHOUT "and"?
 * C2 调用面       is it called only by the container and its own cluster? (a test importing it is fine —
 *                 the question is whether PRODUCTION code reaches into it)
 * C3 可独立测试   can ≥3 assertions be written importing ONLY the cluster (never index.ts)?
 * C4 无隐式时序   does correctness depend on "must run inside the container, after variable X is set"?
 *                 C4 is the decisive one: a sub-block that reads state produced by an earlier loop is
 *                 not functional, no matter how small its closure.
 *
 * This script MEASURES C1–C4 as far as a machine can, and prints what a human must still confirm. It is
 * deliberately honest about that split: `machine` verdicts are computed, `review` verdicts are printed
 * as OPEN and must be filled by a human reading the code. A gate that pretends to decide a semantic
 * question by regex would be the same failure this whole phase keeps finding.
 *
 * Usage:
 *   node scripts/move-gate.mjs --cluster GraftConfig
 *   node scripts/move-gate.mjs --cluster GraftConfig --json
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
/**
 * `GRAFT_MOVE_GATE_SRC` 让测试把整个门槛指向 src/ 的**临时副本**（并转发给 closure.mjs）。
 *
 * 与 `check-cycles.mjs` / `closure.mjs` / `who-references.mjs` 同一做法：会往真实树里写探针的测试
 * 必须有一个不碰真实树的入口，否则并行运行器下别的测试会读到坏树。
 */
const SRC = process.env.GRAFT_MOVE_GATE_SRC !== undefined && process.env.GRAFT_MOVE_GATE_SRC !== ''
  ? resolve(process.env.GRAFT_MOVE_GATE_SRC)
  : join(REPO, 'src')
/**
 * ── 注入点必须自述（lead §五十.4）───────────────────────────────────────────────────────────────
 *
 * 变量生效时打印一行，格式与 `closure.mjs` / `check-cycles.mjs` / `verify-pure-move.mjs` 相同：
 *
 *     move-gate: src = <绝对路径> (injected via GRAFT_MOVE_GATE_SRC)
 *
 * 为什么它必须存在：这个变量既改变本脚本测量的树，又**转发**给 closure.mjs。少一行日志时，
 * 报告只能证明「有一个门槛跑过了」，无法证明「它跑的是哪棵树」——而改道正是最容易伪装成通过的做法。
 */
if (process.env.GRAFT_MOVE_GATE_SRC !== undefined && process.env.GRAFT_MOVE_GATE_SRC !== '') {
  console.error(`move-gate: src = ${SRC} (injected via GRAFT_MOVE_GATE_SRC)`)
}
const INDEX = join(SRC, 'index.ts')
const TOOL = join(REPO, 'scripts', 'closure.mjs')

const args = process.argv.slice(2)
const clusterIndex = args.indexOf('--cluster')
const CLUSTER = clusterIndex >= 0 ? args.slice(clusterIndex + 1).filter((a) => !a.startsWith('--')) : []
const asJson = args.includes('--json')
if (CLUSTER.length === 0) {
  console.error('usage: node scripts/move-gate.mjs --cluster <Name> [<Name> ...]')
  process.exit(2)
}

const subset = new Set(CLUSTER)

/**
 * Evidence fixtures under src/ that are NOT part of the packaging closure.
 *
 * `src/core/ignition.ts.bak-cut` is a v7.6 baseline backup. It is deliberately tracked, and v125/v126
 * exist to keep it (a) present and (b) OUT of the artifact. Counting it as a production caller would
 * be a false positive: nothing imports it and it never ships.
 *
 * The rule is not "ignore .bak files" — it is "ignore files the bundler cannot reach", and v125
 * asserts that property for this exact file.
 */
const NOT_SHIPPED = new Set(['core/ignition.ts.bak-cut'])

// ── measurement helpers ─────────────────────────────────────────────────────────────────────────────
function sourceFiles(dir) {
  const out = []
  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (/\.ts(?:\.|$)/u.test(entry)) out.push(full)
    }
  }
  walk(dir)
  return out
}

/**
 * ── SPANS COME FROM THE COMPILER, NOT FROM A SECOND PARSER ──────────────────────────────────────
 *
 * Six wrong answers in one afternoon, all from a hand-written scanner trying to do what the TypeScript
 * compiler already does:
 *
 *   1. counting only `{}` — `export function buildTape(` opens its brace nine lines later, so the
 *      function measured 0 lines and tier C4 reported "0 local assignments" (a false PASS)
 *   2. per-line block-comment stripping — `export const inject` swallowed to L767, GraftConfig vanished
 *   3. a character state machine that cannot tell a REGEX LITERAL from a comment — L990's
 *      `/(for the rest …` ate the rest of the file, losing tokenSet / nearDuplicate / normalizedEqual
 *   4. object-literal keys and property accesses counted as variable reads
 *   5. a bracket counter that could not handle template-literal `${` nesting — `buildInjectionPlan`
 *      measured **4,002 lines against the compiler's 744**, swallowing 3,258 lines of unrelated
 *      declarations (including `noteForcedCut`, which then disappeared from every downstream count and
 *      made the span sum disagree with the closure by 25 lines)
 *   6. treating a multi-line signature as a closed body
 *
 * The lesson is not "write a better regex". It is: **a second parser is a second truth**, and two truths
 * drift. `closure.mjs --declarations` now emits the compiler's own span table, and this file consumes it.
 * The calibration (six known spans, plus "span sum == closure lines") lives in test/v138-move-gate.test.mjs.
 */
const declarationTable = (() => {
  const output = execFileSync(process.execPath, [TOOL, '--declarations'], {
    encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
    // 沙箱副本必须一路传下去：否则 closure 仍读真实 src/，门槛与测试看到的不是同一棵树
    env: { ...process.env, GRAFT_CLOSURE_SRC: SRC },
  })
  // the banner (compiler version + path) precedes the JSON; the table is the last line
  const json = output.trim().split('\n').pop()
  const rows = JSON.parse(json)
  const byName = new Map()
  for (const row of rows) if (!byName.has(row.name)) byName.set(row.name, row)
  return { rows, byName }
})()

const indexDeclarations = new Map(
  declarationTable.rows.filter((row) => row.file === 'index.ts').map((row) => [row.name, row]),
)



/**
 * ── A CLUSTER MAY ALREADY LIVE IN ITS OWN MODULE ────────────────────────────────────────────────
 *
 * The first version parsed only `src/index.ts`, because every target happened to be there. After
 * GraftConfig moved to `core/graft-config.ts`, tier A reported "0 行 — YES": a pass on something the
 * gate had not found at all. That is the same failure shape this phase keeps finding (a green number
 * with no correct denominator), so the gate now resolves a cluster across the whole tree and says
 * WHICH FILE it found it in.
 */
/**
 * The file's lines with comments AND string literals blanked, LINE COUNT PRESERVED.
 *
 * Kept separate from span parsing on purpose: this function answers "what does this line SAY", and a
 * hand-rolled answer to that question is good enough (three false-positive sources were found and fixed
 * here — a name in a comment, a name in a string, a property key). Span parsing is a DIFFERENT question
 * and is now delegated to the compiler, because a hand-rolled answer to THAT produced six wrong numbers.
 */
function codeLinesOf(file) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const out = []
  let inBlock = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (inBlock) {
      out.push('')
      if (trimmed.includes('*/')) inBlock = false
      continue
    }
    if (trimmed.startsWith('/*')) {
      out.push('')
      if (!trimmed.includes('*/')) inBlock = true
      continue
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) { out.push(''); continue }
    out.push(blankStringLiterals(cutTrailingLineComment(line)))
  }
  return out
}

/** Replace the CONTENT of string literals with spaces, keeping delimiters and length. */
function blankStringLiterals(line) {
  let out = ''
  let index = 0
  while (index < line.length) {
    const char = line[index]
    if (char !== "'" && char !== '"' && char !== '`') { out += char; index += 1; continue }
    const quote = char
    out += quote
    index += 1
    while (index < line.length) {
      const inner = line[index]
      if (inner === '\\') { out += '  '; index += 2; continue }
      if (inner === quote) { out += quote; index += 1; break }
      out += ' '
      index += 1
    }
  }
  return out
}

/** Cut a trailing `// …`, but never inside a string and never a `//` that is not whitespace-led. */
function cutTrailingLineComment(line) {
  let quote
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (quote !== undefined) {
      if (char === '\\') { index += 1; continue }
      if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue }
    if (char === '/' && line[index + 1] === '/' && index > 0 && /\s/u.test(line[index - 1])) {
      return line.slice(0, index)
    }
  }
  return line
}

const allDeclarations = declarationTable.byName

/**
 * 按「名字」或「文件 + 名字」解析一个声明。
 *
 * 第二个参数是可选的 `file`。**带上它才是精确的**：`readJsonl` / `sleepSync` 这类名字
 * 在多个文件里都有，只按名字会取到表里第一个（`byName` 是"先到先得"）。
 */
const resolveDeclaration = (name, file) => {
  if (file === undefined) return allDeclarations.get(name)
  const row = declarationTable.rows.find((r) => r.name === name && (r.file ?? 'index.ts') === file)
  return row ?? allDeclarations.get(name)
}

const runClosure = (name) => {
  try {
    const output = execFileSync(process.execPath, [TOOL, name], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GRAFT_CLOSURE_SRC: SRC },
    })
    return {
      declarations: Number(/declarations : (\d+)/u.exec(output)?.[1]),
      lines: Number(/lines\s+: (\d+)/u.exec(output)?.[1]),
      mutable: (/mutable\s+: (.*)/u.exec(output)?.[1] ?? '').trim(),
      members: [...output.matchAll(/^ {4}(\S+?):(\w+) \[([^\]]+)\]/gmu)].map((m) => ({ file: m[1], name: m[2], kind: m[3] })),
    }
  } catch {
    return undefined
  }
}

// ── A: module size ──────────────────────────────────────────────────────────────────────────────────
const spans = CLUSTER.map((name) => resolveDeclaration(name)).filter(Boolean)
const moduleLines = spans.reduce((total, span) => total + span.lines, 0)
const aVerdict = spans.length > 0 && moduleLines <= 800

// ── B: closure (reported, never a veto) ───────────────────────────────────────────────────────────
/**
 * ── A CLUSTER'S CLOSURE IS THE UNION OF ITS MEMBERS' CLOSURES, NOT THE LARGEST ONE ───────────────
 *
 * Measured on cluster 1 (21 members): taking `max(member closure lines)` reported **341**, because
 * `extractGoal` alone is 341. The cluster's real weight is **558** — the members do not nest, they add
 * up. Reporting 341 understated the cost of the move by 217 lines, in the direction that makes a move
 * look cheaper than it is.
 */
const memberClosures = CLUSTER.map((name) => ({ name, closure: runClosure(name) })).filter((entry) => entry.closure !== undefined)
const closureOfCluster = memberClosures.length === 0 ? undefined : memberClosures[0].closure

/**
 * ── 成员身份必须是「文件:名字」，不是「名字」────────────────────────────────────────────────────
 *
 * 实测（本仓 `store.ts` 的 A3 组）：同一个名单，
 *   · 按名字求并集 → **495 行**
 *   · 按「文件:名字」求并集 → **478 行**
 * 差 17 行，而两种口径的**声明数都是 25** —— 一个不可能的组合，说明名字有歧义。
 *
 * 追下去：`readJsonl` 在 `store.ts:1293`（3 行）和 `causal.ts:86`（20 行）各有一个；
 * `sleepSync` 在 `store.ts:41` 与 `lock.ts:106` 各有一个。旧代码
 *
 *     for (const member of entry.closure.members) unionNames.add(member.name)
 *     … const span = resolveDeclaration(name)          // 按名字解析，会取到"第一个"
 *
 * 于是闭包里那条 `store.ts:readJsonl` 被解析成了 `causal.ts:readJsonl`（20 行而不是 3 行），
 * 凭空多算 17 行。**`runClosure` 明明已经给了 `file`，代码却把它丢了重新按名字查。**
 *
 * 这与该文件上方那段注释（"read the fields, not the string"）是同一个错误的两半：
 * 那次是把对象当字符串读，这次是把带文件的身份降级成裸名字。
 *
 * 修法：直接读 `member.file` + `member.name` + `member.lines`（闭包输出里有行数），
 * 不再走 `resolveDeclaration` 二次解析。
 */
const clusterClosureMembers = new Map() // key = `${file}:${name}` → member
for (const entry of memberClosures) {
  for (const member of entry.closure.members) {
    const key = `${member.file ?? 'index.ts'}:${member.name}`
    if (!clusterClosureMembers.has(key)) clusterClosureMembers.set(key, member)
  }
}

/** 同名多声明：同一个名字出现在 ≥2 个文件里。报出来，不假装没有。 */
const ambiguousNames = (() => {
  const byName = new Map()
  for (const member of clusterClosureMembers.values()) {
    if (!byName.has(member.name)) byName.set(member.name, new Set())
    byName.get(member.name).add(member.file ?? 'index.ts')
  }
  return [...byName].filter(([, files]) => files.size > 1).map(([name, files]) => ({ name, files: [...files].sort() }))
})()

const clusterClosureLines = (() => {
  if (memberClosures.length === 0) return undefined
  /**
   * 闭包输出里**已经有**每个成员的行数（`closure.mjs` 会打印 `[kind]` 与跨度），
   * 但 `runClosure` 只保留了 file/name/kind。所以这里按「文件:名字」去 `resolveDeclaration`
   * 时必须带上文件——`resolveDeclaration` 支持第二个参数指定文件。
   */
  let total = 0
  for (const member of clusterClosureMembers.values()) {
    const span = resolveDeclaration(member.name, member.file)
    if (span !== undefined) total += span.lines
  }
  return total
})()

// ── C1: one sentence without "and" ─────────────────────────────────────────────────────────────────
// A machine cannot decide this. What it CAN do is show the declaration so the reader decides, and
// flag the mechanical signal: how many distinct exported members the cluster holds.
const kinds = spans.map((span) => span.kind)
const oneKind = new Set(kinds).size === 1

// ── C2: who calls it ───────────────────────────────────────────────────────────────────────────────
/**
 * ── A MENTION IN A COMMENT IS NOT A CALLER ──────────────────────────────────────────────────────
 *
 * Measured on GraftConfig: four modules under `src/core/` mention the name, and the first version of
 * this gate counted all four as production callers (verdict REVIEW). Reading them showed every one is
 * inside a comment: "Mirrors `Required<GraftConfig>`'s used fields", "Declared structurally instead of
 * importing `GraftConfig` from index.ts: the dependency must not point backwards". Not one imports it.
 *
 * So comments and string literals are stripped from the FILE under scrutiny before references are
 * collected, using the same whole-file stripper the declaration parser uses. Otherwise the gate would
 * be answering "who talks about it", which is not the question C2 asks.
 */
const referenceSites = []
for (const file of [...sourceFiles(SRC)]) {
  const rel = relative(SRC, file).split('\\').join('/')
  if (NOT_SHIPPED.has(rel)) continue
  const lines = codeLinesOf(file)
  for (const [index, line] of lines.entries()) {
    const declarationOfItself = CLUSTER.some((name) => {
      const span = indexDeclarations.get(name)
      return span !== undefined && rel === 'index.ts' && index + 1 >= span.start && index + 1 <= span.end
    })
    if (declarationOfItself) continue
    for (const name of CLUSTER) {
      const pattern = new RegExp(`\\b${name.replace(/\$/gu, '\\$')}\\b`, 'u')
      if (!pattern.test(line)) continue
      referenceSites.push({ file: rel, line: index + 1, name, text: line.trim() })
    }
  }
}
/**
 * ── THE FILE A CLUSTER LIVES IN IS NOT A CALLER OF ITSELF ──────────────────────────────────────
 *
 * After GraftConfig moved to \`core/graft-config.ts\`, that module naturally contains the name — and the
 * first version counted it as a production caller, turning C2 from YES to REVIEW. A cluster is not its
 * own dependency.
 *
 * \`index.ts\` is treated separately for the same reason: it is the container, and its references are
 * counted (they are the reason the cluster is reachable) but they are not "production callers" in the C2
 * sense — the question is whether anything ELSE reaches in.
 */
const clusterHomeFiles = new Set(spans.map((span) => span.file ?? 'index.ts').filter(Boolean))
const productionCallers = [...new Set(
  referenceSites
    .filter((site) => site.file !== 'index.ts')
    .filter((site) => !clusterHomeFiles.has(site.file))
    .filter((site) => !/^\s*(?:import|export)\b/u.test(site.text)) // a re-export/import is plumbing, not a call
    .map((site) => site.file),
)]
const indexSites = referenceSites.filter((site) => site.file === 'index.ts')

/** Files that literally IMPORT the cluster (stronger evidence than a reference inside the same tree). */
const importersOf = []
for (const file of sourceFiles(SRC)) {
  const rel = relative(SRC, file).split('\\').join('/')
  if (rel === 'index.ts' || NOT_SHIPPED.has(rel)) continue
  const text = codeLinesOf(file).join('\n')
  const importLines = text.split('\n').filter((line) => /^\s*(?:import|export)\b/u.test(line))
  for (const line of importLines) {
    if (CLUSTER.some((name) => new RegExp(`\\b${name}\\b`, 'u').test(line))) { importersOf.push({ file: rel, line: line.trim() }); break }
  }
}

/** Test files that mention the cluster (informational: a test may legitimately import a module). */
const testCallers = []
for (const entry of readdirSync(join(REPO, 'test'))) {
  const full = join(REPO, 'test', entry)
  if (!statSync(full).isFile() || !/\.m?js$/u.test(entry)) continue
  const text = readFileSync(full, 'utf8')
  if (CLUSTER.some((name) => new RegExp(`\\b${name}\\b`, 'u').test(text))) testCallers.push(entry)
}

// ── C3: can it be tested by importing only the cluster? ────────────────────────────────────────────
// Machine signal: does the cluster have any reference to a symbol that lives in index.ts and would NOT
// travel with it? That is exactly the cluster's `outside` set.
const outsideRefs = (() => {
  if (closureOfCluster === undefined) return []
  const members = new Set(closureOfCluster.members.map((member) => member.name))
  return [...members].filter((name) => !subset.has(name)).map((name) => {
    const member = closureOfCluster.members.find((candidate) => candidate.name === name)
    return { name, kind: member.kind }
  })
})()

// ── C4: implicit ordering inside the container ─────────────────────────────────────────────────────
// Machine signal: does the cluster read a name that is ASSIGNED inside the container's body but
// declared outside the cluster? Those are the "must run after X is set" dependencies.
const CONTAINER = 'buildTape'
const containerSpan = indexDeclarations.get(CONTAINER)
const containerAssignments = new Set()
let containerBodyLines = 0
if (containerSpan !== undefined) {
  const all = readFileSync(INDEX, 'utf8').split('\n')
  const body = all.slice(containerSpan.start - 1, containerSpan.end)
  containerBodyLines = body.length
  for (const line of body) {
    // destructuring: const { a, b } = ... / const [x, y] = ...
    for (const match of line.matchAll(/(?:^|\s)(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/gu)) {
      for (const part of match[1].split(',')) {
        const name = part.trim().split(':').pop()?.split('=')[0]?.trim()
        if (name !== undefined && /^[A-Za-z_$][\w$]*$/u.test(name)) containerAssignments.add(name)
      }
    }
    // simple declarations: const x = ... / let x = ... / var x = ...
    for (const match of line.matchAll(/(?:^|[^\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gu)) containerAssignments.add(match[1])
    // bare reassignment of an outer binding: x = ... (not ==, ===, =>, <=, >=, !=)
    for (const match of line.matchAll(/(?:^|\s)([A-Za-z_$][\w$]*)\s*=(?![=>])/gu)) {
      if (!/^(?:const|let|var|if|while|for|return|throw)$/u.test(match[1])) containerAssignments.add(match[1])
    }
    // for-of / for-in bindings
    for (const match of line.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gu)) containerAssignments.add(match[1])
  }
}
const clusterNames = new Set(CLUSTER)
const implicitOrdering = outsideRefs.filter((ref) => containerAssignments.has(ref.name))
/**
 * ── C4 MUST NOT PASS BECAUSE ITS INPUT SET IS EMPTY ─────────────────────────────────────────────
 *
 * The first version asked only: "does any OUTSIDE dependency name a container-local variable?" For a
 * closed cluster that question is vacuous — outsideRefs is empty, so the answer is always YES. That is
 * the empty-set-as-proof shape this phase keeps finding.
 *
 * The question C4 actually asks (user ruling ⑤) is: which buildTape-local variables does this cluster
 * READ? A function that closes over `sliced`, `currentTurn` or `turns` cannot be hoisted out of the
 * container however small its own closure is.
 *
 * ── AND THE COMMENTS MUST BE STRIPPED, WHICH THE SECOND VERSION FORGOT ──────────────────────────
 *
 * Measured on `extractGoal`: the scanner reported 17 reads, and **10 of the 11 distinct names were
 * words in PROSE** — `message`, `user`, `goal`, `content`, `target`, `semantic`, `call`, `pointer` all
 * first occur inside `/** … *\/` paragraphs (`"is this human message a requirement"`,
 * `"the user's 先别写骨架，先修 CI vanished"`, …). The only real hit was `event`, and even that was the
 * PARAMETER of an arrow function (`(event) => event.type === …`), not a container local.
 *
 * This is the same defect as C2's comment mentions, one layer down: a name in prose is not a name in
 * code. So the cluster's text goes through the SAME whole-file stripper the declaration parser uses,
 * and names that the cluster DECLARES ITSELF (parameters, destructuring, const/let/var) are dropped —
 * a function is not closed over by its own parameter.
 */
const containerLocalReads = (() => {
  if (containerSpan === undefined) return []
  const reads = []
  for (const name of CLUSTER) {
    const span = resolveDeclaration(name)
    if (span === undefined) continue
    // ── A CLUSTER MEMBER MAY LIVE IN ANY FILE, NOT ONLY index.ts ─────────────────────────────
    //
    // The first version skipped anything whose file was not `index.ts`. That made C4 silently report
    // "reads nothing" for any member that had already been moved — and, worse, a PROBE function written
    // in a new module and reading a buildTape local came back with zero hits. Zero from "not scanned" is
    // indistinguishable from zero from "scanned and clean", which is exactly the empty-set failure this
    // question exists to avoid. Scan wherever the member actually is.
    const memberFile = span.file ?? 'index.ts'
    const memberLines = memberFile === 'index.ts' ? codeLinesOf(INDEX) : codeLinesOf(join(SRC, memberFile))
    const memberRaw = memberFile === 'index.ts' ? readFileSync(INDEX, 'utf8').split('\n') : readFileSync(join(SRC, memberFile), 'utf8').split('\n')
    const body = memberLines.slice(span.start - 1, span.end)

    // Names the cluster declares ITSELF (parameters, destructuring, local const/let/var, arrow params).
    const own = new Set()
    for (const line of body) {
      for (const match of line.matchAll(/(?:^|[^\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gu)) own.add(match[1])
      for (const match of line.matchAll(/(?:^|[\s(,])([A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$]/gu)) own.add(match[1])
      for (const match of line.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*=(?![=>])/gu)) own.add(match[1])
      // arrow-function parameters, single or parenthesised: `(existing) =>`, `(a, b) =>`, `event =>`
      for (const match of line.matchAll(/\(([^()]*)\)\s*=>/gu)) {
        for (const part of match[1].split(',')) {
          const parameter = part.trim().split('=')[0]?.trim()
          if (parameter !== undefined && /^[A-Za-z_$][\w$]*$/u.test(parameter)) own.add(parameter)
        }
      }
      for (const match of line.matchAll(/(?:^|[^\w$.)])([A-Za-z_$][\w$]*)\s*=>/gu)) own.add(match[1])
      for (const match of line.matchAll(/function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/gu)) {
        for (const part of match[1].split(',')) {
          const parameter = part.trim().split(':')[0]?.split('=')[0]?.trim()
          if (parameter !== undefined && /^[A-Za-z_$][\w$]*$/u.test(parameter)) own.add(parameter)
        }
      }
      for (const match of line.matchAll(/(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/gu)) {
        for (const part of match[1].split(',')) {
          const declared = part.trim().split(':').pop()?.split('=')[0]?.trim()
          if (declared !== undefined && /^[A-Za-z_$][\w$]*$/u.test(declared)) own.add(declared)
        }
      }
    }

    for (const [offset, line] of body.entries()) {
      /**
       * ── A TYPE MEMBER IS NOT A VARIABLE READ (the fourth false-positive source) ────────────────
       *
       * Measured on cluster 1: C4 reported 4 hits and every one was an INTERFACE FIELD —
       * `semantic?: SemanticState`, `replayedMessagesSkipped?: number`, `userTexts?: string[]`,
       * `isError?: boolean`. A type declaration names fields; it does not read container state. A type
       * cannot have an implicit ordering at all, so any hit inside a `type` member is meaningless.
       */
      const spanKind = resolveDeclaration(name)?.kind
      if (spanKind === 'type') continue
      // A field/property declaration line: `name?: Type` or `name: Type` at the start of a member.
      if (/^\s*(?:readonly\s+)?[A-Za-z_$][\w$]*\??\s*[:(]/u.test(line) && !/^\s*(?:const|let|var|return|if|for|while)\b/u.test(line)) {
        continue
      }
      for (const local of containerAssignments) {
        if (own.has(local)) continue // its own parameter/local, not the container's
        // A PROPERTY NAME IS NOT A VARIABLE: in `event.data?.source` the token `source` is a property.
        // Remove every property access before testing, so only a genuine bare identifier counts.
        let stripped = line.replace(new RegExp('\\??\\.\\s*' + local.replace(/\$/gu, '\\$') + '\\b', 'gu'), ' ')
        // AN OBJECT-LITERAL KEY IS NOT A VARIABLE EITHER: in `{ source: 'user' }` it is a key.
        stripped = stripped.replace(new RegExp('(^|[({,\\[])\\s*' + local.replace(/\$/gu, '\\$') + '\\s*:(?!:)', 'gu'), '$1 ')
        const pattern = new RegExp('\\b' + local.replace(/\$/gu, '\\$') + '\\b', 'u')
        if (!pattern.test(stripped)) continue
        reads.push({
          clusterMember: name,
          local,
          atLine: span.start + offset,
          // show the source line WITH comments so a human can see what the code actually says
          text: (memberRaw[span.start + offset - 1] ?? '').trim().slice(0, 110),
        })
      }
    }
  }
  const seen = new Set()
  return reads.filter((entry) => {
    const key = entry.clusterMember + '::' + entry.local
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
})()


// ── D: performance tiers ───────────────────────────────────────────────────────────────────────────
const exportSurface = (() => {
  try {
    const json = JSON.parse(readFileSync(join(REPO, '.export-surface.json'), 'utf8'))
    return { count: json.count, list: json.exports ?? [] }
  } catch { return { count: undefined, list: [] } }
})()
const clusterInExportSurface = CLUSTER.filter((name) => exportSurface.list.includes(name))

const forbiddenPatterns = [
  { label: 'eval(', pattern: /\beval\s*\(/u },
  { label: 'dynamic import(', pattern: /\bimport\s*\(/u },
  { label: 'absolute Windows path', pattern: /[A-Za-z]:\\\\|[A-Za-z]:\/[A-Za-z]/u },
]

const report = {
  cluster: CLUSTER,
  A: {
    tier: 'A 模块大小 ≤ 800',
    verdict: spans.length === 0 ? 'NOT-FOUND' : (aVerdict ? 'YES' : 'NO'),
    machine: true,
    measured: {
      moduleLines,
      cap: 800,
      declarations: spans.map((span) => ({ name: span.name, kind: span.kind, file: span.file ?? 'index.ts', start: span.start, end: span.end, lines: span.lines })),
    },
  },
  B: {
    tier: 'B 闭包（只报告，不设限）',
    verdict: 'REPORTED',
    machine: true,
    measured: {
      closureLines: clusterClosureLines,
      /**
       * ── THE DECLARATION COUNT MUST BE THE UNION'S SIZE TOO ────────────────────────────────
       *
       * Measured on the text-tools cluster (4 members, 19 lines): this field reported
       * `declarations: 1`, because it was taken from `closureOfCluster`, which is the FIRST member's
       * closure. The line count was already the union (19), so the pair read "1 declaration / 19 lines"
       * — a combination that cannot exist and would make a reader distrust the whole row.
       */
      declarations: clusterClosureMembers.size,
      mutable: [...new Set(memberClosures.flatMap((entry) => entry.closure.mutable))].join(', ') || 'none',
    },
  },
  C1: {
    tier: 'C1 一句话说清（不含「并且」）',
    verdict: oneKind ? 'LIKELY' : 'REVIEW',
    machine: false,
    measured: { kinds: [...new Set(kinds)], note: oneKind ? 'the cluster is a single declaration kind' : 'mixed kinds — the sentence may need "and"' },
  },
  C2: {
    tier: 'C2 调用面：只被容器及同簇调用',
    verdict: productionCallers.length === 0 ? 'YES' : 'REVIEW',
    machine: true,
    measured: { productionCallers, indexSites: indexSites.length, testCallers },
  },
  C3: {
    tier: 'C3 能否只 import 该簇写 ≥3 条断言',
    verdict: outsideRefs.length === 0 ? 'YES' : 'REVIEW',
    machine: true,
    measured: { outsideRefs, note: outsideRefs.length === 0 ? 'the cluster needs nothing outside itself' : 'these must come along or be imported' },
  },
  C4: {
    tier: 'C4 无隐式时序',
    verdict: (implicitOrdering.length === 0 && containerLocalReads.length === 0) ? 'YES' : 'REVIEW',
    machine: implicitOrdering.length === 0 && containerLocalReads.length === 0,
    measured: {
      implicitOrdering,
      containerLocalReads,
      containerAssignments: containerAssignments.size,
      containerBodyLines,
      note: containerLocalReads.length === 0
        ? 'the cluster reads NONE of the container\'s local bindings — it can leave as a unit'
        : `the cluster reads ${containerLocalReads.length} container-local name(s); each must be judged "can it still get this after moving?"`,
    },
  },
  D: {
    tier: 'D 性能不退（四项）',
    verdict: 'MEASURED-SEPARATELY',
    machine: false,
    measured: {
      efficiency: 'same-process A/B alternation, relative delta vs the pre-move bundle; > 10% worse = regression. A pure move has no mechanism to change this, so 0% is the expectation — an absolute µs threshold is NOT a criterion (it drifts with the machine)',
      safety: { exportSurfaceCount: exportSurface.count, clusterInExportSurface, forbidden: forbiddenPatterns.map((entry) => entry.label) },
      stability: '当前全套全绿 + 连续 3 次一致 + build 两次 SHA256 相同',
      concurrency: 'v77-state-locks + v096-lock-trace green; lock boundary unchanged if the cluster writes files',
    },
  },
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

const line = (text) => console.log(text)
line(`cluster: ${CLUSTER.join(', ')}`)
line('')
line(`── A 模块大小 ≤ 800 ─────────────────────────────────────────────`)
line(`   ${aVerdict ? 'YES' : 'NO'}   ${moduleLines} 行`)
for (const span of spans) line(`        ${span.name} [${span.kind}] ${span.file ?? 'index.ts'}:L${span.start}..L${span.end} = ${span.lines} 行`)
if (spans.length === 0) line(`        !! NOT FOUND in src/ — the gate cannot measure what it cannot locate`)

line('')
line(`── B 闭包（只报告，不设限）─────────────────────────────────────`)
line(`   ${clusterClosureLines ?? '?'} 行 / ${clusterClosureMembers.size} 声明 / mutable: ${report.B.measured.mutable}`)

line('')
line(`── C1 一句话说清（不含「并且」）────────────────────────────────`)
line(`   ${report.C1.verdict}   声明种类: ${[...new Set(kinds)].join(', ')}`)
line(`        人工确认：这个簇能否用一句不含「并且」的话说清？`)

line('')
line(`── C2 调用面 ───────────────────────────────────────────────────`)
line(`   ${report.C2.verdict}   生产代码调用者: ${productionCallers.length === 0 ? '(无)' : productionCallers.join(', ')}`)
line(`        index.ts 内引用 ${indexSites.length} 处；测试提及 ${testCallers.length} 个文件`)
for (const site of testCallers) line(`          test/${site}`)

line('')
line(`── C3 能否只 import 该簇写 ≥3 条断言 ───────────────────────────`)
line(`   ${report.C3.verdict}   outside 引用: ${outsideRefs.length === 0 ? '(无)' : outsideRefs.map((ref) => `${ref.name} [${ref.kind}]`).join(', ')}`)

line('')
line(`── C4 无隐式时序（最关键）──────────────────────────────────────`)
line(`   ${report.C4.verdict}   依赖容器内先赋值的外部名字: ${implicitOrdering.length === 0 ? '(无)' : implicitOrdering.map((ref) => ref.name).join(', ')}`)
line(`        读到的容器局部变量: ${containerLocalReads.length === 0 ? '(无)' : containerLocalReads.length + ' 处'}`)
for (const read of containerLocalReads) line(`          ${read.clusterMember} 读 ${read.local}  (L${read.atLine})`)
line(`        buildTape 体内 ${containerBodyLines} 行，解析出 ${containerAssignments.size} 个局部赋值`)

line('')
line(`── D 性能不退（四项，需分别测量）───────────────────────────────`)
line(`   效率     同进程 A/B 交替采样，与搬前产物比相对量；>10% 视为退`)
line(`            纯位移没有改变它的机制，预期 0%。绝对 µs 阈值不是判据（会随机器漂移）`)
line(`   安全性   导出面 ${exportSurface.count} 条不变；本簇是否在导出面: ${clusterInExportSurface.length === 0 ? '否（类型不进产物）' : clusterInExportSurface.join(', ')}`)
line(`            禁 eval / 动态 import / 明文路径`)
line(`   稳定性   当前全套全绿 + 连续 3 次一致 + build 两次 SHA256 相同`)
line(`   并发     v77-state-locks + v096-lock-trace 全绿；簇若写文件须证明锁边界未变`)

line('')
const machineVetoes = [report.A, report.C2, report.C3, report.C4].filter((entry) => entry.verdict === 'NO' || entry.verdict === 'NOT-FOUND')
line(`── 机器判据汇总 ────────────────────────────────────────────────`)
line(`   A=${report.A.verdict}  C2=${report.C2.verdict}  C3=${report.C3.verdict}  C4=${report.C4.verdict}`)
line(`   ${machineVetoes.length === 0 ? '无机器否决。C1 与 D 四项仍须人工/单独测量。' : `否决 ${machineVetoes.length} 项：${machineVetoes.map((entry) => entry.tier).join('; ')}`}`)
process.exit(machineVetoes.length === 0 ? 0 : 1)
