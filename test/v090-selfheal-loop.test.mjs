/**
 * THE SELF-RESCUE LOOP, PINNED — `test/v090-selfheal-loop.test.mjs`.
 *
 * WHY THIS FILE EXISTS
 *
 * The scenario the whole harness is built for was verified in `_scratch/e2e-selfheal.mjs`, and a scratch
 * script is not a regression gate: `npm test` does not run it, so a later change can break the rescue
 * silently. These are the assertions that belong in the suite.
 *
 * TWO DEFECTS ARE PINNED HERE, BOTH MEASURED BEFORE THEY WERE FIXED:
 *
 *   1. EXTRACTION WAS STRICTER THAN THE MODELS. `extractToolSource` unwrapped a fence only when it
 *      wrapped the ENTIRE reply. A model writing one sentence first — which real models do, whatever the
 *      prompt says — had its PROSE compiled as JavaScript, and the loop died with:
 *
 *          TOOL_FAILED: Invalid or unexpected token
 *
 *      Meanwhile `launcher.ts` carried its own, MORE tolerant inline strip, so the same reply repaired
 *      fine on one path and killed the other. That divergence is why there is now one implementation.
 *
 *   2. THE RESTART REPEATED. `runOnce` restarted whenever "hosted AND attempts exist AND the last
 *      attempt ran", which stays true for ever after one success: a recovered machine was restarted on
 *      every later tick, each time spawning ANOTHER host. The extra host was invisible because the pid
 *      file only records the newest one. The fix keys the restart on the attempt NUMBER.
 *
 * THE END-TO-END CASES USE A REAL HTTP MODEL SERVER AND A REAL PROCESS. A stubbed llm adapter would let
 * these assertions pass while proving nothing about the HTTP path, the prompt, or the sandbox compile —
 * which is exactly where the chain broke.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const harnessUrl = new URL('../dist/harness.js', import.meta.url).href
const loadHarness = async () => await import(harnessUrl)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const isAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The reply a well-behaved model produces: exactly what the compile contract wants. */
const TOOL_SOURCE =
  "{ description: 'record the diagnosis', parameters: { type: 'object', properties: {} }, " +
  "execute: async function () { return 'diagnosed: the host process was gone; no source patch needed, restart it' } }"

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * 1. EXTRACTION — the unit that decides what gets compiled
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

test('extractToolSource: a fence around the whole reply is unwrapped', async () => {
  const { extractToolSource } = await loadHarness()
  assert.equal(extractToolSource('```js\n' + TOOL_SOURCE + '\n```'), TOOL_SOURCE)
})

test('extractToolSource: prose BEFORE the fence does not poison the source (the shipped bug)', async () => {
  const { extractToolSource } = await loadHarness()
  /**
   * This exact shape returned the whole reply and failed to compile. The assertion is on the RESULT
   * BEING COMPILABLE, not merely on a substring match: "starts with {" would also hold for the broken
   * version, since the broken version started with prose that happened to contain a brace later.
   */
  const reply = '我来诊断。\n\n```javascript\n(' + TOOL_SOURCE + ')\n```\n\n以上就是修复方案。'
  const source = extractToolSource(reply)
  assert.equal(/^```/u.test(source), false, 'the fence must be gone')
  assert.equal(source.includes('我来诊断'), false, 'the prose must not be compiled')
  const compiled = new Function('"use strict"; return (' + source + ')')()
  assert.equal(typeof compiled.execute, 'function')
})

test('extractToolSource: prose AROUND an unfenced object is stripped', async () => {
  const { extractToolSource } = await loadHarness()
  const source = extractToolSource('修复方案如下：\n\n' + TOOL_SOURCE + '\n\n以上。')
  assert.equal(source, TOOL_SOURCE)
})

test('extractToolSource: braces inside strings do not end the object early', async () => {
  const { extractToolSource } = await loadHarness()
  /**
   * A naive regex stops at the first `}` it meets, which here is INSIDE a string literal — producing
   * source that compiles into something else entirely, or not at all. The scanner skips string bodies.
   */
  const tricky =
    "{ description: 'a } brace', parameters: { type: 'object', properties: {} }, " +
    "execute: async function () { return 'ok }' } }"
  const source = extractToolSource('说明：\n' + tricky + '\n完成。')
  const compiled = new Function('"use strict"; return (' + source + ')')()
  assert.equal(await compiled.execute({}), 'ok }')
})

test('extractToolSource: with several blocks, the one carrying execute wins', async () => {
  const { extractToolSource } = await loadHarness()
  /**
   * A model often shows an unrelated snippet first. Picking the first block blindly would compile the
   * wrong thing and the resulting failure would look like a bad repair rather than a bad choice.
   */
  const reply = '先看这段：\n```js\nconst unrelated = 1\n```\n然后修复：\n```js\n' + TOOL_SOURCE + '\n```'
  const source = extractToolSource(reply)
  const compiled = new Function('"use strict"; return (' + source + ')')()
  assert.equal(typeof compiled.execute, 'function')
})

test('extractToolSource: unrecognisable input is returned unchanged, so the error names the real text', async () => {
  const { extractToolSource } = await loadHarness()
  assert.equal(extractToolSource('我修不了，建议人工介入。'), '我修不了，建议人工介入。')
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * 2. THE LOOP — crash, repair, restart, and verify the host is genuinely back
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Run one full crash -> repair -> restart cycle against a real HTTP model.
 *
 * `reply` decides what the model says; everything else is real. Returns what was observed, including
 * HOW MANY hosts were ever started — the number that catches a repeated restart, which heartbeat
 * growth alone cannot see.
 */
async function runCycle(reply) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-heal-test-'))
  const home = join(root, 'home')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(home, { recursive: true })

  const heartbeat = join(root, 'heartbeat.txt')
  const startedLog = join(root, 'started.txt')
  const hostScript = join(root, 'host.mjs')
  const pidFile = join(home, 'host.pid')

  writeFileSync(
    hostScript,
    `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(startedLog)}, String(process.pid) + '\\n')\n` +
      `const beat = () => appendFileSync(${JSON.stringify(heartbeat)}, 'x')\nbeat()\nsetInterval(beat, 50)\n`,
    'utf8',
  )

  const host = spawn(process.execPath, [hostScript], { stdio: 'ignore' })
  writeFileSync(pidFile, String(host.pid), 'utf8')
  await sleep(500)
  const before = existsSync(heartbeat) ? statSync(heartbeat).size : 0
  host.kill('SIGKILL')
  await sleep(300)

  let calls = 0
  const llm = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      calls += 1
      /** Odd calls are the repair generation; even ones are the session's own trigger answer. */
      const content = calls % 2 === 1 ? reply : '已诊断。'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] }))
    })
  })
  await new Promise((r) => llm.listen(0, '127.0.0.1', r))

  const { createHarness } = await loadHarness()
  const runtime = createHarness({
    homeDir: home,
    sandboxRoots: [home],
    noWatch: false,
    restartCmd: '"' + process.execPath + '" "' + hostScript + '"',
    allowRestart: true,
    failureThreshold: 1,
    intervalMs: 10,
    maxRepairAttempts: 2,
    toolTimeoutMs: 15_000,
    sourceDirs: [],
    routeConfigPath: join(home, 'config.json'),
    quiet: true,
    llm: { baseUrl: 'http://127.0.0.1:' + llm.address().port + '/v1', apiKey: 'test-key', model: 'test-model' },
  })

  let result
  const states = []
  for (let i = 0; i < 10; i += 1) {
    result = await runtime.runOnce()
    states.push(result.state)
    if (result.state === 'hosted' && i > 0) break
    if (result.state === 'gave-up') break
    await sleep(60)
  }
  runtime.stop()
  llm.close()
  await sleep(250)

  const after = existsSync(heartbeat) ? statSync(heartbeat).size : 0
  const livePid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : -1
  const hostsStarted = existsSync(startedLog) ? readFileSync(startedLog, 'utf8').trim().split('\n').filter(Boolean).length : 0
  const attempt = (result.attempts ?? [])[result.attempts.length - 1]

  /** CLEANUP MUST KILL THE RESTARTED HOST: a leaked process survives the test run and the suite hangs. */
  for (const pid of (existsSync(startedLog) ? readFileSync(startedLog, 'utf8').trim().split('\n') : [])) {
    const n = Number(pid)
    if (Number.isInteger(n) && n > 0 && isAlive(n)) {
      try {
        process.kill(n, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }
  rmSync(root, { recursive: true, force: true })

  return { result, states, calls, before, after, livePid, hostsStarted, attempt, originalPid: host.pid }
}

test('self-heal: a chatty model still closes the loop, and the host is restarted exactly once', async () => {
  /**
   * THE REGRESSION FOR BOTH DEFECTS AT ONCE. Before the fixes this case ended `degraded -> gave-up`
   * with `TOOL_FAILED: Invalid or unexpected token`; and the tidy-reply case (proven in
   * `_scratch/e2e-selfheal.mjs` scenario A) restarted twice.
   */
  const observed = await runCycle('我来诊断。\n\n```javascript\n(' + TOOL_SOURCE + ')\n```\n\n以上就是方案。')

  assert.equal(observed.attempt?.ran, true, 'the repair must RUN, not fail to compile: ' + String(observed.attempt?.error ?? ''))
  assert.equal(observed.result.state, 'hosted', 'the loop must close: ' + observed.states.join(' -> '))
  assert.equal(observed.after > observed.before, true, 'the host must genuinely be beating again')
  assert.equal(observed.hostsStarted, 2, 'exactly one restart: 1 original + 1 restarted (got ' + observed.hostsStarted + ')')
  assert.equal(observed.livePid !== observed.originalPid && isAlive(observed.livePid), true, 'the restarted host must be alive')
})

test('self-heal: an unusable reply fails LOUDLY and names the text that was compiled', async () => {
  /**
   * WHEN IT CANNOT REPAIR, IT MUST SAY WHY. The old message was `TOOL_FAILED: Invalid or unexpected
   * token` with no hint of the cause, so the next attempt could not be different — the one thing a
   * self-healing loop must guarantee. The excerpt is what makes the failure self-describing.
   */
  const observed = await runCycle('我无法修好这个问题，请人工介入。')

  assert.notEqual(observed.result.state, 'hosted')
  assert.equal(observed.attempt?.ran, false)
  assert.match(String(observed.attempt?.error ?? ''), /被编译的源码前 160 字符/u, 'the failure must name what was compiled')
  assert.equal(observed.hostsStarted, 1, 'a failed repair must NOT restart anything (got ' + observed.hostsStarted + ' hosts)')
})
