/**
 * SESSION WRITER — create a COLD session and write a whole tape into it, in one transaction.
 *
 * WHY THIS IS A SEPARATE FILE FROM `session.ts`
 *
 * `session.ts` is the adapter: five protocol verbs, thin, reporting capabilities. This file is the
 * WRITE MACHINERY: prepare → build → validate → create → append → flush → close → cold-read verify,
 * with rollback on every failure. Separating them means the machinery can be tested directly, and the
 * adapter stays readable.
 *
 * THE ORDER IS DEFENSIVE ON PURPOSE
 *
 * Everything that can fail WITHOUT leaving a trace runs first — cwd, source read, tape build, tape
 * validation, duplicate check, persistence probe. `persistence.create` is the first operation that
 * RESERVES an id, and if anything after it fails the rollback runs before the original error escapes.
 * That is what makes "failure leaves no half-built artifact" a property rather than an intention.
 *
 * WHY `close()` IS VERIFIED FOR USING THE COLD-READ CHECK
 *
 * A write can succeed while the persistence round-trip mangles it: a lost `surfaceOp`, a role that
 * came back different, a title whose refs no longer match its source. Counting events catches
 * truncation and misses all of that — which is why the cold read re-runs the FULL validator, the rule
 * the slicing layer arrived at by catching real host regressions with it.
 */

import { randomUUID } from 'node:crypto'

import type { ContextItem, MutationReceipt, RenderedItem, SessionRef } from '../../protocol/index.js'
import { InjectShapeError, assertTape, buildTape, describeRendered, isAbsoluteCwd, materialiseTape } from './inject.js'
import { deleteSession } from './delete.js'
import { service } from './services.js'

/** What the writer produced, with proof for every claim. */
export interface WriteReceipt extends MutationReceipt {
  session?: SessionRef
  /** What was actually placed where, per item. */
  rendered: RenderedItem[]
  /** Event types written, in order. */
  types: string[]
  appended: number
  /** The cold read-back matched, field by field. */
  verified: boolean
  /** Where the briefing landed, for a reader that wants to fetch it. */
  contentSeq: number | null
  contentSourceKind: string
  workspaceAttached: boolean
  clientAnnounced: boolean
}

export interface CreateOptions {
  cwd: string
  title?: string
  id?: string
  /** A session whose runtime knobs (provider/model/preset/policy) are inherited. */
  inheritFrom?: string
  /** The system head the session opens with. */
  systemPrompt: string
  /** The content to place inside the new session. */
  items: ContextItem[]
  /**
   * A PRE-BUILT tape, written verbatim. When present, `items` and `systemPrompt` are not used to
   * compose anything — the caller's tape IS the content.
   *
   * THE ADAPTER STILL OWNS THE SHAPE RULES: the tape is run through the same `assertTape` validator
   * (system head first, closed turn, `surfaceOp` only on messages, contiguous seq), assigned seq/time
   * here, and re-validated after the cold read. A caller cannot use this to write an illegal log; it can
   * only supply richer content than `items` can express.
   */
  tape?: ReadonlyArray<{ type: string; data: Record<string, any>; surface?: boolean }>
  /** The title template; `{main}` becomes this session's own tag. */
  titleTemplate?: string
  /**
   * A header the CALLER already prepared with `sessions.prepare`.
   *
   * WHY THIS IS NEEDED: a caller may run its own pre-write validation against the prepared header (this
   * plugin checks `isSeeded`, that the cwd matches, and that no lineage was inherited). When it does, it
   * must hand that SAME header over — calling `sessions.prepare` a second time for the same id is a
   * collision on this host, and re-preparing silently would discard the object the caller validated.
   *
   * The adapter still owns the durable write: this only skips the reservation step.
   */
  preparedHeader?: any
  createdAt?: number
  /**
   * Attach the new session to the workspace group and announce it through `api-session/added`.
   *
   * Default `true` — a caller that just wants a session in the sidebar needs both, and the layer knows
   * how this host does them.
   *
   * WHY A CALLER CAN TURN IT OFF: `graft-slice` already does both, with semantics this layer cannot
   * reproduce — its own `workspace.id` in the receipt, a `[已转移]` marker that names the new session,
   * and a refusal reported as a warning rather than a stage. Leaving the default on for that caller
   * announced every target TWICE and attached it to the group twice, which the sidebar renders as a
   * duplicate. Publishing is therefore the layer's DEFAULT, not the layer's MONOPOLY.
   */
  publish?: boolean
}

function fail(stage: string, code: string, message: string, warnings: string[] = []): WriteReceipt {
  return {
    ok: false,
    stage,
    warnings,
    rendered: [],
    types: [],
    appended: 0,
    verified: false,
    contentSeq: null,
    contentSourceKind: '',
    workspaceAttached: false,
    clientAnnounced: false,
    error: { code, stage, message },
  }
}

/** Copy the source session's durable knobs, so the new session resumes under the same policy. */
async function readSourceRuntime(
  ctx: any,
  sourceSessionId: string,
): Promise<{ agentPreset?: string; runtimeIntent: Record<string, Record<string, any>>; warnings: string[] }> {
  const out: { agentPreset?: string; runtimeIntent: Record<string, Record<string, any>>; warnings: string[] } = {
    runtimeIntent: {},
    warnings: [],
  }
  const query = service(ctx, 'sessionQuery', 'readSession')
  if (typeof query !== 'object' || query === null || typeof (query as any).readSession !== 'function') {
    out.warnings.push('sessionQuery 不可用：未继承运行时常量（provider/model/preset）')
    return out
  }
  let snapshot: any
  try {
    snapshot = await (query as any).readSession(sourceSessionId)
  } catch (error) {
    out.warnings.push(`读发起会话日志失败，未继承运行时常量：${String((error as any)?.message ?? error)}`)
    return out
  }
  const events: any[] = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.events) ? snapshot.events : []
  let preset = typeof snapshot?.session?.agentPreset === 'string' ? String(snapshot.session.agentPreset) : ''
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue
    if (event.type === 'agent-preset/selected' && typeof event.data?.agentPreset === 'string') {
      preset = String(event.data.agentPreset)
      continue
    }
    if (event.type === 'model/selection' && typeof event.data?.provider === 'string' && typeof event.data?.model === 'string') {
      out.runtimeIntent.model = {
        provider: event.data.provider,
        model: event.data.model,
        ...(typeof event.data.reasoningEffort === 'string' ? { reasoningEffort: event.data.reasoningEffort } : {}),
      }
      continue
    }
    if (event.type === 'permission/preset' && typeof event.data?.preset === 'string') {
      out.runtimeIntent.permission = { preset: event.data.preset }
      continue
    }
    if (event.type === 'sandbox/mode' && typeof event.data?.mode === 'string') {
      out.runtimeIntent.sandbox = { mode: event.data.mode }
      continue
    }
    if (event.type === 'approval/policy' && typeof event.data?.policy === 'string') {
      out.runtimeIntent.approval = { policy: event.data.policy }
      continue
    }
  }
  if (preset.length > 0) out.agentPreset = preset
  return out
}

/** Is this event type one the conversation renders? Read from the tape, never from the request. */
function renderedFromEvents(types: string[]): boolean {
  return types.includes('user/message')
}

/**
 * Create the session and write the tape.
 *
 * `ok: false` means NOTHING SURVIVES: the artifact is removed or marked before returning.
 */
export async function createSession(ctx: any, options: CreateOptions): Promise<WriteReceipt> {
  const warnings: string[] = []
  const cwd = typeof options?.cwd === 'string' ? options.cwd.trim() : ''

  /* ── everything that can fail without a trace ─────────────────────────── */
  if (cwd.length === 0 || !isAbsoluteCwd(cwd)) {
    // Requirement 1.2, literally: no cwd means no session. Never create an orphan.
    return fail('resolve-cwd', 'CWD_REQUIRED', `拒绝创建没有归属的会话：cwd 为空或不是绝对路径（${JSON.stringify(options?.cwd)}）`)
  }
  /**
   * CONTENT IS REQUIRED — but "content" means `items` OR a caller-supplied tape.
   *
   * A tape IS content: it is the whole replayed history. Requiring `items` on that path would have made
   * the richer API unusable, and the failure ("会话不能在没有内容的情况下诞生") would have been exactly
   * backwards — the caller brought more content, not less.
   */
  const hasTape = Array.isArray(options.tape) && options.tape.length > 0
  if (!hasTape && (!Array.isArray(options.items) || options.items.length === 0)) {
    return fail('arguments', 'NO_CONTENT', '没有要注入的内容：会话不能在没有内容的情况下诞生')
  }

  const sessions = service(ctx, 'sessions', 'get')
  if (typeof sessions !== 'object' || sessions === null || typeof (sessions as any).prepare !== 'function') {
    return fail('prepare', 'SESSIONS_UNAVAILABLE', 'sessions.prepare 不可用：宿主不允许准备零继承会话')
  }
  const persistence = service(ctx, 'sessionPersistence', 'create')
  if (typeof persistence !== 'object' || persistence === null || typeof (persistence as any).create !== 'function') {
    return fail(
      'create',
      'PERSISTENCE_REQUIRED',
      'sessionPersistence.create 不可用：没有持久化句柄就无法写出冷会话（live append 会撞 SessionStore）',
    )
  }

  const source =
    typeof options.inheritFrom === 'string' && options.inheritFrom.trim().length > 0
      ? await readSourceRuntime(ctx, options.inheritFrom.trim())
      : { runtimeIntent: {}, warnings: [] as string[] }
  warnings.push(...source.warnings)

  const sessionId =
    typeof options.id === 'string' && options.id.trim().length > 0 ? options.id.trim() : `session-${randomUUID()}`

  // Preflight: never overwrite a live identity.
  if (typeof (sessions as any).get === 'function' && (sessions as any).get(sessionId) !== undefined) {
    return fail('preflight', 'SESSION_EXISTS', `会话 ${sessionId} 已在 live store 中`, warnings)
  }
  const persistenceAny = service(ctx, 'sessionPersistence')
  if (typeof (persistenceAny as any)?.stat === 'function') {
    const existing = await (persistenceAny as any).stat(sessionId)
    if (existing !== undefined && existing !== null) {
      return fail('preflight', 'SESSION_EXISTS', `会话 ${sessionId} 已存在于持久层`, warnings)
    }
  }

  /* the primary item decides what the tape carries — unless the caller supplied a whole tape */
  const primary = options.items[0]
  const visibility = primary !== undefined && primary.visibility === 'context-only' ? 'context-only' : 'visible'
  const text = primary === undefined ? '' : String(primary.text ?? '')
  const createdAt = Number.isFinite(Number(options.createdAt)) ? Number(options.createdAt) : Date.now()

  let events: ReturnType<typeof materialiseTape>
  /**
   * What the cold read must find, derived ONCE and used by both validators.
   *
   * Kept outside the try so the post-write check does not depend on which branch built the tape: the
   * composed path takes it from `items`, the caller-tape path from the tape's own carrying message.
   */
  let expectedCarryingText = ''
  let expectedCarryingVisibility: 'visible' | 'context-only' = visibility
  /**
   * Which contract the tape was validated under, so the COLD READ uses the same one.
   *
   * A caller-supplied tape is another plugin's log: its carrying message carries that plugin's
   * provenance (`plugin:graft-replay`), which is a property of the TAPE, not of this adapter. Re-checking
   * it against the composed path's `'user'` convention would fail a write that is perfectly legal.
   */
  let expectedComposed = true
  try {
    if (Array.isArray(options.tape) && options.tape.length > 0) {
      /**
       * A CALLER-SUPPLIED TAPE — the path a plugin with its own notion of content takes.
       *
       * It is materialised and validated HERE, by the same functions the composed path uses, so the
       * rules do not fork: the skeleton must close, the first surface node must be the system head,
       * `surfaceOp` goes on messages only, and seq/time are assigned by this adapter rather than trusted
       * from the caller. What the caller cannot do is write an illegal log.
       *
       * `expectedText` is derived from the tape's own carrying message instead of from `items`, because
       * on this path `items` may legitimately be empty — a replay tape's content is the whole history.
       */
      events = materialiseTape(
        options.tape.map((seed) => ({
          type: seed.type,
          data: seed.data,
          surface: seed.surface === true,
        })),
        createdAt,
      )
      const carrying = events.find((event) => event.type === 'user/message' || event.type === 'developer/message')
      const payload = carrying === undefined ? undefined : (carrying.data?.message ?? carrying.data)
      const expectedText = typeof payload?.content?.[0]?.text === 'string' ? payload.content[0].text : ''
      const tapeVisibility: 'visible' | 'context-only' = carrying?.type === 'user/message' ? 'visible' : 'context-only'
      assertTape({ events, sessionId, cwd, expectedText, visibility: tapeVisibility, composed: false })
      expectedCarryingText = expectedText
      expectedCarryingVisibility = tapeVisibility
      expectedComposed = false
    } else {
      const seeds = buildTape({
        sessionId,
        cwd,
        text,
        title: options.titleTemplate ?? options.title ?? '[会话] {main}',
        visibility,
        origin: String(primary?.origin ?? ''),
        runtimeIntent: source.runtimeIntent,
        systemPrompt: options.systemPrompt,
      })
      events = materialiseTape(seeds, createdAt)
      assertTape({ events, sessionId, cwd, expectedText: text, visibility })
      expectedCarryingText = text
      expectedCarryingVisibility = visibility
    }
  } catch (error) {
    const shape = error instanceof InjectShapeError ? error : undefined
    return fail(
      shape?.stage ?? 'build-tape',
      shape?.code ?? 'BUILD_FAILED',
      String((error as any)?.message ?? error),
      warnings,
    )
  }
  const types = events.map((event) => event.type)

  /* ── prepare: reserve the header, still nothing on disk ───────────────── */
  let prepared: any
  try {
    prepared = (sessions as any).prepare(sessionId, {
      meta: { cwd, ...(source.agentPreset === undefined ? {} : { agentPreset: source.agentPreset }) },
    })
  } catch (error) {
    return fail('prepare', 'PREPARE_FAILED', String((error as any)?.message ?? error), warnings)
  }
  if (typeof prepared !== 'object' || prepared === null || typeof prepared.header !== 'object' || prepared.header === null) {
    return fail('prepare', 'PREPARE_FAILED', 'sessions.prepare 没有返回可用的 header', warnings)
  }
  // Requirement 1.2 again, on the artifact: the header must carry the EXACT cwd.
  if (prepared.header.cwd !== cwd) {
    return fail(
      'prepare',
      'CWD_MISMATCH',
      `prepared header 的 cwd ${JSON.stringify(prepared.header.cwd)} 不是请求的 cwd ${JSON.stringify(cwd)}`,
      warnings,
    )
  }
  if (prepared.header.isSeeded !== false) {
    return fail('prepare', 'SEEDED_HEADER', '新会话必须是未播种的顶层会话（isSeeded !== false）', warnings)
  }
  const lineage = prepared.header
  if (lineage.parentSession !== undefined || lineage.parentSessionId !== undefined || lineage.lineage !== undefined) {
    return fail('prepare', 'LINEAGE_NOT_EMPTY', '新增会话不能带 lineage（那是 subagent/fork 的形状）', warnings)
  }

  /* ── the write, and the rollback on ANY failure after it ──────────────── */
  let created = false
  let stage = 'create'
  let verified = false
  let contentSeq: number | null = null
  let contentSourceKind = ''
  let workspaceAttached = false
  let clientAnnounced = false
  // `createdAt` was computed before the tape was built (line ~207) so the seq/time base is the SAME one
  // the caller asked for; re-deriving it here from `events[0].time` would be a second source of truth.

  try {
    const handle = await (persistence as any).create(prepared.header, { inheritedEventCount: 0 })
    created = true
    stage = 'handle'
    if (typeof handle !== 'object' || handle === null || typeof handle.append !== 'function') {
      throw new Error('persistence.create 没有返回可写的 handle')
    }
    stage = 'append'
    await handle.append(events)
    stage = 'flush'
    if (typeof handle.flush !== 'function') throw new Error('handle 没有 flush：写出的 tape 无法保证落盘')
    await handle.flush()
    stage = 'close'
    if (typeof handle.close === 'function') await handle.close()

    /* cold read: the reader's copy must pass the SAME validator the writer's copy passed */
    stage = 'verify'
    const query = service(ctx, 'sessionQuery', 'readSession')
    if (typeof query === 'object' && query !== null && typeof (query as any).readSession === 'function') {
      const cold = await (query as any).readSession(sessionId)
      const coldEvents: any[] =
        typeof cold === 'object' && cold !== null && Array.isArray(cold.events) ? cold.events : []
      if (Number(cold?.inheritedEventCount ?? 0) !== 0) {
        throw new Error(`冷读 inheritedEventCount 是 ${String(cold?.inheritedEventCount)}，应为 0`)
      }
      if (cold?.session?.cwd !== cwd) {
        throw new Error(`冷读 cwd ${JSON.stringify(cold?.session?.cwd)} 不是 ${JSON.stringify(cwd)}`)
      }
      if (coldEvents.length !== events.length) {
        throw new Error(`冷读事件数 ${coldEvents.length} 与写入数 ${events.length} 不一致`)
      }
      for (const [index, event] of coldEvents.entries()) {
        if (Number(event?.seq) !== index || event?.type !== types[index]) {
          throw new Error(`冷读事件 ${index} 是 ${String(event?.type)}，期望 ${String(types[index])}`)
        }
      }
      assertTape({
        events: coldEvents as typeof events,
        sessionId,
        cwd,
        /**
         * DERIVED FROM WHAT WAS WRITTEN, not from the request.
         *
         * On the composed path `text`/`visibility` come from `items`; on the caller-tape path `items`
         * may be empty and the real content is the tape's own carrying message. Reading the expectation
         * off `items` would make the cold check compare the persisted log against a request the writer
         * never intended to honour — and on the tape path it would compare against the empty string,
         * failing a perfectly good write.
         */
        expectedText: expectedCarryingText,
        visibility: expectedCarryingVisibility,
        composed: expectedComposed,
      })
      const carrying = coldEvents.find(
        (event) => event?.type === 'user/message' || event?.type === 'developer/message',
      )
      if (carrying === undefined) throw new Error('冷读日志里找不到承载内容的消息')
      contentSeq = Number(carrying.seq)
      contentSourceKind = String((carrying.data?.message ?? carrying.data)?.source?.kind ?? '')
      verified = true
    } else {
      warnings.push('sessionQuery 不可用：写入未经冷读校验')
    }

    /* publishing: best effort, and REPORTED rather than assumed */
    stage = 'publish'
    const shouldPublish = options.publish !== false
    const registry = shouldPublish ? service(ctx, 'workspaceRegistry', 'resolveByPath') : undefined
    if (typeof registry === 'object' && registry !== null && typeof (registry as any).resolveByPath === 'function') {
      try {
        let workspace = await (registry as any).resolveByPath(cwd)
        if (workspace === undefined && typeof (registry as any).create === 'function') {
          workspace = await (registry as any).create(cwd)
        }
        if (typeof workspace === 'object' && workspace !== null && typeof workspace.attachSession === 'function') {
          await workspace.attachSession(sessionId)
          workspaceAttached = true
        }
      } catch (error) {
        warnings.push(`工作区分组失败：${String((error as any)?.message ?? error)}`)
      }
    }
    try {
      if (shouldPublish && typeof ctx?.emit === 'function') {
        ctx.emit('api-session/added', {
          sessionId,
          updatedAt: createdAt,
          agentAvailable: false,
          formatStatus: 'current',
          running: false,
          blank: false,
          cwd,
        })
        clientAnnounced = true
      }
    } catch (error) {
      warnings.push(`客户端通告失败：${String((error as any)?.message ?? error)}`)
    }

    /**
     * The item id for the receipt — derived from the WRITTEN tape when the caller brought one.
     *
     * `primary` may be `undefined` on the tape path (the caller supplied a whole history, not one item),
     * and reading `.id` off it crashed the publish step AFTER a successful durable write — the worst
     * place for a crash, because the artifact is already on disk.
     */
    const receiptItemId = primary !== undefined && primary.id !== undefined
      ? String(primary.id)
      : (() => {
          const carrying = events.find((event) => event.type === 'user/message' || event.type === 'developer/message')
          const payload = carrying === undefined ? undefined : (carrying.data?.message ?? carrying.data)
          return typeof payload?.id === 'string' && payload.id.length > 0 ? payload.id : `${sessionId}-content`
        })()
    const rendered = [describeRendered(events, receiptItemId)]
    return {
      ok: true,
      stage: 'create_success',
      warnings,
      session: { id: sessionId, cwd },
      rendered,
      types,
      appended: events.length,
      verified,
      contentSeq,
      contentSourceKind,
      workspaceAttached,
      clientAnnounced,
    }
  } catch (error) {
    /**
     * Attribute the failure to the STEP it happened in. A `flush` that throws a bare `disk full` must
     * not surface as `create` — the stage is the first thing whoever reads the report needs.
     */
    const message = `${String((error as any)?.message ?? error)}`
    if (created) {
      const rolled = await deleteSession(ctx, sessionId, message)
      warnings.push(
        rolled.removed
          ? `已回滚并删除空会话 ${sessionId}（${rolled.notes.join(', ')}）`
          : rolled.marked
            ? `已回滚并标记 [孵化失败] ${sessionId}（${rolled.notes.join(', ')}）`
            : `已尝试回滚 ${sessionId}，但宿主既没有删除接口也无法标记（${rolled.notes.join(', ') || '无可用方法'}）`,
      )
      warnings.push(...rolled.warnings)
    }
    return {
      ...fail(stage, 'CREATE_FAILED', message, warnings),
      warnings,
    }
  }
}
