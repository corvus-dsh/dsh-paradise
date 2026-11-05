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
   * may export VALUES, and only `bindHost` / `isParadiseHost` / `ProtocolError`.
   */
  const indexSource = readFileSync(join(protocolDir, 'index.ts'), 'utf8')
  const valueExports = [...indexSource.matchAll(/^export (?:class|function|const) (\w+)/gmu)].map((match) => match[1])
  assert.deepEqual(valueExports.sort(), ['ProtocolError', 'bindHost', 'isParadiseHost'])
})
