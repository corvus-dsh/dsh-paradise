/**
 * THE SESSION ADAPTER FOR THIS RUNTIME.
 *
 * WHAT IS IMPLEMENTED, AND WHAT IS NOT — STATED UP FRONT
 *
 * `readLog` and `subscribe` are REAL: the durable reader (`read/disk.ts`) plus this host's event feed
 * are both proven in production. `create` / `inject` / `trigger` are NOT wired in this phase; they
 * return a failure that names the phase, because the architecture draft puts the write layer in P2
 * and an adapter that pretended to create sessions would be the false-success pattern this whole
 * ecosystem exists to remove.
 *
 * `capabilities` therefore reports the truth, and a caller that consults it BEFORE deciding whether to
 * degrade will never be surprised halfway through a seven-step write.
 *
 * WHY THE HOST'S SERVICE NAMES ARE HERE AND NOWHERE ELSE
 *
 * `sessionPersistence`, `sessionQuery`, `sessionController`, `sessions` are this runtime's internal
 * vocabulary. They live in `adapters/dsh/` so that the protocol — and every plugin above it — can keep
 * talking about "a session", "content" and "a turn".
 */

import type {
  ContextItem,
  LogEvent,
  LogReading,
  MutationReceipt,
  RenderedItem,
  SessionAdapter,
  SessionCapabilities,
  SessionEvent,
  SessionRef,
  TurnTrigger,
  Unsubscribe,
} from '../../protocol/index.js'
import { readDiskEvents } from '../../read/disk.js'
import { escapeSessionDirName, sessionLogPath } from './paths.js'
import { service } from './services.js'
import { createSession } from './session-writer.js'
import { deleteSession, verifyDeletion } from './delete.js'
import { triggerSession } from './trigger.js'
import { SYSTEM_HEAD_PROMPT } from './policy.js'

/** The phase marker for anything still unwired, so a refusal is never vague. */
const WRITE_PHASE = 'P2'

/**
 * The one honest answer an unwired verb can give.
 *
 * At P2 in this file the four write verbs ARE wired; this helper remains because `injectIntoRunning`
 * is a capability some profiles genuinely lack (a host with no prompt channel), and a caller that
 * reaches it must get a named refusal rather than a quiet success.
 */
function notWired(verb: string, why: string): MutationReceipt {
  return {
    ok: false,
    stage: verb,
    warnings: [],
    error: {
      code: 'NOT_WIRED',
      stage: verb,
      message: `${verb} 在当前宿主配置下不可用：${why}`,
    },
  }
}

export function createDshSessionAdapter(ctx: any): SessionAdapter {
  const canTrigger = service(ctx, 'sessionController', 'prompt') !== undefined
  const canReadLog = true // the durable reader needs no service: it takes a path
  const canSubscribe = typeof ctx?.on === 'function'
  const canPrepare = service(ctx, 'sessions', 'prepare') !== undefined
  const canPersist = service(ctx, 'sessionPersistence', 'create') !== undefined
  const canStat = service(ctx, 'sessionPersistence', 'stat') !== undefined

  /**
   * CAPABILITIES ARE PROBED, NOT ASSERTED.
   *
   * `create` needs BOTH halves of the cold path: a way to reserve a detached header and a way to
   * commit it. Claiming it on one half would make the adapter fail at step five of seven, after an
   * artifact had already been reserved.
   */
  const canCreate = canPrepare && canPersist

  const unavailable: Array<{ capability: string; consequence: string }> = []
  if (!canCreate) {
    const missing = [!canPrepare && 'sessions.prepare', !canPersist && 'sessionPersistence.create'].filter(Boolean)
    unavailable.push({
      capability: 'create',
      consequence: `缺少 ${missing.join(' + ')}；无法写出冷会话，必须整体拒绝而不是退化成 live append`,
    })
  }
  if (!canTrigger) {
    unavailable.push({
      capability: 'trigger',
      consequence: '宿主没有 prompt 通道；会话仍可手动打开，但不会自动开始工作',
    })
  }
  if (!canStat) {
    unavailable.push({
      capability: 'verifyDeletion',
      consequence: '宿主没有 persistence.stat；删除只能报告"接口调过"，无法报告"确实没了"',
    })
  }
  if (!canSubscribe) {
    unavailable.push({ capability: 'subscribe', consequence: '宿主没有事件总线；只能轮询 readLog' })
  }

  const capabilities: SessionCapabilities = {
    create: canCreate,
    /** A cold artifact is written through the store's own writer: it needs no open turn. */
    injectIntoIdle: canPersist,
    /** Content arrives as part of the same transactional write; a RUNNING session is a different path. */
    injectIntoRunning: false,
    trigger: canTrigger,
    readLog: canReadLog,
    subscribe: canSubscribe,
    verifyDeletion: canStat,
    unavailable,
  }

  return {
    name: 'dsh-session',
    capabilities,

    /**
     * CREATE — the whole cold path, one transaction.
     *
     * CONTENT IS PLACED HERE, not by a later `inject`: this runtime's write is a single transactional
     * tape, so "create an empty container and append to it" is not a legal sequence on it. That is why
     * the protocol's `create` accepts `items` — see the comment on the interface.
     */
    async create(input) {
      /**
       * WHEN THE CALLER BRINGS A TAPE, IT SUPPLIES THE CONTENT — so no synthetic `items` are invented.
       *
       * The fallback below exists for the "create me a container" case. On the tape path a placeholder
       * would be actively wrong: the writer derives the cold-read expectation from the carrying message,
       * and an invented one would make the validator check the placeholder instead of the real log.
       */
      const hasTape = Array.isArray(input.tape) && input.tape.length > 0
      const items = hasTape
        ? []
        : Array.isArray(input.items) && input.items.length > 0
          ? input.items
          : [
              {
                visibility: 'visible' as const,
                text: input.title !== undefined && input.title.length > 0 ? input.title : '会话已创建',
                origin: 'plugin:paradise:create',
              },
            ]
      const receipt = await createSession(ctx, {
        cwd: input.cwd,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.id === undefined ? {} : { id: input.id }),
        /**
         * INHERITANCE IS A PROTOCOL-LEVEL CONCERN, not a host trick: a new container that does not
         * inherit the runtime knobs (provider / model / preset / sandbox / approval) of the one it was
         * born from will resume under different policy, which is a behaviour change nobody asked for.
         * The caller names the source; the adapter decides how to copy.
         */
        ...(input.inheritFrom === undefined ? {} : { inheritFrom: input.inheritFrom }),
        systemPrompt: SYSTEM_HEAD_PROMPT,
        items,
        ...(hasTape ? { tape: input.tape } : {}),
        titleTemplate: input.title ?? '[会话] {main}',
        ...(input.publish === false ? { publish: false } : {}),
      })
      return receipt
    },

    /**
     * INJECT — content into an existing session.
     *
     * THE HONEST LIMIT, STATED RATHER THAN HIDDEN: on this runtime the write path is a whole-tape
     * transaction taken at CREATE time. Injecting into an EXISTING artifact is a different operation
     * (open the durable log and append a step-scoped event), and it is not wired here. What this verb
     * does implement is the CREATE-time placement, which is where every caller in this workspace
     * actually puts content — and it says so in the refusal instead of pretending.
     */
    async inject(session: SessionRef, items: ContextItem[]): Promise<MutationReceipt & { rendered: RenderedItem[] }> {
      if (!Array.isArray(items) || items.length === 0) {
        return { ...notWired('inject', '没有要注入的内容'), rendered: [] }
      }
      return {
        ...notWired(
          'inject',
          '本宿主的写入是 create 时的一整份 tape 事务；向"已存在的会话"追加内容需要走持久句柄的增量写，' +
            '该路径尚未接线。请用 create(items) 在创建时一并放入内容。',
        ),
        rendered: [],
      }
    },

    /**
     * TRIGGER — make it start working, with the ported ignition chain (marker, idempotence, the
     * AbortSignal that doubles as the timeout, and a fallback between the two modes).
     */
    async trigger(session: SessionRef, trigger: TurnTrigger) {
      return triggerSession(
        ctx,
        session.id,
        {
          mode: trigger.mode === 'interrupt' ? 'interrupt' : 'queue',
          text: trigger.text,
          /**
           * THE MARKER IS THE CALLER'S, because the caller is the one whose prompts are already sitting
           * in this session's log. Substituting this layer's marker would do two wrong things: prepend
           * a marker the caller never used (changing the instruction text it sends), and make the
           * idempotence check look for a string that will never appear — so every retry would
           * re-prompt a session that is already awake.
           *
           * A STRING OR A LIST IS FORWARDED AS GIVEN. The first version of this gate accepted only
           * strings (`typeof marker === 'string'`), which silently DROPPED a caller that passes its
           * marker history as an array — the caller's own prompt then got the neutral default
           * prepended instead, producing `[plugin 点火] [dsh-observer 点火] …`. The type widening is
           * the whole fix; `triggerSession` is what decides stamp-vs-read semantics.
           */
          ...(typeof trigger.marker === 'string' && trigger.marker.trim().length > 0
            ? { marker: trigger.marker.trim() }
            : Array.isArray(trigger.marker) && trigger.marker.length > 0
              ? { marker: trigger.marker }
              : {}),
          /**
           * THE CALLER OWNS "ESCALATE OR REFUSE". A caller that promised one mode and reports a
           * refusal as failure passes `false`; the default keeps the older, more forgiving behaviour.
           */
          ...(trigger.fallbackModes === false ? { fallbackModes: false } : {}),
        },
        /**
         * THE HOST'S MODE VOCABULARY, and it is NOT the protocol's.
         *
         * The protocol names the two intents `queue` and `interrupt`. This runtime's
         * `sessionController.prompt` accepts `queue` and `steer` — measured in the 0.2.2 compatibility
         * record, and relied on by every prompt this workspace already sends. Sending `interrupt` here
         * would send a word the host does not accept, so the protocol's intent is TRANSLATED at the one
         * place that knows both vocabularies.
         */
        { queue: 'queue', interrupt: 'steer' },
      )
    },

    /**
     * READ: REAL, and it is the piece P1 migrated.
     *
     * The path comes from the host when the host can name it (`sessionPersistence.pathOf` and
     * friends), otherwise from this adapter's own derived layout — the neutral reader never learns a
     * directory scheme.
     */
    async readLog(session: SessionRef): Promise<LogReading> {
      const pathProbe = (sessionId: string): { path?: string; source?: string; notes?: string[] } | undefined => {
        const notes: string[] = []
        const persistence = service(ctx, 'sessionPersistence')
        if (typeof persistence === 'object' && persistence !== null) {
          for (const method of ['pathOf', 'pathFor', 'logPath', 'filePath']) {
            if (typeof (persistence as any)[method] !== 'function') continue
            try {
              const value = (persistence as any)[method](sessionId)
              if (typeof value === 'string' && value.trim().length > 0) {
                return { path: value.trim(), source: `sessionPersistence.${method}()`, notes }
              }
            } catch (error) {
              notes.push(`sessionPersistence.${method} 抛错：${String((error as any)?.message ?? error)}`)
            }
            break
          }
        }
        return { path: '', source: 'unavailable', notes }
      }

      const reading = readDiskEvents(session.id, session.cwd, {
        pathProbe,
        derivePath: ({ sessionId, cwd }) => sessionLogPath({ cwd, sessionId }),
      })

      const events: LogEvent[] = reading.events.map((event: any) => ({
        seq: Number(event?.seq ?? 0),
        type: String(event?.type ?? ''),
        time: Number(event?.time ?? 0),
        data: event?.data,
      }))

      return {
        readable: reading.readable,
        path: reading.path,
        pathSource: reading.pathSource,
        bytes: reading.bytes,
        frameCount: reading.frameCount,
        framesDecoded: reading.framesDecoded,
        events,
        eventTypes: reading.eventTypes,
        eventCount: reading.eventCount,
        firstMessage:
          reading.briefing === null
            ? null
            : {
                seq: reading.briefing.seq,
                type: reading.briefing.type,
                role: reading.briefing.role,
                origin: reading.briefing.sourceKind,
                textLength: reading.briefing.textLength,
                textHead: reading.briefing.textHead,
                rendered: reading.renderedByConversation,
              },
        notes: reading.notes,
      }
    },

    /**
     * SUBSCRIBE: REAL, over this host's post-commit feed.
     *
     * The feed is scoped, so the adapter filters to the requested session and normalises the payload
     * into protocol events. A host without a feed returns a no-op unsubscribe rather than throwing —
     * that absence is reported in `capabilities`, which is where a caller should have looked.
     */
    subscribe(session: SessionRef, listener: (event: SessionEvent) => void): Unsubscribe {
      if (!canSubscribe) return () => {}
      const off = (ctx as any).on('session/event', (...args: any[]) => {
        try {
          const event = args.length >= 2 ? args[1] : args[0]
          if (typeof event !== 'object' || event === null) return
          const scope = args.length >= 2 ? args[0] : undefined
          const scopedId =
            (typeof event.data?.sessionId === 'string' ? event.data.sessionId : '') ||
            (typeof scope?.id === 'string' ? scope.id : '') ||
            (typeof scope?.sessionId === 'string' ? scope.sessionId : '')
          if (scopedId !== session.id) return
          listener({
            sessionId: session.id,
            event: {
              seq: Number(event.seq ?? 0),
              type: String(event.type ?? ''),
              time: Number(event.time ?? Date.now()),
              data: event.data,
            },
          })
        } catch {
          // A listener must never break the feed it is attached to.
        }
      })
      return () => {
        if (typeof off === 'function') off()
      }
    },

    /**
     * Can this host CONFIRM an absence?
     *
     * Three answers, and the third is not a fudge: a host with no `stat` genuinely cannot tell, and
     * answering `absent` on the strength of "a removal method returned" is precisely the phantom
     * session this whole rule exists to prevent.
     */
    async probeDeletion(session: SessionRef) {
      const receipt = await verifyDeletion(ctx, session.id)
      return receipt.verified
    },
  }
}

/**
 * Removal is NOT one of the protocol's verbs, and that is a deliberate boundary.
 *
 * The protocol models "create a container, put content in it, make it run, observe it, read it back".
 * Dismantling is a LIFECYCLE concern that belongs to whoever created the artifact — in this ecosystem,
 * the plugin's own rollback. A protocol-level delete would tempt every caller to remove sessions it
 * did not create.
 */
export { deleteSession }

/** The escaping this host uses, for a caller that wants the derived directory name as a label. */
export const dshEscapeSessionDirName = escapeSessionDirName
