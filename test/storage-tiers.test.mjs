/**
 * THE TWO STORAGE TIERS, AND THE PROPERTY EACH ONE IS BOUGHT FOR.
 *
 * WHAT THIS FILE HAS TO PROVE
 *
 *   1. L0 (file) is unchanged and still correct — the existing suite covers it, and it must stay green.
 *   2. L1 (memory) gives EXCLUSION WITHOUT A WINDOW: 50 concurrent critical sections, 0 overlaps.
 *   3. L1 still PERSISTS: what it accepts eventually reaches disk, and the flush does not clobber a value
 *      written while it was running.
 *   4. A broken L0 anchor DEGRADES the memory tier to the file tier LOUDLY, never silently.
 *
 * (3) matters as much as (2). A fast tier that loses writes is not a tier, it is a bug with good numbers.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  chooseStorageTier,
  createDshAdapters,
  createMemoryStorageAdapter,
  createStorageLeaseAdapter,
  withLease,
  parseStorageTier,
  STORAGE_TIERS,
} from '../index.js'

function fileAdapter() {
  const dir = mkdtempSync(join(tmpdir(), 'paradise-tier-'))
  return createDshAdapters({ paths: { data: dir } }).storage
}

/* ── the factory ─────────────────────────────────────────────────────────────────────────── */

test('tier: default is the SAFE one, not the fast one', () => {
  /**
   * A CONFIG THAT FAILS TO PARSE MUST NOT SILENTLY BUY THE RISKIER DURABILITY MODEL. `memory` loses
   * writes during a crash window; `file` does not. So anything unrecognised resolves to `file`.
   */
  assert.equal(parseStorageTier('memory'), 'memory')
  assert.equal(parseStorageTier('file'), 'file')
  assert.equal(parseStorageTier(undefined), 'file')
  assert.equal(parseStorageTier('sqlite'), 'file', 'an unimplemented tier falls back to the safe one')
  assert.equal(parseStorageTier(null), 'file')
  assert.deepEqual([...STORAGE_TIERS], ['file', 'memory'])
})

test('tier: requesting file returns the L0 adapter untouched', async () => {
  const file = fileAdapter()
  const choice = await chooseStorageTier('file', file)
  assert.equal(choice.tier, 'file')
  assert.equal(choice.adapter, file, 'the same object, not a wrapper')
  assert.deepEqual(choice.warnings, [])
  assert.equal(choice.memory, undefined)
})

test('tier: memory is built ON the file adapter and loads what was already durable', async () => {
  const file = fileAdapter()
  await file.write('existing', { persisted: true })

  const choice = await chooseStorageTier('memory', file)
  assert.equal(choice.tier, 'memory')
  assert.equal(choice.adapter.tier, 'memory')
  assert.notEqual(choice.memory, undefined)

  /**
   * A CRASHED MEMORY TIER MUST COME BACK WITH THE LAST DURABLE STATE, not an empty store. This is the
   * difference between "fast" and "amnesiac".
   */
  assert.deepEqual(await choice.adapter.read('existing'), { persisted: true })
})

test('tier: an UNREADABLE anchor degrades to file, loudly', async () => {
  /**
   * THE FAILURE THIS PREVENTS: a memory tier over a dead anchor looks healthy and writes into a void. It
   * must refuse to be built and hand back the file adapter WITH the reason.
   */
  const broken = {
    name: 'broken',
    async read() {
      throw new Error('disk gone')
    },
    async write() {
      throw new Error('disk gone')
    },
    async remove() {
      throw new Error('disk gone')
    },
    async keys() {
      throw new Error('disk gone')
    },
  }
  const choice = await chooseStorageTier('memory', broken)
  assert.equal(choice.tier, 'file', 'degraded to the anchor')
  assert.equal(choice.adapter, broken)
  assert.equal(choice.warnings.length > 0, true, 'the downgrade is REPORTED')
  assert.match(choice.warnings.join(' '), /降级为 file/u)
})

/* ── L1 semantics ───────────────────────────────────────────────────────────────────────── */

test('tier: memory read/write/remove behave like a store, and land on disk after a flush', async () => {
  const file = fileAdapter()
  const memory = createMemoryStorageAdapter({ backing: file, flushDelayMs: 5 })

  await memory.write('alpha', { n: 1 })
  assert.deepEqual(await memory.read('alpha'), { n: 1 })
  assert.deepEqual(await memory.keys(), ['alpha'])

  const flushed = await memory.flushNow()
  assert.equal(flushed.ok, true, flushed.warnings.join(' '))
  assert.deepEqual(await file.read('alpha'), { n: 1 }, 'the value reached the durable tier')

  await memory.remove('alpha')
  await memory.flushNow()
  assert.equal(await file.read('alpha'), undefined, 'a removal reaches disk too')
})

test('tier: the flush does NOT mark a concurrently-written key clean', async () => {
  /**
   * THE FLUSH BUG THIS PINS: a naive flush snapshots the dirty set, writes it, then clears `dirty`. A write
   * arriving DURING the flush would be marked durable without ever being written — a lost update created by
   * the very mechanism meant to prevent loss.
   */
  const file = fileAdapter()
  const memory = createMemoryStorageAdapter({ backing: file, flushDelayMs: 5 })
  await memory.write('racy', 'first')

  const flushing = memory.flushNow()
  await memory.write('racy', 'second')
  await flushing

  assert.equal(memory.pendingCount() > 0, true, 'the later write is still pending')
  await memory.flushNow()
  assert.equal(await file.read('racy'), 'second', 'and it reaches disk on the next flush')
})

test('tier: a THROWING transaction publishes nothing', async () => {
  const file = fileAdapter()
  const memory = createMemoryStorageAdapter({ backing: file, flushDelayMs: 5 })
  await memory.write('stable', 'original')

  const outcome = await memory.transaction(async (tx) => {
    await tx.write('stable', 'mutated')
    await tx.write('extra', 'should not appear')
    throw new Error('body exploded')
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error?.code, 'TRANSACTION_THREW')
  assert.equal(await memory.read('stable'), 'original', 'the mutation was staged, not applied')
  assert.equal(await memory.read('extra'), undefined)
})

test('tier: an ABORTED transaction publishes nothing', async () => {
  const file = fileAdapter()
  const memory = createMemoryStorageAdapter({ backing: file, flushDelayMs: 5 })
  const outcome = await memory.transaction(async (tx) => {
    await tx.write('nope', 1)
    tx.abort()
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error?.code, 'TRANSACTION_ABORTED')
  assert.equal(await memory.read('nope'), undefined)
})

test('tier: a COMMITTED transaction applies every key together', async () => {
  const file = fileAdapter()
  const memory = createMemoryStorageAdapter({ backing: file, flushDelayMs: 5 })
  await memory.write('cursor', 0)

  const outcome = await memory.transaction(async (tx) => {
    const cursor = Number(await tx.read('cursor'))
    await tx.write('cursor', cursor + 1)
    await tx.write('record', { at: cursor + 1 })
    return cursor + 1
  })
  assert.equal(outcome.ok, true, outcome.error?.message)
  assert.equal(outcome.value, 1)
  assert.equal(await memory.read('cursor'), 1)
  assert.deepEqual(await memory.read('record'), { at: 1 })

  await memory.flushNow()
  assert.equal(await file.read('cursor'), 1, 'the whole transaction reached disk')
  assert.deepEqual(await file.read('record'), { at: 1 })
})

/* ── THE HEADLINE PROPERTY ──────────────────────────────────────────────────────────────── */

test('tier: 50 CONCURRENT critical sections under memory — zero overlaps, all persisted', async () => {
  /**
   * THE PROPERTY THE TIER IS BOUGHT FOR, measured the same way the file tier was measured: intervals, not
   * counters. Each critical section records [enter, exit]; any two overlapping intervals mean two holders
   * were inside at once.
   *
   * WHY `withLease` AND NOT A BARE `acquire`: fifty callers hitting at once is EXACTLY what the lease is
   * supposed to stop — a bare acquire correctly refuses 49 of them, which is mutual exclusion working, not
   * a bug. The scenario under test is "fifty callers contend and ALL of them eventually get through, one at
   * a time", so the wait is part of the contract. The first version of this test asserted that all fifty
   * should win instantly, which would only pass if exclusion were broken.
   */
  const file = fileAdapter()
  const memory = createMemoryStorageAdapter({ backing: file, flushDelayMs: 5 })
  const lease = createStorageLeaseAdapter(memory)

  const intervals = []
  const ROUNDS = 50
  const tasks = Array.from({ length: ROUNDS }, (_value, index) =>
    (async () => {
      const result = await withLease(
        lease,
        'critical',
        { owner: `w-${index}`, ttlMs: 30_000, waitMs: 10_000 },
        async () => {
          const enter = Date.now()
          /**
           * A critical section WITH REAL WORK: read a value, derive the next, write it back. An overlap
           * would lose an increment, so the counter is a second, independent check on the same property.
           */
          const current = Number((await memory.read('counter')) ?? 0)
          await memory.write('counter', current + 1)
          intervals.push({ index, enter, exit: Date.now() })
        },
      )
      assert.equal(result.ok, true, `round ${index} failed: ${result.code ?? ''} ${result.reason ?? ''}`)
    })(),
  )

  await Promise.all(tasks)

  intervals.sort((a, b) => a.enter - b.enter)
  const overlaps = []
  let maxExit = intervals.length > 0 ? intervals[0].exit : 0
  for (let index = 1; index < intervals.length; index += 1) {
    if (intervals[index].enter < maxExit) overlaps.push(intervals[index].index)
    if (intervals[index].exit > maxExit) maxExit = intervals[index].exit
  }

  assert.equal(intervals.length, ROUNDS, 'every round ran')
  assert.deepEqual(overlaps, [], `overlapping critical sections: ${overlaps.join(', ')}`)
  assert.equal(Number(await memory.read('counter')), ROUNDS, 'no increment was lost')

  /** AND IT PERSISTS: the final value reaches the durable tier. */
  await memory.flushNow()
  assert.equal(Number(await file.read('counter')), ROUNDS, 'the result is durable, not just in memory')
})
