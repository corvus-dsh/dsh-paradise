/**
 * THE TOOL ADAPTER FOR THIS RUNTIME.
 *
 * WHAT IT WRAPS: this host's tool registry, as a plugin sees it. `execute` returns the tool's answer
 * as DATA and an unknown tool as `isError: true` — never a thrown exception.
 *
 * WHY THAT DISTINCTION IS LOAD-BEARING
 *
 * A caller here is usually a plugin acting on behalf of a model. It has to be able to say "the tool
 * failed" in the same breath as "the operation succeeded" — e.g. an incubated session is mined, and
 * the memory tool was missing. A thrown error collapses those two facts into one and loses the tool's
 * own message on some hosts.
 *
 * THE REGISTRY HAS TWO FACES ON THIS RUNTIME, WHICH IS WHY RESOLUTION IS BY METHOD
 *
 * The direct property may carry only `register`, while the accessor carries `execute`. Resolving
 * positionally picked the wrong face once and the symptom read as "the service is missing" for an
 * hour. So the adapter asks for the method it is about to call.
 */

import type { ToolAdapter, ToolDescriptor, ToolOutcome } from '../../protocol/index.js'
import { service } from './services.js'

/** The default budget for one tool call. A hung tool must not hang a supervisor. */
const DEFAULT_TOOL_TIMEOUT_MS = 30_000

export function createDshToolAdapter(ctx: any): ToolAdapter {
  const registry = (): any => service(ctx, 'tools')

  return {
    name: 'dsh-tools',

    /**
     * ENUMERATION IS BEST-EFFORT AND SAYS SO BY RETURNING WHAT IT HAS.
     *
     * This host does not publish a canonical tool catalogue to a plugin: some faces expose
     * `list`/`names`, most expose only `execute`. An empty list therefore means "this host will not
     * tell me", NOT "there are no tools" — which is why the adapter does not pretend to know.
     */
    async list(): Promise<ToolDescriptor[]> {
      const tools = registry()
      if (tools === undefined) return []
      for (const method of ['list', 'names', 'all']) {
        if (typeof tools[method] !== 'function') continue
        try {
          const raw = await tools[method]()
          if (!Array.isArray(raw)) continue
          return raw
            .map((entry: any) =>
              typeof entry === 'string'
                ? { name: entry, description: '', inputSchema: {} }
                : {
                    name: String(entry?.name ?? ''),
                    description: String(entry?.description ?? ''),
                    inputSchema: entry?.parameters ?? entry?.inputSchema ?? {},
                  },
            )
            .filter((entry: ToolDescriptor) => entry.name.length > 0)
        } catch {
          continue
        }
      }
      return []
    },

    async execute(input): Promise<ToolOutcome> {
      const tools = service(ctx, 'tools', 'execute')
      if (tools === undefined || typeof tools.execute !== 'function') {
        return { isError: true, error: { code: 'TOOL_REGISTRY_UNAVAILABLE', message: 'tools.execute 不可用' } }
      }
      const timeoutMs = Number.isFinite(Number(input.timeoutMs)) ? Number(input.timeoutMs) : DEFAULT_TOOL_TIMEOUT_MS
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
      if (typeof (timer as any).unref === 'function') (timer as any).unref()
      try {
        const result = await tools.execute({
          callId: `paradise-tool-${Date.now().toString(36)}`,
          name: input.name,
          arguments: input.arguments,
          signal: controller.signal,
        })
        if (result !== null && typeof result === 'object' && result.isError === true) {
          return {
            isError: true,
            error: {
              ...(typeof result.error?.code === 'string' ? { code: result.error.code } : {}),
              message: String(result.error?.message ?? 'tool reported an error'),
            },
          }
        }
        return { isError: false, value: result !== null && typeof result === 'object' && 'value' in result ? result.value : result }
      } catch (error) {
        // UNKNOWN is a failure, and a failure is a RESULT here — never an exception escaping the
        // adapter, because the caller has a receipt to fill in and a user waiting for it.
        const message = String((error as any)?.message ?? error)
        return {
          isError: true,
          error: { code: /unknown|未找到|not found/iu.test(message) ? 'UNKNOWN_TOOL' : 'TOOL_FAILED', message },
        }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
