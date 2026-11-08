/**
 * P1-3 (audit 2026-11-08) — THE `api-session/added` PAYLOAD IS A WIRE CONTRACT, AND THIS LOCKS IT.
 *
 * WHY THIS GUARD EXISTS AT ALL, GIVEN THAT NO CURRENT CALLER CAN TRIP IT
 *
 * `assertSessionSummary` cannot fail on any payload this repository emits today: `sessionId` is
 * either the caller's trimmed non-empty id or `session-<uuid>`, and `createdAt` is
 * `Number.isFinite(Number(options.createdAt)) ? … : Date.now()`. So a behavioural test that drives
 * the writer into a bad summary is IMPOSSIBLE — the input cannot be constructed. Saying that plainly
 * matters more than a green test that pretends otherwise.
 *
 * What can be tested, and what this file tests, is therefore two different things:
 *
 *   1. THE PREDICATE's contract, directly — what it accepts and, above all, what it refuses. That is
 *      the part a future caller depends on.
 *   2. THE CALL SITE's structure — that the emit is REACHABLE ONLY THROUGH the guard, and that the
 *      refusal path is REPORTED (`warnings.push`) rather than silent. A guard that exists but does not
 *      gate the emit is the failure mode worth freezing against, and it is invisible at runtime
 *      precisely because nothing can trip it today.
 *
 * The emission itself is still covered end-to-end by `test/caller-contract.test.mjs`, which asserts
 * one `api-session/added` reaches the host on a real write — this file must not duplicate it, or a
 * refactor could pass here while breaking the announcement there.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertSessionSummary } from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))
const writerSource = readFileSync(join(here, '..', 'src', 'adapters', 'dsh', 'session-writer.ts'), 'utf8')

/** The payload the writer builds, exactly as the host's `summarizeCold` shapes a session. */
const validSummary = {
  sessionId: 'session-abc',
  updatedAt: 1_700_000_000_000,
  agentAvailable: false,
  formatStatus: 'current',
  running: false,
  blank: false,
  cwd: 'D:\\work',
}

test('P1-3: a well-formed cold summary is accepted', () => {
  assert.equal(assertSessionSummary(validSummary), true)
  // The minimum a client can key by, without any optional field.
  assert.equal(assertSessionSummary({ sessionId: 's', updatedAt: 0 }), true)
})

test('P1-3: a sessionId the client cannot key by is refused', () => {
  /**
   * `resources.session = (summary) => summary.sessionId` is the transport's routing key and
   * `mergeSummary`'s row key. `assertJsonArgs` accepts all of the payloads below, so without this
   * predicate each one reaches the peer as an undefined key — silently.
   */
  for (const sessionId of [undefined, null, '', 0, 42, false, {}, []]) {
    assert.equal(
      assertSessionSummary({ ...validSummary, sessionId }),
      false,
      `sessionId=${JSON.stringify(sessionId)} must be refused`,
    )
  }
})

test('P1-3: an updatedAt that is not a finite number is refused', () => {
  /**
   * `NaN` and `Infinity` are the two that a plain `typeof === 'number'` check would wave through —
   * and `NaN` is exactly what a damaged header produces (`typeof NaN === 'number'`). The client
   * sorts and de-duplicates the sidebar by this field.
   */
  for (const updatedAt of [undefined, null, '', '1700000000000', Number.NaN, Number.POSITIVE_INFINITY, {}, []]) {
    assert.equal(
      assertSessionSummary({ ...validSummary, updatedAt }),
      false,
      `updatedAt=${String(updatedAt)} must be refused`,
    )
  }
})

test('P1-3: a non-object payload is refused rather than throwing', () => {
  for (const payload of [undefined, null, 'summary', 7, true]) {
    assert.equal(assertSessionSummary(payload), false, `${String(payload)} must be refused`)
  }
})

test('P1-3 STATIC: the emit is reachable ONLY through the guard, and refusal is reported', () => {
  const emitAt = writerSource.indexOf("ctx.emit('api-session/added'")
  assert.notEqual(emitAt, -1, 'the writer must still announce the session to the client')

  const guardAt = writerSource.lastIndexOf('assertSessionSummary(', emitAt)
  assert.notEqual(guardAt, -1, 'the emit must be preceded by assertSessionSummary(summary)')
  assert.ok(guardAt < emitAt, 'the guard must run BEFORE the emit')

  const between = writerSource.slice(guardAt, emitAt)
  assert.match(
    between,
    /^assertSessionSummary\(summary\)/u,
    'the guard must inspect the SAME object that is emitted — not a differently-built one',
  )
  assert.match(between, /\}\s*else\s*\{/u, 'the emit must sit in the else branch of the guard')
  assert.match(between, /warnings\.push\(/u, 'a skipped announcement must be reported, never silent')
  assert.match(
    writerSource.slice(Math.max(0, emitAt - 12), emitAt + 45),
    /ctx\.emit\('api-session\/added', summary\)/u,
    'the payload must be the named object the guard checked',
  )
})
