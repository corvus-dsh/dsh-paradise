/**
 * TOOLS CREATED AT RUNTIME — `adapters/raw/tools.ts`.
 *
 * WHAT THIS IS FOR, IN THE USER'S OWN TERMS
 *
 * "允许 AI 在运行时用 JS 动态注册并执行工具，突破原生工具限制."
 *
 * A harness whose tool set is fixed at start-up is limited to what was installed before it met the
 * problem. A self-healing system meets the problem FIRST: the error message arrives, and the tool that
 * would fix it does not exist yet. This factory is the seam where that tool comes into being.
 *
 * WHAT IT HONESTLY IS, AND THE WORD THAT MUST NOT BE USED
 *
 * `new Function` in the same process is NOT a sandbox. It shares globals, `process`, and the filesystem
 * with the harness. Calling that "sandboxed" would be a lie whose consequence is a security hole nobody
 * audited for. So `isolation` reports `'none'` for this implementation, and a caller that wants more
 * must supply a different factory — one that uses a child process or a VM realm.
 *
 * THE COMPILE CONTRACT
 *
 * The source text must evaluate to `{ description, parameters, execute }`. A body that throws at
 * definition time is a REFUSAL carrying the compile error, never a half-registered tool: a tool that
 * exists in `list()` but cannot run is worse than no tool, because the model will keep calling it.
 */

import type { ProtocolFailure } from '../../protocol/index.js'
import type { RuntimeTool, ToolFactory, ToolSchema } from '../../protocol/index.js'
import { runInSandbox } from './sandbox.js'
import type { SandboxOptions } from './sandbox.js'

/** The shape a source body must evaluate to. */
interface CompiledBody {
  description?: unknown
  parameters?: unknown
  execute?: unknown
}

export interface RawToolFactoryOptions {
  /**
   * Names the factory will refuse to shadow.
   *
   * WHY THIS EXISTS: a created tool called `fs` or `process` would shadow a global inside every other
   * created tool's scope, so one bad definition silently changes the meaning of a later good one.
   */
  readonly reserved?: readonly string[]
  /** Injected for tests: replaces `new Function`, so no real code is compiled. */
  readonly compile?: (source: string) => unknown
  /** Injected for tests: the clock, so a timeout test does not sleep. */
  readonly now?: () => number
  /** Per-call wall clock budget in ms. Default 30s, same as the tool adapter. */
  readonly timeoutMs?: number
  /**
   * THE SANDBOX ROOTS.
   *
   * When present, every tool RUNS IN A WORKER with a restricted API surface, and `isolation` reports
   * `'process'`. When absent, tools run in-process via `new Function` and `isolation` reports `'none'` —
   * which is the correct answer for that configuration and is stated rather than hidden.
   *
   * AN EMPTY ARRAY IS A CONFIGURATION ERROR, not "unrestricted": see `runInSandbox`.
   */
  readonly sandboxRoots?: readonly string[]
  /** How the sandbox is spawned. Injected so a test can prove the wiring without a real worker. */
  readonly runSandbox?: typeof runInSandbox
}

const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/u

/** Wrap a value into a tool error, keeping a code when the value had one. */
function asToolError(code: string, message: string): { isError: true; error: { code: string; message: string } } {
  return { isError: true, error: { code, message } }
}

export function createRawToolFactory(options: RawToolFactoryOptions = {}): ToolFactory {
  const reserved = new Set(['fs', 'process', 'require', 'module', 'console', 'global', 'globalThis', ...(options.reserved ?? [])])
  const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? 30_000))
  const tools = new Map<string, RuntimeTool>()

  /**
   * WHICH ENGINE IS LIVE, DECIDED ONCE.
   *
   * With `sandboxRoots` a tool runs in a worker against a restricted API; without them it runs in this
   * process. The factory REPORTS which, through `isolation`, because a caller that believes it is
   * sandboxed when it is not will make decisions it should not.
   */
  const sandboxRoots = options.sandboxRoots
  const sandboxed = Array.isArray(sandboxRoots) && sandboxRoots.length > 0
  const spawnSandbox = options.runSandbox ?? runInSandbox
  /** Sources are kept so the sandbox can re-run them: a worker cannot receive a function. */
  const sources = new Map<string, string>()

  /**
   * THE COMPILER SEAM.
   *
   * Default: `new Function` over the source. A test replaces it so the suite can prove the REGISTRY
   * behaviour without ever executing model-authored code — which is the only way to test this in CI
   * without making CI a place where arbitrary code runs.
   *
   * IN SANDBOX MODE THIS IS NOT USED TO COMPILE. A worker receives SOURCE TEXT and compiles it inside
   * its own context, because a function cannot be transferred across the thread boundary — which is a
   * feature here, not a limitation: the harness process never evaluates model-authored code at all.
   */
  const compile =
    options.compile ??
    ((source: string): unknown => {
      // `new Function` rather than `eval`: it does not see this module's lexical scope, so a tool body
      // cannot reach `tools`, `reserved`, or anything else that lives here.
      const factory = new Function(`"use strict"; return (${source});`)
      return factory()
    })

  return {
    name: 'raw-tools',
    /**
     * `'process'` WHEN SANDBOXED, `'none'` OTHERWISE — and both are TRUE statements about this instance.
     *
     * The earlier version hard-coded `'none'`. That was honest for the only configuration it had, and
     * it became a lie the moment `sandboxRoots` was added: a caller reading `isolation` to decide
     * whether to run an untrusted repair would have refused a sandboxed factory for the wrong reason.
     */
    isolation: sandboxed ? 'process' : 'none',

    async define(spec: { name: string; source: string; description?: string }): Promise<{ ok: boolean; tool?: RuntimeTool; error?: ProtocolFailure }> {
      const name = String(spec.name ?? '').trim()
      if (!NAME_PATTERN.test(name)) {
        return {
          ok: false,
          error: {
            code: 'TOOL_NAME_INVALID',
            stage: 'define',
            message: `工具名 ${JSON.stringify(name)} 不合法：必须是小写字母开头、只含 a-z0-9_-、最长 48 字符。`,
          },
        }
      }
      if (reserved.has(name)) {
        return {
          ok: false,
          error: {
            code: 'TOOL_NAME_RESERVED',
            stage: 'define',
            message: `工具名 ${name} 是保留名：注册它会遮蔽一个全局，从而悄悄改变其他工具里同名标识符的含义。`,
          },
        }
      }

      /**
       * SANDBOX MODE DOES NOT COMPILE HERE.
       *
       * The source is stored and compiled INSIDE the worker, so the harness process never evaluates
       * model-authored code. A definition that will not compile is therefore discovered on the first
       * `execute`, not here — and that is reported honestly rather than being faked with a local
       * compile that the worker would then redo differently.
       */
      if (sandboxed) {
        const source = String(spec.source ?? '')
        const tool: RuntimeTool = {
          name,
          description: typeof spec.description === 'string' ? spec.description : '',
          parameters: { type: 'object', additionalProperties: true },
          async execute(args: Record<string, unknown>) {
            const result = await spawnSandbox(source, args, { roots: sandboxRoots as readonly string[], timeoutMs })
            if (result.ok) return { isError: false, value: result.value }
            return asToolError(result.error?.code ?? 'TOOL_FAILED', result.error?.message ?? 'sandbox failed')
          },
        }
        tools.set(name, tool)
        sources.set(name, source)
        return { ok: true, tool }
      }

      let body: CompiledBody
      try {
        body = compile(String(spec.source ?? '')) as CompiledBody
      } catch (error) {
        /**
         * A COMPILE ERROR IS THE MOST USEFUL MESSAGE IN THIS WHOLE FILE. It is what a self-healing loop
         * feeds back to the model so the NEXT attempt is different. Truncating it to "invalid source"
         * would make the loop spin.
         */
        return {
          ok: false,
          error: {
            code: 'TOOL_COMPILE_FAILED',
            stage: 'define',
            message: String((error as any)?.message ?? error),
          },
        }
      }

      if (body === null || typeof body !== 'object') {
        return {
          ok: false,
          error: { code: 'TOOL_SHAPE_INVALID', stage: 'define', message: '源码必须求值成一个对象 { description, parameters, execute }。' },
        }
      }
      if (typeof body.execute !== 'function') {
        return {
          ok: false,
          error: { code: 'TOOL_SHAPE_INVALID', stage: 'define', message: '求值结果缺少 execute 函数 —— 没有 execute 的工具存在于列表中却永远无法运行。' },
        }
      }

      const tool: RuntimeTool = {
        name,
        description: typeof spec.description === 'string' && spec.description.length > 0
          ? spec.description
          : typeof body.description === 'string'
            ? body.description
            : '',
        parameters:
          body.parameters !== null && typeof body.parameters === 'object'
            ? (body.parameters as Record<string, unknown>)
            : { type: 'object', additionalProperties: true },
        async execute(args: Record<string, unknown>) {
          try {
            /**
             * AWAIT THE RESULT EVEN WHEN IT IS SYNC. A tool that happens to be synchronous must not
             * behave differently from one that is not — a caller cannot tell, and should not have to.
             */
            const value = await (body.execute as (a: Record<string, unknown>) => unknown)(args)
            return { isError: false, value }
          } catch (error) {
            return asToolError('TOOL_THREW', String((error as any)?.message ?? error))
          }
        },
      }

      tools.set(name, tool)
      return { ok: true, tool }
    },

    list(): readonly ToolSchema[] {
      return [...tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }))
    },

    async execute(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; value?: unknown; error?: { code?: string; message: string } }> {
      const tool = tools.get(name)
      if (tool === undefined) {
        return asToolError('UNKNOWN_TOOL', `没有名为 ${name} 的运行时工具。`);
      }

      /**
       * SANDBOX MODE: the deadline is enforced by TERMINATING THE WORKER, which is the only mechanism
       * that ends a synchronous loop. The in-process branch below cannot do that, and says so.
       */
      if (sandboxed) {
        const source = sources.get(name)
        if (source === undefined) return asToolError('TOOL_SOURCE_MISSING', `工具 ${name} 的源码没有被保留，无法在沙箱中重跑`)
        const result = await spawnSandbox(source, args, { roots: sandboxRoots as readonly string[], timeoutMs })
        if (result.ok) return { isError: false, value: result.value }
        return asToolError(result.error?.code ?? 'TOOL_FAILED', result.error?.message ?? 'sandbox failed')
      }

      /**
       * IN-PROCESS BUDGET, WITH ITS LIMIT STATED.
       *
       * `Promise.race` unblocks the CALLER but cannot stop the tool: a synchronous `while (true)` keeps
       * the thread busy after the race settles. That is exactly why `sandboxRoots` exists, and why
       * `isolation` reports `'none'` when it is absent — a documented limit, not a hidden one.
       */
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`工具 ${name} 超过 ${timeoutMs}ms 未返回`)), timeoutMs)
        if (typeof (timer as any).unref === 'function') (timer as any).unref()
      })
      try {
        return await Promise.race([tool.execute(args), timeout])
      } catch (error) {
        return asToolError('TOOL_TIMEOUT', String((error as any)?.message ?? error))
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    },

    async revoke(name: string): Promise<boolean> {
      return tools.delete(name)
    },
  }
}
