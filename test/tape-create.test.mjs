/**
 * THE CALLER-SUPPLIED TAPE — the path a plugin takes when it owns richer content than `items` can say.
 *
 * WHY THIS CONTRACT NEEDS ITS OWN TESTS
 *
 * `graft-slice` injects a replayed conversation: history turns, a task board, provenance metadata. It
 * cannot be expressed as "one ContextItem", and flattening it into one would push graft's POLICY into
 * this layer. So `create` accepts a pre-built tape — and the moment it does, the interesting questions
 * are about what the ADAPTER still refuses:
 *
 *   - an illegal tape is rejected BEFORE anything is written;
 *   - the adapter assigns seq/time and the per-event metadata, not the caller;
 *   - the cold-read expectation comes from what was WRITTEN, not from the request.
 *
 * The last one is subtle and was a real bug: the post-write validator compared the persisted log against
 * `items[0].text`, which on the tape path is the empty string.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { paradiseInternals } from '../index.js'

const { createDshAdapters } = paradiseInternals

/** A minimal host good enough for the cold path: prepare, create/append/flush/close, stat, readSession. */
function makeCtx() {
  const prepared = { header: { cwd: '/tmp/project', isSeeded: false, createdAt: Date.now() } }
  const persisted = new Map()
  return {
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
        remove: async (id) => persisted.delete(id),
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
    },
  }
}

/** A well-formed replay tape: closed skeleton, system head first, one visible carrying message. */
function replayTape(text) {
  return [
    { type: 'turn/start', data: { turn: 1 }, surface: false },
    { type: 'step/start', data: { turn: 1, step: 1 }, surface: false },
    {
      type: 'system/message',
      data: {
        turn: 1,
        step: 1,
        message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'head' }], source: { kind: 'system-prompt' } },
      },
      surface: true,
    },
    {
      type: 'user/message',
      data: { id: 'graft-goal', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
      surface: true,
    },
    {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'echo',
          role: 'assistant',
          content: [{ type: 'text', text }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
        stream: [],
      },
      surface: true,
    },
    { type: 'session/title', data: { title: 'handoff', messageSeqs: [], source: { kind: 'user' } }, surface: false },
    { type: 'step/end', data: { turn: 1, step: 1 }, surface: false },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, surface: false },
  ]
}

test('tape: a caller-supplied tape is written verbatim, in the caller order', async () => {
  const { ctx, persisted } = makeCtx()
  const session = createDshAdapters(ctx).session
  const tape = replayTape('the replayed goal')

  const receipt = await session.create({ cwd: '/tmp/project', title: 'from tape', tape })
  assert.equal(receipt.ok, true, JSON.stringify(receipt.error ?? {}))
  assert.equal(receipt.stage, 'create_success')

  const events = persisted.get(receipt.session.id).events
  assert.deepEqual(
    events.map((event) => event.type),
    tape.map((seed) => seed.type),
    'the caller defined the shape of the content, and the adapter kept it',
  )
})

test('tape: the adapter still assigns seq, time, and per-event metadata', async () => {
  const { ctx, persisted } = makeCtx()
  const session = createDshAdapters(ctx).session
  const receipt = await session.create({ cwd: '/tmp/project', title: 't', tape: replayTape('goal') })
  const events = persisted.get(receipt.session.id).events

  events.forEach((event, index) => {
    assert.equal(event.seq, index, `event ${index} must carry its position`)
    if (index > 0) assert.ok(event.time >= events[index - 1].time, 'time is monotonic')
  })
  const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message'])
  for (const event of events) {
    if (SURFACE.has(event.type)) assert.equal(event.surfaceOp, 'append', `${event.type} needs the surface marker`)
    else assert.equal(event.surfaceOp, undefined, `${event.type} must not carry it`)
  }
})

test('tape: the cold read is checked against WHAT WAS WRITTEN, not against empty items', async () => {
  /**
   * THE BUG THIS PINS: the post-write validator used the `items` text. On the tape path `items` is empty,
   * so a perfectly good write was compared against `''` and failed — a false negative in the one check
   * that exists to catch false positives.
   */
  const { ctx } = makeCtx()
  const session = createDshAdapters(ctx).session
  const receipt = await session.create({ cwd: '/tmp/project', title: 't', tape: replayTape('a very specific goal') })

  assert.equal(receipt.ok, true, JSON.stringify(receipt.error ?? {}))
  assert.equal(receipt.verified, true, 'the cold read matched')
  assert.equal(receipt.rendered.length, 1)
  assert.equal(receipt.rendered[0].rendered, true, 'the carrying message is visible')
})

test('tape: an ILLEGAL tape is refused before anything is written', async () => {
  const { ctx, persisted } = makeCtx()
  const session = createDshAdapters(ctx).session

  const broken = replayTape('goal').filter((seed) => seed.type !== 'turn/end')
  const receipt = await session.create({ cwd: '/tmp/project', title: 't', tape: broken })

  assert.equal(receipt.ok, false, 'an open turn must not be written')
  assert.equal(persisted.size, 0, 'nothing was reserved')
})

test('tape: a tape whose first surface node is not the system head is refused', async () => {
  const { ctx, persisted } = makeCtx()
  const session = createDshAdapters(ctx).session

  const reordered = (() => {
    const tape = replayTape('goal')
    const systemIndex = tape.findIndex((seed) => seed.type === 'system/message')
    const [system] = tape.splice(systemIndex, 1)
    tape.splice(tape.findIndex((seed) => seed.type === 'user/message') + 1, 0, system)
    return tape
  })()

  const receipt = await session.create({ cwd: '/tmp/project', title: 't', tape: reordered })
  assert.equal(receipt.ok, false)
  assert.match(receipt.error.message, /SYSTEM_HEAD|surface/u)
  assert.equal(persisted.size, 0)
})

test('tape: a bad cwd is refused before the tape is even examined', async () => {
  const { ctx, persisted } = makeCtx()
  const session = createDshAdapters(ctx).session
  const receipt = await session.create({ cwd: 'relative/path', title: 't', tape: replayTape('goal') })
  assert.equal(receipt.ok, false)
  assert.equal(receipt.error.code, 'CWD_REQUIRED')
  assert.equal(persisted.size, 0)
})

test('tape: when both tape and items are given, the TAPE wins', async () => {
  const { ctx, persisted } = makeCtx()
  const session = createDshAdapters(ctx).session
  const receipt = await session.create({
    cwd: '/tmp/project',
    title: 't',
    items: [{ visibility: 'visible', text: 'IGNORED', origin: 'plugin:test:item' }],
    tape: replayTape('the tape wins'),
  })
  assert.equal(receipt.ok, true, JSON.stringify(receipt.error ?? {}))
  const events = persisted.get(receipt.session.id).events
  const carrying = events.find((event) => event.type === 'user/message')
  assert.equal(carrying.data.content[0].text, 'the tape wins')
  assert.equal(
    JSON.stringify(events).includes('IGNORED'),
    false,
    'the item text must not leak into the artifact',
  )
})
