#!/usr/bin/env node
/**
 * ── BURN-IN (B4-0b-2 W1-13): A SINGLE GREEN RUN IS A READING, NOT A PROPERTY ────────────────────
 *
 * WHY THIS EXISTS
 *
 * On 2026-11-20 the paradise suite was reported as 「399/399, check exit 0」. It was red on the next
 * full run: 397/399, and then 4 red out of 12 concurrent runs — always the same case, always
 * 「the restarted host must be alive」. The test waited a fixed 250 ms for a CHILD PROCESS to write a
 * file, so on a busy machine 「还没写下来」 and 「没有重启」 were indistinguishable.
 *
 * The bug was real and is fixed (`waitFor`). But the process failure was bigger than the bug:
 * **one passing run was written down as a stable conclusion.** No amount of can-red protects against
 * that, because can-red proves a fix catches a defect — it says nothing about whether a suite is
 * STABLE. Those are different questions and they need different instruments:
 *
 *   · a fix is verified by can-red        (does the test catch the defect?)
 *   · stability is verified by burn-in    (does the test pass N times in a row?)
 *
 * ── WHY IT IS NOT IN `check`, AND MUST NOT BE ─────────────────────────────────────────────────
 *
 * `check` answers "is this commit correct". Burn-in answers "is this suite trustworthy", needs minutes
 * of wall time, and its result is a RATE — not a boolean a CI gate can consume. Putting it in `check`
 * would make every commit slower and every red ambiguous ("a defect, or the fourth run being flaky?").
 * CI runs each file ONCE. That is exactly why the rate has to be measured somewhere else.
 *
 * ── WHAT IT PRINTS, AND WHY THAT IS THE POINT ─────────────────────────────────────────────────
 *
 * A summary line of the form `<file>: N/N passed`, per file, plus every failure with the test name and
 * the first line of its message. The ACCEPTANCE STATEMENT it enables is 「check exit 0 × N 次 / 失败 0」.
 * A single run may only ever be written down as 「一次通过」 — the distinction this file was built for.
 *
 * USAGE
 *
 *   node scripts/burn-in.mjs                       # every test/*.test.mjs, default 5 runs
 *   node scripts/burn-in.mjs --runs=10             # ten runs
 *   node scripts/burn-in.mjs test/a.mjs test/b.mjs # only these (the files a commit touched)
 *   node scripts/burn-in.mjs --concurrency=4       # load the machine on purpose
 *
 * `--concurrency` runs N processes of the SAME file at once. That is deliberate: a flake that only
 * appears under load is invisible to a serial loop, and the paradise defect was exactly of that kind
 * (serial: 10/10 green; 12 concurrent: 4 red). A burn-in that only runs serially would have certified
 * the broken suite.
 */
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Parse `--runs=10` style flags; everything else is a file path. */
function parseArgs(argv) {
  const options = { runs: 5, concurrency: 1, files: [] }
  for (const arg of argv) {
    const runs = /^--runs=(\d+)$/u.exec(arg)
    if (runs !== null) {
      options.runs = Math.max(1, Number(runs[1]))
      continue
    }
    const concurrency = /^--concurrency=(\d+)$/u.exec(arg)
    if (concurrency !== null) {
      options.concurrency = Math.max(1, Number(concurrency[1]))
      continue
    }
    if (arg.startsWith('--')) {
      console.error(`unknown flag: ${arg}`)
      process.exit(2)
    }
    options.files.push(arg)
  }
  return options
}

/**
 * ── THE ENVIRONMENT A NESTED RUNNER INHERITS MUST BE CLEANED (measured, and it is a FALSE GREEN) ──
 *
 * When `burn-in.mjs` itself runs UNDER `node --test` (a test that drives the harness — `v281` does
 * exactly that), the child inherits `NODE_TEST_CONTEXT` and `NODE_TEST_WORKER_ID`. A child `node
 * --test` that sees those flags goes into "I am an inner test worker" mode: **it runs nothing and
 * exits 0**. Measured: status 0, empty output, for a fixture containing `assert.fail` — and the
 * control run (same fixture, cleaned env) exits 1.
 *
 * This is the batch's signature failure in its purest form: a green reading produced by ZERO
 * attempts. The harness that exists to detect unstable suites was reporting "stable" because it had
 * silently measured nothing. Cleaning the two variables is the whole fix; the assertion in `v281 ⑤`
 * is what caught it.
 */
function childEnv() {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_TEST_WORKER_ID
  return env
}

/**
 * One test-file run. Resolves to `{ ok, detail }` — NEVER throws, so one crash does not end the burn-in
 * before it has said anything (the tenth run is the one that matters and it must still be attempted).
 */
function runOnce(file) {
  return new Promise((resolve) => {
    /**
     * ── A `close` CAN FOLLOW AN `error`, AND THAT CRASHED THIS SCRIPT ONCE (measured) ─────────────
     *
     * `spawn` failing (a missing runner, a bad cwd) emits `error` and then `close`. Resolving twice is
     * harmless, but the second resolve happened inside a callback that ALSO did string work on a null
     * exit code — the burn-in died with an unhandled exception on its first red run, which is the one
     * run it exists to survive. One `settled` latch, and `close` is ignored once an outcome exists.
     */
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const child = spawn(process.execPath, ['--test', file], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('error', (error) => settle({ ok: false, detail: `spawn failed: ${error.message}` }))
    child.on('close', (code) => {
      /**
       * ── NODE CREDITS AN EMPTY FILE WITH ITS OWN `✔` LINE (measured) ─────────────────────────────
       *
       * Two wrong guards preceded this one:
       *   1. counting `ℹ tests` — Node reports `tests 1, pass 1` for a file that registered nothing,
       *      because the FILE ITSELF is counted;
       *   2. requiring any `✔` line — an empty file emits `✔ <absolute path> (82ms)` for that same
       *      phantom case.
       *
       * What distinguishes a real case is its NAME: a registered test prints the name the author gave
       * it, while the phantom line prints a filesystem path ending in `.test.mjs`. So the phantom is
       * recognised by that shape and excluded. A run with no remaining named case did not test anything,
       * and certifying it as "stable" is precisely the error this harness exists to prevent.
       */
      const marks = [...output.replace(/\u001B\[[\d;]*m/gu, '').matchAll(/✔\s+(.+?)\s+\(\d+(?:\.\d+)?ms\)/gu)].map(
        (match) => match[1].trim(),
      )
      const realCases = marks.filter((name) => !/\.test\.(?:mjs|js|cjs)$/u.test(name))
      if (code === 0 && realCases.length === 0) {
        settle({
          ok: false,
          detail: `no named test case ran in this file (only ${marks.length} phantom file-level line(s) — an empty run is not a pass)`,
        })
        return
      }
      if (code === 0) {
        settle({ ok: true, detail: '' })
        return
      }
      /**
       * Name the FAILING TEST, not the exit code. A burn-in that says "run 7 failed" makes the reader
       * re-run the file themselves to find out what happened — which is how a flake gets waved away.
       */
      /**
       * INTERPRETING A RUN MUST NOT BE ABLE TO KILL THE BURN-IN. Measured twice while writing this
       * file: a `matchAll` on a non-global regex threw from this callback and the process died with a
       * stack trace instead of a reading — the reader then sees "the burn-in crashed", which says
       * nothing about whether the suite is stable. A parsing failure becomes THAT RUN'S outcome.
       */
      let unique = []
      try {
        /**
         * `✖` appears twice per failure (once in the live line, once under 「failing tests:」), and the
         * line may carry leading whitespace or ANSI codes. Matching only `^\s*✖` MISSED every name in
         * the first version — the report said `exit 1` for a run whose failing test was right there in
         * the output. A harness that cannot name the failing test makes the reader re-run the file,
         * which is how a flake gets waved away.
         */
        const plain = output.replace(/\u001B\[[\d;]*m/gu, '')
        unique = [
          ...new Set(
            [...plain.matchAll(/✖\s+(.+?)\s+\(\d+(?:\.\d+)?ms\)/gu)].map((match) => match[1].trim()),
          ),
        ]
      } catch (error) {
        unique = [`burn-in could not parse the runner output: ${String(error?.message ?? error)}`]
      }
      settle({
        ok: false,
        detail: unique.length > 0 ? unique.join(' | ') : `exit ${code ?? '(no code)'}`,
      })
    })  })
}

const options = parseArgs(process.argv.slice(2))
const files =
  options.files.length > 0
    ? options.files
    : readdirSync(join(ROOT, 'test'))
        .filter((name) => name.endsWith('.test.mjs'))
        .map((name) => join('test', name))

if (files.length === 0) {
  console.error('burn-in: no test files matched — that is a configuration error, not a pass')
  process.exit(2)
}

console.log(`BURN-IN — ${files.length} file(s) × ${options.runs} run(s), concurrency ${options.concurrency}`)
/**
 * ── SAY WHICH FILES, ABSOLUTELY (measured) ──────────────────────────────────────────────────────
 *
 * A skeleton run once reported `2/2 passed` for a fixture that contained `assert.fail`. The cause was
 * that a relative name reached the child as `cwd`-relative against a root the caller did not expect,
 * and the child answered "no such file → 0 tests → exit 0". Printing the resolved absolute path makes
 * that visible in the first line instead of at the end of a false green.
 */
console.log(`  root: ${ROOT}`)
for (const file of files) console.log(`  file: ${join(ROOT, file)}`)
console.log('')

const failures = []
for (const file of files) {
  const attempts = options.runs * options.concurrency
  const results = []
  /** Batches of `concurrency` identical processes, so the load is real while output stays readable. */
  for (let batch = 0; batch < options.runs; batch += 1) {
    const wave = Array.from({ length: options.concurrency }, () => runOnce(file))
    results.push(...(await Promise.all(wave)))
  }
  const passed = results.filter((result) => result.ok).length
  /**
   * ── AN EMPTY RUN IS NOT A PASS (measured) ────────────────────────────────────────────────────
   *
   * The first version printed `OK — 2/2 passed` in ~0 ms for a file that did not exist in the glob it
   * searched: zero attempts, zero failures, "all green". That is the same arithmetic error this whole
   * batch is about — `0 failures` answered `0 attempts` — and it appeared INSIDE the instrument built
   * to catch it. So a file that produced no result at all is reported as a failure, not a pass.
   */
  if (results.length === 0) {
    console.log(`  FAIL ${file}: NO RUN HAPPENED (0 attempts — an empty run is not a pass)`)
    failures.push({ file, occurrence: 0, detail: 'no run happened (0 attempts)' })
    continue
  }
  const label = passed === attempts ? 'OK  ' : 'FAIL'
  console.log(`  ${label} ${file}: ${passed}/${attempts} passed`)
  for (const [index, result] of results.entries()) {
    if (result.ok) continue
    failures.push({ file, occurrence: index + 1, detail: result.detail })
    console.log(`       run ${index + 1}: ${result.detail}`)
  }
}

console.log('')
if (failures.length === 0) {
  console.log(
    `BURN-IN PASSED — ${files.length} file(s), ${options.runs * options.concurrency} run(s) each, 0 failure(s).`,
  )
  console.log(`Acceptance may now be written as: check exit 0 × ${options.runs}, failures 0.`)
  process.exit(0)
}

console.log(`BURN-IN FAILED — ${failures.length} failure(s). Acceptance may NOT be written as stable.`)
for (const failure of failures) console.log(`  ${failure.file} (run ${failure.occurrence}): ${failure.detail}`)
process.exit(1)
