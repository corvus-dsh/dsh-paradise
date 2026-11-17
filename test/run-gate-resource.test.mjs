/**
 * ── THE RESOURCE BRANCH MUST BE REACHABLE FROM A MACHINE THAT HAS A COMPILER ────────────────────
 *
 * `scripts/run-gate.mjs` translates a gate's exit 2 ("could not measure") into
 *
 *     RESOURCE — gate … NOT CHECKED this run: <reason>
 *     … exit 0
 *
 * That translation is the whole reason the wrapper exists. And on THIS workspace it can never be
 * observed for real: `typescript` resolves from the workspace root, one directory above every repo,
 * so `type-budget.mjs` always measures here and exits 2 only on CI.
 *
 * "Green only on this machine" and "red only on CI" are the same disease. This project already paid
 * for the second one: `check-cycles` shipped a hard-coded `D:/…` that passed locally and failed on
 * every push (#118). So the CI-only branch gets a switch, and this file is what makes the switch
 * worth having — an untested switch is a comment.
 *
 * ── THE SAME FILE IN FOUR REPOSITORIES, ON PURPOSE ──────────────────────────────────────────────
 *
 * `run-gate.mjs` is byte-identical in all four, so its test is too. What differs per repository is
 * only WHICH artifact and WHICH red-pair gate exist — both resolved by looking, never by branching
 * on the repository name.
 *
 * FOUR ASSERTIONS, each closing a different way this could rot:
 *
 *   ① the SIMULATED branch exits 0 and SAYS the check did not happen (never a silent green);
 *   ② the same branch is reachable by environment variable (two spellings must not diverge);
 *   ③ a gate that really FAILS still exits 1 (the wrapper is not a "pass everything" blanket);
 *      the artifact pair comes from git history, so a PURE pair (type-only commit) or an
 *      out-of-date artifact path must fall back to the deterministic cycle fixture — and the
 *      test PRINTS which of the two it actually used;
 *   ④ the copy self-check reports what it compared, and does not crash when a sibling is absent.
 *
 * WHY ① USES A REAL GATE AND NOT A STUB: a stub would only prove the stub. `type-budget.mjs` is the
 * gate this wrapper actually guards in CI, and `--simulate-missing-compiler` deliberately does NOT
 * run it — it forces the translation under test, not a fake verdict.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const WRAPPER = join(ROOT, 'scripts', 'run-gate.mjs')

/** Run the wrapper and keep stdout, stderr and the exit code together. */
function run (args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [WRAPPER, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...env },
    })
    return { code: 0, out: stdout }
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

/** The built bundle is `index.js` here, `lib/` in memory. Whichever has history is the artifact. */
function artifactCommits () {
  /**
   * ── ORDER MATTERS: THE ARTIFACT IS THE DIRECTORY, NOT ONE FILE INSIDE IT ──────────────────────
   *
   * This used to try `lib/index.js` before `lib`, and `lib/index.js` HAS history here — so the
   * lookup stopped there and every commit that changed ONLY other files under `lib/` became
   * invisible. `cf270dd` is exactly that: it changed `lib/dedupe.js`, `lib/extract.js` and
   * `lib/store/layer.js`, but not `lib/index.js`.
   *
   * `lib/` is the artifact (`verify-bundle-purity.mjs` builds its whole comparison around
   * `ARTIFACT_DIR = 'lib'`); `lib/index.js` is a subset of it. Reading history for a subset is
   * how a fixture silently stops looking at the thing it claims to check.
   */
  for (const path of ['index.js', 'lib', 'lib/index.js']) {
    try {
      const out = execFileSync('git', ['log', '--format=%H', '-3', '--', path], { cwd: ROOT, encoding: 'utf8' })
        .trim()
      const shas = out.split(/\r?\n/u).filter(Boolean)
      if (shas.length > 0) return { path, shas }
    } catch {
      // no git, or no history for this path — try the next candidate
    }
  }
  return { path: undefined, shas: [] }
}

test('run-gate: --simulate-missing-compiler exits 0 and SAYS nothing was verified', () => {
  const { code, out } = run(['--simulate-missing-compiler', 'scripts/type-budget.mjs'])
  assert.equal(code, 0, `the RESOURCE branch must exit 0; got ${code}:\n${out}`)
  assert.match(out, /RESOURCE — gate scripts[\\/]type-budget\.mjs NOT CHECKED this run/u,
    'the line must name the gate that was not checked')
  assert.match(out, /not a pass/u, 'it must say this is not a pass')
  assert.match(out, /nothing was verified by this gate/u,
    'it must say nothing was verified — otherwise "exit 0" reads as "it passed"')
  assert.match(out, /SIMULATED/u,
    'a local exercise must be labelled as simulated, so it is never quoted as a CI observation')
})

test('run-gate: the same branch is reachable through the environment variable', () => {
  /**
   * The env-var form exists because a CI workflow may want to exercise the branch without changing
   * the command line. Both spellings must take the SAME path — two spellings that behave differently
   * would be the "two implementations" failure in miniature.
   */
  const { code, out } = run(['scripts/type-budget.mjs'], { GRAFT_SIMULATE_NO_TSC: '1' })
  assert.equal(code, 0, `GRAFT_SIMULATE_NO_TSC=1 must exit 0; got ${code}:\n${out}`)
  assert.match(out, /RESOURCE — gate/u, 'the env var must produce the same RESOURCE line')
  assert.match(out, /GRAFT_SIMULATE_NO_TSC/u, 'the reason must name the env var that caused it')
})

test('run-gate: a REAL failure still exits 1 (the wrapper is not a blanket pass)', (t) => {
  /**
   * ── WHY THIS IS THE MOST IMPORTANT ASSERTION IN THIS FILE ─────────────────────────────────────
   *
   * A wrapper that translates exit 2 to 0 is one line away from translating everything to 0, and
   * from the outside the two look identical on a green run. So the red path is proven here on a
   * real gate with a real defect.
   *
   * Two ways to produce a genuine exit 1, and the file picks whichever this repository supports —
   * looking, never branching on the repo name:
   *
   *   a) `verify-bundle-purity --before <sha>~1 --after <sha>` on a commit that changed the built
   *      artifact (observer / graft / memory have the instrument; paradise does not);
   *   b) `check-cycles` pointed at a temporary `src/` copy with a deliberate VALUE cycle
   *      (`GRAFT_CHECK_CYCLES_SRC`, which every repository's copy honours).
   *
   * (b) is the fallback that makes this assertion portable: it needs no git history and no artifact,
   * only two files and one import.
   */
  const madeCycle = () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-gate-cycle-'))
    writeFileSync(join(dir, 'a.ts'), "import { b } from './b.js'\nexport const a = (): number => b\n")
    writeFileSync(join(dir, 'b.ts'), "import { a } from './a.js'\nexport const b = (): number => a\n")
    return dir
  }

  /**
   * ── THE PATH THIS TEST USED MUST BE PRINTED ──────────────────────────────────────────────────
   *
   * The artifact pair is taken from git history, and history can stop proving anything:
   * a commit that only changed type declarations has the SAME code-line multiset
   * (`verify-bundle-purity` calls that PURE), and a commit that touched only files under `lib/`
   * other than `lib/index.js` is invisible to the narrow lookup this file used to do.
   * In both cases the "real failure" fixture silently degrades into a green run.
   *
   * So the test (a) prints WHICH source it actually used, and (b) FALLS BACK to the
   * deterministic cycle fixture — a temporary `src/` with a real VALUE cycle — whenever the
   * history pair cannot produce a genuine exit 1. A green run now says what it proved.
   *
   * Two test-only switches exist so BOTH paths can be demonstrated on a machine whose history
   * happens to be convenient. Neither can launder a failure into green: they only choose WHICH
   * real gate runs.
   *   GRAFT_RUN_GATE_PAIR="<before>|<after>"  override the pair (feed a known-PURE pair to force
   *                                            the fallback);
   *   GRAFT_RUN_GATE_FORCE_CYCLE=1            skip history entirely.
   */
  const usedCycle = (why) => {
    console.log(`✓ used: deterministic cycle fixture (${why})`)
    const dir = madeCycle()
    try {
      const { code, out } = run(['scripts/check-cycles.mjs'], { GRAFT_CHECK_CYCLES_SRC: dir })
      assert.equal(code, 1,
        'a gate that FAILS must still exit 1 through the wrapper; got ' + code + ':\n' + out.slice(0, 600))
      assert.match(out, /FAILED \(exit 1\)/u, 'the failure line must name the exit code')
      assert.doesNotMatch(out, /RESOURCE — gate/u, 'a failure must NOT be reported as a resource condition')
      assert.match(out, /cycle/iu, 'the underlying gate must have reported the cycle it was given')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const instrument = join(ROOT, 'scripts', 'verify-bundle-purity.mjs')
  const { path, shas } = artifactCommits()

  if (process.env.GRAFT_RUN_GATE_FORCE_CYCLE === '1') {
    usedCycle('forced by GRAFT_RUN_GATE_FORCE_CYCLE')
    return
  }

  if (existsSync(instrument) && shas.length > 0) {
    const sha = shas[0]
    const override = process.env.GRAFT_RUN_GATE_PAIR
    const [beforeRef, afterRef] = override === undefined ? [`${sha}~1`, sha] : override.split('|')
    assert.ok(beforeRef !== undefined && beforeRef.length > 0 && afterRef !== undefined && afterRef.length > 0,
      `GRAFT_RUN_GATE_PAIR must be "<before>|<after>"; got ${JSON.stringify(override)}`)
    // NOTE: this assertion MAKES the instrument fail on purpose, and run-gate writes the
    // FAILED line to stderr. `node --test` aggregates it into the run's output, so a reader
    // scanning the log will see "FAILED (exit 1)" in a GREEN run. It is expected noise,
    // required by the proof below — do not "fix" it by removing the assertion.
    const { code, out } = run(['scripts/verify-bundle-purity.mjs', '--before', beforeRef, '--after', afterRef])
    if (code === 1) {
      console.log(`✓ used: real history pair (${beforeRef} → ${afterRef})  ← NOT PURE (artifact path ${path})`)
      assert.match(out, /FAILED \(exit 1\)/u, 'the failure line must name the exit code')
      assert.doesNotMatch(out, /RESOURCE — gate/u, 'a failure must NOT be reported as a resource condition')
      return
    }
    /**
     * The wrapper maps the instrument's exit 2 to 0 (RESOURCE), so a 0 here means one of THREE
     * things — PURE (a legitimate "nothing changed"), VACUOUS, or NOT MEASURABLE. Name which, then
     * use the deterministic fixture: a pair that is PURE cannot prove the wrapper maps FAIL → 1.
     *
     * `run-gate` collapses the instrument's 2 into 0, so the exit code alone no longer tells
     * "byte-identical" from "could not measure". Reading the instrument's own words is what keeps
     * the three apart — measured 2026-11-17: a shallow clone (CI clones depth=1) makes `~1`
     * unresolvable, the instrument printed `cannot measure: … (a resource condition, not PURE)`,
     * and the old two-branch version reported that as "was PURE" — i.e. it said "we measured it
     * and it was identical" when in fact nothing was measured. That is the silent-misattribution
     * failure this repository keeps writing down.
     */
    const why = code === 0
      ? (/(?:^|\n)VACUOUS/u.test(out)
          ? `real history pair (${beforeRef} → ${afterRef}) was VACUOUS — nothing compared`
          : /cannot measure|resource condition, not PURE|invalid object name|unknown revision|does not exist/u.test(out)
            ? `real history pair (${beforeRef} → ${afterRef}) COULD NOT BE MEASURED (the instrument reported a RESOURCE condition: e.g. \`~1\` absent in a shallow clone)`
            : `real history pair (${beforeRef} → ${afterRef}) was PURE, so it proves nothing about FAIL → exit 1`)
      : `history pair (${beforeRef} → ${afterRef}) could not be measured (exit ${code})`
    usedCycle(why)
    return
  }

  usedCycle('no artifact history available')
})

test('run-gate: the copy self-check says WHAT it compared, and never crashes on a missing sibling', () => {
  /**
   * The check compares this file to the copies beside it in the workspace, because one rule with
   * four implementations is exactly what this wrapper was created to end. Two properties matter and
   * both are asserted here rather than asserted in prose:
   *
   *   - it PRINTS the comparison in every case (a check whose evidence appears only sometimes
   *     cannot be quoted by anyone), including "0 of 3 were found — NOT compared";
   *   - it never exits non-zero merely because a sibling is absent. A single-repo checkout is a
   *     legitimate state (`check-readme-counts.mjs` FACT 5 makes the same decision).
   */
  const { code, out } = run(['--check-copies'])
  assert.equal(code, 0, `--check-copies must not fail on a legitimate checkout layout; got:\n${out}`)
  assert.match(out, /run-gate\.mjs is byte-identical to \d+\/\d+ sibling copies|single-repo checkout/u,
    'the check must print either the agreement or the reason it could not compare')

  // and the source must not freeze a hash — a frozen hash turns the first legitimate edit into
  // "someone changed the number", which converts a structural check into a habit
  const source = readFileSync(WRAPPER, 'utf8')
  assert.doesNotMatch(source, /const\s+SELF_HASH\s*=\s*'[0-9a-f]{16,}'/u,
    'the self-check must compare copies to each other, not against a hard-coded digest')
  assert.match(source, /SELF_CHECK_SIBLINGS/u, 'the sibling list must be a named, readable set')
})