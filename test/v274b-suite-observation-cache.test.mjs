/**
 * ── v274b (B4-0b-2 W4-1): THE SHARED OBSERVATION MUST BE ABLE TO GO STALE, AND SAY SO ───────────
 *
 * `scripts/suite-observation.mjs` exists because graft's `check` ran the SAME suite four times
 * (measured 2026-11-20: `check-readme-counts` 79.8 s + `check-docs` 79.1 s + `check-readme-tally`
 * 78.1 s + the final `node --test` 77.2 s ≈ 314 s of a ~313 s run). One run now serves all of them.
 *
 * ── THIS FILE SHIPS TO ALL FOUR REPOSITORIES, ON PURPOSE (W4-1b) ────────────────────────────────
 *
 * The module it tests is byte-identical in all four, and so is this file. That is not tidiness — it
 * is the fix for a measured mistake: the `tapDigest`/`scripts-in-digest` corrections landed in graft
 * alone, so for a while THREE repositories ran the production cache with NO tests covering it, while
 * this document said 「four repos, byte-identical」. One claim standing in for four unequal facts.
 *
 * WHERE THE COUNT MATTERS DIFFERS BY REPO, AND THAT IS FINE:
 *
 *   graft    · three consumers (readme-counts, check-docs, readme-tally) — the 314 s→104 s case
 *   memory   · ONE consumer (check-readme-counts); no check-docs / check-readme-tally in its chain
 *   observer · ONE consumer
 *   paradise · ONE consumer, and its `check` chain is already fast (54 s measured)
 *
 * In the single-consumer repositories the cache saves one suite run rather than three, so the same
 * properties still have to hold — a smaller win does not make a wrong answer acceptable.
 *
 * A cache in front of a MEASUREMENT is dangerous in a very specific way, and it is the way this batch
 * has been documenting all along: a cache that cannot tell 「the same tree」 from 「a different tree」
 * answers confidently about a world that no longer exists. The count-baseline defect, in a new home.
 *
 * So this file pins the properties that make the cache honest:
 *
 *   ① a changed TEST FILE invalidates it (the digest covers path + size + mtime);
 *   ② a changed GATE SCRIPT invalidates it — measured the hard way: `check-readme-counts.mjs` was
 *     edited, no test file changed, the cache still matched, and the gate reported five failures from
 *     a run that happened BEFORE the fix. A stale observation presented as a current verdict;
 *   ③ a TAMPERED cache is not believed — if the stored TAP is replaced with a green one, the gates
 *     must still see the truth, because the digest no longer matches;
 *   ④ `fresh: true` re-runs regardless (what a test or a diagnosing human needs);
 *   ⑤ the repository root is a PARAMETER — a skeleton with its own `test` script must be measured by
 *     its own command, not this repository's (measured: `v094`'s five assertions went red otherwise).
 *
 * WHAT IS NOT SHARED, AND THE ASSERTION THAT KEEPS IT THAT WAY: the gates keep their own classifiers.
 * The cached artifact is raw TAP + a small index, never a verdict — ⑥ proves that a cache written by
 * one call still lets a DIFFERENT classifier reach its own conclusion from the same bytes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { indexTap, observeSuite } from '../scripts/suite-observation.mjs'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const CACHE = join(REPO, 'node_modules', '.cache', 'dsh-suite-observation.json')

/**
 * A throwaway repository whose `test` script prints what the test wants, so every case below is about
 * the CACHE and not about how long the real suite takes.
 */
function skeleton({ tap = '# tests 3\n# pass 3\n# fail 0\n', name = 'stub' } = {}) {
  const root = mkdtempSync(join(tmpdir(), `dsh-v274b-${name}-`))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'test'), { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'stub', version: '0.0.0', scripts: { test: 'node stub-suite.mjs' } }, null, 2),
    'utf8',
  )
  /** A stub runner that echoes the TAP the case wants — no real suite, no timing dependence. */
  writeFileSync(join(root, 'stub-suite.mjs'), `process.stdout.write(${JSON.stringify(tap)})\n`, 'utf8')
  writeFileSync(join(root, 'test', 'a.test.mjs'), '// placeholder so the digest has something to hash\n', 'utf8')
  return root
}

// ── ① a changed test file invalidates the cache ────────────────────────────────────────────

test('v274b ①: 改动测试文件 ⇒ 缓存失效（digest 覆盖 path+size+mtime）', () => {
  const root = skeleton()
  try {
    const first = observeSuite({ root })
    assert.equal(first.cached, false, '第一次必须是真跑')
    assert.equal(first.index.pass, 3)

    const second = observeSuite({ root })
    assert.equal(second.cached, true, '未改动时必须复用')

    /** Touch the test file the way an edit would: different mtime AND different size. */
    writeFileSync(join(root, 'test', 'a.test.mjs'), '// edited — one more line\n// and one more\n', 'utf8')
    const third = observeSuite({ root })
    assert.equal(third.cached, false, '测试文件变了却命中缓存 ⇒ 缓存看不见它该看见的变化')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── ② a changed GATE SCRIPT invalidates the cache (the measured one) ──────────────────────

test('v274b ②: 改动 scripts/ 下的门禁脚本也失效 —— 这条是实测踩出来的', () => {
  /**
   * The measured failure: `check-readme-counts.mjs` was edited to call this module; no test file had
   * changed, so the digest still matched, and the gate kept reporting FIVE FAILURES from a run that
   * happened before the fix — a stale observation presented as a current verdict.
   */
  const root = skeleton()
  try {
    assert.equal(observeSuite({ root }).cached, false)
    assert.equal(observeSuite({ root }).cached, true, '前提：未改动时确实会命中')

    writeFileSync(join(root, 'scripts', 'gate.mjs'), '// a gate edit\n', 'utf8')
    assert.equal(observeSuite({ root }).cached, false, '门禁脚本变了，观测必须重做')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── ③ a tampered cache is not believed ────────────────────────────────────────────────────

test('v274b ③: 被篡改的缓存不被采信（digest 不匹配 ⇒ 重跑）', () => {
  const root = skeleton({ tap: '# tests 2\n# pass 1\n# fail 1\n' })
  try {
    assert.equal(observeSuite({ root }).index.fail, 1, '前提：真的跑出来是红的')
    const cachePath = join(root, 'node_modules', '.cache', 'dsh-suite-observation.json')
    assert.ok(existsSync(cachePath), '前提：缓存必须写下来了')

    /**
     * Forge a green cache: change the TAP but keep the digest field. A cache that trusts `tap` alone
     * would hand the gates a green reading for a red suite — the exact false-success class.
     */
    const stored = JSON.parse(readFileSync(cachePath, 'utf8'))
    stored.tap = '# tests 2\n# pass 2\n# fail 0\n'
    writeFileSync(cachePath, JSON.stringify(stored), 'utf8')

    const after = observeSuite({ root })
    assert.equal(after.cached, false, 'digest 不匹配的缓存必须被丢弃')
    assert.equal(after.index.fail, 1, '必须读到真实结果，而不是伪造的绿')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── ④ fresh: true always re-runs ─────────────────────────────────────────────────────────

test('v274b ④: fresh:true 无视缓存重跑', () => {
  const root = skeleton()
  try {
    observeSuite({ root })
    assert.equal(observeSuite({ root }).cached, true, '前提：会命中')
    assert.equal(observeSuite({ root, fresh: true }).cached, false, 'fresh 必须重跑')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── ⑤ the root is a parameter, not a fact about the module's own location ────────────────

test('v274b ⑤: 仓根是参数 —— 骨架用自己的 test 脚本，不用本仓的', () => {
  const root = skeleton({ tap: '# tests 7\n# pass 7\n# fail 0\n' })
  try {
    const result = observeSuite({ root })
    assert.equal(result.index.tests, 7, `必须读到骨架的 7，而不是本仓的 1000+；actual: ${result.index.tests}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── ⑥ the shared bytes still let a DIFFERENT classifier decide ───────────────────────────

test('v274b ⑥: 共享的只是观测 —— 同一份 TAP 交给不同判定器，各自得出自己的结论', () => {
  /**
   * This is the property that keeps W4-1 from becoming 「one gate deciding for three」. The module
   * exposes `indexTap(tap)` as a FUNCTION, so a gate can parse the shared bytes its own way.
   *
   * Here the same text is read twice: once by the shared index (which counts), and once by a
   * deliberately different classifier (which asks a different question). Both must work on the same
   * bytes without either overwriting the other's answer.
   */
  const tap = [
    'ok 1 - a real case (1ms)',
    'ok 2 - another case (1ms)',
    'not ok 3 - declared pending (1ms) # SKIP pending a ruling',
    '# tests 3',
    '# pass 2',
    '# fail 0',
    '# skipped 1',
    '',
  ].join('\n')

  const shared = indexTap(tap)
  assert.equal(shared.pass, 2)
  assert.equal(shared.skipped, 1)
  assert.equal(shared.fail, 0)
  assert.deepEqual(shared.failing, [], 'skip 行不许被算成失败（`not ok … # SKIP` 是 skip）')

  /** A different question about the same bytes: how many skip reasons mention a ruling? */
  const ruled = tap.split(/\r?\n/u).filter((line) => /# SKIP/u.test(line) && /ruling/u.test(line))
  assert.equal(ruled.length, 1, '第二个判定器必须能独立地从同一份字节得到它自己的答案')
})

// ── ⑦ REMOVED ON PURPOSE ─────────────────────────────────────────────────────────────────
/**
 * There used to be a case here that ran the REAL suite and asserted the second call was cached. It
 * timed out at 900 s, and the reason is worth keeping: this file lives in `test/`, so running 「the
 * real suite」 from inside a test of the suite is the same recursion `check-readme-tally.mjs` records
 * (`measured: tests 756 -> 760, fail 0 -> 3`). A measurement cannot include itself.
 *
 * The cache's correctness is covered by ①②③④⑤⑥ against a skeleton whose test command is a stub —
 * deterministic, instant, and about the CACHE rather than about the suite. The real-repo behaviour is
 * verified by `npm run check`, which is where a 90-second observation belongs.
 */