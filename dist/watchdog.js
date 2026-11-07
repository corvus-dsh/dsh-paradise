#!/usr/bin/env node
/**
 * `node dist/watchdog.js` — the two-state guardian.
 *
 * THE ARCHITECTURE THIS IMPLEMENTS
 *
 * There are two possible states for this machine, and the watchdog moves between them:
 *
 *   HOSTED     DSH is alive. The watchdog watches, and does nothing else.
 *   REPAIRING  DSH is dead. The watchdog starts the STANDALONE harness, hands it a repair
 *              instruction, and keeps it in the node list until DSH comes back.
 *
 * The point is the ORDER: the repair environment is started BY the watchdog, not by DSH. A repair
 * session hosted inside the thing it repairs dies with it, which is the definition of fake
 * self-healing.
 *
 * ── WHAT "DSH IS ALIVE" MEANS HERE ────────────────────────────────────────────────────────────
 *
 * A pid file and/or a TCP port. Both are configurable; either can be omitted. Neither requires DSH to
 * expose an API, because a host that has crashed cannot expose anything.
 *
 * ── WHAT IT WILL NOT DO ───────────────────────────────────────────────────────────────────────
 *
 * It will not restart DSH itself. Diagnosing a crash and editing a config is a MODEL's job, and the
 * model lives in the standalone harness. The watchdog's job is to make sure that harness is running
 * and knows what happened. If no model is configured, the harness still starts and the repair node
 * still records its refusal — the watchdog does not pretend a repair happened.
 *
 * USAGE
 *
 *   node dist/watchdog.js --pid-file <path> --probe-port 8080 \
 *        --repair-env-port 38080 --repair-home ./.starfire \
 *        --interval 10000 --log-root <dir>
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
/** `pathToFileURL` because a Windows drive letter handed to `import()` is read as a URL scheme. */
const layer = await import(pathToFileURL(join(here, '..', 'index.js')).href)

/* ── arguments ───────────────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  if (at === -1) return fallback
  const next = argv[at + 1]
  return next === undefined || next.startsWith('--') ? true : next
}

const intervalMs = Number(flag('interval', 10_000))
const pidFile = flag('pid-file', undefined)
const probePort = flag('probe-port', undefined)
const repairPort = Number(flag('repair-env-port', 38080))
const repairHome = resolve(String(flag('repair-home', join(process.cwd(), '.starfire'))))
const stateFile = resolve(String(flag('state-file', join(repairHome, 'watchdog-state.json'))))
/**
 * WHERE CRASH LOGS LIVE. This directory is granted to the repair session as its workspace, so the
 * node can read a log and edit the config beside it. It defaults to the repair home, which is safe;
 * pointing it at a real host directory is the operator's explicit choice.
 */
const logRoot = resolve(String(flag('log-root', repairHome)))
const once = flag('once', false) === true
const dryRun = flag('dry-run', false) === true

const bold = (text) => `\x1b[1m${text}\x1b[0m`
const dim = (text) => `\x1b[2m${text}\x1b[0m`
const green = (text) => `\x1b[32m${text}\x1b[0m`
const red = (text) => `\x1b[31m${text}\x1b[0m`
const yellow = (text) => `\x1b[33m${text}\x1b[0m`
const say = (line = '') => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`)

if (!existsSync(repairHome)) mkdirSync(repairHome, { recursive: true })
const auditPath = join(repairHome, 'watchdog.log')
const audit = (line) => {
  try {
    appendFileSync(auditPath, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* the console is the primary channel */
  }
}

/* ── probes ─────────────────────────────────────────────────────────────────────────── */

/** Is the pid in the file alive? `kill(pid, 0)` asks the OS without sending a signal. */
function pidAlive(path) {
  if (!existsSync(path)) return { ok: false, reason: 'PID_FILE_MISSING' }
  let pid
  try {
    pid = Number(readFileSync(path, 'utf8').trim())
  } catch {
    return { ok: false, reason: 'PID_FILE_UNREADABLE' }
  }
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, reason: 'PID_INVALID' }
  try {
    process.kill(pid, 0)
    return { ok: true, pid }
  } catch (error) {
    return { ok: false, reason: String(error?.code ?? 'PID_DEAD'), pid }
  }
}

/** Does the host answer on its port? A live pid with a dead listener is still an outage. */
function portAlive(port) {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (answer) => {
      socket.destroy()
      resolvePromise(answer)
    }
    socket.setTimeout(1200)
    socket.once('connect', () => finish({ ok: true }))
    socket.once('timeout', () => finish({ ok: false, reason: 'PORT_TIMEOUT' }))
    socket.once('error', (error) => finish({ ok: false, reason: String(error?.code ?? 'PORT_CLOSED') }))
  })
}

/** Is the standalone repair harness listening? */
async function repairEnvAlive() {
  return (await portAlive(repairPort)).ok
}

/* ── finding a crash log ────────────────────────────────────────────────────────────── */

/**
 * The newest `*.log` under the configured root, or the root itself when it IS a file.
 *
 * EXCLUDES ITS OWN AUDIT LOG. The first version happily reported `watchdog.log` as the crash log —
 * its own diary, written seconds ago, always the newest file in the directory. A repair node then
 * reads the watchdog's own heartbeat instead of the host's failure, which is worse than having no
 * log at all because it looks like evidence.
 *
 * Files named like a crash/host log are PREFERRED over anything else, so a directory holding both
 * `dsh-crash.log` and an unrelated `access.log` picks the one that matters.
 */
function findCrashLog() {
  try {
    const stat = statSync(logRoot)
    if (stat.isFile()) return logRoot
  } catch {
    return undefined
  }
  const selfNames = new Set(['watchdog.log', 'repair-env.log', 'host-alive.txt'])
  const looksLikeCrash = (name) => /(crash|error|fatal|boot|host)/iu.test(name)
  let best
  let bestScore = -1
  let bestAt = -1
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!/\.log$/iu.test(entry.name)) continue
      /** Never hand a repair node this watchdog's own diary. */
      if (selfNames.has(entry.name.toLowerCase())) continue
      let at
      try {
        at = statSync(full).mtimeMs
      } catch {
        continue
      }
      /** A name that reads like a crash log outranks a newer unrelated one. */
      const score = looksLikeCrash(entry.name) ? 1 : 0
      if (score > bestScore || (score === bestScore && at > bestAt)) {
        best = full
        bestScore = score
        bestAt = at
      }
    }
  }
  walk(logRoot, 0)
  return best
}

/* ── the repair environment ─────────────────────────────────────────────────────────── */

let repairChild

/** Start `harness-server.js` detached, so it outlives this watchdog if the watchdog is killed. */
async function ensureRepairEnv() {
  if (await repairEnvAlive()) return { started: false, already: true }
  if (dryRun) return { started: false, dryRun: true }
  const certLog = join(repairHome, 'repair-env.log')
  const child = spawn(
    process.execPath,
    [join(here, 'harness-server.js'), '--port', String(repairPort), '--home', repairHome],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
  )
  child.stdout.on('data', (chunk) => {
    try {
      appendFileSync(certLog, String(chunk), 'utf8')
    } catch {
      /* ignore */
    }
  })
  child.stderr.on('data', (chunk) => {
    try {
      appendFileSync(certLog, String(chunk), 'utf8')
    } catch {
      /* ignore */
    }
  })
  child.unref()
  repairChild = child
  /**
   * WAIT FOR IT TO LISTEN. A repair instruction sent to a server that has not bound its port yet is
   * a request to a closed socket — the exact race that makes "it started but nothing happened".
   */
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await repairEnvAlive()) return { started: true, pid: child.pid }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
  }
  return { started: false, error: 'repair env did not start listening' }
}

/** Send the repair directive to the standalone harness over its own HTTP API. */
async function dispatchRepair(reason, crashLog) {
  const body = JSON.stringify({
    reason,
    crashLog: crashLog ?? null,
    workspace: logRoot,
  })
  try {
    const response = await fetch(`http://127.0.0.1:${repairPort}/api/repair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    return await response.json()
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/* ── state ─────────────────────────────────────────────────────────────────────────── */

function writeState(state) {
  try {
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch {
    /* best effort: the UI reads the same file when it can */
  }
}

/* ── one cycle ─────────────────────────────────────────────────────────────────────── */

async function tick() {
  let hostOk = true
  const reasons = []
  if (pidFile !== undefined) {
    const answer = pidAlive(String(pidFile))
    if (!answer.ok) {
      hostOk = false
      reasons.push(`pid:${answer.reason}`)
    }
  }
  if (probePort !== undefined) {
    const answer = await portAlive(Number(probePort))
    if (!answer.ok) {
      hostOk = false
      reasons.push(`port:${answer.reason}`)
    }
  }
  if (pidFile === undefined && probePort === undefined) {
    say(yellow('没有配置探测目标（--pid-file / --probe-port），无法判断宿主状态'))
    return { hostOk: true, note: 'no probe configured' }
  }

  if (hostOk) {
    if (repairChild !== undefined) {
      say(green('宿主已恢复，独立环境可以退场（保留进程供 UI 查看）'))
      audit('host recovered')
    }
    writeState({ at: new Date().toISOString(), hostOk: true, reasons: [] })
    return { hostOk: true }
  }

  const reason = reasons.join(', ')
  say(red(`宿主疑似死亡：${reason}`))
  audit(`host-dead ${reason}`)

  const crashLog = findCrashLog()
  say(dim(`  崩溃日志：${crashLog ?? '(未找到 .log 文件)'}`))

  const env = await ensureRepairEnv()
  if (env.already === true) say(dim(`  独立环境已在运行（端口 ${repairPort}）`))
  else if (env.dryRun === true) say(yellow('  dry-run：不启动独立环境'))
  else if (env.started === true) {
    say(green(`  独立环境已启动 pid ${env.pid}（端口 ${repairPort}）`))
    audit(`repair-env-started pid=${env.pid}`)
  } else {
    say(red(`  独立环境启动失败：${env.error ?? '未知'}`))
    audit(`repair-env-failed ${env.error ?? ''}`)
  }

  const dispatched = await dispatchRepair(reason, crashLog)
  say(dim(`  维修指令：${JSON.stringify(dispatched).slice(0, 200)}`))
  audit(`repair-dispatched ${JSON.stringify(dispatched).slice(0, 300)}`)

  writeState({
    at: new Date().toISOString(),
    hostOk: false,
    reasons,
    crashLog: crashLog ?? null,
    repairEnv: { port: repairPort, started: env.started === true, already: env.already === true },
    dispatched,
  })
  return { hostOk: false, reason, crashLog, dispatched }
}

/* ── run ───────────────────────────────────────────────────────────────────────────── */

say(bold('彼岸层看门狗（双态守护）'))
say(dim(`  探测 pid   ${pidFile ?? '(不测)'}`))
say(dim(`  探测端口   ${probePort ?? '(不测)'}`))
say(dim(`  维修环境   http://127.0.0.1:${repairPort}  home=${repairHome}`))
say(dim(`  日志根目录 ${logRoot}`))
say(dim(`  间隔       ${intervalMs}ms`))
say()

if (once) {
  const result = await tick()
  say('')
  say(result.hostOk ? green('一次探测：宿主正常') : red(`一次探测：宿主死亡（${result.reason}）`))
  process.exit(result.hostOk ? 0 : 1)
}

await tick()
const timer = setInterval(() => {
  void tick().catch((error) => {
    /** A watchdog that dies on its own error is the failure it exists to prevent. */
    say(red(`探测周期异常：${String(error?.message ?? error)}`))
  })
}, intervalMs)
/** Deliberately NOT unref'd: the watchdog is a daemon, so its timer must hold the loop open. */
void timer

audit('watchdog started')
say(dim('看门狗已启动。Ctrl-C 退出。'))

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    say(dim(`\n收到 ${signal}，停止看门狗`))
    audit(`stopped by ${signal}`)
    clearInterval(timer)
    process.exit(0)
  })
}
