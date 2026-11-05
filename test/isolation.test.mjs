/**
 * THE ISOLATION GATE — host specifics must not exist outside `src/adapters/<host>/`.
 *
 * THE REQUIREMENT, IN THE USER'S WORDS
 *
 *   「所有的 DSH 特有逻辑（骨架规则、Surface 限制、{turn:1,step:1} 伪造等），全部收敛进
 *     dsh-paradise/src/adapters/dsh/ 目录下。」
 *
 * `protocol-purity.test.mjs` already guards the protocol. This file guards the OTHER half of the same
 * claim: that host logic did not simply move NEXT DOOR. A protocol that is clean while the neutral
 * reader, the policy module and the error vocabulary all still speak one runtime's service names is
 * decoupled in name only.
 *
 * WHAT IS ACTUALLY FORBIDDEN, AND WHAT IS MERELY SUSPICIOUS
 *
 *   FORBIDDEN anywhere outside `src/adapters/<host>/`:
 *     - the runtime's service accessor names (they are implementation vocabulary);
 *     - the runtime's mount/lifecycle hook names;
 *     - the runtime's own product name inside CODE (a comment in the spec/README is documentation,
 *       which is allowed and necessary — see the note on this package's own name below).
 *
 *   ALLOWED, and deliberately so:
 *     - `dsh-paradise` as this PACKAGE's name (it is the package, not the host it adapts);
 *     - the `dsh` import/export prefixes in file paths under `scripts/` and `manifest`, which the
 *       Loader requires.
 *
 * The scan is over `src/` only, so documentation and scripts are out of scope by construction.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'src')

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

/** Files that are allowed to name one runtime: its own adapter directory. */
function isHostAdapterFile(file) {
  return relative(srcDir, file).replace(/\\/gu, '/').startsWith('adapters/')
}

/**
 * The runtime's implementation vocabulary.
 *
 * These are EXACT identifiers, matched as words: a substring match would flag `sessions` inside
 * "conversations" and produce a gate nobody trusts.
 */
const HOST_IDENTIFIERS = [
  'sessionPersistence',
  'sessionController',
  'sessionQuery',
  'workspaceRegistry',
  'systemPrompt',
  'discardPrepared',
  'resolveByPath',
]

const neutralFiles = () => walk(srcDir).filter((file) => !isHostAdapterFile(file))

test('isolation: there are neutral files to scan (the gate is not vacuous)', () => {
  const files = neutralFiles()
  assert.ok(files.length >= 5, `expected the neutral layer, found ${files.length} files`)
})

test('isolation: no neutral file names a host service', () => {
  const offenders = []
  for (const file of neutralFiles()) {
    const source = readFileSync(file, 'utf8')
    for (const identifier of HOST_IDENTIFIERS) {
      if (new RegExp(`\\b${identifier}\\b`, 'u').test(source)) {
        offenders.push(`${relative(root, file).replace(/\\/gu, '/')} → ${identifier}`)
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'host service names must exist only under src/adapters/<host>/:\n  ' + offenders.join('\n  '),
  )
})

test('isolation: the neutral reader takes a deriver instead of importing a layout', () => {
  /**
   * THIS IS THE SPECIFIC MOVE THAT MADE THE READER HOST-AGNOSTIC.
   *
   * `read/disk.ts` used to import `sessionLogPath` — a function that knows one host's directory
   * scheme. It now accepts `derivePath` as an option. If that option disappears, the reader has
   * silently re-coupled and the migration is undone even though every test still passes.
   */
  const source = readFileSync(join(srcDir, 'read', 'disk.ts'), 'utf8')
  assert.match(source, /derivePath/u, 'the reader must accept a path deriver')
  assert.match(source, /PathDeriver/u, 'and name its type')
  assert.equal(
    /from\s+'\.\.\/adapters\//u.test(source),
    false,
    'the neutral reader must not import an adapter',
  )
})

test('isolation: the neutral policy module holds no host constant', () => {
  const source = readFileSync(join(srcDir, 'policy.ts'), 'utf8')
  // The rendering whitelist and the message-type map are the host's facts and must live in the adapter.
  assert.equal(/RENDERED_CONVERSATION_TYPES/u.test(source), false, 'the render whitelist is a host fact')
  assert.equal(/MESSAGE_TYPE_FOR_INTENT/u.test(source), false, 'the type-per-intent map is a host fact')
  assert.equal(/session\.v4\.jsonl\.zstd/u.test(source), false, 'the log file name is a host fact')
})

test('isolation: the host adapter directory is where those facts actually live', () => {
  const policy = readFileSync(join(srcDir, 'adapters', 'dsh', 'policy.ts'), 'utf8')
  assert.match(policy, /RENDERED_CONVERSATION_TYPES/u)
  assert.match(policy, /MESSAGE_TYPE_FOR_INTENT/u)
  assert.match(policy, /session\.v4\.jsonl\.zstd/u)

  const paths = readFileSync(join(srcDir, 'adapters', 'dsh', 'paths.ts'), 'utf8')
  assert.match(paths, /escapeSessionDirName/u, 'the directory escaping is a host fact')
  assert.match(paths, /sessions/u, 'and so is the layout')
})

test('isolation: every host-specific file lives under adapters/', () => {
  /**
   * ENUMERATION, NOT INFERENCE: the directory tree IS the claim. If a future change adds
   * `src/host/…` or `src/publish/…` back, this fails and the reviewer sees it as a structural change
   * rather than as a diff buried in an import line.
   *
   * `lease.ts` / `lease-adapter.ts` (v0.4) are on this list DELIBERATELY, and the reason is the rule
   * itself: the lease names no host. It is written against `StorageAdapter` — the host-neutral contract
   * — and the SAME implementation serves the durable host and the in-memory one. It therefore belongs
   * beside `policy.ts` and `errors.ts` (layer-level, host-free code), not under a host directory. If it
   * ever needs a host import, this list is where the mistake becomes visible.
   */
  /**
   * `storage-memory.ts` / `storage-tiers.ts` (v0.4.2) are on this list for the SAME reason the lease files
   * are: they name no host. The memory driver is written against `StorageAdapter` — the host-neutral
   * contract — and is driven by whatever backing adapter the caller supplies, so it works over this
   * runtime's files AND over the in-memory reference host. `storage-tiers.ts` only chooses between two
   * protocol implementations.
   *
   * The guard below enforces that claim rather than trusting this comment.
   */
  const allowed = [
    'adapters',
    'protocol',
    'read',
    'write',
    'index.ts',
    'policy.ts',
    'errors.ts',
    'lease.ts',
    'lease-adapter.ts',
    'storage-memory.ts',
    'storage-tiers.ts',
  ]
  const top = readdirSync(srcDir, { withFileTypes: true }).map((entry) => entry.name)
  const unexpected = top.filter((name) => !allowed.includes(name))
  assert.deepEqual(
    unexpected,
    [],
    `unexpected top-level entries under src/: ${unexpected.join(', ')}. ` +
      'Host specifics belong under adapters/<host>/; nothing else should need a new directory.',
  )
})

test('isolation: the lease implementation imports NO host module', () => {
  /**
   * THE CLAIM ABOVE, CHECKED AS A FACT RATHER THAN A COMMENT. `lease-adapter.ts` may import the
   * protocol and nothing else — the moment it reaches for `adapters/dsh/…`, the "one implementation,
   * every host" property is gone and the two hosts can drift on fencing rules.
   */
  const leaseAdapter = readFileSync(join(srcDir, 'lease-adapter.ts'), 'utf8')
  assert.equal(
    /from\s+['"]\.\/adapters\//u.test(leaseAdapter),
    false,
    'lease-adapter.ts must not import a host adapter; it is written against the protocol',
  )
  assert.match(leaseAdapter, /StorageAdapter/u, 'and it is written against the protocol contract')
  const lease = readFileSync(join(srcDir, 'lease.ts'), 'utf8')
  assert.equal(
    /from\s+['"]\.\/adapters\//u.test(lease),
    false,
    'lease.ts carries the calling rule and must stay host-free too',
  )
})

test('isolation: the adapter reports its capabilities from PROBING, not from a phase flag', async () => {
  /**
   * STRUCTURAL FACT, PINNED: at P2 the write verbs are wired, so a bare context must disable them
   * because the SERVICES are absent — not because a `WRITE_PHASE` constant says so. A profile with the
   * services mounted gets them back, which is what makes the claim a probe rather than an assertion.
   */
  const mod = await import('../index.js')

  const bare = mod.paradiseInternals.createDshAdapters({}).session.capabilities
  assert.equal(bare.readLog, true, 'the read path never needed a service')
  assert.equal(bare.create, false, 'no services → no cold path')
  assert.equal(bare.trigger, false, 'no prompt channel → no ignition')
  assert.equal(bare.verifyDeletion, false, 'no stat → cannot confirm an absence')

  const mounted = mod.paradiseInternals.createDshAdapters({
    sessions: { prepare: () => ({ header: {} }), get: () => undefined },
    sessionPersistence: { create: async () => ({ append: async () => {}, flush: async () => {} }), stat: async () => undefined },
    sessionController: { prompt: async () => ({ accepted: true }) },
  }).session.capabilities
  assert.equal(mounted.create, true, 'both halves present → create is claimed')
  assert.equal(mounted.trigger, true)
  assert.equal(mounted.verifyDeletion, true)
})
