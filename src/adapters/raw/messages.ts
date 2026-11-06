/**
 * A CONVERSATION AS AN ARRAY — `adapters/raw/messages.ts`.
 *
 * WHY NOT A LOG
 *
 * The protocol's `SessionAdapter` reads a durable log that the HOST owns: it numbers events, writes a
 * header, and decides what its view renders. A standalone harness has none of that. What it has is a
 * list of messages and a token budget. Forcing it to maintain a host-shaped log would mean fabricating
 * numbering and headers nobody reads — coupling with no benefit.
 *
 * THE TOKEN BUDGET IS THE REAL WORK, AND THE HARD PART IS BEING HONEST ABOUT IT
 *
 * Trimming a conversation is lossy, and the loss is INVISIBLE to the model: it will answer as if nothing
 * is missing. So this adapter:
 *
 *   1. never drops a PINNED message (the system prompt is the standing rules — losing it silently is
 *      how a constraint disappears mid-task);
 *   2. returns what it removed, so a caller can persist it instead of shredding it;
 *   3. counts with a REAL approximation and says which approximation it used.
 */

import type { ChatMessage, MessageAdapter } from '../../protocol/index.js'

/**
 * A TOKEN ESTIMATOR, AND AN HONEST ONE.
 *
 * WHY NOT A REAL TOKENIZER: a tokenizer is a per-model artifact. Shipping one here would pin this
 * adapter to one provider's vocabulary, and being wrong about token counts by 20% is survivable while
 * being unable to run without a dictionary is not.
 *
 * THE RULE OF THUMB BELOW IS CALIBRATED FOR MIXED CJK AND LATIN, and it is stated rather than hidden:
 * CJK characters are ~1 token each, Latin words are ~1.3 tokens. A caller that needs exactness passes
 * its own `countTokens`.
 */
export function approximateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    // CJK Unified Ideographs + Hiragana/Katakana + Hangul: roughly one token per character.
    if ((code >= 0x3040 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

export interface RawMessageOptions {
  /** Messages to start with. */
  readonly initial?: readonly ChatMessage[]
  /**
   * Indices that `compact` must never remove, as a predicate over the message.
   *
   * WHY A PREDICATE AND NOT A COUNT: "keep the first message" is right for a system prompt and wrong
   * for a conversation whose first message is a greeting. The caller knows which messages are load-bearing.
   */
  readonly pinned?: (message: ChatMessage, index: number) => boolean
  /** Overrides the estimator. Must return a per-message cost. */
  readonly countTokens?: (message: ChatMessage, index: number) => number
}

export function createRawMessages(options: RawMessageOptions = {}): MessageAdapter {
  let held: ChatMessage[] = [...(options.initial ?? [])]
  const pinned = options.pinned ?? ((message: ChatMessage) => message.role === 'system')
  const cost = (message: ChatMessage, index: number): number => {
    if (options.countTokens !== undefined) return Math.max(1, Math.trunc(options.countTokens(message, index)))
    let total = approximateTokens(message.content)
    for (const call of message.toolCalls ?? []) total += approximateTokens(JSON.stringify(call.arguments)) + 4
    return Math.max(1, total)
  }

  return {
    name: 'raw-messages',

    messages(): readonly ChatMessage[] {
      /**
       * A COPY, NOT THE LIVE ARRAY.
       *
       * A caller that mutated the returned array would change the conversation without going through
       * `append`, which is how a message ends up in the model's context but never in the saved history.
       */
      return [...held]
    },

    async append(message: ChatMessage): Promise<void> {
      held.push(message)
    },

    async appendMany(messages: readonly ChatMessage[]): Promise<void> {
      held.push(...messages)
    },

    /**
     * FIT THE CONVERSATION INTO A BUDGET.
     *
     * ORDER MATTERS: pinned first, then newest-first. That is deliberately not "oldest first" — the
     * newest message is the one being answered, so dropping it would answer a question nobody asked.
     *
     * A SINGLE MESSAGE LARGER THAN THE BUDGET IS KEPT AND REPORTED. Dropping it would leave the caller
     * with an empty conversation that silently fails to answer; keeping it and saying so at least lets
     * the caller decide to truncate the content itself.
     */
    async compact(budgetTokens: number): Promise<{ removed: readonly ChatMessage[]; kept: number }> {
      const budget = Math.max(1, Math.trunc(budgetTokens))
      const keep = new Array<boolean>(held.length).fill(false)
      let used = 0

      for (let index = 0; index < held.length; index += 1) {
        if (!pinned(held[index], index)) continue
        keep[index] = true
        used += cost(held[index], index)
      }

      for (let index = held.length - 1; index >= 0; index -= 1) {
        if (keep[index]) continue
        const price = cost(held[index], index)
        if (used + price > budget) continue
        keep[index] = true
        used += price
      }

      const removed = held.filter((_message, index) => !keep[index])
      held = held.filter((_message, index) => keep[index])
      return { removed: [...removed], kept: held.length }
    },

    async reset(): Promise<void> {
      held = []
    },
  }
}
