/**
 * THE DUAL-MODE TAKEOVER — `src/launcher.ts`.
 *
 * WHAT THIS IS
 *
 * A supervisor that watches a hosted mode (the plugin running inside a harness) and, when that harness
 * stops being healthy, TAKES OVER in bare mode using only the raw adapters. It then uses a model to
 * write the repair, runs it as a runtime tool, and hands control back.
 *
 * WHAT IT IS NOT, AND THIS MATTERS MORE
 *
 * It is NOT a watchdog that restarts a process and calls that "self-healing". Restarting a crashed
 * harness reproduces the crash. The claim being made here is narrower and checkable: the supervisor can
 * DETECT, DEGRADE, DIAGNOSE, and REPAIR — and it must be able to say "I could not" rather than loop
 * forever, because a repair loop that never converges is worse than an outage (it hides the outage).
 *
 * THE FOUR STATES, AND WHY THERE ARE FOUR
 *
 *   hosted      — the thing we depend on is answering
 *   degraded    — it is not, and we are running on raw adapters
 *   repairing   — a model is writing / a tool is running
 *   gave-up     — a human must look; we stopped, loudly
 *
 * A three-state machine (up / down / retrying) cannot express "I am running, but on the floor" — which is
 * exactly the state a dual-mode system spends most of its outage in.
 *
 * NO HOST IMPORTS. This file is importable on a bare machine, which is the entire point: a supervisor
 * that needs the thing it supervises is not a supervisor.
 */

import type { LLMAdapter, MessageAdapter, ToolFactory, GenerationResult } from './protocol/index.js'
/**
 * ONE EXTRACTION RULE, SHARED.
 *
 * This file used to carry its own inline `replace(/^```…/, '')`, which was MORE tolerant than
 * `extractToolSource` — so the launcher path survived a chatty reply while the harness path died on it
 * (`TOOL_FAILED: Invalid or unexpected token`, reproduced in `_scratch/e2e-selfheal.mjs` scenario B).
 * Two copies of "how do I get the code out of this reply" is exactly how a repair that works on one
 * path fails on the other, so there is now one implementation and both paths call it.
 */
import { extractToolSource } from './emergency-repair.js'

/** How the supervisor decides the hosted mode is unwell. */
export interface HealthProbe {
  readonly name: string
  /**
   * Answer "is the thing I depend on working right now".
   *
   * MUST NOT THROW. A probe that throws is a probe that turns a degraded system into a crashed one;
   * returning `false` is the whole contract. The reason is carried separately so the degradation is
   * diagnosable.
   */
  check(): Promise<{ ok: boolean; reason?: string; detail?: string }>
}

export type LauncherState = 'hosted' | 'degraded' | 'repairing' | 'gave-up'

/** One transition, kept so an operator can read what happened without replaying the run. */
export interface LauncherEvent {
  readonly at: number
  readonly from: LauncherState
  readonly to: LauncherState
  readonly reason: string
}

export interface LauncherOptions {
  /** What to watch. At least one. */
  readonly probes: readonly HealthProbe[]
  /** The model that writes repairs. Absent means "detect and degrade, but nobody can write a fix". */
  readonly llm?: LLMAdapter
  /** Where the diagnosis transcript lives. */
  readonly messages?: MessageAdapter
  /** Where a repair becomes a callable tool. */
  readonly tools?: ToolFactory
  /** How often to probe, in ms. Default 5000. */
  readonly intervalMs?: number
  /**
   * How many consecutive failures before degrading. Default 2.
   *
   * NOT 1, and the reason is measured rather than cautious: a single slow probe (a GC pause, a busy
   * disk) is not an outage, and degrading on it would flap between modes, which is worse than staying
   * put — every flap costs a re-initialisation and a user-visible stutter.
   */
  readonly failureThreshold?: number
  /**
   * How many repair attempts before giving up. Default 2.
   *
   * A SMALL number on purpose. A model given the same error twice will produce the same fix twice; the
   * third attempt needs NEW evidence, which is a human's job to supply.
   */
  readonly maxRepairAttempts?: number
  /** Called on every transition. A supervisor that changes state silently is unauditable. */
  readonly onEvent?: (event: LauncherEvent) => void
  /** Injected clock, so a test does not sleep. */
  readonly now?: () => number
  /** Injected timer, so a test drives the loop deterministically. */
  readonly setIntervalImpl?: (fn: () => void, ms: number) => unknown
  readonly clearIntervalImpl?: (handle: unknown) => void
  /**
   * REPLACE THE BUILT-IN REPAIR WITH YOUR OWN.
   *
   * When present, `llm` and `tools` are ignored for repair — the strategy owns the whole attempt. That
   * is the point: a harness that needs to assemble a brief, open a session, ignite it, and THEN compile
   * the answer cannot express that through the narrow `llm` + `tools` pair.
   */
  readonly onRepair?: RepairStrategy
}

/** What a repair attempt produced. */
export interface RepairAttempt {
  readonly attempt: number
  readonly diagnosis: string
  /** The tool name the model's fix was registered under, when it produced one. */
  readonly toolName?: string
  readonly defined: boolean
  readonly ran: boolean
  readonly output?: string
  readonly error?: string
}

/**
 * WHAT ONE REPAIR ATTEMPT LOOKS LIKE WHEN THE CALLER SUPPLIES THE STRATEGY.
 *
 * WHY THIS SEAM EXISTS: the built-in strategy is "ask the model, compile the answer, run it" — which is
 * the right default and the wrong ONLY option. A harness that wants to run an emergency SESSION (assemble
 * a brief from disk, inject it, ignite it, then compile) cannot express that through `llm` + `tools`
 * alone, because the ASSEMBLY is the interesting part and it belongs to the caller.
 *
 * Keeping both paths is deliberate: the built-in one is what a library user gets for free, and the
 * injected one is what a program uses when it has an opinion about the diagnosis.
 */
export type RepairStrategy = (diagnosis: string, attempt: number) => Promise<{
  /** Present when the strategy produced something to record, even if it refused. */
  output?: string
  error?: string
  toolName?: string
  defined: boolean
  ran: boolean
}>

export interface LauncherReport {
  readonly state: LauncherState
  readonly transitions: readonly LauncherEvent[]
  readonly attempts: readonly RepairAttempt[]
  /** Why it gave up, when it did. */
  readonly gaveUpReason?: string
}

/**
 * THE PROMPT A REPAIR IS BUILT FROM.
 *
 * WHY IT IS A CONSTANT IN THIS FILE rather than a separate template: a repair prompt that drifts from
 * the runner that consumes its answer is how a self-healing loop starts asking for things it cannot
 * parse. Keeping the instruction and the parse in one file makes that drift a compile-time problem.
 *
 * IT ASKS FOR A TOOL DEFINITION, not a patch. A patch would have to be applied to a file on disk by a
 * mechanism that then has to be trusted; a tool is compiled, run, and can be revoked. That is a smaller
 * blast radius for the same benefit.
 */
export const REPAIR_PROMPT = `你是彼岸层（paradise）的自修复执行者。

下面的探针报告说某个依赖不健康了。请写一个**运行时工具**来诊断或修复它。

硬性要求：
1. 只能输出一个 JS 对象字面量，形如：
   { description: "...", parameters: { type: "object", properties: {} }, execute: async (args) => { ...; return "结果" } }
2. execute 必须是 async 函数，返回一个字符串（会被当作工具结果回传）。
3. 不要 import 任何东西。不要访问网络。不要写文件，除非诊断结论就是"必须写"。
4. 如果**无法修复**，让 execute 返回 "UNRESOLVED: <原因与建议>"。这是合法且有价值的答案。
5. 不要输出解释、不要代码围栏、不要前后缀 —— 只输出那个对象。

探针报告：
%s`

/** Build the tool name for one attempt, so a retry does not collide with the previous one. */
function repairToolName(attempt: number): string {
  return `repair-attempt-${attempt}`
}

export function createLauncher(options: LauncherOptions) {
  const now = options.now ?? (() => Date.now())
  const intervalMs = Math.max(1, Math.trunc(options.intervalMs ?? 5_000))
  const failureThreshold = Math.max(1, Math.trunc(options.failureThreshold ?? 2))
  const maxRepairAttempts = Math.max(0, Math.trunc(options.maxRepairAttempts ?? 2))

  let state: LauncherState = 'hosted'
  let failures = 0
  const transitions: LauncherEvent[] = []
  const attempts: RepairAttempt[] = []
  let gaveUpReason: string | undefined
  let lastReport = ''
  let timer: unknown
  let running = false

  const transition = (to: LauncherState, reason: string): void => {
    if (to === state) return
    const event: LauncherEvent = { at: now(), from: state, to, reason }
    state = to
    transitions.push(event)
    try {
      options.onEvent?.(event)
    } catch {
      // A throwing observer must never change the supervisor's decision.
    }
  }

  /** Run every probe; the first failure is the reason. Never throws. */
  async function probe(): Promise<{ ok: boolean; reason: string; detail: string }> {
    const reasons: string[] = []
    const details: string[] = []
    for (const entry of options.probes) {
      let answer: Awaited<ReturnType<HealthProbe['check']>>
      try {
        answer = await entry.check()
      } catch (error) {
        answer = { ok: false, reason: 'PROBE_THREW', detail: String((error as any)?.message ?? error) }
      }
      if (answer.ok) continue
      reasons.push(`${entry.name}:${answer.reason ?? 'unhealthy'}`)
      if (answer.detail !== undefined) details.push(answer.detail)
    }
    return { ok: reasons.length === 0, reason: reasons.join(' | '), detail: details.join('\n') }
  }

  /**
   * ONE REPAIR ATTEMPT: ask the model for a tool, compile it, run it.
   *
   * EVERY STEP'S FAILURE IS ITS OWN OUTCOME. "The model produced nothing", "the model produced
   * something that does not compile", and "the tool compiled but threw" are three different problems
   * with three different next actions — collapsing them into "repair failed" makes the loop blind.
   */
  async function attemptRepair(attempt: number, diagnosis: string): Promise<RepairAttempt> {
    const record: RepairAttempt = { attempt, diagnosis, defined: false, ran: false }

    /**
     * AN INJECTED STRATEGY OWNS THE WHOLE ATTEMPT.
     *
     * Checked BEFORE the `NO_LLM` bail-out, and that order matters: a caller that supplies a strategy
     * has its own way of getting a repair and must not be refused because this object happens not to
     * carry a model. A strategy is allowed to fail on its own terms, and its error is recorded as-is.
     */
    if (options.onRepair !== undefined) {
      try {
        const outcome = await options.onRepair(diagnosis, attempt)
        return {
          ...record,
          defined: outcome.defined,
          ran: outcome.ran,
          ...(outcome.toolName === undefined ? {} : { toolName: outcome.toolName }),
          ...(outcome.output === undefined ? {} : { output: outcome.output }),
          ...(outcome.error === undefined ? {} : { error: outcome.error }),
        }
      } catch (error) {
        return { ...record, error: `STRATEGY_THREW：${String((error as any)?.message ?? error)}` }
      }
    }

    if (options.llm === undefined) {
      return { ...record, error: 'NO_LLM：没有模型可用，只能检测与降级，无法自动修复' }
    }

    let answer: GenerationResult
    try {
      answer = await options.llm.generate(
        [{ role: 'user', content: REPAIR_PROMPT.replace('%s', diagnosis) }],
        { maxTokens: 4000 },
      )
    } catch (error) {
      return { ...record, error: `MODEL_THREW：${String((error as any)?.message ?? error)}` }
    }
    if (answer.error !== undefined) return { ...record, error: `MODEL_FAILED：${answer.error.message}` }

    /**
     * STRIP CODE FENCES. Models wrap JSON in ```js fences despite being told not to; treating that as a
     * failure would reject a perfectly good repair over presentation. The fence is stripped, the content
     * is kept, and nothing else is repaired on the model's behalf.
     */
    const source = extractToolSource(answer.text)
    if (source.length === 0) return { ...record, error: 'MODEL_EMPTY：模型没有输出任何内容' }

    if (options.tools === undefined) {
      return { ...record, error: 'NO_TOOL_FACTORY：没有工具工厂，无法把修复编译成可执行工具' }
    }

    const toolName = repairToolName(attempt)
    const defined = await options.tools.define({ name: toolName, source, description: `自动修复尝试 #${attempt}` })
    if (defined.ok !== true) {
      return { ...record, error: `COMPILE_FAILED：${defined.error?.message ?? 'unknown'}` }
    }
    record.toolName = toolName

    const outcome = await options.tools.execute(toolName, { diagnosis })
    if (outcome.isError) {
      return { ...record, defined: true, error: `TOOL_FAILED：${outcome.error?.message ?? 'unknown'}` }
    }

    const output = typeof outcome.value === 'string' ? outcome.value : JSON.stringify(outcome.value ?? null)
    return { ...record, defined: true, ran: true, output }
  }

  /** One supervision tick: probe, and act on the result. */
  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      const health = await probe()

      if (health.ok) {
        failures = 0
        lastReport = ''
        if (state === 'degraded') transition('hosted', '探针恢复健康')
        return
      }

      failures += 1
      lastReport = `${health.reason}\n${health.detail}`
      if (failures < failureThreshold) return

      if (state === 'hosted') transition('degraded', `${failures} 次连续失败：${health.reason}`)

      /**
       * GIVING UP IS A STATE, NOT AN EXCEPTION. Once `gave-up` is reached the supervisor STOPS trying
       * and keeps probing, so a recovery is still noticed — but it does not spend money on a third
       * identical repair.
       */
      if (attempts.length >= maxRepairAttempts) {
        if (state !== 'gave-up') {
          gaveUpReason = `${attempts.length} 次修复尝试后仍未恢复：${attempts[attempts.length - 1]?.error ?? '未知'}`
          transition('gave-up', gaveUpReason)
        }
        return
      }

      transition('repairing', `第 ${attempts.length + 1} 次修复尝试`)
      const attempt = await attemptRepair(attempts.length + 1, lastReport)
      attempts.push(attempt)

      /**
       * `UNRESOLVED` IS A MODEL SAYING "THIS NEEDS A HUMAN", and it ends the loop immediately rather
       * than consuming the remaining budget on attempts that cannot succeed.
       */
      if (attempt.output !== undefined && attempt.output.startsWith('UNRESOLVED')) {
        gaveUpReason = attempt.output
        transition('gave-up', attempt.output)
        return
      }

      // Re-probe right away: a successful repair should show up before the next interval.
      const after = await probe()
      if (after.ok) {
        failures = 0
        transition('hosted', '修复后探针恢复')
        return
      }
      transition('degraded', `修复尝试 #${attempt.attempt} 未生效：${attempt.error ?? after.reason}`)
    } finally {
      running = false
    }
  }

  return {
    /** Start supervising. Returns immediately; the loop is async. */
    start(): void {
      if (timer !== undefined) return
      const setImpl = options.setIntervalImpl ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
      timer = setImpl(() => {
        void tick()
      }, intervalMs)
      const handle = timer as unknown as { unref?: () => void }
      handle.unref?.()
    },

    /** Stop supervising. Never throws. */
    stop(): void {
      if (timer === undefined) return
      const clearImpl = options.clearIntervalImpl ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))
      clearImpl(timer)
      timer = undefined
    },

    /** Run one tick by hand. The entry point a test drives instead of waiting. */
    tick,

    /** The whole run so far, as data. */
    report(): LauncherReport {
      return {
        state,
        transitions: [...transitions],
        attempts: [...attempts],
        ...(gaveUpReason === undefined ? {} : { gaveUpReason }),
      }
    },

    getState(): LauncherState {
      return state
    },
  }
}
