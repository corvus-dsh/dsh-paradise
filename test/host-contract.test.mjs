/**
 * dsh-paradise — THE HOST CONTRACT: capability probing, service resolution, errors, and the
 * P2 contract that must never claim success.
 *
 * WHY THESE ARE TESTS AND NOT DOCUMENTATION
 *
 * The draft (§6.1) reduces the two existing implementations to seven unified rules. Six of them are
 * about the write layer (P2), but two are already load-bearing here: **resolve by the method about to
 * be called** (rule 5) and **errors carry code + stage + stack** (rule 4). Both failed in production
 * before, so both get pinned now, while the layer they belong to is being built.
 *
 * The third group below pins the opposite failure: a P2 stub that answers `ok: true`. It must throw.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CARRYING_MESSAGE_RULE,
  ParadiseError,
  ParadiseUnavailableError,
  UNIFIED_RULES,
  WRITE_LAYER_PHASE,
  asParadiseError,
  isRenderedByConversation,
  probeCapabilities,
  resolveService,
  writeNotImplemented,
} from '../index.js'
/** The whole entry, for the surface assertions (a named import cannot ask "is this absent?"). */
import * as paradiseEntry from '../index.js'

/* ── rule 5: resolve by the method about to be called ────────────────────── */

test('resolve: a service mounted only through ctx.get is found', () => {
  const ctx = { get: (name) => (name === 'sessions' ? { prepare() {} } : undefined) }
  assert.equal(typeof resolveService(ctx, 'sessions', 'prepare')?.prepare, 'function')
})

test('resolve: a service mounted only as a direct property is found', () => {
  const ctx = { sessions: { prepare() {} } }
  assert.equal(typeof resolveService(ctx, 'sessions', 'prepare')?.prepare, 'function')
})

test('resolve: the METHOD decides, not the position', () => {
  /**
   * THE REAL INCIDENT: the direct property carried only `register`, `get('tools')` carried `execute`.
   * Resolving positionally picked the direct property and then called `execute` on it — which read
   * like "the service is missing" for an hour.
   */
  const direct = { register() {} }
  const viaGet = { register() {}, execute() {} }
  const ctx = { tools: direct, get: (name) => (name === 'tools' ? viaGet : undefined) }

  assert.equal(resolveService(ctx, 'tools', 'execute'), viaGet, 'the candidate that HAS execute wins')
  assert.equal(resolveService(ctx, 'tools', 'register'), direct, 'and the other call resolves the other way')
})

test('resolve: a throwing getter is simply not a candidate', () => {
  const ctx = {
    get: () => {
      throw new Error('nope')
    },
    sessions: { prepare() {} },
  }
  assert.equal(typeof resolveService(ctx, 'sessions', 'prepare')?.prepare, 'function')
})

test('resolve: no candidate at all is undefined, never a fabricated object', () => {
  assert.equal(resolveService({}, 'sessions', 'prepare'), undefined)
})

/* ── capability probing: what this host can do, and what it costs ─────────── */

test('capabilities: a bare ctx reports everything missing, with a consequence for each', () => {
  const capabilities = probeCapabilities({})
  assert.equal(capabilities.can.prepareCold, false)
  assert.equal(capabilities.can.persistenceCreate, false)
  assert.equal(capabilities.can.readSession, false)
  assert.equal(capabilities.unavailable.length, capabilities.unavailable.length)
  for (const item of capabilities.unavailable) {
    assert.ok(item.capability.length > 0, 'the capability is named')
    assert.ok(item.consequence.length > 0, 'and the consequence is stated, not implied')
  }
})

test('capabilities: a fully mounted host reports every probed capability', () => {
  const ctx = {
    sessions: { prepare() {} },
    sessionPersistence: { create() {}, open() {}, stat() {}, discardPrepared() {} },
    sessionQuery: { readSession() {} },
    workspaceRegistry: { resolveByPath() {} },
    sessionController: { prompt() {} },
    emit() {},
  }
  const capabilities = probeCapabilities(ctx)
  assert.deepEqual(Object.values(capabilities.can).filter((value) => value !== true), [], 'nothing is missing')
  assert.deepEqual(capabilities.unavailable, [])
})

test('capabilities: a partial host names EXACTLY what is missing', () => {
  const ctx = {
    sessions: { prepare() {} },
    sessionPersistence: { create() {}, open() {} },
    sessionQuery: { readSession() {} },
    emit() {},
  }
  const capabilities = probeCapabilities(ctx)
  const missing = capabilities.unavailable.map((item) => item.capability)
  assert.ok(missing.includes('sessionPersistence.stat'), 'stat is missing')
  assert.ok(missing.includes('workspaceRegistry.resolveByPath'), 'workspace attach is missing')
  assert.ok(missing.includes('sessionController.prompt'), 'ignition is missing')
  assert.equal(missing.includes('sessions.prepare'), false, 'what IS present is not reported missing')
})

test('capabilities: the read layer needs nothing, and that is stated', () => {
  // The whole point of P1: a profile with NO session services still gets the disk reader.
  const capabilities = probeCapabilities({})
  assert.equal(capabilities.can.readSession, false)
  // Nothing in read/ consults capabilities, which is why the layer works anyway.
  assert.equal(typeof probeCapabilities, 'function')
})

/* ── rule 4: errors carry code + stage + stack ───────────────────────────── */

test('errors: a ParadiseError carries code, stage and the code inside the message', () => {
  const error = new ParadiseError('CWD_REQUIRED', 'locate', '拒绝创建没有归属的会话')
  assert.equal(error.code, 'CWD_REQUIRED')
  assert.equal(error.stage, 'locate')
  assert.match(error.message, /\[CWD_REQUIRED\]/u, 'the code is greppable in the host log')
})

test('errors: wrapping preserves the ORIGINAL stack', () => {
  const original = new Error('the real cause')
  const wrapped = asParadiseError(original, 'WRITE_FAILED', 'append')
  assert.equal(wrapped.code, 'WRITE_FAILED')
  assert.equal(wrapped.stage, 'append')
  assert.match(wrapped.stack, /the real cause/u)
  assert.match(String(wrapped.stack), /original stack/u, 'the original stack travels separately')
  assert.equal(wrapped.cause, original)
})

test('errors: an already-paradise error is not wrapped twice', () => {
  const first = new ParadiseError('A', 'append', 'one')
  assert.equal(asParadiseError(first, 'B', 'flush'), first, 'the original code and stage survive')
})

test('errors: the missing-layer error names the CONSEQUENCE', () => {
  const error = new ParadiseUnavailableError('dsh-paradise 未安装', '磁盘核对不可用，冷读结论仍有效')
  assert.equal(error.code, 'PARADISE_UNAVAILABLE')
  assert.match(error.consequence, /磁盘核对不可用/u, 'the caller can decide how to degrade')
})

/* ── the P2 contract: it must THROW, never answer ok:true ───────────────── */

test('P2 contract: the write layer says which phase it belongs to', () => {
  assert.equal(WRITE_LAYER_PHASE, 'P2')
})

test('P2 contract: an unimplemented write path THROWS instead of faking success', () => {
  assert.throws(
    () => writeNotImplemented('createSession'),
    (error) => error instanceof ParadiseError && error.code === 'NOT_IMPLEMENTED' && /P2/u.test(error.message),
    'an unimplemented path that returns ok:true is the exact lie this ecosystem removes',
  )
})

/**
 * ── 批次 D (2026-11-09): THIS TEST USED TO ASSERT A STATE THAT NO LONGER EXISTED ────────────────
 *
 * It read `assert.throws(() => publishNotImplemented())` and was titled "publishing is unimplemented
 * too". That had been false for several releases: the real publishing runs inside the write path
 * (`session-writer.ts`, `stage = 'publish'`) — workspace resolve/create/attach plus the
 * `api-session/added` announcement, with failures collected in `warnings`. The assertion survived
 * because it tested a helper nobody called: it certified nothing while reading like contract coverage.
 *
 * The replacement asserts what is TRUE and checkable without a mounted host: the publishing stage's
 * contract is EXPRESSED AS A TYPE the write receipt extends, and the fake thrower is gone from the
 * public surface. `write-lifecycle.test.mjs` and `caller-contract.test.mjs` cover the behaviour end to
 * end against a real context.
 */
test('publish: the stage is implemented — its contract is the receipt type, not a thrower', () => {
  const entry = Object.keys(paradiseEntry)
  assert.equal(
    entry.includes('publishNotImplemented'),
    false,
    'publishNotImplemented must NOT be exported: publishing is implemented inline in the write path, ' +
      'and a thrower advertising the opposite is how readers conclude a feature does not exist',
  )
  assert.ok(
    entry.includes('PUBLISH_CAPABILITIES'),
    'the capability names stay exported: a caller must still be able to ask what publishing needs',
  )
})

test('P2 contract: the seven unified rules are enumerable, so a cross-plugin test can walk them', () => {
  assert.equal(UNIFIED_RULES.length, 7, 'draft §6.1 lists exactly seven')
  const ids = UNIFIED_RULES.map((rule) => rule.id)
  assert.deepEqual(ids, [
    'verify-full',
    'delete-verified',
    'cold-markable',
    'error-stage',
    'resolve-by-method',
    'ignite-separate',
    'message-visible',
  ])
  for (const rule of UNIFIED_RULES) {
    assert.ok(rule.rule.length > 0, `${rule.id} must state its rule`)
    assert.ok(rule.source.length > 0, `${rule.id} must name where the stricter behaviour came from`)
  }
})

test('P2 contract: the carrying message defaults to the VISIBLE type', () => {
  assert.equal(CARRYING_MESSAGE_RULE.defaultType, 'user/message', 'v1.3.0 wrote developer/message and it was invisible')
  assert.ok(CARRYING_MESSAGE_RULE.visibleRoles.includes('user'))
  assert.ok(CARRYING_MESSAGE_RULE.invisibleRoles.includes('developer'))
  assert.equal(CARRYING_MESSAGE_RULE.markerPrefix, 'plugin:')
})

/* ── the render policy is REPORT-ONLY ───────────────────────────────────── */

test('policy: only user/message and assistant/message are reported as rendered', () => {
  assert.equal(isRenderedByConversation('user/message'), true)
  assert.equal(isRenderedByConversation('assistant/message'), true)
  assert.equal(isRenderedByConversation('developer/message'), false, 'this is the v1.3.0 bug, pinned')
  assert.equal(isRenderedByConversation('system/message'), false)
  assert.equal(isRenderedByConversation('tool/result'), false)
  assert.equal(isRenderedByConversation(undefined), false)
})
