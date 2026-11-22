/**
 * ── v287 / B4-B B14 (P1): 幂等是「读」，点火是「写」，中间什么都没有 ────────────────────────────────
 *
 * 用户原话（派工单 §十四 B14）：**「marker 判定用全等（或带边界的判定），而不是前缀（实测：一条不是本调用
 * 方写的、但以 marker 开头的消息 ⇒ 判为未触发）；幂等检查与真正点火之间不可被并发穿透；负向：marker 真的在
 * 目标日志里时仍能正确识别为已触发。」**
 *
 * 两处缺陷：
 *
 *   ① `policy.isPromptText` 用 `trimmed.startsWith(candidate)`：**marker 是调用方已知的字符串**，所以任何
 *      能往这条会话里写字的东西 —— 模型自己、粘贴进来的转述、用户引用 marker —— 只要以它开头，就让幂等检查
 *      认为「已经点过火」而**不再发唤醒**。回执写着 done，会话里什么也没开始跑。
 *   ② `alreadyTriggered`（读）与 `prompt`（写）之间没有互斥：同时进入的两个调用都读到「没点过火」，于是都发
 *      了唤醒 —— 正是幂等检查要防的重复点火。
 *
 * 判据走**真实生产入口** `createDshAdapters(ctx).session.trigger(...)`，不是内部函数。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createDshAdapters } from '../index.js'

const MARKER = '[标记 点火]'
const BODY = '请开始执行交接看板里的待办。'

function adaptersWith(events, prompt) {
  const ctx = {
    sessionController: { prompt },
    sessionQuery: { async readSession(id) { return { id, events } } },
  }
  return createDshAdapters(ctx).session
}

const trigger = (session) => ({ text: BODY, mode: 'queue', origin: 'plugin:test:b14', marker: MARKER })
const ref = { id: 'session-b14', cwd: '/tmp' }

/** A prompt channel that records and accepts. */
function recordingPrompt() {
  const calls = []
  return {
    calls,
    prompt: async (request) => {
      calls.push(request)
      return { accepted: true }
    },
  }
}

/** A user message event as this host stores it. */
function userMessage(text) {
  return { seq: 0, type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text }] } } }
}

test('v287 B14 ①: a message that merely STARTS with the marker is NOT one of our ignitions', async () => {
  /**
   * The marker is the caller's own, so nothing stops this text from existing: the model can write it,
   * a pasted transcript can carry it, a user can quote it. Under `startsWith` it retired the
   * idempotence check and no wake-up was ever sent.
   */
  const channel = recordingPrompt()
  const session = adaptersWith([userMessage(`${MARKER} 这不是点火载荷，只是有人引用了这个标记`)], channel.prompt)

  const receipt = await session.trigger(ref, trigger(session))
  assert.equal(receipt.ok, true)
  assert.equal(receipt.alreadyTriggered, undefined,
    'a message with the right marker and a DIFFERENT body must not count as already triggered')
  assert.equal(channel.calls.length, 1, 'so the wake-up must actually be sent')
})

test('v287 B14 ③ (negative half): the REAL prompt in the log still counts as already triggered', async () => {
  /**
   * Without this, ① is satisfied by 「never recognise anything」 — every retry would re-prompt a
   * session that is already awake, which is the duplicate the check exists to prevent.
   */
  const channel = recordingPrompt()
  const session = adaptersWith([userMessage(`${MARKER} ${BODY}`)], channel.prompt)

  const receipt = await session.trigger(ref, trigger(session))
  assert.equal(receipt.ok, true)
  assert.equal(receipt.alreadyTriggered, true, 'the exact composed prompt IS our ignition')
  assert.equal(channel.calls.length, 0, 'and the model must not be woken twice')
})

test('v287 B14 ③b: an ALIAS marker with the same body still counts (the rename case is preserved)', async () => {
  const channel = recordingPrompt()
  const session = adaptersWith([userMessage(`[旧标记 点火] ${BODY}`)], channel.prompt)
  const receipt = await session.trigger(ref, { ...trigger(session), marker: [MARKER, '[旧标记 点火]'] })
  assert.equal(receipt.alreadyTriggered, true, 'a historical alias + the same body is still ours')
  assert.equal(channel.calls.length, 0)
})

test('v287 B14 ②: two SIMULTANEOUS triggers for one session do not both reach the channel', async () => {
  const calls = []
  let release
  const prompt = (request) =>
    new Promise((resolve) => {
      calls.push(request)
      release = () => resolve({ accepted: true })
    })
  const session = adaptersWith([], prompt)

  const first = session.trigger(ref, trigger(session))
  // Let the first call get past the idempotence read and into the channel.
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(calls.length, 1, 'the first call reached the channel')

  const second = await session.trigger(ref, trigger(session))
  assert.equal(second.ok, false, 'the concurrent call must be REFUSED, not silently sent')
  assert.equal(second.error?.code, 'TRIGGER_IN_FLIGHT')
  assert.equal(calls.length, 1, 'the channel must still have been called exactly once')

  release()
  const done = await first
  assert.equal(done.ok, true, 'and the admitted call still completes normally')
})

test('v287 B14 ②b (negative half): the admission is released, so a LATER trigger still works', async () => {
  /**
   * Without this, ② is satisfied by 「admit once per session forever」 — a permanent block is a slower
   * dead session, not a fix.
   */
  const channel = recordingPrompt()
  const session = adaptersWith([], channel.prompt)
  const first = await session.trigger(ref, trigger(session))
  assert.equal(first.ok, true)
  const second = await session.trigger(ref, trigger(session))
  assert.equal(second.ok, true, 'the next trigger after a completed one must be admitted')
  assert.equal(channel.calls.length, 2)
})
