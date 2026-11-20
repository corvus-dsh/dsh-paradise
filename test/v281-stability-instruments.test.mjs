/**
 * ── v281 (B4-0b-2 W3-5 / W1-13): THE INSTRUMENTS THAT MEASURE STABILITY ────────────────────────
 *
 * TWO DEFECTS, ONE SHAPE: an instrument that cannot tell "not yet" from "never", and an acceptance
 * statement that could not say how many times it had been tested.
 *
 * ── W3-5: A FIXED SLEEP IS A GUESS ABOUT THE MACHINE ─────────────────────────────────────────
 *
 * `v090` awaited `sleep(250)` and then read a file written by a CHILD PROCESS. Measured on
 * 2026-11-20: serial 10/10 green, then **4 red in 12 concurrent runs**, always the same case, always
 * `the restarted host must be alive` with `livePid` still the ORIGINAL (dead) pid. The test was
 * asking 「did the restart happen?」 with an instrument that could only answer 「has it been written
 * down 250 ms later?」 — and on a busy machine those differ.
 *
 * The repair replaced the sleep with a BOUNDED POLL. This file pins the properties that make the
 * repair a repair rather than a longer sleep:
 *   ① a condition that becomes true LATE is still seen (a fixed short sleep would miss it);
 *   ② a condition that never becomes true FAILS, and says how long it waited;
 *   ③ the failure reports WHAT IT OBSERVED, not only "expected true, got false".
 *
 * ── W1-13: 「一次通过」被当成了「稳定」 ────────────────────────────────────────────────────────
 *
 * That is exactly how the paradise suite was signed off at 399/399 and was red on the next full run.
 * The lesson is not about any one test: it is that a single run is a READING. `scripts/burn-in.mjs`
 * exists to produce a RATE, and ⑤/⑥ pin that it reports a rate for both outcomes — because a harness
 * that cannot show a red reading is a green printer.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * The same helper `v090` now uses, reproduced here so its PROPERTIES are testable in isolation. A
 * helper that only exists inside the one test that needs it cannot be tested itself — and this batch
 * has already paid for "the instrument was never checked" three times.
 */
/**
 * ── THE NESTED-RUNNER TRAP, AND WHY THIS HELPER EXISTS ───────────────────────────────────────
 *
 * Calling `node --test` from INSIDE `node --test` inherits `NODE_TEST_CONTEXT` / `NODE_TEST_WORKER_ID`;
 * the child then behaves as an inner worker: it runs NOTHING and exits 0. Measured here — a fixture
 * containing `assert.fail` reported `2/2 passed`, and the control run with a cleaned env exited 1.
 *
 * That is this batch's signature failure in its purest form: a green reading from ZERO attempts, and
 * it appeared inside the very instrument built to detect unstable suites. Both call sites clean it.
 */
function cleanTestEnv() {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_TEST_WORKER_ID
  return env
}

async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 10, observe = () => ({}) } = {}) {
  const startedAt = Date.now()
  while (true) {
    let satisfied = false
    try {
      satisfied = (await predicate()) === true
    } catch {
      satisfied = false
    }
    if (satisfied) return { ok: true, elapsedMs: Date.now() - startedAt, observed: observe() }
    if (Date.now() - startedAt >= timeoutMs) break
    await sleep(intervalMs)
  }
  return { ok: false, elapsedMs: Date.now() - startedAt, observed: observe() }
}

// ── ① a late condition is still seen ─────────────────────────────────────────────────────────

test('v281 ①: 条件晚到（300 ms 后才为真）也被等到 —— 固定 250 ms 会漏掉它', async () => {
  const startedAt = Date.now()
  const ready = () => Date.now() - startedAt >= 300

  const fixedSleepWouldMiss = 250
  assert.equal(ready(), false, `前提：250 ms 时条件必须还不成立（否则这条测试没有诊断力）`)

  const result = await waitFor(ready, { timeoutMs: 3000 })
  assert.equal(result.ok, true, `晚到的条件必须被等到；observed: ${JSON.stringify(result)}`)
  assert.ok(result.elapsedMs >= 250, `必须真的等过一段；actual ${result.elapsedMs} ms`)
  assert.ok(fixedSleepWouldMiss < result.elapsedMs, '这正是旧写法漏掉的那种晚到')
})

// ── ② a condition that never holds FAILS, and reports the wait ──────────────────────────────

test('v281 ②: 永不为真的条件 —— 超时失败，并说出等了多久', async () => {
  const result = await waitFor(() => false, { timeoutMs: 120 })
  assert.equal(result.ok, false, '永不为真必须失败，而不是永远等下去')
  assert.ok(result.elapsedMs >= 120, `必须真的等到超时；actual ${result.elapsedMs} ms`)
  assert.ok(result.elapsedMs < 2000, `超时必须有界；actual ${result.elapsedMs} ms`)
})

// ── ③ the failure carries what was observed ────────────────────────────────────────────────

test('v281 ③: 失败信息带上 observed 快照（行数 / size / pid），不是光说 expected true got false', async () => {
  const state = { hostsStarted: 1, heartbeatBytes: 0, livePid: -1 }
  const result = await waitFor(() => false, {
    timeoutMs: 60,
    observe: () => ({ ...state }),
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.observed, { hostsStarted: 1, heartbeatBytes: 0, livePid: -1 })
  /** And it must be JSON-serialisable: the assertion messages JSON.stringify it. */
  assert.equal(typeof JSON.stringify(result.observed), 'string')
  assert.match(JSON.stringify(result.observed), /hostsStarted/u)
})

// ── ④ the real v090 no longer contains an unbounded fixed wait before a state assertion ────

test('v281 ④: v090 里不再有「sleep 后立刻断言外部进程状态」的固定等待', () => {
  const source = readFileSync(join(REPO, 'test', 'v090-selfheal-loop.test.mjs'), 'utf8')
  /**
   * The two shapes that were there: `await sleep(250)` immediately before reading the files the child
   * writes, and `await sleep(60)` inside the drive loop. A bare `sleep` may still exist (a poll's own
   * interval uses one) — what must not exist is a sleep FOLLOWED by reading the started log.
   */
  assert.doesNotMatch(
    source,
    /await sleep\(\s*250\s*\)[\s\S]{0,200}?readFileSync\(startedLog/u,
    '固定 250 ms 之后立刻读 startedLog，正是那个 flake 的形状',
  )
  assert.match(source, /async function waitFor/u, 'v090 必须有有界轮询')
  assert.match(source, /timeoutMs = 5000/u, '默认上限必须是有限的 5 s')
  /** The "must not happen" branch gets its own bounded window — absence also needs time. */
  assert.match(source, /expectRestart \? 5000 : 1500/u, '「不该重启」那一条也要有窗口（1.5 s），否则无从观察缺席')
})

// ── ⑤ burn-in reports a RATE, and says which test failed ───────────────────────────────────

test('v281 ⑤: burn-in 能红 —— 报告次数、点名失败用例，并以非零退出', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v281-burnin-'))
  try {
    /** A throwaway REPO-SHAPED skeleton: the harness resolves `test/` and `scripts/` from its own URL. */
    const skeleton = join(root, 'repo')
    mkdirSync(join(skeleton, 'scripts'), { recursive: true })
    mkdirSync(join(skeleton, 'test'), { recursive: true })
    cpSync(join(REPO, 'scripts', 'burn-in.mjs'), join(skeleton, 'scripts', 'burn-in.mjs'))

    writeFileSync(
      join(skeleton, 'test', 'a.test.mjs'),
      [
        "import test from 'node:test'",
        "import assert from 'node:assert/strict'",
        "test('goes red on demand', () => {",
        "  assert.fail('forced red: burn-in must name this test')",
        '})',
        '',
      ].join('\n'),
      'utf8',
    )

    /**
     * DIAGNOSTIC FIRST. When the assertion below failed during development this test printed only
     * `0 !== 1` — the reader could not tell whether the skeleton was green (a bad fixture), the
     * harness was broken, or the run never happened. The file content is printed on failure.
     */
    const written = readFileSync(join(skeleton, 'test', 'a.test.mjs'), 'utf8')
    /**
     * CONTROL FIRST: the fixture must be red when the runner is invoked DIRECTLY. Without this line a
     * green reading could mean "the harness is broken" or "the fixture was never red", and the two
     * require opposite repairs. (Measured: exactly this ambiguity cost three rounds here.)
     */
    const control = spawnSync(process.execPath, ['--test', join('test', 'a.test.mjs')], {
      cwd: skeleton,
      encoding: 'utf8',
      env: cleanTestEnv(),
    })
    assert.equal(
      control.status,
      1,
      `对照：直接跑夹具必须红。actual ${control.status}\n--- fixture (JSON) ---\n${JSON.stringify(written)}\n--- output ---\n${`${control.stdout}${control.stderr}`.slice(-600)}`,
    )
    /**
     * ── WHY THE FIXTURE PATH IS PASSED EXPLICITLY (measured) ─────────────────────────────────────
     *
     * With no file argument, `burn-in.mjs` enumerates `test/*.test.mjs` under ITS OWN root — which is
     * correct in a real repository and WRONG here, because this skeleton is a throwaway. Worse, the
     * measured symptom was misleading: the run reported `2/2 passed` in ~0 ms, because the glob had
     * picked up nothing and the summary counted zero attempts as zero failures.
     *
     * So the file is named, and an empty match must never be able to read as a pass (the harness exits
     * 2 for that — see ⑦).
     */
    const named = spawnSync(
      process.execPath,
      [join(skeleton, 'scripts', 'burn-in.mjs'), join('test', 'a.test.mjs'), '--runs=2'],
      { cwd: skeleton, encoding: 'utf8', env: cleanTestEnv() },
    )
    const namedOutput = `${named.stdout}${named.stderr}`
    assert.equal(
      named.status,
      1,
      `burn-in 必须非零退出；actual ${named.status}（cwd=${skeleton}）\n--- written fixture ---\n${written}\n--- output ---\n${namedOutput.slice(-800)}`,
    )
    assert.match(namedOutput, /0\/2 passed/u, `必须报告次数；actual:\n${namedOutput.slice(-600)}`)
    assert.match(namedOutput, /goes red on demand/u, '必须点名失败的用例，否则读者只能自己重跑')
    assert.match(namedOutput, /may NOT be written as stable/u, '必须明确说：这次读数不许写成「稳定」')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── ⑥ the green path also states the rate ──────────────────────────────────────────────────

test('v281 ⑥: burn-in 绿的时候也报出次数（不是只说通过）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v281-green-'))
  try {
    const skeleton = join(root, 'repo')
    mkdirSync(join(skeleton, 'scripts'), { recursive: true })
    mkdirSync(join(skeleton, 'test'), { recursive: true })
    cpSync(join(REPO, 'scripts', 'burn-in.mjs'), join(skeleton, 'scripts', 'burn-in.mjs'))
    writeFileSync(
      join(skeleton, 'test', 'ok.test.mjs'),
      ["import test from 'node:test'", "import assert from 'node:assert/strict'", "test('green', () => { assert.equal(1, 1) })", ''].join('\n'),
      'utf8',
    )

    const run = spawnSync(process.execPath, [join(skeleton, 'scripts', 'burn-in.mjs'), '--runs=3'], {
      cwd: skeleton,
      encoding: 'utf8',
      env: cleanTestEnv(),
    })
    const output = `${run.stdout}${run.stderr}`
    assert.equal(run.status, 0, `绿的时候必须 exit 0；actual ${run.status}\n${output.slice(-600)}`)
    assert.match(output, /3\/3 passed/u, '必须报出跑了几次')
    assert.match(output, /check exit 0 × 3, failures 0/u, '必须给出可以直接抄进验收的那句话')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── ⑧ concurrency must be counted in the acceptance sentence (W1-13b) ─────────────────────

test('v281 ⑧: --concurrency > 1 时收尾句的总次数 = runs × concurrency（不许少报）', () => {
  /**
   * ── THE SENTENCE IS THE EVIDENCE, SO IT MUST COUNT EVERY ATTEMPT (measured by the reviewer) ───
   *
   * `--runs=2 --concurrency=4` printed `8/8 passed` and then the copyable acceptance line said
   * **× 2**. The total is 8. That line is what goes into an acceptance document verbatim, so the
   * under-report is not cosmetic — it is a false claim about how much was tested, and it happened in
   * the same file that exists to stop «一次通过被当成稳定».
   *
   * The fix prints the TOTAL, and when concurrency > 1 also the shape (`2 round(s) × 4 concurrent`),
   * because 「× 2」 and 「× 8」 are different claims.
   */
  const root = mkdtempSync(join(tmpdir(), 'dsh-v281-conc-'))
  try {
    const skeleton = join(root, 'repo')
    mkdirSync(join(skeleton, 'scripts'), { recursive: true })
    mkdirSync(join(skeleton, 'test'), { recursive: true })
    cpSync(join(REPO, 'scripts', 'burn-in.mjs'), join(skeleton, 'scripts', 'burn-in.mjs'))
    writeFileSync(
      join(skeleton, 'test', 'ok.test.mjs'),
      ["import test from 'node:test'", "import assert from 'node:assert/strict'", "test('green', () => { assert.equal(1, 1) })", ''].join('\n'),
      'utf8',
    )

    const run = spawnSync(
      process.execPath,
      [join(skeleton, 'scripts', 'burn-in.mjs'), join('test', 'ok.test.mjs'), '--runs=2', '--concurrency=4'],
      { cwd: skeleton, encoding: 'utf8', env: cleanTestEnv() },
    )
    const output = `${run.stdout}${run.stderr}`
    assert.equal(run.status, 0, `绿的时候必须 exit 0；actual ${run.status}\n${output.slice(-700)}`)
    assert.match(output, /8\/8 passed/u, '必须报出总尝试次数 8')
    /** THE ASSERTION THIS ITEM EXISTS FOR: the copyable line must say 8, not 2. */
    assert.match(
      output,
      /check exit 0 × 8 \(2 round\(s\) × 4 concurrent\), failures 0\./u,
      `收尾句必须写总次数 8 并说明构成；actual:\n${output.slice(-700)}`,
    )
    assert.doesNotMatch(output, /check exit 0 × 2,/u, '不许把 8 次尝试报成 × 2')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── ⑦ zero attempts must never read as a pass ──────────────────────────────────────────────

test('v281 ⑦: 空跑（0 次尝试）不算通过 —— 「一次通过被当成稳定」的算术错误', () => {
  /**
   * MEASURED, and it happened INSIDE the instrument itself: the first version printed
   * `OK — 2/2 passed` in ~0 ms for a run that executed nothing, because `0 failures` was computed
   * over `0 attempts`. That is the batch's signature arithmetic error (an unchanged total hiding a
   * swap) in its purest form — and here it would have certified an untested suite as stable.
   *
   * This is a REGRESSION GUARD on the harness, not on any product code: a file that registers no
   * tests must be reported as `0/2`, never as `2/2`.
   */
  const root = mkdtempSync(join(tmpdir(), 'dsh-v281-empty-'))
  try {
    const skeleton = join(root, 'repo')
    mkdirSync(join(skeleton, 'scripts'), { recursive: true })
    mkdirSync(join(skeleton, 'test'), { recursive: true })
    cpSync(join(REPO, 'scripts', 'burn-in.mjs'), join(skeleton, 'scripts', 'burn-in.mjs'))
    writeFileSync(join(skeleton, 'test', 'empty.test.mjs'), '// registers no tests\nexport {}\n', 'utf8')

    const run = spawnSync(
      process.execPath,
      [join(skeleton, 'scripts', 'burn-in.mjs'), join('test', 'empty.test.mjs'), '--runs=2'],
      { cwd: skeleton, encoding: 'utf8', env: cleanTestEnv() },
    )
    const output = `${run.stdout}${run.stderr}`
    assert.match(output, /0\/2 passed|NO RUN HAPPENED/u, `空跑必须读成 0/2；actual:\n${output.slice(-500)}`)
    assert.doesNotMatch(output, /2\/2 passed/u, '零次尝试绝不许读成 2/2 通过')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})