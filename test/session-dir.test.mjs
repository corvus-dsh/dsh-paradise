/**
 * dsh-paradise — THE HOST'S SESSION-DIRECTORY ESCAPING AND PATH DERIVATION.
 *
 * Migrated from `dsh-observer/test/session-dir.test.mjs`. The escaping is only useful if it is the
 * host's ACTUAL scheme, and it is not `encodeURIComponent`: measured against real directory names,
 * `D:\软件开发` becomes `--D-~8F6F~4EF6~5F00~53D1--` — `~` + FOUR uppercase hex digits per UTF-16
 * code unit, drive colon dropped, separators as `-`.
 *
 * A wrong guess here produces a plausible-looking path that reads nothing, which is worse than
 * saying "unknown". So the two real names are pinned as fixtures, and the derivation is asserted to
 * LABEL ITSELF as derived.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { escapeSessionDirName, sessionLogPath } from '../index.js'

/* ── the escaping ─────────────────────────────────────────────────────────── */

test('escaping: the two MEASURED real directory names round-trip', () => {
  // Both names were read off this machine's real <DSH_HOME>/sessions root.
  assert.equal(escapeSessionDirName('D:\\持久层能力架构'), '--D-~6301~4E45~5C42~80FD~529B~67B6~6784--')
  assert.equal(escapeSessionDirName('D:\\软件开发'), '--D-~8F6F~4EF6~5F00~53D1--')
})

test('escaping: ascii survives, the drive colon vanishes, separators become dashes', () => {
  assert.equal(escapeSessionDirName('D:\\live2d'), '--D-live2d--')
  assert.equal(escapeSessionDirName('C:\\Users\\x'), '--C-Users-x--')
})

test('escaping: hex is uppercase and always four digits', () => {
  const escaped = escapeSessionDirName('D:\\A中')
  assert.match(escaped, /~4E2D/u, 'the CJK code unit is four uppercase hex digits')
  assert.equal(/[a-f]/u.test(escaped.replace(/[a-z]/gu, '')), false, 'no lowercase hex survives')
})

test('escaping: it is NOT encodeURIComponent, and the difference is load-bearing', () => {
  const mine = escapeSessionDirName('D:\\软件开发')
  assert.notEqual(mine, encodeURIComponent('D:\\软件开发'), 'the two schemes disagree; the host uses this one')
  assert.notEqual(mine, '--D-%E8%BD%AF%E4%BB%B6%E5%BC%80%E5%8F%91--')
})

test('escaping: a mixed-case path keeps its case', () => {
  assert.equal(escapeSessionDirName('D:\\TimeSeries'), '--D-TimeSeries--')
})

test('escaping: an astral character is escaped per UTF-16 code unit', () => {
  // 🀄 U+1F004 = surrogate pair D83C DC04; the host escapes code units, not code points.
  const escaped = escapeSessionDirName('D:\\🀄')
  assert.match(escaped, /~D83C~DC04/u)
})

/* ── the derivation, and how honestly it labels itself ────────────────────── */

test('path: the layout is <home>/sessions/<escaped cwd>/<sessionId>/session.v4.jsonl.zstd', () => {
  const derived = sessionLogPath({
    cwd: 'D:\\持久层能力架构',
    sessionId: 'session-abc',
    home: 'C:\\Users\\x\\.dsh',
  })
  assert.equal(
    derived.path,
    'C:\\Users\\x\\.dsh\\sessions\\--D-~6301~4E45~5C42~80FD~529B~67B6~6784--\\session-abc\\session.v4.jsonl.zstd',
  )
})

test('path: it says DERIVED, never authoritative', () => {
  const derived = sessionLogPath({ cwd: 'D:\\w', sessionId: 's', home: 'H' })
  assert.equal(derived.source, 'derived:sessions-layout')
  assert.ok(
    derived.notes.some((note) => /推导/u.test(note)),
    'the note must admit the path was derived: ' + JSON.stringify(derived.notes),
  )
})

test('path: a trailing separator on home does not double up', () => {
  const derived = sessionLogPath({ cwd: 'D:\\w', sessionId: 's', home: 'C:\\h\\' })
  assert.match(derived.path, /^C:\\h\\sessions\\/u)
})

test('path: no cwd is "unavailable" with a stated reason', () => {
  const derived = sessionLogPath({ cwd: '', sessionId: 's', home: 'C:\\h' })
  assert.equal(derived.path, '')
  assert.equal(derived.source, 'unavailable')
  assert.ok(derived.notes.some((note) => /没有提供 cwd/u.test(note)))
})

test('path: no home is "unavailable" with a stated reason', () => {
  const derived = sessionLogPath({ cwd: 'D:\\w', sessionId: 's', env: {} })
  assert.equal(derived.path, '')
  assert.equal(derived.source, 'unavailable')
  assert.ok(derived.notes.some((note) => /DSH_HOME/u.test(note)))
})

test('path: DSH_HOME comes from the environment when not passed', () => {
  const derived = sessionLogPath({ cwd: 'D:\\w', sessionId: 's', env: { DSH_HOME: 'E:\\home' } })
  assert.match(derived.path, /^E:\\home\\sessions\\/u)
})
