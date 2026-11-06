/**
 * THE REPAIR SESSION — self-repair with no host under it.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 *
 * A supervisor whose repair path runs inside the host dies with the host. This session imports
 * only `agent-loop.ts` plus real tools (`read_file`, `write_file`, `append_file`,
 * `run_command`, `restart_host`), so it can run from a terminal with nothing else alive.
 *
 * The MODEL here is scripted. That is stated plainly: these tests prove the MACHINERY (which
 * tool runs, what gets written, what gets refused), not the quality of a diagnosis. A test
 * that needed a provider credential could not be run by the next person either.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const layer = await import(new URL('../index.js', import.meta.url).href)

/** A workspace with a crash log and a broken config, i.e. a plausible failed boot. */
function brokenHost() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-repair-'))
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(
    join(root, 'crash.log'),
    [
      '2026-11-07T09:14:02.331Z ERROR host boot failed after 3 attempts',
      '2026-11-07T09:14:02.332Z ERROR   at HostDatabase.open (src/host/db.ts:41)',
      "2026-11-07T09:14:02.333Z ERROR   ENOENT: no such file or directory, open './db/host.sqlite'",
    ].join('\n'),
    'utf8',
  )
  writeFileSync(join(root, 'config/host.json'), JSON.stringify({ hostDb: './db/host.sqlite', port: 8080 }), 'utf8')
  return root
}

/** Scripted model: read log → read config → write fix → report. */
function repairScript(workspace) {
  const steps = [
    { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'crash.log' } }] },
    { toolCalls: [{ id: 'c2', name: 'read_file', arguments: { path: 'config/host.json' } }] },
    {
      toolCalls: [
        {
          id: 'c3',
          name: 'write_file',
          arguments: { path: 'config/host.json', content: JSON.stringify({ hostDb: './data/host.db', port: 8080 }, null, 2) },
        },
      ],
    },
    { text: '已把 hostDb 改到 ./data/host.db' },
  ]
  let index = 0
  return {
    name: 'scripted',
    provider: 'test',
    async generate() {
      const step = steps[Math.min(index, steps.length - 1)]
      index += 1
      return { text: step.text ?? '', toolCalls: step.toolCalls ?? [], model: 'scripted-1' }
    },
  }
}

test('repair: reads the crash log, diagnoses, and really rewrites the config', async () => {
  const workspace = brokenHost()
  const result = await layer.runRepairSession({
    workspace,
    logPath: 'crash.log',
    llm: repairScript(workspace),
  })

  assert.equal(result.turn.error, undefined, JSON.stringify(result.turn.error))
  assert.equal(result.written.includes('config/host.json'), true, 'the config was actually written')

  /** The file on disk must be the fix, not just "a tool returned ok". */
  const config = JSON.parse(readFileSync(join(workspace, 'config/host.json'), 'utf8'))
  assert.equal(config.hostDb, './data/host.db')
  rmSync(workspace, { recursive: true, force: true })
})

test('repair: dry-run sees the same evidence but writes nothing', async () => {
  const workspace = brokenHost()
  const before = readFileSync(join(workspace, 'config/host.json'), 'utf8')
  const result = await layer.runRepairSession({
    workspace,
    logPath: 'crash.log',
    llm: repairScript(workspace),
    dryRun: true,
  })
  const after = readFileSync(join(workspace, 'config/host.json'), 'utf8')
  assert.equal(after, before, 'the config is untouched under dry-run')
  assert.equal(result.written.length, 0)
  assert.ok(result.withheld.some((entry) => entry.startsWith('write_file')), 'the refusal is reported, not silent')
  /** Reads still happened: a dry run that cannot see the log is useless for review. */
  assert.ok(result.turn.toolCalls.filter((call) => call.name === 'read_file').length >= 2)
  rmSync(workspace, { recursive: true, force: true })
})

test('repair: a path outside the workspace is REFUSED', async () => {
  const workspace = brokenHost()
  const outside = join(tmpdir(), `dsh-outside-${Date.now()}.txt`)
  writeFileSync(outside, 'secret', 'utf8')
  const steps = [
    { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: outside } }] },
    { text: '读不到，放弃' },
  ]
  let index = 0
  const llm = {
    name: 'escape',
    provider: 'test',
    async generate() {
      const step = steps[Math.min(index, steps.length - 1)]
      index += 1
      return { text: step.text ?? '', toolCalls: step.toolCalls ?? [], model: 'escape' }
    },
  }
  const result = await layer.runRepairSession({ workspace, logPath: 'crash.log', llm })
  assert.equal(result.turn.toolCalls[0].ok, false, 'reading outside must fail')
  assert.match(String(result.turn.toolCalls[0].error), /SANDBOX_DENIED|不在 workspace/u)
  rmSync(workspace, { recursive: true, force: true })
  try {
    rmSync(outside, { force: true })
  } catch {
    /* best effort */
  }
})

test('repair: run_command is refused unless explicitly allowed', async () => {
  const workspace = brokenHost()
  const steps = [
    { toolCalls: [{ id: 'c1', name: 'run_command', arguments: { command: process.execPath, args: ['-e', 'console.log(1)'] } }] },
    { text: 'ok' },
  ]
  let index = 0
  const llm = {
    name: 'run',
    provider: 'test',
    async generate() {
      const step = steps[Math.min(index, steps.length - 1)]
      index += 1
      return { text: step.text ?? '', toolCalls: step.toolCalls ?? [], model: 'run' }
    },
  }
  const result = await layer.runRepairSession({ workspace, logPath: 'crash.log', llm })
  assert.equal(result.commands.length, 0, 'nothing ran')
  assert.ok(result.withheld.some((entry) => entry.startsWith('run_command')))
  rmSync(workspace, { recursive: true, force: true })
})

test('repair: an allowed command really runs and its exit code is reported', async () => {
  const workspace = brokenHost()
  const steps = [
    {
      toolCalls: [
        { id: 'c1', name: 'run_command', arguments: { command: process.execPath, args: ['-e', 'console.log("REPAIR_PROBE_OK")'] } },
      ],
    },
    { text: '跑完了' },
  ]
  let index = 0
  const llm = {
    name: 'run',
    provider: 'test',
    async generate() {
      const step = steps[Math.min(index, steps.length - 1)]
      index += 1
      return { text: step.text ?? '', toolCalls: step.toolCalls ?? [], model: 'run' }
    },
  }
  const result = await layer.runRepairSession({ workspace, logPath: 'crash.log', llm, allowCommands: true })
  assert.equal(result.commands.length, 1)
  assert.equal(result.commands[0].code, 0)
  assert.match(result.commands[0].output, /REPAIR_PROBE_OK/u)
  rmSync(workspace, { recursive: true, force: true })
})

test('repair: restart_host spawns the configured command', async () => {
  const workspace = brokenHost()
  const marker = join(workspace, 'restarted.txt')
  const steps = [{ toolCalls: [{ id: 'c1', name: 'restart_host', arguments: {} }] }, { text: '重启了' }]
  let index = 0
  const llm = {
    name: 'restart',
    provider: 'test',
    async generate() {
      const step = steps[Math.min(index, steps.length - 1)]
      index += 1
      return { text: step.text ?? '', toolCalls: step.toolCalls ?? [], model: 'restart' }
    },
  }
  const result = await layer.runRepairSession({
    workspace,
    logPath: 'crash.log',
    llm,
    restart: { command: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'up')`], cwd: workspace },
  })
  assert.equal(typeof result.restartedPid, 'number')
  /**
   * The spawned process is detached; give it a moment to write its marker. This is the only
   * sleep in the file, and it exists because the assertion is about the CHILD's side effect.
   */
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500))
  assert.equal(existsSync(marker), true, 'the restarted host actually ran')
  rmSync(workspace, { recursive: true, force: true })
})

test('repair: the workspace allowlist is enforced by resolveInside too', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-inside-'))
  assert.equal(layer.resolveInside(workspace, 'a/b.txt'), resolve(workspace, 'a/b.txt'))
  assert.throws(() => layer.resolveInside(workspace, '../escape.txt'), /SANDBOX_DENIED/u)
  assert.throws(() => layer.resolveInside(workspace, resolve(workspace, '..', 'x')), /SANDBOX_DENIED/u)
  rmSync(workspace, { recursive: true, force: true })
})

test('repair: the declared tool list matches what the session actually offers', () => {
  assert.deepEqual([...layer.REPAIR_TOOL_NAMES], ['read_file', 'write_file', 'append_file', 'run_command', 'restart_host'])
})
