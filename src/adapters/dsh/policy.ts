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
 * The DEFAULT prefix an ignition prompt carries, when the caller names no marker of its own.
 *
 * ── P0 (audit 2026-11-08): THIS USED TO NAME AN UPPER LAYER ────────────────────────────────────
 *
 * It was `'[dsh-observer 点火]'`. That is a LAYER INVERSION: L1 (this host adapter) was encoding
 * the identity of a specific L4 plugin. Two consequences, and the second is the one that bites:
 *
 *   1. The dependency runs backwards. Nothing in this layer imports or knows about observer; a
 *      constant with its name is the only thing suggesting otherwise, and it is wrong.
 *   2. It was ALSO the idempotence key. Renaming the observer's marker would silently stop every
 *      prior ignition from being recognised — and a missed recognition means RE-TRIGGERING a
 *      session that is already running, which is not a cosmetic failure.
 *
 * So the marker is now a CALLER concern:
 *
 *   - this constant is deliberately NEUTRAL: it says "a plugin started this", naming none;
 *   - `isPromptText` takes `string | string[]`, and each caller passes the markers it has actually
 *     used over time (its current one first, then the historical aliases it must keep honouring).
 *
 * That is what keeps the old sessions idempotent WITHOUT this layer knowing whose they are: the
 * knowledge of "observer used to stamp `[dsh-observer 点火]`" lives in observer, where it belongs.
 */
export const DEFAULT_PROMPT_MARKER = '[plugin 点火]'

/** How long the host is given to admit a prompt before the attempt is abandoned. */
export const TRIGGER_TIMEOUT_MS = 20_000

/**
 * Is this text one of OUR ignitions, rather than something a human typed?
 *
 * `marker` accepts a LIST because a caller's stamp changes over time and old sessions must keep
 * being recognised. The first entry is the current marker (also used when composing new prompts);
 * the rest are historical aliases that only ever matter on the READ side.
 */
export function isPromptText(text: unknown, marker: string | readonly string[] = DEFAULT_PROMPT_MARKER): boolean {
  if (typeof text !== 'string') return false
  const trimmed = text.trimStart()
  const markers = typeof marker === 'string' ? [marker] : marker
  for (const candidate of markers) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    if (trimmed.startsWith(candidate)) return true
  }
  return false
}

/**
 * The marker to STAMP with, from a caller's list: the current one, or the neutral default.
 *
 * Separate from `isPromptText` on purpose. Reading accepts a list; writing must choose exactly one,
 * and choosing the wrong member would stamp a historical alias onto a new prompt.
 */
export function markerToStamp(marker: string | readonly string[] | undefined): string {
  if (typeof marker === 'string' && marker.trim().length > 0) return marker.trim()
  if (Array.isArray(marker)) {
    const first = marker.find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0)
    if (typeof first === 'string') return first.trim()
  }
  return DEFAULT_PROMPT_MARKER
}

/**
 * THE `api-session/added` WIRE SHAPE — the two fields a host can actually resolve a payload by.
 *
 * ── P1-3 (audit 2026-11-08) WHY THIS IS A GUARD AND NOT A COMMENT ──────────────────────────────
 *
 * This layer emits `api-session/added` ITSELF when it writes a cold session, because the host emits
 * that event only for sessions published into the live store, and a published target cannot be
 * resumed — publishing would make it visible and unopenable. The event reaches peers through
 * `dsh-api-remotes`, which keys it by `resources: { session: summary => summary.sessionId }`, and
 * the client applies it through `handleSessionAdded` -> `mergeSummary`.
 *
 * The host's `assertJsonArgs` checks only that the payload is JSON-serialisable. It does NOT check
 * that `sessionId` is a string. So a payload carrying a missing or non-string id throws NOWHERE: it
 * arrives at the peer's access-control step as `undefined`, where at best the summary is dropped and
 * at worst the key is used for a lookup that cannot succeed. That is a silent, remote-only failure —
 * exactly the class this file exists to name rather than assume.
 *
 * IT REJECTS NOTHING THAT IS EMITTED TODAY: every current caller derives `sessionId` from a
 * non-empty string and `updatedAt` from a finite number (or from `Date.now()`). The guard is for the
 * NEXT caller, so a payload no host can resolve can never leave this layer unnoticed.
 */
export function assertSessionSummary(payload: unknown): payload is { sessionId: string; updatedAt: number } {
  if (typeof payload !== 'object' || payload === null) return false
  const summary = payload as { sessionId?: unknown; updatedAt?: unknown }
  if (typeof summary.sessionId !== 'string' || summary.sessionId.length === 0) return false
  return typeof summary.updatedAt === 'number' && Number.isFinite(summary.updatedAt)
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
