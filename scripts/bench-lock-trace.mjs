#!/usr/bin/env node
/**
 * T2f — HOW MANY TIMES DOES A TURN TAKE THE LOCK, AND ON WHICH PATHS?
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
 *
 * T2d's verdict was "contention dominates ⇒ reduce the number of acquisitions". That names a
 * DIRECTION, not an edit: reducing acquisitions is only possible once someone knows which call sites
 * run per turn — and 9 graft sites + 8 memory sites exist, but no one has measured how many of them
 * fire in one `agent/pre-step`, or on which files.
 *
 * A site that runs twice inside one function is a merge candidate. A site that runs once per session
 * is not. Without the distribution, "fewer" is a guess with a plausible story attached.
 *
 * ── THE INSTRUMENT (and why it cannot change behaviour) ─────────────────────────────────────────
 *
 * Both lock implementations now carry a counter gated by `DSH_LOCK_TRACE=1`:
 *
 *     recordAcquisition(path)   →   if (!enabled) return   // one boolean test when off
 *
 * It only increments a Map; a snapshot function reads it. Nothing in production consults it, so with
 * the variable unset the observable behaviour is identical (the test suites must confirm that — see
 * the report).
 *
 * ── WHAT IS MEASURED ────────────────────────────────────────────────────────────────────────────
 *
 * A REAL pre-step through the real plugin entry (`dsh-graft-slice/index.js`) with the real fake
 * harness, plus a real `memory_harvest`-shaped pass over the memory store, so the count is what a
 * turn actually does rather than what the source suggests it might do.
 *
 * Usage: node scripts/bench-lock-trace.mjs [--json out.json]
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const PARADISE = resolve(dirname(SELF), '..')
const WORKSPACE = resolve(PARADISE, '..')
const MEMORY = join(WORKSPACE, 'dsh-memory')
const GRAFT = join(WORKSPACE, 'dsh-graft-slice')

const JSON_OUT = (() => {
  const index = process.argv.indexOf('--json')
  return index >= 0 ? process.argv[index + 1] : undefined
})()

process.env.DSH_LOCK_TRACE = '1'
process.env.PARADISE_STRICT_HOST = '0'

const memoryLock = await import(pathToFileURL(join(MEMORY, 'lib', 'lock.js')).href)
const graftBundle = await import(pathToFileURL(join(GRAFT, 'index.js')).href)
const harness = await import(pathToFileURL(join(GRAFT, 'test', 'fake-harness.mjs')).href)

/**
 * The graft counter is not on the public export surface — deliberately, since adding a name there
 * would be a breaking-change signal for an instrument nothing ships. It IS in the bundle, so the
 * counters are reachable through the module's own snapshot function only if exported; when it is not,
 * fall back to counting through the audit-free path: wrap `acquireFileLock` is impossible (module
 * namespace is frozen), so the honest answer is "not observable from outside" and that is reported
 * rather than guessed.
 */
const graftTrace = typeof graftBundle.lockTraceSnapshot === 'function' ? graftBundle.lockTraceSnapshot : undefined

async function measureGraftPreStep() {
  const log = harness.makeSourceLog({ turns: 6, sourceSessionId: 'trace-source' })
  const persistence = new harness.FakePersistence()
  const ctx = harness.makeCtx({ sourceLog: log, persistence })
  graftBundle.apply(ctx, {})

  // Warm up so one-off registrations are not counted as per-turn cost.
  await harness.dispatchPreStep(ctx, { agent: { id: log.session.id }, messages: [] })

  memoryLock.lockTraceReset?.()
  graftBundle.lockTraceReset?.()

  const ROUNDS = 10
  for (let i = 0; i < ROUNDS; i += 1) {
    await harness.dispatchPreStep(ctx, {
      agent: { id: log.session.id },
      messages: [{ role: 'user', content: [{ type: 'text', text: '继续' }] }],
    })
  }

  return {
    rounds: ROUNDS,
    graft: graftTrace === undefined ? undefined : graftTrace(),
    memory: memoryLock.lockTraceSnapshot(),
  }
}

async function measureMemoryHarvest() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-trace-'))
  const memory = join(root, 'memory')
  try {
    const { apply } = await import(pathToFileURL(join(MEMORY, 'lib', 'index.js')).href)
    const tools = []
    const ctx = {
      paths: { data: memory },
      tools: { register: (definition) => tools.push(definition) },
      on: () => {},
      get: (name) => (name === 'sessions' ? { get: () => undefined, list: () => [] } : undefined),
      logger: { info: () => {}, warn: () => {} },
    }
    apply(ctx, { memoryDir: memory, skillsDir: join(root, 'skills'), retrieval: false })

    memoryLock.lockTraceReset()
    const stats = tools.find((tool) => tool.name === 'memory_stats')
    await stats.execute({}, { agent: { id: 'a1' } })
    const afterStats = memoryLock.lockTraceSnapshot()

    memoryLock.lockTraceReset()
    const graphRead = tools.find((tool) => tool.name === 'memory_graph_read')
    if (graphRead !== undefined) await graphRead.execute({}, { agent: { id: 'a1' } })
    const afterGraphRead = memoryLock.lockTraceSnapshot()

    return { afterStats, afterGraphRead }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

process.stdout.write('T2f — lock acquisition distribution per turn\n')
process.stdout.write(`DSH_LOCK_TRACE=1 · node ${process.version}\n\n`)

const preStep = await measureGraftPreStep()
process.stdout.write('── one agent/pre-step (real plugin entry, fake harness) ──\n')
process.stdout.write(`  rounds measured: ${preStep.rounds}\n`)
if (preStep.graft === undefined) {
  process.stdout.write('  graft counter: NOT reachable from the public entry (not exported; by design)\n')
} else {
  process.stdout.write(`  graft: ${preStep.graft.total} acquisitions = ${(preStep.graft.total / preStep.rounds).toFixed(2)}/turn\n`)
  for (const entry of preStep.graft.byPath.slice(0, 8)) {
    process.stdout.write(`    ${entry.count.toString().padStart(4)}  ${entry.path}\n`)
  }
}
process.stdout.write(`  memory: ${preStep.memory.total} acquisitions = ${(preStep.memory.total / preStep.rounds).toFixed(2)}/turn\n`)
for (const entry of preStep.memory.byPath.slice(0, 8)) {
  process.stdout.write(`    ${entry.count.toString().padStart(4)}  ${entry.path}\n`)
}

/**
 * Measure the WRITE paths: the ones `withFileLock` actually guards.
 *
 * Each is a real tool call against a real temp store, so this counts what a turn does rather than
 * what the source suggests it might do.
 */
async function measureMemoryWrites() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-trace-w-'))
  const memory = join(root, 'memory')
  const skills = join(root, 'skills')
  try {
    const { apply } = await import(pathToFileURL(join(MEMORY, 'lib', 'index.js')).href)
    const tools = []
    const ctx = {
      paths: { data: memory },
      tools: { register: (definition) => tools.push(definition) },
      on: () => {},
      get: (name) => (name === 'sessions' ? { get: () => undefined, list: () => [] } : undefined),
      logger: { info: () => {}, warn: () => {} },
    }
    apply(ctx, { memoryDir: memory, skillsDir: skills, retrieval: false })
    const tool = (name) => tools.find((entry) => entry.name === name)

    const results = {}

    // 1. graph update — creates the graph (the TD-M12 path that never ran in production).
    memoryLock.lockTraceReset()
    const graphUpdate = tool('memory_graph_update')
    if (graphUpdate !== undefined) {
      await graphUpdate.execute(
        {
          op: 'add',
          node: { id: 'phase-1', title: '阶段 1', node_type: 'coding', requirements: ['测量'] },
        },
        { agent: { id: 'a1' } },
      ).catch(() => undefined)
    }
    results['memory_graph_update'] = memoryLock.lockTraceSnapshot()

    // 2. graph update again — same tool, now mutating an existing graph.
    memoryLock.lockTraceReset()
    if (graphUpdate !== undefined) {
      await graphUpdate.execute(
        { op: 'activate', nodeId: 'phase-1' },
        { agent: { id: 'a1' } },
      ).catch(() => undefined)
    }
    results['memory_graph_update (2nd)'] = memoryLock.lockTraceSnapshot()

    // 3. a skill write, which goes through updateJsonlFile / SKILL.md replacement.
    memoryLock.lockTraceReset()
    const harvestTool = tool('memory_harvest')
    if (harvestTool !== undefined) {
      await harvestTool.execute({}, { agent: { id: 'a1' } }).catch(() => undefined)
    }
    results['memory_harvest'] = memoryLock.lockTraceSnapshot()

    return results
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const harvest = await measureMemoryHarvest()
process.stdout.write('\n── READ-ONLY paths (expected: 0 acquisitions — the lock protects writes only) ──\n')
process.stdout.write(`  memory_stats      : ${harvest.afterStats.total}\n`)
process.stdout.write(`  memory_graph_read : ${harvest.afterGraphRead.total}\n`)

/**
 * ── A ZERO HERE IS THE DESIGN, BUT IT MUST BE PROVEN, NOT ASSUMED ──────────────────────────────
 *
 * `withFileLock` in `dsh-memory/src/store.ts` wraps `updateJsonlFile` / `updateJsonArrayFile` — the
 * READ-MODIFY-WRITE helpers. A pure reader takes no lock on purpose ("an unchanged pass does not
 * rewrite, so a read-only sweep does not fight other writers"), so 0 is correct for `memory_stats`.
 *
 * That makes the read-only row useless as evidence about WRITE cost. The write paths are measured
 * next, because those are the ones a harvest runs and the ones contention would actually hit.
 */
const writes = await measureMemoryWrites()
process.stdout.write('\n── WRITE paths (these are the ones that take the lock) ──\n')
for (const [label, trace] of Object.entries(writes)) {
  process.stdout.write(`  ${label}: ${trace.total} acquisition(s)\n`)
  for (const entry of trace.byPath.slice(0, 6)) {
    process.stdout.write(`    ${entry.count.toString().padStart(3)}  ${entry.path.split(/[\\/]/u).slice(-2).join('/')}\n`)
  }
}

if (JSON_OUT !== undefined) {
  writeFileSync(
    JSON_OUT,
    `${JSON.stringify({ env: { node: process.version, platform: process.platform }, preStep, harvest }, null, 2)}\n`,
    'utf8',
  )
  process.stdout.write(`\nraw json -> ${JSON_OUT}\n`)
}
