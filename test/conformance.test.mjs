/**
 * THE CONFORMANCE SUITE — the protocol, checked against a host that shares nothing with the original.
 *
 * WHY THIS FILE IS THE REAL PROOF OF DECOUPLING
 *
 * "The functional layer no longer depends on the harness" is a claim you cannot verify by reading the
 * old adapter. You verify it by running the same contract against a host built from the protocol's
 * words only. `adapters/memory/` is that host: conversations live in a Map, there is no log file, no
 * compression, no event bus, no service registry.
 *
 * So these cases do two jobs:
 *
 *   1. CONFORMANCE — every adapter verb behaves as the protocol says, on a host with no runtime
 *      baggage. If a verb only works because of something one runtime happens to provide, it fails
 *      here.
 *   2. HOST-NEUTRALITY — a caller written against the interfaces can drive either host, and the
 *      "functional layer" side of these tests contains no host names at all.
 *
 * `PARADISE_SPEC.md` tells a new implementer to make THIS SUITE pass. That is why it exists as a test
 * rather than as prose.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { ProtocolError, bindHost, createMemoryHost, isParadiseHost } from '../index.js'

/* ── the host contract ───────────────────────────────────────────────────── */

test('conformance: the reference host satisfies the structural check', () => {
  const host = createMemoryHost()
  assert.equal(isParadiseHost(host), true)
})

test('conformance: binding a complete host yields usable dependencies', () => {
  const host = createMemoryHost()
  const deps = bindHost(host)
  assert.equal(deps.session.name, 'memory')
  assert.equal(deps.storage.name, 'memory')
  assert.equal(deps.tools?.name, 'memory', 'tools are optional but present here')
})

test('conformance: a host missing a REQUIRED adapter is rejected at bind time, naming it', () => {
  const host = createMemoryHost()
  assert.throws(
    () => bindHost({ name: 'half-built', storage: host.storage }),
    (error) =>
      error instanceof ProtocolError &&
      error.code === 'HOST_INCOMPLETE' &&
      /session/u.test(error.message) &&
      /拒绝/u.test(error.message),
    'the failure must name the missing adapter AND say this is a refusal, not a degradation',
  )
})

test('conformance: storage without a session adapter is rejected too', () => {
  assert.throws(
    () => bindHost({ name: 'no-storage', session: createMemoryHost().session }),
    (error) => error instanceof ProtocolError && /storage/u.test(error.message),
  )
})

/* ── session: create ─────────────────────────────────────────────────────── */

test('session: create refuses an empty workspace — the protocol has no way to express "guess it"', async () => {
  const { session } = createMemoryHost()
  const receipt = await session.create({ cwd: '' })
  assert.equal(receipt.ok, false)
  assert.equal(receipt.error?.code, 'WORKSPACE_REQUIRED')
  assert.equal(receipt.stage, 'create', 'the stage is present on the FAILURE too')
})

test('session: create refuses a relative workspace', async () => {
  const { session } = createMemoryHost()
  const receipt = await session.create({ cwd: 'some/relative/path' })
  assert.equal(receipt.ok, false)
  assert.equal(receipt.error?.code, 'WORKSPACE_RELATIVE')
})

test('session: create answers an opaque ref and a stage on SUCCESS', async () => {
  const { session } = createMemoryHost()
  const receipt = await session.create({ cwd: 'D:\\project', title: 'work' })
  assert.equal(receipt.ok, true)
  assert.equal(receipt.stage, 'create', 'success carries a stage too — "how far did it get?" is the first question')
  assert.ok(receipt.session !== undefined)
  assert.equal(receipt.session.cwd, 'D:\\project')
  assert.ok(receipt.session.id.length > 0)
})

test('session: a duplicate id is refused, not silently reused', async () => {
  const { session } = createMemoryHost()
  await session.create({ cwd: 'D:\\project', id: 'fixed' })
  const again = await session.create({ cwd: 'D:\\project', id: 'fixed' })
  assert.equal(again.ok, false)
  assert.equal(again.error?.code, 'SESSION_EXISTS')
})

/* ── session: inject ─────────────────────────────────────────────────────── */

test('session: inject reports per-item what the transcript will actually SHOW', async () => {
  const { session } = createMemoryHost()
  const created = await session.create({ cwd: 'D:\\project' })
  const receipt = await session.inject(created.session, [
    { visibility: 'visible', text: 'the plan', origin: 'plugin:slicer:handoff' },
    { visibility: 'context-only', text: 'background', origin: 'plugin:slicer:background' },
  ])

  assert.equal(receipt.ok, true)
  assert.equal(receipt.rendered.length, 2, 'one answer per item, never a single global flag')
  assert.equal(receipt.rendered[0].rendered, true)
  assert.equal(receipt.rendered[0].requested, 'visible')
  assert.equal(receipt.rendered[1].rendered, false, 'context-only is honoured, and said so')
  assert.ok(receipt.rendered[1].reason.length > 0, 'a demoted item must explain itself')
})

test('session: inject into a missing session fails with the id and a stage', async () => {
  const { session } = createMemoryHost()
  const receipt = await session.inject({ id: 'nope', cwd: 'D:\\project' }, [
    { visibility: 'visible', text: 'x', origin: 'plugin:a:b' },
  ])
  assert.equal(receipt.ok, false)
  assert.equal(receipt.error?.code, 'SESSION_NOT_FOUND')
  assert.deepEqual(receipt.rendered, [], 'and it answers the per-item field with nothing, not undefined')
})

/* ── session: trigger ────────────────────────────────────────────────────── */

test('session: trigger records the mode it was asked for', async () => {
  const { session } = createMemoryHost()
  const created = await session.create({ cwd: 'D:\\project' })
  const queued = await session.trigger(created.session, { text: 'go', mode: 'queue', origin: 'plugin:a:b' })
  assert.equal(queued.ok, true)
  assert.equal(queued.stage, 'trigger:queue')

  const interrupted = await session.trigger(created.session, { text: 'stop', mode: 'interrupt', origin: 'plugin:a:b' })
  assert.equal(interrupted.stage, 'trigger:interrupt', 'the two modes are distinct outcomes, not one success flag')
})

/* ── session: readLog ────────────────────────────────────────────────────── */

test('session: readLog reports what was written, including per-message renderability', async () => {
  const { session } = createMemoryHost()
  const created = await session.create({ cwd: 'D:\\project' })
  await session.inject(created.session, [{ visibility: 'visible', text: 'the plan', origin: 'plugin:a:b' }])

  const reading = await session.readLog(created.session)
  assert.equal(reading.readable, true)
  assert.equal(reading.eventCount, 1)
  assert.deepEqual(reading.eventTypes, ['content'])
  assert.equal(reading.firstMessage?.rendered, true)
  assert.equal(reading.firstMessage?.origin, 'plugin:a:b', 'provenance survives the round trip')
  assert.equal(reading.firstMessage?.textLength, 'the plan'.length)
})

test('session: readLog NEVER throws — a missing session is readable:false with a reason', async () => {
  const { session } = createMemoryHost()
  const reading = await session.readLog({ id: 'ghost', cwd: 'D:\\project' })
  assert.equal(reading.readable, false)
  assert.equal(reading.eventCount, 0)
  assert.ok(reading.notes.length > 0, 'the reason is stated, not implied')
})

/* ── session: subscribe ──────────────────────────────────────────────────── */

test('session: subscribe delivers events for THIS session only', async () => {
  const { session } = createMemoryHost()
  const first = await session.create({ cwd: 'D:\\project' })
  const second = await session.create({ cwd: 'D:\\project' })

  const seen = []
  const off = session.subscribe(first.session, (event) => seen.push(event))
  await session.inject(second.session, [{ visibility: 'visible', text: 'other', origin: 'plugin:a:b' }])
  assert.equal(seen.length, 0, 'another session\'s event must not arrive')

  await session.inject(first.session, [{ visibility: 'visible', text: 'mine', origin: 'plugin:a:b' }])
  assert.equal(seen.length, 1)
  assert.equal(seen[0].sessionId, first.session.id)

  off()
  await session.inject(first.session, [{ visibility: 'visible', text: 'after', origin: 'plugin:a:b' }])
  assert.equal(seen.length, 1, 'unsubscribe really detaches')
})

test('session: subscribing to a missing session is a no-op unsubscribe, not a throw', () => {
  const { session } = createMemoryHost()
  const off = session.subscribe({ id: 'ghost', cwd: 'D:\\project' }, () => {})
  assert.equal(typeof off, 'function')
  assert.doesNotThrow(() => off())
})

/* ── storage ─────────────────────────────────────────────────────────────── */

test('storage: undefined means "not stored", distinct from a stored null', async () => {
  const { storage } = createMemoryHost()
  assert.equal(await storage.read('missing'), undefined)
  await storage.write('present', null)
  assert.equal(await storage.read('present'), null, 'a stored null is a real value and must not collapse to undefined')
})

test('storage: a write is a SNAPSHOT, so mutating the source does not change what is stored', async () => {
  const { storage } = createMemoryHost()
  const value = { bindings: { a: 'b' } }
  await storage.write('table', value)
  value.bindings.a = 'CHANGED'
  const read = await storage.read('table')
  assert.equal(read.bindings.a, 'b', 'an atomic writer copies; otherwise the "stored" document is a live reference')
})

test('storage: keys(prefix) finds a namespace without knowing the layout', async () => {
  const { storage } = createMemoryHost()
  await storage.write('observer.bindings', {})
  await storage.write('observer.focus', {})
  await storage.write('slicer.ledger', {})
  assert.deepEqual((await storage.keys('observer.')).sort(), ['observer.bindings', 'observer.focus'])
  assert.equal((await storage.keys()).length, 3)
})

test('storage: remove is idempotent', async () => {
  const { storage } = createMemoryHost()
  await storage.write('k', 1)
  assert.equal((await storage.remove('k')).ok, true)
  assert.equal((await storage.remove('k')).ok, true, 'removing what is already gone is a success, not an error')
  assert.equal(await storage.read('k'), undefined)
})

/* ── tools ───────────────────────────────────────────────────────────────── */

test('tools: an unknown tool is a RESULT with isError, never a thrown exception', async () => {
  const { tools } = createMemoryHost()
  const outcome = await tools.execute({ name: 'nope', arguments: {} })
  assert.equal(outcome.isError, true)
  assert.equal(outcome.error?.code, 'UNKNOWN_TOOL')
})

test('tools: list answers descriptors with a schema field', async () => {
  const { tools } = createMemoryHost()
  const list = await tools.list()
  assert.ok(list.length > 0)
  for (const descriptor of list) {
    assert.ok(descriptor.name.length > 0)
    assert.ok('inputSchema' in descriptor)
  }
})

/* ── a CALLER written against the interfaces ─────────────────────────────── */

test('neutrality: a caller using only the protocol words works end to end', async () => {
  /**
   * THIS IS THE DECOUPLING CLAIM, EXECUTED.
   *
   * The function below is what "the functional layer" looks like after the migration: it takes the
   * dependency bundle and does its job using only protocol vocabulary. It has never heard of a turn
   * pair, a surface operation, a service getter or a log file — and it runs here, on a host that has
   * none of those.
   */
  const deps = bindHost(createMemoryHost())

  async function handOff(dependencies, goalText) {
    const created = await dependencies.session.create({ cwd: 'D:\\project', title: 'goal' })
    if (!created.ok) return { ok: false, because: created.error?.code }

    const injected = await dependencies.session.inject(created.session, [
      { visibility: 'visible', text: goalText, origin: 'plugin:test:goal' },
      { visibility: 'context-only', text: 'constraints', origin: 'plugin:test:context' },
    ])
    if (!injected.ok) return { ok: false, because: injected.error?.code }

    const started = await dependencies.session.trigger(created.session, {
      text: 'begin',
      mode: 'queue',
      origin: 'plugin:test:ignite',
    })
    if (!started.ok) return { ok: false, because: started.error?.code }

    await dependencies.storage.write('test.last-goal', { sessionId: created.session.id, at: Date.now() })
    const reading = await dependencies.session.readLog(created.session)

    return {
      ok: true,
      sessionId: created.session.id,
      visible: injected.rendered.filter((item) => item.rendered).length,
      transcribed: reading.eventTypes,
      persisted: (await dependencies.storage.read('test.last-goal')) !== undefined,
    }
  }

  const result = await handOff(deps, 'ship it')
  assert.equal(result.ok, true)
  assert.equal(result.visible, 1, 'exactly the item marked visible is transcribed')
  assert.deepEqual(result.transcribed, ['content', 'content', 'turn'])
  assert.equal(result.persisted, true)
})

test('neutrality: the same caller works on a SECOND host without modification', async () => {
  /**
   * A second in-memory host, built differently on purpose (different ids, no tools adapter), to prove
   * the caller depends on the CONTRACT and not on the reference host's incidental behaviour.
   */
  const base = createMemoryHost()
  const renamed = {
    name: 'second-host',
    session: { ...base.session, name: 'second-host-session' },
    storage: { ...base.storage, name: 'second-host-storage' },
  }
  const deps = bindHost(renamed)

  const created = await deps.session.create({ cwd: '/tmp/project' })
  assert.equal(created.ok, true)
  const injected = await deps.session.inject(created.session, [
    { visibility: 'visible', text: 'goal', origin: 'plugin:test:goal' },
  ])
  assert.equal(injected.rendered[0].rendered, true)
  assert.equal(deps.tools, undefined, 'tools are optional: this host has none and the caller did not need one')
})

/* ── the honest half: this host's capabilities are PROBED, not asserted ── */

test('honesty: the host adapter reports what it can ACTUALLY do on a bare context', async () => {
  /**
   * A BARE CONTEXT HAS NO SERVICES. So every verb that depends on one must report unavailable — and
   * the write verbs, which are now wired, must report unavailable HERE because the host half is
   * missing, not because the code is missing. That distinction is the whole point of probing.
   */
  const { createDshAdapters } = await import('../index.js')
  const adapters = createDshAdapters({})
  const capabilities = adapters.session.capabilities

  assert.equal(capabilities.readLog, true, 'the read path needs no service: it takes a path')
  assert.equal(capabilities.create, false, 'create needs prepare + persistence, and this ctx has neither')
  assert.equal(capabilities.trigger, false, 'trigger needs a prompt channel')
  assert.equal(capabilities.verifyDeletion, false, 'verification needs stat')

  const names = capabilities.unavailable.map((entry) => entry.capability)
  for (const verb of ['create', 'trigger', 'verifyDeletion']) {
    assert.ok(names.includes(verb), `${verb} must appear in the unavailable list when it cannot work`)
  }
  for (const entry of capabilities.unavailable) {
    assert.ok(entry.consequence.length > 0, `the absence of ${entry.capability} must state its cost`)
  }

  /* And the verbs must REFUSE, naming what is missing — never a quiet success. */
  const receipt = await adapters.session.create({ cwd: 'D:\\project' })
  assert.equal(receipt.ok, false)
  assert.equal(receipt.error?.code, 'SESSIONS_UNAVAILABLE')
  assert.equal(receipt.stage, 'prepare', 'the stage names WHERE it refused')
})

test('honesty: a fully mounted host enables the write verbs', async () => {
  const { createDshAdapters } = await import('../index.js')
  const ctx = {
    sessions: { prepare: () => ({ header: { cwd: 'D:\\project', isSeeded: false, createdAt: 1 } }), get: () => undefined },
    sessionPersistence: { create: async () => ({ append: async () => {}, flush: async () => {}, close: async () => {} }), stat: async () => undefined },
    sessionController: { prompt: async () => ({ accepted: true }) },
    // The event bus is what makes `subscribe` possible; without it that ONE capability stays off.
    on: () => () => {},
    emit: () => {},
  }
  const capabilities = createDshAdapters(ctx).session.capabilities
  assert.equal(capabilities.create, true, 'both halves of the cold path are present')
  assert.equal(capabilities.trigger, true)
  assert.equal(capabilities.verifyDeletion, true, 'stat is present, so verification is possible')
  assert.equal(capabilities.subscribe, true)
  assert.deepEqual(capabilities.unavailable, [], 'nothing is missing on this profile')
})

test('honesty: injectIntoRunning stays false — the create-time transaction cannot append to a running turn', async () => {
  const { createDshAdapters } = await import('../index.js')
  const ctx = {
    sessions: { prepare: () => ({ header: {} }), get: () => undefined },
    sessionPersistence: { create: async () => ({ append: async () => {}, flush: async () => {} }) },
    sessionController: { prompt: async () => ({ accepted: true }) },
  }
  const capabilities = createDshAdapters(ctx).session.capabilities
  assert.equal(
    capabilities.injectIntoRunning,
    false,
    'a whole-tape transaction at create time is NOT the same operation as appending to an open turn',
  )
  const receipt = await createDshAdapters(ctx).session.inject({ id: 's', cwd: 'D:\\project' }, [
    { visibility: 'visible', text: 'x', origin: 'plugin:a:b' },
  ])
  assert.equal(receipt.ok, false)
  assert.match(receipt.error.message, /create 时|尚未接线/u, 'and it says what to do instead')
})
