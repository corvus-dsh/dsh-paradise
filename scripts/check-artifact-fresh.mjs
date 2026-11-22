#!/usr/bin/env node
/**
 * ── TD-B1: IS THE COMMITTED ARTIFACT THE ONE THIS SOURCE BUILDS? ─────────────────────────────────────
 *
 * `dsh-graft-slice` has had this check since a CI run went red for a cause that was fully visible
 * locally. The other three repositories had NOTHING: their "the artifact is the source" claim could
 * only be checked by a human rebuilding and eyeballing a diff. Measured before this file existed:
 *
 *     dsh-memory     0 *artifact* scripts
 *     dsh-observer   0 *artifact* scripts
 *     dsh-paradise   0 *artifact* scripts
 *     dsh-graft-slice 1
 *
 * WHY IT MATTERS BEYOND TIDINESS: every one of these plugins ships a PREBUILT bundle that the host
 * loads. A stale bundle means the tests exercise one thing and the user runs another — and the failure
 * is silent in exactly the direction that matters (a fix that is committed but not shipped).
 *
 * ── THE COMPARISON IS PER-FILE, NOT ONE BLOB ─────────────────────────────────────────────────────────
 *
 * `dsh-memory` builds MANY files into `lib/`, so a single-artifact comparison would either miss all of
 * them or compare a directory listing. The script rebuilds, then compares every tracked build output
 * byte for byte, and REPORTS WHICH FILES DIFFER — a message that says only 「stale」 sends the reader
 * looking through a diff to find out what.
 *
 * A missing committed file is reported separately from a differing one: 「never committed」 and
 * 「committed but out of date」 are different problems with different fixes.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * WHAT TO COMPARE, declared per repository rather than discovered.
 *
 * A glob would silently pass when a build starts emitting a NEW file (it is not in the glob yet) or
 * stops emitting an old one (nothing on disk to compare). The two entries below are the complete,
 * stated output sets; if a build changes them, this list has to change with it.
 */
const ARTIFACTS = ['index.js']

function git(args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

/** Rebuild first: the question is 「what does THIS source produce」, not 「what did the last build leave」. */
execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: REPO, stdio: 'ignore' })

let tracked
try {
  tracked = git(['ls-files', ...ARTIFACTS]).split('\n').map((line) => line.trim()).filter(Boolean)
} catch (error) {
  console.log(`artifact-check: cannot read the index (${String(error?.message ?? error)})`)
  process.exit(1)
}

/**
 * ③ NEGATIVE HALF: with nothing committed there is nothing to lie about.
 *
 * A repository whose artifact is not tracked cannot be stale in the sense this check means. Saying
 * 「OK」 would be a claim about a comparison that did not happen, so the wording says the comparison
 * did not happen.
 */
if (tracked.length === 0) {
  console.log('artifact-check: no artifact is committed — nothing to compare (not a pass claim about staleness)')
  process.exit(0)
}

const stale = []
const missing = []
const absent = []

for (const rel of tracked) {
  const abs = join(REPO, rel)
  if (!existsSync(abs)) {
    absent.push(rel)
    continue
  }
  const working = readFileSync(abs, 'utf8')
  let committed
  try {
    committed = git(['show', `HEAD:${rel}`])
  } catch {
    missing.push(rel)
    continue
  }
  if (working !== committed) {
    stale.push({ rel, working, committed })
  }
}

if (absent.length > 0) {
  console.log('artifact-check: A TRACKED ARTIFACT IS MISSING FROM THE WORKING TREE')
  for (const rel of absent) console.log(`  missing: ${rel} (run: npm run build)`)
  process.exit(1)
}
if (missing.length > 0) {
  console.log('artifact-check: A TRACKED ARTIFACT IS NOT IN HEAD')
  for (const rel of missing) console.log(`  not committed: ${rel}`)
  process.exit(1)
}
if (stale.length === 0) {
  console.log(`artifact-check: OK — the committed artifact is what this source builds (${tracked.length} file(s))`)
  process.exit(0)
}

console.log('artifact-check: THE COMMITTED ARTIFACT IS STALE')
for (const entry of stale) {
  console.log(`  ${entry.rel}`)
  console.log(`    working  : ${entry.working.length} chars / ${entry.working.split('\n').length} lines`)
  console.log(`    committed: ${entry.committed.length} chars / ${entry.committed.split('\n').length} lines`)
}
console.log('  Run: git add <the files above>  (a benchmark or a restore step may have written old bytes back)')
console.log(`  repo: ${relative(process.cwd(), REPO) || '.'}`)
process.exit(1)
