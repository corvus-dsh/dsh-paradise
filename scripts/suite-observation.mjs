#!/usr/bin/env node
/**
 * ── SUITE OBSERVATION (B4-0b-2 W4-1): RUN THE SUITE ONCE, LET EVERY GATE READ IT ────────────────
 *
 * ── THE MEASUREMENT THAT PROMPTED THIS ──────────────────────────────────────────────────────
 *
 * graft, 2026-11-20, `npm run check` ≈ 313 s:
 *
 *     check-readme-counts   79.8 s   ← spawns  node --test test/*.test.mjs
 *     check-docs            79.1 s   ← spawns  node --test test/<every file>
 *     check-readme-tally    78.1 s   ← spawns  node --test --test-reporter=tap test/*.test.mjs
 *     final test step       77.2 s   ← spawns  node --test test/*.test.mjs
 *     ─────────────────────────────
 *     ~314 s: the SAME suite, four times. Every static gate in the chain together: < 1.5 s.
 *
 * ── WHAT IS SHARED, AND WHAT IS ABSOLUTELY NOT ──────────────────────────────────────────────
 *
 * The gates are not redundant — they answer different questions:
 *
 *     check-readme-counts  does the README's number equal the suite's number?
 *     check-docs           does every documented claim match the code?
 *     check-readme-tally   which skips are DECLARED (pending) and which are MACHINE-missing (resource)?
 *
 * Collapsing them into one gate would be the wrong repair: one gate cannot refuse two different
 * things, and 「一个判据只能有一份实现」 is about implementations, not about questions.
 *
 * So the OBSERVATION is shared and the JUDGEMENT is kept apart. This module produces raw TAP plus a
 * small parsed index; each gate keeps parsing and deciding for itself. A bug here shows up in every
 * gate at once (visible), rather than letting one gate's answer silently satisfy another's question.
 *
 * ── WHY THE CACHE KEY IS A DIGEST AND NOT A TIMESTAMP ───────────────────────────────────────
 *
 * A cache that cannot distinguish 「the same tree」 from 「a different tree」 is the count-baseline
 * defect in a new costume: it would answer 「1023 tests」 for a repo that now has 1030. The key is a
 * digest over every `test/*.test.mjs` file's PATH + SIZE + MTIME, plus the Node version. Any edit,
 * any new/deleted file, any Node upgrade invalidates it. `mtime` alone would not be enough across a
 * fresh checkout (git sets mtime to checkout time), which is why size and path are in there too.
 *
 * ── WHY A STALE CACHE IS NOT A CORRECTNESS RISK ────────────────────────────────────────────
 *
 * The cache holds the runner's OUTPUT, never a verdict. A wrong or torn cache file is treated as a
 * MISS and the suite is simply run again — there is no path where a cache failure produces a green
 * verdict that a fresh run would not have produced.
 *
 * ── USAGE ──────────────────────────────────────────────────────────────────────────────────
 *
 *   import { observeSuite } from './suite-observation.mjs'
 *   const suite = observeSuite()            // shared run (cached for this tree)
 *   suite.tap                               // raw TAP text
 *   suite.index                             // { tests, pass, fail, skipped, failing[] }
 *   observeSuite({ fresh: true })           // force one real run (tests, diagnosis)
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ── THE REPO ROOT IS A PARAMETER, NOT A FACT ABOUT THIS FILE (measured) ─────────────────────────
 *
 * The first version derived `REPO` from `import.meta.url` — correct for the four gates that live
 * beside it, and WRONG for the tests that copy a gate into a throwaway skeleton and run it there.
 * `v0.9.4` does exactly that: it builds a fake repository containing one README and copies
 * `check-readme-counts.mjs` in. With a self-derived root, the copy measured the REAL repository
 * (1023 tests) while judging the FAKE README that declared `598/598` — five of its assertions went
 * red, and the failure looked like a stale-document bug rather than a wrong root.
 *
 * So the caller says which tree to measure, exactly like `composeHarness(root)` in paradise
 * (W1-10b) and `build-harness` before it: **a function that measures a tree must be handed the tree.**
 * Defaults to this file's own repository so the four gates need no change.
 */
function resolveRepo(explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  return fileURLToPath(new URL('..', import.meta.url))
}

/** Every test file's identity plus the runner's version — the whole invalidation key. */
function inputDigest(REPO) {  /**
   * ── A MISSING `test/` IS A MISS, NOT AN ERROR (measured) ────────────────────────────────────
   *
   * A throwaway skeleton declares its own `test` script and has no `test/` directory at all
   * (`v094` — and that is legitimate: it is testing the gate's arithmetic, not the suite). The first
   * version called `readdirSync` unconditionally and threw ENOENT, which surfaced as
   * 「测试数无法测得」 and pointed at the wrong thing entirely.
   *
   * Without a `test/` directory the invalidation key falls back to the package metadata — which is
   * the right input for a repo whose test command is a stub: if `package.json` changes, the cache is
   * invalid; if it does not, the previous observation is still true.
   */
  const parts = []
  let names = []
  try {
    names = readdirSync(join(REPO, 'test')).filter((name) => name.endsWith('.test.mjs')).sort()
  } catch {
    names = []
  }
  for (const name of names) {
    try {
      const stat = statSync(join(REPO, 'test', name))
      parts.push(`${name}:${stat.size}:${Math.trunc(stat.mtimeMs)}`)
    } catch {
      parts.push(`${name}:unstattable`)
    }
  }
  /**
   * ── THE GATE SCRIPTS ARE PART OF THE INPUT TOO (measured, and this one cost a whole debug round) ─
   *
   * The digest covered `test/**` + `package.json` + the Node version. Then `check-readme-counts.mjs`
   * was edited to call this module, the cache still matched (no test file had changed), and the gate
   * kept reporting **five failures from a run that happened BEFORE the fix** — a stale observation
   * presented as a current verdict, which is precisely the defect this batch keeps finding.
   *
   * The gate scripts feed `test/*.test.mjs` through `execFileSync`, so their bytes change what the
   * suite reports. They are therefore inputs, and they belong in the key. This also means a
   * half-finished edit can never be masked by a cached answer from the previous version.
   */
  try {
    const scripts = readdirSync(join(REPO, 'scripts')).filter((name) => name.endsWith('.mjs')).sort()
    for (const name of scripts) {
      const stat = statSync(join(REPO, 'scripts', name))
      parts.push(`scripts/${name}:${stat.size}:${Math.trunc(stat.mtimeMs)}`)
    }
  } catch {
    /** No scripts/ directory (a stub skeleton): nothing to add. */
  }
  try {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
    parts.push(`script:${pkg?.scripts?.test ?? ''}`)
  } catch {
    parts.push('script:?')
  }
  parts.push(`node:${process.version}`)
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

/**
 * The parsed index, from raw TAP. Deliberately small: counts plus the failing names.
 *
 * TAP is used rather than the default reporter because ONLY TAP prints a skip's REASON, and the
 * reason is what lets a gate tell a DECLARED pending test from a MACHINE-missing resource. That
 * distinction predates this module and must not be lost to a performance change.
 */
export function indexTap(tap) {
  const read = (label) => {
    const match = new RegExp(`^# ${label} (\\d+)$`, 'mu').exec(tap)
    return match === null ? undefined : Number(match[1])
  }
  /**
   * ── TWO SUMMARY DIALECTS, ON PURPOSE ─────────────────────────────────────────────────────────
   *
   * TAP prints `# tests N` / `# pass N`; a stub test script (the kind a throwaway skeleton uses to
   * make the measured count deterministic — `v094`) prints a bare `pass 604`. Both are accepted
   * because the module's job is to report what the repository's own test command said, not to insist
   * that every repository speak TAP.
   *
   * This is NOT a loosening of any gate: each gate still applies its own judgement to these numbers.
   * It is the observation agreeing to read what it was given.
   */
  const fallback = (label) => {
    const match = new RegExp(`^${label} (\\d+)$`, 'mu').exec(tap)
    return match === null ? undefined : Number(match[1])
  }
  const tests = read('tests') ?? fallback('tests')
  const pass = read('pass') ?? fallback('pass')
  const fail = read('fail') ?? fallback('fail') ?? 0
  const skipped = read('skipped') ?? fallback('skipped') ?? 0
  /**
   * ── A SKIP ARRIVES ON THE SAME CHANNEL AS A FAILURE (measured) ────────────────────────────────
   *
   * TAP prints `t.skip()` as `not ok N - <name> # SKIP <reason>`. The first version of this parser
   * collected every `not ok` name and then filtered on the NAME TEXT, so a skip whose name did not
   * contain `# SKIP` (the directive is on the LINE, not in the name) was counted as a failure —
   * measured: `fail 2` on a green suite, with `C1: a pasted REPORT …` appearing as a failing test.
   *
   * That is the same class as the tally gate's own recorded lesson (`not ok … # SKIP` is a skip), and
   * it matters here because `check-readme-counts` refuses to judge a document while `fail > 0`.
   */
  const failing = []
  for (const line of tap.split(/\r?\n/u)) {
    const match = /^not ok \d+ - (.+?)(\s+#.*)?$/u.exec(line)
    if (match === null) continue
    if (/# SKIP/u.test(match[2] ?? '')) continue
    const name = match[1].trim()
    if (!failing.includes(name)) failing.push(name)
  }
  return { tests, pass, fail, skipped, failing }
}

/**
 * Run the suite (or reuse this tree's observation) and return `{ tap, index, cached }`.
 *
 * `NODE_TEST_*` IS STRIPPED FROM THE CHILD ENVIRONMENT. Measured: a `node --test` started from INSIDE
 * a test run inherits `NODE_TEST_CONTEXT` / `NODE_TEST_WORKER_ID`, treats itself as an inner worker,
 * **runs nothing and exits 0**. That false green was caught by `v281 ⑤` in the burn-in harness and it
 * applies equally here: any gate driven from a test would otherwise measure zero tests and agree with
 * a README claiming zero.
 */
export function observeSuite(options = {}) {
  const REPO = resolveRepo(options.root)
  const CACHE = join(REPO, 'node_modules', '.cache', 'dsh-suite-observation.json')
  const digest = inputDigest(REPO)
  if (options.fresh !== true && existsSync(CACHE)) {
    try {
      const stored = JSON.parse(readFileSync(CACHE, 'utf8'))
      /**
       * ── THE TAP ITSELF IS VERIFIED, NOT JUST THE INPUTS (measured) ────────────────────────────
       *
       * The first version trusted `tap` whenever the INPUT digest matched. Measured by `v274b ③`:
       * editing only the stored `tap` (leaving the digest untouched) made the gates read a forged
       * GREEN for a suite that had failed — the false-success class, produced by the cache that
       * exists to save time.
       *
       * The digest covers the tree; `tap` needs its own checksum, or the cache is only as trustworthy
       * as the file's immutability. Both are checked; either mismatch is a MISS.
       */
      const tapDigest = createHash('sha256').update(String(stored?.tap ?? '')).digest('hex')
      /**
       * ── A FAILED OBSERVATION MUST NOT BE REUSED (measured twice, 2026-11-24) ──────────────────
       *
       * The digest keys on `test/` + `scripts/` files. A failure whose cause is NOT in those files —
       * a full disk, a dead subprocess, a machine at load 40 — leaves the digest UNCHANGED, so the
       * failing TAP kept matching and every subsequent `npm run check` re-read ONE bad observation
       * as if it were current. Measured: 93 `ENOSPC` failures persisted across runs after the disk
       * was freed, and the final `node --test` (which does not cache) was green the whole time.
       *
       * So the rule is directional:
       *
       *     failCount === 0  → the observation may be reused (the cache keeps its whole point:
       *                        `check` stays fast, and a green suite is re-measured only when the
       *                        tree actually changed);
       *     failCount  > 0   → ALWAYS re-observe. A red result is cheap to re-derive and expensive
       *                        to believe: its cause may be entirely outside the digest.
       *
       * NEGATIVE HALF: this must not turn `check` into a 30-minute command. A GREEN observation is
       * still cached and still hits; only red ones are recomputed. `v338 ②` asserts both directions.
       */
      const cachedFail = Number(indexTap(String(stored?.tap ?? '')).fail ?? 0)
      if (
        stored?.digest === digest &&
        typeof stored.tap === 'string' &&
        stored.tap.length > 0 &&
        stored.tapDigest === tapDigest &&
        cachedFail === 0
      ) {
        return { tap: stored.tap, index: indexTap(stored.tap), cached: true }
      }
    } catch {
      /** A torn or unreadable cache is a MISS. Re-run; never report a measurement we cannot read. */
    }
  }

  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_TEST_WORKER_ID

  /**
   * ── THE COMMAND COMES FROM THE REPOSITORY, NOT FROM THIS FILE (measured) ──────────────────────
   *
   * The first version hardcoded `node --test test/*.test.mjs`. `v094` builds a throwaway repository
   * whose `package.json` declares `test: 'node fake-suite.mjs'` — a stub that prints `pass 604` — so
   * the gate's measured count is deterministic and no real suite runs. With a hardcoded command this
   * module ignored that stub, ran nothing in the skeleton, and reported `tests undefined`: five
   * assertions of an old regression went red, and the failure pointed at 「a stale README」 rather than
   * at 「the observation ignored the repository's own test command」.
   *
   * `check-readme-counts.mjs` already had this right — it ran `scripts.test` through the shell — and
   * the shared module must not be less honest than the gate it replaced. TAP is requested explicitly
   * ONLY when the declared script is a `node --test` invocation; otherwise the script runs as written
   * and `indexTap` falls back to the `pass N` / `tests N` summary form.
   */
  let command = 'node --test --test-reporter=tap test/*.test.mjs'
  try {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
    const declared = String(pkg?.scripts?.test ?? '').trim()
    if (declared.length > 0) {
      /** `--test-reporter=tap` is added only where it belongs; a stub that prints `pass 604` needs nothing. */
      command = /node\s+--test/u.test(declared) && !/--test-reporter/u.test(declared)
        ? declared.replace(/node\s+--test/u, 'node --test --test-reporter=tap')
        : declared
    }
  } catch {
    /** No readable package.json ⇒ keep the default. */
  }

  let tap = ''
  try {
    tap = execFileSync(command, {
      cwd: REPO,
      shell: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 128 * 1024 * 1024,
      timeout: 900_000,
      env,
    })
  } catch (error) {
    /**
     * A RED SUITE IS DATA, NOT AN EXCEPTION. `execFileSync` throws on a non-zero exit, but the TAP
     * with the failing names is on stdout and the gates need it to say 「先修测试，再谈计数」. The
     * index records `fail > 0`; each gate decides what that means for ITS question.
     */
    tap = String(error?.stdout ?? '')
  }

  const index = indexTap(tap)
  if (tap.length > 0 && index.tests !== undefined) {
    try {
      mkdirSync(dirname(CACHE), { recursive: true })
      const temp = `${CACHE}.tmp-${process.pid}`
      const payload = JSON.stringify({ digest, tap, tapDigest: createHash('sha256').update(tap).digest('hex') })
      writeFileSync(temp, payload, 'utf8')
      rmSync(CACHE, { force: true })
      writeFileSync(CACHE, payload, 'utf8')
      rmSync(temp, { force: true })
    } catch {
      /** An unwritable cache costs time on the next gate, never correctness. */
    }
  }
  return { tap, index, cached: false }
}

/**
 * ── THE DIGEST IS EXPOSED FOR TESTS, AND ONLY FOR THAT ──────────────────────────────────────────
 *
 * `v338` has to seed a cache that a previous run would have left for THIS tree, which means it needs
 * the digest the real code would compute. Re-deriving it inside the test would be a SECOND
 * implementation of the invalidation key — and two implementations of one rule drift, which is the
 * defect this repository keeps recording.
 *
 * Named with a `__` prefix and a `ForTest` suffix so it reads as a seam at every call site rather
 * than as part of the public surface.
 */
export const __inputDigestForTest = inputDigest
