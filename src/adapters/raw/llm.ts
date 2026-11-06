/**
 * A MODEL OVER PLAIN `fetch` — `adapters/raw/llm.ts`.
 *
 * WHY THIS EXISTS AT ALL
 *
 * Everything else in this layer is transport-neutral, which means something has to be the FLOOR: the
 * one implementation that turns the protocol's `ChatMessage[]` into bytes on a socket and back. If that
 * floor required an SDK, the layer would depend on a package that changes on its own schedule — and the
 * whole point of `adapters/raw/` is that a bare Node process can be a harness.
 *
 * THE WIRE FORMAT IS OPENAI-COMPATIBLE, and that is a MEASURED choice rather than a taste: the same
 * request shape is accepted by the mainstream providers (including the one this workspace uses) with
 * only `baseUrl` and `model` differing. A provider that speaks something else is another adapter, not a
 * flag here.
 *
 * WHERE THE TOOL LOOP LIVES, AND WHY IT NEEDS A SEAM
 *
 * The loop — ask, run the tools the model requested, append their results, ask again — belongs next to
 * the WIRE FORMAT, because each provider has its own shape for "a tool result". But an adapter that
 * only speaks HTTP has no tool registry, so the loop needs one injected thing: a function that runs a
 * call. `executeTool` is that seam. Without it the adapter cannot complete a loop and must hand the
 * calls back — which it does, rather than pretending the request never happened.
 */

import type {
  ChatMessage,
  GenerateOptions,
  GenerationResult,
  LLMAdapter,
  ToolCall,
  ToolSchema,
} from '../../protocol/index.js'

/** Runs one tool call on the caller's behalf. */
export type ToolRunner = (
  call: ToolCall,
) => Promise<{ isError: boolean; value?: unknown; error?: { code?: string; message: string } }>

/** One OpenAI-compatible endpoint. */
export interface RawLlmOptions {
  /** e.g. `https://api.deepseek.com/v1` — the `/chat/completions` suffix is added here. */
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  /** Tried once when the primary model fails on the FIRST round. Its use is reported, never silent. */
  readonly fallbackModel?: string
  readonly fetchImpl?: typeof fetch
  /** How many tool-call rounds a single `generate` may run before giving up. Default 8. */
  readonly maxToolRounds?: number
  /** Runs tool calls when the loop is allowed to complete them. */
  readonly executeTool?: ToolRunner

  /* ── ROUTE HIJACKING ──────────────────────────────────────────────────────────────────────── */

  /**
   * A SECOND ENDPOINT, used when the primary says "no more" — 429 or a quota error.
   *
   * WHY THIS IS A ROUTE AND NOT A RETRY: a retry against an exhausted account retries into the same
   * refusal. The only thing that helps is DIFFERENT CREDENTIALS, and that means a different endpoint,
   * a different key, or both. Retrying is for transient failures; this is for a spent budget.
   */
  readonly fallbackRoute?: { readonly baseUrl: string; readonly apiKey: string; readonly model?: string }
  /**
   * READ THE FALLBACK ROUTE WHEN IT IS NEEDED, not at construction.
   *
   * THE DIFFERENCE MATTERS OPERATIONALLY: a config file edited while the harness runs (by a human, or by
   * a repair tool — see `rewriteRouteInConfig`) must be picked up WITHOUT a restart. Reading at
   * construction would pin the process to whatever the file said at boot, which is precisely the moment
   * the operator was still fixing it.
   */
  readonly loadFallbackRoute?: () => { baseUrl?: string; apiKey?: string; model?: string } | undefined
  /** Called after a hijack, so a caller can persist the switch or raise an alarm. */
  readonly onRouteHijacked?: (event: { from: string; to: string; status: number; reason: string }) => void
}

/**
 * IS THIS RESPONSE A SPENT BUDGET RATHER THAN A TRANSIENT FAILURE?
 *
 * THE DISTINCTION IS THE WHOLE MECHANISM. Retrying a 500 might work; retrying a 429 on an exhausted
 * account never will. So the switch triggers on exactly two signals:
 *
 *   - HTTP 429 (`Too Many Requests`), the standard "slow down or go away";
 *   - a provider-specific quota error in the body — `QUOTA_EXCEEDED`, `insufficient_quota`,
 *     `exceeded your current quota`, `额度`, `余额不足`.
 *
 * WHY THE BODY IS INSPECTED AT ALL: several compatible providers answer `HTTP 403` or `HTTP 400` with a
 * quota message rather than 429, and a status-only test would miss exactly the case this exists for.
 */
export function isQuotaExhausted(status: number, body: string): boolean {
  if (status === 429) return true
  return /QUOTA_EXCEEDED|insufficient[_\s-]?quota|exceeded your current quota|额度|余额不足|配额/iu.test(body)
}

/** Assert an API key is present, with a message that says what to do rather than what failed. */
function requireKey(apiKey: string): void {
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new Error(
      'raw-llm: 缺少 apiKey。把它放在环境变量里（如 DEEPSEEK_API_KEY）再构造这个 adapter；' +
        '不要把它写进代码，也不要提交到仓库。',
    )
  }
}

/** The wire shape of one message. Kept local: this is the ONLY place that knows the provider format. */
interface WireMessage {
  role: string
  content: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

function toWire(message: ChatMessage): WireMessage {
  if (message.role === 'assistant' && message.toolCalls !== undefined && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content.length > 0 ? message.content : null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    }
  }
  if (message.role === 'tool') {
    return { role: 'tool', content: message.content, tool_call_id: message.toolCallId ?? '' }
  }
  return { role: message.role, content: message.content }
}

function toWireTool(tool: ToolSchema): { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } } {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }
}

/**
 * Parse the arguments a provider sent.
 *
 * WHY THIS IS TOLERANT: a model can emit malformed JSON for arguments — it is the single most common
 * provider-side defect. Throwing here would turn "the model fumbled a tool call" into "the harness
 * crashed", when the correct behaviour is to hand the failure BACK to the model as a tool error so it
 * can correct itself.
 */
function parseArguments(raw: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: {} }
  if (typeof raw === 'object') return { ok: true, value: raw as Record<string, unknown> }
  if (typeof raw !== 'string') return { ok: false, message: `tool arguments 不是字符串：${typeof raw}` }
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: 'tool arguments 不是一个 JSON 对象' }
    }
    return { ok: true, value: parsed as Record<string, unknown> }
  } catch (error) {
    return { ok: false, message: `tool arguments 不是合法 JSON：${String((error as any)?.message ?? error)}` }
  }
}

/** What one HTTP round produced. Internal, so the loop logic lives in one place. */
interface RoundResult {
  text: string
  toolCalls: ToolCall[]
  model: string
  usage?: { inputTokens?: number; outputTokens?: number }
}

export function createRawLlm(options: RawLlmOptions): LLMAdapter {
  requireKey(options.apiKey)
  const baseUrl = options.baseUrl.replace(/\/+$/u, '')
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const maxRounds = Math.max(1, Math.trunc(options.maxToolRounds ?? 8))

  /**
   * THE LIVE ROUTE — MUTABLE, and that is the entire feature.
   *
   * `generate()` reads it at the top of every attempt rather than capturing it, so a hijack takes effect
   * on the very next call. A `const` here would mean the switch only worked for calls made after a
   * restart, which is not a switch.
   */
  let route = {
    baseUrl: options.baseUrl.replace(/\/+$/u, ''),
    apiKey: options.apiKey,
    model: options.model,
  }
  /** What the caller originally configured, for the "from → to" report. */
  const initialRoute = { ...route }
  let hijacked = false

  /**
   * SWITCH THE ROUTE. Returns the new route, or `undefined` when there is nowhere to go.
   *
   * ORDER OF SOURCES, and why: the STATIC fallback is checked first because it is cheap and explicit; the
   * LOADER is checked second because it is the one that can change on disk while the process runs. A
   * loader that returns nothing is not an error — it means "no fallback has been configured yet", which
   * is a legitimate operational state.
   */
  function hijackRoute(status: number, reason: string): typeof route | undefined {
    const loaded = options.loadFallbackRoute?.()
    const candidate = {
      baseUrl: (options.fallbackRoute?.baseUrl ?? loaded?.baseUrl ?? '').replace(/\/+$/u, ''),
      apiKey: options.fallbackRoute?.apiKey ?? loaded?.apiKey ?? '',
      model: options.fallbackRoute?.model ?? loaded?.model ?? route.model,
    }
    if (candidate.baseUrl.length === 0 || candidate.apiKey.length === 0) return undefined
    /**
     * GOING BACK TO WHERE WE ALREADY ARE IS NOT A HIJACK. Without this, a fallback configured to the same
     * endpoint would produce an infinite "switch" that changes nothing and hides the real failure.
     */
    if (candidate.baseUrl === route.baseUrl && candidate.apiKey === route.apiKey) return undefined

    const from = `${initialRoute.baseUrl}`
    route = candidate
    hijacked = true
    try {
      options.onRouteHijacked?.({ from, to: candidate.baseUrl, status, reason })
    } catch {
      /** A throwing observer must not undo the switch it was told about. */
    }
    return route
  }

  /** Has this adapter switched away from what it was constructed with? Diagnostics read this. */
  const routeState = (): { baseUrl: string; model: string; hijacked: boolean; initialBaseUrl: string } => ({
    baseUrl: route.baseUrl,
    model: route.model,
    hijacked,
    initialBaseUrl: initialRoute.baseUrl,
  })

  /**
   * ONE HTTP ROUND. No loop, no tool execution.
   *
   * Keeping this pure is what makes the loop readable: everything about the provider's wire format is
   * here, everything about control flow is in `generate`.
   */
  async function round(
    messages: readonly ChatMessage[],
    settings: {
      tools?: readonly ToolSchema[]
      system?: string
      maxTokens?: number
      temperature?: number
      model: string
      signal?: AbortSignal
    },
  ): Promise<{ ok: true; result: RoundResult } | { ok: false; message: string; status?: number; quota?: boolean; body?: string }> {
    const body: Record<string, unknown> = {
      model: settings.model,
      messages: [
        ...(settings.system === undefined || settings.system.length === 0
          ? []
          : [{ role: 'system', content: settings.system }]),
        ...messages.map(toWire),
      ],
      max_tokens: settings.maxTokens ?? 4096,
    }
    if (settings.tools !== undefined && settings.tools.length > 0) {
      body.tools = settings.tools.map(toWireTool)
      body.tool_choice = 'auto'
    }
    if (typeof settings.temperature === 'number') body.temperature = settings.temperature

    let response: Response
    try {
      /**
       * THE ROUTE IS READ HERE, per round — so a switch made between rounds (or between calls) applies
       * immediately, and a multi-round tool loop cannot keep hammering an exhausted key.
       */
      response = await fetchImpl(`${route.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${route.apiKey}` },
        body: JSON.stringify(body),
        ...(settings.signal === undefined ? {} : { signal: settings.signal }),
      })
    } catch (error) {
      return { ok: false, message: `网络错误：${String((error as any)?.message ?? error)}` }
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      return {
        ok: false,
        message: `HTTP ${response.status} ${detail.slice(0, 300)}`,
        status: response.status,
        /** Flagged at the source, so the caller does not have to re-parse a message string. */
        quota: isQuotaExhausted(response.status, detail),
        body: detail,
      }
    }

    const payload: any = await response.json()
    const choice = payload?.choices?.[0]
    if (choice === undefined) return { ok: false, message: '回复里没有 choices' }

    const rawCalls: any[] = Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : []
    const toolCalls: ToolCall[] = []
    for (const raw of rawCalls) {
      const name = String(raw?.function?.name ?? '')
      if (name.length === 0) continue
      const parsed = parseArguments(raw?.function?.arguments)
      /**
       * MALFORMED ARGUMENTS BECOME A TOOL CALL WITH A MARKER, not a dropped call.
       *
       * Dropping it would leave the model's request unanswered, and the next round would look like the
       * model forgot what it asked. Sending it back as a failed RESULT is how the model learns.
       */
      toolCalls.push({
        id: String(raw?.id ?? `call-${toolCalls.length}`),
        name,
        arguments: parsed.ok ? parsed.value : { __parseError: parsed.message },
      })
    }

    return {
      ok: true,
      result: {
        text: String(choice?.message?.content ?? ''),
        toolCalls,
        model: String(payload?.model ?? settings.model),
        ...(payload?.usage === undefined
          ? {}
          : {
              usage: {
                inputTokens: Number(payload.usage.prompt_tokens),
                outputTokens: Number(payload.usage.completion_tokens),
              },
            }),
      },
    }
  }

  return {
    name: 'raw-llm',
    provider: 'openai-compatible',

    /**
     * ASK, AND RUN THE TOOL LOOP WHEN IT CAN.
     *
     * Three exits, and each is a different fact:
     *
     *   1. the model answered in text            → done, the normal case;
     *   2. the model called tools and we HAVE a runner → run them, append, ask again;
     *   3. the model called tools and we have NO runner → hand the calls back.
     *
     * Exit 3 is why `GenerationResult` carries `toolCalls` at all: an adapter with no registry must not
     * pretend the request never happened, and must not answer "done" when the model asked for work.
     */
    async generate(messages: readonly ChatMessage[], settings: GenerateOptions = {}): Promise<GenerationResult> {
      const limit = Math.max(1, Math.trunc(settings.maxToolRounds ?? maxRounds))
      const conversation: ChatMessage[] = [...messages]
      let model = route.model
      let lastText = ''
      let usage: { inputTokens?: number; outputTokens?: number } | undefined
      let fellBack = false
      /** How many times THIS call has switched routes. Bounded, so a broken fallback cannot loop. */
      let hijacks = 0
      const maxHijacks = 1

      for (let roundIndex = 0; roundIndex < limit; roundIndex += 1) {
        const answer = await round(conversation, {
          ...(settings.tools === undefined ? {} : { tools: settings.tools }),
          ...(settings.system === undefined ? {} : { system: settings.system }),
          ...(settings.maxTokens === undefined ? {} : { maxTokens: settings.maxTokens }),
          ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
          ...(settings.signal === undefined ? {} : { signal: settings.signal }),
          model,
        })

        if (!answer.ok) {
          /**
           * ROUTE HIJACKING — THE SPENT-BUDGET CASE.
           *
           * ORDER IS THE DESIGN:
           *
           *   1. a QUOTA failure switches the endpoint/credentials and RETRIES THE SAME REQUEST;
           *   2. only if there is nowhere to switch (or the switch already happened) does a MODEL
           *      fallback apply;
           *   3. otherwise the failure is reported.
           *
           * WHY QUOTA COMES FIRST: an exhausted key answers the same refusal to every model. Switching
           * the model name first would spend a second round learning the same fact, and the thing that
           * actually helps — a different account — would never be tried.
           */
          if (answer.quota === true && hijacks < maxHijacks) {
            const next = hijackRoute(answer.status ?? 429, answer.message)
            if (next !== undefined) {
              hijacks += 1
              model = next.model
              /** `roundIndex -= 1` so the hijacked attempt replaces the failed one rather than consuming budget. */
              roundIndex -= 1
              continue
            }
          }

          if (options.fallbackModel !== undefined && !fellBack && model !== options.fallbackModel) {
            fellBack = true
            model = options.fallbackModel
            roundIndex -= 1
            continue
          }
          return {
            text: lastText,
            toolCalls: [],
            model,
            error: {
              code: answer.quota === true ? 'LLM_QUOTA_EXHAUSTED' : 'LLM_CALL_FAILED',
              stage: 'generate',
              message:
                answer.quota === true && hijacks === 0
                  ? `${answer.message}（没有可用的备用路由：设置 fallbackRoute / FALLBACK_API_URL + FALLBACK_API_KEY）`
                  : answer.message,
            },
          }
        }

        model = answer.result.model
        lastText = answer.result.text
        if (answer.result.usage !== undefined) usage = answer.result.usage

        /** NO TOOL CALLS MEANS DONE — checked first, so a plain answer never costs an extra round. */
        if (answer.result.toolCalls.length === 0) {
          return { text: lastText, toolCalls: [], model, ...(usage === undefined ? {} : { usage }) }
        }

        /** Exit 3: no runner, so the calls go back to the caller unexecuted and un-dropped. */
        if (options.executeTool === undefined) {
          return { text: lastText, toolCalls: answer.result.toolCalls, model, ...(usage === undefined ? {} : { usage }) }
        }

        /** Exit 2: run what the model asked for, feed the results back, ask again. */
        conversation.push({ role: 'assistant', content: lastText, toolCalls: answer.result.toolCalls })
        for (const call of answer.result.toolCalls) {
          let outcome: Awaited<ReturnType<ToolRunner>>
          try {
            outcome = await options.executeTool(call)
          } catch (error) {
            /**
             * A THROWING RUNNER BECOMES A TOOL ERROR, NOT A HARNESS ERROR. The model gets to see what
             * went wrong and try something else; the caller does not get an exception it cannot act on.
             */
            outcome = { isError: true, error: { code: 'TOOL_THREW', message: String((error as any)?.message ?? error) } }
          }
          conversation.push({
            role: 'tool',
            content: outcome.isError
              ? `ERROR: ${outcome.error?.message ?? 'tool failed'}`
              : typeof outcome.value === 'string'
                ? outcome.value
                : JSON.stringify(outcome.value ?? null),
            toolCallId: call.id,
            ...(outcome.isError === true ? { isError: true } : {}),
          })
        }
      }

      return {
        text: lastText,
        toolCalls: [],
        model,
        error: {
          code: 'LLM_TOOL_ROUNDS_EXHAUSTED',
          stage: 'generate',
          message:
            `超过 ${limit} 轮工具调用仍未得到最终回答：` +
            '一个在失败工具上反复重试的模型会无限计费，所以这里必须停下并如实报告。',
        },
      }
    },

    async healthy(): Promise<boolean> {
      try {
        /** Probes the LIVE route — after a hijack, health means "can the endpoint we would use answer". */
        const response = await fetchImpl(`${route.baseUrl}/models`, {
          headers: { authorization: `Bearer ${route.apiKey}` },
        })
        return response.ok
      } catch {
        return false
      }
    },
    /**
     * WHICH ROUTE IS LIVE RIGHT NOW — a diagnostic, not part of `LLMAdapter`.
     *
     * A hijack that nobody can observe is indistinguishable from a request that quietly started going
     * somewhere else. `initialBaseUrl` is kept so a report can say "from → to" without the caller
     * remembering what it configured.
     */
    routeState,
  } as LLMAdapter & { routeState: typeof routeState }
}
