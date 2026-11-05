/**
 * THE CALLER CONTRACT — the four facts a caller brings that THIS layer must not overwrite.
 *
 * WHY THIS FILE EXISTS
 *
 * `dsh-paradise` was built by porting one plugin's write path, and the first version carried that
 * plugin's vocabulary along with the mechanics: its prompt marker, its mode word, its publishing step,
 * its briefing rule. Each of those is correct for THAT caller and wrong as a shared rule — and the way
 * they failed was expensive, because a wrong convention does not throw:
 *
 *   - a hostile marker makes idempotence look for a string that never appears, so every retry
 *     RE-PROMPTS a target that is already awake;
 *   - a wrong mode word is a prompt the host refuses, reported as "the channel is missing";
 *   - a layer-side publish makes every session appear TWICE in the sidebar;
 *   - a briefing rule applied to a replay tape refuses a legal log.
 *
 * So each test below is a regression pin, written from the caller's side: "I brought my own X — prove
 * the layer used it, and prove it did not silently substitute its own."
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { paradiseInternals } from '../index.js'

const { createDshAdapters } = paradiseInternals

/** A host with a recording prompt channel, so the WIRE can be inspected rather than inferred. */
function makeCtx(promptImpl = async () => ({ accepted: true })) {
  const calls = []
  const prepared = { header: { cwd: '/tmp/project', isSeeded: false, createdAt: Date.now() } }
  const persisted = new Map()
  return {
    calls,
    persisted,
    ctx: {
      sessions: {
        prepare: (id) => ({ header: { ...prepared.header, id } }),
        get: () => undefined,
      },
      sessionPersistence: {
        create: async (header) => {
          const record = { header, events: [], live: false }
          persisted.set(header.id, record)
          return {
            append: async (events) => record.events.push(...events),
            flush: async () => {},
            close: async () => {
              record.live = true
            },
          }
        },
        stat: async (id) => (persisted.has(id) ? { header: persisted.get(id).header } : undefined),
        open: async (id) => persisted.get(id),
        discardPrepared: async (id) => persisted.delete(id),
        remove: async (id) => persisted.delete(id),
      },
      sessionQuery: {
        readSession: async (id) => {
          const record = persisted.get(id)
          if (record === undefined) throw new Error(`session "${id}" not found`)
          return { session: record.header, inheritedEventCount: 0, events: [...record.events] }
        },
      },
      sessionController: {
        prompt: async (request, signal) => {
          calls.push({ request, signal })
          return promptImpl(request, signal)
        },
      },
      on: () => () => {},
      emit: () => {},
    },
  }
}

/* ── the marker: the CALLER's prefix is what stamps, and what is searched for ── */

test('caller: a supplied marker is PREPENDED to the prompt, not replaced by the default', async () => {
  const { ctx, calls } = makeCtx()
  const session = createDshAdapters(ctx).session

  const receipt = await session.trigger(
    { id: 'session-m', cwd: '/tmp/project' },
    { text: 'keep going', mode: 'queue', origin: 'plugin:mine:ignite', marker: '[mine 点火]' },
  )

  assert.equal(receipt.ok, true, JSON.stringify(receipt.error ?? {}))
  assert.equal(calls.length, 1)
  const sent = calls[0].request.content[0].text
  assert.equal(sent.startsWith('[mine 点火]'), true, `the caller's marker must lead the prompt, got ${sent}`)
  assert.equal(
    sent.includes('[dsh-observer 点火]'),
    false,
    'the layer must not stamp its own historical marker onto another plugin\'s prompt',
  )
  assert.equal(sent.slice('[mine 点火]'.length).trim(), 'keep going', 'the caller\'s text survives verbatim')
})

test('caller: the SAME marker is what idempotence searches the log for', async () => {
  /**
   * THE FAILURE THIS PINS: with the wrong marker in the search, a target whose log ALREADY carries the
   * caller's prompt reports "never triggered". The retry then sends the instruction a second time, and
   * the target reads it as two turns of user intent.
   */
  const { ctx, persisted, calls } = makeCtx()
  const session = createDshAdapters(ctx).session
  const marker = '[mine 点火]'

  /**
   * TRIGGER ADDRESSES AN EXISTING SESSION — it never creates one. The target is written first, exactly
   * as a real caller does (create → trigger), and then the log is warmed the way the host would.
   */
  const created = await session.create({ cwd: '/tmp/project', id: 'session-warm', title: 'warm' })
  assert.equal(created.ok, true, JSON.stringify(created.error ?? {}))
  await session.trigger(
    { id: 'session-warm', cwd: '/tmp/project' },
    { text: 'go', mode: 'queue', origin: 'plugin:mine:ignite', marker },
  )
  // Simulate what the host does when it admits the prompt.
  const record = persisted.get('session-warm')
  record.events.push({
    type: 'user/message',
    seq: record.events.length,
    time: Date.now(),
    data: { id: 'admitted', role: 'user', content: [{ type: 'text', text: `${marker} go` }], source: { kind: 'user' } },
    surfaceOp: 'append',
  })
  const before = calls.length

  const again = await session.trigger(
    { id: 'session-warm', cwd: '/tmp/project' },
    { text: 'go', mode: 'queue', origin: 'plugin:mine:ignite', marker },
  )

  assert.equal(again.ok, true)
  assert.equal(again.alreadyTriggered, true, 'the caller\'s own marker must count as already delivered')
  assert.equal(calls.length, before, 'a duplicate instruction must not be admitted')
})

/* ── the mode dialect: the PROTOCOL's intent, the HOST's word ── */

test('dialect: the protocol says `interrupt`, this host accepts `steer`', async () => {
  /**
   * THE HOST'S REAL CONTRACT, measured in the 0.2.2 compatibility record: `sessionController.prompt`
   * takes `mode: 'queue' | 'steer'`. Sending the protocol's word `interrupt` would be a prompt the host
   * does not accept — and because the failure surfaces as "not accepted", it reads like a dead channel.
   */
  const { ctx, calls } = makeCtx()
  const session = createDshAdapters(ctx).session

  const receipt = await session.trigger(
    { id: 'session-d', cwd: '/tmp/project' },
    { text: 'correct course', mode: 'interrupt', origin: 'plugin:mine:ignite' },
  )

  assert.equal(receipt.ok, true, JSON.stringify(receipt.error ?? {}))
  assert.equal(receipt.stage, 'trigger:interrupt', 'the PROTOCOL mode is what the receipt reports')
  assert.equal(calls[0].request.mode, 'steer', "the HOST's word is what goes on the wire")
})

test('dialect: `queue` is spelled the same by both sides, and stays that way', async () => {
  const { ctx, calls } = makeCtx()
  const session = createDshAdapters(ctx).session
  const receipt = await session.trigger(
    { id: 'session-q', cwd: '/tmp/project' },
    { text: 'start', mode: 'queue', origin: 'plugin:mine:ignite' },
  )
  assert.equal(receipt.ok, true)
  assert.equal(calls[0].request.mode, 'queue')
})

/* ── falling back between modes: a caller's policy, not the layer's ── */

test('fallback: by default a refused queue IS retried as an interrupt', async () => {
  let attempt = 0
  const { ctx, calls } = makeCtx(async () => {
    attempt += 1
    // Refuse the first call, accept the second.
    return attempt === 1 ? { accepted: false } : { accepted: true }
  })
  const session = createDshAdapters(ctx).session
  const receipt = await session.trigger(
    { id: 'session-f', cwd: '/tmp/project' },
    { text: 'go', mode: 'queue', origin: 'plugin:mine:ignite' },
  )

  assert.equal(receipt.ok, true, 'the fallback is what makes a hint arrive instead of being dropped')
  assert.equal(calls.length, 2, 'the second attempt is the other mode')
  assert.equal(calls[1].request.mode, 'steer')
})

test('fallback:false turns a refusal into a REPORTED failure, not a silent escalation', async () => {
  /**
   * WHY A CALLER WANTS THIS: `interrupt` lands inside a live turn. A caller whose contract is "the
   * mode the user configured, and a refusal is reported" must not have that upgraded behind its back.
   */
  const { ctx, calls } = makeCtx(async () => ({ accepted: false }))
  const session = createDshAdapters(ctx).session
  const receipt = await session.trigger(
    { id: 'session-nf', cwd: '/tmp/project' },
    { text: 'go', mode: 'queue', origin: 'plugin:mine:ignite', fallbackModes: false },
  )

  assert.equal(receipt.ok, false)
  assert.equal(receipt.error.code, 'TRIGGER_REFUSED')
  assert.equal(calls.length, 1, 'exactly one attempt — no escalation')
  assert.equal(calls[0].request.mode, 'queue', 'and it was the mode the caller asked for')
})

/* ── publishing: the layer's default, the caller's choice ── */

test('publish: by default the layer attaches the workspace and announces the session', async () => {
  const attached = []
  const emitted = []
  const { ctx } = makeCtx()
  ctx.workspaceRegistry = {
    resolveByPath: async () => ({ id: 'ws', attachSession: async (id) => attached.push(id) }),
  }
  ctx.emit = (name, payload) => emitted.push({ name, payload })
  const session = createDshAdapters(ctx).session

  const receipt = await session.create({ cwd: '/tmp/project', title: 't' })
  assert.equal(receipt.ok, true, JSON.stringify(receipt.error ?? {}))
  assert.deepEqual(attached, [receipt.session.id], 'the default is to publish')
  assert.equal(emitted.filter((entry) => entry.name === 'api-session/added').length, 1)
  assert.equal(receipt.workspaceAttached, true)
  assert.equal(receipt.clientAnnounced, true)
})

test('publish:false leaves BOTH side effects to the caller, so neither happens twice', async () => {
  /**
   * THE BUG THIS PINS: a caller that publishes its own receipt (its own workspace id, its own marker on
   * the source, its own warning on refusal) had every target attached twice and announced twice. The
   * sidebar renders the duplicate announcement as two entries.
   */
  const attached = []
  const emitted = []
  const { ctx } = makeCtx()
  ctx.workspaceRegistry = {
    resolveByPath: async () => ({ id: 'ws', attachSession: async (id) => attached.push(id) }),
  }
  ctx.emit = (name, payload) => emitted.push({ name, payload })
  const session = createDshAdapters(ctx).session

  const receipt = await session.create({ cwd: '/tmp/project', title: 't', publish: false })
  assert.equal(receipt.ok, true, JSON.stringify(receipt.error ?? {}))
  assert.deepEqual(attached, [], 'the caller owns the attach')
  assert.equal(emitted.length, 0, 'the caller owns the announcement')
  assert.equal(receipt.workspaceAttached, false, 'and the receipt says so rather than claiming it happened')
  assert.equal(receipt.clientAnnounced, false)
})
