/**
 * THE EXOSKELETON — model, message list, and runtime-created tools.
 *
 * WHAT THIS ADDSS TO THE PROTOCOL, AND WHY IT IS A SEPARATE MODULE
 *
 * The three adapters in `adapters.ts` describe a CONTAINER: somewhere to put content, somewhere to
 * keep state, something to run a tool. They deliberately say nothing about how a thought is produced,
 * because every host already has its own way of producing one and the layer only needed to observe it.
 *
 * An independent harness has no host. It must be able to:
 *
 *   1. ASK A MODEL SOMETHING — with tools it can call, in a shape any provider accepts;
 *   2. HOLD A CONVERSATION WITHOUT AN EVENT STREAM — a plain array, because a harness that has no
 *      host has no log to project from;
 *   3. CREATE A TOOL WHILE RUNNING — because the set of tools a self-healing system needs is not
 *      knowable in advance. A repair script IS a new tool, invented from an error message.
 *
 * So these three interfaces exist. They are still host-neutral: a model endpoint is a model endpoint
 * on any machine, and "a list of messages" is not a host concept.
 *
 * NO HOST NAMES BELOW. See `test/protocol-purity.test.mjs`.
 */

import type { ProtocolFailure } from './types.js'

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * 1. LLMAdapter — ask a model, with tools, in a transport-neutral shape
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/** A tool the MODEL may call, described the way providers expect. */
export interface ToolSchema {
  readonly name: string
  readonly description: string
  /** JSON Schema for the arguments. Opaque to this layer; the provider validates it. */
  readonly parameters: Record<string, unknown>
}

/** One message in a conversation. A closed vocabulary, so a provider adapter can map it. */
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  /** Text content. A message with only tool calls leaves this empty rather than absent. */
  readonly content: string
  /** Tool calls this assistant message is asking for. */
  readonly toolCalls?: readonly ToolCall[]
  /** For `role: 'tool'`: which call this answers. */
  readonly toolCallId?: string
  /** For `role: 'tool'`: the tool's own error flag, surfaced rather than flattened into text. */
  readonly isError?: boolean
}

/** One request the model made for a tool. */
export interface ToolCall {
  readonly id: string
  readonly name: string
  /** Parsed arguments. A provider adapter parses its own wire format into this. */
  readonly arguments: Record<string, unknown>
}

/** What one generation produced. */
export interface GenerationResult {
  /** The assistant's text, possibly empty when it only called tools. */
  readonly text: string
  readonly toolCalls: readonly ToolCall[]
  /** Which model actually answered — a fallback route must be visible, not silent. */
  readonly model: string
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number }
  /** Present when the call failed. The caller decides whether to retry. */
  readonly error?: ProtocolFailure
}

export interface GenerateOptions {
  /** Tools the model may call. Absent means "no tools", which is different from "empty list". */
  readonly tools?: readonly ToolSchema[]
  readonly system?: string
  readonly maxTokens?: number
  /** Stop after this many tool-call rounds. The adapter enforces it; the caller sets it. */
  readonly maxToolRounds?: number
  readonly signal?: AbortSignal
  readonly temperature?: number
}

/**
 * ASK A MODEL. One call, one answer.
 *
 * WHY `generate` AND NOT `stream`: a streaming interface forces every caller to consume an async
 * iterable to get a string. A harness that reports progress can use `generateStreaming`; one that just
 * needs an answer should not have to write a `for await` loop. The non-streaming form is the contract;
 * streaming is an OPTIONAL capability, exactly like `StorageAdapter.transaction`.
 *
 * WHY IT TAKES TOOLS: an independent harness that cannot let the model call a tool is a chatbot. The
 * tool loop is what makes it an agent, and the loop belongs HERE (in the adapter that knows the
 * provider's wire format), not in every functional layer.
 */
export interface LLMAdapter {
  readonly name: string
  /** Which provider family this speaks. Diagnostic; never branched on by callers. */
  readonly provider: string
  generate(messages: readonly ChatMessage[], options?: GenerateOptions): Promise<GenerationResult>
  /**
   * The same call, streamed. OPTIONAL.
   *
   * A caller that needs incremental output checks for it; one that does not, ignores it. Making it
   * required would force every adapter to implement a second code path for a capability most callers
   * never use.
   */
  generateStreaming?(
    messages: readonly ChatMessage[],
    options?: GenerateOptions,
  ): AsyncIterable<{ readonly type: 'text-delta' | 'tool-call' | 'finish'; readonly text?: string; readonly call?: ToolCall }>
  /** Cheap reachability probe. Must not throw; a false answer is a result, not an error. */
  healthy?(): Promise<boolean>
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * 2. MessageAdapter — the conversation as a plain array
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * A CONVERSATION HELD AS AN ARRAY, NOT PROJECTED FROM AN EVENT STREAM.
 *
 * WHY THIS IS NOT `SessionAdapter`: a session adapter's log is the HOST's durable record — it owns
 * numbering, headers, and what a view renders. A harness that runs without a host has no such log; it
 * has a list of messages in memory and, optionally, a file. Conflating the two would force the harness
 * to fabricate a host-shaped log, which is the coupling this whole layer exists to avoid.
 *
 * THE WINDOW IS THE POINT. A context window is finite; a conversation is not. So the adapter owns
 * "what survives when the list gets too long", and it reports WHAT IT DROPPED — a harness that silently
 * loses the system prompt is worse than one that refuses to run.
 */
export interface MessageAdapter {
  readonly name: string
  /** Every message currently held, oldest first. */
  messages(): readonly ChatMessage[]
  /** Append one message. */
  append(message: ChatMessage): Promise<void>
  /** Append several, atomically with respect to a concurrent reader of `messages()`. */
  appendMany(messages: readonly ChatMessage[]): Promise<void>
  /**
   * Fit the conversation into a token budget, keeping the newest and whatever is PINNED.
   *
   * Returns what it removed, so a caller can persist it rather than lose it. A method that trims
   * silently would make "the model forgot the constraint" indistinguishable from "we deleted it".
   */
  compact(budgetTokens: number): Promise<{ removed: readonly ChatMessage[]; kept: number }>
  /** Drop everything. Used by a rollback, never by a normal turn. */
  reset(): Promise<void>
  /** Persist to durable storage, when the adapter has one. A no-op is a legitimate implementation. */
  save?(): Promise<void>
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * 3. ToolFactory — create a tool WHILE RUNNING
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/** A tool that exists in this process, callable by a model. */
export interface RuntimeTool {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  /** Run it. MUST NOT throw: a failure is `isError: true`, same rule as `ToolAdapter.execute`. */
  execute(args: Record<string, unknown>): Promise<{ isError: boolean; value?: unknown; error?: { code?: string; message: string } }>
}

/**
 * CREATE TOOLS AT RUNTIME. The escape hatch a self-healing system needs.
 *
 * WHY THIS IS NOT `ToolAdapter`: `ToolAdapter` is a VIEW of tools the host already has — a consumer.
 * This is a PRODUCER: it takes source text and turns it into a callable tool. A harness that can only
 * consume tools is limited to what was installed before it started, which is precisely the limitation
 * a system that must invent a repair script cannot accept.
 *
 * WHAT "CREATE" MEANS, AND WHAT IT DELIBERATELY DOES NOT MEAN
 *
 *   It means: compile a body of code into this process, give it a name and a schema, register it.
 *   It does NOT mean: sandboxed. Running model-authored code is running model-authored code, and
 *   pretending an in-process `new Function` is a sandbox would be a lie with a security consequence.
 *   An implementation that CAN sandbox (a child process, a VM) should, and should say so through
 *   `isolation`. A caller that accepts `'none'` has made a decision; a caller that was never told has
 *   been deceived.
 */
export interface ToolFactory {
  readonly name: string
  /**
   * How isolated the created tools are from the host process.
   *
   *   `'none'`    — same process, same globals. Fast, and a bad tool can take the harness down.
   *   `'process'` — a child process; a crash is survivable, but it can touch the same disk.
   *   `'vm'`      — a separate realm with no ambient authority.
   */
  readonly isolation: 'none' | 'process' | 'vm'
  /**
   * Turn SOURCE TEXT into a registered tool.
   *
   * The source must evaluate to an object shaped like `{ description, parameters, execute }`. A body
   * that throws at definition time is a REFUSAL with the compile error, not a partially-registered
   * tool — a half-created tool that exists but cannot run is the failure mode this rule prevents.
   */
  define(spec: { name: string; source: string; description?: string }): Promise<{ ok: boolean; tool?: RuntimeTool; error?: ProtocolFailure }>
  /** What has been created so far. */
  list(): readonly ToolSchema[]
  /** Call one. Unknown name is `isError: true`, never a throw. */
  execute(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; value?: unknown; error?: { code?: string; message: string } }>
  /** Remove one, so a failed repair does not leave a broken tool registered. */
  revoke(name: string): Promise<boolean>
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * 4. The bundle — what a standalone harness binds
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * EVERYTHING A STANDALONE HARNESS NEEDS, each piece independently optional.
 *
 * WHY OPTIONAL: the same reason `ParadiseHost` keeps its adapters optional. A script that only writes
 * state should not have to stub a model. A harness with a model but no tools is a legitimate harness.
 * A bundle that required all four would make the smallest useful program carry three lies.
 */
export interface HarnessBundle {
  readonly name: string
  readonly llm?: LLMAdapter
  readonly messages?: MessageAdapter
  readonly tools?: ToolFactory
  /** Tools the harness already had, as opposed to ones it created. */
  readonly toolRegistry?: import('./adapters.js').ToolAdapter
}
