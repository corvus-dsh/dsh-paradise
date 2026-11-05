/**
 * PARADISE PROTOCOL — the three adapters a host must provide.
 *
 * WHAT A HOST IS, IN THIS PROTOCOL'S TERMS
 *
 * Nothing more than: something that can hold conversations, something that can store a small amount
 * of durable state, and something that can run tools. A caller that only needs one of the three can
 * depend on only that one — which is what makes "run the functional layer with no host at all" a real
 * property rather than a slogan.
 *
 * THE THREE ADAPTERS ARE DELIBERATELY SEPARATE
 *
 * A harness may have conversations but no tool registry (a minimal local runner), or a tool registry
 * but no durable conversation store (a one-shot script). Merging them into one `Host` interface would
 * force every such host to stub two thirds of it, and a stub that answers "ok" is how false success
 * gets in. So each adapter is independently satisfiable, and each has a documented minimum.
 *
 * NO HOST NAMES BELOW. See `test/protocol-purity.test.mjs`.
 */

import type {
  ContextItem,
  LogEvent,
  LogReading,
  MutationReceipt,
  SessionEvent,
  SessionRef,
  TurnTrigger,
  Unsubscribe,
} from './types.js'
import type { LeaseAdapter } from './lease.js'

/**
 * SESSION ADAPTER — the conversation container.
 *
 * The five capabilities, and why each is its own verb:
 *
 *   create    — make a container. Separate from `inject` because a container can exist empty.
 *   inject    — place content. Separate from `create` because content can arrive later, and because
 *               `inject` must be legal on an ALREADY RUNNING container.
 *   trigger   — admit a turn. Separate from `inject` because "make it visible" and "make it run" are
 *               different decisions with different costs, and a host that cannot do the second must
 *               still be usable for the first.
 *   readLog   — read back what the host durably holds. Separate from `subscribe` because it is how a
 *               caller VERIFIES, including right after a write, with no event in between.
 *   subscribe — learn about changes as they happen. Separate from `readLog` because polling a log and
 *               receiving events have different costs and different failure modes.
 *
 * MUTATING METHODS RETURN A RECEIPT, NEVER A BOOLEAN. `true` does not say which step completed, and
 * the first question in every incident is "did it get as far as the write?".
 */
export interface SessionAdapter {
  /** Stable name of the adapter implementation, for logs and receipts. */
  readonly name: string

  /**
   * Create a container in `cwd`.
   *
   * MUST refuse an empty or relative `cwd` — the protocol has no way to express "guess the
   * workspace", so an adapter that invents one is violating the contract, not helping.
   *
   * MUST NOT leave a half-created artifact behind on failure.
   *
   * WHY `items` IS HERE AND NOT ONLY ON `inject`: on a runtime whose write path is a SINGLE
   * transactional tape, content must be placed at create time or not at all — there is no legal
   * "empty session, then append" step. A protocol that only allowed `inject` afterwards would be
   * un-implementable on such a host, and forcing a caller to fake it would spread the workaround into
   * every functional layer. `items` is OPTIONAL: a host that can append later simply ignores it.
   *
   * The receipt MUST report, per item, whether the transcript will actually SHOW it.
   */
  create(input: {
    cwd: string
    title?: string
    id?: string
    items?: ContextItem[]
    /**
     * A PRE-BUILT event tape, written verbatim instead of the one this adapter would compose.
     *
     * WHY THIS EXISTS, AND WHY IT IS NOT A LEAK: a caller that already owns a richer notion of "what
     * goes into a session" — a replayed conversation history, a task board, provenance metadata — must
     * not have to flatten that into `items` and hope the adapter reconstitutes it. That would push the
     * caller's POLICY into the adapter, which is the opposite of the boundary this package exists for.
     *
     * The adapter still owns everything that is a host FACT: the numbering of the frame it writes, the
     * per-event metadata its runtime requires, seq/time assignment, the system head, and the post-write
     * verification. A caller supplying a tape supplies CONTENT, not shape — and an invalid shape is
     * refused before anything is written.
     *
     * When both are given, `tape` wins and `items` is ignored.
     */
    tape?: ReadonlyArray<{ type: string; data: Record<string, any>; surface?: boolean }>
    /**
     * A session whose runtime policy (provider / model / preset / permissions) the new one inherits.
     *
     * PROTOCOL-LEVEL, not a host concern: a container that does not inherit resumes under different
     * policy, which is a silent behaviour change. Naming the source is the caller's intent; HOW to
     * copy it is the adapter's business.
     */
    inheritFrom?: string
    /**
     * Let the adapter attach the new container to its workspace group and announce it to clients.
     *
     * OPTIONAL, and defaults to ON. A caller that owns its own publishing — a specific group id in its
     * receipt, its own marker on the source, a refusal it reports as a warning — says `false` here
     * instead of having the announcement happen twice for one session.
     */
    publish?: boolean
  }): Promise<MutationReceipt & { session?: SessionRef; rendered?: RenderedItem[] }>

  /**
   * Place content into an existing container.
   *
   * MUST be legal whether or not the container is currently running. An adapter that can only write
   * to a live container must say so through `capabilities`, not by failing at call time.
   *
   * The receipt MUST report, per item, whether the host's transcript will actually SHOW it — a
   * `visibility: 'visible'` request that the host silently demotes is the failure this field exists
   * to prevent.
   */
  inject(session: SessionRef, items: ContextItem[]): Promise<MutationReceipt & { rendered: RenderedItem[] }>

  /**
   * Admit a turn so the container starts working.
   *
   * MUST be a no-op-with-receipt when the adapter cannot do it (`capabilities.trigger === false`),
   * never a silent success: a caller that believes ignition happened and does not see work starting
   * has no way to tell a slow start from a broken channel.
   */
  trigger(session: SessionRef, trigger: TurnTrigger): Promise<MutationReceipt>

  /** Read what the host durably holds. MUST NOT throw; failures come back as `readable: false`. */
  readLog(session: SessionRef): Promise<LogReading>

  /**
   * Observe changes.
   *
   * Returns an unsubscribe function. MUST be safe to call when the host has no event feed (return a
   * no-op unsubscribe) — a missing feed is `capabilities.subscribe === false`, not an exception.
   */
  subscribe(session: SessionRef, listener: (event: SessionEvent) => void): Unsubscribe

  /**
   * Can this host CONFIRM that a session is gone?
   *
   * Deliberately NOT a `delete`: dismantling an artifact is the concern of whoever created it, and a
   * protocol-level delete would tempt every caller to remove sessions it did not make. What a caller
   * genuinely needs is the narrower question — "may I trust my own rollback?" — and the answer has
   * THREE values, not two: gone, still there, or this host cannot tell.
   *
   * MUST NOT throw, and MUST NOT answer `gone` on the strength of "the removal method returned".
   */
  probeDeletion(session: SessionRef): Promise<DeletionProbe>

  /**
   * What this adapter can and cannot do.
   *
   * A caller consults this BEFORE deciding whether to degrade or to refuse. Discovering a missing
   * capability halfway through a multi-step write means an artifact already exists.
   */
  readonly capabilities: SessionCapabilities
}

/** The three honest answers to "is it gone?". */
export type DeletionProbe = 'absent' | 'present' | 'unverifiable'

export interface SessionCapabilities {
  /** Can create a new, empty container. */
  readonly create: boolean
  /** Can place content into an idle container (the cold-artifact case). */
  readonly injectIntoIdle: boolean
  /** Can place content into a running container (the correction case). */
  readonly injectIntoRunning: boolean
  /** Can make a container start running. */
  readonly trigger: boolean
  /** Can read the durable log. */
  readonly readLog: boolean
  /** Can deliver change events without polling. */
  readonly subscribe: boolean
  /** Can verify a deletion (as opposed to merely issuing one). */
  readonly verifyDeletion: boolean
  /** Capabilities that are absent, each with what it costs the caller. */
  readonly unavailable: ReadonlyArray<{ capability: string; consequence: string }>
}

/** Per-item visibility as the adapter actually delivered it. */
export interface RenderedItem {
  readonly id: string
  /** What was requested. */
  readonly requested: 'visible' | 'context-only'
  /** What the host will do. When this differs from `requested`, `reason` explains why. */
  readonly rendered: boolean
  readonly reason: string
}

/**
 * STORAGE ADAPTER — durable state, and NOTHING ELSE.
 *
 * Deliberately tiny. The functional layer needs somewhere to put a pointer file, a binding table, a
 * counter. It does not need a database, a cache, or a transaction manager, and an interface that
 * offers those invites callers to depend on them.
 *
 * SCOPED, NOT ABSOLUTE. `read`/`write` take a KEY, not a path. A host maps keys into its own data
 * directory; a caller that could name an absolute path would immediately start writing outside its
 * own namespace, which is how plugins corrupt each other's state.
 */
export interface StorageAdapter {
  readonly name: string
  /** Read a value. `undefined` means "not stored" — distinct from "stored as null". */
  read(key: string): Promise<unknown>
  /** Write a value. MUST be atomic: a reader never observes a half-written document. */
  write(key: string, value: unknown): Promise<MutationReceipt>
  /** Remove a key. MUST be idempotent. */
  remove(key: string): Promise<MutationReceipt>
  /** Enumerate keys with a prefix, so a caller can find its own namespace without knowing the layout. */
  keys(prefix?: string): Promise<string[]>
  /**
   * The same read as `read`, PLUS the diagnosis — optional, and here is why it is worth a method.
   *
   * `read` answers `undefined` for three different situations: never stored, deliberately removed, and
   * CORRUPT. A caller that cannot tell them apart will treat damaged state as an empty start and
   * overwrite what is left. An adapter that can diagnose says so; one that cannot simply omits this,
   * and `read` remains the whole contract.
   */
  readDetailed?(key: string): Promise<StorageReadReport>
  /**
   * ATOMIC read-modify-write — optional, and the thing a lock is built from.
   *
   * WHY THE PAIR IS NOT ENOUGH: `read` and `write` are each atomic, but two callers can both read "no
   * lock", both decide they may take it, and both write. `compareAndSet` runs `verify` inside whatever
   * exclusion the host can provide and writes only what `verify` returns.
   *
   * `verify` returning `undefined` means REFUSE, and the refusal must be reported rather than turned
   * into a write. A host that cannot provide real exclusion omits this method, and a caller that needs
   * it must say so instead of falling back to the racy pair.
   */
  compareAndSet?(
    key: string,
    verify: (current: unknown) => unknown | undefined,
  ): Promise<{ ok: boolean; value?: unknown; warnings: string[] }>
}

/**
 * WHAT A READ ACTUALLY FOUND.
 *
 * `ok`        — a stored value, read cleanly.
 * `missing`   — nothing was ever stored, or the key was removed. NOT an error.
 * `recovered` — the primary copy was unreadable; the value came from the adapter's own snapshot and
 *               `warnings` says so. The caller has its data AND knows it was nearly lost.
 * `corrupt`   — unreadable, and no usable snapshot. This is the one answer that must never be
 *               confused with `missing`.
 */
export type StorageReadStatus = 'ok' | 'missing' | 'recovered' | 'corrupt'

export interface StorageReadReport {
  readonly value: unknown
  readonly status: StorageReadStatus
  readonly warnings: readonly string[]
}

/**
 * TOOL ADAPTER — the tool registry, as a caller sees it.
 *
 * `execute` returns the tool's RESULT AS DATA, and an error is a result with `isError: true` — not a
 * thrown exception. Two reasons: the caller is usually a plugin acting on behalf of a model, and it
 * must be able to report "the tool failed" in the same breath as "the operation succeeded"; and a
 * thrown error loses the tool's own message on some hosts.
 */
export interface ToolAdapter {
  readonly name: string
  /** Every tool the host will let this caller invoke. */
  list(): Promise<ToolDescriptor[]>
  /** Invoke one. MUST refuse an unknown name with `isError: true`, never by throwing. */
  execute(input: { name: string; arguments: Record<string, unknown>; timeoutMs?: number }): Promise<ToolOutcome>
}

export interface ToolDescriptor {
  readonly name: string
  readonly description: string
  /** The tool's input contract, as the host publishes it. Opaque to the protocol. */
  readonly inputSchema: unknown
}

export interface ToolOutcome {
  readonly isError: boolean
  /** The tool's answer, when it succeeded. */
  readonly value?: unknown
  /** The tool's failure message, when it did not. */
  readonly error?: { code?: string; message: string }
}

/** The bundle a host provides. Every field is independently optional. */
export interface ParadiseHost {
  /** Human-readable name of the implementation, e.g. `memory`, `selftest`. */
  readonly name: string
  readonly session?: SessionAdapter
  readonly storage?: StorageAdapter
  readonly tools?: ToolAdapter
  /**
   * Mutual exclusion over the host's shared state.
   *
   * OPTIONAL, because a host that links only one process never needs it. A plugin that writes shared
   * state from a background pass does — see `withLease` — and it must then SAY SO rather than race.
   */
  readonly lease?: LeaseAdapter
}

/** What a functional layer needs in order to run. */
export interface ParadiseDependencies {
  readonly session: SessionAdapter
  readonly storage: StorageAdapter
  readonly tools?: ToolAdapter
  readonly lease?: LeaseAdapter
}
