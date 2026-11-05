#!/usr/bin/env node
/**
 * PREFLIGHT — run this BEFORE restarting the host.
 *
 * WHY THIS EXISTS
 *
 * Every test in this package imports `index.js`, which proves the BEHAVIOUR but not the ARTIFACT.
 * A stale build, a relative import that only fails at load, a BOM, or a version drift between
 * `index.js` / `package.json` / `manifest.json` would all ship a layer that the Loader refuses — and
 * the symptom (the whole entry does not activate, taking its dependents with it) reads nothing like
 * the cause.
 *
 * This layer has TWO extra hazards the plugins do not:
 *
 *   1. it is IMPORTED, not just mounted — so the artifact is imported here in a clean process;
 *   2. it now carries a HOST-NEUTRAL PROTOCOL — and the whole point of that protocol collapses if a
 *      host name leaks into it. So `src/protocol/` is scanned from the SHIPPED FILE, not just from
 *      the sources a test already covers.
 *
 * Exit 0 = safe to restart.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const checked = []
const fail = (message) => problems.push(message)
const ok = (message) => checked.push(message)

/* ── 1. version agreement across the three carriers ──────────────────────── */
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
const bundle = readFileSync(join(root, 'index.js'), 'utf8')

const bundleVersion = /export const VERSION = '([^']+)'/u.exec(bundle)?.[1] ?? '(none)'
if (pkg.version !== manifest.version) fail(`package.json ${pkg.version} ≠ manifest.json ${manifest.version}`)
else ok(`version agreement: ${pkg.version}`)
if (bundleVersion !== pkg.version) fail(`index.js VERSION '${bundleVersion}' ≠ package.json ${pkg.version} — rebuild`)
else ok(`built bundle carries VERSION ${bundleVersion}`)

/* ── 2. byte-level hazards the Loader rejects ────────────────────────────── */
for (const file of ['package.json', 'manifest.json', 'index.js']) {
  const bytes = readFileSync(join(root, file))
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail(`${file} starts with a UTF-8 BOM — the entry reports 包不可用`)
}
ok('no UTF-8 BOM in the shipped files')

/* ── 3. a surviving relative import fails at IMPORT time, not at build ───── */
const relativeImport = bundle
  .split('\n')
  .findIndex((line) => /from\s*'\.\.?\//u.test(line) && !line.trimStart().startsWith('//'))
if (relativeImport >= 0) fail(`index.js line ${relativeImport + 1} has an unresolved relative import`)
else ok('no unresolved relative import in index.js')

/* ── 4. the bundle must be a FRESH composition ───────────────────────────── */
const { composeBundle } = await import('./bundle.mjs')
const fresh = composeBundle(root).output
if (fresh !== bundle) fail('index.js differs from a fresh build — run `node scripts/build.mjs`')
else ok(`index.js is byte-identical to a fresh build (${Buffer.byteLength(bundle)} bytes)`)

/* ── 5. THE PROTOCOL MUST REACH THE ARTIFACT UNCONTAMINATED ──────────────── */
/**
 * THE ONE CHECK THIS PACKAGE CANNOT SKIP.
 *
 * `test/protocol-purity.test.mjs` scans the SOURCES. That is not the same as scanning what ships:
 * a host name can enter the bundle from a re-export, from a shared helper the protocol imports, or
 * from the composer inlining a module in the wrong place. So the protocol's own declarations are
 * located IN THE ARTIFACT and checked there.
 *
 * The declarations are delimited by the protocol's file banner comment, which survives inlining.
 */
const protocolMarkers = ['protocol/types.ts', 'protocol/adapters.ts', 'protocol/index.ts']
const inlined = /Inlined modules \(dependency order\): ([^\n]+)/u.exec(bundle)?.[1] ?? ''
for (const marker of protocolMarkers) {
  if (!inlined.includes(marker)) fail(`the protocol module ${marker} is NOT in the bundle — did the barrel stop importing it?`)
}
if (protocolMarkers.every((marker) => inlined.includes(marker))) {
  ok(`all ${protocolMarkers.length} protocol modules are inlined`)
}

/**
 * Scan the protocol's own slice of the artifact.
 *
 * HOW THE REGION IS LOCATED, AND WHY NOT BY TYPE NAMES: the inliner strips TypeScript types entirely,
 * so `interface SessionRef` does not survive — it is a type, and types do not exist at runtime. The
 * protocol's BANNER COMMENTS do survive, and they are unique to those modules. So the region is
 * bookended by its first module banner and the protocol barrel's error class, and everything between
 * is protocol text where no host word may appear.
 */
const anchors = ['PARADISE PROTOCOL', 'SESSION ADAPTER', 'STORAGE ADAPTER', 'TOOL ADAPTER']
const hostWordInArtifact = (() => {
  const present = anchors.filter((anchor) => bundle.includes(anchor))
  if (present.length !== anchors.length) {
    fail(
      `protocol banners missing from the artifact (${present.length}/${anchors.length}): ` +
        anchors.filter((a) => !bundle.includes(a)).join(', '),
    )
    return false
  }
  const from = bundle.indexOf('PARADISE PROTOCOL')
  const tail = bundle.indexOf('class ProtocolError')
  if (from < 0 || tail <= from) {
    fail('could not delimit the protocol region inside index.js')
    return false
  }
  const region = bundle.slice(from, tail)
  const offenders = [/dsh/iu, /cordis/iu].filter((pattern) => pattern.test(region))
  if (offenders.length > 0) {
    fail(`the SHIPPED protocol region names a host (${offenders.map(String).join(', ')})`)
    return false
  }
  return true
})()
if (hostWordInArtifact) ok('the shipped protocol region names no host (checked in the artifact, not only in src/)')

/* ── 6. it must IMPORT, and expose the surface its dependents call ───────── */
/**
 * FIRST THE CLASS OF BUG THAT SHIPPED ONCE: two modules declaring the same top-level name.
 *
 * The bundle inlines every module into ONE scope, so `const DEFAULT_TTL_MS` in two files is a
 * SyntaxError in the artifact — and the BUILD cannot see it, because building never loads what it
 * writes. The composer already refuses an unresolved relative import; this refuses a duplicate
 * identifier, which is the sibling failure and is equally release-blocking. It went unnoticed because
 * the colliding module was only reached through a DYNAMIC import (a plugin resolving the lease), so no
 * test that ran the package's own entry point touched it.
 */
const topLevelDecl = /^(?:export\s+)?(?:const|let|var|function|async\s+function|class)\s+([A-Za-z_$][\w$]*)/gmu
const declaredAt = new Map()
const duplicateNames = []
bundle.split('\n').forEach((line, index) => {
  const match = topLevelDecl.exec(line)
  topLevelDecl.lastIndex = 0
  if (match === null) return
  const name = match[1]
  const first = declaredAt.get(name)
  if (first === undefined) declaredAt.set(name, index + 1)
  else duplicateNames.push(`${name} (行 ${first} 与 行 ${index + 1})`)
})
if (duplicateNames.length > 0) {
  fail(
    `index.js declares the same top-level identifier twice — the bundled file cannot load: ${duplicateNames.join(', ')}`,
  )
} else {
  ok(`no duplicate top-level identifier across ${declaredAt.size} declarations`)
}

try {
  const mod = await import(new URL('../index.js', import.meta.url))
  if (typeof mod.activate !== 'function') fail('index.js does not export `activate` — the Loader looks for it')
  else if (typeof mod.apply !== 'function') fail('index.js does not export `apply`')
  else ok('index.js exports activate + apply')

  /**
   * THE DEPENDENT CONTRACT. `dsh-observer` calls exactly these, so a rename here is a break there.
   */
  const REQUIRED = [
    'readDiskEvents',
    'readDiskEventTypes',
    'sessionLogPath',
    'escapeSessionDirName',
    'probeCapabilities',
    'ParadiseError',
    'ParadiseUnavailableError',
    /* the protocol, for any future adapter */
    'bindHost',
    'isParadiseHost',
    'ProtocolError',
    'createMemoryHost',
    'createDshAdapters',
    /* the write machinery, reachable so a plugin's own rollback can use it */
    'deleteSession',
    /**
     * v0.4: THE CONCURRENCY FOUNDATION.
     *
     * Checked in the backstop rather than only in a test, because a plugin adopting the lease needs all
     * of these and each has a silent failure mode: a missing `withLease` leaves callers hand-rolling
     * acquire/release (and leaking on a throw), and a missing `LEASE_RELEASE` turns every release into
     * a no-op write — a lock that is never given up, which reads as "someone else holds it" forever.
     */
    'createStorageLeaseAdapter',
    'withLease',
    'LEASE_RELEASE',
    'isLeaseExpired',
  ]
  const missing = REQUIRED.filter((name) => mod[name] === undefined)
  if (missing.length > 0) fail(`index.js is missing dependent-facing export(s): ${missing.join(', ')}`)
  else ok(`${REQUIRED.length} dependent-facing exports present`)
  if (mod.paradiseInternals === undefined) fail("test seam 'paradiseInternals' missing from the bundle")
  else ok('test seam paradiseInternals present')

  /* The reference host must build in the SHIPPED copy: it is the proof the protocol is implementable. */
  const memory = mod.createMemoryHost()
  if (mod.isParadiseHost(memory) !== true) fail('the shipped reference host does not satisfy isParadiseHost')
  else ok('the shipped reference host satisfies the protocol')
} catch (error) {
  fail(`importing index.js threw: ${String(error?.message ?? error)}`)
}

/* ── 7. the write layer must be REACHABLE, and must still refuse honestly ── */
/**
 * TWO CHECKS, BECAUSE BOTH HALVES CAN REGRESS IN OPPOSITE DIRECTIONS.
 *
 *   - the machinery must exist in the artifact (a refactor that drops `deleteSession` from the barrel
 *     silently breaks every plugin's rollback);
 *   - the two refusal paths must still be present. `writeNotImplemented` guards the still-unbuilt P3
 *     pieces, and `NOT_WIRED` guards the verbs that are unavailable on a given host PROFILE — a quiet
 *     success in either place is the false-success pattern this package removes.
 */
if (/writeNotImplemented|NOT_IMPLEMENTED/u.test(bundle)) ok('the P3 contract still refuses with NOT_IMPLEMENTED')
else fail('the P3 write contract no longer refuses — an unimplemented path that returns ok:true is a false success')

if (/NOT_WIRED/u.test(bundle)) ok('an unavailable verb still refuses with NOT_WIRED (profile-dependent)')
else fail('the profile-dependent refusal is gone — a missing capability would now look like a quiet success')

/* ── 8. the host adapter must still confess what it cannot do ────────────── */

console.log('PREFLIGHT — dsh-paradise\n')
for (const line of checked) console.log(`  OK   ${line}`)
if (problems.length > 0) {
  console.log('')
  for (const line of problems) console.log(`  FAIL ${line}`)
  console.log(`\n${problems.length} problem(s). DO NOT RESTART until they are fixed.`)
  process.exitCode = 1
} else {
  console.log('\nAll checks passed. Safe to restart the host.')
}
