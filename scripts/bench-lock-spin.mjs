#!/usr/bin/env node
/**
 * T2e — THE SPIN MEASUREMENT: how much CPU does waiting for a lock actually burn?
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
 *
 * T2d found that `dsh-memory`'s `sleepSync` busy-waits:
 *
 *     const until = Date.now() + ms
 *     while (Date.now() < until) {}
 *
 * and observed `hold p95 = 2004 ms` in a cell whose critical section was EMPTY — impossible unless
 * the process was being starved rather than waiting. That is a hypothesis. This script replaces it
 * with a number: `process.cpuUsage()` taken before and after a wait, so "the waiter burned N ms of
 * CPU while waiting M ms" becomes measurable.
 *
 * ── THE COMPARISON THAT MATTERS ─────────────────────────────────────────────────────────────────
 *
 * The two lock implementations in this ecosystem do NOT wait the same way:
 *
 *   dsh-memory/src/lock.ts   `while (Date.now() < until) {}`         — SPINS, burns a core
 *   dsh-graft-slice/src/core/txn.ts  `Atomics.wait(new Int32Array(…), 0, 0, ms)` — REAL sleep
 *
 * So the same measurement is run against both. If the graft version burns ~0 CPU while the memory
 * version burns ~100%, then "replace the spin" is not a design debate: it is copying an
 * implementation this repository already ships and has already tested.
 *
 * ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────────────────────────
 *
 * It does not change any production file. It imports both `sleepSync` implementations, calls them,
 * and reports CPU time. Nothing in `lock.ts` or `core/txn.ts` is touched.
 *
 * Usage: node scripts/bench-lock-spin.mjs [--json out.json]
 */

import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const PARADISE = resolve(dirname(SELF), '..')
const WORKSPACE = resolve(PARADISE, '..')

const JSON_OUT = (() => {
  const index = process.argv.indexOf('--json')
  return index >= 0 ? process.argv[index + 1] : undefined
})()

/** A fixed, small wait: the ratio matters, not the absolute. */
const WAIT_MS = 50
const REPEATS = 20

const cpu = () => {
  const usage = process.cpuUsage()
  return (usage.user + usage.system) / 1000 // µs → ms
}
const wall = () => Number(process.hrtime.bigint()) / 1e6

/**
 * Measure one sleep implementation.
 *
 * `cpuMs` is CPU consumed; `wallMs` is elapsed. Their ratio is the answer: a true sleep is ~0%,
 * a busy-wait is ~100% (one core).
 */
function measure(label, sleeper) {
  // Warm up once: the first call pays module init / JIT, which is not what we are measuring.
  sleeper(WAIT_MS)

  const samples = []
  for (let i = 0; i < REPEATS; i += 1) {
    const cpuBefore = cpu()
    const wallBefore = wall()
    sleeper(WAIT_MS)
    const wallElapsed = wall() - wallBefore
    const cpuElapsed = cpu() - cpuBefore
    samples.push({
      wallMs: wallElapsed,
      cpuMs: cpuElapsed,
      ratio: wallElapsed === 0 ? 0 : cpuElapsed / wallElapsed,
    })
  }
  const median = (key) => {
    const values = samples.map((sample) => sample[key]).sort((a, b) => a - b)
    return values[Math.floor(values.length / 2)]
  }
  return {
    label,
    waitMs: WAIT_MS,
    repeats: REPEATS,
    medianWallMs: median('wallMs'),
    medianCpuMs: median('cpuMs'),
    medianRatio: median('ratio'),
    maxRatio: Math.max(...samples.map((sample) => sample.ratio)),
    samples,
  }
}

/**
 * Load the PRODUCTION implementations. Both are imported, neither is re-implemented here: a
 * re-implementation would measure this script instead of the code that ships.
 */
async function loadMemorySleeper() {
  // `sleepSync` is module-private in dsh-memory/src/lock.ts — it is not exported. So the wait is
  // reproduced through the public API: acquiring a lock that is HELD forces the waiter into the
  // retry loop. That is the honest way to measure it without editing the file.
  const lockModule = await import(pathToFileURL(join(WORKSPACE, 'dsh-memory', 'lib', 'lock.js')).href)
  return { lockModule }
}

async function loadGraftSleeper() {
  const txn = await import(pathToFileURL(join(WORKSPACE, 'dsh-graft-slice', 'index.js')).href)
  if (typeof txn.sleepSync !== 'function') {
    throw new Error('graft does not export sleepSync — measured comparison impossible')
  }
  return txn.sleepSync
}

process.stdout.write('T2e — CPU cost of waiting for a lock\n')
process.stdout.write(`node ${process.version} · ${process.platform} ${process.arch}\n`)
process.stdout.write(`wait = ${WAIT_MS} ms × ${REPEATS} repeats, median reported\n\n`)

const results = []

/* ── 1. the control: no sleep at all, so the measurement floor is visible ─────────────────────── */
results.push(measure('control (no wait)', () => {}))
process.stdout.write(
  `control        wall=${results[0].medianWallMs.toFixed(2)}ms cpu=${results[0].medianCpuMs.toFixed(3)}ms ` +
    `ratio=${(results[0].medianRatio * 100).toFixed(1)}%\n`,
)

/* ── 2. graft: Atomics.wait ──────────────────────────────────────────────────────────────────── */
const graftSleep = await loadGraftSleeper()
results.push(measure('graft txn.sleepSync (Atomics.wait)', graftSleep))
const graft = results[1]
process.stdout.write(
  `graft          wall=${graft.medianWallMs.toFixed(2)}ms cpu=${graft.medianCpuMs.toFixed(3)}ms ` +
    `ratio=${(graft.medianRatio * 100).toFixed(1)}%\n`,
)

/* ── 3. memory: the busy-wait, reached through its public API ────────────────────────────────── */
const { lockModule } = await loadMemorySleeper()
const { mkdtempSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')

const dir = mkdtempSync(join(tmpdir(), 'dsh-t2e-'))
const lockPath = join(dir, 'held.json.lock')

/**
 * Force the memory lock into its retry loop: hold the lock, then try to acquire it with a SHORT
 * timeout, and measure the CPU burned while it waits and finally throws.
 *
 * A throw is expected and is the point — the wait happens before it.
 */
function memorySpinWait(ms) {
  const release = lockModule.acquireFileLock(lockPath, { label: 'holder', timeoutMs: 10_000, staleMs: 30_000 })
  try {
    lockModule.acquireFileLock(lockPath, { label: 'waiter', timeoutMs: ms, staleMs: 30_000 })
  } catch {
    // expected: the timeout is the measurement window
  } finally {
    release()
  }
}

try {
  // Warm up and confirm it really blocks (a no-op would report 0 for everything).
  memorySpinWait(WAIT_MS)
  results.push(measure('memory lock retry loop (busy-wait)', memorySpinWait))
  const memory = results[2]
  process.stdout.write(
    `memory         wall=${memory.medianWallMs.toFixed(2)}ms cpu=${memory.medianCpuMs.toFixed(3)}ms ` +
      `ratio=${(memory.medianRatio * 100).toFixed(1)}%\n`,
  )
  process.stdout.write(
    `\nCPU burned per ${WAIT_MS} ms of waiting: ` +
      `graft ${graft.medianCpuMs.toFixed(2)} ms vs memory ${memory.medianCpuMs.toFixed(2)} ms ` +
      `(${(memory.medianCpuMs / Math.max(0.001, graft.medianCpuMs)).toFixed(1)}× more)\n`,
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (JSON_OUT !== undefined) {
  writeFileSync(
    JSON_OUT,
    `${JSON.stringify({ env: { node: process.version, platform: process.platform, cpus: (await import('node:os')).cpus().length }, waitMs: WAIT_MS, repeats: REPEATS, results }, null, 2)}\n`,
    'utf8',
  )
  process.stdout.write(`\nraw json -> ${JSON_OUT}\n`)
}
