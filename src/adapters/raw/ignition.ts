/**
 * BARE-METAL IGNITION — `adapters/raw/ignition.ts`.
 *
 * WHAT THIS IS, IN ONE SENTENCE
 *
 * The trigger verb of a hostless deployment: when a migrator needs a target session to "start working",
 * this calls the model with the session's own content and writes the reply back into the session.
 *
 * WHY IT BELONGS HERE AND NOT IN THE PLUGIN
 *
 * `dsh-graft-slice` asks for one thing — `binding.triggers`, a function that takes a session ref and a
 * trigger and answers a receipt. Inside a host, the layer supplies the host's controller behind it. On a
 * bare machine there IS no controller, and the honest implementation of "make it start" is: build the
 * conversation from what is already in the log, ask the model, append the answer.
 *
 * Putting that in the PLUGIN would mean the plugin knows how to call a model, and the whole point of the
 * gateway work is that it does not.
 *
 * THE THREE THINGS THIS MUST GET RIGHT
 *
 *   1. IDEMPOTENCE. A retry must not prompt twice. The check is the same one the host channel uses: read
 *      the session's own log and look for the caller's marker. The marker is CALLER-SUPPLIED, because graft
 *      stamps its prompts with its own string and a hard-coded one would make every warm target look cold.
 *
 *   2. THE CONVERSATION COMES FROM THE LOG, not from the trigger text alone. A migrated target's context
 *      is already written — the setup, the goal, the replayed history. Asking the model with ONLY the
 *      trigger text would throw all of it away and produce an answer to a question nobody asked.
 *
 *   3. A FAILURE IS A RECEIPT, NEVER A THROW. The caller is mid-migration; an exception here would leave
 *      a half-built target with no diagnosis.
 */

import type { ChatMessage, LLMAdapter } from '../../protocol/harness.js'

/** The shape `dsh-graft-slice` calls. Structural, so a signature change breaks here first. */
export interface IgnitionTriggerInput {
  readonly text: string
  readonly mode: 'queue' | 'interrupt'
  readonly origin: string
  readonly marker?: string
}

export interface IgnitionReceipt {
  readonly ok: boolean
  readonly stage: string
  readonly warnings: string[]
  readonly channel?: string
  readonly alreadyTriggered?: true
  readonly promptChars?: number
  readonly error?: { code: string; stage: string; message: string }
}

/**
 * WHAT THE IGNITER NEEDS FROM THE SESSION.
 *
 * Deliberately NOT `SessionAdapter`: this module only reads a log and appends one message, and asking for
 * the whole adapter would let it create sessions it has no business creating.
 */
export interface IgnitionSession {
  readLog(ref: { id: string; cwd?: string }): Promise<{ readable: boolean; events: ReadonlyArray<{ seq: number; type: string; data?: unknown }>; notes?: readonly string[] }>
  inject(ref: { id: string; cwd?: string }, items: Array<{ visibility: 'visible' | 'context-only'; text: string; origin: string }>): Promise<{
    ok: boolean
    stage: string
    warnings: string[]
    rendered: ReadonlyArray<{ id: string; requested: string; rendered: boolean; reason: string }>
    error?: { code: string; stage: string; message: string }
  }>
}

export interface IgnitionOptions {
  readonly session: IgnitionSession
  readonly llm: LLMAdapter
  /** Cap on the model call. A repair that hangs must not hang the migration. */
  readonly timeoutMs?: number
  /** Max characters of prior conversation sent to the model. Keeps one huge session from blowing the budget. */
  readonly maxContextChars?: number
}

/** Pull readable text out of a stored message event, tolerating both `data.text` and `data.message.content`. */
function textOfEvent(event: { type: string; data?: unknown }): string {
  const data = (event.data ?? {}) as Record<string, unknown>
  if (typeof data.text === 'string' && data.text.trim().length > 0) return data.text.trim()
  const message = (data.message ?? data) as Record<string, unknown>
  const content = Array.isArray(message.content) ? message.content : []
  return content
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => String(block.text))
    .join('\n')
    .trim()
}

/** Which stored event kinds become which roles. The same mapping the raw session adapter uses. */
const ROLE_OF: Record<string, ChatMessage['role']> = {
  'developer/message': 'system',
  'system/message': 'system',
  'user/message': 'user',
  'assistant/message': 'assistant',
}

export function createBareIgnition(options: IgnitionOptions) {
  const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? 120_000))
  const maxContextChars = Math.max(200, Math.trunc(options.maxContextChars ?? 40_000))

  return {
    /**
     * THE TRIGGER VERB. Signature matches the layer's, so a binding can carry it unchanged.
     */
    async trigger(ref: { id: string; cwd?: string }, trigger: IgnitionTriggerInput): Promise<IgnitionReceipt> {
      const marker = typeof trigger.marker === 'string' && trigger.marker.length > 0 ? trigger.marker : ''
      const promptChars = trigger.text.length

      /* ── 1. idempotence: has this caller already prompted this session? ─────────────────── */

      let before: Awaited<ReturnType<IgnitionSession['readLog']>>
      try {
        before = await options.session.readLog(ref)
      } catch (error) {
        return {
          ok: false,
          stage: 'trigger:read',
          warnings: [],
          error: { code: 'LOG_UNREADABLE', stage: 'trigger', message: String((error as any)?.message ?? error) },
        }
      }
      if (before.readable !== true) {
        return {
          ok: false,
          stage: 'trigger:missing',
          warnings: [],
          error: {
            code: 'SESSION_NOT_FOUND',
            stage: 'trigger',
            message: `${ref.id} 的日志读不到（${(before.notes ?? []).join('; ') || 'no events'}）`,
          },
        }
      }

      if (marker.length > 0) {
        const already = before.events.some((event) => {
          if (ROLE_OF[event.type] !== 'user') return false
          return textOfEvent(event).startsWith(marker)
        })
        if (already) {
          /**
           * ALREADY PROMPTED — and the receipt says `alreadyTriggered`, which the plugin maps to
           * "not attempted, but fine". Re-prompting a warm session is the exact routing bug the per-target
           * admission map exists to stop, and the LOG is the only durable evidence.
           */
          return { ok: true, stage: 'trigger:already', warnings: [], alreadyTriggered: true, channel: 'bare.log', promptChars }
        }
      }

      /* ── 2. build the conversation FROM THE LOG, then add the trigger ────────────────────── */

      const conversation: ChatMessage[] = []
      for (const event of before.events) {
        const role = ROLE_OF[event.type]
        if (role === undefined) continue
        const text = textOfEvent(event)
        if (text.length === 0) continue
        conversation.push({ role, content: text })
      }
      conversation.push({ role: 'user', content: trigger.text })

      /** Trim from the OLDEST end: the newest context is what the answer depends on. */
      let budget = 0
      const kept: ChatMessage[] = []
      for (let index = conversation.length - 1; index >= 0; index -= 1) {
        const message = conversation[index]
        budget += message.content.length
        if (budget > maxContextChars && kept.length > 0) break
        kept.unshift(message)
      }

      /* ── 3. ask, and write the answer back ─────────────────────────────────────────────── */

      const controller = typeof AbortController === 'function' ? new AbortController() : undefined
      const timer = setTimeout(() => controller?.abort(new Error(`点火超时 ${timeoutMs}ms`)), timeoutMs)
      if (typeof (timer as any).unref === 'function') (timer as any).unref()

      let answer: Awaited<ReturnType<LLMAdapter['generate']>>
      try {
        answer = await options.llm.generate(kept, {
          maxTokens: 2000,
          ...(controller === undefined ? {} : { signal: controller.signal }),
        })
      } catch (error) {
        clearTimeout(timer)
        return {
          ok: false,
          stage: 'trigger:model',
          warnings: [],
          error: { code: 'IGNITION_MODEL_FAILED', stage: 'trigger', message: String((error as any)?.message ?? error) },
        }
      }
      clearTimeout(timer)

      if (answer.error !== undefined) {
        return {
          ok: false,
          stage: 'trigger:model',
          warnings: [],
          error: { code: answer.error.code, stage: 'trigger', message: answer.error.message },
        }
      }
      if (answer.text.trim().length === 0) {
        return {
          ok: false,
          stage: 'trigger:empty',
          warnings: [],
          error: { code: 'IGNITION_EMPTY_ANSWER', stage: 'trigger', message: '模型返回了空回答' },
        }
      }

      /**
       * THE ANSWER IS WRITTEN AS `visible`, and that is a decision worth stating: the model's reply is what
       * a human opening the target will read first. Writing it `context-only` would make the session look
       * awake in the log and asleep on screen.
       */
      const written = await options.session.inject(ref, [
        { visibility: 'visible', text: answer.text, origin: trigger.origin },
      ])
      if (!written.ok) {
        return {
          ok: false,
          stage: `trigger:${written.stage}`,
          warnings: written.warnings,
          error: written.error ?? { code: 'IGNITION_WRITE_FAILED', stage: 'trigger', message: written.stage },
        }
      }

      return {
        ok: true,
        stage: `trigger:${trigger.mode}`,
        warnings: [],
        channel: 'bare.llm',
        promptChars,
      }
    },
  }
}
