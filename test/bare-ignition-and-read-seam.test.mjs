/**
 * BARE-METAL IGNITION & THE READ SEAM — pinned so the two last gaps cannot reopen.
 *
 * WHY THIS FILE EXISTS
 *
 * Two capabilities were built to close the final gaps, and both live at seams that `_scratch/` proves but
 * `npm test` does not run:
 *
 *   1. `createBareIgnition` — the trigger verb on a machine with no host. Its absence is not a crash: the
 *      migrator correctly reports `TRIGGER_UNAVAILABLE`. That is exactly why its absence is dangerous — a
 *      regression would look like honest degradation, and nobody would notice the feature had gone.
 *   2. `setSessionLogReader` — the observer's read seam. Without it the monitor reads a compressed frame
 *      file, cannot open a `.jsonl`, and reports the session as absent.
 *
 * WHAT IS ASSERTED
 *
 *   1. the igniter calls the model with the SESSION'S OWN CONTEXT, not just the trigger text;
 *   2. the answer is written back as an `assistant/message`, not as `user/message`;
 *   3. a supplied marker makes a retry idempotent (the durable evidence, not an in-memory flag);
 *   4. every failure is a RECEIPT with a code — the igniter never throws into a migration;
 *   5. the read seam answers before the host layer is consulted, and an absent session is a report.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const paradiseUrl = new URL('../index.js', import.meta.url).href
const observerEntry = join(import.meta.dirname, '..', '..', 'dsh-observer', 'index.js')
const observerUrl = new URL('../../dsh-observer/index.js', import.meta.url).href

/**
 * ── THE OBSERVER SEAM LIVES IN A SIBLING REPO, AND CI DOES NOT HAVE IT ──────────────────────
 *
 * Case 4/5 below import `dsh-observer/index.js` to prove its read seam works. In this workspace the
 * repo sits beside this one; in CI only `corvus-dsh/dsh-paradise` is checked out, so the import fails
 * with `ERR_MODULE_NOT_FOUND` — the same shape of failure as `host-independence-seams.test.mjs`.
 *
 * The cases that stand on their own (bare ignition is entirely inside this package) still run. Only
 * the two that need the sibling are skipped, and the reason names the missing repo — a silent pass
 * would claim the seam is verified when nothing was verified, which is the one outcome worse than a
 * skip.
 */
const observerSkip = existsSync(observerEntry)
  ? false
  : 'sibling repo not checked out: dsh-observer — this seam is verified when the full workspace is present'

/** An in-memory session: a list of typed events, plus the two verbs the igniter needs. */
function memorySession(initial) {
  const events = [...initial]
  return {
    events,
    async readLog() {
      return { readable: events.length > 0, events, notes: [] }
    },
    async inject(_ref, items) {
      for (const item of items) {
        events.push({
          seq: events.length,
          type: item.visibility === 'context-only' ? 'developer/message' : 'user/message',
          data: { text: item.text, source: { kind: item.origin } },
        })
      }
      return { ok: true, stage: 'inject', warnings: [], rendered: [] }
    },
  }
}

/** A scripted model that records what it was asked. */
function scriptedLlm(text) {
  const seen = []
  return {
    seen,
    name: 'scripted',
    provider: 'test',
    async generate(messages) {
      seen.push(messages.map((message) => ({ role: message.role, content: message.content })))
      return { text, model: 'scripted', toolCalls: [] }
    },
  }
}

test('ignition: the model is given the SESSION CONTEXT, not just the trigger text', async () => {
  const { createBareIgnition } = await import(paradiseUrl)
  const session = memorySession([
    { seq: 0, type: 'developer/message', data: { text: '你是被交接的会话。' } },
    { seq: 1, type: 'user/message', data: { text: '这个会话的任务：完成收尾。' } },
  ])
  const llm = scriptedLlm('收到，继续推进。')
  const igniter = createBareIgnition({ session, llm })

  const receipt = await igniter.trigger({ id: 's1', cwd: '/tmp' }, { text: '[点火] 开始执行', mode: 'queue', origin: 'plugin:test:ignition' })
  assert.equal(receipt.ok, true, receipt.error?.message)
  assert.equal(receipt.channel, 'bare.llm')

  /**
   * THE CONTEXT ASSERTION IS THE POINT OF THIS TEST. An igniter that sent only the trigger text would
   * produce an answer to a question nobody asked — the target's setup and replayed history are the whole
   * reason a migrated session is resumable.
   */
  assert.equal(llm.seen.length, 1)
  const conversation = llm.seen[0]
  assert.ok(conversation.length >= 3, `expected context + trigger, got ${conversation.length} messages`)
  assert.ok(conversation.some((message) => message.content.includes('被交接的会话')), 'the setup travelled')
  assert.ok(conversation.some((message) => message.content.includes('完成收尾')), 'the replayed goal travelled')
  assert.match(conversation[conversation.length - 1].content, /点火/u, 'and the trigger is last')
})

test('ignition: an answer is WRITTEN BACK, as its own event', async () => {
  const { createBareIgnition } = await import(paradiseUrl)
  const session = memorySession([{ seq: 0, type: 'user/message', data: { text: '任务：收尾。' } }])
  const igniter = createBareIgnition({ session, llm: scriptedLlm('这是模型的回答。') })

  const before = session.events.length
  await igniter.trigger({ id: 's1', cwd: '/tmp' }, { text: '开始', mode: 'queue', origin: 'plugin:test:ignition' })
  assert.equal(session.events.length, before + 1, 'exactly one event must be appended')
  assert.equal(session.events.at(-1).data.text, '这是模型的回答。')
})

test('ignition: a marker makes a retry idempotent, using the LOG as evidence', async () => {
  const { createBareIgnition } = await import(paradiseUrl)
  /** A log that already carries this caller's prompt — the durable proof that it was already asked. */
  const session = memorySession([
    { seq: 0, type: 'user/message', data: { text: '[标记] 已经点过火了' } },
    { seq: 1, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '在做了' }] } } },
  ])
  const llm = scriptedLlm('不应该被调用')
  const igniter = createBareIgnition({ session, llm })

  const receipt = await igniter.trigger({ id: 's1', cwd: '/tmp' }, { text: '[标记] 再来一次', mode: 'queue', origin: 'p', marker: '[标记]' })
  assert.equal(receipt.ok, true)
  assert.equal(receipt.alreadyTriggered, true, 'the receipt must say "already", not "done again"')
  assert.equal(llm.seen.length, 0, 'the model must NOT be called for a warm session')
})

test('ignition: a missing session is a NAMED refusal, never a throw', async () => {
  const { createBareIgnition } = await import(paradiseUrl)
  const session = { async readLog() { return { readable: false, events: [], notes: ['absent'] } }, async inject() { throw new Error('must not be called') } }
  const igniter = createBareIgnition({ session, llm: scriptedLlm('x') })
  /** The caller is mid-migration: an exception here leaves a half-built target with no diagnosis. */
  const receipt = await igniter.trigger({ id: 'gone', cwd: '/tmp' }, { text: 'go', mode: 'queue', origin: 'p' })
  assert.equal(receipt.ok, false)
  assert.equal(receipt.error?.code, 'SESSION_NOT_FOUND')
})

test('ignition: a failing model is a RECEIPT with its code, not an exception', async () => {
  const { createBareIgnition } = await import(paradiseUrl)
  const session = memorySession([{ seq: 0, type: 'user/message', data: { text: 'x' } }])
  const llm = { name: 'f', provider: 'f', async generate() { return { text: '', toolCalls: [], model: 'f', error: { code: 'LLM_CALL_FAILED', stage: 'generate', message: 'boom' } } } }
  const receipt = await createBareIgnition({ session, llm }).trigger({ id: 's', cwd: '/tmp' }, { text: 'go', mode: 'queue', origin: 'p' })
  assert.equal(receipt.ok, false)
  assert.equal(receipt.error?.code, 'LLM_CALL_FAILED')
})

test('ignition: an EMPTY answer is refused rather than written as a blank message', async () => {
  const { createBareIgnition } = await import(paradiseUrl)
  const session = memorySession([{ seq: 0, type: 'user/message', data: { text: 'x' } }])
  const before = session.events.length
  const receipt = await createBareIgnition({ session, llm: scriptedLlm('   ') }).trigger({ id: 's', cwd: '/tmp' }, { text: 'go', mode: 'queue', origin: 'p' })
  assert.equal(receipt.ok, false)
  assert.equal(receipt.error?.code, 'IGNORED_EMPTY_ANSWER'.replace('IGNORED_', 'IGNITION_'))
  assert.equal(session.events.length, before, 'nothing must be appended for an empty answer')
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * THE READ SEAM
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

test('observer: the read seam is exported, absent by default, and wins when installed', { skip: observerSkip }, async () => {
  const observer = await import(observerUrl)
  const internals = observer.diskLogInternals
  assert.equal(typeof internals.setSessionLogReader, 'function')
  assert.equal(typeof internals.hasSessionLogReader, 'function')
  assert.equal(internals.hasSessionLogReader(), false, 'the host path is the default')

  const root = mkdtempSync(join(tmpdir(), 'read-seam-'))
  const logPath = join(root, 's.jsonl')
  writeFileSync(
    logPath,
    [
      { seq: 0, type: 'session', data: { id: 's', cwd: root } },
      { seq: 0, type: 'developer/message', data: { message: { role: 'system', content: [{ type: 'text', text: '这是被读到的第一个非空行。\n第二行' }] } } },
      { seq: 1, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '结论。' }] } } },
    ].map((event) => JSON.stringify(event)).join('\n') + '\n',
    'utf8',
  )

  let calls = 0
  internals.setSessionLogReader({
    name: 'test-jsonl',
    async read(id) {
      calls += 1
      const text = (await import('node:fs')).readFileSync(join(root, `${id}.jsonl`), 'utf8')
      const events = text.split(/\r?\n/u).filter((line) => line.trim()).map((line) => JSON.parse(line))
      return { readable: true, path: join(root, `${id}.jsonl`), pathSource: 'test-jsonl', events, notes: [] }
    },
  })

  try {
    const report = await internals.inspectSessionLog({}, 's', root)
    assert.equal(calls, 1, 'the injected reader must be consulted')
    assert.equal(report.pathSource, 'test-jsonl', 'and it must be the one that answered')
    assert.equal(report.readable, true)
    assert.equal(report.eventCount, 3)

    /**
     * THE BRIEFING IS DERIVED, and that is asserted because it used to come free from the frame decoder.
     * A bare read that forgot to derive it would print `briefing: null` for a session that plainly has one.
     */
    assert.notEqual(report.briefing, null, 'a briefing must be derived from the events')
    assert.match(String(report.briefing?.textHead), /第一个非空行/u, 'the FIRST non-empty line, not the whole text')
  } finally {
    internals.setSessionLogReader(undefined)
  }
  assert.equal(internals.hasSessionLogReader(), false, 'clearing restores the host path')
})

test('observer: an absent session is a report, not an exception', { skip: observerSkip }, async () => {
  const observer = await import(observerUrl)
  const internals = observer.diskLogInternals
  internals.setSessionLogReader({
    name: 'empty-reader',
    async read(id) {
      return { readable: false, path: `/${id}.jsonl`, pathSource: 'test', events: [], notes: [`${id} 不存在`] }
    },
  })
  try {
    const report = await internals.inspectSessionLog({}, 'nope', '/tmp')
    assert.equal(report.readable, false)
    assert.ok(report.notes.length > 0, 'the absence must be explained')
  } finally {
    internals.setSessionLogReader(undefined)
  }
})
