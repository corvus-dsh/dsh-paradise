#!/usr/bin/env node
/**
 * RUN-GATE — one RESOURCE-aware wrapper for the gates that legitimately cannot measure everywhere.
 *
 * ── THE PROBLEM IT SOLVES ────────────────────────────────────────────────────────────────────────
 *
 * Three shapes of gate exit code live in this workspace:
 *
 *   0  PASS          the gate measured something and it was fine
 *   1  FAIL          the gate measured something and it was WRONG   → must fail the push
 *   2  RESOURCE      the gate could not measure at all (no compiler, no ref, nothing to compare)
 *
 * Shape 2 is the one that gets mishandled. Two wrong answers, both seen in this workspace:
 *
 *   a) let exit 2 fail the build  → the gate is red on every machine that lacks the tool, so
 *                                    somebody deletes the step, and the gate stops existing;
 *   b) `|| true`, or `set +e` around it  → a green step that never ran is a LIE, and nothing in the
 *                                    log says so.
 *
 * The ruling (user, 2026-11-12) is the third answer, and this file is that ruling in code:
 *
 *   **report RESOURCE, exit 0, but the LOG MUST SAY the check did not happen.**
 *
 * Same shape as `t.skip('RESOURCE: …')` in `test/v201-closure-label-consistency.test.mjs`, and the
 * same rule graft-slice `docs/维护手册.md` §四 states: 缺少资源是「跳过」，不是「通过」.
 *
 * ── WHY THIS FILE EXISTS IN FOUR REPOSITORIES, BYTE-IDENTICAL ───────────────────────────────────
 *
 * Measured 2026-11-16, before this file was centralised: the SAME rule had FOUR implementations —
 *
 *   dsh-observer    this node script                        (copy A)
 *   dsh-paradise    this node script, copied from observer  (copy A)
 *   dsh-graft-slice an 11-line inline shell block in ci.yml (copy B)
 *   dsh-memory      nothing at all: `npm run check` called `type-budget` bare
 *
 * All three were CORRECT on the day, which is exactly why nothing was red. A rule with four
 * implementations does not fail when it is written; it fails the day one of them is edited. The
 * inline shell in graft-slice could never be compared to the node script, and memory's bare call
 * would have turned `npm run check` red on any machine without a compiler — a condition this
 * workspace cannot see, because `typescript` resolves from `D:\持久层能力架构\node_modules`.
 *
 * So: one implementation, four copies, and a SELF-CHECK that compares the copies to each other.
 *
 * ── THE SELF-CHECK DOES NOT HARD-CODE A HASH (and that is the point) ────────────────────────────
 *
 * A frozen hash turns the first LEGITIMATE edit into a red, and the person who hits it fixes the
 * hash — which converts a structural check into a habit. Instead this file hashes its SIBLINGS and
 * compares them to itself: four copies agree iff all four hashes agree, with no value to freeze.
 *
 * A missing sibling is NOT a failure: a published tarball, or a CI job that cloned one repo, has no
 * siblings, and the same reasoning applies as in `check-readme-counts.mjs` FACT 5 — that case prints
 * WHY it skipped. A self-check that crashes when a sibling is absent makes a single-repo checkout
 * unverifiable.
 *
 * ── `--simulate-missing-compiler`: MAKING THE CI-ONLY PATH TESTABLE HERE ─────────────────────────
 *
 * The RESOURCE branch is the one this workspace can never exercise locally: `typescript` resolves
 * from the workspace root, so `type-budget` always measures here and exits 2 only on CI. "Green only
 * on this machine" and "red only on CI" are the same disease, and this project has already paid for
 * it once (a hard-coded `D:/…` path that passed locally and failed on every push).
 *
 * So the branch must be REACHABLE: `--simulate-missing-compiler` (or `GRAFT_SIMULATE_NO_TSC=1`)
 * makes this wrapper take the RESOURCE path WITHOUT running the gate, printing the same lines it
 * would print on CI. The flag is named after what it simulates, it announces itself in the output,
 * and it can only ever produce the RESOURCE result — never a pass, never a fail — so it cannot be
 * used to launder a real failure into green.
 *
 * ---
 *
 * Usage:
 *   node scripts/run-gate.mjs scripts/type-budget.mjs [extra args…]
 *   node scripts/run-gate.mjs --simulate-missing-compiler scripts/type-budget.mjs
 *   node scripts/run-gate.mjs --check-copies          # only the four-copy self-check
 *
 * Exit: 0 for PASS and RESOURCE (with the RESOURCE line printed), 1 for FAIL, 1 for a bad invocation
 * (a missing script is a wiring bug, not a resource condition — it must not be swallowed).
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const SELF = fileURLToPath(import.meta.url)

/**
 * ── THE FOUR-COPY SELF-CHECK ────────────────────────────────────────────────────────────────────
 *
 * Runs on every invocation, including the CI ones: the check is four `readFileSync` calls, and a
 * rule that is only checked when somebody remembers to check it is the problem this file exists for.
 *
 * Reported:
 *   - all present copies equal        → one `ok` line with the shared hash prefix
 *   - present copies differ           → exit 1, naming the file and both hashes
 *   - no sibling present              → one line saying the check was skipped and why (NOT a pass:
 *                                       the line says what was not compared)
 */
const SELF_CHECK_SIBLINGS = ['dsh-paradise', 'dsh-memory', 'dsh-graft-slice', 'dsh-observer']

function checkCopies () {
  const selfBytes = readFileSync(SELF)
  const selfHash = createHash('sha256').update(selfBytes).digest('hex')
  const workspaceRoot = resolve(REPO, '..')
  const selfRepoName = REPO.split(/[\\/]/u).pop()
  const present = []
  const differing = []
  let expected = 0
  for (const name of SELF_CHECK_SIBLINGS) {
    if (name === selfRepoName) continue
    expected += 1
    const candidate = join(workspaceRoot, name, 'scripts', 'run-gate.mjs')
    if (!existsSync(candidate)) continue
    const hash = createHash('sha256').update(readFileSync(candidate)).digest('hex')
    present.push({ name, hash })
    if (hash !== selfHash) differing.push(`${name} (${hash.slice(0, 12)} ≠ ${selfHash.slice(0, 12)})`)
  }
  if (differing.length > 0) {
    console.error(`FAIL run-gate.mjs copies have DIVERGED in this workspace: ${differing.join(', ')}`)
    console.error('  One RESOURCE rule, four implementations, is the failure this file exists to prevent.')
    console.error('  Fix: make the four copies byte-identical again (copy one over the others).')
    return { ok: false, selfHash, present }
  }
  /**
   * ALWAYS printed, including under `--check-copies`: this line is the whole evidence of the check,
   * and a check whose evidence only appears sometimes is a check nobody can quote.
   */
  if (present.length === 0) {
    console.log(`  note run-gate.mjs: single-repo checkout — cross-repo consistency NOT compared (0 of ${expected} sibling copies found beside ${selfRepoName})`)
  } else {
    const partial = present.length < expected ? ` — ${expected - present.length} absent, NOT compared` : ''
    console.log(`  ok   run-gate.mjs is byte-identical to ${present.length}/${expected} sibling copies (${selfHash.slice(0, 12)})${partial}`)
  }
  return { ok: true, selfHash, present }
}

// ── argument parsing ────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const simulateMissingCompiler = argv.includes('--simulate-missing-compiler') || process.env.GRAFT_SIMULATE_NO_TSC === '1'
const copiesOnly = argv.includes('--check-copies')
const positional = argv.filter((arg, index) => {
  if (arg === '--simulate-missing-compiler' || arg === '--check-copies') return false
  return true
})

const copies = checkCopies()
if (!copies.ok) process.exit(1)
if (copiesOnly) process.exit(0)

const [scriptArg, ...rest] = positional
if (scriptArg === undefined) {
  console.error('usage: node scripts/run-gate.mjs [--simulate-missing-compiler] <script-path> [args…]')
  process.exit(1)
}

const script = existsSync(scriptArg) ? scriptArg : join(REPO, scriptArg)
if (!existsSync(script)) {
  // NOT a RESOURCE condition: the wiring points at a file that does not exist. That is a defect in
  // this repository, and swallowing it would mean a renamed script silently removes a gate.
  console.error(`WIRING BUG — no such gate script: ${script}`)
  process.exit(1)
}

const label = resolve(script).slice(REPO.length + 1)

/**
 * The simulated branch. It deliberately does NOT run the gate: the point is to exercise the
 * translation this wrapper performs when the gate reports exit 2, not to fake the gate's verdict.
 * The line says "SIMULATED" so nobody can mistake a local exercise for a CI observation.
 */
if (simulateMissingCompiler) {
  console.log(`  [simulated] ${label} would have been run; this switch forces its RESOURCE outcome`)
  console.log(`RESOURCE — gate ${label} NOT CHECKED this run: GRAFT_SIMULATE_NO_TSC / --simulate-missing-compiler`)
  console.log('  This is a RESOURCE condition, not a pass: nothing was verified by this gate.')
  console.log('  SIMULATED on purpose so the CI-only branch is reachable on a machine that has a compiler.')
  process.exit(0)
}

const run = spawnSync(process.execPath, [script, ...rest], {
  cwd: REPO,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})
process.stdout.write(run.stdout ?? '')
process.stderr.write(run.stderr ?? '')

if (run.status === 0) {
  console.log(`gate ${label}: PASS`)
  process.exit(0)
}
if (run.status === 2) {
  console.log(`RESOURCE — gate ${label} NOT CHECKED this run (the instrument exited 2).`)
  console.log('  This is a RESOURCE condition, not a pass: nothing was verified by this gate.')
  process.exit(0)
}
console.error(`gate ${label}: FAILED (exit ${run.status ?? 'unknown'})`)
process.exit(1)