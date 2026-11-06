/**
 * AGENT LOOP — a working agent with no host under it.
 *
 * WHAT WAS MISSING, IN THE USER'S OWN TERMS
 *
 * "裸机上，能跑通 Memory 的读写和 Graft 的切片，但是交互循环（Agent Loop）在哪？"
 *
 * Exactly right, and it was the honest gap. The four repositories could store, slice and
 * observe, but nothing turned a user sentence into a sequence of tool calls and a final answer
 * without a HOST to drive it. A persistence layer with no loop is a library, not a harness.
 *
 * WHAT THIS IS
 *
 *   input → recall from memory → ask the model → run requested tools → append results → repeat
 *
 * and it stops when the model answers without asking for a tool, or when the round budget is
 * spent. Nothing here imports a DSH module, subscribes to an event bus, or assumes a session
 * log: the only collaborators are `LLMAdapter`, `MessageAdapter` and a tool registry, all of
 * which are plain interfaces.
 *
 * WHY THE LOOP IS EXPLICIT AND NOT INSIDE THE LLM ADAPTER
 *
 * A provider adapter may run tool rounds internally (the raw one does, up to `maxToolRounds`).
 * That is a convenience for callers who only want an answer. A HARNESS needs to OBSERVE each
 * round — to persist it, to budget it, to cancel it, to report it. So this loop drives the
 * rounds itself and treats the adapter as "one model call", which is the smallest contract
 * that still works with every provider.
 *
 * THE FAILURE PHILOSOPHY
 *
 * A tool that throws does not end the turn: the error is appended as a `tool` message with
 * `isError: true`, which is what the model needs to recover. A model error DOES end the turn,
 * because there is nothing to feed back to. Both are reported in the result, so a caller never
 * has to infer success from silence.
 */
import type { ChatMessage, GenerateOptions, LLMAdapter, MessageAdapter, ToolCall, ToolSchema } from './protocol/index.js'

/** A tool this loop can execute. Shaped like `RuntimeTool` so a factory result drops straight in. */
export interface AgentTool {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  execute(args: Record<string, unknown>): Promise<unknown>
}

/** What happened in one turn, in enough detail to persist or to debug. */
export interface AgentTurnResult {
  /** The model's final text. Empty when the turn ended on an error or the round budget. */
  readonly text: string
  /** Model calls made, including the final one. */
  readonly rounds: number
  readonly toolCalls: ReadonlyArray<{
    readonly name: string
    readonly arguments: Record<string, unknown>
    readonly ok: boolean
    readonly ms: number
    readonly error?: string
  }>
  /** Memory context injected into this turn, if any. Empty string when nothing was recalled. */
  readonly recalled: string
  readonly error?: { readonly code: string; readonly message: string }
}

export type AgentLoopEvent =
  | { readonly type: 'recall'; readonly chars: number }
  | { readonly type: 'round'; readonly round: number }
  | { readonly type: 'tool-call'; readonly name: string; readonly arguments: Record<string, unknown> }
  | { readonly type: 'tool-result'; readonly name: string; readonly ok: boolean; readonly ms: number; readonly error?: string }
  | { readonly type: 'answer'; readonly text: string }

export interface AgentLoopOptions {
  /** One model call per round. Any implementation: a provider, a scripted stub, a mock. */
  readonly llm: LLMAdapter
  /** The conversation, as an array. Owns trimming; this loop never truncates on its own. */
  readonly messages: MessageAdapter
  /** Tools available to the model, by name. */
  readonly tools: ReadonlyMap<string, AgentTool>
  /**
   * Long-term memory. Called once per turn with the raw user input; returns context to inject.
   *
   * Optional, and deliberately so: the loop must run with no memory layer at all, otherwise it
   * is not "independent of DSH" — it is "independent of DSH as long as dsh-memory is present".
   */
  readonly recall?: (query: string) => Promise<string | undefined> | string | undefined
  /** System prompt. Re-sent each round; the adapter decides how to place it. */
  readonly system?: string
  /** Model calls allowed before giving up. Default 8. */
  readonly maxRounds?: number
  /** Per-round model options passed through to the adapter. */
  readonly generateOptions?: Omit<GenerateOptions, 'tools' | 'system'>
  readonly onEvent?: (event: AgentLoopEvent) => void
}

/**
 * The tool schemas the model is offered.
 *
 * Sorted by name so two runs offer the same list in the same order — a model that behaves
 * differently because tool order changed is a bug that looks like nondeterminism.
 */
function schemasOf(tools: ReadonlyMap<string, AgentTool>): ToolSchema[] {
  return [...tools.values()]
    .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Run one turn to completion.
 *
 * The conversation is NOT reset: `messages` accumulates across turns, which is what makes a
 * multi-turn session possible. Only `reset()` (the caller's choice) clears it.
 */
export async function runAgentTurn(input: string, options: AgentLoopOptions): Promise<AgentTurnResult> {
  const maxRounds = Math.max(1, options.maxRounds ?? 8)
  const emit = options.onEvent ?? (() => {})
  const usedToolNames: string[] = []
  const executed: Array<{ name: string; arguments: Record<string, unknown>; ok: boolean; ms: number; error?: string }> = []

  /** 1. Memory first: what the system already knows should shape the prompt, not follow it. */
  let recalled = ''
  if (options.recall !== undefined) {
    try {
      recalled = (await options.recall(input)) ?? ''
    } catch (error) {
      /**
       * A memory failure must not block the turn. The model can still answer from the input;
       * silently pretending memory was consulted would be worse than saying it was not.
       */
      recalled = ''
      void error
    }
    emit({ type: 'recall', chars: recalled.length })
  }

  const prompt = recalled.trim().length === 0 ? input : `${recalled.trim()}\n\n---\n\n${input}`
  await options.messages.append({ role: 'user', content: prompt })

  const schemas = schemasOf(options.tools)
  let rounds = 0
  let lastText = ''

  while (rounds < maxRounds) {
    rounds += 1
    emit({ type: 'round', round: rounds })

    const result = await options.llm.generate(options.messages.messages(), {
      ...(options.system === undefined ? {} : { system: options.system }),
      ...(schemas.length === 0 ? {} : { tools: schemas }),
      ...options.generateOptions,
    })

    if (result.error !== undefined) {
      /** A model error ends the turn: there is nothing to feed back to the model. */
      return {
        text: lastText,
        rounds,
        toolCalls: executed,
        recalled,
        error: { code: result.error.code, message: result.error.message },
      }
    }

    lastText = result.text
    const calls: readonly ToolCall[] = result.toolCalls

    /** 2. No tool requested means the turn is finished. */
    if (calls.length === 0) {
      if (result.text.length > 0) await options.messages.append({ role: 'assistant', content: result.text })
      emit({ type: 'answer', text: result.text })
      return { text: result.text, rounds, toolCalls: executed, recalled }
    }

    /** 3. Record the assistant's tool request before running anything, so history is faithful. */
    await options.messages.append({ role: 'assistant', content: result.text, toolCalls: calls })

    for (const call of calls) {
      usedToolNames.push(call.name)
      emit({ type: 'tool-call', name: call.name, arguments: call.arguments })
      const started = Date.now()
      const tool = options.tools.get(call.name)
      let ok = false
      let payload: string
      let errorText: string | undefined
      if (tool === undefined) {
        /** An unknown tool is a model mistake, reported back so it can correct itself. */
        errorText = `no tool named "${call.name}" is registered`
        payload = errorText
      } else {
        try {
          const value = await tool.execute(call.arguments)
          ok = true
          payload = typeof value === 'string' ? value : JSON.stringify(value)
        } catch (error) {
          errorText = String((error as { message?: unknown })?.message ?? error)
          payload = errorText
        }
      }
      const ms = Date.now() - started
      executed.push({ name: call.name, arguments: call.arguments, ok, ms, ...(errorText === undefined ? {} : { error: errorText }) })
      emit({ type: 'tool-result', name: call.name, ok, ms, ...(errorText === undefined ? {} : { error: errorText }) })
      await options.messages.append({
        role: 'tool',
        content: payload,
        toolCallId: call.id,
        ...(ok ? {} : { isError: true }),
      })
    }
  }

  /**
   * The budget ran out with the model still asking for tools. Reported as an error rather than
   * an empty success: "it stopped" and "it finished" are different outcomes.
   */
  return {
    text: lastText,
    rounds,
    toolCalls: executed,
    recalled,
    error: { code: 'ROUND_BUDGET_EXHAUSTED', message: `model asked for tools in all ${maxRounds} rounds it was given` },
  }
}

/**
 * A conversation held in memory, for a harness with no host log.
 *
 * `compact` keeps the PINNED messages (a system prompt the caller marks) and the newest, and
 * reports what it removed — the same contract `MessageAdapter` documents, implemented without
 * a dependency so the loop can run with nothing installed.
 */
export function createMemoryMessages(initial: readonly ChatMessage[] = []): MessageAdapter & {
  /** Mark a message as never trimmed. Index-based over the current array. */
  pin(index: number): void
} {
  let list: ChatMessage[] = [...initial]
  const pinned = new Set<number>()
  return {
    name: 'memory',
    messages: () => list,
    async append(message: ChatMessage) {
      list = [...list, message]
    },
    async appendMany(messages: readonly ChatMessage[]) {
      list = [...list, ...messages]
    },
    pin(index: number) {
      pinned.add(index)
    },
    async compact(budgetTokens: number) {
      /** A cheap char/4 estimate: exactness is not the point, boundedness is. */
      const cost = (message: ChatMessage): number => Math.ceil(message.content.length / 4) + 4
      let total = list.reduce((sum, message) => sum + cost(message), 0)
      if (total <= budgetTokens) return { removed: [], kept: list.length }
      const keep = new Set<number>()
      for (let index = 0; index < list.length; index += 1) if (pinned.has(index)) keep.add(index)
      for (let index = list.length - 1; index >= 0; index -= 1) {
        if (keep.has(index)) continue
        const price = cost(list[index])
        if (total - price < budgetTokens) {
          keep.add(index)
          total -= price
        }
      }
      const removed: ChatMessage[] = []
      const kept: ChatMessage[] = []
      for (let index = 0; index < list.length; index += 1) {
        if (keep.has(index)) kept.push(list[index])
        else removed.push(list[index])
      }
      list = kept
      pinned.clear()
      return { removed, kept: kept.length }
    },
    async reset() {
      list = []
      pinned.clear()
    },
  }
}
