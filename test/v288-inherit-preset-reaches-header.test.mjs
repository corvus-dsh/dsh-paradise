/**
 * ── v288 / B4-B TD-26 (P1): 「判了有没有，值从未使用」 ──────────────────────────────────────────────
 *
 * 用户原话（派工单 §十六 TD-26）：**「`index.ts:8276` 的唯一用法是
 * `...(sourceAgentPreset === undefined ? {} : { inheritFrom: sourceId })` —— 判的是『有没有』，传的是
 * `sourceId`。」** 判据：**② 一条断言「值真的进了目标 header」，不是「函数收到了参数」；③ 负向：未提供
 * preset 时目标 header 不含该字段（不许「一律写入」也能过 ②）。**
 *
 * 这条的重点不是「继承没生效」（`inheritFrom: sourceId` 让运行期读取本身是活的），而是：
 * **一个算得很仔细的值，没有任何下游能看到它**，所以「调用方决定的 preset」与「适配器自己读到的 preset」
 * 永远无法比较 —— 这正是 B4 的反向同族（不是修好的函数没人调，是算好的值没有去处）。
 *
 * 本仓这半边钉三件事：
 *   ① 调用方给的 `inheritPreset` 写进目标 header 的 `meta.agentPreset`（读磁盘 header，不读回执）；
 *   ② 与适配器自己读到的不一致时，回执里有 **warnings** 点名（不静默择一）；
 *   ③ 负向：不给 `inheritPreset` 时 header **不含**该键（不许「一律写入」）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDshAdapters } from '../index.js'

const SOURCE = 'session-source-td26'

/**
 * A session host minimal enough to be honest: `prepare` composes the header that will be persisted,
 * `sessionPersistence.create` records it, and the source log answers `readSession`.
 *
 * The important property is that the HEADER is built by the host side, from `meta`, exactly as the real
 * one is — so an assertion on the stored header is an assertion about what a reader would find on disk.
 */
function makeHost({ sourceEvents = [], presetFromHeader = undefined } = {}) {
  const created = new Map()
  const sourceLog = { session: { id: SOURCE, cwd: '/tmp/work', ...(presetFromHeader === undefined ? {} : { agentPreset: presetFromHeader }) }, events: sourceEvents }
  const ctx = {
    sessions: {
      /**
       * `isSeeded: false` is required, not cosmetic: `createSession` refuses a header that does not
       * explicitly declare 「this is an unseeded top-level session」 (`SEEDED_HEADER`, measured).
       */
      prepare(id, options) {
        const meta = options?.meta ?? {}
        return {
          header: {
            id,
            cwd: meta.cwd,
            isSeeded: false,
            createdAt: Date.now(),
            ...(meta.agentPreset === undefined ? {} : { agentPreset: meta.agentPreset }),
          },
        }
      },
      get: () => undefined,
    },
    sessionPersistence: {
      async stat() {
        return undefined
      },
      async create(header) {
        const record = { header, events: [] }
        created.set(header.id, record)
        return {
          async append(events) {
            record.events.push(...events)
          },
          async flush() {},
          async close() {},
        }
      },
      async open(id) {
        return created.get(id)
      },
      async discardPrepared() {},
      async remove() {},
    },
    /**
     * THE COLD READ MUST AGREE WITH THE WRITE — `createSession` verifies it and refuses with
     * `CREATE_FAILED … 冷读事件数 N 与写入数 M 不一致`. So the reader answers from the SAME record the
     * append wrote into, exactly like the real persistence layer.
     */
    sessionQuery: {
      async readSession(id) {
        if (id === SOURCE) return sourceLog
        const record = created.get(id)
        if (record === undefined) throw new Error(`session "${id}" not found`)
        return { session: record.header, inheritedEventCount: 0, events: [...record.events] }
      },
    },
    sessionController: { prompt: async () => ({ accepted: true }) },
    on: () => () => {},
    emit: () => {},
  }
  /** The persisted HEADER, which is what a reader finds on disk. */
  const headers = () => new Map([...created.entries()].map(([id, record]) => [id, record.header]))
  return { ctx, created, headers }
}

test('v288 TD-26 ①: the caller-supplied preset reaches the target HEADER', async () => {
  /**
   * The source log says `standard` (its header and its last event), while the caller says `cordis`.
   * If the value were still being used only as a boolean, the header would get `standard` and this
   * assertion would fail — which is exactly the defect.
   */
  const { ctx, headers } = makeHost({
    presetFromHeader: 'standard',
    sourceEvents: [{ seq: 1, type: 'agent-preset/selected', data: { agentPreset: 'standard' } }],
  })
  const session = createDshAdapters(ctx).session

  const receipt = await session.create({
    cwd: '/tmp/work',
    id: 'session-td26-a',
    title: 'TD-26',
    items: [{ visibility: 'visible', text: 'hello', origin: 'plugin:test:td26' }],
    inheritFrom: SOURCE,
    inheritPreset: 'cordis',
  })
  assert.equal(receipt.ok, true, `create must succeed; got: ${JSON.stringify(receipt.error ?? receipt)}`)

  const header = headers().get('session-td26-a')
  assert.ok(header !== undefined, 'the session was persisted')
  assert.equal(header.agentPreset, 'cordis',
    '目标 header 的 agentPreset 必须是调用方决定的那个值 —— 「值真的进了 header」，不是「函数收到了参数」')
})

test('v288 TD-26 ③ (negative half): WITHOUT inheritPreset the header carries no such key', async () => {
  /**
   * Without this, ① is satisfied by writing a preset unconditionally — which would stamp the adapter's
   * own guess onto every session, including ones nobody asked to inherit anything.
   */
  const { ctx, headers } = makeHost({ sourceEvents: [] })
  const session = createDshAdapters(ctx).session

  const receipt = await session.create({
    cwd: '/tmp/work',
    id: 'session-td26-b',
    title: 'TD-26',
    items: [{ visibility: 'visible', text: 'hello', origin: 'plugin:test:td26' }],
  })
  assert.equal(receipt.ok, true)
  const header = headers().get('session-td26-b')
  assert.equal('agentPreset' in header, false,
    `没有 inheritPreset 时 header 不得含 agentPreset；实测 ${JSON.stringify(header)}`)
})

test('v288 TD-26 ②: a DISAGREEMENT between caller and adapter is named in the receipt', async () => {
  /**
   * Two independent reads of one fact. Preferring the caller is right; doing it silently would be the
   * failure this batch keeps finding — two values for one fact and nobody saying which one won.
   */
  const { ctx } = makeHost({
    presetFromHeader: 'standard',
    sourceEvents: [{ seq: 1, type: 'agent-preset/selected', data: { agentPreset: 'standard' } }],
  })
  const session = createDshAdapters(ctx).session

  const receipt = await session.create({
    cwd: '/tmp/work',
    id: 'session-td26-c',
    title: 'TD-26',
    items: [{ visibility: 'visible', text: 'hello', origin: 'plugin:test:td26' }],
    inheritFrom: SOURCE,
    inheritPreset: 'cordis',
  })
  assert.equal(receipt.ok, true)
  const warnings = Array.isArray(receipt.warnings) ? receipt.warnings.join(' | ') : ''
  assert.match(warnings, /inheritPreset 不一致/u,
    `不一致必须在回执里点名；实测 warnings=${warnings}`)
  assert.match(warnings, /cordis/u, '并且必须说出调用方给的值')
  assert.match(warnings, /standard/u, '也说出适配器自己读到的值')
})

test('v288 TD-26 ②b: AGREEMENT does not warn (the warning is for a real disagreement)', async () => {
  /**
   * The negative half of ②: a warning that fires when the two values agree is noise, and noise is how a
   * real disagreement gets ignored.
   */
  const { ctx, headers } = makeHost({
    presetFromHeader: 'cordis',
    sourceEvents: [{ seq: 1, type: 'agent-preset/selected', data: { agentPreset: 'cordis' } }],
  })
  const session = createDshAdapters(ctx).session
  const receipt = await session.create({
    cwd: '/tmp/work',
    id: 'session-td26-d',
    title: 'TD-26',
    items: [{ visibility: 'visible', text: 'hello', origin: 'plugin:test:td26' }],
    inheritFrom: SOURCE,
    inheritPreset: 'cordis',
  })
  assert.equal(receipt.ok, true)
  const warnings = Array.isArray(receipt.warnings) ? receipt.warnings.join(' | ') : ''
  assert.doesNotMatch(warnings, /inheritPreset 不一致/u, `一致时不得告警；实测 ${warnings}`)
  assert.equal(headers().get('session-td26-d').agentPreset, 'cordis', '一致时值照样写进 header')
})
