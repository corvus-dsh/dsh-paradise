#!/usr/bin/env node
/**
 * ── WHO REFERENCES SYMBOL X? — exact identifier, never a substring ─────────────────────────────────
 *
 * THE FAILURE THIS EXISTS TO PREVENT (observed twice, on both sides of the review):
 *
 *     includes('GraftSource')  also matches
 *        GraftSourceShape        (host-shape.ts — a different interface)
 *        pendingGraftSources     (state.ts / ignition.ts — a Map field / Set variable)
 *
 * That produced "GraftSource is referenced by 5 core/ modules" — a confident, wrong statement. The
 * finding was caught by re-checking line by line, not by any tool, which is exactly why the tool is
 * needed: the next reader would have believed the sum.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────────────────────────────
 *
 * A symbol reference is a WHOLE IDENTIFIER. Matching is `\b<name>\b`, and the classification separates
 *   DECL   the declaration itself
 *   IMPORT an import/export clause naming it
 *   TYPE   a type position (`: X`, `<X>`, `as X`, `X |`)
 *   CODE   any other code reference
 *   PROSE  a comment or a string literal (NOT a reference — reported separately so it cannot be
 *          silently counted, and so "5 modules mention it" can be seen for what it is)
 *
 * Usage:
 *   node scripts/who-references.mjs GraftSource [GraftTape …]
 *   node scripts/who-references.mjs --json GraftSource
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
/**
 * `GRAFT_WHO_REFS_SRC` 让测试把扫描指向 src/ 的**临时副本**。
 *
 * 实测：本仓库的探针测试曾把 `__v141-probe.ts` 写进真实 `src/core/` 再删除。Node 的测试运行器
 * 并行跑文件，别的测试在这段窗口里会读到多出来的模块（依赖图、产物构建、计数门禁都可能因此抖动）。
 * 给仪器一个指向副本的入口，测试就不必碰真实树 —— 与 `check-cycles.mjs` / `closure.mjs` 同一做法。
 */
const SRC = process.env.GRAFT_WHO_REFS_SRC !== undefined && process.env.GRAFT_WHO_REFS_SRC !== ''
  ? resolve(process.env.GRAFT_WHO_REFS_SRC)
  : join(REPO, 'src')

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const names = args.filter((a) => !a.startsWith('--'))
if (names.length === 0) {
  console.error('usage: node scripts/who-references.mjs [--json] <Symbol> [<Symbol> ...]')
  process.exit(2)
}

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
 * Split each line into the CODE half and the PROSE half, preserving line count.
 *
 * ── THREE SHAPES, AND TWO OF THEM ARE NOT REFERENCES ────────────────────────────────────────────
 *
 * Measured with a probe (left in test/v141 as an assertion):
 *
 *     'GraftSource'                 a string literal        → PROSE  (its content is text)
 *     `type=${GraftSource}`         a template INTERPOLATION → CODE   (the interpolation is an expression)
 *     `type=GraftSource`            template TEXT            → PROSE  (text)
 *
 * The first version of this function did not handle strings at all — it only cut `//` comments — so
 * all three came back CODE. Two of those are FALSE POSITIVES: a name inside a string is not a
 * reference. `\`type=${X}\`` staying CODE was luck, not design.
 *
 * So the scanner tracks quote state across the file. Inside a template literal, a `${ … }` run is
 * copied into the CODE half (and the brace depth is tracked, because `${a ? \`${b}\` : c}` nests).
 *
 * ── A REGEX LITERAL IS NOT A STRING, AND CONFUSING THEM POISONED WHOLE FILES ─────────────────────
 *
 * Measured: `sessionTitleForGoal` came back with 2 references when it has 3 call sites — index.ts:9936
 * and host-shape.ts:656 both sat inside what the scanner thought was an unterminated string. The
 * culprit was `/[{}[\]"]/u` (host-shape.ts:336) and `matchAll(/…[^\s"'`,;)|&]+/gu)` (command-guard.ts):
 * a quote INSIDE a regex literal switched the state to "string", the string never closed on that line,
 * and every following line was filed as PROSE until an accidental matching quote much later.
 *
 * A regex cannot span lines, so one leaked regex does not corrupt one line — it corrupts a REGION.
 * Hence: recognise `/` as a regex opener when the previous meaningful character says so (an operator
 * position: start, `(`, `,`, `=`, `:`, `[`, `!`, `&`, `|`, `?`, `{`, `}`, `;`, `return`), then consume
 * to the closing `/` and its flags, treating quotes inside as regex characters. Without this the
 * instrument under-reports references — the dangerous direction, because "no caller" reads as "safe
 * to move", which is exactly the question this tool is asked.
 *
 * ── `//` ENDS AT THE END OF ITS OWN LINE, NOT THE START OF THE NEXT ─────────────────────────────
 *
 * Measured: index.ts:9936 (a real `sessionTitleForGoal` call) was filed as PROSE. Cause was one layer
 * up from the regex bug — the scanner carried state `'line'` INTO the following line and skipped it
 * whole. The line after a `//` comment was index.ts:9771, which opens a block comment with `/**`; that
 * opener was swallowed, so the block-comment body from 9772 to its `*​/` was scanned as CODE, the
 * apostrophe in "the target's constraints" opened a string, and the string ran for 150 lines.
 *
 * A line comment cannot outlive its line. The `//` branch already consumes the rest of THAT line, so
 * it must not set a persistent state at all.
 */
function splitProse(file) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const code = []
  const prose = []
  let state = 'code' // code | block | ' | " | `    ('line' is transient: see above)
  let interpolationDepth = 0

  /**
   * The tail of the code seen so far, used to decide whether a `/` starts a regex.
   *
   * It must be a TAIL, not a single character: `/` is a regex opener after a KEYWORD such as
   * `return /x/` or `typeof /x/`, and a keyword is more than one character. Measured: with a
   * one-character buffer, `return /[{}"]/u.test(x)` fell through to the division branch, the `"`
   * inside the character class opened a string, and the rest of the file was filed PROSE.
   */
  let codeTail = ''

  const regexAllowed = () => codeTail.trim() === ''
    || /[=(,:;[\]{!&|?+\-*%^~<>]$/u.test(codeTail.trimEnd())
    || /\b(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/u.test(codeTail.trimEnd())

  for (const line of lines) {
    let codePart = ''
    let prosePart = ''
    let index = 0

    if (state === 'block') {
      const close = line.indexOf('*/')
      if (close < 0) { code.push(''); prose.push(line); continue }
      prosePart += line.slice(0, close + 2)
      index = close + 2
      state = 'code'
    }

    while (index < line.length) {
      const char = line[index]
      const next = line[index + 1]

      if (state === 'code') {
        if (char === '/' && next === '*') { state = 'block'; prosePart += '/*'; index += 2; continue }
        // `//` runs to the END OF THIS LINE. It must not persist: the next line is ordinary code.
        if (char === '/' && next === '/') { prosePart += line.slice(index); break }
        // a regex literal is CODE: its quotes and brackets are regex syntax, not delimiters
        if (char === '/' && regexAllowed()) {
          let j = index + 1
          // the character class is tracked because `[/]` does not close the regex
          let inClass = false
          for (; j < line.length; j++) {
            const c = line[j]
            if (c === '\\') { j += 1; continue }
            if (c === '[') { inClass = true; continue }
            if (c === ']') { inClass = false; continue }
            if (c === '/' && !inClass) break
          }
          if (j < line.length) {
            j += 1
            while (j < line.length && /[a-z]/iu.test(line[j])) j += 1
            codePart += line.slice(index, j)
            codeTail = 'x'
            index = j
            continue
          }
          // no closing slash on this line: it was a division sign, not a regex
        }
        if (char === "'" || char === '"') { state = char; prosePart += char; index += 1; codeTail += char; continue }
        if (char === '`') { state = '`'; prosePart += char; index += 1; codeTail += char; continue }
        codeTail = (codeTail + char).slice(-24)
        codePart += char
        index += 1
        continue
      }

      if (state === 'block') {
        if (char === '*' && next === '/') { state = 'code'; prosePart += '*/'; index += 2; continue }
        prosePart += char
        index += 1
        continue
      }

      if (state === "'" || state === '"') {
        if (char === '\\') { prosePart += line.slice(index, index + 2); index += 2; continue }
        if (char === state) { state = 'code'; prosePart += char; index += 1; continue }
        prosePart += char
        index += 1
        continue
      }

      // inside a template literal
      if (char === '\\') { prosePart += line.slice(index, index + 2); index += 2; continue }
      if (char === '`' && interpolationDepth === 0) { state = 'code'; prosePart += char; index += 1; continue }
      if (char === '$' && next === '{') {
        // an INTERPOLATION is code, not text
        interpolationDepth = 1
        codePart += '${'
        index += 2
        let inner = ''
        while (index < line.length) {
          const c = line[index]
          if (c === '{') { interpolationDepth += 1; inner += c; index += 1; continue }
          if (c === '}') {
            interpolationDepth -= 1
            index += 1
            if (interpolationDepth === 0) break
            inner += c
            continue
          }
          inner += c
          index += 1
        }
        codePart += inner + '}'
        continue
      }
      prosePart += char
      index += 1
    }

    code.push(codePart)
    prose.push(prosePart)
  }
  return { code, prose }
}

const findings = []
for (const file of sourceFiles(SRC)) {
  const rel = relative(SRC, file).split('\\').join('/')
  const { code, prose } = splitProse(file)
  for (const name of names) {
    // \b is the whole point: GraftSource must not match GraftSourceShape or pendingGraftSources
    const exact = new RegExp(`\\b${name.replace(/\$/gu, '\\$')}\\b`, 'u')
    for (const [index, line] of code.entries()) {
      if (!exact.test(line)) continue
      const isDecl = new RegExp(`^(?:export\\s+)?(?:declare\\s+)?(?:interface|type|class|const|let|var|function)\\s+${name}\\b`, 'u').test(line.trim())
      /**
       * ── `export` IS NOT THE SAME AS `import` ──────────────────────────────────────────────────
       *
       * The first version used /^\s*(?:import|export)\b/ and therefore classified EVERY line that
       * starts with `export` as an IMPORT — including `export function apply(ctx, config: GraftConfig)`,
       * a mere signature. Measured: GraftConfig came back with "imports" in `index.ts` (two function
       * signatures) and in `core/ignition.ts.bak-cut:64`, none of which import anything.
       *
       * An import/export CLAUSE names the symbol in its binding list: `import { A, B } from`, or
       * `export type { A } from`, or `export { A }`. A declaration's signature does not.
       */
      const isImportClause = /^\s*import\b/u.test(line)
        || /^\s*export\s+(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?)\s*(?:from\b)?/u.test(line)
      const isImport = isImportClause && new RegExp(`(?:\\{[^}]*\\b${name}\\b[^}]*\\}|\\b${name}\\s+from\\b|\\bas\\s+${name}\\b)`, 'u').test(line)
      const isType = new RegExp(`(?::\\s*|as\\s+|<|\\||&\\s*)${name}\\b`, 'u').test(line)
      findings.push({
        symbol: name, file: rel, line: index + 1,
        kind: isDecl ? 'DECL' : isImport ? 'IMPORT' : isType ? 'TYPE' : 'CODE',
        text: line.trim().slice(0, 110),
        /**
         * `nested` must be captured from the RAW line, before the trim — the indentation IS the signal.
         * Measured: a first version derived it from the trimmed `text`, so every local `const name`
         * inside a function was labelled `[module-level]`, and the ambiguity report could not show
         * which declarations were shadowing.
         */
        nested: /^\s+\S/u.test(line),
      })
    }
    // prose mentions are reported separately — never as references
    for (const [index, line] of prose.entries()) {
      if (!exact.test(line)) continue
      findings.push({ symbol: name, file: rel, line: index + 1, kind: 'PROSE', text: line.trim().slice(0, 110) })
    }
  }
}

/**
 * ── SCOPE: A NAME WITH MORE THAN ONE DECLARATION IS NOT ONE SYMBOL ──────────────────────────────
 *
 * Measured (2026-11-12): `families.mjs` reported ONE connected component of 17 declarations gluing
 * `buildTape`'s helpers together. All twelve of the edges that did the gluing pointed at `name` —
 * the plugin constant `export const name = 'dsh-graft-slice'` — but every single reference was to a
 * SHADOWING local: `const name = …` inside `attachmentPointer` (index.ts:3554), `name` as an object
 * property, `name` as a local tool-name variable.
 *
 * This tool matches `\bname\b` on a line. It never claimed to resolve bindings, and it cannot: the
 * same text is a different symbol at every scope. So a name that is declared more than once is
 * reported as AMBIGUOUS and EXCLUDED from the reference count — because a count that silently mixes
 * scopes is not a lower bound and not an upper bound, it is a wrong number.
 *
 * The exclusion is PRINTED, never silent (same rule as every other exclusion in this repo).
 *
 * ── THIS MUST RUN BEFORE THE `--json` EXIT ───────────────────────────────────────────────────────
 *
 * Measured: the first version computed ambiguity AFTER `if (asJson) … exit(0)`, so the machine-readable
 * output never carried `ambiguous` at all — and `families.mjs` consumes exactly that output. A guard
 * that only exists in the human-readable path is not a guard for the consumers.
 */
const declSites = new Map()
for (const f of findings) {
  if (f.kind !== 'DECL') continue
  if (!declSites.has(f.symbol)) declSites.set(f.symbol, [])
  declSites.get(f.symbol).push(f)
}

/** A declaration is NESTED when its raw line was indented; a module-level one starts at column 0. */
const isNested = (f) => f.nested === true

const ambiguous = new Map()
for (const [symbol, sites] of declSites) {
  // more than one declaration site ⇒ shadowing is possible; we cannot tell which one a reference means
  if (sites.length > 1) ambiguous.set(symbol, sites)
}

for (const f of findings) {
  if (ambiguous.has(f.symbol)) f.ambiguous = true
}


if (asJson) { console.log(JSON.stringify(findings, null, 1)); process.exit(0) }

if (ambiguous.size > 0) {
  console.log('AMBIGUOUS (excluded from reference counts — same text, more than one declaration):')
  for (const [symbol, sites] of [...ambiguous].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${symbol}: ${sites.length} declaration site(s)`)
    for (const s of sites) console.log(`      ${s.file}:${s.line}${isNested(s) ? '  [nested — shadows]' : '  [module-level]'}  ${s.text.slice(0, 70)}`)
  }
  console.log('')
}

for (const symbol of names) {
  const mine = findings.filter((f) => f.symbol === symbol)
  const refs = mine.filter((f) => f.kind !== 'PROSE' && f.kind !== 'DECL')
  const proseOnly = mine.filter((f) => f.kind === 'PROSE')
  console.log(`\n${symbol}`)
  console.log(`  declarations : ${mine.filter((f) => f.kind === 'DECL').length}`)
  if (ambiguous.has(symbol)) {
    console.log(`  references   : EXCLUDED — ${ambiguous.get(symbol).length} declarations share this name,`)
    console.log('                 so a reference here cannot be attributed to one symbol')
  } else {
    console.log(`  references   : ${refs.length}  (files: ${[...new Set(refs.map((f) => f.file))].join(', ') || 'none'})`)
  }
  console.log(`  prose mentions: ${proseOnly.length}  ← NOT references`)
  for (const f of mine) console.log(`    [${f.kind.padEnd(6)}] ${f.file}:${f.line}  ${f.text}`)
}
