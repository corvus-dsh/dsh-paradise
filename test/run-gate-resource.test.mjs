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
  for (const path of ['index.js', 'lib/index.js', 'lib']) {
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

  const instrument = join(ROOT, 'scripts', 'verify-bundle-purity.mjs')
  const { path, shas } = artifactCommits()

  if (existsSync(instrument) && shas.length > 0) {
    const sha = shas[0]
    // NOTE: this assertion MAKES the instrument fail on purpose, and run-gate writes the
    // FAILED line to stderr. `node --test` aggregates it into the run's output, so a reader
    // scanning the log will see "FAILED (exit 1)" in a GREEN run. It is expected noise,
    // required by the proof below — do not "fix" it by removing the assertion.
    const { code, out } = run(['scripts/verify-bundle-purity.mjs', '--before', `${sha}~1`, `--after`, sha])
    assert.equal(code, 1,
      `a gate that FAILS must still exit 1 through the wrapper (artifact path ${path}); got ${code}:\n${out.slice(0, 600)}`)
    assert.match(out, /FAILED \(exit 1\)/u, 'the failure line must name the exit code')
    assert.doesNotMatch(out, /RESOURCE — gate/u, 'a failure must NOT be reported as a resource condition')
    return
  }

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