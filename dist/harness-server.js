#!/usr/bin/env node
/**
 * `node dist/harness-server.js` — the standalone 星火 OS host.
 *
 * WHAT THIS IS
 *
 * The one command that replaces a DSH desktop installation. It starts a host, serves a browser UI,
 * and is ready to drive agents — no other process required.
 *
 * CREDENTIALS ARE OPTIONAL AND THEIR ABSENCE IS REPORTED
 *
 *   DSH_HARNESS_BASE_URL   e.g. https://api.deepseek.com/v1
 *   DSH_HARNESS_API_KEY
 *   DSH_HARNESS_MODEL      e.g. deepseek-chat
 *
 * Without them the host still runs, the UI still loads, sessions can still be created and the node
 * list still works — but a turn returns a clear refusal instead of a fabricated answer. That is the
 * honest configuration, and the banner says which one is live.
 *
 * PERSISTENCE
 *
 * Everything lives under `--home` (default `./.starfire`): `sessions/*.jsonl`, `nodes/`, `memory/`.
 * A restart re-reads those logs, so a conversation survives the process.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
/** `pathToFileURL` because a Windows drive letter handed to `import()` is read as a URL scheme. */
const layer = await import(pathToFileURL(join(here, '..', 'index.js')).href)

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  if (at === -1) return fallback
  const next = argv[at + 1]
  return next === undefined || next.startsWith('--') ? true : next
}

const port = Number(flag('port', process.env.DSH_HARNESS_PORT ?? 38080))
const host = String(flag('host', '127.0.0.1'))
const home = resolve(String(flag('home', process.env.DSH_HARNESS_HOME ?? join(process.cwd(), '.starfire'))))
const quiet = flag('quiet', false) === true

const bold = (text) => `\x1b[1m${text}\x1b[0m`
const dim = (text) => `\x1b[2m${text}\x1b[0m`
const green = (text) => `\x1b[32m${text}\x1b[0m`
const yellow = (text) => `\x1b[33m${text}\x1b[0m`
const say = (line = '') => {
  if (!quiet) console.log(line)
}

if (!existsSync(home)) mkdirSync(home, { recursive: true })

/* ── the model, if there is one ──────────────────────────────────────────────────────── */

const baseUrl = process.env.DSH_HARNESS_BASE_URL
const apiKey = process.env.DSH_HARNESS_API_KEY
const model = process.env.DSH_HARNESS_MODEL

const llm =
  baseUrl !== undefined && apiKey !== undefined && model !== undefined
    ? layer.createRawLlm({ baseUrl, apiKey, model })
    : undefined

/* ── memory recall, when dsh-memory is present ───────────────────────────────────────── */

/**
 * THE MEMORY BRIDGE IS OPTIONAL AND SILENT WHEN ABSENT.
 *
 * `dsh-memory` is a sibling package, not a dependency: a machine with only this repo must still be
 * able to run the host. So recall is wired when the module resolves and skipped when it does not,
 * and the banner reports which case is live rather than leaving it to guesswork.
 */
let recallHandler
let memoryMode = 'absent'
try {
  const memoryUrl = pathToFileURL(join(here, '..', '..', 'dsh-memory', 'lib', 'retrieve.js')).href
  const memory = await import(memoryUrl)
  const memoryDir = join(home, 'memory')
  const skillsDir = join(home, 'skills')
  memoryMode = 'ok'
  recallHandler = (query) => {
    try {
      const hit = memory.retrieve(memoryDir, skillsDir, query, { threshold: 0.2 })
      const parts = []
      if (hit.skill !== undefined) parts.push(`技能：${hit.skill.title}`)
      if (hit.negative !== undefined) parts.push(`负知识：${hit.negative.title} → ${hit.negative.detail ?? ''}`)
      if (hit.fact !== undefined) parts.push(`事实：${hit.fact.title}`)
      return parts.length === 0 ? undefined : parts.join('\n')
    } catch {
      return undefined
    }
  }
} catch {
  memoryMode = 'absent'
}

/* ── start ───────────────────────────────────────────────────────────────────────────── */

const server = layer.createHarnessServer({
  home,
  port,
  host,
  ...(llm === undefined ? {} : { llm }),
  ...(recallHandler === undefined ? {} : { recall: recallHandler }),
})

/**
 * LISTEN, WITH THE FAILURE EXPLAINED.
 *
 * THE BUG THIS FIXES, TWICE OVER:
 *
 * 1. The first version awaited `server.listen()` with no error handling. When the port was already
 *    taken, the rejection surfaced as an unhandled error AFTER the banner had printed the URL, and
 *    the process exited. From the browser that is `ERR_CONNECTION_REFUSED` — indistinguishable from
 *    "the server never started".
 *
 * 2. The fix then used TypeScript casts (`(error as { code?: string })`). This is a PLAIN `.js` file
 *    run directly by Node, so that is a SYNTAX ERROR — the file did not parse at all, and the
 *    watchdog saw a child that died instantly. That is why the repair environment never came up.
 *
 * Lesson recorded: `dist/*.js` files are plain JavaScript, not the bundle. No type syntax here.
 */
let info
try {
  info = await server.listen()
} catch (error) {
  const code = String(error && error.code ? error.code : '')
  if (code === 'EADDRINUSE') {
    console.error(`\n❌ 端口 ${port} 已被占用。`)
    console.error(`   换一个端口：node dist/harness-server.js --port ${port + 1}`)
    console.error(`   或者找出占用者：netstat -ano | findstr :${port}`)
  } else if (code === 'EACCES') {
    console.error(`\n❌ 没有权限绑定端口 ${port}（1024 以下的端口通常需要管理员）。`)
    console.error(`   换一个高位端口：node dist/harness-server.js --port 38080`)
  } else {
    console.error(`\n❌ 宿主启动失败：${String(error && error.message ? error.message : error)}`)
    if (error && error.stack) console.error(String(error.stack))
  }
  process.exit(1)
}

say()
say(bold('星火 OS · 彼岸原生宿主'))
say(dim(`  地址      ${info.url}`))
say(dim(`  数据目录  ${home}`))
say(
  llm === undefined
    ? `  模型      ${yellow('未配置')}（会话可用，但回答会明确说明缺凭据）`
    : `  模型      ${green(model)} @ ${baseUrl}`,
)
say(
  memoryMode === 'ok'
    ? `  记忆      ${green('已接入')}（${join(home, 'memory')}）`
    : `  记忆      ${dim('未接入（找不到 dsh-memory/lib/retrieve.js）')}`,
)
say('')
if (llm === undefined) {
  say(dim('  接真实模型：'))
  say(dim('    DSH_HARNESS_BASE_URL=https://api.deepseek.com/v1'))
  say(dim('    DSH_HARNESS_API_KEY=<your-key>'))
  say(dim('    DSH_HARNESS_MODEL=deepseek-chat'))
  say('')
}
say(green(`  在浏览器打开：${info.url}`))
say(dim('  Ctrl-C 退出'))
say()

/* ── shutdown ────────────────────────────────────────────────────────────────────────── */

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    say(dim(`\n收到 ${signal}，关闭宿主`))
    void server.close().then(() => process.exit(0))
  })
}

/**
 * A CRASH MUST BE LOUD, NOT SILENT.
 *
 * The reported symptom was `ERR_CONNECTION_REFUSED` with nothing in the terminal to explain it. An
 * unhandled rejection or exception that kills the process while the terminal has already scrolled
 * past is exactly how that happens, so both are printed here with their full message.
 *
 * The watchdog relies on this too: it reads the child's stderr to decide whether a restart failed
 * for a reason worth reporting.
 */
process.on('uncaughtException', (error) => {
  console.error(`\n❌ 宿主未捕获异常：${String(error && error.message ? error.message : error)}`)
  if (error && error.stack) console.error(String(error.stack))
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  console.error(`\n❌ 宿主未处理的 Promise 拒绝：${String(reason && reason.message ? reason.message : reason)}`)
  if (reason && reason.stack) console.error(String(reason.stack))
  process.exit(1)
})

/**
 * KEEP THE PROCESS ALIVE.
 *
 * A listening HTTP server already holds a handle, so this is belt-and-braces — but it is also how
 * a future refactor that stops listening (e.g. socket-only mode) would otherwise exit instantly and
 * look like a crash. Explicit is better here.
 */
const keepAlive = setInterval(() => {}, 1 << 30)
process.on('exit', () => clearInterval(keepAlive))
