#!/usr/bin/env node
/**
 * T2d-contend — REAL contention, across REAL processes.
 *
 * ── WHY THE IN-PROCESS VERSION (bench-lock.mjs) COULD NOT MEASURE THIS ─────────────────────────
 *
 * `dsh-memory/src/lock.ts` is synchronous: `for(;;)` with `sleepSync(8..15ms)` between attempts.
 * Running N workers in ONE thread therefore serialises them completely — worker 1 finishes all its
 * acquisitions before worker 2 starts one. Nothing ever overlaps, so nothing ever queues.
 *
 * Measured proof, from the first run: wait/hold stayed at 1.5–1.6 for n=1, 5, 10, 20 AND 50, and
 * stayed at 0.5 when the critical section was artificially held for 5 ms. A metric that does not
 * move when you multiply the queue depth by fifty and the service time by five is not measuring
 * queueing. It was measuring "the first acquisition attempt succeeded", i.e. the un-contended cost.
 *
 * That is not a small caveat — it is the difference between "the lock is the bottleneck" and "the
 * lock is fine". So contention is measured HERE, with child processes that genuinely hold and wait
 * on the same lock file at the same time.
 *
 * ── WHAT IS MEASURED PER ACQUISITION ────────────────────────────────────────────────────────────
 *
 *   t0 → entering acquireFileLock
 *   t1 → returned (lock held)            t1-t0 = WAIT
 *   t2 → after release()                 t2-t1 = HOLD
 *
 * Each child reports its own samples as JSON on stdout; this parent aggregates. Children are
 * STARTED TOGETHER via a barrier file so their work overlaps in wall-clock time.
 *
 * Usage:
 *   node scripts/bench-lock-contend.mjs [--quick]
 *   node scripts/bench-lock-contend.mjs --json docs/T2d-contend.json
 */

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const WORKSPACE = resolve(dirname(SELF), '..', '..')
const MEMORY_LIB = join(WORKSPACE, 'dsh-memory', 'lib', 'lock.js')

const QUICK = process.argv.includes('--quick')
const JSON_OUT = (() => {
  const index = process.argv.indexOf('--json')
  return index >= 0 ? process.argv[index + 1] : undefined
})()

const CHILD = process.argv.includes('--child')

/* ── child mode: do the work, print samples as JSON ─────────────────────────────────────────── */
if (CHILD) {
  const lockPath = process.argv[process.argv.indexOf('--lock') + 1]
  const iterations = Number(process.argv[process.argv.indexOf('--iterations') + 1])
  const holdMs = Number(process.argv[process.argv.indexOf('--hold') + 1])
  const barrierPath = process.argv[process.argv.indexOf('--barrier') + 1]

  const lock = await import(`file:///${MEMORY_LIB.replace(/\\/gu, '/')}`)
  const now = () => Number(process.hrtime.bigint()) / 1e6

  // Wait for the parent's go signal so every child starts contending at the same moment.
  const spinUntil = Date.now() + 30_000
  while (!existsSync(barrierPath) && Date.now() < spinUntil) {
    const until = Date.now() + 2
    while (Date.now() < until) {
      /* spin */
    }
  }

  const waits = []
  const holds = []
  let errors = 0
  for (let i = 0; i < iterations; i += 1) {
    const t0 = now()
    let release
    try {
      release = lock.acquireFileLock(lockPath, { label: 'contend', timeoutMs: 120_000, staleMs: 120_000 })
    } catch {
      errors += 1
      break
    }
    const t1 = now()
    waits.push(t1 - t0)
    if (holdMs > 0) {
      const until = Date.now() + holdMs
      while (Date.now() < until) {
        /* model real work inside the critical section */
      }
    }
    release()
    holds.push(now() - t1)
  }
  process.stdout.write(JSON.stringify({ waits, holds, errors }))
  process.exit(0)
}

/* ── parent mode ────────────────────────────────────────────────────────────────────────────── */
function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

function stats(values) {
  if (values.length === 0) return { n: 0, p50: 0, p95: 0, p99: 0, max: 0 }
  return {
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: Math.max(...values),
  }
}

const CONCURRENCY = QUICK ? [1, 5, 20] : [1, 5, 10, 20, 50]
const ITERATIONS = QUICK ? 20 : 60
const HOLD_INFLATION_MS = 5
const ROUNDS = QUICK ? 1 : 2

async function runCell({ concurrency, iterations, holdMs }) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-t2d-c-'))
  const lockPath = join(dir, 'ledger.json.lock')
  const barrierPath = join(dir, 'go')
  const waits = []
  const holds = []
  let errors = 0
  let failedChildren = 0
  /** Why a child produced nothing — printed, never swallowed into a zero sample. */
  const childErrors = []

  try {
    for (let round = 0; round < ROUNDS; round += 1) {
      rmSync(lockPath, { force: true })
      rmSync(barrierPath, { force: true })
      const children = []
      for (let i = 0; i < concurrency; i += 1) {
        children.push(
          new Promise((resolvePromise) => {
            const child = spawn(
              process.execPath,
              [SELF, '--child', '--lock', lockPath, '--iterations', String(iterations), '--hold', String(holdMs), '--barrier', barrierPath],
              { stdio: ['ignore', 'pipe', 'ignore'] },
            )
            let out = ''
            child.stdout.on('data', (chunk) => {
              out += chunk
            })
            child.on('close', () => {
              /**
               * THE CHILD ALSO PRINTS A BANNER — `[dsh-paradise] layer version …` — because resolving
               * the lease layer logs once. `JSON.parse(out)` therefore threw on EVERY child, and the
               * parent counted them all as `failed`, reporting 0 samples as if the lock had no cost.
               *
               * That is the exact failure this repo has a note about: "a wrong 0 is worse than a
               * missing row". The parse now takes the LAST line that looks like JSON, and a child
               * that produces none is counted loudly instead of contributing a silent zero.
               */
              const line = out
                .split('\n')
                .map((entry) => entry.trim())
                .filter((entry) => entry.startsWith('{') && entry.endsWith('}'))
                .pop()
              try {
                if (line === undefined) throw new Error('no JSON line on stdout')
                const parsed = JSON.parse(line)
                waits.push(...parsed.waits)
                holds.push(...parsed.holds)
                errors += parsed.errors
              } catch (error) {
                failedChildren += 1
                childErrors.push(`${String(error?.message ?? error)} :: ${out.slice(-200).replace(/\s+/gu, ' ')}`)
              }
              resolvePromise()
            })
          }),
        )
      }
      // Release the barrier once every child has had time to load the module and reach the spin.
      // A fixed wait is honest here: a child that is not spinning yet simply joins the queue late,
      // which understates contention rather than inventing it.
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 1500))
      writeFileSync(barrierPath, 'go', 'utf8')
      await Promise.all(children)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  return {
    concurrency,
    iterations,
    holdMs,
    acquisitions: waits.length,
    failedChildren,
    errors,
    childErrors,
    wait: stats(waits),
    hold: stats(holds),
  }
}

process.stdout.write('T2d-contend — real cross-process contention on the production lock\n')
process.stdout.write(`lock: ${MEMORY_LIB}\n`)
process.stdout.write(`per child: ${ITERATIONS} acquisitions · ${ROUNDS} round(s)\n\n`)

const cells = []

process.stdout.write('── uncontended: 1 process, 1 session ──\n')
cells.push({ tier: 'C1-uncontended', ...(await runCell({ concurrency: 1, iterations: ITERATIONS * 5, holdMs: 0 })) })
const c1 = cells[0]
process.stdout.write(
  `  wait p50=${c1.wait.p50.toFixed(3)} p95=${c1.wait.p95.toFixed(3)} · hold p50=${c1.hold.p50.toFixed(3)} p95=${c1.hold.p95.toFixed(3)}\n\n`,
)

process.stdout.write('── C2: N real processes contending, empty critical section ──\n')
for (const concurrency of CONCURRENCY) {
  const cell = { tier: 'C2-contend', ...(await runCell({ concurrency, iterations: ITERATIONS, holdMs: 0 })) }
  cells.push(cell)
  process.stdout.write(
    `  n=${String(concurrency).padStart(2)} · wait p50=${cell.wait.p50.toFixed(2)} p95=${cell.wait.p95.toFixed(2)} ` +
      `p99=${cell.wait.p99.toFixed(2)} max=${cell.wait.max.toFixed(1)} · hold p95=${cell.hold.p95.toFixed(2)} · ` +
      `wait/hold=${(cell.wait.p95 / (cell.hold.p95 || 1)).toFixed(1)} · n=${cell.acquisitions} failed=${cell.failedChildren}\n`,
  )
}

process.stdout.write(`\n── C3: N real processes, critical section held ${HOLD_INFLATION_MS} ms ──\n`)
for (const concurrency of CONCURRENCY) {
  const cell = {
    tier: 'C3-inflated',
    ...(await runCell({ concurrency, iterations: Math.max(10, Math.floor(ITERATIONS / 3)), holdMs: HOLD_INFLATION_MS })),
  }
  cells.push(cell)
  process.stdout.write(
    `  n=${String(concurrency).padStart(2)} · wait p50=${cell.wait.p50.toFixed(2)} p95=${cell.wait.p95.toFixed(2)} ` +
      `p99=${cell.wait.p99.toFixed(2)} max=${cell.wait.max.toFixed(1)} · hold p95=${cell.hold.p95.toFixed(2)} · ` +
      `wait/hold=${(cell.wait.p95 / (cell.hold.p95 || 1)).toFixed(1)} · n=${cell.acquisitions} failed=${cell.failedChildren}\n`,
  )
}

const maxN = Math.max(...CONCURRENCY)
const atMax = cells.find((cell) => cell.tier === 'C2-contend' && cell.concurrency === maxN)
const inflatedMax = cells.find((cell) => cell.tier === 'C3-inflated' && cell.concurrency === maxN)
const uncontended = cells[0]

const verdict = {
  uncontendedWaitP95: uncontended.wait.p95,
  uncontendedHoldP95: uncontended.hold.p95,
  waitP95AtMaxN: atMax?.wait.p95 ?? 0,
  holdP95AtMaxN: atMax?.hold.p95 ?? 0,
  waitGrowth1ToMaxN: uncontended.wait.p95 === 0 ? Infinity : (atMax?.wait.p95 ?? 0) / uncontended.wait.p95,
  inflatedWaitP95AtMaxN: inflatedMax?.wait.p95 ?? 0,
  inflatedHoldP95AtMaxN: inflatedMax?.hold.p95 ?? 0,
  inflateFactor: HOLD_INFLATION_MS,
}
verdict.waitOverHoldAtMaxN = (verdict.holdP95AtMaxN || 1) === 0 ? Infinity : verdict.waitP95AtMaxN / (verdict.holdP95AtMaxN || 1)
verdict.inflatedWaitOverHold = verdict.inflatedWaitP95AtMaxN / (verdict.inflatedHoldP95AtMaxN || 1)
verdict.waitGrowthUnderInflation =
  atMax === undefined || atMax.wait.p95 === 0 ? Infinity : verdict.inflatedWaitP95AtMaxN / atMax.wait.p95

process.stdout.write('\n── verdict ──\n')
process.stdout.write(
  `  uncontended wait p95          = ${verdict.uncontendedWaitP95.toFixed(2)} ms\n` +
    `  at n=${maxN}: wait p95 = ${verdict.waitP95AtMaxN.toFixed(2)} ms, hold p95 = ${verdict.holdP95AtMaxN.toFixed(2)} ms\n` +
    `  wait/hold at n=${maxN}          = ${verdict.waitOverHoldAtMaxN.toFixed(1)}\n` +
    `  wait growth 1 → ${maxN}          = ${verdict.waitGrowth1ToMaxN.toFixed(1)}×\n` +
    `  hold ×${HOLD_INFLATION_MS}ms: wait p95     = ${verdict.inflatedWaitP95AtMaxN.toFixed(2)} ms ` +
    `(growth vs empty section: ${verdict.waitGrowthUnderInflation.toFixed(1)}×)\n`,
)

/**
 * ── STARVATION MUST BE REPORTED, NOT AVERAGED AWAY ────────────────────────────────────────────
 *
 * A cell that planned `N × iterations` acquisitions and collected far fewer did not merely measure a
 * slow lock: some children ran out of their wait budget and THREW. Reporting only the samples that
 * arrived would describe a system that kept up, when the truth is that it did not.
 */
process.stdout.write('\n── completeness (a cell that collected few samples did not keep up) ──\n')
let anyIncomplete = false
for (const cell of cells) {
  const planned = cell.concurrency * cell.iterations * (cell.tier === 'C1-uncontended' ? 1 : ROUNDS)
  const ratio = planned === 0 ? 1 : cell.acquisitions / planned
  if (ratio < 0.99 || cell.failedChildren > 0 || cell.errors > 0) {
    anyIncomplete = true
    process.stdout.write(
      `  ${cell.tier} n=${cell.concurrency} hold=${cell.holdMs}ms: collected ${cell.acquisitions}/${planned} ` +
        `(${(ratio * 100).toFixed(0)}%), acquisition errors=${cell.errors}, failed children=${cell.failedChildren}\n`,
    )
    for (const message of cell.childErrors.slice(0, 2)) process.stdout.write(`    child: ${message}\n`)
  }
}
if (!anyIncomplete) process.stdout.write('  every cell collected all planned acquisitions\n')

/**
 * THE BUSY-WAIT IS ITSELF A CONSUMER.
 *
 * `sleepSync` is `while (Date.now() < until) {}` — it burns a whole core for 8–15 ms per attempt.
 * So N contending processes are not merely queued; they are N spinning threads competing for CPUs.
 * This is reported because it changes how the numbers must be read: at N approaching the core count,
 * part of the "wait" is CPU starvation rather than lock queueing, and a fix that only reorders lock
 * acquisitions would not address it.
 */
process.stdout.write(
  `\n  NOTE: sleepSync busy-waits, so each waiting process holds a core. ` +
    `n=${maxN} on ${(await import('node:os')).cpus().length} cores ⇒ part of the wait is CPU starvation, not only lock queueing.\n`,
)

if (JSON_OUT !== undefined) {
  writeFileSync(JSON_OUT, `${JSON.stringify({ env: { node: process.version, platform: process.platform, cpus: (await import('node:os')).cpus().length }, cells, verdict }, null, 2)}\n`, 'utf8')
  process.stdout.write(`\nraw json -> ${JSON_OUT}\n`)
}
