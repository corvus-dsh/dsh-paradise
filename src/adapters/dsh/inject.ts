/**
 * INJECT — build the events, and prove the shape BEFORE anything is reserved.
 *
 * WHAT THIS FILE IS, AND WHAT IT IS NOT
 *
 * It is the writer's SHAPE half: turn the caller's intent (some text, a title, a visibility) into the
 * exact event tape this runtime accepts, and validate it. It does not create a session, does not open
 * a handle, and touches no service — which is why a shape mistake costs nothing: no id is reserved,
 * no artifact exists, no cleanup is needed.
 *
 * WHERE THE RULES CAME FROM (each one cost something to learn)
 *
 *   1. THE SKELETON MUST BE CLOSED. A message outside an open step is the write this host refuses,
 *      and a cold artifact has no open step at all. So: turn/start → step/start → … → step/end →
 *      turn/end, and the session is ASLEEP when it is born.
 *   2. THE CARRYING MESSAGE MUST BE VISIBLE. `user/message` is rendered; `developer/message` is
 *      written, stored, readable — and shown nowhere. That was a whole release.
 *   3. VISIBILITY AND PROVENANCE PULL IN OPPOSITE DIRECTIONS. The renderer keeps a `user/message`
 *      only when `source.kind === 'user'`, so provenance cannot live there; it rides on the message
 *      ID instead, which no projector consults. The one thing that must never be true is an `rpcId`:
 *      that is what marks a real human prompt.
 *   4. A VISIBLE PLAN NEEDS TWO SURFACES. The renderer and the model-context path disagree about
 *      which roles are speech, so the plan travels as a `user/message` AND as an `assistant/message`
 *      echo. The honest cost — it appears twice — is stated in the receipt rather than hidden.
 *   5. THE FIRST SURFACE NODE MUST BE THE SYSTEM HEAD. Replacing it is a host invariant; a tape that
 *      opens with anything else is rejected.
 *
 * NOTHING HERE KNOWS A SERVICE NAME. The one host-shaped thing it needs — "which event type means
 * visible on this runtime" — comes from `./policy.js`, in this same adapter directory.
 */

import { MESSAGE_TYPE_FOR_INTENT, PLUGIN_SOURCE_PREFIX } from './policy.js'

/** A tape seed: the event before seq/time are assigned. */
export interface TapeSeed {
  type: string
  data: Record<string, any>
  /** A message may be surface; a skeleton event must not. */
  surface: boolean
}

/** A materialised event: seq/time assigned, `surfaceOp` only where legal. */
export interface TapeEvent {
  type: string
  seq: number
  time: number
  data: Record<string, any>
  surfaceOp?: 'append'
}

/** Event types this runtime treats as surface (conversation) nodes. */
export const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message'])

/** The ID prefix that marks a message as OURS. Provenance lives here because the source kind cannot. */
export const BRIEFING_ID_PREFIX = 'observer-briefing-'

/** What a caller wants placed into a fresh session. */
export interface InjectShape {
  sessionId: string
  cwd: string
  text: string
  title: string
  /** `visible` renders in the transcript; `context-only` is present but shown nowhere. */
  visibility: 'visible' | 'context-only'
  /** Provenance, e.g. `plugin:observer:briefing`. Stored on the id, reported in the receipt. */
  origin: string
  /** Runtime knobs inherited from the source session (provider/model/preset/policy). */
  runtimeIntent?: Record<string, Record<string, any>>
  /** The system head this runtime requires as the first surface node. */
  systemPrompt: string
}

/** The adapter's own error, carrying the step it failed in. */
export class InjectShapeError extends Error {
  readonly code: string
  readonly stage: string
  constructor(code: string, stage: string, message: string) {
    super(`[${code}] ${message}`)
    this.name = 'InjectShapeError'
    this.code = code
    this.stage = stage
  }
}

/** Windows drive, UNC, or POSIX absolute. A relative cwd is a bug, not a path. */
export function isAbsoluteCwd(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\') || value.startsWith('/')
}

/** The distinguishable tail of a session id. `session-` is a constant, not entropy. */
export function shortSessionTag(sessionId: string, length = 8): string {
  const stemless = String(sessionId ?? '').replace(/^session-/u, '')
  const head = stemless.slice(0, length)
  return head.length > 0 ? head : String(sessionId ?? '').slice(-length)
}

/** The sidebar title a cold session carries. `{main}` becomes its own id tag. */
export function resolveTitle(template: string, sessionId: string): string {
  const tag = shortSessionTag(sessionId)
  const base = typeof template === 'string' ? template.trim() : ''
  if (base.length === 0) return `[主脑] ${tag}`
  return base.includes('{main}') ? base.split('{main}').join(tag) : `${base} · ${tag}`
}

/**
 * Build the tape seeds for one session.
 *
 * Throws `InjectShapeError` with a stage for anything that would produce an illegal artifact, so the
 * caller can fail before reserving an id.
 */
export function buildTape(input: InjectShape): TapeSeed[] {
  const { sessionId, cwd, text, title } = input
  const visible = input.visibility !== 'context-only'
  const turn = 1
  const step = 1

  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new InjectShapeError('EMPTY_CONTENT', 'build-tape', '注入内容为空：会话不能在没有内容的情况下诞生')
  }
  if (!isAbsoluteCwd(cwd)) {
    throw new InjectShapeError('CWD_INVALID', 'build-tape', `cwd ${JSON.stringify(cwd)} 不是绝对路径`)
  }
  if (typeof input.origin !== 'string' || !input.origin.startsWith(PLUGIN_SOURCE_PREFIX)) {
    throw new InjectShapeError(
      'ORIGIN_REQUIRED',
      'build-tape',
      `注入内容必须带 ${PLUGIN_SOURCE_PREFIX} 前缀的来源标记（实际 ${JSON.stringify(input.origin)}）`,
    )
  }
  if (sessionId.length === 0) {
    throw new InjectShapeError('MISSING_ID', 'build-tape', '缺少会话 id')
  }

  const messageId = `${BRIEFING_ID_PREFIX}${sessionId}`

  /**
   * THE CARRYING MESSAGE.
   *
   * Visible: `user/message` with `source.kind: 'user'` (what the renderer demands) and provenance on
   * the id (what no projector consults). It carries NO `turn`/`step`: this runtime's own user messages
   * do not, and a pair here would be a shape the host never writes.
   *
   * Context-only: `developer/message`, step-scoped, invisible by design — and the receipt will say so.
   */
  const visibleMessage: Record<string, any> = {
    id: messageId,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
  const contextMessage: Record<string, any> = {
    id: messageId,
    role: 'developer',
    content: [{ type: 'text', text }],
    source: { kind: 'system-prompt' },
  }

  /**
   * THE RENDERED ECHO — only for a visible plan, and only because the renderer and the model-context
   * path disagree about which roles count as speech. `stream: []` is mandatory (a synthetic message
   * has no model stream, and a copied one would make content and stream disagree); `source.kind` must
   * be producer-owned and NOT `plugin` (the validator refuses a bare plugin kind on an assistant message).
   */
  const assistantEcho: TapeSeed = {
    type: 'assistant/message',
    data: {
      turn,
      step,
      message: {
        id: `${messageId}-echo`,
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'paradise', model: 'briefing-echo' },
      },
      stream: [],
    },
    surface: true,
  }

  const seeds: TapeSeed[] = [
    { type: 'turn/start', data: { turn }, surface: false },
    { type: 'step/start', data: { turn, step }, surface: false },
    {
      type: 'system/message',
      data: {
        turn,
        step,
        message: {
          id: `${BRIEFING_ID_PREFIX}${sessionId}-system`,
          role: 'system',
          content: [{ type: 'text', text: input.systemPrompt }],
          // The host replaces surface node 0 with its own rendered prompt on the first live step;
          // `system-prompt` is the only source kind a system message may carry.
          source: { kind: 'system-prompt' },
        },
      },
      // The FIRST surface node: a host invariant, not a preference.
      surface: true,
    },
    {
      type: MESSAGE_TYPE_FOR_INTENT[visible ? 'visible' : 'context-only'],
      data: visible ? visibleMessage : { turn, step, message: contextMessage },
      surface: true,
    },
    ...(visible ? [assistantEcho] : []),
    {
      type: 'session/title',
      data: {
        title: resolveTitle(title, sessionId),
        // This runtime's rule: an EMPTY reference list requires `source.kind: 'user'`. A tape has no
        // human message for the title to cite, so empty + 'user' is the only legal shape.
        messageSeqs: [],
        source: { kind: 'user' },
      },
      surface: false,
    },
    { type: 'step/end', data: { turn, step }, surface: false },
    { type: 'turn/end', data: { turn, reason: { kind: 'completed' } }, surface: false },
  ]

  // Runtime knobs LAST, after the closed turn — exactly where this host writes them, log-only so they
  // can never affect the protected surface head.
  const intent = input.runtimeIntent ?? {}
  for (const [type, data] of [
    ['permission/preset', intent.permission],
    ['sandbox/mode', intent.sandbox],
    ['approval/policy', intent.approval],
    ['model/selection', intent.model],
  ] as Array<[string, Record<string, any> | undefined]>) {
    if (data === undefined) continue
    seeds.push({ type, data, surface: false })
  }

  return seeds
}

/**
 * Assign seq/time, and `surfaceOp` only where the host allows it.
 *
 * `ReadonlyArray<T>` rather than `readonly T[]`: Node's type STRIPPER (which builds this package)
 * rejects the `readonly`-prefixed array form, and a build that fails on a type annotation is a build
 * that fails for no reason. The intent is identical.
 */
export function materialiseTape(seeds: ReadonlyArray<TapeSeed>, createdAt: number): TapeEvent[] {
  if (!Array.isArray(seeds) || seeds.length === 0) {
    throw new InjectShapeError('EMPTY_TAPE', 'materialise', '注入 tape 为空')
  }
  return seeds.map((seed, index) => {
    const event: TapeEvent = {
      type: seed.type,
      seq: index,
      time: createdAt + index,
      data: seed.data,
    }
    if (seed.surface) {
      if (!SURFACE_TYPES.has(seed.type)) {
        throw new InjectShapeError('SURFACE_TYPE', 'materialise', `${seed.type} 不能作为 surface 事件写出`)
      }
      event.surfaceOp = 'append'
    }
    return event
  })
}

/** What the shape validator needs to know to apply the right contract. */
export interface ValidateShapeInput {
  events: readonly TapeEvent[]
  sessionId: string
  cwd: string
  expectedText: string
  visibility: 'visible' | 'context-only'
  /**
   * Did THIS adapter compose the tape (`items` → `buildTape`), or did a caller bring its own?
   *
   * The distinction is not cosmetic: `buildTape` chooses the carrying message's `source.kind` and is
   * therefore bound by its own convention, while a caller-supplied tape is another plugin's log, whose
   * provenance vocabulary belongs to that plugin. Defaults to `true` so every pre-existing call site
   * keeps the strict composed-path contract.
   */
  composed?: boolean
}

/**
 * Validate the whole tape. Runs BEFORE `create`, so a shape mistake costs nothing.
 *
 * Runs again on the COLD READ with the same rules: the reader's copy must pass the same validator the
 * writer's copy passed, or the check only proves the log is the same length — and a lost `surfaceOp`
 * or a role that came back different would sail through.
 */
export function assertTape(input: ValidateShapeInput): void {
  const { events, sessionId, cwd, expectedText } = input
  const visibility: 'visible' | 'context-only' = input.visibility === 'context-only' ? 'context-only' : 'visible'
  /** Which contract applies to the carrying message — see `ValidateShapeInput.composed`. */
  const wasComposed = input.composed !== false
  /**
   * A local helper rather than an inline `throw` at each site: the validator has ~30 checks and every
   * one needs the SAME stage, so repeating it invites one of them drifting.
   *
   * NOTE the missing return annotation. Node's type STRIPPER (which is what builds this package) parses
   * a smaller TypeScript subset than `tsc`; `: never` on a function that only throws is one of the
   * forms it rejects. The function's behaviour is unchanged — it always throws.
   */
  function fail(code: string, message: string) {
    throw new InjectShapeError(code, 'validate', message)
  }

  if (!isAbsoluteCwd(cwd)) fail('CWD_INVALID', `cwd ${JSON.stringify(cwd)} 不是绝对路径`)
  if (events.length < 5) fail('TAPE_TOO_SHORT', `tape 只有 ${events.length} 个事件，缺少完整骨架`)

  for (const [index, event] of events.entries()) {
    if (Number(event.seq) !== index) fail('SEQ_GAP', `事件 ${index} 的 seq 是 ${String(event.seq)}`)
    if (SURFACE_TYPES.has(event.type)) {
      if (event.surfaceOp !== 'append') fail('RED_LINE_SURFACE', `${event.type} 必须带 surfaceOp: 'append'`)
    } else if (event.surfaceOp !== undefined) {
      fail('RED_LINE_SURFACE', `${event.type} 不得带 surfaceOp`)
    }
    if (event.type === 'tool/result') fail('RED_LINE_TOOL_RESULT', 'tape 里不能有独立的 tool/result')
  }

  /* the lifecycle machine: a message outside an open step is the write the host refuses */
  let turn: number | null = null
  let step: number | null = null
  const surfaces: string[] = []
  for (const event of events) {
    switch (event.type) {
      case 'turn/start': {
        if (turn !== null) fail('SKELETON', `turn ${turn} 仍然打开时又写了 turn/start`)
        if (event.data?.turn !== 1) fail('SKELETON', `turn/start 的 turn 必须是 1，实际 ${String(event.data?.turn)}`)
        turn = 1
        step = null
        break
      }
      case 'step/start': {
        if (turn === null) fail('SKELETON', 'step/start 之前没有 turn/start')
        if (step !== null) fail('SKELETON', `step ${step} 仍然打开时又写了 step/start`)
        if (event.data?.turn !== turn || event.data?.step !== 1) {
          fail('SKELETON', `step/start 的 turn/step 必须是 ${turn}/1`)
        }
        step = 1
        break
      }
      case 'step/end': {
        if (step === null || event.data?.step !== step) fail('SKELETON', 'step/end 与打开的 step 不匹配')
        step = null
        break
      }
      case 'turn/end': {
        if (turn === null || step !== null) fail('SKELETON', 'turn/end 之前 step 仍然打开')
        if (event.data?.turn !== turn) fail('SKELETON', 'turn/end 的 turn 与打开的不一致')
        if (event.data?.reason?.kind !== 'completed') {
          fail('SKELETON', "turn/end 的 reason.kind 必须是 'completed'，会话必须休眠着出生")
        }
        turn = null
        break
      }
      default: {
        if (SURFACE_TYPES.has(event.type)) {
          surfaces.push(event.type)
          /**
           * STEP-SCOPED vs FREE. A user message carries NO turn/step on this runtime (measured: real
           * logs hold `data{content,source,role,id}` and nothing else), while the other surface kinds
           * are validated against the OPEN pair. Enforcing the pair on a user message would reject the
           * shape the host itself writes; skipping it elsewhere would let the historical bug through.
           */
          const stepScoped = event.type !== 'user/message'
          if (stepScoped) {
            if (turn === null || step === null) {
              fail(
                'STEP_OUTSIDE_TURN',
                `${event.type} 写在了没有打开的 turn/step 之外 —— 这就是宿主拒绝的那类写入`,
              )
            }
            if (event.data?.turn !== turn || event.data?.step !== step) {
              fail('STEP_OUTSIDE_TURN', `${event.type} 的 turn/step 与打开的 ${turn}/${step} 不一致`)
            }
          } else if (event.data?.turn !== undefined || event.data?.step !== undefined) {
            fail('USER_MESSAGE_STEP_SCOPE', 'user/message 不能携带 turn/step：宿主自己的 user/message 从不带这两个字段')
          }
        }
        break
      }
    }
  }
  if (turn !== null || step !== null) fail('SKELETON_OPEN', 'tape 结束时骨架仍未闭合')
  if (surfaces[0] !== 'system/message') {
    fail('RED_LINE_SYSTEM_HEAD', '第一个 surface 事件必须是 system/message（受保护的 surface head）')
  }

  /* THE CARRYING MESSAGE: found by ROLE, not by event type */
  const briefingIndex = events.findIndex(
    (event) => event.type === 'user/message' || event.type === 'developer/message',
  )
  if (briefingIndex < 0) fail('MISSING_BRIEFING', 'tape 里没有承载内容的 user/message 或 developer/message')
  const briefing = events[briefingIndex]
  const briefingMessage = briefing.data?.message ?? briefing.data
  if (briefingMessage?.role !== 'user' && briefingMessage?.role !== 'developer') {
    fail('RED_LINE_BRIEFING_ROLE', `承载内容的消息 role 是 ${String(briefingMessage?.role)}，应为 user 或 developer`)
  }
  if (briefingMessage?.content?.[0]?.text !== expectedText) {
    fail('BRIEFING_MISMATCH', '承载内容的消息内容与传入的文本不一致')
  }

  if (visibility === 'visible') {
    if (briefing.type !== MESSAGE_TYPE_FOR_INTENT.visible) {
      fail('VISIBILITY_MISMATCH', `可见内容必须是 ${MESSAGE_TYPE_FOR_INTENT.visible}，实际 ${briefing.type}`)
    }
    /**
     * THE SOURCE KIND OF A VISIBLE MESSAGE — a HOST fact and a CALLER fact, kept apart.
     *
     * There are two legal populations here, and conflating them is what refused every replay tape:
     *
     *   - COMPOSED (`items` → `buildTape`): this adapter authored the message, and nobody else can
     *     claim to have. The id carries the provenance (`observer-briefing-…`), so the source kind is
     *     free to be the renderer's `'user'` — that is exactly the shape `buildTape` emits.
     *   - CALLER TAPE: someone else wrote this log, and this adapter cannot dictate the provenance
     *     vocabulary they use. `graft-slice` marks its replayed goal `plugin:graft-replay` ON PURPOSE,
     *     so that a later generation replaying the log never mistakes the plugin's own words for the
     *     human's — that is a correctness requirement of the tape, not a defect.
     *
     * The HOST-level rule survives both: a visible `user/message` must carry a NON-EMPTY source kind,
     * and an `rpcId` (the marker of a real human prompt) must never be forged. What this validator no
     * longer does is insist on the composed path's spelling when a caller brought its own tape.
     */
    const briefingKind = briefingMessage?.source?.kind
    if (visibility === 'visible' && wasComposed) {
      if (briefingKind !== 'user') {
        fail(
          'RED_LINE_BRIEFING_SOURCE',
          `可见的 user/message 的 source.kind 必须是 'user'（实际 ${JSON.stringify(briefingKind)}）—— ` +
            '投影器只渲染 kind=user 的 user/message，其它值等于主动隐藏它',
        )
      }
    } else if (typeof briefingKind !== 'string' || briefingKind.length === 0) {
      fail(
        'RED_LINE_BRIEFING_SOURCE',
        '可见的 user/message 必须带非空的 source.kind：没有来源就无法判断这条消息该不该被渲染',
      )
    }
    if (briefingMessage?.role !== 'user') fail('RED_LINE_BRIEFING_ROLE', 'user/message 的 message.role 必须是 user')
    /**
     * PROVENANCE: the id must NAME ITS OWNER, not carry a fixed prefix.
     *
     * The rule this enforces is "a plugin-authored message must be distinguishable from something a
     * human typed". The first version spelled that as "starts with `observer-briefing-`", which is the
     * OBSERVER's marker — correct for that caller, wrong as a shared rule: a different plugin bringing a
     * replay tape (its own goal/briefing ids) was refused with a message telling it to use someone
     * else's prefix.
     *
     * So the check is on the SHAPE of ownership: the id must be non-empty and must not be a bare UUID or
     * a number, because an id that carries no owner cannot answer "who wrote this?" — which is the only
     * question this line exists to keep answerable.
     */
    if (typeof briefingMessage?.id !== 'string' || briefingMessage.id.trim().length === 0) {
      fail('RED_LINE_BRIEFING_PROVENANCE', '可见的 user/message 必须带 id，否则无法把这条消息与真人写的区分开')
    }
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/iu.test(briefingMessage.id) || /^\d+$/u.test(briefingMessage.id)) {
      fail(
        'RED_LINE_BRIEFING_PROVENANCE',
        `可见的 user/message 的 id ${JSON.stringify(briefingMessage.id)} 只是一个裸标识，不带任何来源名称——` +
          '无法回答"这条消息是谁写的"，也就无法与真人输入区分',
      )
    }
    if (briefingMessage?.source?.rpcId !== undefined) {
      fail('RED_LINE_BRIEFING_PROVENANCE', '我们写的 user/message 不能带 rpcId —— 那是真人 prompt 的标记')
    }

    /* THE RENDERED ECHO — a COMPOSED-path convention, checked only when this adapter composed it */
    /**
     * WHY THE WHOLE ECHO CONTRACT IS COMPOSED-ONLY.
     *
     * `buildTape` emits the carrying message WITHOUT a turn/step (the host's own user messages carry
     * none) plus an assistant echo, because the renderer and the model-context path disagree about
     * which roles count as speech. That pairing is this adapter's answer to "make the plan visible",
     * and the echo text is required to EQUAL the carrying text — because on that path both were authored
     * here from the same string.
     *
     * A caller-supplied replay tape answers a different question: what the previous session CONTAINED.
     * Such a tape legitimately holds MANY assistant messages (the replayed conversation), none of which
     * echoes the goal. Applying this contract there does not check anything real — it just picks the
     * first historical assistant message and demands it be a copy of the brief. `graft-slice` in
     * particular must NOT write an echo: a fabricated model turn would be replayed by the next slice as
     * if the model had said it.
     *
     * The HOST rules about an assistant message are still enforced for every tape: `surfaceOp` in the
     * loop above, and — for any assistant message actually present — role, `stream: []` and a
     * producer-owned source kind.
     */
    const echo = events.find((event) => event.type === 'assistant/message')
    if (wasComposed && echo === undefined) {
      fail('MISSING_ECHO', '可见内容缺少 assistant/message 回显：宿主会渲染它，缺了就等于只在模型侧可见')
    }
    if (wasComposed && echo !== undefined) {
      const echoMessage = echo.data?.message
      if (echoMessage?.role !== 'assistant') fail('RED_LINE_ECHO_ROLE', 'assistant/message 的 role 必须是 assistant')
      if (!Array.isArray(echo.data?.stream) || echo.data.stream.length !== 0) {
        fail('RED_LINE_ECHO_STREAM', 'assistant/message 的 stream 必须是 []')
      }
      const echoKind = echoMessage?.source?.kind
      if (typeof echoKind !== 'string' || echoKind.length === 0 || echoKind === 'plugin') {
        fail(
          'RED_LINE_ECHO_SOURCE',
          `assistant/message 的 source.kind 必须是 producer-owned 且不是 'plugin'（实际 ${JSON.stringify(echoKind)}）`,
        )
      }
      if (echoMessage?.content?.[0]?.text !== expectedText) {
        fail('ECHO_MISMATCH', 'assistant/message 回显的文本与传入内容不一致')
      }
    }
  }

  /**
   * EVERY assistant message must still be a legal one — on any path.
   *
   * The echo above checks the COMPOSED contract; this checks the HOST contract, so a caller tape cannot
   * smuggle in an assistant message with a model stream (a fabricated generation) or a bare `plugin`
   * source.
   */
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const message = event.data?.message
    if (message?.role !== 'assistant') fail('RED_LINE_ECHO_ROLE', 'assistant/message 的 role 必须是 assistant')
    if (!Array.isArray(event.data?.stream) || event.data.stream.length !== 0) {
      fail('RED_LINE_ECHO_STREAM', 'assistant/message 的 stream 必须是 []')
    }
    const kind = message?.source?.kind
    if (typeof kind !== 'string' || kind.length === 0 || kind === 'plugin') {
      fail(
        'RED_LINE_ECHO_SOURCE',
        `assistant/message 的 source.kind 必须是 producer-owned 且不是 'plugin'（实际 ${JSON.stringify(kind)}）`,
      )
    }
  }

  const titleEvent = events.find((event) => event.type === 'session/title')
  if (titleEvent !== undefined) {
    if (typeof titleEvent.data?.title !== 'string' || titleEvent.data.title.length === 0) {
      fail('RED_LINE_TITLE', 'session/title 的标题为空')
    }
    const refs = Array.isArray(titleEvent.data?.messageSeqs) ? titleEvent.data.messageSeqs : []
    const kind = titleEvent.data?.source?.kind
    if ((refs.length === 0) !== (kind === 'user')) {
      fail('RED_LINE_TITLE_SOURCE', "session/title 空引用必须配 source.kind: 'user'")
    }
  }

  const system = events.find((event) => event.type === 'system/message')
  const systemMessage = system?.data?.message
  if (systemMessage?.role !== 'system' || systemMessage?.source?.kind !== 'system-prompt') {
    fail('RED_LINE_SYSTEM_ROLE', 'system/message 的 role/source 不合法')
  }
  if (!Array.isArray(systemMessage?.content) || systemMessage.content.length === 0) {
    fail('RED_LINE_SYSTEM_CONTENT', 'system/message 的内容为空')
  }

  if (sessionId.length === 0) fail('MISSING_ID', '缺少会话 id')
}

/**
 * What the caller is told about visibility — the field that exists because "the model can read it" and
 * "the user can see it" are different facts.
 *
 * It is derived from the ACTUAL event type in the tape, never from the request: reporting the request
 * is how the original bug reported itself as a success.
 */
export function describeRendered(events: ReadonlyArray<TapeEvent>, messageId: string): {
  id: string
  requested: 'visible' | 'context-only'
  rendered: boolean
  reason: string
} {
  const userMessage = events.find((event) => event.type === 'user/message')
  const developerMessage = events.find((event) => event.type === 'developer/message')
  const carrying = userMessage ?? developerMessage
  const rendered = carrying?.type === 'user/message'
  const requested: 'visible' | 'context-only' = userMessage === undefined ? 'context-only' : 'visible'
  return {
    id: messageId,
    requested,
    rendered,
    reason: rendered
      ? 'user/message 是本宿主的会话投影会渲染的类型'
      : 'developer/message 只在模型上下文里可见：本宿主的会话投影不渲染它',
  }
}
