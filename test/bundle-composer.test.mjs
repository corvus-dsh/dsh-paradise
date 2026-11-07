/**
 * THE BUNDLE COMPOSER — the rule that broke the CLI must stay broken-proof.
 *
 * THE INCIDENT
 *
 * A multi-line `export { … }` list becomes a BLOCK STATEMENT when only the `export` keyword is
 * stripped. Its trailing `}` then closes a brace nothing opened, and the artifact fails at
 * `import()` time — not at build time, because the composer's guard only looked for surviving
 * relative specifiers.
 *
 * TWO SUCCESSIVE WRONG FIXES
 *
 *   1. Strip the whole list with `^export\s*\{[^}]*\}`. `[^}]*` stops at the FIRST `}` — and
 *      this package's real export block contains JSDoc with braces in it:
 *          export {
 *            createDshAdapters,
 *            … JSDoc mentioning createDshAdapters(ctx) …
 *            createDshAdapters as createAdapters,
 *          }
 *      The regex amputated a fragment and left a stray brace. `dist/harness.js` died with
 *      `Unexpected token '}'`.
 *
 *   2. Fix it in `bundle.mjs` only. `build-harness.mjs` has its OWN `inline()` and kept the naive
 *      `replace(/^export\s+/gmu, '')`, so the CLI stayed broken after the plugin bundle was fixed.
 *
 * The tests below pin BOTH lessons: the scanner must ignore braces in comments and strings, and
 * the two builders must share one implementation rather than keeping two copies that can drift.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const { dropBareReExportLists } = await import(new URL('../scripts/bundle.mjs', import.meta.url).href)

test('composer: an export list is removed whole, even with braces inside its JSDoc', () => {
  const source = [
    'export {',
    '  createDshAdapters,',
    '  /**',
    '   * prose: `createDshAdapters(ctx)` in its interface — braces } { inside a comment',
    '   */',
    '  createDshAdapters as createAdapters,',
    '}',
    'const after = 1',
  ].join('\n')
  const out = dropBareReExportLists(source)
  assert.equal(/\bcreateDshAdapters,\s*$/mu.test(out), false, 'the list is gone')
  assert.equal(out.includes('}'), false, 'no stray brace survives')
  assert.match(out, /const after = 1/u, 'code after the list is kept')
})

test('composer: braces in a STRING do not end the list early', () => {
  const source = ['export {', '  a,', "  b as c,", '}', 'const s = "{ not a brace }"', 'const t = 2'].join('\n')
  const out = dropBareReExportLists(source)
  assert.match(out, /const s = "\{ not a brace \}"/u, 'the string literal is untouched')
  assert.match(out, /const t = 2/u)
})

test('composer: a template literal with braces does not break the scan', () => {
  const source = ['export {', '  a,', '}', 'const tpl = `x ${1 + 2} y`', 'const n = 3'].join('\n')
  const out = dropBareReExportLists(source)
  assert.match(out, /const tpl = `x \$\{1 \+ 2\} y`/u)
  assert.match(out, /const n = 3/u)
})

test('composer: `export const x = { … }` is NOT a re-export list and survives', () => {
  const source = ['export const table = { a: 1, b: 2 }', 'export function f() { return 1 }'].join('\n')
  const out = dropBareReExportLists(source)
  assert.match(out, /export const table = \{ a: 1, b: 2 \}/u, 'a value export is not touched')
  assert.match(out, /export function f\(\) \{ return 1 \}/u)
})

test('composer: several lists in one file are each removed', () => {
  const source = ['export { a }', 'const mid = 1', 'export {', '  b,', '}', 'const end = 2'].join('\n')
  const out = dropBareReExportLists(source)
  assert.match(out, /const mid = 1/u)
  assert.match(out, /const end = 2/u)
  assert.equal(out.includes('export {'), false)
})

test('composer: BOTH builders share one implementation, not two copies', () => {
  /**
   * The second wrong fix was fixing only one builder. This asserts the fix is shared, so a future
   * edit to the rule cannot silently leave the CLI on the old path.
   */
  const harness = readFileSync(join(root, 'scripts', 'build-harness.mjs'), 'utf8')
  assert.match(harness, /dropBareReExportLists/u, 'build-harness must import the shared helper')
  assert.match(harness, /from '\.\/bundle\.mjs'/u)
  /**
   * And it must NOT still contain the naive strip that caused the bug. The pattern is checked in a
   * shape that cannot match inside a comment: a bare `code.replace(/^export\s+/` call site.
   */
  assert.equal(
    /code\.replace\(\/\^export\\s\+\/gmu/u.test(harness),
    false,
    'the naive export strip must be gone from the CLI builder',
  )
})

test('composer: the shipped artifacts actually parse', () => {
  /**
   * The end-to-end assertion. Every unit test above can pass while the composer still emits a file
   * that Node refuses — this is the check that would have caught both incidents directly.
   *
   * `node --check` IS THE RIGHT TOOL, and `new Function` is not: these files are ES MODULES, and
   * `new Function` parses a script body, so a legal `export` throws "Unexpected token 'export'".
   * My first version used `new Function` and produced exactly that false alarm — the same class of
   * mistake as reading a file with the wrong parser, which is what caused the original bug.
   */
  const files = ['index.js', 'dist/harness.js', 'dist/harness-server.js', 'dist/watchdog.js']
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', join(root, file)], { encoding: 'utf8' })
    assert.equal(result.status, 0, `${file} must parse:\n${result.stderr}`)
  }
})
