/**
 * THE STANDALONE HARNESS — `src/harness.ts`.
 *
 * WHAT THIS FILE IS
 *
 * The assembly step that turns a pile of verified parts into one runnable program. It reads
 * configuration, builds the bare-metal session adapter and the model adapter, starts the dual-mode
 * supervisor, and — when the supervised thing dies — runs an emergency repair session and hands the
 * resulting script to the sandboxed tool factory.
 *
 * WHY IT IS A SEPARATE ENTRY POINT AND NOT PART OF `index.ts`
 *
 * `index.ts` is the PLUGIN: it must stay importable inside a host, where `main()` must never run on
 * import. This file is the PROGRAM: it owns `process.exitCode`, reads `process.argv`, and prints to
 * stdout. Bundling those two together would make importing the layer start a supervisor.
 *
 * THE CONFIG CONTRACT, AND WHY THERE IS NO CONFIG FILE FORMAT YET
 *
 * Configuration comes from ARGUMENTS and ENVIRONMENT VARIABLES, and from nothing else. A config file
 * would need a schema, a migration story, and a "where is it" answer — three decisions that are not
 * needed to prove the loop closes. When one is added, it lands here and nowhere else.
 *
 * WHAT IT DOES NOT DO, SAID UP FRONT
 *
 * It does not restart a real host. `--restart-cmd` is executed ONLY when the caller passes `--allow-restart`,
 * because a program that can spawn arbitrary processes from a config value is a program that will one
 * day be pointed at the wrong command.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { createLauncher } from './launcher.js'
import type { HealthProbe, LauncherEvent, RepairAttempt, RepairStrategy } from './launcher.js'
import { createEmergencyRepair, extractToolSource, isUnresolved } from './emergency-repair.js'
import { createRawLlm, createRawMessages, createRawSessionAdapter, createRawToolFactory } from './adapters/raw/index.js'
import { ensureRoot, listWithin, readWithin, writeFileEnsured } from './adapters/raw/sandbox.js'
import type { LLMAdapter, MessageAdapter, SessionAdapter, ToolFactory } from './protocol/index.js'
/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * CONFIGURATION
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

export interface HarnessConfig {
  /** Where all harness state lives: sessions, reports, sandbox roots. */
  readonly homeDir: string
  /** Directories a repair tool may touch. Always includes `homeDir`. */
  readonly sandboxRoots: readonly string[]
  /** The command whose health is being watched, when there is one. */
  readonly watchCmd?: string
  /**
   * Watch NOTHING. The escape hatch for "run the harness without a process to supervise".
   *
   * WHY IT IS AN EXPLICIT FLAG RATHER THAN THE DEFAULT: a supervisor with no probe reports `hosted`
   * forever, which is indistinguishable from a healthy system until someone reads the report. Making
   * "do nothing" something a caller must SAY is the difference between a choice and an accident.
   */
  readonly noWatch?: boolean
  /** How to bring it back. Only executed with `allowRestart`. */
  readonly restartCmd?: string
  readonly allowRestart: boolean
  readonly intervalMs: number
  readonly failureThreshold: number
  readonly maxRepairAttempts: number
  readonly toolTimeoutMs: number
  /** `llm` is absent when no key was supplied — the harness then degrades but cannot repair. */
  readonly llm?: { baseUrl: string; apiKey: string; model: string; fallbackModel?: string }
  /** Where the source under repair lives, for the brief. */
  readonly sourceDirs: readonly string[]
  /**
   * WHERE THE ROUTE CONFIG LIVES.
   *
   * Kept beside the harness home rather than in the repository root, for the same reason sessions are: a
   * harness owns its own state, and a config file that two harnesses share is a config file that one of
   * them will overwrite while the other is reading it.
   */
  readonly routeConfigPath: string
  readonly quiet: boolean
}

const DEFAULT_INTERVAL_MS = 5_000
const DEFAULT_TOOL_TIMEOUT_MS = 15_000

/** Parse `--key=value` / `--flag` arguments. Unknown keys are a REFUSAL, not ignored. */
export function parseArgs(argv: readonly string[]): { ok: true; values: Record<string, string | true> } | { ok: false; error: string } {
  const values: Record<string, string | true> = {}
  const known = new Set([
    'home',
    'sandbox-root',
    'watch-cmd',
    'restart-cmd',
    'allow-restart',
    'interval-ms',
    'failure-threshold',
    'max-repair-attempts',
    'tool-timeout-ms',
    'source-dir',
    'route-config',
    'llm-base-url',
    'llm-model',
    'llm-fallback-model',
    'quiet',
    'once',
    'no-watch',
    'help',
  ])
  for (const raw of argv) {
    if (!raw.startsWith('--')) return { ok: false, error: `无法识别的参数：${raw}（所有参数必须以 -- 开头）` }
    const body = raw.slice(2)
    const eq = body.indexOf('=')
    const key = eq < 0 ? body : body.slice(0, eq)
    const value = eq < 0 ? true : body.slice(eq + 1)
    if (!known.has(key)) return { ok: false, error: `未知参数 --${key}。已知：${[...known].sort().join(', ')}` }
    values[key] = value
  }
  return { ok: true, values }
}

/** Turn parsed arguments + environment into a config, defaulting every absence explicitly. */
export function resolveConfig(values: Record<string, string | true>, env: Record<string, string | undefined>, cwd: string): HarnessConfig {
  const str = (key: string): string | undefined => (typeof values[key] === 'string' ? (values[key] as string) : undefined)
  const num = (key: string, fallback: number): number => {
    const raw = str(key)
    if (raw === undefined) return fallback
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback
  }

  const homeDir = resolve(str('home') ?? join(cwd, '.paradise-harness'))
  /**
   * THE SANDBOX ROOT ALWAYS INCLUDES THE HARNESS HOME, and that is not a convenience: a repair that
   * cannot write its own report is a repair nobody can audit. Caller-supplied roots are ADDED.
   */
  const extraRoots = str('sandbox-root') !== undefined ? [resolve(str('sandbox-root') as string)] : []
  const homeRoots = Array.isArray((values['sandbox-root'] as unknown) as string[]) ? [] : []

  const apiKey = env.LLM_API_KEY ?? env.DEEPSEEK_API_KEY ?? env.OPENAI_API_KEY ?? env.DASHSCOPE_API_KEY
  const model = str('llm-model') ?? env.LLM_MODEL
  const baseUrl = str('llm-base-url') ?? env.LLM_BASE_URL

  return {
    homeDir,
    sandboxRoots: [...new Set([homeDir, ...extraRoots, ...homeRoots])],
    ...(str('watch-cmd') === undefined ? {} : { watchCmd: str('watch-cmd') as string }),
    noWatch: values['no-watch'] === true,
    ...(str('restart-cmd') === undefined ? {} : { restartCmd: str('restart-cmd') as string }),
    allowRestart: values['allow-restart'] === true,
    intervalMs: num('interval-ms', DEFAULT_INTERVAL_MS),
    failureThreshold: num('failure-threshold', 2),
    maxRepairAttempts: num('max-repair-attempts', 2),
    toolTimeoutMs: num('tool-timeout-ms', DEFAULT_TOOL_TIMEOUT_MS),
    ...(apiKey === undefined || model === undefined || baseUrl === undefined
      ? {}
      : {
          llm: {
            baseUrl,
            apiKey,
            model,
            ...(str('llm-fallback-model') === undefined && env.LLM_FALLBACK_MODEL === undefined
              ? {}
              : { fallbackModel: str('llm-fallback-model') ?? (env.LLM_FALLBACK_MODEL as string) }),
          },
        }),
    sourceDirs: str('source-dir') === undefined ? [] : [resolve(str('source-dir') as string)],
    routeConfigPath: str('route-config') === undefined ? join(homeDir, 'config.json') : resolve(str('route-config') as string),
    quiet: values.quiet === true,
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * THE PROBE — is the watched command alive?
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * A PROCESS-EXISTENCE PROBE.
 *
 * `process.kill(pid, 0)` is the only portable "is it alive" check on Node: it sends signal 0, which
 * performs the permission and existence checks without delivering anything. `EPERM` means alive but
 * not ours — which is ALIVE, and treating it as dead is how a supervisor kills a healthy process.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as any)?.code === 'EPERM'
  }
}

/** A probe over a pid file, so the harness can watch something it did not spawn. */
export function createPidFileProbe(name: string, pidFile: string): HealthProbe {
  return {
    name,
    async check() {
      if (!existsSync(pidFile)) {
        return { ok: false, reason: 'PID_FILE_MISSING', detail: `找不到 pid 文件：${pidFile}` }
      }
      const text = readFileSync(pidFile, 'utf8').trim()
      const pid = Number(text)
      if (!Number.isFinite(pid) || pid <= 0) {
        return { ok: false, reason: 'PID_UNREADABLE', detail: `pid 文件内容不是数字：${text.slice(0, 40)}` }
      }
      if (!isProcessAlive(pid)) {
        return { ok: false, reason: 'PROCESS_DEAD', detail: `pid ${pid} 已不存在` }
      }
      return { ok: true }
    },
  }
}

/** A probe that treats "everything fine" as the answer. Used when nothing is watched. */
export function createAlwaysHealthyProbe(): HealthProbe {
  return { name: 'noop', async check() { return { ok: true } } }
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * THE ASSEMBLY
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

export interface HarnessResult {
  readonly ok: boolean
  readonly state: string
  readonly transitions: readonly LauncherEvent[]
  readonly attempts: readonly RepairAttempt[]
  readonly reportPath?: string
  readonly error?: string
}

/** Everything the harness wired, exposed so a test can assert on it without re-deriving it. */
export interface HarnessRuntime {
  readonly config: HarnessConfig
  readonly session: SessionAdapter | undefined
  readonly llm: LLMAdapter | undefined
  readonly messages: MessageAdapter
  readonly tools: ToolFactory
  readonly launcher: ReturnType<typeof createLauncher>
  runOnce(): Promise<HarnessResult>
  report(): HarnessResult
  stop(): void
}

/**
 * BUILD THE RUNTIME.
 *
 * Separated from `main` so a test can drive one tick without spawning a process — the same reason
 * `createLauncher` separates `tick` from `start`.
 */
export function createHarness(config: HarnessConfig): HarnessRuntime {
  const sessionsDir = ensureRoot(join(config.homeDir, 'sessions'))
  const reportsDir = ensureRoot(join(config.homeDir, 'reports'))
  const log = (message: string): void => {
    if (config.quiet) return
    process.stdout.write(`[harness] ${message}\n`)
  }

  /**
   * THE SANDBOX IS THE DEFAULT FOR ANY TOOL A MODEL WRITES.
   *
   * `sandboxRoots` is always non-empty (it includes `homeDir`), so `isolation` reports `'process'` and
   * every repair runs in a worker with a restricted API. The in-process path still exists for tests and
   * for a caller that explicitly wants it — it is simply not the one a repair takes.
   */
  const tools = createRawToolFactory({
    sandboxRoots: config.sandboxRoots,
    timeoutMs: config.toolTimeoutMs,
  })

  const llm =
    config.llm === undefined
      ? undefined
      : createRawLlm({
          baseUrl: config.llm.baseUrl,
          apiKey: config.llm.apiKey,
          model: config.llm.model,
          ...(config.llm.fallbackModel === undefined ? {} : { fallbackModel: config.llm.fallbackModel }),
          /**
           * ROUTE HIJACKING IS ON BY DEFAULT, because the alternative is a harness that dies when a
           * budget runs out — and running out of budget is a NORMAL event, not an exceptional one.
           *
           * The loader is a FUNCTION, not a value: it re-reads the environment and the config file on
           * every attempt to hijack. That is what lets a repair tool rewrite `config.json` and have the
           * NEXT call pick it up without a restart.
           */
          loadFallbackRoute: () => resolveFallbackRoute(config.routeConfigPath),
          onRouteHijacked: (event) => {
            log(`路由已切换：${event.from} → ${event.to}（HTTP ${event.status}）`)
          },
        })

  const messages = createRawMessages({})

  /**
   * THE REPAIR SESSION'S EXECUTOR.
   *
   * The session adapter is created with an `onTrigger` that does NOTHING here on purpose: the actual
   * model call happens in the launcher's repair step, where the result is compiled and run. Wiring the
   * model into `onTrigger` as well would call it twice per repair.
   */
  /**
   * THE EXECUTOR BEHIND `trigger`.
   *
   * An adapter that reports `capabilities.trigger === true` must actually be able to start something.
   * Here, "starting" means: hand the session's own material (its `developer/message` setup and its
   * `user/message` brief) to the model, and record the answer back into the session.
   *
   * WHY IT LIVES HERE AND NOT IN THE ADAPTER: the adapter must be usable with NO model at all (a session
   * store is a session store). The model is the harness's business, so the harness supplies the closure —
   * and when it cannot, the adapter honestly reports `trigger: false` through its capability probe.
   */
  const executeSession = async (ref: { id: string; cwd: string }): Promise<void> => {
    if (llm === undefined) return
    const reading = await session.readLog(ref)
    const conversation = reading.events
      .filter((event) => event.type === 'developer/message' || event.type === 'user/message')
      .map((event) => ({
        role: event.type === 'developer/message' ? ('system' as const) : ('user' as const),
        content: String((event.data as any)?.text ?? ''),
      }))
    if (conversation.length === 0) return
    const answer = await llm.generate(conversation, { maxTokens: 4000 })
    if (answer.text.length === 0) return
    await session.inject(ref, [
      { visibility: 'visible', text: answer.text, origin: 'plugin:paradise:session-answer' },
    ])
  }

  const session = createRawSessionAdapter({
    dir: sessionsDir,
    onTrigger: async (ref) => {
      await executeSession(ref)
    },
  })

  const emergency = llm === undefined
    ? undefined
    : createEmergencyRepair({
        session,
        llm,
        messages,
        tools,
        cwd: process.cwd(),
      })

  /** Assemble the brief from what is on disk, refusing anything outside the roots. */
  function buildBrief(failure: string): { failure: string; stack?: string; sources: Array<{ path: string; content: string }> } {
    const sources: Array<{ path: string; content: string }> = []
    for (const dir of config.sourceDirs) {
      for (const name of listWithin(dir, config.sandboxRoots)) {
        if (!name.endsWith('.ts') && !name.endsWith('.js') && !name.endsWith('.mjs')) continue
        const path = join(dir, name)
        try {
          sources.push({ path, content: readWithin(path, config.sandboxRoots, 20_000) })
        } catch {
          /** A file outside the roots is skipped, not smuggled in through the brief. */
        }
        if (sources.length >= 6) break
      }
      if (sources.length >= 6) break
    }

    /** The stack, when the failing thing left one where we can find it. */
    const stackPath = join(config.homeDir, 'crash.log')
    const stack = existsSync(stackPath) ? (() => {
      try {
        return readWithin(stackPath, config.sandboxRoots, 20_000)
      } catch {
        return ''
      }
    })() : ''
    return { failure, ...(stack.length === 0 ? {} : { stack }), sources }
  }

  /**
   * THE REPAIR, WIRED AS THE LAUNCHER'S EXECUTOR.
   *
   * The launcher asks "give me something to run"; this answers by running a SESSION and compiling what
   * the model produced. That division is what lets a caller swap in a different repair strategy without
   * touching the supervisor.
   */
  const repair: RepairStrategy = async (diagnosis, attempt) => {
    if (emergency === undefined) return { error: 'NO_LLM：没有模型可用，只能检测与降级', ran: false, defined: false }

    const brief = buildBrief(diagnosis)
    log(`维修会话 #${attempt}：${brief.sources.length} 个源文件、堆栈 ${brief.stack === undefined ? '缺失' : `${brief.stack.length} 字符`}`)
    const sessionResult = await emergency.run({
      ...brief,
      extraInstruction: `这是第 ${attempt} 次尝试。如果前一次失败，请换一个思路，而不是重写同一段代码。`,
    })
    if (sessionResult.ok !== true) {
      return { error: `维修会话失败：${sessionResult.error ?? 'unknown'}`, ran: false, defined: false }
    }
    if (isUnresolved(sessionResult.text)) {
      return { output: `UNRESOLVED: ${sessionResult.text.slice(0, 400)}`, ran: false, defined: false }
    }

    const source = extractToolSource(sessionResult.text)
    const toolName = `repair-attempt-${attempt}`
    const defined = await tools.define({ name: toolName, source, description: `紧急维修尝试 #${attempt}` })
    if (defined.ok !== true) {
      return { error: `COMPILE_FAILED：${defined.error?.message ?? 'unknown'}`, ran: false, defined: false }
    }
    const outcome = await tools.execute(toolName, { diagnosis })
    if (outcome.isError) {
      return { error: `TOOL_FAILED：${outcome.error?.message ?? 'unknown'}`, ran: false, defined: true, toolName }
    }
    const output = typeof outcome.value === 'string' ? outcome.value : JSON.stringify(outcome.value ?? null)
    return { output, ran: true, defined: true, toolName }
  }

  /**
   * THE PROBE — AND THE BUG THIS LINE USED TO HAVE.
   *
   * It used to be `config.watchCmd !== undefined ? pidProbe : alwaysHealthy`. That read the flag as
   * "should I watch a process at all", which is wrong in both directions:
   *
   *   - `--watch-cmd` names a pid FILE, and omitting it means "use the default one" — not "watch
   *     nothing";
   *   - with no flag the supervisor probed `alwaysHealthy`, so a dead host reported `hosted` and the
   *     entire self-rescue path was unreachable. Measured on the CLI: a pid file pointing at a dead
   *     process produced `状态 hosted / 修复尝试 0`, exit 0.
   *
   * A SUPERVISOR THAT CANNOT FAIL IS NOT SUPERVISING. The default is now the pid-file probe, and
   * "watch nothing" requires saying so: `--no-watch`.
   */
  const pidFile = config.watchCmd ?? join(config.homeDir, 'host.pid')
  const probe: HealthProbe = config.noWatch === true
    ? createAlwaysHealthyProbe()
    : createPidFileProbe('watched-process', pidFile)

  /**
   * THE LAUNCHER OWNS THE STATE MACHINE; this file supplies the executor and the restart.
   *
   * `onRepair` is passed through a small adapter onto the launcher's `llm`/`tools` pair, because the
   * launcher's contract is deliberately narrow (a model and a factory). The extra behaviour — building
   * a brief from disk, running a session — lives HERE, where the filesystem is allowed to be known.
   */
  const launcher = createLauncher({
    probes: [probe],
    intervalMs: config.intervalMs,
    failureThreshold: config.failureThreshold,
    maxRepairAttempts: config.maxRepairAttempts,
    onEvent: (event) => {
      log(`${event.from} → ${event.to}：${event.reason}`)
    },
    /**
     * THE STRATEGY IS THIS FILE'S, NOT THE LAUNCHER'S.
     *
     * The launcher knows WHEN to repair; this knows HOW, because building a brief means reading the
     * filesystem and opening a session — knowledge the supervisor deliberately does not have (it must
     * stay importable on a machine where none of that exists).
     */
    onRepair: repair,
  })

  /** Restart, gated by `allowRestart`, and REPORTED either way. */
  async function restart(): Promise<{ ok: boolean; detail: string }> {
    if (config.restartCmd === undefined) return { ok: false, detail: '没有提供 --restart-cmd' }
    if (!config.allowRestart) {
      /**
       * A PROGRAM THAT SPAWNS ARBITRARY COMMANDS FROM CONFIG IS A PROGRAM THAT WILL ONE DAY BE POINTED
       * AT THE WRONG COMMAND. The gate is explicit, and saying "I would have but was not allowed" is
       * more useful than silently doing nothing.
       */
      return { ok: false, detail: '拒绝重启：需要显式 --allow-restart。' + `（命令：${config.restartCmd}）` }
    }
    return await new Promise((done) => {
      try {
        const child = spawn(config.restartCmd as string, { shell: true, detached: true, stdio: 'ignore' })
        child.on('error', (error) => done({ ok: false, detail: String(error?.message ?? error) }))
        child.on('spawn', () => {
          if (typeof child.pid === 'number') {
            writeFileSync(join(config.homeDir, 'host.pid'), String(child.pid), 'utf8')
          }
          child.unref()
          done({ ok: true, detail: `已重启：pid ${child.pid ?? 'unknown'}` })
        })
      } catch (error) {
        done({ ok: false, detail: String((error as any)?.message ?? error) })
      }
    })
  }

  const transitions: LauncherEvent[] = []
  const attempts: RepairAttempt[] = []

  function report(): HarnessResult {
    const state = launcher.report()
    const reportPath = join(reportsDir, `harness-${Date.now().toString(36)}.json`)
    try {
      writeFileEnsured(
        reportPath,
        JSON.stringify(
          {
            at: new Date().toISOString(),
            host: hostname(),
            config: {
              homeDir: config.homeDir,
              sandboxRoots: config.sandboxRoots,
              allowRestart: config.allowRestart,
              hasLlm: config.llm !== undefined,
            },
            state: state.state,
            transitions: state.transitions,
            attempts: state.attempts,
          },
          null,
          2,
        ),
      )
    } catch {
      /** A report that cannot be written must not fail the run it describes. */
    }
    return {
      ok: state.state === 'hosted',
      state: state.state,
      transitions: state.transitions,
      attempts: state.attempts,
      reportPath,
      ...(state.gaveUpReason === undefined ? {} : { error: state.gaveUpReason }),
    }
  }

  return {
    config,
    session,
    llm,
    messages,
    tools,
    launcher,
    /**
     * ONE FULL SUPERVISION PASS, DRIVEN BY HAND.
     *
     * This is what the end-to-end test calls: probe → (degrade → repair → restart)? → report. It is the
     * same sequence `start()` runs on a timer, exposed so the loop can be proven without waiting.
     */
    async runOnce(): Promise<HarnessResult> {
      await launcher.tick()
      const state = launcher.report()

      /**
       * THE SELF-RESCUE CLOSURE, assembled here because it spans three owners: the launcher decides
       * the state, the repair session produces an attempt, and the restart brings the host back.
       */
      if (state.state === 'repairing' || state.state === 'degraded' || (state.state === 'hosted' && state.attempts.length > 0)) {
        const last = state.attempts[state.attempts.length - 1]
        const repaired = last !== undefined && last.ran === true && (last.output ?? '').startsWith('UNRESOLVED') === false
        if (repaired) {
          const restarted = await restart()
          log(`修复脚本已执行 → 重启：${restarted.ok ? restarted.detail : restarted.detail}`)
          if (restarted.ok) {
            /** One more probe, so "restarted" is measured rather than assumed. */
            await launcher.tick()
          }
        }
      }

      return report()
    },
    report,
    stop(): void {
      launcher.stop()
    },
  }
}

/**
 * RE-EXPORTED SO THE CLI BUNDLE IS SELF-CONTAINED.
 *
 * A test that wants to drive a repair session without going through the supervisor must import it from
 * THE SAME BUNDLE the CLI ships — otherwise the thing under test is `src/index.js`'s copy and the
 * shipped artifact is never exercised. The two are built from one source, so this cannot drift.
 *
 * WRITTEN AS IMPORT + BARE EXPORT, NOT `export … from`. The bundler inlines modules into one scope and
 * refuses a surviving relative specifier — `export … from` is exactly that, and the guard caught it:
 *
 *     Error: dist/harness.js would ship an unresolved relative import (line 3779)
 *
 * That guard is the reason this file ships at all.
 */
import {
  EMERGENCY_SETUP,
  createEmergencyRepair,
  extractToolSource,
  isUnresolved,
} from './emergency-repair.js'
import { createRawSessionAdapter } from './adapters/raw/session.js'
import { SANDBOX_CAPABILITIES, isWithinRoots, listWithin, readWithin } from './adapters/raw/sandbox.js'

export {
  EMERGENCY_SETUP,
  REPAIR_PROMPT,
  SANDBOX_CAPABILITIES,
  createEmergencyRepair,
  createLauncher,
  createRawLlm,
  createRawMessages,
  createRawSessionAdapter,
  createRawToolFactory,
  extractToolSource,
  isUnresolved,
  isWithinRoots,
  listWithin,
  readWithin,
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * THE CLI
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

export const USAGE = `dsh-paradise 独立 Harness

用法：
  node dist/harness.js [选项]

选项：
  --home=<dir>               状态目录（会话、报告、pid）。默认 ./.paradise-harness
  --sandbox-root=<dir>       允许维修工具读写的额外目录（可重复）
  --source-dir=<dir>         出问题时要放进维修简报的源码目录（可重复）
  --route-config=<file>      路由配置（base_url / fallback），默认 <home>/config.json
  --watch-cmd=<file>         监视哪个 pid 文件（默认 <home>/host.pid）
  --no-watch                 完全不监视（默认会看 <home>/host.pid，缺了它不算"健康"）
  --restart-cmd=<cmd>        修复成功后用来拉起宿主的命令
  --allow-restart            允许真的执行 --restart-cmd（没有它只会报告"我没有重启"）
  --interval-ms=<n>          轮询间隔，默认 5000
  --failure-threshold=<n>    连续失败几次才降级，默认 2
  --max-repair-attempts=<n>  最多修几次，默认 2
  --tool-timeout-ms=<n>      单个工具预算，默认 15000
  --llm-base-url=<url>       模型端点（OpenAI 兼容），也可用 LLM_BASE_URL
  --llm-model=<name>         模型名，也可用 LLM_MODEL
  --llm-fallback-model=<n>   首选失败时的备用模型
  --once                     只跑一轮就退出（用于验收与 CI）
  --quiet                    不打印过程
  --help                     显示本帮助

环境变量：
  LLM_BASE_URL / LLM_MODEL / LLM_API_KEY（或 DEEPSEEK_API_KEY / OPENAI_API_KEY / DASHSCOPE_API_KEY）
`

/**
 * THE PROCESS ENTRY.
 *
 * Returns an exit code instead of calling `process.exit`, so a test can invoke it and a shell script
 * can compose it. `main` is the only place allowed to touch argv, env, and stdout.
 */
export async function main(argv: readonly string[] = process.argv.slice(2), env: Record<string, string | undefined> = process.env): Promise<number> {
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}`)
    return 2
  }
  if (parsed.values.help === true) {
    process.stdout.write(USAGE)
    return 0
  }

  const config = resolveConfig(parsed.values, env, process.cwd())
  mkdirSync(config.homeDir, { recursive: true })

  process.stdout.write(
    `[harness] 启动\n` +
      `  状态目录   ${config.homeDir}\n` +
      `  沙箱白名单 ${config.sandboxRoots.join(', ')}\n` +
      `  模型       ${config.llm === undefined ? '（未配置：只能检测与降级，无法自动修复）' : `${config.llm.model} @ ${config.llm.baseUrl}`}\n` +
      `  监视       ${config.watchCmd ?? `（无：默认看 ${join(config.homeDir, 'host.pid')}）`}\n` +
      `  重启       ${config.restartCmd === undefined ? '（未配置）' : config.allowRestart ? config.restartCmd : `${config.restartCmd}（需要 --allow-restart）`}\n`,
  )

  const runtime = createHarness(config)

  if (parsed.values.once === true) {
    const result = await runtime.runOnce()
    process.stdout.write(
      `\n[harness] 单轮结束\n` +
        `  状态     ${result.state}\n` +
        `  迁移     ${result.transitions.map((t) => `${t.from}→${t.to}`).join(', ') || '（无）'}\n` +
        `  修复尝试 ${result.attempts.length}\n` +
        `  报告     ${result.reportPath ?? '（未写出）'}\n` +
        `${result.error === undefined ? '' : `  原因     ${result.error}\n`}`,
    )
    runtime.stop()
    return result.ok ? 0 : 1
  }

  runtime.launcher.start()
  /**
   * A SUPERVISOR MUST NOT EXIT ON ITS OWN. The timer is unref'd, so the process would end immediately
   * without this keep-alive — and a supervisor that exits is not supervising.
   */
  await new Promise<void>((resolveForever) => {
    const stop = (): void => {
      runtime.stop()
      resolveForever()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  return 0
}
