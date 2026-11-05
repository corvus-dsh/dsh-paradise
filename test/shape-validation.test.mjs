/**
 * THE SHAPE VALIDATOR — migrated from `dsh-observer/test/visibility.test.mjs` and `cold-inject.test.mjs`.
 *
 * WHY THESE CASES MOVED HERE RATHER THAN BEING DELETED
 *
 * Each one pins a shape defect that this ecosystem has actually shipped:
 *
 *   - an unattributable `user/message` (renders, but nothing says it is ours);
 *   - a `user/message` carrying a turn/step pair (a shape the host never writes);
 *   - a tape with no carrying message at all;
 *   - a tape whose first surface node is not the system head;
 *   - an open turn at the end (the session would not be asleep when born).
 *
 * The validator lives in `adapters/dsh/inject.ts` now, so the tests live next to it. Leaving them in
 * the plugin would have meant asserting against an archived module — certifying code that no longer
 * runs.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { paradiseInternals, writeShapeInternals } from '../index.js'

const { buildTape, materialiseTape, assertTape, InjectShapeError, BRIEFING_ID_PREFIX, describeRendered } =
  writeShapeInternals

/** A minimal valid shape, used as the base every case mutates. */
function baseShape(overrides = {}) {
  return {
    sessionId: 'session-shape',
    cwd: 'D:/work',
    text: 'the plan',
    title: 'a title',
    visibility: 'visible',
    origin: 'plugin:test:shape',
    systemPrompt: 'system head',
    ...overrides,
  }
}

function build(overrides = {}) {
  return materialiseTape(buildTape(baseShape(overrides)), 1000)
}

/* ── the happy path, so every failure below is contrastive ──────────────── */

test('shape: a valid tape passes the full validator', () => {
  const events = build()
  assert.doesNotThrow(() => assertTape({ events, sessionId: 'session-shape', cwd: 'D:/work', expectedText: 'the plan', visibility: 'visible' }))
})

/* ── provenance and visibility ──────────────────────────────────────────── */

test('shape: an unattributable user/message is REFUSED — provenance rides on the id', () => {
  /**
   * `source.kind` must be `'user'` for the renderer to show the message, so provenance CANNOT live
   * there. It lives on the id. A message with kind:user and no id would render and be unattributable —
   * indistinguishable from something the human typed.
   */
  const events = build()
  const carrying = events.find((event) => event.type === 'user/message')
  delete carrying.data.id
  assert.throws(
    () => assertTape({ events, sessionId: 'session-shape', cwd: 'D:/work', expectedText: 'the plan', visibility: 'visible' }),
    /RED_LINE_BRIEFING_PROVENANCE/u,
  )
})

test('shape: a user/message carrying turn/step is REFUSED — the host never writes that', () => {
  const events = build()
  const carrying = events.find((event) => event.type === 'user/message')
  carrying.data.turn = 1
  carrying.data.step = 1
  assert.throws(
    () => assertTape({ events, sessionId: 'session-shape', cwd: 'D:/work', expectedText: 'the plan', visibility: 'visible' }),
    /USER_MESSAGE_STEP_SCOPE/u,
  )
})

test('shape: an rpcId on our own message is REFUSED — that marks a real human prompt', () => {
  const events = build()
  const carrying = events.find((event) => event.type === 'user/message')
  carrying.data.source = { kind: 'user', rpcId: 'rpc-1' }
  assert.throws(
    () => assertTape({ events, sessionId: 'session-shape', cwd: 'D:/work', expectedText: 'the plan', visibility: 'visible' }),
    /RED_LINE_BRIEFING_PROVENANCE/u,
  )
})

test('shape: a developer-role briefing is legal, step-scoped, and has no echo', () => {
  const events = build({ visibility: 'context-only' })
  assert.doesNotThrow(() =>
    assertTape({ events, sessionId: 'session-shape', cwd: 'D:/work', expectedText: 'the plan', visibility: 'context-only' }),
  )
  const carrying = events.find((event) => event.type === 'developer/message')
  assert.ok(carrying !== undefined, 'context-only content is a developer/message')
  assert.equal(carrying.data.turn, 1, 'a developer/message IS step-scoped, unlike a user/message')
  assert.equal(
    events.some((event) => event.type === 'assistant/message'),
    false,
    'no echo: context-only content has nothing to mirror into the transcript',
  )
})

test('shape: a tape with NO carrying message is refused by ROLE', () => {
  const events = build().filter(
    (event) => event.type !== 'user/message' && event.type !== 'assistant/message',
  )
  // reseq so the failure is about the missing message, not about a gap
  events.forEach((event, index) => {
    event.seq = index
  })
  assert.throws(
    () => assertTape({ events, sessionId: 'session-shape', cwd: 'D:/work', expectedText: 'the plan', visibility: 'visible' }),
    /MISSING_BRIEFING/u,
  )
})

/* ── the skeleton ───────────────────────────────────────────────────────── */

test('shape: the first SURFACE node must be the system head', () => {
  const events = build()
  const systemIndex = events.findIndex((event) => event.type === 'system/message')
  const [system] = events.splice(systemIndex, 1)
  // put it AFTER the carrying message: still a legal position in the turn, but no longer the head
  events.splice(events.indexOf(events.find((event) => event.type === 'user/message')) + 1, 0, system)
  events.forEach((event, index) => {
    event.seq = index
  })
  assert.throws(
    () => assertTape({ events, sessionId: 'session-shape', cwd: 'D:/work', expectedText: 'the plan', visibility: 'visible' }),
    /RED_LINE_SYSTEM_HEAD/u,
  )
})

test('shape: an OPEN turn is refused — the session must be born asleep', () => {
  const events = build()
  events.pop() // remove turn/end
  events.forEach((event, index) => {
    event.seq = index
  })
  assert.throws(
    () => assertTape({ events, sessionId: 'session-shape', cwd: 'D:/work', expectedText: 'the plan', visibility: 'visible' }),
    /SKELETON_OPEN/u,
  )
})

test('shape: a turn/end that is not "completed" is refused', () => {
  const events = build()
  const end = events.find((event) => event.type === 'turn/end')
  end.data.reason = { kind: 'aborted' }
  assert.throws(
    () => assertTape({ events, sessionId: 'session-shape', cwd: 'D:/work', expectedText: 'the plan', visibility: 'visible' }),
    /SKELETON/u,
  )
})

test('shape: surfaceOp lands on messages only, and seq/time are contiguous', () => {
  const events = build()
  const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message'])
  events.forEach((event, index) => {
    assert.equal(event.seq, index)
    if (SURFACE.has(event.type)) assert.equal(event.surfaceOp, 'append', `${event.type} needs surfaceOp`)
    else assert.equal(event.surfaceOp, undefined, `${event.type} must not carry surfaceOp`)
    if (index > 0) assert.ok(event.time >= events[index - 1].time)
  })
})

test('shape: a standalone tool/result is refused', () => {
  const events = build()
  events.splice(1, 0, { type: 'tool/result', seq: 0, time: 0, data: {} })
  events.forEach((event, index) => {
    event.seq = index
  })
  assert.throws(
    () => assertTape({ events, sessionId: 'session-shape', cwd: 'D:/work', expectedText: 'the plan', visibility: 'visible' }),
    /RED_LINE_TOOL_RESULT/u,
  )
})

/* ── the guards that run before anything is built ──────────────────────── */

test('shape: EMPTY content is refused — a session with no content is the bug, not a fallback', () => {
  assert.throws(() => buildTape(baseShape({ text: '   ' })), /EMPTY_CONTENT/u)
})

test('shape: a relative cwd is refused when BUILDING the tape', () => {
  assert.throws(() => buildTape(baseShape({ cwd: 'relative/path' })), /CWD_INVALID/u)
})

test('shape: content with no plugin provenance is refused', () => {
  assert.throws(() => buildTape(baseShape({ origin: '' })), /ORIGIN_REQUIRED/u)
  assert.throws(() => buildTape(baseShape({ origin: 'not-a-plugin-marker' })), /ORIGIN_REQUIRED/u)
})

test('shape: every refusal carries a code AND a stage', () => {
  try {
    buildTape(baseShape({ text: '' }))
    assert.fail('should have thrown')
  } catch (error) {
    assert.equal(error instanceof InjectShapeError, true)
    assert.equal(typeof error.code, 'string')
    assert.equal(typeof error.stage, 'string')
    assert.ok(error.code.length > 0 && error.stage.length > 0)
  }
})

test('shape: the carrying message id carries the documented prefix', () => {
  const events = build()
  const carrying = events.find((event) => event.type === 'user/message')
  assert.equal(carrying.data.id.startsWith(BRIEFING_ID_PREFIX), true)
})

/* ── the renderer's answer, reported not assumed ───────────────────────── */

test('shape: describeRendered reads the TAPE, not the request', () => {
  const visible = build()
  assert.equal(describeRendered(visible, 'x').rendered, true)
  const invisible = build({ visibility: 'context-only' })
  const answer = describeRendered(invisible, 'x')
  assert.equal(answer.rendered, false)
  assert.ok(answer.reason.length > 0, 'a demoted item explains itself')
})

test('paradise still exposes the write machinery its dependents call', () => {
  assert.equal(typeof paradiseInternals.deleteSession, 'function')
  assert.equal(typeof paradiseInternals.createDshAdapters, 'function')
})
