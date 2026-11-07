/**
 * THE STANDALONE HARNESS — its CLI contract, and the bug that made it blind.
 *
 * WHY THIS FILE EXISTS
 *
 * `dist/harness.js` was verified end-to-end by `_scratch/verify-emergency-loop.mjs`, but a scratch script
 * is not a regression gate: it is not run by `npm test`, and a future change can break the CLI without
 * anything turning red. These assertions are the ones that belong in the suite.
 *
 * THE BUG BEING PINNED
 *
 * The first version chose its probe like this:
 *
 *     config.watchCmd !== undefined ? pidFileProbe : alwaysHealthy
 *
 * So with no `--watch-cmd` — the default, and the only mode in the help text — the supervisor probed
 * "always healthy" and reported `hosted` no matter what. Measured on the CLI against a pid file pointing
 * at a dead process:
 *
 *     状态 hosted / 修复尝试 0 / exit 0
 *
 * The self-rescue path was unreachable. A supervisor that cannot fail is not supervising, so the default
 * is now the pid-file probe and "watch nothing" requires `--no-watch`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const harnessUrl = new URL('../dist/harness.js', import.meta.url).href

/** A pid that cannot be alive: above the maximum on every platform Node runs on. */
const DEAD_PID = 999_999

async function loadHarness() {
  return await import(harnessUrl)
}

test('harness: the CLI bundle exists and is importable', async () => {
  const mod = await loadHarness()
  assert.equal(typeof mod.main, 'function', 'the shipped artifact must expose main')
  assert.equal(typeof mod.createHarness, 'function')
})

test('harness: --help prints usage and exits 0', async () => {
  const mod = await loadHarness()
  const code = await mod.main(['--help'], {})
  assert.equal(code, 0)
})

test('harness: an unknown argument is a REFUSAL with the known list', async () => {
  const mod = await loadHarness()
  const parsed = mod.parseArgs(['--not-a-flag'])
  assert.equal(parsed.ok, false)
  assert.match(parsed.error, /未知参数/u)
})

test('harness: DEFAULT config watches <home>/host.pid — the bug that made it blind', async () => {
  const mod = await loadHarness()
  const home = mkdtempSync(join(tmpdir(), 'harness-probe-'))
  const parsed = mod.parseArgs([`--home=${home}`])
  assert.equal(parsed.ok, true)
  const config = mod.resolveConfig(parsed.values, {}, home)

  /** The default is NOT "no watch": that was the defect. */
  assert.notEqual(config.noWatch, true, 'watching must be the default; --no-watch is the escape hatch')

  /** And the probe it builds must actually read the default pid file. */
  writeFileSync(join(home, 'host.pid'), String(DEAD_PID), 'utf8')
  const probe = mod.createPidFileProbe('watched-process', join(home, 'host.pid'))
  const answer = await probe.check()
  assert.equal(answer.ok, false, 'a dead pid must be reported as unhealthy')
  assert.equal(answer.reason, 'PROCESS_DEAD')
})

test('harness: a dead host degrades, and says so — the end-to-end symptom, without spawning', async () => {
  const mod = await loadHarness()
  const home = mkdtempSync(join(tmpdir(), 'harness-degrade-'))
  writeFileSync(join(home, 'host.pid'), String(DEAD_PID), 'utf8')

  const parsed = mod.parseArgs([`--home=${home}`, '--failure-threshold=1', '--max-repair-attempts=1', '--quiet'])
  const config = mod.resolveConfig(parsed.values, {}, home)
  const runtime = mod.createHarness(config)

  const result = await runtime.runOnce()
  runtime.stop()

  /**
   * NO MODEL IS CONFIGURED HERE, so the correct outcome is: detect, degrade, try once, record that it
   * could not repair, and NOT claim success. `ok === false` is the point — the earlier bug returned
   * `ok === true` from a system that had probed nothing.
   */
  assert.equal(result.ok, false, 'a dead host with no model must not report success')
  assert.notEqual(result.state, 'hosted', `state was ${result.state}`)
  assert.ok(result.transitions.length > 0, 'the transition must be recorded')
  assert.equal(result.transitions[0].to, 'degraded')
  assert.ok(typeof result.reportPath === 'string' && result.reportPath.length > 0, 'a report path must be produced')
})

test('harness: --no-watch is the explicit way to supervise nothing', async () => {
  const mod = await loadHarness()
  const home = mkdtempSync(join(tmpdir(), 'harness-nowatch-'))
  const parsed = mod.parseArgs([`--home=${home}`, '--no-watch', '--once', '--quiet'])
  assert.equal(parsed.ok, true)
  const config = mod.resolveConfig(parsed.values, {}, home)
  assert.equal(config.noWatch, true)

  const runtime = mod.createHarness(config)
  const result = await runtime.runOnce()
  runtime.stop()
  assert.equal(result.state, 'hosted', 'with nothing watched, nothing can be wrong')
})

test('harness: the sandbox root always includes the harness home', async () => {
  const mod = await loadHarness()
  const home = mkdtempSync(join(tmpdir(), 'harness-roots-'))
  const extra = mkdtempSync(join(tmpdir(), 'harness-extra-'))
  const parsed = mod.parseArgs([`--home=${home}`, `--sandbox-root=${extra}`])
  const config = mod.resolveConfig(parsed.values, {}, home)
  assert.ok(config.sandboxRoots.includes(config.homeDir), 'a repair that cannot write its own report is unauditable')
  assert.ok(config.sandboxRoots.includes(extra))
})

test('harness: restart is REFUSED without --allow-restart, and says why', async () => {
  const mod = await loadHarness()
  const home = mkdtempSync(join(tmpdir(), 'harness-restart-'))
  const parsed = mod.parseArgs([`--home=${home}`, '--restart-cmd=echo hi', '--failure-threshold=1', '--quiet'])
  const config = mod.resolveConfig(parsed.values, {}, home)
  assert.equal(config.allowRestart, false, 'spawning commands from a config value requires an explicit opt-in')

  /**
   * The refusal is REPORTED rather than silent: driving one tick must not spawn anything, and the run
   * must end in a state that a human can act on.
   */
  const runtime = mod.createHarness(config)
  const result = await runtime.runOnce()
  runtime.stop()
  assert.notEqual(result.state, 'hosted')
})

/**
 * ── AUDIT P1-13: THE ROUTE CONFIG FILE WAS IGNORED ON THE MAIN PATH ─────────────────────────────
 *
 * WHAT WAS WRONG. `route-config.ts` exists for one reason its own header states: "An environment
 * variable is fixed at process start… A file can be rewritten by a running process". That matters
 * exactly for the incident this harness is built for — the key expired at 3am, the operator can
 * rewrite a file, but cannot restart the watcher without defeating the point of the watcher.
 *
 * The main route, however, was built from env/CLI only. `routeConfigPath` went to the FALLBACK
 * route and nowhere else. Measured: a `config.json` holding a valid `baseUrl` / `apiKey` / `model`
 * produced "模型（未配置：只能检测与降级）" and `NO_LLM` on every repair. 153 lines of atomic
 * write, three-source precedence and merge-not-replace code were dead where they were needed.
 *
 * THE PRECEDENCE IS THE CONTRACT: CLI flag > environment > file. Tested in all three directions,
 * because "the file works" alone would let a later regression silently override an operator's
 * explicit environment variable.
 */
test('audit P1-13: the route config FILE configures the main route, and env still wins over it', async () => {
  const mod = await loadHarness()
  const home = mkdtempSync(join(tmpdir(), 'harness-route-'))
  const cfgPath = join(home, 'config.json')
  writeFileSync(
    cfgPath,
    JSON.stringify({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-file', model: 'file-model' }),
    'utf8',
  )
  const parsed = mod.parseArgs([`--home=${home}`, `--route-config=${cfgPath}`])

  // 1. FILE ONLY: no LLM_* in the env handed to resolveConfig.
  const fromFile = mod.resolveConfig(parsed.values, {}, home)
  assert.equal(fromFile.llm?.model, 'file-model', 'a config file alone must configure the main route')
  assert.equal(fromFile.llm?.apiKey, 'sk-file')
  assert.equal(fromFile.llm?.baseUrl, 'http://127.0.0.1:9/v1')

  // 2. ENV WINS over the file.
  const envOnly = { LLM_BASE_URL: 'http://127.0.0.1:10/v1', LLM_API_KEY: 'sk-env', LLM_MODEL: 'env-model' }
  const fromEnv = mod.resolveConfig(parsed.values, envOnly, home)
  assert.equal(fromEnv.llm?.model, 'env-model', 'environment must beat the file (CLI > env > file)')
  assert.equal(fromEnv.llm?.apiKey, 'sk-env')

  // 3. CLI WINS over both, for the two flags that exist. NOTE: there is deliberately NO
  //    `--llm-api-key` flag — a key passed on the command line lands in the process list and in
  //    shell history. So the key must come from env or the file; only model/baseUrl are CLI-settable.
  const cliArgs = mod.parseArgs([
    `--home=${home}`,
    `--route-config=${cfgPath}`,
    '--llm-model=cli-model',
    '--llm-base-url=http://127.0.0.1:11/v1',
  ])
  const fromCli = mod.resolveConfig(cliArgs.values, envOnly, home)
  assert.equal(fromCli.llm?.model, 'cli-model', 'the most explicit source must win for model')
  assert.equal(fromCli.llm?.baseUrl, 'http://127.0.0.1:11/v1', 'and for baseUrl')
  // The key cannot come from the CLI, so env supplies it — and env beats the file here too.
  assert.equal(fromCli.llm?.apiKey, 'sk-env', 'the apiKey must fall back to env, never to a CLI flag')

  // 4. A MISSING FILE degrades to the old behaviour instead of throwing: a repair path that dies on
  //    a missing config would replace "your key expired" with "your file is absent".
  const noFile = mod.parseArgs([`--home=${home}`, `--route-config=${join(home, 'nope.json')}`])
  const degraded = mod.resolveConfig(noFile.values, {}, home)
  assert.equal(degraded.llm, undefined, 'no route anywhere must mean no LLM, not a crash')
})
