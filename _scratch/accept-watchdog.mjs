#!/usr/bin/env node
/**
 * ACCEPTANCE: kill the host, watch the watchdog bring it back — no human in the loop.
 *
 * WHAT THE USER ASKED TO SEE
 *
 *   "手动 kill 掉假的 DSH 进程，验证看门狗能否在 1 分钟内自动完成
 *    「发现死亡 → LLM 诊断 → 修复配置 → 拉起进程」的全自动闭环"
 *
 * THIS RUN IS THE REAL TOPOLOGY
 *
 *   process A: the fake host        (pid file + TCP port — what the probes check)
 *   process B: `dist/watchdog.mjs`  (a SEPARATE OS process, as it must be)
 *   this file: the operator         — starts both, kills A, then watches
 *
 * No component calls another in-process. The only channel is the filesystem and the port, which
 * is the same channel a systemd unit or a service manager would use.
 *
 * WHY `--rehearse`
 *
 * There is no provider credential in this environment. The rehearsal repair performs a REAL
 * file edit (the config is rewritten on disk), so every mechanical step is genuine: detection,
 * diagnosis text, file mutation, spawn, verification. What is scripted is only the model's
 * choice of which edit to make — and the run says so in its own output.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const WS = process.cwd()

const bold = (text) => `\x1b[1m${text}\x1b[0m`
const dim = (text) => `\x1b[2m${text}\x1b[0m`
const red = (text) => `\x1b[31m${text}\x1b[0m`
const green = (text) => `\x1b[32m${text}\x1b[0m`
const say = (line = '') => console.log(line)

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

/** A free port, so the acceptance run never collides with a real service. */
async function freePort() {
  return await new Promise((resolvePromise) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePromise(port))
    })
  })
}

const port = await freePort()
const root = mkdtempSync(join(WS, '_scratch', '.watchdog-accept-'))
mkdirSync(join(root, 'config'), { recursive: true })
mkdirSync(join(root, 'data'), { recursive: true })

const fakeHost = join(repo, '_scratch', 'fake-host.mjs')
const watchdogCli = join(repo, 'dist', 'watchdog.mjs')

say()
say(bold('看门狗闭环验收'))
say(dim(`  场景目录  ${root}`))
say(dim(`  假宿主    ${fakeHost}  (port ${port})`))
say(dim(`  看门狗    ${watchdogCli}`))
say()

/* ── 1. Start the fake host, healthy ─────────────────────────────────────────────────── */

const hostArgs = ['--port', String(port), '--workspace', root, '--pid-file', 'host.pid']
const host = spawn(process.execPath, [fakeHost, ...hostArgs], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
host.stdout.on('data', (chunk) => process.stdout.write(dim(`  [host] ${chunk}`)))
host.stderr.on('data', (chunk) => process.stdout.write(red(`  [host] ${chunk}`)))

await sleep(1200)
const firstPid = Number(readFileSync(join(root, 'host.pid'), 'utf8').trim())
say(`1) 假宿主已启动 pid ${firstPid}，端口 ${port}`)

/* ── 2. Start the watchdog as its OWN process ───────────────────────────────────────── */

const watchdogOut = []
const watchdog = spawn(
  process.execPath,
  [
    watchdogCli,
    '--workspace', root,
    '--log', 'crash.log',
    '--pid-file', 'host.pid',
    '--port', String(port),
    '--interval', '1000',
    '--threshold', '1',
    '--max-recoveries', '2',
    '--rehearse',
    '--host-cmd', process.execPath, fakeHost, ...hostArgs,
  ],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
)
watchdog.stdout.on('data', (chunk) => {
  const text = String(chunk)
  watchdogOut.push(text)
  process.stdout.write(text.split('\n').filter(Boolean).map((line) => `  ${dim('[watchdog]')} ${line}`).join('\n') + '\n')
})
watchdog.stderr.on('data', (chunk) => {
  const text = String(chunk)
  watchdogOut.push(text)
  process.stdout.write(red(`  [watchdog] ${text}`))
})

await sleep(2500)
say('2) 看门狗已启动（独立进程）')

/* ── 3. Kill the host ───────────────────────────────────────────────────────────────── */

const killStarted = Date.now()
try {
  process.kill(firstPid, 'SIGKILL')
} catch (error) {
  say(red(`  kill 失败：${String(error.message)}`))
}
say(`3) ${red(`已 kill 假宿主 pid ${firstPid}`)}`)

/* ── 4. Wait for the closed loop ────────────────────────────────────────────────────── */

const DEADLINE = 60_000
let recovered = false
let recoveredPid
let elapsed = 0
while (Date.now() - killStarted < DEADLINE) {
  await sleep(500)
  elapsed = Date.now() - killStarted
  const pidNow = (() => {
    try {
      return Number(readFileSync(join(root, 'host.pid'), 'utf8').trim())
    } catch {
      return undefined
    }
  })()
  /** The pid file must hold a DIFFERENT, ALIVE pid — not the corpse's number. */
  if (pidNow !== undefined && pidNow !== firstPid && pidNow > 0) {
    let alive = false
    try {
      process.kill(pidNow, 0)
      alive = true
    } catch {
      alive = false
    }
    if (alive) {
      recovered = true
      recoveredPid = pidNow
      break
    }
  }
}

say('')
if (!recovered) {
  say(red(`4) 60 秒内未恢复（等待 ${elapsed}ms）`))
} else {
  say(`4) ${green(`看门狗已拉起新宿主 pid ${recoveredPid}`)}（kill 后 ${(elapsed / 1000).toFixed(1)} 秒）`)
}

/* ── 5. Verify the repair actually happened ─────────────────────────────────────────── */

const configPath = join(root, 'config', 'host.json')
const configText = (() => {
  try {
    return readFileSync(configPath, 'utf8')
  } catch {
    return ''
  }
})()
let config = {}
try {
  config = JSON.parse(configText)
} catch {
  config = {}
}

const heartbeat = (() => {
  try {
    return readFileSync(join(root, 'host-alive.txt'), 'utf8').trim()
  } catch {
    return ''
  }
})()

say('')
say(bold('验收判定'))
const repairedConfig = config.repairedBy === 'watchdog-rehearsal'
say(`  ${recovered ? green('✅') : red('❌')} 自动恢复（60 秒内）`)
say(`  ${repairedConfig ? green('✅') : red('❌')} 修复了配置（repairedBy=${config.repairedBy ?? '(无)'}, hostDb=${config.hostDb ?? '(无)'}）`)
say(`  ${heartbeat.length > 0 ? green('✅') : red('❌')} 新宿主有心跳：${heartbeat || '(无)'}`)
say(`  ${elapsed < 60_000 ? green('✅') : red('❌')} 用时 ${(elapsed / 1000).toFixed(1)} 秒 < 60 秒`)

const auditLog = (() => {
  try {
    return readFileSync(join(root, 'watchdog.log'), 'utf8')
  } catch {
    return ''
  }
})()
const sawDeath = /death-detected/.test(auditLog)
const sawRepair = /repair-end/.test(auditLog)
const sawSpawn = /host-spawned/.test(auditLog)
const sawVerify = /verified ok=true/.test(auditLog)
say(`  ${sawDeath ? green('✅') : red('❌')} 审计日志记录了「判定死亡」`)
say(`  ${sawRepair ? green('✅') : red('❌')} 审计日志记录了「维修」`)
say(`  ${sawSpawn ? green('✅') : red('❌')} 审计日志记录了「拉起」`)
say(`  ${sawVerify ? green('✅') : red('❌')} 审计日志记录了「验证通过」`)

say('')
say(dim('看门狗审计日志：'))
for (const line of auditLog.split('\n').filter(Boolean).slice(-14)) say(dim(`  ${line}`))

/* ── Cleanup ───────────────────────────────────────────────────────────────────────── */

watchdog.kill()
try {
  if (recoveredPid !== undefined) process.kill(recoveredPid, 'SIGKILL')
} catch {
  /* already gone */
}
await sleep(300)

const allGreen = recovered && repairedConfig && heartbeat.length > 0 && elapsed < 60_000 && sawDeath && sawRepair && sawSpawn && sawVerify
say('')
say(allGreen ? green(bold('闭环验收通过：无需人类终端')) : red(bold('闭环验收未通过')))

try {
  rmSync(root, { recursive: true, force: true })
} catch {
  /* best effort */
}
process.exit(allGreen ? 0 : 1)
