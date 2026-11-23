/**
 * ── handler-inventory: WHO IS REGISTERED, AND WHAT FACTS DOES EACH UNIT OWN ──────────────────────
 *
 * Phase A deliverable (B4-B/①). The unit is NOT `ctx.on(` — that was the first formulation, and it
 * would have produced three EMPTY tables:
 *
 *     memory   ctx.on( → 0      observer  ctx.on( → 0      paradise  ctx.on( → 0
 *
 * because two repos call the hook OPTIONALLY (`ctx.on?.(`) and paradise registers nothing at all. A
 * criterion written as 「scanned ≥ actual ctx.on( count」 would then pass VACUOUSLY (0 ≥ 0) — the
 * empty-set disease this batch keeps removing.
 *
 * So four kinds are scanned, and **every kind that is empty must say WHY it is empty**:
 *
 *     tool  command  event  adapter-entry
 *
 * MECHANICAL vs DECLARED. Names, locations and spans are read from the source. `facts` and `movable`
 * cannot be: they are judgments, so they live in `docs/handler-inventory.json` and this script REFUSES to
 * call the inventory complete until every scanned unit has one. A checklist the scanner invents for
 * itself would be the same 「a criterion that pins a spelling pins the spelling」 failure.
 *
 * Usage:
 *   node scripts/handler-inventory.mjs           # verify + print the summary (exit 1 on any gap)
 *   node scripts/handler-inventory.mjs --write   # also (re)generate docs/HANDLER-INVENTORY.md
 *   node scripts/handler-inventory.mjs --skeleton# print the JSON skeleton for missing declarations
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(REPO, 'src')
const DECLARATIONS = join(REPO, 'docs', 'handler-inventory.json')
const OUTPUT = join(REPO, 'docs', 'HANDLER-INVENTORY.md')

const KINDS = ['tool', 'command', 'event', 'adapter-entry']

/** Every `.ts` under `src`, recursively. `test`/`dist`/`node_modules` are not registration surfaces. */
function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === 'test') continue
    const full = join(dir, name)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) walk(full, out)
    else if (name.endsWith('.ts')) out.push(full)
  }
  return out
}

/**
 * The CODE half of a line. A mention inside a comment never counts — measured: this repository has a
 * `ctx.tools?.register(` in a comment (`index.ts:135`) and a `ctx.on(` in one (`index.ts:8657`), and the
 * raw grep counts 17 tools / 5 events where the truth is 16 / 4.
 */
function codeOf(line) {
  const trimmed = line.trimStart()
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return ''
  const at = line.indexOf('//')
  return at >= 0 ? line.slice(0, at) : line
}

/** The unit's closing line, found by balancing the `(` that opens the registration. */
function spanEnd(lines, startIndex) {
  let depth = 0
  let seen = false
  for (let i = startIndex; i < lines.length; i += 1) {
    for (const ch of codeOf(lines[i])) {
      if (ch === '(') {
        depth += 1
        seen = true
      } else if (ch === ')') depth -= 1
    }
    if (seen && depth <= 0) return i + 1
  }
  return startIndex + 1
}

const PATTERNS = {
  tool: /(?:ctx\.)?tools\??\.register\s*\(/u,
  command: /commands?\??\.register\s*\(/u,
  event: /ctx\.on\??\.?\s*\(/u,
  'adapter-entry': /(?:registerAdapter|adapters?\s*\.\s*push)\s*\(/u,
}

function nameOf(kind, lines, index) {
  for (let i = index; i < Math.min(lines.length, index + 10); i += 1) {
    const named = /name:\s*'([^']+)'/u.exec(codeOf(lines[i])) ?? /name:\s*"([^"]+)"/u.exec(codeOf(lines[i]))
    if (named !== null) return named[1]
  }
  if (kind === 'event') {
    const literal = /ctx\.on\??\.?\s*\(\s*'([^']+)'/u.exec(codeOf(lines[index]))
    if (literal !== null) return literal[1]
    const constant = /ctx\.on\??\.?\s*\(\s*([A-Z][A-Z0-9_]+)/u.exec(codeOf(lines[index]))
    return constant === null ? '(event)' : constant[1]
  }
  /* A delegated registration carries its name one call deeper, possibly on the NEXT line:
   *     ctx.tools?.register(
   *         graphUpdateTool({ ... })
   * Measured: reading only the same line produced `(anonymous)` for a real, named tool. */
  const window = lines.slice(index, index + 4).map(codeOf).join(' ')
  const factory = /register\s*\(\s*([a-zA-Z][\w]*)\s*\(/u.exec(window)
  if (factory !== null) return `<${factory[1]}>`
  return '(anonymous)'
}

function scan() {
  const units = []
  for (const file of walk(SRC)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, index) => {
      const code = codeOf(line)
      if (code.length === 0) return
      for (const kind of KINDS) {
        if (!PATTERNS[kind].test(code)) continue
        const end = spanEnd(lines, index)
        units.push({
          kind,
          name: nameOf(kind, lines, index),
          file: relative(REPO, file).replace(/\\/gu, '/'),
          line: index + 1,
          end,
          lines: end - index,
        })
      }
    })
  }
  return units.sort((a, b) => (a.kind === b.kind ? a.line - b.line : KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind)))
}

function declarations() {
  try {
    return JSON.parse(readFileSync(DECLARATIONS, 'utf8'))
  } catch {
    return { repo: '', zeroReasons: {}, units: {} }
  }
}

const units = scan()
const declared = declarations()
const key = (unit) => `${unit.kind}:${unit.name}`

const missing = units.filter((unit) => declared.units?.[key(unit)] === undefined)
const orphaned = Object.keys(declared.units ?? {}).filter((id) => !units.some((unit) => `${unit.kind}:${unit.name}` === id))
const emptyKinds = KINDS.filter((kind) => !units.some((unit) => unit.kind === kind))
const unexplained = emptyKinds.filter((kind) => typeof declared.zeroReasons?.[kind] !== 'string' || declared.zeroReasons[kind].trim().length < 20)

const args = new Set(process.argv.slice(2))

if (args.has('--skeleton')) {
  const skeleton = { repo: declared.repo ?? '(repo name)', zeroReasons: declared.zeroReasons ?? {}, units: { ...(declared.units ?? {}) } }
  for (const unit of units) {
    if (skeleton.units[key(unit)] === undefined) {
      skeleton.units[key(unit)] = { facts: 'TODO: 读什么 / 写什么', movable: 'TODO', why: 'TODO' }
    }
  }
  for (const kind of emptyKinds) {
    if (skeleton.zeroReasons[kind] === undefined) skeleton.zeroReasons[kind] = 'TODO: 为什么这一类是 0（这是事实，不是漏扫）'
  }
  console.log(JSON.stringify(skeleton, null, 2))
  process.exit(0)
}

const byKind = Object.fromEntries(KINDS.map((kind) => [kind, units.filter((unit) => unit.kind === kind)]))

if (args.has('--write')) {
  mkdirSync(dirname(OUTPUT), { recursive: true })
  const rows = []
  rows.push(`# handler-inventory · ${declared.repo ?? ''}`)
  rows.push('')
  rows.push('> 生成物：`node scripts/handler-inventory.mjs --write`。**不要手改** —— 它每次从头扫源码。')
  rows.push('> `facts` / `movable` / `why` 来自 `docs/handler-inventory.json`（判断，不可机械提取）。')
  rows.push('')
  for (const kind of KINDS) {
    const list = byKind[kind]
    rows.push(`## ${kind} · ${list.length}`)
    rows.push('')
    if (list.length === 0) {
      rows.push(`**这一类是 0，理由是事实：** ${declared.zeroReasons?.[kind] ?? '（未登记 —— 门禁会红）'}`)
      rows.push('')
      continue
    }
    rows.push('| # | 名称 | 位置 | 行数 | 读/写的事实 | 可搬 | 理由 |')
    rows.push('|---|---|---|---:|---|---|---|')
    list.forEach((unit, index) => {
      const entry = declared.units?.[key(unit)] ?? {}
      rows.push(
        `| ${index + 1} | \`${unit.name}\` | ${unit.file}:${unit.line}-${unit.end} | ${unit.lines} | ` +
          `${entry.facts ?? '**未登记**'} | ${entry.movable ?? '**未登记**'} | ${entry.why ?? '**未登记**'} |`,
      )
    })
    rows.push('')
  }
  writeFileSync(OUTPUT, `${rows.join('\n')}\n`, 'utf8')
  console.log(`wrote ${relative(REPO, OUTPUT).replace(/\\/gu, '/')}`)
}

console.log(`\n${declared.repo ?? '(repo)'}: ${units.length} unit(s)`)
for (const kind of KINDS) console.log(`  ${kind}: ${byKind[kind].length}`)

let failed = false
if (missing.length > 0) {
  failed = true
  console.log(`\n❌ ${missing.length} 个单元没有登记（facts / movable / why 是判断，必须手写）:`)
  for (const unit of missing) console.log(`   ${key(unit)}  (${unit.file}:${unit.line})`)
}
if (orphaned.length > 0) {
  failed = true
  console.log(`\n❌ ${orphaned.length} 条登记指向已不存在的单元（登记过期，和没登记一样有害）:`)
  for (const id of orphaned) console.log(`   ${id}`)
}
if (unexplained.length > 0) {
  failed = true
  console.log(`\n❌ 这些种类是 0，却没有写出理由 —— 0 是事实，但必须写出来，否则下一位读者会以为漏扫:`)
  for (const kind of unexplained) console.log(`   ${kind}`)
}
if (!failed) console.log('\nOK — every scanned unit is declared, every declared unit exists, every empty kind has a reason.')
process.exit(failed ? 1 : 0)