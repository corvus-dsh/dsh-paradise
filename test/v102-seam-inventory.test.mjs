/**
 * THE TWO `…Internals` EXPORTS — one seam, one cross-repository contract.
 *
 * ── WHY THIS FILE MATTERS MORE THAN A NAME LIST (批次 3 第 1 组, 2026-11-08) ────────────────────
 *
 * The audit bucketed both of these as "test-only exposure". The evidence says otherwise for one of
 * them, and the difference decides whether it is safe to touch:
 *
 *   `writeShapeInternals`  → TEST-ONLY. One test file. Free to fold or rename with the tests.
 *   `paradiseInternals`    → **A CONTRACT WITH A SIBLING'S PRODUCTION CODE.**
 *                            `dsh-graft-slice/src/core/paradise-write.ts` reads
 *                            `mod.paradiseInternals.VERSION` to report the layer version it loaded,
 *                            and `scripts/preflight.mjs` asserts the object exists.
 *
 * AND THE ACCESS IS OPTIONAL-CHAINED, which is the part worth pinning: `?(...)` means a rename or a
 * fold does NOT throw. Graft would simply stop reporting a version — a field vanishing from a receipt
 * that nothing else verifies. A name-only inventory lock would not notice; therefore this file also
 * asserts the FIELD the contract depends on.
 *
 * LOCK RULE (proportionate and stated across the four bundles): the FULL surface is pinned where it is
 * small enough to read (dsh-observer 16, dsh-memory 31); the seam-shaped SUBSET is pinned where the
 * entry is large — paradise exports 97 names.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as entry from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')

/** The only true test seam in this bundle. */
const TEST_ONLY_SEAMS = ['writeShapeInternals']

/** Exported for tests AND consumed outside them — pinned so nobody folds it as a seam. */
const CROSS_REPO_CONTRACT = ['paradiseInternals']

const seamShaped = (name) =>
  /ForTest$/u.test(name) || /^debug/u.test(name) || /Internals$/u.test(name) || /CacheStats$/u.test(name) || /^clear[A-Z]/u.test(name) || /^reset[A-Z]/u.test(name) || /^invalidate[A-Z]/u.test(name)

test('every seam-SHAPED export is registered — and the categories stay distinct', () => {
  const registered = [...TEST_ONLY_SEAMS, ...CROSS_REPO_CONTRACT]
  const unregistered = Object.keys(entry).filter((name) => seamShaped(name) && !registered.includes(name))
  assert.deepEqual(unregistered, [], `unregistered seam-shaped export(s): ${unregistered.join(', ')}`)
  for (const name of registered) {
    assert.ok(name in entry, `${name} is registered but no longer exported`)
  }
})

test('the cross-repository contract still carries the field graft reads', () => {
  /**
   * THE ASSERTION THE AUDIT'S BUCKET WOULD HAVE MISSED. Graft reads `paradiseInternals.VERSION`
   * through an optional chain, so this is the only place the contract can actually fail loudly.
   */
  assert.equal(
    typeof entry.paradiseInternals?.VERSION,
    'string',
    'dsh-graft-slice reads paradiseInternals.VERSION to report the loaded layer version; ' +
      'an optional-chained read means a missing field is silent, so it is pinned here',
  )
  assert.ok(entry.paradiseInternals.VERSION.length > 0, 'and a version must not be the empty string')
})

test('the test seam is still reachable and callable for its suite', () => {
  assert.equal(typeof entry.writeShapeInternals, 'object', 'writeShapeInternals must stay exported as an object')
  assert.notEqual(entry.writeShapeInternals, null)
})

test('the boundary is DOCUMENTED in the source, including the cross-repo half', () => {
  assert.match(source, /THE TWO `…Internals` EXPORTS/u, 'the boundary block must stay in src/index.ts')
  assert.match(source, /IS NOT\. It is a CROSS-REPOSITORY CONTRACT/u, 'and must keep the distinction')
  assert.match(source, /paradise-write\.ts/u, 'and name the sibling file that depends on it')
  assert.match(source, /optional-chained|optional chain/u, 'and record WHY a rename fails silently')
  assert.match(source, /test\/v102-seam-inventory\.test\.mjs/u, 'and point at this file')
})
