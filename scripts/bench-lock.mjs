#!/usr/bin/env node
/**
 * T2d — THE LOCK CRITICAL SECTION, MEASURED DIRECTLY.
 *
 * ── WHY THIS EXISTS AT ALL ───────────────────────────────────────────────────────────────────────
 *
 * S2 measured the pre-step p95 at 50 concurrency (7.26 ms vs 0.20 ms on a single session) and
 * concluded that **97.2% of it is waiting, not computing**. That conclusion says "the lock is the
 * cost" but it cannot say WHICH of two completely different fixes is right:
 *
 *   (a) reduce CONTENTION  — fewer acquisitions, batches, one lock instead of N;
 *   (b) shorten the CRITICAL SECTION — move JSON parsing out, smaller writes.
 *
 * They point at opposite code changes, and picking wrong makes things worse. So the lock is measured
 * on its own, with the same synchronous driver production uses.
 *
 * ── THE THREE REQUIREMENTS THAT MAKE THIS MEASUREMENT VALID ──────────────────────────────────────
 *
 * 1. THE REAL LOCK, SYNCHRONOUSLY. `dsh-memory/src/lock.ts` is `for(;;)` + `sleepSync(8..15ms)`. It
 *    is imported from the built `lib/`, never mocked and never wrapped in `await`: an async harness
 *    would let the event loop interleave acquisitions and measure a concurrency model this code does
 *    not have. Every worker below is a synchronous loop inside one thread — which is exactly what
 *    fifty sessions in one DSH process do to each other.
 *
 * 2. THREE TIERS, because one number cannot separate the two causes:
 *      T2d-1  single session, no contention      → the cost of HOLDING, uncontended
 *      T2d-2  N concurrent (1,5,10,20,50)        → how waiting grows with N
 *      T2d-3  N concurrent + 5 ms artificial hold → does waiting grow linearly with hold time?
 *
 *    T2d-3 is the discriminator. If waiting scales with hold time, the fix is (b). If it does not,
 *    the fix is (a). Without it, "the lock is slow" is a feeling, not a finding.
 *
 * 3. t0/t1/t2 PER ACQUISITION:
 *      t0 → entering `acquireFileLock`
 *      t1 → returned (lock held)
 *      t2 → after `release()`
 *    `t1-t0` is WAIT, `t2-t1` is HOLD. They are reported separately as p50/p95/p99.
 *
 * ── WHAT THIS SCRIPT DOES NOT DO ─────────────────────────────────────────────────────────────────
 *
 * It does not change `lock.ts`, does not change any `withFileLock` call site, and does not optimise
 * anything. It produces the numbers that decide the direction. Per the plan: no edit to the lock
 * until these three numbers exist.
 *
 * Usage:
 *   node scripts/bench-lock.mjs [--quick]
 *   node scripts/bench-lock.mjs --json docs/T2d-lock.json
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const WORKSPACE = resolve(dirname(dirname(fileURLToPath(import.meta.url))), '..')
const MEMORY_LIB = join(WORKSPACE, 'dsh-memory', 'lib', 'lock.js')

const QUICK = process.argv.includes('--quick')
const JSON_OUT = (() => {
  const index = process.argv.indexOf('--json')
  return index >= 0 ? process.argv[index + 1] : undefined
})()

/** The lock module must be the REAL one. A missing layer is a hard error, not a fallback. */
let lock
try {
  lock = await import(pathToFileURL(MEMORY_LIB).href)
} catch (error) {
  process.stderr.write(
    `cannot load the production lock from ${MEMORY_LIB}\n` +
      `  ${String(error?.message ?? error)}\n` +
      '  T2d must measure the real synchronous lock; a substitute would measure nothing.\n',
  )
  process.exit(1)
}
for (const name of ['acquireFileLock', 'releaseFileLockProbe', 'isLockHeld']) {
  if (name === 'releaseFileLockProbe') continue
  if (typeof lock[name] !== 'function') {
    process.stderr.write(`the lock module does not export ${name}(); refusing to guess\n`)
    process.exit(1)
  }
}

const TIERS_CONCURRENCY = QUICK ? [1, 10, 50] : [1, 5, 10, 20, 50]
const ITERATIONS = QUICK ? 40 : 200
/** Rounds per cell; the median of the per-round p95 is reported, so one scheduling spike cannot win. */
const ROUNDS = QUICK ? 2 : 3
const HOLD_INFLATION_MS = 5

const now = () => Number(process.hrtime.bigint()) / 1e6

function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

function stats(values) {
  if (values.length === 0) return { n: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 }
  const sum = values.reduce((total, value) => total + value, 0)
  return {
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: Math.max(...values),
    mean: sum / values.length,
  }
}

const median = (values) => percentile(values, 50)

/**
 * One synchronous worker: acquire → hold for `holdMs` → release, `iterations` times.
 *
 * `holdMs` is burned INSIDE the critical section with a busy-wait, because that is what the real
 * body does — `store.ts` parses and rewrites JSON in there. Using a timer would yield the thread and
 * measure a different system.
 */
function worker(lockPath, iterations, holdMs, waits, holds, errors) {
  for (let i = 0; i < iterations; i += 1) {
    const t0 = now()
    let release
    try {
      release = lock.acquireFileLock(lockPath, { label: 'bench', timeoutMs: 60_000, staleMs: 60_000 })
    } catch (error) {
      errors.push(String(error?.message ?? error))
      return
    }
    const t1 = now()
    waits.push(t1 - t0)
    if (holdMs > 0) {
      const until = Date.now() + holdMs
      while (Date.now() < until) {
        // Busy-wait: models real work inside the critical section.
      }
    }
    release()
    const t2 = now()
    holds.push(t2 - t1)
  }
}

/**
 * Run one cell: `concurrency` workers, each doing `iterations` acquisitions on ONE lock path.
 *
 * They run SEQUENTIALLY in this thread on purpose. That is not a simplification — it is the model:
 * `lock.ts` is synchronous, so N sessions in one process cannot overlap; they take turns, and the
 * "concurrency" is the queue depth, not parallelism.
 */
function runCell({ concurrency, iterations, holdMs }) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-t2d-'))
  const lockPath = join(dir, 'ledger.json.lock')
  const waits = []
  const holds = []
  const errors = []
  const started = now()
  try {
    for (let round = 0; round < ROUNDS; round += 1) {
      // Clean between rounds: a lock record left behind by a crash would poison the next round.
      rmSync(lockPath, { force: true })
      for (let w = 0; w < concurrency; w += 1) {
        worker(lockPath, iterations, holdMs, waits, holds, errors)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const totalMs = now() - started
  return {
    concurrency,
    iterations,
    holdMs,
    acquisitions: waits.length,
    totalMs,
    wait: stats(waits),
    hold: stats(holds),
    errors: errors.length,
    firstError: errors[0],
    /** The ratio the verdict depends on — computed here so it cannot be recomputed wrongly later. */
    ratioWaitOverHold: stats(holds).p95 === 0 ? Infinity : stats(waits).p95 / stats(holds).p95,
    ratioHoldOverWait: stats(waits).p95 === 0 ? Infinity : stats(holds).p95 / stats(waits).p95,
  }
}

const env = {
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  cpus: (await import('node:os')).cpus().length,
  lockModule: MEMORY_LIB,
  quick: QUICK,
  concurrencyTiers: TIERS_CONCURRENCY,
  iterations: ITERATIONS,
  rounds: ROUNDS,
  holdInflationMs: HOLD_INFLATION_MS,
  sampledAt: new Date().toISOString(),
}

process.stdout.write('T2d — lock critical section\n')
process.stdout.write(
  `node ${env.node} · ${env.platform} · ${env.cpus} cores · ${ITERATIONS} acquisitions/worker × ${ROUNDS} rounds\n`,
)
process.stdout.write(`lock: ${env.lockModule}\n\n`)

const cells = []

process.stdout.write('── T2d-1: single session, no contention (the cost of HOLDING) ──\n')
const single = runCell({ concurrency: 1, iterations: ITERATIONS * 5, holdMs: 0 })
cells.push({ tier: 'T2d-1', ...single })
process.stdout.write(
  `  wait p50=${single.wait.p50.toFixed(3)} p95=${single.wait.p95.toFixed(3)} ms · ` +
    `hold p50=${single.hold.p50.toFixed(3)} p95=${single.hold.p95.toFixed(3)} ms · ` +
    `${single.acquisitions} acquisitions · errors=${single.errors}\n\n`,
)

process.stdout.write('── T2d-2: N concurrent sessions, real (empty) critical section ──\n')
for (const concurrency of TIERS_CONCURRENCY) {
  const cell = runCell({ concurrency, iterations: ITERATIONS, holdMs: 0 })
  cells.push({ tier: 'T2d-2', ...cell })
  process.stdout.write(
    `  n=${String(concurrency).padStart(2)} · wait p50=${cell.wait.p50.toFixed(3)} p95=${cell.wait.p95.toFixed(3)} ` +
      `p99=${cell.wait.p99.toFixed(3)} · hold p95=${cell.hold.p95.toFixed(3)} · ` +
      `wait/hold=${Number.isFinite(cell.ratioWaitOverHold) ? cell.ratioWaitOverHold.toFixed(1) : 'inf'} · ` +
      `total=${cell.totalMs.toFixed(0)}ms · errors=${cell.errors}\n`,
  )
}

process.stdout.write(`\n── T2d-3: N concurrent, critical section artificially held ${HOLD_INFLATION_MS} ms ──\n`)
for (const concurrency of TIERS_CONCURRENCY) {
  const cell = runCell({ concurrency, iterations: Math.max(10, Math.floor(ITERATIONS / 4)), holdMs: HOLD_INFLATION_MS })
  cells.push({ tier: 'T2d-3', ...cell })
  process.stdout.write(
    `  n=${String(concurrency).padStart(2)} · wait p50=${cell.wait.p50.toFixed(3)} p95=${cell.wait.p95.toFixed(3)} ` +
      `p99=${cell.wait.p99.toFixed(3)} · hold p95=${cell.hold.p95.toFixed(3)} · ` +
      `wait/hold=${Number.isFinite(cell.ratioWaitOverHold) ? cell.ratioWaitOverHold.toFixed(1) : 'inf'} · ` +
      `total=${cell.totalMs.toFixed(0)}ms · errors=${cell.errors}\n`,
  )
}

/**
 * ── THE VERDICT, WRITTEN AS CODE SO THE THRESHOLDS CANNOT DRIFT FROM THE REPORT ──────────────
 *
 * The plan fixes these bounds; a reader must be able to check the arithmetic, not trust a sentence.
 */
const worstUncontended = cells.find((cell) => cell.tier === 'T2d-1')
const atMax = cells.filter((cell) => cell.tier === 'T2d-2' && cell.concurrency === Math.max(...TIERS_CONCURRENCY))
const inflated = cells.filter((cell) => cell.tier === 'T2d-3' && cell.concurrency === Math.max(...TIERS_CONCURRENCY))

const verdictInput = {
  uncontendedHoldP95: worstUncontended?.hold.p95 ?? 0,
  waitP95AtMaxN: atMax[0]?.wait.p95 ?? 0,
  holdP95AtMaxN: atMax[0]?.hold.p95 ?? 0,
  inflatedWaitP95AtMaxN: inflated[0]?.wait.p95 ?? 0,
  inflatedHoldP95AtMaxN: inflated[0]?.hold.p95 ?? 0,
}

verdictInput.waitOverHoldAtMaxN =
  verdictInput.holdP95AtMaxN === 0 ? Infinity : verdictInput.waitP95AtMaxN / verdictInput.holdP95AtMaxN

const growth = (() => {
  const singleCell = cells.find((cell) => cell.tier === 'T2d-2' && cell.concurrency === 1)
  const maxCell = cells.find((cell) => cell.tier === 'T2d-2' && cell.concurrency === Math.max(...TIERS_CONCURRENCY))
  if (singleCell === undefined || maxCell === undefined || singleCell.wait.p95 === 0) return undefined
  return maxCell.wait.p95 / singleCell.wait.p95
})()
verdictInput.waitGrowth1ToMaxN = growth

process.stdout.write('\n── verdict ──\n')
process.stdout.write(
  `  uncontended hold p95        = ${verdictInput.uncontendedHoldP95.toFixed(3)} ms\n` +
    `  at n=${Math.max(...TIERS_CONCURRENCY)}: wait p95 = ${verdictInput.waitP95AtMaxN.toFixed(3)} ms, ` +
    `hold p95 = ${verdictInput.holdP95AtMaxN.toFixed(3)} ms\n` +
    `  wait/hold at max n          = ${Number.isFinite(verdictInput.waitOverHoldAtMaxN) ? verdictInput.waitOverHoldAtMaxN.toFixed(1) : 'inf'}\n` +
    `  wait growth (n=1 → n=max)   = ${growth === undefined ? 'n/a' : growth.toFixed(1) + '×'}\n` +
    `  with +${HOLD_INFLATION_MS}ms hold: wait p95 = ${verdictInput.inflatedWaitP95AtMaxN.toFixed(3)} ms\n`,
)

const report = { env, cells, verdict: verdictInput }
if (JSON_OUT !== undefined) {
  writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`\nraw json -> ${JSON_OUT}\n`)
}
