#!/usr/bin/env node
/**
 * A FAKE DSH, FOR THE WATCHDOG ACCEPTANCE RUN.
 *
 * It is deliberately dumb: write a pid file, listen on a port, stay alive. That is exactly
 * what the watchdog's probes check (pid alive + port answering), so a process that does only
 * those two things is a faithful stand-in for "the host is up".
 *
 * `--crash-on-start` makes it write a broken config and exit 1, which is how the acceptance run
 * simulates a host that cannot boot until something repairs it.
 */
import { createServer } from 'node:net'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const port = Number(argv[argv.indexOf('--port') + 1] ?? 18080)
const workspace = resolve(argv[argv.indexOf('--workspace') + 1] ?? process.cwd())
const pidFile = argv[argv.indexOf('--pid-file') + 1] ?? 'host.pid'
const crashOnStart = argv.includes('--crash-on-start')

const pidPath = resolve(workspace, pidFile)
mkdirSync(dirname(pidPath), { recursive: true })

if (crashOnStart) {
  /**
   * The failure the repair session is supposed to fix: a config pointing at a database
   * directory that does not exist. Written, then the process exits 1 — so the watchdog sees a
   * dead pid and a closed port, and the repair has something real to correct.
   */
  const configPath = join(workspace, 'config', 'host.json')
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, `${JSON.stringify({ hostDb: './db/host.sqlite', port }, null, 2)}\n`, 'utf8')
  writeFileSync(join(workspace, 'crash.log'), `${new Date().toISOString()} ERROR boot failed: ENOENT './db/host.sqlite'\n`, 'utf8')
  writeFileSync(pidPath, `${process.pid}\n`, 'utf8')
  process.stderr.write('fake host: boot failed (config points at ./db/host.sqlite)\n')
  process.exit(1)
}

/** Refuse to boot until the config points somewhere real — the condition a repair must satisfy. */
let config = {}
try {
  config = JSON.parse(readFileSync(join(workspace, 'config', 'host.json'), 'utf8'))
} catch {
  config = {}
}
if (typeof config.hostDb === 'string' && config.hostDb.includes('/db/')) {
  writeFileSync(pidPath, `${process.pid}\n`, 'utf8')
  writeFileSync(join(workspace, 'crash.log'), `${new Date().toISOString()} ERROR boot failed: ENOENT '${config.hostDb}'\n`, 'utf8')
  process.stderr.write(`fake host: boot failed (hostDb=${config.hostDb})\n`)
  process.exit(1)
}

writeFileSync(pidPath, `${process.pid}\n`, 'utf8')
const server = createServer((socket) => socket.end())
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`fake host listening on 127.0.0.1:${port} pid ${process.pid}\n`)
})

/** The host records its own heartbeat so "it came back and stayed back" is checkable. */
setInterval(() => {
  try {
    writeFileSync(join(workspace, 'host-alive.txt'), `${new Date().toISOString()} pid ${process.pid}\n`, 'utf8')
  } catch {
    /* ignore */
  }
}, 1000)

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0))
