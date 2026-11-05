/**
 * A REFERENCE IMPLEMENTATION WITH NO HOST — and the reason it is not a toy.
 *
 * WHY THIS FILE IS THE PROOF
 *
 * The user's requirement is "decouple the functional layer from the harness", and there is exactly
 * one way to know whether that succeeded: run it against a host that shares nothing with the
 * original. A mock that reuses the original's vocabulary proves nothing. So this adapter is built
 * from the PROTOCOL's words only — containers, content, turns, receipts — and it keeps everything in
 * memory.
 *
 * What it deliberately does NOT model: nothing about a real durable log, no compression, no event
 * feed from a file. Those are one host's implementation. This host holds conversations in a Map,
 * which is a perfectly valid host, and a functional layer that works here and also works on the real
 * one has been genuinely decoupled.
 *
 * It is also the fixture the conformance suite runs against, so "the protocol is implementable" is
 * checked on every test run rather than asserted in a document.
 */

import type {
  ContextItem,
  DeletionProbe,
  LeaseAdapter,
  LogEvent,
  LogReading,
  MutationReceipt,
  RenderedItem,
  SessionAdapter,
  SessionCapabilities,
  SessionEvent,
  SessionRef,
  StorageAdapter,
  ToolAdapter,
  ToolDescriptor,
  ToolOutcome,
  TriggerMode,
  TurnTrigger,
  Unsubscribe,
} from '../../protocol/index.js'
import { LEASE_RELEASE } from '../../protocol/lease.js'
import { createStorageLeaseAdapter } from '../../lease-adapter.js'

interface MemorySession {
  ref: SessionRef
  title: string
  events: LogEvent[]
  /** Content written while the session was running, for the inject-into-running capability. */
  running: boolean
  listeners: Set<(event: SessionEvent) => void>
}

function receipt(stage: string, warnings: string[] = []): MutationReceipt {
  return { ok: true, stage, warnings }
}

function failure(code: string, stage: string, message: string): MutationReceipt {
  return { ok: false, stage, warnings: [], error: { code, stage, message } }
}

/** Absolute path test that names no host: drive letter, UNC, or POSIX root. */
function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\') || value.startsWith('/')
}

export interface MemoryHost {
  name: string
  session: SessionAdapter
  storage: StorageAdapter
  lease: LeaseAdapter
  tools: ToolAdapter
  /** Everything this host holds, for a test to inspect. */
  dump(): { sessions: Map<string, MemorySession>; files: Map<string, unknown> }
}

/**
 * Build an in-memory host that satisfies the protocol.
 *
 * Every capability the protocol defines is answerable here, which is what makes the conformance suite
 * meaningful: a host that CAN do everything is the right baseline for "and the functional layer does
 * not need anything outside the protocol".
 */
export function createMemoryHost(): MemoryHost {
  const sessions = new Map<string, MemorySession>()
  const files = new Map<string, unknown>()
  /**
   * Serialises concurrent `compareAndSet` bodies — see the storage adapter below.
   *
   * Starts RESOLVED, and each link is attached with both handlers so a refused or throwing CAS cannot
   * poison the chain for every later caller. That failure mode is worth naming: a permanently rejected
   * queue would make every subsequent `compareAndSet` skip its body and report `ok: false`, which on a
   * lease reads as "someone else holds it" forever.
   */
  let casQueue: Promise<unknown> = Promise.resolve()
  let counter = 0
  const nextId = (prefix: string): string => {
    counter += 1
    return `${prefix}-${counter}`
  }

  const emit = (session: MemorySession, event: LogEvent): void => {
    for (const listener of session.listeners) listener({ sessionId: session.ref.id, event })
  }

  const appendEvent = (session: MemorySession, type: string, data: unknown): LogEvent => {
    const event: LogEvent = { seq: session.events.length, type, time: Date.now(), data }
    session.events.push(event)
    emit(session, event)
    return event
  }

  const capabilities: SessionCapabilities = {
    create: true,
    injectIntoIdle: true,
    injectIntoRunning: true,
    trigger: true,
    readLog: true,
    subscribe: true,
    verifyDeletion: true,
    unavailable: [],
  }

  const session: SessionAdapter = {
    name: 'memory',
    capabilities,
    async create(input) {
      if (typeof input.cwd !== 'string' || input.cwd.trim().length === 0) {
        return failure('WORKSPACE_REQUIRED', 'create', '协议不允许创建没有归属的会话')
      }
      if (!isAbsolutePath(input.cwd.trim())) {
        return failure('WORKSPACE_RELATIVE', 'create', `工作目录必须是绝对路径：${input.cwd}`)
      }
      const id = typeof input.id === 'string' && input.id.length > 0 ? input.id : nextId('memory-session')
      if (sessions.has(id)) return failure('SESSION_EXISTS', 'create', `会话已存在：${id}`)
      const ref: SessionRef = { id, cwd: input.cwd.trim() }
      sessions.set(id, { ref, title: input.title ?? '', events: [], running: false, listeners: new Set() })
      return { ...receipt('create'), session: ref }
    },
    async inject(ref, items: ContextItem[]) {
      const target = sessions.get(ref.id)
      if (target === undefined) return { ...failure('SESSION_NOT_FOUND', 'inject', ref.id), rendered: [] }
      if (target.running && !capabilities.injectIntoRunning) {
        return { ...failure('INJECT_WHILE_RUNNING', 'inject', '本宿主不支持写入运行中的会话'), rendered: [] }
      }
      /**
       * THE VISIBILITY ANSWER IS PER ITEM, AND IT IS AN ANSWER — not an echo of the request.
       *
       * `context-only` is honoured as written (it is a legitimate choice). `visible` is honoured too,
       * because this host renders everything it holds. A host that cannot would set `rendered: false`
       * and say why, which is the field's whole purpose.
       */
      const rendered: RenderedItem[] = []
      for (const item of items) {
        const id = item.id ?? nextId('item')
        appendEvent(target, 'content', { id, text: item.text, visibility: item.visibility, origin: item.origin })
        rendered.push({
          id,
          requested: item.visibility,
          rendered: item.visibility === 'visible',
          reason: item.visibility === 'visible' ? '' : 'context-only 是显式选择，不渲染是正确的',
        })
      }
      return { ...receipt('inject'), rendered }
    },
    async trigger(ref, trigger: TurnTrigger) {
      const target = sessions.get(ref.id)
      if (target === undefined) return failure('SESSION_NOT_FOUND', 'trigger', ref.id)
      if (!capabilities.trigger) {
        return failure('TRIGGER_UNSUPPORTED', 'trigger', '本宿主不能点火；会话仍可手动打开')
      }
      const mode: TriggerMode = trigger.mode
      appendEvent(target, 'turn', { text: trigger.text, mode, origin: trigger.origin })
      target.running = true
      return receipt(`trigger:${mode}`)
    },
    async readLog(ref): Promise<LogReading> {
      const target = sessions.get(ref.id)
      if (target === undefined) {
        return {
          readable: false,
          path: '',
          pathSource: 'memory',
          bytes: 0,
          frameCount: 0,
          framesDecoded: 0,
          events: [],
          eventTypes: [],
          eventCount: 0,
          firstMessage: null,
          notes: [`会话不存在：${ref.id}`],
        }
      }
      const firstContent = target.events.find((event) => event.type === 'content')
      return {
        readable: true,
        path: `memory://${ref.id}`,
        pathSource: 'memory',
        bytes: 0,
        frameCount: 0,
        framesDecoded: 0,
        events: [...target.events],
        eventTypes: target.events.map((event) => event.type),
        eventCount: target.events.length,
        firstMessage:
          firstContent === undefined
            ? null
            : {
                seq: firstContent.seq,
                type: firstContent.type,
                role: String((firstContent.data as any)?.visibility ?? ''),
                origin: String((firstContent.data as any)?.origin ?? ''),
                textLength: String((firstContent.data as any)?.text ?? '').length,
                textHead: String((firstContent.data as any)?.text ?? '').slice(0, 120),
                rendered: (firstContent.data as any)?.visibility === 'visible',
              },
        notes: [],
      }
    },
    subscribe(ref, listener: (event: SessionEvent) => void): Unsubscribe {
      const target = sessions.get(ref.id)
      if (target === undefined) return () => {}
      target.listeners.add(listener)
      return () => {
        target.listeners.delete(listener)
      }
    },
    /**
     * THE WRITE-FREE ANSWER, and it is exact here: an in-memory host always knows whether it holds a
     * session, so it never has to answer `unverifiable`. That is what makes it a useful contrast with
     * the durable adapter — the three-valued answer collapses to two only when the host can actually
     * say.
     */
    async probeDeletion(ref): Promise<DeletionProbe> {
      return sessions.has(ref.id) ? 'present' : 'absent'
    },
  }

  const storage: StorageAdapter = {
    name: 'memory',
    async read(key) {
      return files.get(key)
    },
    async write(key, value) {
      // Deep copy on the way in: a caller mutating its own object afterwards must not change what is
      // "stored", which is the one property an atomic writer has to have even in memory.
      files.set(key, JSON.parse(JSON.stringify(value ?? null)))
      return receipt('write')
    },
    async remove(key) {
      files.delete(key)
      return receipt('remove')
    },
    async keys(prefix) {
      const all = [...files.keys()]
      return prefix === undefined ? all : all.filter((key) => key.startsWith(prefix))
    },
    /**
     * REAL EXCLUSION, EVEN IN MEMORY.
     *
     * A single-threaded `Map` still needs this: `verify` is a user callback that can await, and two
     * concurrent `compareAndSet` calls would otherwise both read the old value before either wrote.
     * The chain below serialises them, so this host exercises the SAME lease code path as the real one
     * instead of a weaker one that would let a fencing bug through unnoticed.
     */
    compareAndSet(key, verify) {
      const run = async (): Promise<{ ok: boolean; value?: unknown; warnings: string[] }> => {
        const current = files.get(key)
        const next = verify(current)
        if (next === undefined) return { ok: false, warnings: [] }
        if (next === LEASE_RELEASE) {
          files.delete(key)
          return { ok: true, warnings: [] }
        }
        files.set(key, JSON.parse(JSON.stringify(next ?? null)))
        return { ok: true, value: next, warnings: [] }
      }
      const chained = casQueue.then(run, run)
      // The queue must never stay rejected, or every later CAS would skip its body.
      casQueue = chained.then(
        () => undefined,
        () => undefined,
      )
      return chained
    },
  }

  const tools: ToolAdapter = {
    name: 'memory',
    async list(): Promise<ToolDescriptor[]> {
      return [{ name: 'echo', description: 'Echo the arguments back.', inputSchema: { type: 'object' } }]
    },
    async execute(input): Promise<ToolOutcome> {
      if (input.name === 'echo') return { isError: false, value: input.arguments }
      return { isError: true, error: { code: 'UNKNOWN_TOOL', message: `未知工具：${input.name}` } }
    },
  }

  return {
    // A host MUST name itself: `bindHost` and every log line use the name to say which
    // implementation is in play, and "unnamed host" in a failure report is useless.
    name: 'memory',
    session,
    storage,
    /** The same lease implementation the durable host uses — only the storage underneath differs. */
    lease: createStorageLeaseAdapter(storage),
    tools,
    dump: () => ({ sessions, files }),
  }
}
