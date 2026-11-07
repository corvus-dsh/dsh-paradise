#!/usr/bin/env node
/**
 * Build `dist/harness.js` — THE STANDALONE CLI.
 *
 * WHY A SECOND ENTRY POINT NEEDS ITS OWN BUILDER
 *
 * `scripts/build.mjs` inlines everything reachable from `src/index.ts`, because that file is the PLUGIN:
 * importing it must never start a supervisor. The harness is a PROGRAM — it owns argv, env and stdout —
 * and it must not be reachable from the plugin graph, or importing the package would run `main`.
 *
 * So it gets its own bundle, with the same three properties the plugin bundle has:
 *
 *   1. ONE FILE, no relative specifiers at import time (a missing `./protocol/x.js` would fail at the
 *      first repair, which is the worst possible moment);
 *   2. node built-ins HOISTED and deduped — the only imports left in the shipped file;
 *   3. a SHEBANG, so `./dist/harness.js` is directly executable and `node dist/harness.js` also works.
 *
 * IT DOES NOT IMPORT `src/index.ts`. Two bundles that shared a 340 KB module would each carry a copy,
 * and — worse — the harness would inherit every adapter the plugin has, including the host-specific
 * ones it exists to be independent of.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

import { composeBundle, dropBareReExportLists } from './bundle.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const srcDir = join(root, 'src')
const outDir = join(root, 'dist')
const entry = join(srcDir, 'harness.ts')

/**
 * THE LOCAL SPECIFIER WALKER, copied deliberately rather than shared.
 *
 * `bundle.mjs` exports `composeBundle` which is hard-wired to `src/index.ts`. Sharing the internals
 * would mean exporting four private helpers for one caller. This file instead re-derives the same
 * three rules — resolve, dedupe, hoist node imports — and the `guard` below is what makes a divergence
 * fail loudly instead of shipping a broken CLI.
 */
const SPECIFIER = /from\s*['"](\.[^'"]+)['"]/gu
const NODE_IMPORT = /^import\s*\{([^}]*)\}\s*from\s*'(node:[^']+)'\s*;?[ \t]*\n?/gmu
const NODE_DEFAULT_IMPORT = /^import\s+(\w+)\s+from\s*'(node:[^']+)'\s*;?[ \t]*\n?/gmu

function resolveSpecifier(fromFile, spec) {
  const absolute = resolve(dirname(fromFile), spec)
  return absolute.endsWith('.ts') ? absolute : `${absolute.slice(0, -'.js'.length)}.ts`
}

function localSpecifiersOf(file) {
  return [...readFileSync(file, 'utf8').matchAll(SPECIFIER)].map((match) => resolveSpecifier(file, match[1]))
}

/** Depth-first topological order over the modules reachable from `harness.ts`. */
function orderModules(entryFile) {
  const state = new Map()
  const ordered = []
  const visit = (file, stack) => {
    if (state.get(file) === 'done') return
    if (state.get(file) === 'visiting') {
      throw new Error(`cycle: ${[...stack, file].map((f) => relative(srcDir, f)).join(' -> ')}`)
    }
    state.set(file, 'visiting')
    for (const dep of localSpecifiersOf(file)) visit(dep, [...stack, file])
    state.set(file, 'done')
    ordered.push(file)
  }
  visit(entryFile, [])
  return ordered
}

/** Remove local imports (the modules are inlined into one scope) and their `export` keywords. */
function inline(file) {
  const source = readFileSync(file, 'utf8').replace(/\r\n/gu, '\n').replace(/\r/gu, '\n')
  const withoutLocal = source
    .replace(/^import[^\n]*from[ \t]+'\.[^'\n]+';?[ \t]*\n/gmu, '')
    .replace(/^import[ \t]*\{\n(?:[ \t]+[^\n]*\n){0,40}?\}[ \t]*from[ \t]+'\.[^'\n]+';?[ \t]*\n/gmu, '')
    .replace(/^import[ \t]*\{(?:[^}\n]*)\}[ \t]*from[ \t]+'\.[^'\n]+';?[ \t]*\n/gmu, '')
  const code = stripTypeScriptTypes(withoutLocal, { mode: 'strip' })
  /**
   * `export` KEYWORDS ARE STRIPPED — EXCEPT THE ENTRY'S OWN, because a CLI exports `main` for tests.
   * The same reason the plugin bundle keeps `index.ts`'s exports.
   *
   * `dropBareReExportLists` IS IMPORTED, NOT DUPLICATED. A bare `export { … }` list leaves a BLOCK
   * STATEMENT when only the keyword is removed, and its trailing `}` then closes a brace nothing
   * opened — `dist/harness.js` failed to parse with `Unexpected token '}'`, which is how this CLI
   * stopped booting. The plugin builder had the same defect and was fixed first; copying that fix
   * here would guarantee the two copies drift, so the helper is shared.
   */
  return file === entry ? code.trim() : dropBareReExportLists(code).replace(/^export\s+/gmu, '').trim()
}

function hoistNodeImports(pieces) {
  const byModule = new Map()
  const stripped = pieces.map((code) =>
    code
      .replace(NODE_IMPORT, (_whole, names, moduleName) => {
        const set = byModule.get(moduleName) ?? new Set()
        for (const name of names.split(',')) {
          const trimmed = name.trim()
          if (trimmed.length > 0) set.add(trimmed)
        }
        byModule.set(moduleName, set)
        return ''
      })
      .replace(NODE_DEFAULT_IMPORT, (_whole, name, moduleName) => {
        const set = byModule.get(moduleName) ?? new Set()
        set.add(`__default__:${name}`)
        byModule.set(moduleName, set)
        return ''
      }),
  )
  const lines = []
  for (const [moduleName, names] of byModule.entries()) {
    const defaults = [...names].filter((name) => name.startsWith('__default__:')).map((name) => name.slice('__default__:'.length))
    const named = [...names].filter((name) => !name.startsWith('__default__:')).sort()
    if (defaults.length > 0) lines.push(`import ${defaults[0]} from '${moduleName}'`)
    if (named.length > 0) lines.push(`import { ${named.join(', ')} } from '${moduleName}'`)
  }
  return { header: lines.join('\n'), stripped }
}

/* ── compose ───────────────────────────────────────────────────────────────────────────── */

const ordered = orderModules(entry)
const pieces = ordered.map((file) => inline(file))
const names = ordered.map((file) => relative(srcDir, file).replace(/\\/gu, '/'))
const { header: nodeHeader, stripped } = hoistNodeImports(pieces)

const SHEBANG = '#!/usr/bin/env node'
const BANNER =
  '// GENERATED from src/harness.ts by scripts/build-harness.mjs — do not edit this file directly.\n' +
  `// Inlined modules (dependency order): ${names.join(', ')}\n`

const body = `${SHEBANG}\n${BANNER}${nodeHeader}\n\n${stripped.join('\n\n')}\n`

/**
 * THE GUARD, AND WHY IT IS THE MOST IMPORTANT PART OF THIS FILE.
 *
 * A surviving relative specifier fails at IMPORT time — which for a CLI means the moment a human types
 * the command, usually during an outage. The plugin bundle has the same guard for the same reason; this
 * one names the harness so the message says which artifact is broken.
 */
for (const [index, line] of body.split('\n').entries()) {
  if (/from\s*'\.\.?\//u.test(line)) {
    throw new Error(
      `dist/harness.js would ship an unresolved relative import (line ${index + 1}): ${line.trim()}\n` +
        'Hint: inlined modules must be re-exported BARE (`export { a }`), not `export … from`.',
    )
  }
}

/**
 * THE ENTRY POINT MUST ACTUALLY BE CALLED.
 *
 * `main` is exported so a test can drive it; a FILE that only defines it would exit 0 having done
 * nothing — the most expensive kind of silence. The guard is `import.meta.url` matching `argv[1]` so an
 * importing test does not start a supervisor.
 */
const invocation = `
/* ── run ─────────────────────────────────────────────────────────────────────────────────── */
const __isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? '').href
  } catch {
    return false
  }
})()
if (__isMain) {
  main().then((code) => { process.exitCode = code }).catch((error) => {
    process.stderr.write('[harness] 致命错误：' + String((error && error.stack) || error) + '\\n')
    process.exitCode = 1
  })
}
`

const needsPathUrl = !/import\s*\{[^}]*pathToFileURL[^}]*\}\s*from\s*'node:url'/u.test(nodeHeader)
const finalHeader = needsPathUrl ? `${nodeHeader}\nimport { pathToFileURL } from 'node:url'` : nodeHeader
const output = `${SHEBANG}\n${BANNER}${finalHeader}\n\n${stripped.join('\n\n')}\n${invocation}`

mkdirSync(outDir, { recursive: true })
const target = join(outDir, 'harness.js')
writeFileSync(target, output, 'utf8')
process.stdout.write(
  `built dist/harness.js (${Buffer.byteLength(output)} bytes, ${names.length} inlined module(s): ${names.join(', ')})\n` +
    `run it with: node dist/harness.js --help\n`,
)
