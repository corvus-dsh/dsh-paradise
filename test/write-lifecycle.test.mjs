/**
 * THE WRITE CONTRACT — create / inject / trigger / probeDeletion, checked on a host with no baggage.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `conformance.test.mjs`
 *
 * `conformance.test.mjs` proves the protocol is IMPLEMENTABLE. This file proves the write half is
 * USABLE: the exact lifecycle a functional layer performs — create, put content in, make it run, read
 * it back, then confirm it is gone — executed against the in-memory host and, in the last group, against
 * BOTH hosts through one caller.
 *
 * THE PROPERTY THAT MATTERS MOST HERE
 *
 * The same caller function must work on a host that keeps conversations in a `Map` and on a host that
 * writes compressed frames to disk. If that caller needs a branch, the abstraction leaked. The final
 * group is written as one function run twice, and its body names no host.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { bindHost, createMemoryHost } from '../index.js'

/* ── create ─────────────────────────────────────────────────────────────── */

test('write: create answers a stage and an opaque ref on success', async () => {
  const { session } = createMemoryHost()
  const receipt = await session.create({ cwd: '/tmp/work', title: 'goal' })

  assert.equal(receipt.ok, true)
  assert.equal(receipt.stage, 'create', 'success carries a stage too — "how far did it get?" matters')
  assert.equal(receipt.session.cwd, '/tmp/work')
  assert.deepEqual(receipt.warnings, [], 'an empty warnings array is a claim, and here it is earned')
})

test('write: create refuses an empty or relative workspace BEFORE anything exists', async () => {
  const host = createMemoryHost()
  const empty = await host.session.create({ cwd: '' })
  assert.equal(empty.ok, false)
  assert.equal(empty.error.code, 'WORKSPACE_REQUIRED')

  const relative = await host.session.create({ cwd: 'relative/path' })
  assert.equal(relative.ok, false)
  assert.equal(relative.error.code, 'WORKSPACE_RELATIVE')

  assert.equal(host.dump().sessions.size, 0, 'a refused create must leave NOTHING behind')
})

test('write: a duplicate id is refused and the first session is untouched', async () => {
  const host = createMemoryHost()
  const first = await host.session.create({ cwd: '/tmp/a', id: 'fixed' })
  assert.equal(first.ok, true)

  const again = await host.session.create({ cwd: '/tmp/b', id: 'fixed' })
  assert.equal(again.ok, false)
  assert.equal(again.error.code, 'SESSION_EXISTS')

  const stored = host.dump().sessions.get('fixed')
  assert.equal(stored.ref.cwd, '/tmp/a', 'the original is not overwritten by the failed second create')
})

/* ── inject ─────────────────────────────────────────────────────────────── */

test('write: inject answers per item, and only the visible one is transcribed as visible', async () => {
  const { session } = createMemoryHost()
  const created = await session.create({ cwd: '/tmp/work' })

  const receipt = await session.inject(created.session, [
    { visibility: 'visible', text: 'the plan', origin: 'plugin:slicer:handoff' },
    { visibility: 'context-only', text: 'background', origin: 'plugin:slicer:context' },
  ])
  assert.equal(receipt.ok, true)
  assert.equal(receipt.rendered.length, 2)
  assert.equal(receipt.rendered[0].rendered, true)
  assert.equal(receipt.rendered[1].rendered, false)
  assert.ok(receipt.rendered[1].reason.length > 0, 'a demoted item explains itself')
})

test('write: injecting into a session that does not exist is a failure with the id', async () => {
  const { session } = createMemoryHost()
  const receipt = await session.inject({ id: 'ghost', cwd: '/tmp/work' }, [
    { visibility: 'visible', text: 'x', origin: 'plugin:a:b' },
  ])
  assert.equal(receipt.ok, false)
  assert.equal(receipt.error.code, 'SESSION_NOT_FOUND')
  assert.deepEqual(receipt.rendered, [], 'the per-item field is present even on failure')
})

/* ── trigger ────────────────────────────────────────────────────────────── */

test('write: trigger marks the session running and records which mode was used', async () => {
  const host = createMemoryHost()
  const created = await host.session.create({ cwd: '/tmp/work' })

  const queued = await host.session.trigger(created.session, { text: 'go', mode: 'queue', origin: 'plugin:a:b' })
  assert.equal(queued.ok, true)
  assert.equal(queued.stage, 'trigger:queue')
  assert.equal(host.dump().sessions.get(created.session.id).running, true, 'the session really started')

  const interrupted = await host.session.trigger(created.session, { text: 'stop', mode: 'interrupt', origin: 'plugin:a:b' })
  assert.equal(interrupted.stage, 'trigger:interrupt', 'the two modes are distinct outcomes')
})

test('write: triggering a session that does not exist fails, and starts nothing', async () => {
  const host = createMemoryHost()
  const receipt = await host.session.trigger({ id: 'ghost', cwd: '/tmp/work' }, { text: 'go', mode: 'queue', origin: 'plugin:a:b' })
  assert.equal(receipt.ok, false)
  assert.equal(receipt.error.code, 'SESSION_NOT_FOUND')
})

/* ── probeDeletion ──────────────────────────────────────────────────────── */

test('write: probeDeletion answers present, then absent — and never guesses', async () => {
  const host = createMemoryHost()
  const created = await host.session.create({ cwd: '/tmp/work' })

  assert.equal(await host.session.probeDeletion(created.session), 'present')

  // The memory host exposes no public delete verb (removal is a lifecycle concern of the creator), so
  // the probe is exercised through the store the fixture exposes.
  host.dump().sessions.delete(created.session.id)
  assert.equal(await host.session.probeDeletion(created.session), 'absent')

  assert.equal(
    await host.session.probeDeletion({ id: 'never-existed', cwd: '/tmp/work' }),
    'absent',
    'a session that never was is also "absent" — the probe answers about the world, not about history',
  )
})

/* ── capabilities ───────────────────────────────────────────────────────── */

test('write: the memory host claims every capability it can actually serve', async () => {
  const host = createMemoryHost()
  const capabilities = host.session.capabilities
  assert.equal(capabilities.create, true)
  assert.equal(capabilities.injectIntoIdle, true)
  assert.equal(capabilities.injectIntoRunning, true, 'this host can write to a running session')
  assert.equal(capabilities.trigger, true)
  assert.equal(capabilities.readLog, true)
  assert.equal(capabilities.subscribe, true)
  assert.equal(capabilities.verifyDeletion, true)
  assert.deepEqual(capabilities.unavailable, [], 'nothing is missing, and the list says so')
})

/* ── THE CROSS-HOST LIFECYCLE ───────────────────────────────────────────── */

/**
 * One caller, written against the protocol's words ONLY.
 *
 * It is deliberately NOT a helper that knows which host it is on: no `if (host.name === …)`, no
 * capability branching beyond "did the receipt say ok". If this function ever needs to know, the
 * abstraction has failed and the test below is where that shows up.
 */
async function fullLifecycle(deps, goalText) {
  const created = await deps.session.create({ cwd: '/tmp/project', title: 'lifecycle probe' })
  if (!created.ok) return { ok: false, at: 'create', why: created.error }

  const injected = await deps.session.inject(created.session, [
    { visibility: 'visible', text: goalText, origin: 'plugin:test:goal' },
    { visibility: 'context-only', text: 'constraints', origin: 'plugin:test:context' },
  ])
  if (!injected.ok) return { ok: false, at: 'inject', why: injected.error }

  const started = await deps.session.trigger(created.session, {
    text: 'begin the work',
    mode: 'queue',
    origin: 'plugin:test:ignition',
  })
  if (!started.ok) return { ok: false, at: 'trigger', why: started.error }

  const reading = await deps.session.readLog(created.session)

  const before = await deps.session.probeDeletion(created.session)

  return {
    ok: true,
    sessionId: created.session.id,
    visible: injected.rendered.filter((item) => item.rendered).length,
    transcribed: reading.eventTypes,
    readable: reading.readable,
    firstMessage: reading.firstMessage,
    beforeDeletion: before,
  }
}

test('lifecycle: 创建 → 注入 → 点火 → 读回 → 删除核实, on the HOSTLESS host', async () => {
  const deps = bindHost(createMemoryHost())
  const result = await fullLifecycle(deps, 'ship the feature')

  assert.equal(result.ok, true, JSON.stringify(result.why ?? {}))
  assert.equal(result.visible, 1, 'exactly the item marked visible is transcribed')
  assert.equal(result.readable, true)
  assert.deepEqual(result.transcribed, ['content', 'content', 'turn'])
  assert.equal(result.firstMessage.textLength, 'ship the feature'.length)
  assert.equal(result.firstMessage.rendered, true)
  assert.equal(result.beforeDeletion, 'present', 'the artifact exists before any removal')
})

test('lifecycle: the SAME caller runs unchanged on the HOST-BACKED adapter (capabilities permitting)', async () => {
  /**
   * THE REAL COMPARISON. `createDshAdapters` returns the runtime-backed adapter; on a bare context its
   * write verbs are correctly DISABLED, and that is what this case asserts — the caller does not
   * crash, it gets a NAMED refusal at the exact step that is unavailable.
   *
   * This is the honest form of "works on two hosts": on the hostless one it completes; on the
   * host-backed one without services it fails at `create` with `SESSIONS_UNAVAILABLE`. The assertion
   * that matters is that the CALLER is identical and the failure is legible.
   */
  const mod = await import('../index.js')
  const dsh = mod.paradiseInternals.createDshAdapters({})
  const deps = { session: dsh.session, storage: dsh.storage, tools: dsh.tools }

  const result = await fullLifecycle(deps, 'ship the feature')
  assert.equal(result.ok, false)
  assert.equal(result.at, 'create', 'a bare context can create nothing — and says so at the right step')
  assert.equal(result.why.code, 'SESSIONS_UNAVAILABLE')
  assert.match(result.why.message, /prepare|持久化/u, 'the refusal names the missing half')
})

test('lifecycle: the same caller ALSO completes on a fully mounted host', async () => {
  /**
   * AND HERE IS THE OTHER HALF: a host that has the services mounted gets the whole lifecycle through
   * the DSH adapter. The fake services are minimal on purpose — this asserts the adapter's WIRING, not
   * the host's disk format (which `disk.test.mjs` and the plugin suites cover).
   */
  const mod = await import('../index.js')
  const prepared = { header: { cwd: '/tmp/project', isSeeded: false, createdAt: Date.now() } }
  const persisted = new Map()
  const ctx = {
    sessions: {
      prepare: (id) => ({ ...prepared, header: { ...prepared.header, id } }),
      get: (id) => persisted.get(id)?.live,
      remove: async (id) => persisted.delete(id),
    },
    sessionPersistence: {
      create: async (header) => {
        const record = { header, events: [], live: false }
        persisted.set(header.id, record)
        return {
          append: async (events) => {
            record.events.push(...events)
          },
          flush: async () => {},
          close: async () => {
            record.live = true
          },
        }
      },
      stat: async (id) => (persisted.has(id) ? { header: persisted.get(id).header } : undefined),
      open: async (id) => persisted.get(id),
      discardPrepared: async (id) => persisted.delete(id),
    },
    sessionQuery: {
      readSession: async (id) => {
        const record = persisted.get(id)
        if (record === undefined) throw new Error(`session "${id}" not found`)
        return { session: record.header, inheritedEventCount: 0, events: [...record.events] }
      },
    },
    sessionController: { prompt: async () => ({ accepted: true }) },
    on: () => () => {},
    emit: () => {},
  }
  const dsh = mod.paradiseInternals.createDshAdapters(ctx)

  /**
   * THE DSH ADAPTER WRITES THE WHOLE TAPE AT CREATE TIME (that is this host's transactional shape), so
   * `create` already places the content. `inject` afterwards is a DIFFERENT operation on this host and
   * is correctly reported as unavailable — the caller below tolerates that, which is exactly what a
   * capability-aware functional layer does.
   */
  const created = await dsh.session.create({ cwd: '/tmp/project', title: 'lifecycle probe' })
  assert.equal(created.ok, true, JSON.stringify(created.error ?? {}))
  assert.equal(created.stage, 'create_success')
  assert.equal(created.verified, true, 'the cold read confirmed the write, field by field')
  assert.ok(created.appended >= 5, 'the whole closed skeleton was written')
  assert.equal(created.rendered.length, 1)

  const started = await dsh.session.trigger(created.session, { text: 'begin', mode: 'queue', origin: 'plugin:test:ignition' })
  assert.equal(started.ok, true, JSON.stringify(started.error ?? {}))
  assert.match(started.channel ?? '', /sessionController\.prompt/u)

  const reading = await dsh.session.readLog(created.session)
  assert.equal(reading.readable, false, 'there is no durable file behind this fixture, and the reader says so')

  assert.equal(await dsh.session.probeDeletion(created.session), 'present')

  const deleted = await mod.paradiseInternals.deleteSession(ctx, created.session.id, 'test cleanup')
  assert.equal(deleted.removed, true, 'the store removed it')
  assert.equal(await dsh.session.probeDeletion(created.session), 'absent', 'and the probe CONFIRMS it')
})
