/**
 * REPAIR SESSION — a maintenance conversation that needs no host to exist.
 *
 * THE PROBLEM THIS SOLVES, IN THE USER'S OWN TERMS
 *
 * "如果 DSH 挂了，系统能靠 API 接管并自我修复。但这个'维修会话'的载体如果还是 DSH，那就是假自举。"
 *
 * That is the right critique, and it invalidated the earlier claim. A supervisor that lives
 * inside the thing it supervises is not a supervisor: when the host dies, the repair dies with
 * it. This module is the repair conversation built out of `runAgentTurn` plus REAL tools —
 * read the log, edit the file, run the command, start the process — with nothing from DSH
 * imported. It runs from a terminal.
 *
 * WHAT THE TOOLS ARE ALLOWED TO DO
 *
 * Every path must resolve inside `workspace`. This is the same allowlist contract
 * `adapters/raw/sandbox.ts` uses and for the same reason: the realistic failure is not an
 * attacker, it is a model writing a plausible repair that edits the wrong file. A repair that
 * can touch anything is a repair nobody can let run unattended.
 *
 * `dryRun` is a first-class mode: the model sees every tool's real output, and only the writes
 * and commands are withheld. That is how a repair can be reviewed before it is trusted.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { createMemoryMessages, runAgentTurn } from './agent-loop.js'
import type { AgentTool, AgentTurnResult } from './agent-loop.js'
import type { LLMAdapter, MessageAdapter } from './protocol/index.js'

export interface RepairSessionOptions {
  /** The only directory the session may write into. */
  readonly workspace: string
  /** Crash log to read. Missing file is reported, not fatal. */
  readonly logPath: string
  /** The model. Any adapter; a scripted one is legitimate for a rehearsal. */
  readonly llm: LLMAdapter
  /** Conversation store. Defaults to a fresh in-memory one per session. */
  readonly messages?: MessageAdapter
  /** Do not write files or run commands; still run the read-only tools. */
  readonly dryRun?: boolean
  /** Allow `run_command` at all. Off by default: a repair that can run anything is unattended risk. */
  readonly allowCommands?: boolean
  /** How the host is restarted when the model asks. Omit to disable restarting. */
  readonly restart?: {
    /** Command to run, already split (no shell). */
    readonly command: readonly string[]
    readonly cwd?: string
  }
  readonly maxRounds?: number
  readonly onEvent?: (event: RepairSessionEvent) => void
}

export type RepairSessionEvent =
  | { readonly type: 'session-start'; readonly workspace: string; readonly logPath: string; readonly dryRun: boolean }
  | { readonly type: 'log-read'; readonly bytes: number }
  | { readonly type: 'round'; readonly round: number }
  | { readonly type: 'tool-call'; readonly name: string; readonly arguments: Record<string, unknown> }
  | { readonly type: 'tool-result'; readonly name: string; readonly ok: boolean; readonly ms: number; readonly error?: string }
  | { readonly type: 'file-written'; readonly path: string }
  | { readonly type: 'command-run'; readonly command: string; readonly code: number }
  | { readonly type: 'restart-requested'; readonly command: readonly string[] }
  | { readonly type: 'restarted'; readonly pid: number }
  | { readonly type: 'answer'; readonly text: string }

export interface RepairSessionResult {
  readonly turn: AgentTurnResult
  /** Every file the session actually wrote, relative to the workspace, with `/` separators. */
  readonly written: readonly string[]
  /** Commands that actually ran, with their exit codes. */
  readonly commands: ReadonlyArray<{ readonly command: string; readonly code: number; readonly output: string }>
  /** PID of the restarted host, when the model asked for one and it was allowed. */
  readonly restartedPid?: number
  /** True when a write or command was withheld because of `dryRun` or a disabled capability. */
  readonly withheld: readonly string[]
}

/** The system prompt. Stated as rules, because a repair session is a procedure. */
const SYSTEM_PROMPT = `你是一个在裸机上运行的维修会话。宿主的进程已经崩溃或异常，你是唯一还能行动的实体。

你的工作流程：
1. 用 read_file 读取崩溃日志（通常在 logPath），找出真正的错误。
2. 用 read_file 读相关源码，定位缺陷。
3. 用 write_file 写出修复（只改必要的最小范围）。
4. 如果需要验证，用 run_command 运行测试。
5. 修复可信之后，用 restart_host 重启宿主。

规则：
- 只修改 workspace 内的文件。
- 一次只改一处，改完再验证。
- 不确定时，先读再写，宁可少改。
- 完成后用一句话说明你改了什么、为什么。`

/**
 * Run one repair conversation to completion.
 *
 * The log is READ BEFORE the model is called, and its size is reported. A model asked to fix a
 * crash without the crash text invents a cause; the log is the evidence, so it is the first
 * thing in the prompt rather than something the model has to remember to ask for.
 */
export async function runRepairSession(options: RepairSessionOptions): Promise<RepairSessionResult> {
  const workspace = resolve(options.workspace)
  const emit = options.onEvent ?? (() => {})
  const dryRun = options.dryRun === true
  const written: string[] = []
  const commands: Array<{ command: string; code: number; output: string }> = []
  const withheld: string[] = []
  let restartedPid: number | undefined

  emit({ type: 'session-start', workspace, logPath: options.logPath, dryRun })

  /** Resolve a model-supplied path inside the workspace, or refuse. */
  const inside = (target: string): string => {
    const absolute = resolve(workspace, target)
    if (absolute !== workspace && !absolute.startsWith(`${workspace}${sep}`)) {
      throw new Error(`SANDBOX_DENIED: ${target} 不在 workspace 内（允许 ${workspace}）`)
    }
    return absolute
  }

  /**
   * Paths are reported with `/`, not the platform separator.
   *
   * These strings end up in a transcript and in `RepairSessionResult.written`, which callers
   * compare and persist. A Windows-only `config\host.json` and a POSIX `config/host.json`
   * would make the same repair look different depending on where it ran.
   */
  const reportPath = (absolute: string): string => relative(workspace, absolute).split(sep).join('/')

  const tools = new Map<string, AgentTool>()
  tools.set('read_file', {
    name: 'read_file',
    description: '读取 workspace 内的一个文件。用于看崩溃日志和源码。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对 workspace 的路径' }, maxBytes: { type: 'number' } },
      required: ['path'],
    },
    async execute(args) {
      const path = inside(String(args.path ?? ''))
      const limit = Number(args.maxBytes ?? 200_000)
      if (!existsSync(path)) return `文件不存在：${args.path}`
      const stat = statSync(path)
      if (stat.isDirectory()) return `这是一个目录：${args.path}`
      const text = readFileSync(path, 'utf8')
      return text.length > limit ? `${text.slice(0, limit)}\n…（已截断，共 ${text.length} 字符）` : text
    },
  })

  tools.set('write_file', {
    name: 'write_file',
    description: '覆盖写入 workspace 内的一个文件。这是真正落盘的修复。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    async execute(args) {
      const path = inside(String(args.path ?? ''))
      const content = String(args.content ?? '')
      if (dryRun) {
        withheld.push(`write_file ${args.path}`)
        return `[dry-run] 已跳过写入 ${args.path}（${content.length} 字符）`
      }
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content, 'utf8')
      written.push(reportPath(path))
      emit({ type: 'file-written', path: reportPath(path) })
      return `已写入 ${args.path}（${content.length} 字符）`
    },
  })

  tools.set('append_file', {
    name: 'append_file',
    description: '向 workspace 内的文件追加内容（用于写修复记录）。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    async execute(args) {
      const path = inside(String(args.path ?? ''))
      const content = String(args.content ?? '')
      if (dryRun) {
        withheld.push(`append_file ${args.path}`)
        return `[dry-run] 已跳过追加 ${args.path}`
      }
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, content, 'utf8')
      written.push(reportPath(path))
      return `已追加到 ${args.path}`
    },
  })

  tools.set('run_command', {
    name: 'run_command',
    description: '在 workspace 内运行一个命令（无 shell，参数分开传）。用于跑测试验证修复。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '可执行文件，如 node' },
        args: { type: 'array', items: { type: 'string' } },
      },
      required: ['command'],
    },
    async execute(args) {
      if (options.allowCommands !== true) {
        withheld.push(`run_command ${args.command}`)
        return '命令执行未启用（allowCommands: false）。请只做文件修改，或让操作者重启。'
      }
      if (dryRun) {
        withheld.push(`run_command ${args.command}`)
        return `[dry-run] 已跳过命令 ${args.command}`
      }
      const command = String(args.command ?? '')
      const rest = Array.isArray(args.args) ? args.args.map(String) : []
      const result = await execOnce(command, rest, workspace, 60_000)
      commands.push({ command: [command, ...rest].join(' '), code: result.code, output: result.output })
      emit({ type: 'command-run', command: [command, ...rest].join(' '), code: result.code })
      return `exit ${result.code}\n${result.output.slice(0, 20_000)}`
    },
  })

  tools.set('restart_host', {
    name: 'restart_host',
    description: '重启宿主进程。只有修复可信之后才调用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      if (options.restart === undefined) {
        withheld.push('restart_host')
        return '重启未配置（restart 选项缺失）。修复已写入，请手动重启。'
      }
      if (dryRun) {
        withheld.push('restart_host')
        return `[dry-run] 已跳过重启：${options.restart.command.join(' ')}`
      }
      emit({ type: 'restart-requested', command: options.restart.command })
      const [command, ...rest] = options.restart.command
      const child = spawn(command, rest, { cwd: options.restart.cwd ?? workspace, detached: true, stdio: 'ignore' })
      child.unref()
      restartedPid = child.pid ?? -1
      emit({ type: 'restarted', pid: restartedPid })
      return `宿主已重启，pid ${restartedPid}`
    },
  })

  /**
   * THE LOG GOES IN FIRST.
   *
   * A model asked to "fix the crash" without the crash text invents a cause. Reading it here,
   * outside the loop, makes the evidence part of the prompt instead of something the model has
   * to remember to ask for — and it is the one input a repair session cannot do without.
   */
  let logText = ''
  try {
    const logPath = inside(options.logPath)
    logText = readFileSync(logPath, 'utf8')
    emit({ type: 'log-read', bytes: logText.length })
  } catch (error) {
    logText = `（无法读取崩溃日志：${String((error as { message?: unknown })?.message ?? error)}）`
  }

  const input = [
    `宿主崩溃了。崩溃日志（${options.logPath}）：`,
    '```',
    logText.slice(-40_000),
    '```',
    '',
    `workspace: ${workspace}`,
    `dry-run: ${dryRun ? '是（只读，不写文件、不跑命令）' : '否'}`,
    '',
    '请按流程诊断并修复。',
  ].join('\n')

  const turn = await runAgentTurn(input, {
    llm: options.llm,
    messages: options.messages ?? createMemoryMessages(),
    tools,
    system: SYSTEM_PROMPT,
    maxRounds: options.maxRounds ?? 10,
    onEvent: (event) => {
      if (event.type === 'round') emit({ type: 'round', round: event.round })
      if (event.type === 'tool-call') emit({ type: 'tool-call', name: event.name, arguments: event.arguments })
      if (event.type === 'tool-result') {
        emit({
          type: 'tool-result',
          name: event.name,
          ok: event.ok,
          ms: event.ms,
          ...(event.error === undefined ? {} : { error: event.error }),
        })
      }
      if (event.type === 'answer') emit({ type: 'answer', text: event.text })
    },
  })

  return { turn, written, commands, ...(restartedPid === undefined ? {} : { restartedPid }), withheld }
}

/** Run one command to completion and capture its output. No shell interpolation. */
function execOnce(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      output += String(chunk)
    })
    const timer = setTimeout(() => {
      child.kill()
      output += `\n（超时 ${timeoutMs}ms，已终止）`
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ code: -1, output: `无法启动：${String(error.message)}` })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolvePromise({ code: code ?? -1, output })
    })
  })
}

/**
 * The tools a repair session offers, for inspection and for tests.
 *
 * Exported so a caller can assert the allowlist without running a model — the capability
 * boundary is the thing that must be auditable, not just the conversation.
 */
export const REPAIR_TOOL_NAMES = Object.freeze(['read_file', 'write_file', 'append_file', 'run_command', 'restart_host'])

/** Resolve a path inside a workspace, or throw. Shared with tests. */
export function resolveInside(workspace: string, target: string): string {
  const root = resolve(workspace)
  const absolute = resolve(root, target)
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    throw new Error(`SANDBOX_DENIED: ${target} 不在 workspace 内`)
  }
  return absolute
}

/** Join path segments the way the module expects (re-exported so callers avoid a path import). */
export const joinPath = join
