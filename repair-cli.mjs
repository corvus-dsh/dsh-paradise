#!/usr/bin/env node
/**
 * REPAIR CLI — the repair session, from a terminal, with no host.
 *
 * WHAT THIS IS FOR
 *
 * "如果 DSH 彻底坏了，彼岸层靠自己在终端里就能把 DSH 救活。"
 *
 * This is that terminal entry point. It reads a crash log, asks a model to diagnose it, lets
 * the model edit files and run commands inside the workspace, and can restart the host. It
 * imports `dsh-paradise/index.js` and nothing else from DSH.
 *
 * MODES
 *
 *   --dry-run        read-only: every tool runs except writes, commands and restarts
 *   --rehearse       use a SCRIPTED model instead of a provider (proves the machinery works
 *                    with no credential; says so in its output rather than pretending)
 *   --allow-commands let the model run commands
 *   --restart <cmd>  allow restarting the host with this command
 *
 * REAL PROVIDER
 *
 *   DSH_REPAIR_BASE_URL, DSH_REPAIR_API_KEY, DSH_REPAIR_MODEL
 *
 * Absent those, the CLI refuses to pretend: it exits with an explanation instead of running a
 * fake diagnosis.
 *
 * Usage:
 *   node repair-cli.mjs --log crash.log --workspace ./repo --dry-run
 *   node repair-cli.mjs --log crash.log --workspace ./repo --rehearse
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
/**
 * `pathToFileURL`, NOT a raw join: on Windows an absolute path handed to `import()` is read as
 * a URL with scheme `d:` and Node refuses it. This is the same trap every Windows ESM script
 * hits once.
 */
const layer = await import(pathToFileURL(join(here, 'index.js')).href)

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  if (at === -1) return fallback
  const next = args[at + 1]
  return next === undefined || next.startsWith('--') ? true : next
}

const workspace = resolve(String(flag('workspace', process.cwd())))
const logPath = String(flag('log', 'crash.log'))
const dryRun = flag('dry-run', false) === true
const rehearse = flag('rehearse', false) === true
const allowCommands = flag('allow-commands', false) === true
const restartSpec = flag('restart', undefined)
const maxRounds = Number(flag('max-rounds', 10))

const say = (line = '') => console.log(line)
const dim = (text) => `\x1b[2m${text}\x1b[0m`
const bold = (text) => `\x1b[1m${text}\x1b[0m`
const red = (text) => `\x1b[31m${text}\x1b[0m`
const green = (text) => `\x1b[32m${text}\x1b[0m`

say()
say(bold('彼岸层裸机维修会话'))
say(dim(`  workspace : ${workspace}`))
say(dim(`  崩溃日志  : ${logPath}`))
say(dim(`  dry-run   : ${dryRun ? '是' : '否'}`))
say(dim(`  命令执行  : ${allowCommands ? '允许' : '禁止'}`))
say(dim(`  重启      : ${restartSpec === undefined ? '未配置' : String(restartSpec)}`))
say()

if (!existsSync(workspace)) {
  say(red(`workspace 不存在：${workspace}`))
  process.exit(2)
}

/* ── The model: a provider, or an explicit rehearsal ─────────────────────────────────── */

function scriptedModel(logText, hasRestart) {
  /**
   * A REHEARSAL MODEL. It is not a stand-in for intelligence; it is a fixed script that walks
   * the same tool path a real model would, so the MACHINERY can be proven without a
   * credential. Its answers are derived from the log it is given, and the CLI labels the run
   * as a rehearsal in the output.
   */
  const steps = []
  /** 1. Read the log. */
  steps.push({ toolCalls: [{ id: 'r1', name: 'read_file', arguments: { path: logPath } }] })
  /** 2. Diagnose from what the log actually says. */
  const hasMissingDb = /ENOENT|no such file|missing/i.test(logText)
  const fixPath = 'config/host.json'
  steps.push({ toolCalls: [{ id: 'r2', name: 'read_file', arguments: { path: fixPath } }] })
  steps.push({
    toolCalls: [
      {
        id: 'r3',
        name: 'write_file',
        arguments: {
          path: fixPath,
          content: JSON.stringify(
            {
              hostDb: './data/host.db',
              port: 8080,
              note: 'rehearsal 修复：hostDb 指向不存在的文件导致启动失败',
            },
            null,
            2,
          ),
        },
      },
    ],
  })
  steps.push({ toolCalls: [{ id: 'r4', name: 'append_file', arguments: { path: 'repair-log.md', content: `\n## 修复记录\n- 症状：${hasMissingDb ? 'hostDb 指向不存在文件（ENOENT）' : '启动失败'}\n- 处理：修正 hostDb 路径\n` } }] })
  /** 3. Only ask for a restart when one was configured, so the rehearsal matches reality. */
  if (hasRestart) steps.push({ toolCalls: [{ id: 'r5', name: 'restart_host', arguments: {} }] })
  steps.push({ text: `诊断完成：${hasMissingDb ? 'hostDb 指向不存在的文件' : '启动失败'}，已修正 ${fixPath} 并写入 repair-log.md${hasRestart ? '，已重启宿主' : ''}。` })
  let index = 0
  return {
    name: 'rehearsal',
    provider: 'scripted',
    async generate() {
      const step = steps[Math.min(index, steps.length - 1)]
      index += 1
      return { text: step.text ?? '', toolCalls: step.toolCalls ?? [], model: 'rehearsal-v1' }
    },
  }
}

function providerModel() {
  const baseUrl = process.env.DSH_REPAIR_BASE_URL
  const apiKey = process.env.DSH_REPAIR_API_KEY
  const model = process.env.DSH_REPAIR_MODEL
  if (baseUrl === undefined || apiKey === undefined || model === undefined) return undefined
  return layer.createRawLlm({ baseUrl, apiKey, model })
}

const logText = (() => {
  const path = resolve(workspace, logPath)
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
})()

const llm = providerModel() ?? (rehearse ? scriptedModel(logText, restartSpec !== undefined) : undefined)

if (llm === undefined) {
  say(red('没有可用的模型。'))
  say()
  say('要接真实提供方，设置三个环境变量：')
  say(dim('  DSH_REPAIR_BASE_URL=https://api.deepseek.com/v1'))
  say(dim('  DSH_REPAIR_API_KEY=<key>'))
  say(dim('  DSH_REPAIR_MODEL=deepseek-chat'))
  say()
  say('要用固定脚本演练这套机制（不需要凭据）：')
  say(dim('  node repair-cli.mjs --log crash.log --workspace . --rehearse --dry-run'))
  process.exit(3)
}

if (rehearse && providerModel() === undefined) {
  say(dim('  模型      : rehearsal（固定脚本，用于证明机制；不是真实诊断）'))
  say()
}

/* ── Run it ──────────────────────────────────────────────────────────────────────────── */

const restart =
  restartSpec === undefined
    ? undefined
    : { command: String(restartSpec).split(/\s+/u).filter(Boolean), cwd: workspace }

const result = await layer.runRepairSession({
  workspace,
  logPath,
  llm,
  dryRun,
  allowCommands,
  ...(restart === undefined ? {} : { restart }),
  maxRounds,
  onEvent(event) {
    if (event.type === 'log-read') say(dim(`  读取崩溃日志 ${event.bytes} 字符`))
    if (event.type === 'round') say(dim(`  ── 第 ${event.round} 轮`))
    if (event.type === 'tool-call') say(`  → ${bold(event.name)} ${dim(JSON.stringify(event.arguments).slice(0, 120))}`)
    if (event.type === 'tool-result') {
      const mark = event.ok ? green('✓') : red('✗')
      say(`    ${mark} ${event.ms}ms${event.error === undefined ? '' : ` ${red(event.error)}`}`)
    }
    if (event.type === 'file-written') say(`    ${green('写入')} ${event.path}`)
    if (event.type === 'command-run') say(`    ${event.code === 0 ? green('退出 0') : red(`退出 ${event.code}`)} ${event.command}`)
    if (event.type === 'restart-requested') say(`    ${bold('重启')} ${event.command.join(' ')}`)
    if (event.type === 'restarted') say(`    ${green('已重启')} pid ${event.pid}`)
  },
})

say()
say(bold('结果'))
say(`  轮次      ${result.turn.rounds}`)
say(`  工具调用  ${result.turn.toolCalls.length}`)
say(`  写入文件  ${result.written.length === 0 ? '(无)' : result.written.join(', ')}`)
say(`  执行命令  ${result.commands.length}`)
if (result.withheld.length > 0) say(`  被跳过    ${result.withheld.join(', ')}`)
if (result.restartedPid !== undefined) say(`  重启 pid  ${result.restartedPid}`)
if (result.turn.error !== undefined) {
  say(red(`  错误      ${result.turn.error.code}: ${result.turn.error.message}`))
}
say()
say(bold('模型结论'))
say(`  ${result.turn.text}`)
say()
say(result.turn.error === undefined ? green('完成') : red('未完成'))
process.exit(result.turn.error === undefined ? 0 : 1)
