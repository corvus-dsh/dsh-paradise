/**
 * THE PURITY GATE — `src/protocol/` must not name a host.
 *
 * THE REQUIREMENT, IN THE USER'S WORDS
 *
 *   「这套 Interface 里，绝对不能出现任何带有 dsh 或 cordis 字样或特性的类型定义。」
 *
 * A rule that lives only in a comment is a rule that survives until the first hurried edit. So the
 * check is mechanical, it scans COMMENTS TOO (a comment that says "on dsh this is a turn/step pair"
 * has already taught the next reader the wrong abstraction), and it fails the suite.
 *
 * WHAT COUNTS AS A HOST WORD HERE
 *
 *   - the two names, case-insensitively, anywhere in the file;
 *   - the host's own vocabulary that leaked into earlier versions of this codebase: the surface
 *     operation concept, the turn/step pair, the projection whitelist.
 *
 * The second list is the interesting one: a reviewer can spot `dsh`, but nobody notices that
 * `surfaceOp` is a host concept smuggled into a "neutral" interface. That is exactly how the layer
 * being replaced would have drifted back in.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const protocolDir = join(root, 'src', 'protocol')

/** Host NAMES. Case-insensitive; a mention anywhere is a failure. */
const HOST_NAMES = [/dsh/iu, /cordis/iu]

/**
 * Host CONCEPTS.
 *
 * Each of these is a fact about one host's implementation that must never be expressible in a
 * protocol type. They are matched on word-ish boundaries so ordinary prose ("turning point") does
 * not trip them.
 */
const HOST_CONCEPTS = [
  { pattern: /surfaceOp/u, why: 'surface operations are one host rewriting rule' },
  { pattern: /\bturn\s*\/\s*step\b/iu, why: 'the turn/step pair is one host log shape' },
  { pattern: /\bturnStep\b/u, why: 'the turn/step pair is one host log shape' },
  { pattern: /sessionPersistence/u, why: 'a service name is a host implementation detail' },
  { pattern: /sessionController/u, why: 'a service name is a host implementation detail' },
  { pattern: /sessionQuery/u, why: 'a service name is a host implementation detail' },
  { pattern: /workspaceRegistry/u, why: 'a service name is a host implementation detail' },
  { pattern: /systemPrompt/u, why: 'a service name is a host implementation detail' },
  { pattern: /projectSessionConversation/u, why: 'a rendering function is one host internals' },
]

function protocolFiles() {
  return readdirSync(protocolDir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(protocolDir, name))
}

test('purity: the protocol directory has files to scan (the gate is not vacuous)', () => {
  const files = protocolFiles()
  assert.ok(files.length >= 3, `expected the protocol modules, found ${files.length}`)
})

for (const file of protocolFiles()) {
  const label = relative(root, file).replace(/\\/gu, '/')

  test(`purity: ${label} names no host`, () => {
    const source = readFileSync(file, 'utf8')
    const offenders = HOST_NAMES.filter((pattern) => pattern.test(source)).map((pattern) => String(pattern))
    assert.deepEqual(
      offenders,
      [],
      `${label} contains a host name (${offenders.join(', ')}). A protocol that names a host is that host's wrapper.`,
    )
  })

  test(`purity: ${label} expresses no host-specific concept`, () => {
    const source = readFileSync(file, 'utf8')
    const offenders = HOST_CONCEPTS.filter((entry) => entry.pattern.test(source)).map((entry) => entry.why)
    assert.deepEqual(
      offenders,
      [],
      `${label} leaks a host concept:\n  - ${offenders.join('\n  - ')}\n` +
        'The word is the tell: if the protocol can say it, every adapter must be able to mean it.',
    )
  })
}

test('purity: the protocol exports no value that could construct a host artifact', () => {
  /**
   * A protocol module exporting `buildTape`, `skeleton` or `fabricateTurnPair` would let a caller
   * depend on one host's writing shape while believing it depends on the interface. Only the barrel
   * may export VALUES, and only the ones on the allow-list below.
   *
   * ══ THE BLIND SPOT THIS TEST USED TO HAVE, AND WHY IT IS WORTH RECORDING ══
   *
   * The first version matched ONLY `^export const|function|class`. It therefore did not see
   *
   *     export { TRUST_ORDER } from './firewall.js'
   *
   * at all — a value export that went straight past the gate. The gate still PASSED, which is the worst
   * possible outcome: a check that cannot see the thing it exists to check.
   *
   * The pattern now also matches `export { a, b } from`, bare `export { a, b }`, and `export * `. A gate
   * with a hole is worse than no gate, because it certifies.
   */
  const indexSource = readFileSync(join(protocolDir, 'index.ts'), 'utf8')

  /** Plain JS — this file is `.mjs`, so no TypeScript annotations (the first version had one and would not parse). */
  const named = []
  /** `export const|let|function|class|enum NAME` */
  for (const decl of indexSource.matchAll(/^export\s+(?:const|let|function|class|enum)\s+(\w+)/gmu)) named.push(decl[1])
  /** `export { a, b as c }` and `export { a } from './x.js'` — the form that used to be invisible. */
  for (const group of indexSource.matchAll(/^export\s*\{([^}]*)\}(?:\s*from\s*['"][^'"]+['"])?/gmu)) {
    for (const part of group[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/u).pop()?.trim()
      if (name !== undefined && name.length > 0 && name !== 'type') named.push(name)
    }
  }
  /** `export * from './x.js'` would export an unknown set — refuse outright rather than guess. */
  assert.equal(/^export\s+\*/mu.test(indexSource), false, 'the protocol barrel must not star-export: the gate cannot enumerate what escapes')

  /**
   * THE ALLOW-LIST, with the reason each entry is permitted. A protocol that can carry a VALUE is a
   * protocol a caller can depend on at runtime; each one has to earn it.
   */
  const allowed = [
    'ProtocolError', // the protocol's own error: a class is needed to `instanceof` it
    'bindHost',      // the one function every caller uses to bind a host
    'isParadiseHost', // structural check, so a host can be validated without importing a class
    'LEASE_RELEASE', // a SENTINEL the lease contract requires callers to compare against
    'describeLease', // pure formatting of a lease record
    'isLeaseExpired', // pure predicate on a lease record
    'leaseOwnedBy',  // pure predicate on a lease record
    'planAcquire',   // pure decision function; no I/O, no host
    'planRelease',   // pure decision function
    'planRenew',     // pure decision function
    /**
     * `TRUST_ORDER` — the firewall's ordered trust scale.
     *
     * IS IT HARMLESS? It is a frozen map of five origin names to integers. It constructs nothing, touches
     * no host, and its whole purpose is to be COMPARED (`TRUST_ORDER[a] > TRUST_ORDER[b]`), which a
     * caller cannot do through a type. Permitted, and listed here so the decision is reviewable rather
     * than implied by a regex gap.
     */
    'TRUST_ORDER',
  ]
  const offenders = named.filter((name) => !allowed.includes(name))
  assert.deepEqual(
    offenders.sort(),
    [],
    'the protocol barrel exports a value outside the allow-list. If it is genuinely harmless, add it with a ' +
      'reason; if it can construct a host artifact, it belongs in an adapter.',
  )

  /** The check must not pass vacuously: the barrel does export values, and the gate sees them. */
  assert.ok(named.length >= 3, `the value-export scan found ${named.length} names — it may be broken`)
})
