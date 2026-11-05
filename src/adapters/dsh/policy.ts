/**
 * THE ONE HOST'S SHAPE POLICY — `adapters/dsh/`.
 *
 * WHY THESE CONSTANTS ARE HOST-SPECIFIC AND NOT PROTOCOL
 *
 * `RENDERED_CONVERSATION_TYPES` is a MEASURED fact about one runtime's conversation projection: it
 * switches on `user/message` and `assistant/message` and pushes `developer/message`, `system/message`
 * and tool results through one shared "do not show this" branch. A second host renders whatever it
 * likes.
 *
 * So this file lives under `adapters/dsh/` and `src/policy.ts` keeps only the neutral helpers. The
 * architecture draft's §7 risk 4 said it plainly: this set is used **only to REPORT** whether a
 * message will be seen. It never decides what to write — that is decided by the caller's intent,
 * which is why a plugin can be correct here and invisible everywhere.
 */

/** The message kinds this runtime's conversation view renders. MEASURED, not contractual. */
export const RENDERED_CONVERSATION_TYPES: readonly string[] = ['user/message', 'assistant/message']

/**
 * The message kinds this runtime writes for the two intents the protocol names.
 *
 * `visible` → `user/message` (plus a plugin marker, so a later replay cannot mistake it for a human).
 * `context-only` → `developer/message`, which this runtime stores and reads but does not render.
 */
export const MESSAGE_TYPE_FOR_INTENT = {
  visible: 'user/message',
  'context-only': 'developer/message',
} as const

/** The `source.kind` prefix every plugin-authored message must carry on this runtime. */
export const PLUGIN_SOURCE_PREFIX = 'plugin:'

/** The durable log file name this runtime writes, under `<sessionId>/`. */
export const SESSION_LOG_FILENAME = 'session.v4.jsonl.zstd'

/** The header line's `type`, which is not an event (it carries no `seq`). */
export const SESSION_HEADER_TYPE = 'session'

/** Does this runtime's conversation view render events of this kind? */
export function isRenderedByConversation(type: unknown): boolean {
  return typeof type === 'string' && RENDERED_CONVERSATION_TYPES.includes(type)
}

/**
 * Does this `source.kind` mark content as plugin-authored?
 *
 * The slicing layer's `isHumanAuthored()` uses `kind === 'user'` to decide "a human typed this". A
 * plugin message carrying no marker is therefore indistinguishable from a user instruction to the
 * next generation that replays the log — which is how an injected plan gets replayed as an order.
 */
export function isPluginAuthored(sourceKind: unknown): boolean {
  return typeof sourceKind === 'string' && sourceKind.startsWith(PLUGIN_SOURCE_PREFIX)
}

/**
 * The prefix every ignition prompt carries.
 *
 * It is how a RETRY recognises its own previous admission, and how a later reader knows a session was
 * started by a plugin rather than by a human. Deliberately the observer's historical marker: an
 * existing session already carries prompts with this prefix, and changing it would make every prior
 * ignition invisible to the idempotence check — i.e. re-triggering sessions that are already running.
 */
export const PROMPT_MARKER = '[dsh-observer 点火]'

/** How long the host is given to admit a prompt before the attempt is abandoned. */
export const TRIGGER_TIMEOUT_MS = 20_000

/** Is this text our own ignition, rather than something a human typed? */
export function isPromptText(text: unknown, marker: string = PROMPT_MARKER): boolean {
  return typeof text === 'string' && text.trimStart().startsWith(marker)
}

/**
 * The system head a freshly written session opens with.
 *
 * WHY IT MUST EXIST AT ALL: this host replaces surface node 0 with its own rendered prompt on the
 * first live step, so the tape's `system/message` is a placeholder that gets replaced — but it is a
 * REQUIRED placeholder. A tape whose first surface node is anything else is rejected, and a session
 * that opens with no system node has no protection for its head.
 *
 * The wording is deliberately bare. Its job is to be a legal, structurally-correct system message,
 * not to instruct the agent — the caller's own content carries the instruction.
 */
export const SYSTEM_HEAD_PROMPT = '[系统] 这是一个由插件写入的会话，其内容由创建方提供。'
