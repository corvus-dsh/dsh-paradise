#!/usr/bin/env node
/**
 * ── TEST NUMBER UNIQUENESS (B4-0b-2 W5-1) ───────────────────────────────────────────────────────
 *
 * ── WHAT THE DISPATCH SAID, AND WHAT IS ACTUALLY THERE ────────────────────────────────────────
 *
 * W5-1 reported two collisions (`v249`, `v253` in graft). Measured across all four repositories, the
 * real picture is much larger:
 *
 *     graft    · 18 numbers used more than once (v74 twelve times, v73 four, v018 four, …)
 *     memory   ·  9 (v091 four, v102 three, v032 three, …)
 *     observer ·  2 (v274 twice)
 *     paradise ·  2 (v102 twice)
 *
 * So 「make every number unique」 is not a repair, it is a mass rename of files whose names are cited
 * in commit messages, reports and TD entries across four repositories. That rename would itself be a
 * far larger source of error than the collisions.
 *
 * ── WHAT THIS GATE DOES INSTEAD ─────────────────────────────────────────────────────────────
 *
 * It BASELINES the collisions that exist and fails on any NEW one. This is the same shape as the
 * frontmatter-read and count baselines: **the存量 is recorded, the growth is refused.** A number that
 * was already shared is a known condition someone can look up; a number shared by two files written
 * next week is a mistake nobody chose.
 *
 * ── WHY THE BASELINE IS A COUNT, NOT A SET OF NAMES ─────────────────────────────────────────
 *
 * A name-set baseline would let `v249` gain a THIRD file silently (the name is already allowed), and
 * would break the moment someone legitimately renames one of the two. A count baseline says: this
 * number may appear at most N times. `--list` prints the current map so the baseline can be
 * re-derived rather than hand-edited, and the check fails if the baseline is ever SMALLER than
 * reality (which would mean someone reduced it without fixing anything — the 「修一份拷贝」 shape).
 *
 * ── USAGE ─────────────────────────────────────────────────────────────────────────────────
 *
 *   node scripts/check-test-numbers.mjs            # verdict
 *   node scripts/check-test-numbers.mjs --list     # current duplicates, for re-baselining
 *   node scripts/check-test-numbers.mjs --self-test
 */
import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ── THE ROOT IS THE CALLER'S WORKING DIRECTORY, NOT THIS FILE'S LOCATION (measured) ──────────
 *
 * The first version derived `REPO` from `import.meta.url`. That is correct when the script runs from
 * its own repository and WRONG the moment it is invoked from a sibling — measured: running it from
 * `dsh-memory` while it lived in `dsh-graft-slice` reported GRAFT's collisions against memory's
 * baseline, and the `--list` output was graft's.
 *
 * Every other cross-repo gate in this workspace (`check-readme-counts`) uses `process.cwd()` for the
 * same reason: the gate answers a question about the tree it was pointed at.
 */
const REPO = process.cwd()
const TEST_DIR = join(REPO, 'test')

/**
 * The numbers that are ALREADY shared, with the count each currently has. Measured 2026-11-21.
 *
 * This is a CEILING: a number may appear at most this many times. Lowering one is a real repair and
 * should be done by editing this table in the same commit; raising one is refused.
 */
export const SHARED_NUMBER_BASELINE = new Map(
  REPO.includes('dsh-memory')
    ? [
        ['v018', 2], ['v020', 2], ['v022', 2], ['v023', 2], ['v032', 3],
        ['v091', 4], ['v096', 2], ['v102', 3], ['v220', 2],
      ]
    : REPO.includes('dsh-observer')
      ? [['v274', 2]]
      : REPO.includes('dsh-paradise')
        ? [['v102', 2]]
        : [
            ['v018', 4], ['v019', 2], ['v021', 2], ['v022', 2], ['v023', 2], ['v032', 3],
            ['v102', 4], ['v103', 2], ['v220', 2], ['v249', 2], ['v253', 2], ['v64', 2],
            ['v70', 4], ['v72', 2], ['v73', 4], ['v731', 3], ['v74', 12], ['v75', 2],
          ],
)

/** `vNNN…` prefix of a test file name, or undefined when the file carries no number. */
export function numberOf(name) {
  const match = /^(v\d+)/u.exec(name)
  return match === null ? undefined : match[1]
}

/** Count every number's occurrences, keeping the file names so a failure can point at them. */
export function countNumbers(dir) {
  const map = new Map()
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.test.mjs'))) {
    const number = numberOf(name)
    if (number === undefined) continue
    const bucket = map.get(number) ?? []
    bucket.push(name)
    map.set(number, bucket)
  }
  return map
}

/**
 * Compare reality against the baseline.
 *
 * Three distinct failures, because they mean three different things:
 *
 *   raised   — a number is used MORE than allowed ⇒ refuse (this is the whole point of the gate)
 *   unknown  — a number collides but was never baselined ⇒ refuse (first-time collision)
 *   lowered  — the baseline says N but reality is fewer ⇒ refuse, because a baseline that is smaller
 *              than reality can only be reached by editing the table without fixing anything, and
 *              the next file would then slip in under the raised ceiling
 */
export function evaluate(counts, baseline) {
  const raised = []
  const unknown = []
  const lowered = []
  for (const [number, files] of counts) {
    if (files.length < 2) continue
    const allowed = baseline.get(number)
    if (allowed === undefined) {
      unknown.push({ number, files })
      continue
    }
    if (files.length > allowed) raised.push({ number, files, allowed })
  }
  for (const [number, allowed] of baseline) {
    const actual = counts.get(number)?.length ?? 0
    if (actual < allowed) lowered.push({ number, allowed, actual })
  }
  return { raised, unknown, lowered }
}

function main() {
  /**
   * A gate asked about a tree that has no `test/` cannot answer 「no new collision」 — it can only
   * say it found nothing, which is the 「zero match means wrong place」 shape from §〇 17. Refuse.
   */
  try {
    readdirSync(TEST_DIR)
  } catch {
    console.log(`test-numbers: FAILED TO START — ${TEST_DIR} does not exist or is unreadable`)
    return 1
  }
  const counts = countNumbers(TEST_DIR)
  if (process.argv.includes('--list')) {
    const dupes = [...counts.entries()].filter(([, files]) => files.length > 1).sort((a, b) => a[0].localeCompare(b[0]))
    console.log(`duplicate number(s) in ${relative(REPO, TEST_DIR) || 'test'}: ${dupes.length}`)
    for (const [number, files] of dupes) {
      console.log(`  ${number} x${files.length}`)
      for (const file of files) console.log(`      ${file}`)
    }
    console.log('')
    console.log('baseline table (paste into SHARED_NUMBER_BASELINE):')
    for (const [number, files] of dupes) console.log(`    ['${number}', ${files.length}],`)
    return 0
  }

  if (process.argv.includes('--self-test')) {
    /**
     * `evaluate` alone is not enough: the whole gate hangs off `numberOf` reading the right digits.
     * Measured failure mode this catches — a pattern that stops at the first digit would map both
     * `v249-a` and `v2491-a` … and `v74` and `v741` … to one number, inventing collisions that are
     * not there while hiding the ones that are.
     */
    const parsing = [
      ['v249-alpha.test.mjs', 'v249'],
      ['v2491-alpha.test.mjs', 'v2491'],
      ['v74-a.test.mjs', 'v74'],
      ['v741-a.test.mjs', 'v741'],
      ['v018-a.test.mjs', 'v018'],
      ['v284-perf-record.test.mjs', 'v284'],
      ['zz-perfrecord-canred.test.mjs', undefined],
      ['README.test.mjs', undefined],
    ]
    const parseFails = parsing.filter(([name, expected]) => numberOf(name) !== expected)
    if (parseFails.length > 0) {
      console.log('self-test: FAIL — numberOf()')
      for (const [name, expected] of parseFails) {
        console.log(`  ${name} → ${String(numberOf(name))}, expected ${String(expected)}`)
      }
      return 1
    }

    const fake = new Map([
      ['v1', ['v1-a.test.mjs', 'v1-b.test.mjs']],
      ['v2', ['v2-a.test.mjs']],
      ['v3', ['v3-a.test.mjs', 'v3-b.test.mjs', 'v3-c.test.mjs']],
    ])
    const baseline = new Map([['v1', 2], ['v3', 2]])
    const verdict = evaluate(fake, baseline)
    const ok =
      verdict.raised.length === 1 && verdict.raised[0].number === 'v3' &&
      verdict.unknown.length === 0 &&
      verdict.lowered.length === 0
    console.log(`self-test: ${ok ? 'PASS' : 'FAIL'} (numberOf + evaluate)`)
    return ok ? 0 : 1
  }

  const verdict = evaluate(counts, SHARED_NUMBER_BASELINE)
  const problems = []
  for (const entry of verdict.raised) {
    problems.push(
      `${entry.number} now has ${entry.files.length} file(s), baseline allows ${entry.allowed}:\n` +
        entry.files.map((file) => `      ${file}`).join('\n'),
    )
  }
  for (const entry of verdict.unknown) {
    problems.push(
      `${entry.number} is shared by ${entry.files.length} files and is NOT in the baseline:\n` +
        entry.files.map((file) => `      ${file}`).join('\n'),
    )
  }
  for (const entry of verdict.lowered) {
    problems.push(
      `baseline says ${entry.number} appears ${entry.allowed}× but reality is ${entry.actual}× — ` +
        'the baseline is LARGER than reality, which leaves a silent headroom: a new file could join ' +
        'that number and stay under the ceiling. Either lower the baseline to the real count (a real ' +
        'repair) or explain why headroom is intended',
    )
  }

  if (problems.length === 0) {
    console.log(
      `test-numbers: OK — no new collision (${SHARED_NUMBER_BASELINE.size} pre-existing shared number(s) recorded)`,
    )
    return 0
  }
  console.log(`test-numbers: ${problems.length} problem(s)`)
  for (const problem of problems) console.log(`  ${problem}`)
  return 1
}

process.exitCode = main()
