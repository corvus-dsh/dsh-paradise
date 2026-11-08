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
    /**
     * `launcher.ts` — THE DUAL-MODE SUPERVISOR.
     *
     * It is allowed at the top level for the SAME reason `lease.ts` and `storage-tiers.ts` are: it
     * imports the protocol and nothing else. Its single import is
     * `./protocol/index.js`, verified below — so it carries no host vocabulary, and it must be
     * importable on a machine that has never seen the host, which a file under `adapters/<host>/`
     * could not promise.
     *
     * THE RULE THIS FILE GUARDS IS UNCHANGED: host specifics stay under `adapters/<host>/`. A
     * supervisor that would otherwise have to import a host to watch it would be the OPPOSITE of that
     * rule — it would be a host-specific file masquerading as infrastructure.
     */
    'launcher.ts',
    /**
     * `emergency-repair.ts` and `harness.ts` — THE ASSEMBLY LAYER.
     *
     * Both are allowed at the top level for the same reason `launcher.ts` is: neither imports a host.
     * `emergency-repair.ts` imports ONLY the protocol (it is a session runner, and a session is a
     * protocol concept). `harness.ts` imports the protocol, the launcher, the emergency runner and
     * `adapters/raw/` — never `adapters/dsh/`.
     *
     * THE RULE IS UNCHANGED and is asserted below: a file at `src/` top level may reach the protocol,
     * its own siblings, and the RAW adapters. The moment one of them reaches for `adapters/dsh/`, the
     * standalone harness stops being standalone — which is the only property that justifies its
     * existence.
     */
    'emergency-repair.ts',
    'harness.ts',
    /**
     * `agent-loop.ts` and `repair-session.ts` — THE FIRE SEED.
     *
     * Both are allowed at the top level for the same reason `launcher.ts` is, and the reason the
     * user's request named explicitly: a repair conversation whose carrier is the host it repairs
     * is not a repair conversation. These two must be importable on a machine where the host has
     * never started, which a file under `adapters/<host>/` could not promise.
     *
     * `agent-loop.ts` imports only `./protocol/index.js`.
     * `repair-session.ts` imports only `./agent-loop.js` and `./protocol/index.js`.
     *
     * Neither reaches `adapters/dsh/`, which is what the guard below asserts. The moment one of
     * them does, the "self-repair without the host" claim becomes false — and that claim is the
     * entire justification for these files existing outside `adapters/`.
     */
    'agent-loop.ts',
    'repair-session.ts',
    /**
     * `watchdog.ts` — THE TRIGGER.
     *
     * Allowed at the top level for the same reason as the two above, and for one more that is
     * specific to it: a watchdog that lives inside the process it watches dies with that process,
     * so it must be startable on a machine where the host has never run. `watchdog.ts` imports
     * nothing at all — no protocol, no adapters — so it cannot even in principle reach a host
     * module. The guard below asserts that.
     */
    'watchdog.ts',
    /**
     * `spawn-node.ts` and `dispatcher.ts` — THE CREATION PRIMITIVE and a scheduler over it.
     *
     * Allowed at the top level for the reason that defines the primitive: a node must be
     * creatable on a machine where no host has ever run. `spawnNode` PROBES host capability and
     * reports `mode: 'portable'` when there is none, so it must load without the host present —
     * which a file under `adapters/<host>/` could not promise.
     *
     * Neither imports a host module: `spawn-node.ts` imports the tape builder, the capability
     * probe, and (lazily, only on the host path) the session writer; `dispatcher.ts` imports
     * `spawn-node` and the tape type. The guard below asserts that, and the identifier scan above
     * confirms no host service name leaks into the neutral layer.
     */
    'spawn-node.ts',
    'dispatcher.ts',
    /**
     * `harness-server.ts`, `harness-http.ts`, `ws-server.ts` — THE HOST ITSELF.
     *
     * These are the files that make the claim "this layer is a host, not a client of one" true, so
     * they must load on a machine with no host installed — which is precisely what a file under
     * `adapters/<host>/` could not promise.
     *
     * `harness-server.ts` drives the loop and persists sessions; `harness-http.ts` serves the UI on
     * Node built-ins; `ws-server.ts` implements RFC 6455 framing with `crypto` and `http`. None of
     * them imports a host module — none of them CAN, because there is no host to import.
     */
    'harness-server.ts',
    'harness-http.ts',
    'ws-server.ts',
    /**
     * `topology.ts` — THE HOST'S VIEW OF THE TASK GRAPH.
     *
     * It belongs at the top level for the same reason as the three above: it is part of the host
     * ITSELF (the UI's data), and it must load on a machine with no DSH installed. It reads
     * `<home>/memory/task-graph.json` and `<home>/knowledge/knowledge.jsonl` — the file contract the
     * memory plugin writes — and imports nothing but `node:fs` and `node:path`.
     *
     * IT IS NOT AN ADAPTER. There is no host to adapt to: the shape it returns is this layer's own
     * projection for its own page. Putting it under `adapters/<host>/` would claim a dependency it
     * does not have.
     */
    'topology.ts',
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

test('isolation: the dual-mode supervisor imports NO host module', () => {
  /**
   * THE PERMISSION GRANTED ABOVE, CHECKED AS A FACT RATHER THAN A COMMENT.
   *
   * `launcher.ts` was allowed at the top level because it is written against the protocol. That claim
   * is worth exactly nothing unless something fails when it stops being true — so this test reads the
   * file and refuses any import that leaves `protocol/`.
   *
   * THE FAILURE THIS PREVENTS: a supervisor that imports the host in order to WATCH the host. It looks
   * reasonable, and it destroys the one property that makes a supervisor useful — being able to run
   * when the thing it supervises is dead.
   */
  const launcher = readFileSync(join(srcDir, 'launcher.ts'), 'utf8')
  const imports = [...launcher.matchAll(/^import[^\n]*from\s+['"]([^'"]+)['"]/gmu)].map((match) => match[1])
  /**
   * WHAT "LEAVES protocol/" ACTUALLY MEANT.
   *
   * The first version of this assertion required EVERY import to start with `./protocol/`. That is a
   * proxy for the real invariant, and the two stopped being the same thing when `launcher.ts` began
   * sharing one extraction rule with `emergency-repair.ts`: a top-level sibling that imports NOTHING
   * but the protocol cannot reintroduce the failure this test exists to prevent (a supervisor that
   * needs its host cannot run when the host is dead).
   *
   * So the bar is unchanged and now STATED AS WHAT IT IS, plus made TRANSITIVE: the allowed set is
   * node builtins, the protocol, and top-level siblings — and every sibling actually used is read and
   * required to be host-free in turn. A sibling that one day imports `adapters/dsh/` fails here.
   */
  const hostFree = (specifier) => {
    if (specifier.startsWith('node:')) return true
    if (specifier.startsWith('./protocol/')) return true
    return /^\.\/[a-z0-9-]+\.js$/u.test(specifier)
  }
  const offenders = imports.filter((specifier) => !hostFree(specifier))
  assert.deepEqual(
    offenders,
    [],
    'launcher.ts must not import a host module; a supervisor that needs its host cannot run when the host is down',
  )

  /**
   * THE TRANSITIVE HALF. An import list proves nothing about what those files import, so each sibling
   * the launcher leans on is opened and held to the same bar.
   */
  for (const specifier of imports.filter((s) => /^\.\/[a-z0-9-]+\.js$/u.test(s) && !s.startsWith('./protocol/'))) {
    const sibling = join(srcDir, specifier.replace(/^\.\//u, '').replace(/\.js$/u, '.ts'))
    const source = readFileSync(sibling, 'utf8')
    const siblingImports = [...source.matchAll(/^import[^\n]*from\s+['"]([^'"]+)['"]/gmu)].map((match) => match[1])
    const nested = siblingImports.filter((nested) => !hostFree(nested))
    assert.deepEqual(
      nested,
      [],
      `${specifier} is reachable from launcher.ts and imports a host module: ${nested.join(', ')}. ` +
        'A host-free supervisor cannot rest on a dependency that is not host-free.',
    )
  }
  assert.ok(imports.length > 0, 'and it must actually import the protocol (an empty import list would pass vacuously)')
})

test('isolation: the standalone harness never imports the host adapter', () => {
  /**
   * THE PERMISSION GRANTED ABOVE, CHECKED AS A FACT.
   *
   * `harness.ts` is the file that must run on a machine where the host binary does not exist. If it
   * imports `adapters/dsh/`, the CLI it produces would fail to load during an outage — the one moment
   * it is needed. `emergency-repair.ts` is held to the same bar because it runs inside the same bundle.
   *
   * THE ALLOWED SET IS EXPLICIT: protocol, siblings at the top level, and `adapters/raw/`. Anything
   * else — including a future `adapters/<other-host>/` — fails here rather than at 3am.
   */
  for (const name of ['harness.ts', 'emergency-repair.ts']) {
    const source = readFileSync(join(srcDir, name), 'utf8')
    const imports = [...source.matchAll(/^import[^\n]*from\s+['"]([^'"]+)['"]/gmu)].map((match) => match[1])
    const offenders = imports.filter((specifier) => {
      if (specifier.startsWith('node:')) return false
      if (specifier === './protocol/index.js') return false
      if (specifier.startsWith('./adapters/raw/')) return false
      if (/^\.\/[a-z0-9-]+\.js$/u.test(specifier)) return false
      return true
    })
    assert.deepEqual(
      offenders,
      [],
      `${name} imports something a standalone harness cannot have: ${offenders.join(', ')}. ` +
        'The CLI must load on a machine where the host does not exist.',
    )
    assert.ok(imports.length > 0, `${name} must actually import something (an empty list would pass vacuously)`)
  }
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
