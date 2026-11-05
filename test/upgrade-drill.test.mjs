/**
 * THE UPGRADE DRILL — a missing host API must be a NAMED refusal that names the file to edit.
 *
 * WHY THIS FILE EXISTS
 *
 * This ecosystem has been broken three times by a host upgrade removing or reshaping a method, and each
 * time the symptom appeared far from the cause: the cold write path silently lost its reservation, every
 * ignition died on a signature change, a service was visible on one accessor but not the other. What all
 * three had in common is that NOTHING refused: a capability quietly switched off.
 *
 * So the assertion is tested from both directions:
 *   - a context missing one API names THAT api, its CONSEQUENCE, and the FILE to edit;
 *   - a fully mounted context says nothing.
 *
 * The strict/lenient split is also pinned, because deleting the lenient path would break the conformance
 * property that a host with nothing mounted reports `false` rather than throwing.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  apply,
  createDshAdapters,
  probeHostCapabilities,
  assertHostCapabilities,
  REQUIRED_HOST_CAPABILITIES,
} from '../index.js'

/** A context with every API the table asks for. */
function mountedCtx() {
  return {
    sessions: { prepare: () => ({ header: {} }), get: () => undefined },
    sessionPersistence: {
      create: async () => ({ append: async () => {}, flush: async () => {}, close: async () => {} }),
      stat: async () => undefined,
    },
    sessionQuery: { readSession: async () => ({ session: {}, events: [] }) },
    sessionController: { prompt: async () => ({ accepted: true }) },
    on: () => () => {},
    emit: () => {},
  }
}

test('drill: a fully mounted host asserts clean', () => {
  const assertion = probeHostCapabilities(mountedCtx())
  assert.equal(assertion.ok, true, assertion.message)
  assert.deepEqual(assertion.missing, [])
  assert.equal(assertion.message, '')
})

test('drill: a missing API is named, with its CONSEQUENCE and the FILE to edit', () => {
  /**
   * THE DSH UPGRADE SIMULATION: `sessionPersistence.create` is gone, which is the exact change the user
   * described. The refusal must tell an AI where to go, not merely that something is wrong.
   */
  const ctx = mountedCtx()
  delete ctx.sessionPersistence.create

  const assertion = probeHostCapabilities(ctx)
  assert.equal(assertion.ok, false)
  assert.equal(assertion.missing.length, 1)
  const [entry] = assertion.missing
  assert.equal(entry.service, 'sessionPersistence')
  assert.equal(entry.method, 'create')
  assert.equal(entry.editIn, 'src/adapters/dsh/session-writer.ts', 'the file to edit must be named')
  assert.match(assertion.message, /HOST_CAPABILITY_MISSING/u)
  assert.match(assertion.message, /sessionPersistence\.create/u)
  assert.match(assertion.message, /session-writer\.ts/u, 'the message carries the edit target')
  assert.match(assertion.message, /协议层不需要改/u, 'and says the protocol layer is not the place to fix it')
})

test('drill: EVERY missing API is reported at once, not just the first', () => {
  /**
   * One-at-a-time reporting turns a single upgrade into a sequence of round trips: fix, restart, discover
   * the next one. The whole list is the point of an assertion that runs at startup.
   */
  const ctx = { on: () => () => {} }
  const assertion = probeHostCapabilities(ctx)
  assert.equal(assertion.ok, false)
  assert.equal(
    assertion.missing.length,
    REQUIRED_HOST_CAPABILITIES.length,
    'an empty context is missing every required API',
  )
  for (const entry of assertion.missing) {
    assert.equal(typeof entry.editIn, 'string')
    assert.equal(entry.editIn.length > 0, true)
    assert.equal(typeof entry.consequence, 'string')
  }
})

test('drill: strict THROWS the named refusal; lenient returns it', () => {
  const ctx = mountedCtx()
  delete ctx.sessionController.prompt

  assert.throws(
    () => assertHostCapabilities(ctx, { strict: true }),
    (error) => {
      assert.equal(error.name, 'ParadiseError')
      assert.equal(error.code, 'HOST_CAPABILITY_MISSING')
      assert.match(error.message, /trigger\.ts/u, 'the ignition file is the one to edit')
      return true
    },
    'a strict assertion must refuse rather than switch the capability off',
  )

  const lenient = assertHostCapabilities(ctx, {})
  assert.equal(lenient.ok, false, 'the lenient path still REPORTS — it just does not throw')
})

test('drill: createDshAdapters is lenient by default and strict on request', () => {
  /**
   * THE DEFAULT MATTERS. The capability probe and the conformance suite build adapters from `{}` to prove
   * that a host with nothing mounted reports `false` rather than pretending; a throwing default would
   * delete that property, which is why the drill is opt-in.
   */
  const bare = createDshAdapters({})
  assert.equal(bare.session.capabilities.create, false, 'lenient: reports, does not throw')

  assert.throws(
    () => createDshAdapters({}, { strict: true }),
    /HOST_CAPABILITY_MISSING/u,
    'strict: refuses at construction, which is the upgrade drill',
  )

  const mounted = createDshAdapters(mountedCtx(), { strict: true })
  assert.equal(mounted.session.capabilities.create, true)
})

test('drill: BOOT is strict BY DEFAULT — an upgraded host missing an API refuses to mount', () => {
  /**
   * THE POINT OF THE WHOLE MECHANISM, PINNED AT THE ONE MOMENT THAT MATTERS.
   *
   * After a host upgrade, `apply()`/`activate()` is the FIRST of our code to see the new API surface. If
   * strictness lived only behind a flag there, the drill would work solely when someone remembered to
   * pass it — which is not a drill, it is a hope.
   *
   * SIMULATED UPGRADE: `sessionPersistence.create` is gone. Mounting must THROW, not log a warning.
   */
  const upgraded = mountedCtx()
  delete upgraded.sessionPersistence.create
  const logger = { info: [], warn: [], error: [] }

  assert.throws(
    () => apply({ ...upgraded, logger: { info: (m) => logger.info.push(m), warn: (m) => logger.warn.push(m), error: (m) => logger.error.push(m) } }),
    (error) => {
      assert.equal(error.name, 'ParadiseError')
      assert.equal(error.code, 'HOST_CAPABILITY_MISSING')
      assert.match(error.message, /sessionPersistence\.create/u)
      assert.match(error.message, /session-writer\.ts/u, 'the refusal still names the file to edit')
      return true
    },
  )
  assert.equal(
    logger.error.length,
    1,
    'the refusal is logged with the instruction intact, not swallowed',
  )

  // A FULLY MOUNTED host mounts cleanly and says so.
  const healthy = { ...mountedCtx(), logger: { info: () => {}, warn: () => {}, error: () => {} } }
  assert.doesNotThrow(() => apply(healthy))
})

test('drill: PARADISE_STRICT_HOST=0 opts a deliberately bare profile out of the boot refusal', () => {
  /**
   * THE ESCAPE HATCH, because the strict default must not make a legitimately bare profile unmountable.
   * The opt-out is explicit and is itself logged — a profile running without the write services should be
   * able to see that it is doing so.
   */
  const previous = process.env.PARADISE_STRICT_HOST
  try {
    process.env.PARADISE_STRICT_HOST = '0'
    const warnings = []
    const bare = { logger: { info: () => {}, warn: (m) => warnings.push(m), error: () => {} } }
    assert.doesNotThrow(() => apply(bare), 'the override turns the boot refusal off')
    assert.match(
      warnings.join(' '),
      /MISSING required API/u,
      'and the missing APIs are still REPORTED, so the opt-out is never silent',
    )
  } finally {
    if (previous === undefined) delete process.env.PARADISE_STRICT_HOST
    else process.env.PARADISE_STRICT_HOST = previous
  }
})
