#!/usr/bin/env node
/**
 * S2 — PRE-STEP PERFORMANCE BASELINE. **This script adds a file; it modifies no source.**
 *
 * `node scripts/bench-prestep.mjs [--quick] [--expose-gc]`
 *
 * ── WHAT IT MEASURES, AND WHY THESE THREE TIERS ────────────────────────────────────────────────
 *
 * The question is not "how fast is pre-step" but "of that time, how much is the lock queue, how much
 * is real computation, and how much is the file system". Three tiers answer the third part by
 * subtraction:
 *
 *   T1 graft-only   graft's pre-step waterfall with NO memory plugin attached — the floor.
 *   T2 json         graft + memory, `storageTier: 'json'` (the shipped default).
 *   T3 sqlite       graft + memory, `storageTier: 'sqlite'`.
 *
 * ── WHY THE TIER NAMES DIFFER FROM THE BRIEF ──────────────────────────────────────────────────
 *
 * The brief asked for `'file'` vs `'memory'`. Measured: `MemoryConfig.storageTier` is
 * `'json' | 'sqlite'` (`src/index.ts:213`) — there is no `'memory'` tier. Reporting a tier that does
 * not exist would produce a comparison table nobody could reproduce, so this measures the two tiers
 * the code actually has.
 *
 * ── WHY `semanticFilter: false` EVERYWHERE ────────────────────────────────────────────────────
 *
 * With it on, memory's retrieval calls the host LLM to adjudicate candidates. That is a NETWORK round
 * trip whose p99 is measured in seconds and which swamps every local cost this baseline exists to
 * capture. Measured separately (if ever needed) it belongs in its own report.
 *
 * ── THE EVENT COUNT IS PART OF THE INPUT ─────────────────────────────────────────────────────
 *
 * `checkSafeHarbor` and the task-state extractor walk EVERY event. A three-event fixture would make
 * them free and the numbers meaningless, so every session here is seeded with `EVENTS_PER_SESSION`
 * events (default 200) built to look like a real conversation.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

/**
 * THE BOOT DRILL IS OPT-OUT HERE, AND THAT IS THE SANCTIONED PATH.
 *
 * `assertHostCapabilitiesOnBoot` refuses to mount when the host lacks `sessionController.prompt` etc.
 * The fake harness is a deliberately bare host — it has no prompt channel because these benchmarks never
 * ignite anything; they call `agent/pre-step` directly. `PARADISE_STRICT_HOST=0` is the documented
 * switch for "a deliberately bare profile" (see `assert-capabilities.ts`), so it is set BEFORE the
 * bundle is imported rather than by weakening the assertion.
 */
process.env.PARADISE_STRICT_HOST = '0'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const workspace = join(repoRoot, '..')
const require = createRequire(import.meta.url)

/**
 * Windows: a bare absolute path is not a valid ESM specifier (`ERR_UNSUPPORTED_ESM_URL_SCHEME`,
 * protocol `d:`). Everything imported dynamically must go through `pathToFileURL`.
 */
const fileUrl = (path) => pathToFileURL(path).href

const QUICK = process.argv.includes('--quick')

const CONCURRENCY = QUICK ? [1, 10, 50] : [1, 5, 10, 20, 50]
const ROUNDS = QUICK ? 10 : 50
const WARMUP = QUICK ? 3 : 10
const EVENTS_PER_SESSION = 200
const REPEATS = 3

const TIERS = [
  { name: 'T1-graft-only', attachMemory: false },
  { name: 'T2-json', attachMemory: true, memoryConfig: { storageTier: 'json', semanticFilter: false, retrieval: true } },
  { name: 'T3-sqlite', attachMemory: true, memoryConfig: { storageTier: 'sqlite', semanticFilter: false, retrieval: true } },
  /**
   * ── T2b / T2c: THE SUPERLINEARITY PROBE (added 2026-11-09 on request) ─────────────────────────
   *
   * Measured and unexplained: memory's contribution grew 38× (0.08 → 3.05 ms) while concurrency grew
   * 50×. That is not linear, and the cause decides what G5 should optimise:
   *
   *   if it is COMPUTATION  → the index is rebuilt per call (cache it);
   *   if it is QUEUING      → the critical section is too long (shorten it).
   *
   * T2b isolates the plugin's NON-retrieval cost: memory is mounted (`retrieval: false`), so whatever
   * it still does at pre-step is measured without the search path.
   *
   * T2c runs the SAME retrieval work on ONE session, 50 rounds — no cross-session queueing at all.
   * Comparing its per-round cost with T2@n=50's per-round cost splits the two hypotheses: if a single
   * session is much cheaper per round, the 50× number is dominated by waiting, not working.
   *
   * T2c reuses `runCell` with concurrency 1 and ROUNDS=50, which is exactly "50 rounds on one session".
   */
  { name: 'T2b-no-retrieval', attachMemory: true, memoryConfig: { storageTier: 'json', semanticFilter: false, retrieval: false } },
  { name: 'T2c-single-session', attachMemory: true, memoryConfig: { storageTier: 'json', semanticFilter: false, retrieval: true }, singleSessionRounds: true },
]

/* ── the fake host ──────────────────────────────────────────────────────────────────────────── */

const harness = await import(fileUrl(join(workspace, 'dsh-graft-slice', 'test', 'fake-harness.mjs')))
const { makeCtx, makeSourceLog, dispatchPreStep } = harness

const graft = await import(fileUrl(join(workspace, 'dsh-graft-slice', 'index.js')))
const memory = await import(fileUrl(join(workspace, 'dsh-memory', 'lib', 'index.js')))

/**
 * One session with a realistic event mix.
 *
 * The proportions matter: `checkSafeHarbor` looks for an unanswered `tool/call` and the extractor
 * reads turns, so a fixture of nothing but `turn/start` would be cheaper than a real log in exactly
 * the paths being measured.
 */
function seedEvents(sessionId, count) {
  const events = []
  let seq = 0
  let turn = 1
  let step = 1
  events.push({ type: 'turn/start', seq: seq++, time: Date.now() - 60_000, data: { turn } })
  events.push({ type: 'step/start', seq: seq++, time: Date.now() - 60_000, data: { turn, step } })
  while (events.length < count) {
    events.push({
      type: 'user/message',
      seq: seq++,
      time: Date.now() - 50_000 + seq,
      data: { message: { role: 'user', id: `u-${seq}`, source: { kind: 'user' }, content: [{ type: 'text', text: `第 ${seq} 条要求：继续处理第 ${turn} 项` }] } },
      surfaceOp: 'append',
    })
    events.push({
      type: 'tool/call',
      seq: seq++,
      time: Date.now() - 49_000 + seq,
      data: { name: seq % 5 === 0 ? 'todo_write' : 'read', callId: `c-${seq}`, args: { path: `src/f${seq}.ts` } },
      surfaceOp: 'append',
    })
    if (seq % 3 !== 0) {
      events.push({
        type: 'tool/result',
        seq: seq++,
        time: Date.now() - 48_000 + seq,
        data: { callId: `c-${seq - 1}`, ok: true, text: `ok ${seq}` },
        surfaceOp: 'append',
      })
    }
    if (seq % 7 === 0) {
      events.push({
        type: 'assistant/message',
        seq: seq++,
        time: Date.now() - 47_000 + seq,
        data: { message: { role: 'assistant', id: `a-${seq}`, content: [{ type: 'text', text: `完成了第 ${turn} 项` }] } },
        surfaceOp: 'append',
      })
      events.push({ type: 'step/end', seq: seq++, time: Date.now() - 46_000 + seq, data: { turn, step } })
      events.push({ type: 'turn/end', seq: seq++, time: Date.now() - 45_000 + seq, data: { turn } })
      turn += 1
      step = 1
      events.push({ type: 'turn/start', seq: seq++, time: Date.now() - 44_000 + seq, data: { turn } })
      events.push({ type: 'step/start', seq: seq++, time: Date.now() - 44_000 + seq, data: { turn, step } })
    }
  }
  events.push({ type: 'turn/end', seq, time: Date.now(), data: { turn } })
  return events
}

/**
 * Build one host context for one (tier, session) pair.
 *
 * A FRESH DIRECTORY PER SESSION: two sessions sharing a `memoryDir` would contend on the same lock file,
 * turning a per-session measurement into a cross-session one.
 */
function buildContext(tier, sessionId, index) {
  const dir = mkdtempSync(join(tmpdir(), `bench-${tier.name}-${index}-`))
  const log = makeSourceLog({ turns: 3, sourceSessionId: sessionId, cwd: `D:\\bench\\s${index}` })
  log.events = seedEvents(sessionId, EVENTS_PER_SESSION)
  const ctx = makeCtx({ sourceLog: log, currentAgentId: sessionId })

  graft.apply(ctx, {
    retireSource: false,
    verifyReadBack: false,
    autoGraft: false,
    modelDrivenGraft: false,
    igniteTarget: false,
    memoryDir: '',
    skillsDir: '',
  })

  if (tier.attachMemory) {
    memory.apply(ctx, {
      memoryDir: join(dir, 'memory'),
      skillsDir: join(dir, 'skills'),
      graftDataDir: join(dir, 'graft'),
      extractor: 'off',
      autoApprove: false,
      retrieval: true,
      ...tier.memoryConfig,
    })
  }
  return { ctx, dir }
}

/* ── measurement ────────────────────────────────────────────────────────────────────────────── */

const percentile = (sorted, p) => {
  if (sorted.length === 0) return 0
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[at]
}

const resourceCount = () => {
  const fn = process.getActiveResourcesInfo
  return typeof fn === 'function' ? fn.call(process).length : -1
}

/** The largest concurrency on the grid — used to give T2c the same total dispatch count. */
const CONCURRENCY_CONST = Math.max(...CONCURRENCY)

/** One (tier, concurrency) cell, repeated REPEATS times; the report keeps the MEDIAN of each statistic. */
async function runCell(tier, concurrency, rounds = ROUNDS) {
  const repeats = []
  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    const built = []
    for (let i = 0; i < concurrency; i += 1) {
      const sessionId = `bench-${tier.name}-${concurrency}-${repeat}-${i}`
      built.push({ sessionId, ...buildContext(tier, sessionId, i) })
    }

    const payloadFor = (sessionId) => ({
      agent: { id: sessionId },
      messages: [{ role: 'user', content: [{ type: 'text', text: '请继续把这一项做完，并说明你改了哪些文件' }] }],
    })

    // warm-up: JIT, lazy module init, first-touch of cache files
    for (let w = 0; w < WARMUP; w += 1) {
      await Promise.all(built.map(({ ctx, sessionId }) => dispatchPreStep(ctx, payloadFor(sessionId))))
    }

    const handlesBefore = resourceCount()
    const latencies = []
    const startedAll = process.hrtime.bigint()
    for (let round = 0; round < rounds; round += 1) {
      await Promise.all(
        built.map(async ({ ctx, sessionId }) => {
          const started = process.hrtime.bigint()
          try {
            await dispatchPreStep(ctx, payloadFor(sessionId))
          } catch {
            // A rejected pre-step is a datum, not a crash: it is counted, not thrown.
          }
          latencies.push(Number(process.hrtime.bigint() - started) / 1e6)
        }),
      )
    }
    const wallMs = Number(process.hrtime.bigint() - startedAll) / 1e6
    const handlesAfter = resourceCount()

    if (global.gc) global.gc()
    const rssMb = process.memoryUsage().rss / (1024 * 1024)

    latencies.sort((a, b) => a - b)
    repeats.push({
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies[latencies.length - 1] ?? 0,
      wallMs,
      rssMb,
      handlesBefore,
      handlesAfter,
      samples: latencies.length,
    })

    for (const { dir } of built) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // a leftover temp dir is not a measurement failure
      }
    }
  }

  const median = (key) => {
    const values = repeats.map((r) => r[key]).sort((a, b) => a - b)
    return values[Math.floor(values.length / 2)]
  }
  return {
    p50: median('p50'),
    p95: median('p95'),
    p99: median('p99'),
    max: median('max'),
    wallMs: median('wallMs'),
    rssMb: median('rssMb'),
    handlesBefore: median('handlesBefore'),
    handlesAfter: median('handlesAfter'),
    samples: repeats[0].samples,
    spreadP95: (() => {
      const values = repeats.map((r) => r.p95)
      const min = Math.min(...values)
      const max = Math.max(...values)
      return min === 0 ? 0 : ((max - min) / min) * 100
    })(),
  }
}

/* ── the two pure hot paths, measured without the harness ───────────────────────────────────── */

/**
 * THE TWO PURE HOT PATHS ARE MEASURED FROM THE **graft** BUNDLE, not from paradise's.
 *
 * A first version asked paradise's entry for them and got `hasHarbor: false`, which read like "the
 * functions do not exist". They do — `src/index.ts:9442` / `:1828`, both `export function`, both present
 * in graft's own bundle (4 / 5 occurrences) and both on its export list (180 exports measured). The bug
 * was in this script: it looked them up on the wrong module. Recorded because a wrong "0" in a baseline
 * report is worse than a missing row.
 */
const graftModule = graft
const graftSources = {
  hasHarbor: typeof graftModule.checkSafeHarbor === 'function',
  hasTaskState: typeof graftModule.extractTaskState === 'function',
  exportCount: Object.keys(graftModule).length,
}

function benchPureFunction(name, fn, events, iterations) {
  if (typeof fn !== 'function') return undefined
  const started = process.hrtime.bigint()
  for (let i = 0; i < iterations; i += 1) {
    try {
      fn(events, i)
    } catch {
      // signature may differ per function; the timing still reflects the call cost, and a thrown
      // call is reported rather than silently summed as zero work.
    }
  }
  const totalMs = Number(process.hrtime.bigint() - started) / 1e6
  return { name, iterations, totalMs, perCallMs: totalMs / iterations }
}

/* ── environment ────────────────────────────────────────────────────────────────────────────── */

const env = {
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  cpus: (() => {
    try {
      return require('node:os').cpus().length
    } catch {
      return -1
    }
  })(),
  cpuModel: (() => {
    try {
      return require('node:os').cpus()[0]?.model ?? 'unknown'
    } catch {
      return 'unknown'
    }
  })(),
  totalRamGb: (() => {
    try {
      return Math.round((require('node:os').totalmem() / 1024 ** 3) * 10) / 10
    } catch {
      return -1
    }
  })(),
  exposeGc: typeof global.gc === 'function',
}

/* ── run ────────────────────────────────────────────────────────────────────────────────────── */

const results = []
for (const tier of TIERS) {
  /**
   * T2c is measured at concurrency 1 ONLY, and its ROUNDS is raised to match the n=50 cell's total
   * dispatch count (50 sessions × 50 rounds = 2500) so the two numbers are comparable per-dispatch
   * rather than per-cell.
   */
  const grid = tier.singleSessionRounds === true ? [1] : CONCURRENCY
  for (const concurrency of grid) {
    const cell = await runCell(tier, concurrency, tier.singleSessionRounds === true ? CONCURRENCY_CONST * ROUNDS : ROUNDS)
    results.push({ tier: tier.name, concurrency, ...cell })
    console.log(
      `${tier.name.padEnd(20)} n=${String(concurrency).padStart(2)}  p50=${cell.p50.toFixed(2).padStart(8)}  p95=${cell.p95.toFixed(2).padStart(8)}  p99=${cell.p99.toFixed(2).padStart(8)}  max=${cell.max.toFixed(2).padStart(8)}  rss=${cell.rssMb.toFixed(0)}MB  handles=${cell.handlesBefore}->${cell.handlesAfter}  n=${cell.samples}  spread(p95)=${cell.spreadP95.toFixed(0)}%`,
    )
  }
}

/** The two pure functions, on a 1000-event log, 1000 calls. */
const pureEvents = seedEvents('pure-bench', 1000)
const pure = [
  benchPureFunction('checkSafeHarbor', graft.checkSafeHarbor, pureEvents, 1000),
  benchPureFunction('extractTaskState', graft.extractTaskState, pureEvents, 1000),
].filter(Boolean)

for (const p of pure) {
  console.log(`${p.name.padEnd(20)} ${p.iterations} 次 / ${p.totalMs.toFixed(1)}ms  → 单次 ${p.perCallMs.toFixed(4)}ms`)
}

const report = {
  generatedAt: new Date().toISOString(),
  env,
  settings: { CONCURRENCY, ROUNDS, WARMUP, EVENTS_PER_SESSION, REPEATS },
  pureFunctionAvailability: graftSources,
  results,
  pure,
}
const out = join(workspace, 'docs', 'S2-raw.json')
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(`\nraw json -> ${out}`)
