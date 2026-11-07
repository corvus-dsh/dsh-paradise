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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs'
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

/**
 * ── AUDIT A1: A LINK INSIDE THE ROOT IS NOT INSIDE THE ROOT ─────────────────────────────────────
 *
 * WHY THIS TEST EXISTS. The allowlist used to compare `path.resolve(target)` with the roots.
 * `path.resolve` is LEXICAL: it collapses `.` and `..`, and it does NOT resolve symlinks or Windows
 * directory junctions. So the predicate answered "does this path STRING start with a root" instead
 * of "is this FILE inside a root".
 *
 * Measured consequence, before the fix: a junction created inside the root pointing outside it
 * (a plain `mklink /J`, no admin needed) let `api.readFile` / `api.listDir` / `api.writeFile`
 * reach files outside the allowlist — while the direct path, the `..` traversal and the case
 * variants were all correctly DENIED. That contrast is what identified the defect: lexical
 * normalization handles `..`; only real-path resolution handles links.
 *
 * WHY IT MATTERS. The default roots include the user's HOME directory, and a home directory often
 * already contains a junction to elsewhere. The code this sandbox runs is MODEL-GENERATED repair
 * code. Reading `~/.ssh/id_rsa` or `.aws/credentials` through a pre-existing link needs nothing
 * from an attacker beyond a poisoned context.
 *
 * THIS TEST IS SKIPPED WHEN THE PLATFORM REFUSES TO CREATE A LINK, and it says so. A silently
 * skipped security test is worse than a present one that cannot run: the second is visible.
 */
test('audit A1: a junction pointing OUTSIDE the allowlist is refused, while real paths still work', async (t) => {
  const base = sandboxDir()
  const root = join(base, 'root')
  const outside = join(base, 'outside')
  mkdirSync(root, { recursive: true })
  mkdirSync(outside, { recursive: true })

  const outsideSecret = join(outside, 'secret.txt')
  const outsidePwned = join(outside, 'pwned.txt')
  const insideFile = join(root, 'inside.txt')
  writeFileSync(outsideSecret, 'TOP-SECRET-OUTSIDE', 'utf8')
  writeFileSync(insideFile, 'INSIDE-LEGIT', 'utf8')

  const link = join(root, 'escape-link')
  let linked = true
  try {
    symlinkSync(outside, link, 'junction')
  } catch {
    linked = false
  }
  if (!linked) {
    t.skip('this platform refused to create a directory link; A1 cannot be exercised here')
    rmSync(base, { recursive: true, force: true })
    return
  }

  const factory = sandboxedFactory([root], 5000)

  const define = async (name, body) => {
    const defined = await factory.define({
      name,
      source: `({ execute: async () => { ${body} } })`,
    })
    assert.equal(defined.ok, true, `${name}: ${defined.error?.message ?? ''}`)
    return factory.execute(name, {})
  }

  // ── THE ATTACK: through the link, in all three verbs ──
  const readThrough = await define('a1-read-link', `return api.readFile(${JSON.stringify(join(link, 'secret.txt'))})`)
  assert.equal(readThrough.isError, true, 'reading through a link must be DENIED')
  assert.equal(readThrough.error?.code, 'SANDBOX_DENIED')
  assert.equal(
    String(readThrough.error?.message ?? '').includes('TOP-SECRET-OUTSIDE'),
    false,
    'the refusal must not echo the secret it refused',
  )

  const listThrough = await define('a1-list-link', `return api.listDir(${JSON.stringify(link)})`)
  assert.equal(listThrough.isError, true, 'listing through a link must be DENIED')

  const writeThrough = await define(
    'a1-write-link',
    `api.writeFile(${JSON.stringify(join(link, 'pwned.txt'))}, "PWNED"); return "wrote"`,
  )
  assert.equal(writeThrough.isError, true, 'writing through a link must be DENIED')
  assert.equal(existsSync(outsidePwned), false, 'the outside file must NOT have been created')

  // ── THE CONTROLS: the fix must not turn the allowlist into a wall ──
  const readInside = await define('a1-read-inside', `return api.readFile(${JSON.stringify(insideFile)})`)
  assert.equal(readInside.isError, false, JSON.stringify(readInside.error))
  assert.equal(readInside.value, 'INSIDE-LEGIT', 'a real path inside the root must still be readable')

  const insideOk = join(root, 'ok.txt')
  const writeInside = await define('a1-write-inside', `api.writeFile(${JSON.stringify(insideOk)}, "fine"); return "wrote"`)
  assert.equal(writeInside.isError, false, JSON.stringify(writeInside.error))
  assert.equal(existsSync(insideOk), true, 'writing a new file inside the root must still work')

  // And a plain `..` traversal must STILL be denied, so the fix did not trade one hole for another.
  const traversal = await define('a1-traversal', `return api.readFile(${JSON.stringify(join(root, '..', 'outside', 'secret.txt'))})`)
  assert.equal(traversal.isError, true, 'traversal must remain denied')

  assert.equal(existsSync(outsideSecret), true, 'the outside secret must still be where the attacker left it')
  rmSync(base, { recursive: true, force: true })
})

/**
 * ── AUDIT ROUND 3: THE ONE-LINE ESCAPE IS DEAD, AND `globalThis` NO LONGER LEAKS ────────────────
 *
 * THE MEASURED BREACH this pins. The old bootstrap compiled the tool body with
 * `new Function('api','require',…)`. Shadowing those names worked — `typeof require` really was
 * `undefined` inside the body — but the REAL `Function` constructor was still reachable through the
 * global object, and a function built with it declares its own parameters (none of ours):
 *
 *     const R = (function(){}).constructor('return require')()
 *     R('node:fs').readFileSync('<outside the allowlist>')   -> returned the contents
 *     R('node:fs').writeFileSync('<outside the allowlist>')  -> WROTE the file
 *     R('node:child_process').execSync                        -> available
 *
 * …while `api.readFile` on the SAME path was correctly refused. So the allowlist was never the weak
 * part — the compiler was, and one line defeated it.
 *
 * WHAT CHANGED. The body now runs in a `vm` context created with
 * `codeGeneration: { strings: false, wasm: false }`, so no code string can be compiled from inside.
 * Measured after the change: the constructor call throws "Code generation from strings disallowed
 * for this context", an attempted read/write outside the allowlist fails, and — a bonus the fix did
 * not promise — `globalThis.process` is now `undefined` too, because the context has its own clean
 * global object rather than the worker's.
 *
 * WHAT IS STILL TRUE, AND WHY THE ASSERTIONS DO NOT OVERCLAIM: `node:vm` is documented as NOT a
 * security mechanism. These tests assert that the CHEAP escape is gone and the allowlist still works
 * in both directions. They do not assert that the sandbox is a container, because it is not.
 */
test('audit round 3: code generation is DISALLOWED inside the tool, so the constructor escape is dead', async () => {
  const root = sandboxDir()
  const outside = join(root, '..', `outside-${Date.now().toString(36)}`)
  mkdirSync(outside, { recursive: true })
  const secret = join(outside, 'secret.txt')
  const pwned = join(outside, 'pwned.txt')
  writeFileSync(secret, 'HOST-SECRET', 'utf8')

  const factory = sandboxedFactory([root], 8000)
  const define = async (name, body) => {
    const defined = await factory.define({
      name,
      source: `({ execute: async (args) => { ${body} } })`,
    })
    assert.equal(defined.ok, true, `${name}: ${defined.error?.message ?? ''}`)
    return factory.execute(name, { path: secret, target: pwned })
  }

  // 1. The global object no longer even carries the host's `process` (stronger than before).
  const directProcess = await define('r3-direct-process', 'return typeof process')
  assert.equal(directProcess.value, 'undefined', '`process` is not a parameter, and must not leak in')

  const viaGlobal = await define('r3-global-process', 'return typeof (globalThis && globalThis.process)')
  assert.equal(
    viaGlobal.value,
    'undefined',
    'globalThis must not carry the host process — the vm context has its own clean global',
  )

  // 2. THE ESCAPE ITSELF MUST THROW, not merely fail to be useful.
  const ctor = await define(
    'r3-ctor',
    "const R = (function(){}).constructor('return require')(); return typeof R",
  )
  assert.equal(ctor.isError, true, 'building a function from a string must be REFUSED')
  assert.match(
    String(ctor.error?.message ?? ''),
    /code generation|disallowed/iu,
    'and the refusal must be the code-generation block, not an unrelated error',
  )

  // 3. Reading outside the allowlist through the (now impossible) recovery path must not work.
  const readOutside = await define(
    'r3-read-outside',
    "const R = (function(){}).constructor('return require')(); return R('node:fs').readFileSync(args.path, 'utf8')",
  )
  assert.equal(readOutside.isError, true, 'the recovered-require path must not read outside')

  // 4. Writing outside must not work either — the assertion that actually matters.
  const writeOutside = await define(
    'r3-write-outside',
    "const R = (function(){}).constructor('return require')(); R('node:fs').writeFileSync(args.target, 'PWNED'); return 'wrote'",
  )
  assert.equal(writeOutside.isError, true, 'the recovered-require path must not write outside')
  assert.equal(existsSync(pwned), false, 'no file may appear outside the allowlist')

  // 5. THE CONTROLS: the allowlist still refuses `api.*` outside, and still allows inside.
  const apiOutside = await define('r3-api-outside', 'return api.readFile(args.path)')
  assert.equal(apiOutside.isError, true, 'api.* outside the allowlist must still be denied')
  assert.equal(apiOutside.error?.code, 'SANDBOX_DENIED')

  const apiInside = await define('r3-api-inside', 'return "inside-ok"')
  assert.equal(apiInside.isError, false, 'the sandbox must still run ordinary tools')

  rmSync(outside, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})