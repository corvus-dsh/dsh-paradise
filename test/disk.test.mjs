/**
 * dsh-paradise — THE DISK READER (`src/read/disk.ts`).
 *
 * Migrated from `dsh-observer/test/disk-log.test.mjs`, keeping every case, because each one pins a
 * mistake that was already made once:
 *
 *   - a v4 log is MULTI-FRAME, and a whole-file decompress reads only the first frame → the false
 *     "0 events" reading;
 *   - a `developer/message` is written correctly, is present on disk, and is rendered NOWHERE;
 *   - "could not read" must never be dressed up as "is not there".
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readDiskEvents, readDiskEventTypes } from '../index.js'
import { HEADER, TAPE, invisibleTape, probeTo, writeFramedSession, writePlainSession } from './fixtures.mjs'

const root = () => mkdtempSync(join(tmpdir(), 'dsh-paradise-log-'))

/* ── the trap this whole layer exists for ────────────────────────────────── */

test('disk: EVERY zstd frame is decoded — one frame is not the whole log', () => {
  const dir = root()
  const path = join(dir, 'session.v4.jsonl.zstd')
  const bytes = writeFramedSession(path, HEADER, TAPE, 2)

  const reading = readDiskEvents('session-x', undefined, { pathProbe: probeTo(path) })
  assert.equal(reading.readable, true, JSON.stringify(reading.notes))
  assert.equal(reading.bytes, bytes)
  assert.ok(reading.frameCount > 1, `the fixture must hold several frames, got ${reading.frameCount}`)
  assert.equal(reading.framesDecoded, reading.frameCount, 'no frame is skipped')
  assert.equal(reading.eventCount, TAPE.length, 'a single-frame read would report 0 here')
  assert.deepEqual(reading.eventTypes, TAPE.map((event) => event.type))
})

test('disk: one event per frame — the extreme case still reads completely', () => {
  const dir = root()
  const path = join(dir, 'session.v4.jsonl.zstd')
  writeFramedSession(path, HEADER, TAPE, 1)

  const reading = readDiskEvents('session-x', undefined, { pathProbe: probeTo(path) })
  assert.equal(reading.frameCount, TAPE.length + 1, 'header + one frame per event')
  assert.equal(reading.framesDecoded, reading.frameCount)
  assert.equal(reading.eventCount, TAPE.length)
})

test('disk: readDiskEventTypes is the one-liner a receipt prints', () => {
  const dir = root()
  const path = join(dir, 'session.v4.jsonl.zstd')
  writeFramedSession(path, HEADER, TAPE, 3)

  assert.deepEqual(
    readDiskEventTypes('session-x', undefined, { pathProbe: probeTo(path) }),
    TAPE.map((event) => event.type),
  )
})

/* ── what the reading reports about the briefing ─────────────────────────── */

test('disk: the briefing is reported by seq, role, source and RENDERABILITY', () => {
  const dir = root()
  const path = join(dir, 'session.v4.jsonl.zstd')
  writeFramedSession(path, HEADER, TAPE, 1)

  const reading = readDiskEvents('session-x', undefined, { pathProbe: probeTo(path) })
  assert.ok(reading.briefing !== null)
  assert.equal(reading.briefing.seq, 3)
  assert.equal(reading.briefing.type, 'user/message')
  assert.equal(reading.briefing.role, 'user')
  assert.equal(reading.briefing.sourceKind, 'plugin:observer-briefing')
  assert.equal(reading.briefing.surfaceOp, 'append')
  assert.equal(reading.briefing.textLength, 'THE PLAN'.length)
  assert.equal(reading.briefing.carriesTurnStep, false, 'a user/message must not carry the pair')
  assert.equal(reading.renderedByConversation, true)
})

test('disk: a developer/message is reported as PRESENT BUT NOT RENDERED', () => {
  const dir = root()
  const path = join(dir, 'session.v4.jsonl.zstd')
  writeFramedSession(path, HEADER, invisibleTape(), 1)

  const reading = readDiskEvents('session-x', undefined, { pathProbe: probeTo(path) })
  assert.equal(reading.readable, true)
  assert.equal(reading.briefing.type, 'developer/message')
  assert.equal(reading.renderedByConversation, false, 'this is exactly the v1.3.0 bug')
  assert.ok(
    reading.notes.some((note) => /不渲染|看不见/u.test(note)),
    `the report must explain WHY it is invisible: ${JSON.stringify(reading.notes)}`,
  )
})

test('disk: a log with NO message reports the absence, not a success', () => {
  const dir = root()
  const path = join(dir, 'session.v4.jsonl.zstd')
  writeFramedSession(path, HEADER, TAPE.filter((event) => !event.type.endsWith('/message')), 1)

  const reading = readDiskEvents('session-x', undefined, { pathProbe: probeTo(path) })
  assert.equal(reading.briefing, null)
  assert.ok(reading.notes.some((note) => /没有任何 user\/message/u.test(note)))
})

/* ── the three "unreadable" shapes, each stated and none thrown ──────────── */

test('disk: no path and no cwd is stated, never guessed', () => {
  const reading = readDiskEvents('session-x')
  assert.equal(reading.readable, false)
  assert.equal(reading.path, '')
  assert.equal(reading.pathSource, 'unavailable')
  assert.ok(reading.notes.some((note) => /无法定位会话日志/u.test(note)))
})

test('disk: a missing file is a stated reason, not an exception', () => {
  const reading = readDiskEvents('session-x', undefined, {
    pathProbe: probeTo(join(root(), 'nope.v4.jsonl.zstd')),
  })
  assert.equal(reading.readable, false)
  assert.ok(reading.notes.some((note) => /读文件失败/u.test(note)))
})

test('disk: a throwing pathProbe is reported, and the read still returns', () => {
  const reading = readDiskEvents('session-x', undefined, {
    pathProbe: () => {
      throw new Error('backend exploded')
    },
  })
  assert.equal(reading.readable, false)
  assert.ok(reading.notes.some((note) => /pathProbe 抛错.*backend exploded/u.test(note)))
})

/* ── the other encodings ─────────────────────────────────────────────────── */

test('disk: a plain-JSONL log is read too (no frames to walk)', () => {
  const dir = root()
  const path = join(dir, 'session.v4.jsonl')
  writePlainSession(path, HEADER, TAPE)

  const reading = readDiskEvents('session-x', undefined, { pathProbe: probeTo(path) })
  assert.equal(reading.readable, true)
  assert.equal(reading.frameCount, 0, 'no frames were found, and the reader says so')
  assert.equal(reading.eventCount, TAPE.length)
  assert.equal(reading.briefing.type, 'user/message')
  assert.ok(reading.notes.some((note) => /明文 JSONL/u.test(note)))
})

test('disk: a file that is neither zstd nor JSONL reports that, without throwing', () => {
  const dir = root()
  const path = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(path, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]))

  const reading = readDiskEvents('session-x', undefined, { pathProbe: probeTo(path) })
  assert.equal(reading.readable, false)
  assert.ok(reading.notes.some((note) => /既不是可解的 zstd/u.test(note)))
})

test('disk: a torn tail frame is tolerated — the earlier frames still read', () => {
  const dir = root()
  const path = join(dir, 'session.v4.jsonl.zstd')
  const full = writeFramedSession(path, HEADER, TAPE, 1)
  // Append a truncated zstd magic + garbage: exactly what a killed writer leaves behind.
  appendFileSync(path, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x11]))

  const reading = readDiskEvents('session-x', undefined, { pathProbe: probeTo(path) })
  assert.equal(reading.readable, true, JSON.stringify(reading.notes))
  assert.equal(reading.eventCount, TAPE.length, 'the good frames survived')
  assert.ok(reading.bytes > full, 'and the torn tail was really there')
})
