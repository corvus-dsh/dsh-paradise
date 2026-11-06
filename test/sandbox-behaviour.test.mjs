/**
 * SANDBOX BEHAVIOUR — the tests that were missing.
 *
 * The sandbox in `adapters/raw/sandbox.ts` claims three things:
 *
 *   1. a synchronous infinite loop can be KILLED from outside (not merely raced)
 *   2. a path outside the allowlist is refused BEFORE the tool touches it
 *   3. a crashing tool does not take the harness down
 *
 * Before this file, only the CLI's `--sandbox-root` parsing had a test. A capability tested
 * only where it is CONFIGURED is a capability nobody has verified — and this one exists to
 * contain code a model wrote, so "it compiles" is not evidence.
 *
 * These go through the PUBLIC factory (`createRawToolFactory`) rather than importing
 * `sandbox.ts` directly: `runInSandbox` is internal to the bundle, and testing the seam a
 * caller actually uses is worth more than testing an internal.
 *
 * THE TOOL'S API NAME IS `api`, AND THAT IS THE POINT
 *
 * The worker bootstrap compiles the body with `new Function('api', 'require', 'process', …)`
 * — so `api.readFile` exists and `require`/`process` are parameters bound to undefined. The
 * first version of this file guessed `globalThis.__sandbox.fs`; the tool then failed with
 * "Cannot read properties of undefined", which is the SHADOWING WORKING, not a bug.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const layer = await import(new URL('../index.js', import.meta.url).href)

function sandboxDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-sandbox-test-'))
}

function sandboxedFactory(roots, timeoutMs) {
  return layer.createRawToolFactory({ sandboxRoots: roots, timeoutMs })
}

test('sandbox: a sandboxed factory reports isolation "process", not "none"', () => {
  const root = sandboxDir()
  const factory = sandboxedFactory([root], 5000)
  assert.equal(factory.isolation, 'process', 'a caller reading isolation must be told the truth')
  rmSync(root, { recursive: true, force: true })
})

test('sandbox: a tool that returns a value does so through the worker boundary', async () => {
  const root = sandboxDir()
  const factory = sandboxedFactory([root], 5000)
  const defined = await factory.define({ name: 'double-it', source: '({ execute: async (a) => ({ doubled: a.n * 2 }) })' })
  assert.equal(defined.ok, true, JSON.stringify(defined.error))
  const result = await factory.execute('double-it', { n: 21 })
  assert.equal(result.isError, false, JSON.stringify(result.error))
  assert.deepEqual(result.value, { doubled: 42 })
  rmSync(root, { recursive: true, force: true })
})

test('sandbox: a SYNCHRONOUS infinite loop is KILLED, not merely raced', async () => {
  const root = sandboxDir()
  const factory = sandboxedFactory([root], 300)
  const defined = await factory.define({ name: 'hang-it', source: '({ execute: () => { while (true) {} } })' })
  assert.equal(defined.ok, true, 'a hung definition is legal; only EXECUTION must be stopped')
  const started = Date.now()
  /**
   * `while (true) {}` never yields, so `Promise.race` would unblock the caller while the
   * thread kept burning CPU forever. Only `worker.terminate()` ends it.
   */
  const result = await factory.execute('hang-it', {})
  const elapsed = Date.now() - started
  assert.equal(result.isError, true, 'a hung tool must not report success')
  assert.match(String(result.error?.message ?? ''), /超时|timeout|未返回|终止|terminat/iu)
  assert.ok(elapsed < 10_000, `the killer must fire near the budget, took ${elapsed}ms`)
  rmSync(root, { recursive: true, force: true })
})

test('sandbox: a path outside the allowlist is REFUSED', async () => {
  const root = sandboxDir()
  const outside = join(tmpdir(), `dsh-outside-${Date.now()}.txt`)
  writeFileSync(outside, 'secret', 'utf8')
  const factory = sandboxedFactory([root], 5000)
  /**
   * The tool asks to read a file that really exists and that it was never granted. The
   * refusal must come from the bootstrap's allowlist, so the handle is never opened.
   */
  const defined = await factory.define({
    name: 'read-outside',
    source: `({ execute: () => api.readFile(${JSON.stringify(outside)}) })`,
  })
  assert.equal(defined.ok, true)
  const result = await factory.execute('read-outside', {})
  assert.equal(result.isError, true, 'reading outside the roots must fail')
  assert.match(String(result.error?.message ?? ''), /允许|allow|拒绝|outside|permission|范围/iu)
  rmSync(root, { recursive: true, force: true })
  try {
    rmSync(outside, { force: true })
  } catch {
    /* best effort */
  }
})

test('sandbox: a path INSIDE the allowlist is readable (the gate is not simply closed)', async () => {
  const root = sandboxDir()
  const inside = join(root, 'readable.txt')
  writeFileSync(inside, 'hello-sandbox', 'utf8')
  const factory = sandboxedFactory([root], 5000)
  const defined = await factory.define({
    name: 'read-inside',
    source: `({ execute: () => api.readFile(${JSON.stringify(inside)}) })`,
  })
  assert.equal(defined.ok, true)
  const result = await factory.execute('read-inside', {})
  assert.equal(result.isError, false, JSON.stringify(result.error))
  assert.equal(result.value, 'hello-sandbox')
  rmSync(root, { recursive: true, force: true })
})

test('sandbox: a tool that throws reports an error instead of killing the host', async () => {
  const root = sandboxDir()
  const factory = sandboxedFactory([root], 5000)
  const defined = await factory.define({ name: 'thrower', source: '({ execute: () => { throw new Error("boom") } })' })
  assert.equal(defined.ok, true)
  const result = await factory.execute('thrower', {})
  assert.equal(result.isError, true)
  assert.match(String(result.error?.message ?? ''), /boom/u)
  rmSync(root, { recursive: true, force: true })
})

test('sandbox: an empty root list does not silently mean "unrestricted"', () => {
  /**
   * The dangerous reading of `roots: []` is "no restrictions"; the correct reading is "never
   * configured". A factory built with an empty list must therefore report `none` rather than
   * claiming isolation it does not have.
   */
  const factory = layer.createRawToolFactory({ sandboxRoots: [], timeoutMs: 3000 })
  assert.equal(factory.isolation, 'none', 'an unconfigured sandbox must not claim to be one')
})
