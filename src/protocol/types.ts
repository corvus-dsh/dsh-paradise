/**
 * PARADISE PROTOCOL — the host-neutral value types.
 *
 * THE HARD RULE THIS FILE EXISTS TO ENFORCE
 *
 * Nothing in `src/protocol/` may name a specific host implementation. No product names, no plugin
 * framework names, and no host-shaped concepts: nothing that describes how one particular runtime
 * lays out its log, validates its writes, or decides what its view chooses to render.
 * `test/protocol-purity.test.mjs` scans this directory and FAILS the build if such a word appears,
 * including in a comment — because a protocol that leaks "how one host does it" stops being a
 * protocol and becomes that host's wrapper.
 *
 * That rule is why this header does not spell the forbidden words out: naming them to forbid them
 * would already be the leak. The test carries the list.
 *
 * WHY THE VOCABULARY IS THIS SMALL
 *
 * The temptation is to model everything the two existing plugins do. But most of what they do is
 * POLICY (when to slice, what to write, which session to hatch) and belongs above this line. What
 * stays here is only what a plugin cannot do for itself: create a conversation container, put
 * content into it, make it start running, observe it, and persist small state.
 *
 * A useful test for anything you are about to add: could a SECOND, entirely different host implement
 * it with the same meaning? If the answer needs a paragraph of "well, on this one it's different",
 * it belongs in an adapter, not here.
 */

/**
 * An opaque conversation-container handle.
 *
 * OPAQUE IS THE POINT. The protocol says "a session is identified by this string and belongs to this
 * working directory"; it does NOT say the id is a UUID, that it starts with a prefix, or that it is
 * a filename. An adapter that needs a prefix can add one; a caller must never parse it.
 */
export interface SessionRef {
  /** Opaque identifier. Never parsed, never constructed by callers. */
  readonly id: string
  /**
   * Absolute working directory this session belongs to.
   *
   * REQUIRED, never defaulted. The single most expensive incident in this ecosystem's history was
   * "the归属 was guessed" — a session created without a workspace lands in a draft with no owner and
   * nobody can find it. The protocol therefore cannot express "unknown cwd": a caller that does not
   * know the directory does not get to create a session.
   */
  readonly cwd: string
}

/** One piece of content to place inside a session. */
export interface ContextItem {
  /** How the content should be treated by the host's conversation view. */
  readonly visibility: ContextVisibility
  /** The text itself. */
  readonly text: string
  /**
   * Machine-readable provenance, e.g. `plugin:slicer:handoff`.
   *
   * REQUIRED, and required for a reason: content injected by a plugin must never be mistaken for
   * something a human typed. A later transfer that replays a log will otherwise promote an injected
   * plan into a user instruction.
   */
  readonly origin: string
  /**
   * Stable id for this item, when a caller wants the same item to be recognisable on a re-run.
   * Absent means "the adapter may name it".
   */
  readonly id?: string
}

/**
 * Whether the host's conversation view will SHOW the content.
 *
 * TWO VALUES, NOT THREE, AND NO DEFAULT. `visible` means the transcript renders it (the point of
 * writing anything a human should read). `context-only` means it is present and readable by the
 * model but not rendered — a legitimate choice (system background), which every receipt must then
 * report honestly as not-shown.
 *
 * There is deliberately no `'auto'`: "let the adapter decide" is exactly how a plan gets written
 * correctly and rendered nowhere.
 */
export type ContextVisibility = 'visible' | 'context-only'

/** How a turn should be admitted when the session is (or is not) already running. */
export type TriggerMode =
  /** Deliver at the next natural boundary. Safe for a session that is idle. */
  | 'queue'
  /** Deliver into the turn that is open right now. The correction channel. */
  | 'interrupt'

/** What a caller asks a session to start doing. */
export interface TurnTrigger {
  readonly text: string
  readonly mode: TriggerMode
  /** Provenance, same rule as `ContextItem.origin`. */
  readonly origin: string
  /**
   * The literal prefix that marks this CALLER's prompts in a session's log, when it differs from the
   * host's default.
   *
   * WHY THE PROTOCOL CARRIES THIS: idempotence is decided by reading the target's own log for "did I
   * already send this?". Two callers with different prefixes cannot both be answered by one hard-coded
   * string — the wrong one makes a retry look like a first attempt, and the target is prompted twice.
   * It is opaque caller text, not a host vocabulary word, so it belongs in the protocol.
   */
  readonly marker?: string
  /**
   * Try the OTHER mode when the requested one is refused. Defaults to ON.
   *
   * WHY A CALLER MAY SAY `false`: falling back changes what the user experiences — a `queue` prompt
   * that was refused becomes an `interrupt` into a live turn, which is a stronger intervention than
   * the caller asked for. A caller whose contract is "one mode, and a refusal is a REPORTED failure"
   * says `false` here instead of silently escalating.
   */
  readonly fallbackModes?: boolean
}

/** One entry of a session's event log, as the adapter is willing to expose it. */
export interface LogEvent {
  /** Monotonic position in the log. */
  readonly seq: number
  /**
   * The adapter's own event name, OPAQUE to the protocol.
   *
   * This is the one place a host's vocabulary legitimately survives, because the alternative is a
   * protocol that enumerates every host's event kinds. Callers that need to recognise a kind do so
   * through `SessionAdapter.describeEvent`, and a caller that hard-codes a name has taken a
   * deliberate host dependency.
   */
  readonly type: string
  readonly time: number
  /** The adapter's payload, opaque. */
  readonly data: unknown
}

/** A subscription handle. */
export interface Unsubscribe {
  (): void
}

/** What a caller learns when something happens in a session it observes. */
export interface SessionEvent {
  readonly sessionId: string
  readonly event: LogEvent
}

/** The answer to "what happened" after a mutation. Evidence, never a bare success flag. */
export interface MutationReceipt {
  readonly ok: boolean
  /** Which step completed. Present on success too — "did it get as far as the write?" is the first question. */
  readonly stage: string
  /** Non-fatal problems, stated. An empty array is a claim, so it must be earned. */
  readonly warnings: string[]
  /** The failure, when `ok` is false. */
  readonly error?: ProtocolFailure
}

/** A failure, shaped so a caller never has to guess which step broke. */
export interface ProtocolFailure {
  /** Stable machine-readable code, e.g. `WORKSPACE_REQUIRED`. */
  readonly code: string
  /** The step that failed. */
  readonly stage: string
  readonly message: string
  /** The original stack, when one exists. */
  readonly stack?: string
}

/** What a durable-log reading can conclude. Mirrors `src/read/disk.ts`. */
export interface LogReading {
  readonly readable: boolean
  readonly path: string
  /** How the path was obtained — `host`, `derived:<how>`, or `unavailable`. */
  readonly pathSource: string
  readonly bytes: number
  readonly frameCount: number
  readonly framesDecoded: number
  readonly events: LogEvent[]
  readonly eventTypes: string[]
  readonly eventCount: number
  /** The first human-readable message found, with the facts that decide whether it is shown. */
  readonly firstMessage: MessageOnDisk | null
  readonly notes: string[]
}

/** A message found in a durable log, described by FACTS rather than by a host's vocabulary. */
export interface MessageOnDisk {
  readonly seq: number
  readonly type: string
  readonly role: string
  readonly origin: string
  readonly textLength: number
  readonly textHead: string
  /** Whether the host's conversation view renders this kind of message. */
  readonly rendered: boolean
}
