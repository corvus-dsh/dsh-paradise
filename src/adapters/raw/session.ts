/**
 * THE BARE-METAL SESSION — `adapters/raw/session.ts`.
 *
 * THE SHAPE THAT WAS DECIDED, AND WHY IT IS THE RIGHT ONE
 *
 * The user's answer to "what is a session on a bare machine?" was: **the same idea as the slicing
 * plugin — a JSON array of `developer/message` (the standing setup) and `user/message` (the material),
 * reasoned over by an LLMAdapter.**
 *
 * That answer is not a simplification; it is the minimal thing that can carry a conversation:
 *
 *   - `developer/message` is the SETUP: rules, role, the standing prompt. It is what a system head
 *     would be on a host, reduced to the one property that matters — it is read but never answered.
 *   - `user/message` is the MATERIAL: the crash log, the source under repair, the instruction.
 *   - `assistant/message` is the OUTPUT: what the model produced, kept so a second round sees it.
 *
 * WHY THIS IS A REAL SessionAdapter AND NOT A STAND-IN
 *
 * The protocol asks for five verbs and a capability report. This implements them against a file, which
 * is what a durable log IS once the host's numbering and rendering rules are removed. A caller written
 * against `SessionAdapter` — `dsh-memory`'s harvest, for instance — cannot tell the difference, and
 * that is the whole test.
 *
 * WHAT IS DELIBERATELY LOST, AND SAID OUT LOUD
 *
 *   - no `surface` / rendering concept: nothing here decides what a UI shows, because there is no UI;
 *   - no turn/step skeleton: there is no agent loop to carry one;
 *   - `subscribe` is a no-op: there is no event bus, and the protocol explicitly allows this through
 *     `capabilities.subscribe === false`.
 *
 * `inject` therefore maps visibility DIRECTLY to message role, which is the one place this adapter
 * makes a policy decision rather than a mechanical one:
 *
 *     visibility: 'visible'      → 'user/message'
 *     visibility: 'context-only' → 'developer/message'
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

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

/** One stored event. The file is one JSON object per line, so a torn tail costs one event. */
interface StoredEvent {
  seq: number
  type: string
  time: number
  data: Record<string, unknown>
}

export interface RawSessionOptions {
  /** Where session files live. One `<id>.jsonl` per session. */
  readonly dir: string
  /** Injected clock, so a test can assert ordering without sleeping. */
  readonly now?: () => number
  /**
   * The callback that makes a session START. Absent means `capabilities.trigger === false`.
   *
   * WHY IT IS INJECTED: "make it run" is the one verb that needs an executor, and on a bare machine the
   * executor is whatever the caller wired up (a model call, a subprocess). The adapter must not pretend
   * it can trigger when nobody is listening.
   */
  readonly onTrigger?: (ref: SessionRef, trigger: TurnTrigger, events: readonly StoredEvent[]) => void | Promise<void>
}

const CAPABILITIES_BASE: Omit<SessionCapabilities, 'trigger'> = {
  create: true,
  injectIntoIdle: true,
  injectIntoRunning: true,
  readLog: true,
  subscribe: false,
  verifyDeletion: true,
  unavailable: [
    { capability: 'subscribe', consequence: '没有事件总线：调用方改用 readLog 轮询，这是协议允许的降级' },
  ],
}

function fail(stage: string, code: string, message: string): MutationReceipt {
  return { ok: false, stage, warnings: [], error: { code, stage, message } }
}

/** Absolute-path check, the same rule the protocol states for `SessionRef.cwd`. */
function isAbsolute(path: string): boolean {
  return /^([A-Za-z]:[\\/]|\/)/u.test(path)
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/iu

export function createRawSessionAdapter(options: RawSessionOptions): SessionAdapter {
  const dir = resolve(options.dir)
  mkdirSync(dir, { recursive: true })
  const now = options.now ?? (() => Date.now())

  const logPath = (id: string): string => join(dir, `${id}.jsonl`)

  const readAll = (id: string): StoredEvent[] => {
    let text: string
    try {
      text = readFileSync(logPath(id), 'utf8')
    } catch {
      return []
    }
    const events: StoredEvent[] = []
    for (const line of text.split(/\r?\n/u)) {
      if (line.trim().length === 0) continue
      try {
        const parsed = JSON.parse(line)
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.seq === 'number') events.push(parsed as StoredEvent)
      } catch {
        /**
         * A TORN LINE COSTS ONE EVENT, NOT THE SESSION. This is the same discipline the memory store
         * uses: a crash mid-write must not make the whole log unreadable, or the repair session that
         * exists to diagnose a crash would itself be destroyed by the crash it is diagnosing.
         */
      }
    }
    return events
  }

  const append = (id: string, incoming: Array<{ type: string; data: Record<string, unknown> }>): StoredEvent[] => {
    const existing = readAll(id)
    let seq = existing.length === 0 ? 0 : existing[existing.length - 1].seq + 1
    const written: StoredEvent[] = incoming.map((item) => ({ seq: seq++, type: item.type, time: now(), data: item.data }))
    appendFileSync(logPath(id), written.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8')
    return written
  }

  /**
   * THE VISIBILITY → ROLE MAPPING, in one place so it can be argued with.
   *
   * `visible` means "a human should read this" → `user/message`.
   * `context-only` means "the model reads this, nobody else" → `developer/message`.
   *
   * This is the same distinction the host-backed adapter draws; the difference is that here the
   * MESSAGE TYPE is the only place to record it, because there is no view to ask.
   */
  const typeFor = (visibility: string): string => (visibility === 'context-only' ? 'developer/message' : 'user/message')

  const adapter: SessionAdapter = {
    name: 'raw-session',

    /**
     * THE CAPABILITY REPORT IS COMPUTED, NOT ASSERTED.
     *
     * `trigger` is true only when somebody wired an executor. A adapter that claimed it could trigger
     * and then did nothing would be the exact failure `assert-capabilities` exists to prevent.
     */
    capabilities: {
      ...CAPABILITIES_BASE,
      trigger: typeof options.onTrigger === 'function',
    },

    async create(input) {
      if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd)) {
        return {
          ...fail('create', 'WORKSPACE_REQUIRED', 'cwd 必须是绝对路径：协议没有"猜一个工作目录"这种表达'),
          session: undefined,
          rendered: [],
        } as MutationReceipt & { session?: SessionRef; rendered?: RenderedItem[] }
      }
      const id = input.id ?? `raw-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      if (!ID_PATTERN.test(id)) {
        return { ...fail('create', 'SESSION_ID_INVALID', `会话 id ${JSON.stringify(id)} 不合法`), rendered: [] } as MutationReceipt & {
          session?: SessionRef
          rendered?: RenderedItem[]
        }
      }
      if (existsSync(logPath(id))) {
        return { ...fail('create', 'SESSION_EXISTS', id), rendered: [] } as MutationReceipt & { session?: SessionRef; rendered?: RenderedItem[] }
      }

      const head: StoredEvent = { seq: 0, type: 'session', time: now(), data: { id, cwd: input.cwd, title: input.title ?? '' } }
      writeFileSync(logPath(id), JSON.stringify(head) + '\n', 'utf8')

      const rendered: RenderedItem[] = []
      for (const item of input.items ?? []) {
        const written = append(id, [{ type: typeFor(item.visibility), data: { text: item.text, source: { kind: item.origin } } }])
        rendered.push({
          id: item.id ?? `${id}-${written[0]?.seq ?? 0}`,
          requested: item.visibility,
          rendered: item.visibility !== 'context-only',
          reason: item.visibility === 'context-only' ? '仅上下文（developer/message）' : '可见（user/message）',
        })
      }

      return {
        ok: true,
        stage: 'create',
        warnings: [],
        session: { id, cwd: input.cwd },
        rendered,
      }
    },

    async inject(ref, items) {
      if (!existsSync(logPath(ref.id))) {
        return { ...fail('inject', 'SESSION_NOT_FOUND', ref.id), rendered: [] }
      }
      const rendered: RenderedItem[] = []
      for (const item of items) {
        const written = append(ref.id, [{ type: typeFor(item.visibility), data: { text: item.text, source: { kind: item.origin } } }])
        rendered.push({
          id: item.id ?? `${ref.id}-${written[0]?.seq ?? 0}`,
          requested: item.visibility,
          rendered: item.visibility !== 'context-only',
          reason: item.visibility === 'context-only' ? '仅上下文（developer/message）' : '可见（user/message）',
        })
      }
      return { ok: true, stage: 'inject', warnings: [], rendered }
    },

    async trigger(ref, trigger) {
      if (!existsSync(logPath(ref.id))) {
        return fail('trigger', 'SESSION_NOT_FOUND', ref.id)
      }
      if (typeof options.onTrigger !== 'function') {
        /**
         * A NO-OP WITH A RECEIPT, NEVER A SILENT SUCCESS. The protocol is explicit: a caller that
         * believes ignition happened and sees nothing must be able to tell a slow start from a broken
         * channel.
         */
        return {
          ok: false,
          stage: 'trigger',
          warnings: ['没有注入 onTrigger：这个适配器无法让会话开始工作'],
          error: { code: 'TRIGGER_UNAVAILABLE', stage: 'trigger', message: '环境不是错误：它只是没有被接上' },
        }
      }
      append(ref.id, [{ type: 'trigger/admitted', data: { text: trigger.text, mode: trigger.mode, origin: trigger.origin } }])
      append(ref.id, [{ type: typeFor('visible'), data: { text: trigger.text, source: { kind: trigger.origin } } }])
      try {
        await options.onTrigger(ref, trigger, readAll(ref.id))
      } catch (error) {
        return {
          ok: false,
          stage: 'trigger',
          warnings: [],
          error: { code: 'TRIGGER_FAILED', stage: 'trigger', message: String((error as any)?.message ?? error) },
        }
      }
      return { ok: true, stage: 'trigger', warnings: [] }
    },

    async readLog(ref) {
      const events = readAll(ref.id)
      const types = [...new Set(events.map((event) => event.type))]
      return {
        readable: events.length > 0,
        path: logPath(ref.id),
        pathSource: 'raw-session',
        bytes: events.length === 0 ? 0 : readFileSync(logPath(ref.id)).byteLength,
        frameCount: events.length,
        framesDecoded: events.length,
        events: events as unknown as LogEvent[],
        eventTypes: types,
        eventCount: events.length,
        firstMessage: null,
        notes: [],
      } satisfies LogReading
    },

    subscribe(_ref, _listener): Unsubscribe {
      /** No event bus, and the capability report says so. A no-op is the documented behaviour. */
      return () => {}
    },

    async probeDeletion(ref) {
      return existsSync(logPath(ref.id)) ? 'present' : 'absent'
    },
  }

  /** Extra verb for the harness: destroy a session. Not part of the protocol, by design. */
  const destroy = (id: string): boolean => {
    if (!existsSync(logPath(id))) return false
    rmSync(logPath(id), { force: true })
    return true
  }

  /** Extra verb: every session id on disk. Useful for a diagnostic, and for tests. */
  const listIds = (): string[] => readdirSync(dir).filter((name) => name.endsWith('.jsonl')).map((name) => name.slice(0, -6))

  return Object.assign(adapter, { destroy, listIds, logPath })
}
