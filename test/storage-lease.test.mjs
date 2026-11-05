/**
 * DURABLE STATE THAT SURVIVES A TORN WRITE — and a lease built on it.
 *
 * WHY THESE TWO ARE ONE FILE
 *
 * The lease is not a separate mechanism; it is the storage's atomic read-modify-write used to answer
 * "may I proceed?". Testing them apart would let the fencing rules pass while the primitive underneath
 * them was racy — which is the exact failure a lease is supposed to make impossible.
 *
 * THE FOUR CLAIMS, EACH OF WHICH HAS COST SOMETHING IN THIS ECOSYSTEM ALREADY
 *
 *   1. ATOMIC WRITE. A reader never sees half a document.
 *   2. RECOVERY. A document that IS torn (killed around rename, full disk, hand-edited) is rolled back
 *      to the previous snapshot and REPAIRED — instead of being reported as "never stored", which is
 *      how a caller ends up starting from empty and overwriting the wreckage.
 *   3. EXCLUSION. Two callers cannot both win the same key, even when both read before either writes.
 *   4. FENCING. A holder whose lease expired cannot renew, cannot release, and cannot pretend its write
 *      is still current once a successor holds the key.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createStorageLeaseAdapter,
  createDshAdapters,
  createMemoryHost,
  withLease,
  isLeaseExpired,
  leaseOwnedBy,
  describeLease,
} from '../index.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'paradise-storage-'))
}

/** A storage adapter over a real directory, so the recovery path runs against real torn bytes. */
function diskStorage() {
  const dir = tempDir()
  const adapter = createDshAdapters({ paths: { data: dir } }).storage
  return { dir, adapter, file: (key) => join(dir, `${key}.json`) }
}

/* ── 1 + 2: atomicity and recovery ─────────────────────────────────────────────────────────── */

test('storage: a value round-trips, and the snapshot is taken', async () => {
  const { adapter, file } = diskStorage()
  const first = await adapter.write('alpha', { n: 1 })
  assert.equal(first.ok, true)
  const written = await adapter.write('alpha', { n: 2 })
  assert.equal(written.ok, true)
  assert.deepEqual(await adapter.read('alpha'), { n: 2 })
  // The snapshot is a copy of the last successful write, not of the value it replaced.
  assert.deepEqual(JSON.parse(readFileSync(`${file('alpha')}.bak`, 'utf8')), { n: 2 })
})

test('storage: a TORN primary is rolled back to the snapshot, reported, and repaired', async () => {
  const { adapter, file } = diskStorage()
  await adapter.write('beta', { keep: 'this' })
  // Simulate a kill around rename / a full disk / a hand edit.
  writeFileSync(file('beta'), '{"keep": "thi', 'utf8')

  const report = await adapter.readDetailed('beta')
  assert.equal(report.status, 'recovered', 'a torn primary is recovered, not reported as missing')
  assert.deepEqual(report.value, { keep: 'this' }, 'and the value is the last known-good one')
  assert.equal(report.warnings.length > 0, true, 'the recovery is REPORTED, not silent')

  // REPAIRED: the next read is a plain success, and the file on disk is valid JSON again.
  const after = await adapter.readDetailed('beta')
  assert.equal(after.status, 'ok')
  assert.deepEqual(JSON.parse(readFileSync(file('beta'), 'utf8')), { keep: 'this' })
})

test('storage: corrupt with NO usable snapshot is `corrupt`, which is NOT `missing`', async () => {
  const { adapter, file } = diskStorage()
  await adapter.write('gamma', { a: 1 })
  writeFileSync(file('gamma'), 'not json at all', 'utf8')
  writeFileSync(`${file('gamma')}.bak`, 'also not json', 'utf8')

  const report = await adapter.readDetailed('gamma')
  assert.equal(report.status, 'corrupt', 'the caller MUST be able to tell "damaged" from "never wrote it"')
  assert.equal(await adapter.read('gamma'), undefined)
  const never = await adapter.readDetailed('never-written')
  assert.equal(never.status, 'missing')
})

test('storage: remove takes the snapshot with it — deleted data never comes back', async () => {
  const { adapter, file } = diskStorage()
  await adapter.write('delta', { secret: true })
  const receipt = await adapter.remove('delta')
  assert.equal(receipt.ok, true)
  assert.equal(await adapter.read('delta'), undefined)
  /**
   * THE RESURRECTION THIS PREVENTS: with the snapshot left behind, a later torn write to the same key
   * would "recover" data the caller deliberately deleted — a loss that looks like a successful read.
   */
  assert.equal(await adapter.readDetailed('delta').then((r) => r.status), 'missing')
  // And the remove is idempotent, which the protocol requires.
  assert.equal((await adapter.remove('delta')).ok, true)
})

test('storage: keys() never lists its own bookkeeping files', async () => {
  const { adapter } = diskStorage()
  await adapter.write('one', 1)
  await adapter.write('two', 2)
  const keys = await adapter.keys()
  assert.deepEqual(keys.sort(), ['one', 'two'], 'snapshots and guards are not keys')
  assert.deepEqual(await adapter.keys('t'), ['two'], 'a prefix narrows the listing')
})

/* ── 3: exclusion ──────────────────────────────────────────────────────────────────────────── */

test('lease: the SAME key cannot be won twice while the first lease is alive', async () => {
  const storage = createDshAdapters({ paths: { data: tempDir() } }).storage
  const lease = createStorageLeaseAdapter(storage)
  assert.equal(lease.exclusive, true, 'this storage can provide real exclusion')

  const first = await lease.acquire('corpus', { owner: 'a', ttlMs: 60_000 })
  assert.equal(first.ok, true)
  const second = await lease.acquire('corpus', { owner: 'b', ttlMs: 60_000 })
  assert.equal(second.ok, false)
  assert.equal(second.holder?.owner, 'a', 'a refusal NAMES the holder; "busy" alone is not actionable')
  assert.match(String(second.reason), /a/u)
})

test('lease: two CONCURRENT acquisitions — exactly one wins', async () => {
  /**
   * THE RACE A LOCK EXISTS FOR. Both callers read "no lease" before either writes. Without an atomic
   * read-modify-write underneath, both would decide they may take it.
   */
  const storage = createDshAdapters({ paths: { data: tempDir() } }).storage
  const lease = createStorageLeaseAdapter(storage)
  const attempts = await Promise.all([
    lease.acquire('race', { owner: 'a', ttlMs: 60_000 }),
    lease.acquire('race', { owner: 'b', ttlMs: 60_000 }),
  ])
  assert.equal(attempts.filter((attempt) => attempt.ok).length, 1, 'exactly one winner')
})

test('lease: an EXPIRED lease is reclaimable, and the epoch advances', async () => {
  const storage = createDshAdapters({ paths: { data: tempDir() } }).storage
  const lease = createStorageLeaseAdapter(storage)
  const t0 = Date.now()
  const first = await lease.acquire('stale', { owner: 'a', ttlMs: 1_000, now: t0 })
  assert.equal(first.ok, true)
  assert.equal(first.lease?.epoch, 1)

  // Same wall-clock moment: still held.
  assert.equal((await lease.acquire('stale', { owner: 'b', ttlMs: 1_000, now: t0 + 500 })).ok, false)
  // Past expiry: a crashed holder must not block anyone forever.
  const reclaimed = await lease.acquire('stale', { owner: 'b', ttlMs: 1_000, now: t0 + 2_000 })
  assert.equal(reclaimed.ok, true)
  assert.equal(reclaimed.lease?.epoch, 2, 'the FENCING TOKEN advances on every acquisition')
})

/* ── 4: fencing ────────────────────────────────────────────────────────────────────────────── */

test('lease: a stale holder CANNOT renew after its lease expired', async () => {
  const storage = createDshAdapters({ paths: { data: tempDir() } }).storage
  const lease = createStorageLeaseAdapter(storage)
  const t0 = Date.now()
  const stale = await lease.acquire('fence', { owner: 'slow', ttlMs: 1_000, now: t0 })
  // A successor takes over after expiry.
  const fresh = await lease.acquire('fence', { owner: 'fast', ttlMs: 10_000, now: t0 + 2_000 })
  assert.equal(fresh.ok, true)

  const renewed = await lease.renew(stale.lease, { ttlMs: 10_000, now: t0 + 3_000 })
  assert.equal(renewed.ok, false, 'the stalled holder must not extend a generation that is over')
  assert.match(String(renewed.reason), /epoch/u)
})

test('lease: a stale holder CANNOT release — it would delete its successor\'s claim', async () => {
  const storage = createDshAdapters({ paths: { data: tempDir() } }).storage
  const lease = createStorageLeaseAdapter(storage)
  const t0 = Date.now()
  const stale = await lease.acquire('fence-release', { owner: 'slow', ttlMs: 1_000, now: t0 })
  await lease.acquire('fence-release', { owner: 'fast', ttlMs: 10_000, now: t0 + 2_000 })

  const released = await lease.release(stale.lease)
  assert.equal(released.ok, false)
  assert.equal(released.error?.code, 'LEASE_STALE')
  // The successor still holds it: the refusal was not merely cosmetic.
  const holder = await lease.inspect('fence-release')
  assert.equal(holder?.owner, 'fast')
})

test('lease: renewing the CURRENT generation works, and keeps the epoch', async () => {
  const storage = createDshAdapters({ paths: { data: tempDir() } }).storage
  const lease = createStorageLeaseAdapter(storage)
  const t0 = Date.now()
  const held = await lease.acquire('renew-ok', { owner: 'a', ttlMs: 1_000, now: t0 })
  const renewed = await lease.renew(held.lease, { ttlMs: 5_000, now: t0 + 500 })
  assert.equal(renewed.ok, true)
  assert.equal(renewed.lease?.epoch, held.lease?.epoch, 'a renewal is the same generation, extended')
  assert.equal(renewed.lease?.expiresAt, t0 + 500 + 5_000)
})

/* ── the calling rule ──────────────────────────────────────────────────────────────────────── */

test('withLease: the body runs, and the lease is RELEASED even when the body throws', async () => {
  const storage = createDshAdapters({ paths: { data: tempDir() } }).storage
  const lease = createStorageLeaseAdapter(storage)

  const ok = await withLease(lease, 'job', { owner: 'a', ttlMs: 60_000 }, async () => 'done')
  assert.equal(ok.ok, true)
  assert.equal(ok.value, 'done')
  assert.equal(await lease.inspect('job'), undefined, 'released on the happy path')

  const threw = await withLease(lease, 'job', { owner: 'a', ttlMs: 60_000 }, async () => {
    throw new Error('body exploded')
  })
  assert.equal(threw.ok, false)
  assert.equal(threw.code, 'BODY_FAILED')
  assert.equal(
    await lease.inspect('job'),
    undefined,
    'released on the THROW path too — a leaked lease is a delay nobody can explain later',
  )
})

test('withLease: a busy lease is a NAMED refusal, not a hang', async () => {
  const storage = createDshAdapters({ paths: { data: tempDir() } }).storage
  const lease = createStorageLeaseAdapter(storage)
  await lease.acquire('held', { owner: 'other', ttlMs: 60_000 })

  const start = Date.now()
  const result = await withLease(lease, 'held', { owner: 'me', ttlMs: 1_000, waitMs: 60 }, async () => 'never')
  const elapsed = Date.now() - start
  assert.equal(result.ok, false)
  assert.equal(result.code, 'LEASE_BUSY')
  assert.equal(elapsed >= 50, true, 'it waited as asked')
  assert.equal(elapsed < 2_000, true, 'and it BOUNDED the wait: no deadlock, no hang')
})

test('withLease: an ADVISORY adapter is refused rather than trusted', async () => {
  /**
   * A host without `compareAndSet` cannot promise exclusion. Falling back to "probably fine" is how
   * two writers interleave once a month and corrupt a corpus, so the helper REFUSES and says why.
   */
  const host = createMemoryHost()
  const advisory = {
    name: 'advisory',
    exclusive: false,
    acquire: async () => ({ ok: true, stage: 'x', lease: { key: 'k', owner: 'a', epoch: 1, acquiredAt: 0, expiresAt: Date.now() + 1000 }, warnings: [] }),
    renew: async () => ({ ok: true, stage: 'x', warnings: [] }),
    release: async () => ({ ok: true, stage: 'x', warnings: [] }),
    inspect: async () => undefined,
  }
  const refused = await withLease(advisory, 'k', {}, async () => 'should not run')
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'LEASE_UNAVAILABLE')
  void host
})

test('lease: the SAME implementation runs on the in-memory host', async () => {
  /**
   * THE DECOUPLING CLAIM, CHECKED. If the lease needed anything host-specific, this would fail — and
   * the two hosts would drift into two different fencing rules.
   */
  const host = createMemoryHost()
  assert.equal(typeof host.lease, 'object', 'a host bundle carries a lease')
  const first = await host.lease.acquire('shared', { owner: 'a', ttlMs: 60_000 })
  assert.equal(first.ok, true)
  assert.equal((await host.lease.acquire('shared', { owner: 'b', ttlMs: 60_000 })).ok, false)
  const ran = await withLease(host.lease, 'shared', { owner: 'c', waitMs: 30 }, async () => 'no')
  assert.equal(ran.code, 'LEASE_BUSY')
})

/* ── the pure rules ────────────────────────────────────────────────────────────────────────── */

test('rules: expiry and ownership are decided by pure functions, so they can be tested without a clock', () => {
  const lease = { key: 'k', owner: 'a', epoch: 3, acquiredAt: 0, expiresAt: 1_000 }
  assert.equal(isLeaseExpired(lease, 999), false)
  assert.equal(isLeaseExpired(lease, 1_000), true, 'the boundary belongs to the successor, not the holder')
  assert.equal(isLeaseExpired(undefined), true, 'no lease is an expired lease')
  assert.equal(isLeaseExpired({ ...lease, expiresAt: Number.NaN }), true, 'a garbled expiry is not a licence')

  assert.equal(leaseOwnedBy(lease, { ...lease }), true)
  assert.equal(leaseOwnedBy(lease, { ...lease, owner: 'b' }), false, 'a different owner is a different generation')
  assert.equal(leaseOwnedBy(lease, { ...lease, epoch: 4 }), false, 'and so is a different epoch')

  assert.match(describeLease(lease), /owner=a|a/u)
  assert.match(describeLease(undefined), /无持有者/u)
})

test('storage: a temp file left by a crash is never mistaken for a key', async () => {
  const { adapter, dir } = diskStorage()
  await adapter.write('clean', 1)
  writeFileSync(join(dir, 'clean.json.tmp-999-abc'), '{', 'utf8')
  assert.deepEqual(await adapter.keys(), ['clean'])
  rmSync(dir, { recursive: true, force: true })
})
