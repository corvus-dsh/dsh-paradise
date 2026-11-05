/**
 * dsh-paradise — PACKAGE CONTRACT (no BOM, versions agree, the patch is insertable).
 *
 * Written from the same incident as the observer's copy: editing a JSON file with PowerShell's
 * `Set-Content -Encoding UTF8` writes a BOM, the Loader's `JSON.parse` fails, and the Plugins page
 * shows 「异常 · 包不可用」 while the code is perfectly fine. A BOM is invisible in every editor that
 * tolerates it, so it has to be asserted.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => readFileSync(join(root, file), 'utf8')

for (const file of ['package.json', 'manifest.json']) {
  test(`${file}: no UTF-8 BOM (a BOM makes the entry report 包不可用)`, () => {
    const bytes = readFileSync(join(root, file))
    assert.equal(
      bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
      false,
      `${file} starts with EF BB BF — rewrite it without a BOM`,
    )
  })

  test(`${file}: parses as JSON`, () => {
    assert.doesNotThrow(() => JSON.parse(read(file)), `${file} must be valid JSON or the plugin cannot load`)
  })
}

test('package.json declares the dsh.bundle patch the Loader looks for', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'index.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml', 'without dsh.bundle the bundle entry never loads')
  assert.equal(pkg.scripts.build, 'node scripts/build.mjs')
  assert.ok(pkg.engines.dsh, 'the host range is declared')
})

test('manifest and package agree on version, entry and activation', () => {
  const pkg = JSON.parse(read('package.json'))
  const manifest = JSON.parse(read('manifest.json'))
  assert.equal(pkg.version, manifest.version, 'the two versions drifted apart')
  assert.equal(manifest.entry, 'index.js')
  assert.match(manifest.activate, /^activate\(/u)
})

test('the patch inserts exactly one row, with no config', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /^- insert:/mu)
  assert.match(patch, /id: dsh-paradise/u)
  assert.equal(patch.includes('config:'), false, 'the layer takes no config at P1')
})

test('the layer declares NO services and NO tools — it is a library', () => {
  const manifest = JSON.parse(read('manifest.json'))
  assert.deepEqual(manifest.services, [], 'declaring inject would make a read-only profile refuse to activate')
  assert.deepEqual(manifest.tools, [], 'it registers nothing')
  const bundle = read('index.js')
  assert.equal(/ctx\.tools\?\.register\(/u.test(bundle), false, 'and nothing in the code registers a tool')
})
