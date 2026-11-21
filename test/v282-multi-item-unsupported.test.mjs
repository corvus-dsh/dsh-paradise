/**
 * ── v282 (B4-B B5)：`create({items:[A,B]})` 不许静默只写 A ───────────────────────────────────────
 *
 * ── 缺陷（派工单 B5，我核过 `session-writer.ts:249`）──────────────────────────────────────────
 *
 *   const primary = options.items[0]
 *   const text = primary === undefined ? '' : String(primary.text ?? '')
 *
 * `items[1..N]` **没有读者**。而调用仍然返回成功 —— 于是传 `[{text:'A'},{text:'B'}]` 的调用方拿到
 * 一个**只含 A** 的会话，`rendered` 还声称写成功了。
 *
 * 调用方无法区分「B 被写了」与「B 静默消失了」，这恰好是本项目反复禁止的那一类。
 *
 * ── 为什么是拒绝而不是拼接（派工单给了二选一）────────────────────────────────────────────────
 *
 * 写多个 item 意味着要决定**N 条用户消息的磁带长什么样** —— 顺序契约、provenance 契约都会变。
 * 那是协议层的活（B4-A），而派工单把它列为停止条件 3。所以选拒绝：调用方立刻知道，
 * **能力声明也不再多承诺一件它做不到的事**。
 *
 * ── 为什么从 `../index.js` 进，而不是直接 import `session-writer.ts` ──────────────────────────
 *
 * 本仓的 `npm test` 是 `node --test test/*.test.mjs`，**没有 TS loader**。直接 import `.ts` 会在
 * `session-writer.ts` 的 `./inject.js` 上抛 `ERR_MODULE_NOT_FOUND`（实测），于是整条测试在加载期
 * 就红了 —— 而它红的方式与被测行为无关。同仓每一个既有测试都走 `../index.js` 的 `paradiseInternals`，
 * 这条也走：**被测对象是调用方真正会调到的那个 `session.create`**，不是紧邻实现的一个旁门。
 *
 * ── 判据（五条）────────────────────────────────────────────────────────────────────────────────
 *
 *   ① 传 2 项 ⇒ `MULTI_ITEM_UNSUPPORTED`，且**回执不声称成功**
 *   ② 文案点名「收到 N 个」与「其余 N-1 个不会写入」—— 只说「不支持」等于没说
 *   ③ 拒绝**没有留下任何痕迹**：persistence 里一个会话都不该诞生（"failure leaves no half-built artifact"）
 *   ④ 对照：传 1 项 ⇒ 照常写（不许「一律拒绝」也能通过 ①）
 *   ⑤ 对照：caller-supplied `tape` 路径不受影响（`items` 在那条路径上可以不传）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { paradiseInternals } from '../index.js'

const { createDshAdapters } = paradiseInternals

/**
 * A host good enough for the COLD path — prepare / create / append / flush / close / stat / readSession.
 *
 * Deliberately the SAME shape `tape-create.test.mjs` and `caller-contract.test.mjs` use, because ③ and
 * ④ must run the real write machinery: a stub that only answers 「有没有被拒绝」 could not tell a
 * refusal apart from a write that failed later for an unrelated reason.
 */
function makeCtx() {
  const prepared = { header: { cwd: '/tmp/project', isSeeded: false, createdAt: Date.now() } }
  const persisted = new Map()
  return {
    persisted,
    ctx: {
      sessions: {
        prepare: (id) => ({ header: { ...prepared.header, id } }),
        get: () => undefined,
      },
      sessionPersistence: {
        create: async (header) => {
          const record = { header, events: [], live: false }
          persisted.set(header.id, record)
          return {
            append: async (events) => {
              record.events.push(...events)
            },
            flush: async () => {},
            close: async () => {
              record.live = true
            },
          }
        },
        stat: async (id) => (persisted.has(id) ? { header: persisted.get(id).header } : undefined),
        open: async (id) => persisted.get(id),
        discardPrepared: async (id) => persisted.delete(id),
        remove: async (id) => persisted.delete(id),
      },
      sessionQuery: {
        readSession: async (id) => {
          const record = persisted.get(id)
          if (record === undefined) throw new Error(`session "${id}" not found`)
          return { session: record.header, inheritedEventCount: 0, events: [...record.events] }
        },
      },
      sessionController: { prompt: async () => ({ accepted: true }) },
      on: () => () => {},
      emit: () => {},
    },
  }
}

/** A well-formed replay tape: closed skeleton, system head first, one visible carrying message. */
function replayTape(text) {
  return [
    { type: 'turn/start', data: { turn: 1 }, surface: false },
    { type: 'step/start', data: { turn: 1, step: 1 }, surface: false },
    {
      type: 'system/message',
      data: {
        turn: 1,
        step: 1,
        message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'head' }], source: { kind: 'system-prompt' } },
      },
      surface: true,
    },
    {
      type: 'user/message',
      data: { id: 'graft-goal', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
      surface: true,
    },
    {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'echo',
          role: 'assistant',
          content: [{ type: 'text', text }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
        stream: [],
      },
      surface: true,
    },
    { type: 'session/title', data: { title: 'handoff', messageSeqs: [], source: { kind: 'user' } }, surface: false },
    { type: 'step/end', data: { turn: 1, step: 1 }, surface: false },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, surface: false },
  ]
}

const ITEM = (text) => ({ text, origin: 'plugin:test:create' })

test('v282 ①: 传 2 项 ⇒ 显式拒绝，且回执不声称成功', async () => {
  const { ctx } = makeCtx()
  const session = createDshAdapters(ctx).session

  const receipt = await session.create({
    cwd: '/tmp/project',
    title: 'two',
    items: [ITEM('ITEM-A'), ITEM('ITEM-B')],
  })

  assert.equal(receipt.ok, false, `多 item 必须被拒绝，实测 ok=${receipt.ok} stage=${receipt.stage}`)
  assert.equal(receipt.error?.code, 'MULTI_ITEM_UNSUPPORTED', `必须指名这个码，实测 ${receipt.error?.code}`)
  /**
   * And the second half of ①: a refused write must not carry a success-shaped payload. `rendered` is
   * what the tool layer echoes to the model, and `session` names an artifact — a truthy one here would
   * report a session that does not exist, which is exactly the failure the old code committed.
   */
  assert.deepEqual(receipt.rendered, [], '被拒绝的写入不许带 rendered —— 那会让调用方以为写成功了')
  assert.equal(receipt.session, undefined, '被拒绝的写入不许指名一个会话')
})

test('v282 ②: 文案点名「收到 N 个」与「其余 N-1 个不会写入」', async () => {
  const { ctx } = makeCtx()
  const session = createDshAdapters(ctx).session

  const receipt = await session.create({
    cwd: '/tmp/project',
    title: 'three',
    items: [ITEM('A'), ITEM('B'), ITEM('C')],
  })
  const reason = String(receipt.error?.message ?? '')

  assert.match(reason, /收到 3 个/u, `必须说明收到了几个，实测：${reason}`)
  assert.match(reason, /其余 2 个不会被写入/u, `必须说明有几个不会被写，实测：${reason}`)
  /**
   * A refusal that only says 「不支持」 sends the caller looking for a different problem. The reason has
   * to name the CONSEQUENCE, because the consequence is what the old code hid.
   */
  assert.match(reason, /合并成一个 item|分多次创建/u, '必须给出可执行的下一步')
})

test('v282 ③: 拒绝不留痕 —— persistence 里一个会话都不该诞生', async () => {
  /**
   * THE ORDERING PROPERTY, pinned from the outside. The module header promises "failure leaves no
   * half-built artifact"; the multi-item check runs in the "everything that can fail without a trace"
   * block, so nothing may have been created by the time it returns.
   *
   * The negative shape matters: a future edit that moved the check AFTER `persistence.create` would
   * still satisfy ①②（同样的码与文案）, and would leave a half-built session behind. Only this case
   * notices.
   */
  const { ctx, persisted } = makeCtx()
  const session = createDshAdapters(ctx).session

  const receipt = await session.create({ cwd: '/tmp/project', title: 'ghost', items: [ITEM('A'), ITEM('B')] })

  assert.equal(receipt.ok, false)
  assert.equal(persisted.size, 0, `拒绝之后不许有半成品会话，实测留下 ${persisted.size} 个`)
})

test('v282 ④: 对照 —— 单个 item 照常写完（不许「一律拒绝」也能过 ①）', async () => {
  /**
   * The negative half. Without it, `return fail(...)` on EVERY create would pass ①②③ and quietly break
   * the layer. So this asserts a real write: ok, a named session, and the content reaching the tape.
   */
  const { ctx, persisted } = makeCtx()
  const session = createDshAdapters(ctx).session

  const receipt = await session.create({ cwd: '/tmp/project', title: 'one', items: [ITEM('ONLY-ONE')] })

  assert.equal(receipt.ok, true, `单 item 必须照常写，实测 ${JSON.stringify(receipt.error ?? {})}`)
  assert.equal(receipt.stage, 'create_success')
  assert.ok(receipt.session?.id, '成功的写入必须指名它写出的会话')

  const record = persisted.get(receipt.session.id)
  assert.ok(record !== undefined, '会话必须真的落到持久层')
  const userMessages = record.events.filter((event) => event.type === 'user/message')
  assert.equal(userMessages.length, 1, '单 item 路径写一条用户消息，不多不少')
  assert.match(JSON.stringify(userMessages[0]), /ONLY-ONE/u, '内容必须是调用方给的那一条')
})

test('v282 ⑤: 对照 —— caller-supplied `tape` 路径不受这条新检查影响', async () => {
  /**
   * `hasTape` short-circuits the items requirement entirely: a replay tape IS content, and its `items`
   * may legitimately be empty. The new check is gated on `!hasTape` for the same reason, and this case
   * pins that gate — without it, a future edit could start refusing replay tapes for 「0 items」, and
   * every caller that brings its own tape (graft-slice does) would break at once.
   */
  const { ctx, persisted } = makeCtx()
  const session = createDshAdapters(ctx).session

  const receipt = await session.create({ cwd: '/tmp/project', title: 'from tape', tape: replayTape('the replayed goal') })

  assert.equal(receipt.ok, true, `tape 路径不许被多 item 检查拦住，实测 ${JSON.stringify(receipt.error ?? {})}`)
  assert.notEqual(receipt.error?.code, 'MULTI_ITEM_UNSUPPORTED')
  assert.ok(persisted.get(receipt.session.id) !== undefined, 'tape 路径必须真的写出会话')
})
