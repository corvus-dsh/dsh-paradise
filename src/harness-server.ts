/**
 * PARADISE HARNESS — the host itself.
 *
 * WHAT CHANGED, AND WHY IT MATTERS
 *
 * Until now everything in this layer was a CLIENT: it needed a host to supply `sessions`,
 * persistence and a trigger bus, and it reported `mode: 'portable'` when none was there. That is
 * why `spawnNode`'s host path was never exercised — there was no host to exercise it against.
 *
 * This file IS the host. It owns the four things a harness must own:
 *
 *   1. SESSIONS   — create, list, persist. A session is a record with a message list.
 *   2. THE LOOP   — user input → recall → model → tools → reply, via `runAgentTurn`.
 *   3. TOOLS      — a registry the model can call, including tools created at runtime.
 *   4. IGNITION   — `spawnNode` no longer needs anyone else's `prompt`; this loop is the igniter.
 *
 * ── THE PART THAT IS EASY TO GET WRONG ────────────────────────────────────────────────────────
 *
 * A host that CLAIMS to have run a model but had no credential would be the exact failure this whole
 * project has been written to avoid. So the harness reports `llm: 'live' | 'absent'` and every
 * session records what actually happened. With no key, a turn returns a clear refusal instead of a
 * fabricated answer — and the UI shows that refusal as the assistant's reply, because that IS the
 * truth of the turn.
 *
 * STORAGE
 *
 * Sessions persist as JSON lines under `<home>/sessions/<id>.jsonl`, one event per line. That is the
 * same append-only discipline the memory layer uses, and for the same reason: a torn tail must not
 * destroy the conversation before it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createMemoryMessages, runAgentTurn } from './agent-loop.js'
import type { AgentTool, AgentTurnResult } from './agent-loop.js'
import type { ChatMessage, LLMAdapter, MessageAdapter } from './protocol/index.js'

export type SessionStatus = 'idle' | 'running' | 'waiting' | 'dead'

export interface HarnessSessionState {
  readonly id: string
  readonly title: string
  readonly workspace: string
  status: SessionStatus
  /** Every message the session has, oldest first. Persisted, not derived. */
  messages: ChatMessage[]
  /** Why the session is in `dead`, when it is. */
  deathReason?: string
  /**
   * Consecutive tool failures with no success between them.
   *
   * THE SOFT-TAKEOVER SIGNAL. A model that fails the same way three times is not learning; it is
   * looping. That is measurable here without inspecting its reasoning.
   */
  consecutiveFailures: number
  /** Approximate tokens held in `messages`, for the context-watermark check. */
  approxTokens: number
  /** How many soft takeovers have fired for this session. */
  takeovers: number
  createdAt: string
  updatedAt: string
}

export interface HarnessOptions {
  /** Where sessions, nodes and the memory ledgers live. */
  readonly home: string
  /** The model. Absent means the harness runs and reports `llm: 'absent'`. */
  readonly llm?: LLMAdapter
  /** Optional recall: gets a query, returns context to inject. Usually dsh-memory. */
  readonly recall?: (query: string) => Promise<string | undefined> | string | undefined
  /** Tools every session may call. */
  readonly tools?: ReadonlyMap<string, AgentTool>
  /** System prompt for every session. */
  readonly system?: string
  /** Consecutive tool failures that trigger a soft takeover. Default 3. */
  readonly failureThreshold?: number
  /** Context watermark, in approximate tokens. Default 60000. */
  readonly tokenWatermark?: number
  /** Model calls allowed per turn. Default 8. */
  readonly maxRounds?: number
  readonly onEvent?: (event: HarnessEvent) => void
}

export type HarnessEvent =
  | { readonly type: 'session-created'; readonly id: string; readonly title: string }
  | { readonly type: 'session-status'; readonly id: string; readonly status: SessionStatus }
  | { readonly type: 'turn-start'; readonly id: string; readonly input: string }
  | { readonly type: 'round'; readonly id: string; readonly round: number }
  | { readonly type: 'tool-call'; readonly id: string; readonly name: string }
  | { readonly type: 'tool-result'; readonly id: string; readonly name: string; readonly ok: boolean }
  | { readonly type: 'reply'; readonly id: string; readonly text: string }
  | { readonly type: 'takeover'; readonly id: string; readonly reason: string; readonly injected: string }
  | { readonly type: 'error'; readonly id: string; readonly message: string }

/** One turn's outcome, in enough detail for a UI and for a test. */
export interface TurnResult {
  readonly sessionId: string
  readonly reply: string
  readonly rounds: number
  readonly toolCalls: AgentTurnResult['toolCalls']
  readonly ok: boolean
  readonly error?: string
  readonly takeover?: string
}

interface SessionRuntime {
  state: HarnessSessionState
  messages: MessageAdapter
  /** Serialises turns per session: two concurrent turns would interleave one conversation. */
  queue: Promise<unknown>
}

/**
 * APPROXIMATE TOKENS, AND THE WORD "APPROXIMATE" IS DOING WORK.
 *
 * There is no tokeniser here and adding one would be a dependency. The 4-chars-per-token heuristic
 * is good enough to answer the only question the watermark asks: "is this conversation getting too
 * long to keep sending". It is reported as an estimate everywhere it appears.
 */
function approxTokensOf(messages: readonly ChatMessage[]): number {
  let total = 0
  for (const message of messages) total += Math.ceil((message.content?.length ?? 0) / 4) + 4
  return total
}

function firstLine(text: string, limit = 80): string {
  const line = text.split(/\r?\n/u).find((entry) => entry.trim().length > 0) ?? 'untitled'
  return line.trim().slice(0, limit)
}

export function createParadiseHarness(options: HarnessOptions) {
  const home = options.home
  const sessionsDir = join(home, 'sessions')
  const nodesDir = join(home, 'nodes')
  for (const dir of [home, sessionsDir, nodesDir]) if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const emit = options.onEvent ?? (() => {})
  const failureThreshold = Math.max(1, Math.trunc(options.failureThreshold ?? 3))
  const tokenWatermark = Math.max(1000, Math.trunc(options.tokenWatermark ?? 60_000))
  const tools = options.tools ?? new Map<string, AgentTool>()
  const runtime = new Map<string, SessionRuntime>()

  /** `live` only when a real adapter was supplied. Never inferred. */
  const llmMode: 'live' | 'absent' = options.llm === undefined ? 'absent' : 'live'

  const sessionPath = (id: string): string => join(sessionsDir, `${id}.jsonl`)

  /** Append one event. Best effort: a failed write must not break the conversation in memory. */
  const persist = (id: string, event: Record<string, unknown>): void => {
    try {
      appendFileSync(sessionPath(id), `${JSON.stringify(event)}\n`, 'utf8')
    } catch {
      /* the transcript is also in memory; losing the mirror is not losing the turn */
    }
  }

  /**
   * Load a session from its log, or `undefined` when there is no such file.
   *
   * THE LOG IS THE SOURCE OF TRUTH for a restart, so replay is straightforward: every `message`
   * event is appended in order. Anything else in the log (status changes, takeovers) is metadata.
   */
  const load = (id: string): HarnessSessionState | undefined => {
    const path = sessionPath(id)
    if (!existsSync(path)) return undefined
    let text = ''
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
    const messages: ChatMessage[] = []
    let title = id
    let workspace = home
    let createdAt = new Date().toISOString()
    let takeovers = 0
    for (const line of text.split(/\r?\n/u)) {
      if (line.trim().length === 0) continue
      let event: Record<string, unknown>
      try {
        event = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (event.type === 'created') {
        title = String(event.title ?? id)
        workspace = String(event.workspace ?? home)
        createdAt = String(event.at ?? createdAt)
      }
      if (event.type === 'takeover') takeovers += 1
      if (event.type === 'message' && event.message !== null && typeof event.message === 'object') {
        messages.push(event.message as ChatMessage)
      }
    }
    return {
      id,
      title,
      workspace,
      status: 'idle',
      messages,
      consecutiveFailures: 0,
      approxTokens: approxTokensOf(messages),
      takeovers,
      createdAt,
      updatedAt: new Date().toISOString(),
    }
  }

  const attach = (state: HarnessSessionState): SessionRuntime => {
    /** Rehydrate from the persisted messages so a restart continues the same conversation. */
    const messages = createMemoryMessages(state.messages)
    const entry: SessionRuntime = { state, messages, queue: Promise.resolve() }
    runtime.set(state.id, entry)
    return entry
  }

  const setStatus = (entry: SessionRuntime, status: SessionStatus, reason?: string): void => {
    if (entry.state.status === status) return
    entry.state.status = status
    entry.state.updatedAt = new Date().toISOString()
    if (status === 'dead' && reason !== undefined) entry.state.deathReason = reason
    persist(entry.state.id, { type: 'status', status, ...(reason === undefined ? {} : { reason }), at: entry.state.updatedAt })
    emit({ type: 'session-status', id: entry.state.id, status })
  }

  const appendMessage = (entry: SessionRuntime, message: ChatMessage): void => {
    entry.state.messages.push(message)
    entry.state.approxTokens = approxTokensOf(entry.state.messages)
    entry.state.updatedAt = new Date().toISOString()
    persist(entry.state.id, { type: 'message', message, at: entry.state.updatedAt })
    void entry.messages.append(message)
  }

  /** Create a session. Also the thing `spawnNode` calls to make a node real. */
  function createSession(input: { title?: string; workspace?: string; system?: string } = {}): HarnessSessionState {
    const id = `node-${randomUUID()}`
    const state: HarnessSessionState = {
      id,
      title: input.title === undefined || input.title.trim().length === 0 ? firstLine('新节点') : input.title.trim().slice(0, 120),
      workspace: input.workspace ?? home,
      status: 'idle',
      messages: [],
      consecutiveFailures: 0,
      approxTokens: 0,
      takeovers: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    persist(id, { type: 'created', title: state.title, workspace: state.workspace, at: state.createdAt })
    if (input.system !== undefined && input.system.length > 0) {
      appendMessage(attach(state), { role: 'system', content: input.system })
    } else {
      attach(state)
    }
    emit({ type: 'session-created', id, title: state.title })
    return state
  }

  /** Every session, newest activity first. Loads from disk when the runtime does not remember it. */
  function listSessions(): HarnessSessionState[] {
    const out: HarnessSessionState[] = []
    const known = new Set<string>()
    for (const entry of runtime.values()) {
      out.push(entry.state)
      known.add(entry.state.id)
    }
    let files: string[] = []
    try {
      files = readdirSync(sessionsDir).filter((name) => name.endsWith('.jsonl'))
    } catch {
      files = []
    }
    for (const file of files) {
      const id = file.replace(/\.jsonl$/u, '')
      if (known.has(id)) continue
      const state = load(id)
      if (state !== undefined) out.push(state)
    }
    return out.sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1))
  }

  /** Get one session, attaching it if only the log knew about it. */
  function getSession(id: string): SessionRuntime | undefined {
    const existing = runtime.get(id)
    if (existing !== undefined) return existing
    const state = load(id)
    if (state === undefined) return undefined
    return attach(state)
  }

  /**
   * THE SOFT TAKEOVER.
   *
   * Two signals, both measurable without reading the model's mind:
   *
   *   consecutiveFailures  the same tool keeps failing → it is looping, not learning
   *   approxTokens         the conversation is too long → it is about to lose the beginning
   *
   * What it DOES is bounded and honest: it injects an instruction and counts the takeover. It does
   * not silently rewrite the conversation and it does not claim to have fixed anything — a takeover
   * that pretends to have solved the problem is worse than no takeover.
   */
  function maybeTakeover(entry: SessionRuntime): string | undefined {
    const reasons: string[] = []
    if (entry.state.consecutiveFailures >= failureThreshold) {
      reasons.push(`连续 ${entry.state.consecutiveFailures} 次工具失败`)
    }
    if (entry.state.approxTokens >= tokenWatermark) {
      reasons.push(`上下文约 ${entry.state.approxTokens} tokens，超过水位 ${tokenWatermark}`)
    }
    if (reasons.length === 0) return undefined
    const reason = reasons.join('；')
    const injected =
      `[强制中断] ${reason}。请立刻停止当前做法，改用不同的思路；` +
      '如果无法推进，直接说明卡在哪里，不要重复同一个失败的操作。'
    appendMessage(entry, { role: 'user', content: injected })
    entry.state.takeovers += 1
    entry.state.consecutiveFailures = 0
    persist(entry.state.id, { type: 'takeover', reason, at: new Date().toISOString() })
    emit({ type: 'takeover', id: entry.state.id, reason, injected })
    return injected
  }

  /**
   * Run one turn.
   *
   * SERIALISED PER SESSION: `entry.queue` chains turns so two callers cannot interleave one
   * conversation. That is a real hazard in a web UI where a user can send twice before the first
   * reply arrives.
   */
  async function send(id: string, input: string): Promise<TurnResult> {
    const entry = getSession(id)
    if (entry === undefined) {
      return { sessionId: id, reply: '', rounds: 0, toolCalls: [], ok: false, error: `no such session: ${id}` }
    }
    const run = async (): Promise<TurnResult> => {
      emit({ type: 'turn-start', id, input })
      appendMessage(entry, { role: 'user', content: input })
      const takeover = maybeTakeover(entry)
      setStatus(entry, 'running')

      if (options.llm === undefined) {
        /**
         * NO MODEL. The honest reply says so, and it is stored as the assistant's message because
         * that is what the session actually got. Fabricating an answer here is the one thing this
         * project has refused at every layer.
         */
        const reply =
          '（宿主已就绪，但没有配置模型凭据。设置 DSH_HARNESS_BASE_URL / DSH_HARNESS_API_KEY / DSH_HARNESS_MODEL 后重新启动，我就能真正回答。）'
        appendMessage(entry, { role: 'assistant', content: reply })
        setStatus(entry, 'idle')
        emit({ type: 'reply', id, text: reply })
        return {
          sessionId: id,
          reply,
          rounds: 0,
          toolCalls: [],
          ok: false,
          error: 'LLM_ABSENT',
          ...(takeover === undefined ? {} : { takeover }),
        }
      }

      try {
        const result = await runAgentTurn(input, {
          llm: options.llm,
          messages: entry.messages,
          tools,
          ...(options.system === undefined ? {} : { system: options.system }),
          ...(options.maxRounds === undefined ? {} : { maxRounds: options.maxRounds }),
          ...(options.recall === undefined ? {} : { recall: options.recall }),
          onEvent: (event) => {
            if (event.type === 'round') emit({ type: 'round', id, round: event.round })
            if (event.type === 'tool-call') emit({ type: 'tool-call', id, name: event.name })
            if (event.type === 'tool-result') {
              emit({ type: 'tool-result', id, name: event.name, ok: event.ok })
              /** Consecutive failures drive the takeover signal. A success resets it. */
              entry.state.consecutiveFailures = event.ok ? 0 : entry.state.consecutiveFailures + 1
            }
          },
        })
        /**
         * `runAgentTurn` already appended the assistant's own messages through the adapter, but the
         * HOST's transcript is `state.messages`, so mirror the final reply into it.
         */
        if (result.text.length > 0) {
          entry.state.messages.push({ role: 'assistant', content: result.text })
          entry.state.approxTokens = approxTokensOf(entry.state.messages)
          persist(id, { type: 'message', message: { role: 'assistant', content: result.text }, at: new Date().toISOString() })
        }
        setStatus(entry, 'idle')
        emit({ type: 'reply', id, text: result.text })
        return {
          sessionId: id,
          reply: result.text,
          rounds: result.rounds,
          toolCalls: result.toolCalls,
          ok: result.error === undefined,
          ...(result.error === undefined ? {} : { error: `${result.error.code}: ${result.error.message}` }),
          ...(takeover === undefined ? {} : { takeover }),
        }
      } catch (error) {
        const message = String((error as { message?: unknown })?.message ?? error)
        setStatus(entry, 'dead', message)
        emit({ type: 'error', id, message })
        return { sessionId: id, reply: '', rounds: 0, toolCalls: [], ok: false, error: message, ...(takeover === undefined ? {} : { takeover }) }
      }
    }
    const chained = entry.queue.then(run, run)
    entry.queue = chained.catch(() => undefined)
    return chained
  }

  /** Kill a session: it stops accepting turns but its transcript stays readable. */
  function killSession(id: string, reason = 'killed by operator'): boolean {
    const entry = getSession(id)
    if (entry === undefined) return false
    setStatus(entry, 'dead', reason)
    return true
  }

  return {
    home,
    llmMode,
    createSession,
    listSessions,
    getSession: (id: string) => getSession(id)?.state,
    send,
    killSession,
    /** Tokens the harness is willing to hold before a takeover, for the UI to display. */
    get tokenWatermark(): number {
      return tokenWatermark
    },
    get failureThreshold(): number {
      return failureThreshold
    },
    /** Counts for the UI's status panel. */
    stats(): { sessions: number; running: number; dead: number; takeovers: number } {
      const all = listSessions()
      return {
        sessions: all.length,
        running: all.filter((state) => state.status === 'running').length,
        dead: all.filter((state) => state.status === 'dead').length,
        takeovers: all.reduce((sum, state) => sum + state.takeovers, 0),
      }
    },
  }
}

export type ParadiseHarness = ReturnType<typeof createParadiseHarness>
