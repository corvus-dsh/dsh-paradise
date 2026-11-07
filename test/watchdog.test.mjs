/**
 * THE WATCHDOG — the trigger for unattended self-healing.
 *
 * WHAT THIS FIXES
 *
 * The repair session could fix a broken host, but a human still had to open the terminal and
 * run it. A watchdog that lived inside the host would die with the host, so `watchdog.ts`
 * imports only the protocol and is started as its own process.
 *
 * These tests drive `tick()` directly with injected probes and a scripted repair: the
 * acceptance run in `_scratch/accept-watchdog.mjs` covers the real multi-process topology
 * (kill a host, watch a separate watchdog process bring it back).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const layer = await import(new URL('../index.js', import.meta.url).href)

/** A probe whose answer the test controls. */
function probe(name, sequence) {
  let index = 0
  return {
    name,
    async check() {
      const answer = sequence[Math.min(index, sequence.length - 1)]
      index += 1
      return answer
    },
  }
}

const OK = { ok: true }
const DEAD = { ok: false, reason: 'DEAD' }

test('watchdog: a healthy probe never triggers a repair', async () => {
  let repairs = 0
  const watchdog = layer.createWatchdog({
    probes: [probe('p', [OK])],
    repair: async () => {
      repairs += 1
      return { ok: true, summary: '' }
    },
    spawnHost: async () => ({ pid: 1, command: ['x'] }),
    failureThreshold: 1,
  })
  await watchdog.tick()
  assert.equal(repairs, 0)
  assert.equal(watchdog.getState(), 'watching')
})

test('watchdog: one failure is not a death until the threshold is reached', async () => {
  let repairs = 0
  const watchdog = layer.createWatchdog({
    probes: [probe('p', [DEAD, DEAD, OK])],
    repair: async () => {
      repairs += 1
      return { ok: true, summary: '' }
    },
    spawnHost: async () => ({ pid: 1, command: ['x'] }),
    failureThreshold: 2,
  })
  await watchdog.tick()
  assert.equal(repairs, 0, 'a single slow probe must not restart a healthy host')
  await watchdog.tick()
  assert.equal(repairs, 1, 'the second consecutive failure is a death')
})

test('watchdog: death runs repair, spawns the host, and verifies the result', async () => {
  const order = []
  const watchdog = layer.createWatchdog({
    probes: [
      /**
       * fail, fail (threshold), then HEALTHY for the post-spawn verification poll.
       */
      probe('p', [DEAD, DEAD, OK]),
    ],
    repair: async (diagnosis) => {
      order.push('repair')
      assert.match(diagnosis, /宿主/u, 'the diagnosis is built from the probe reasons')
      return { ok: true, summary: 'fixed' }
    },
    spawnHost: async () => {
      order.push('spawn')
      return { pid: 4242, command: ['node', 'host.js'] }
    },
    failureThreshold: 2,
    verifyTimeoutMs: 1000,
    verifyIntervalMs: 1,
  })
  await watchdog.tick()
  await watchdog.tick()
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  assert.deepEqual(order, ['repair', 'spawn'], 'repair happens before the spawn')
  const report = watchdog.report()
  assert.equal(report.recoveries, 1)
  assert.equal(report.spawned[0].pid, 4242)
  assert.equal(watchdog.getState(), 'watching', 'a verified recovery returns to watching')
})

test('watchdog: verification polls instead of judging a single instant', async () => {
  /**
   * The acceptance run this replaces: spawn succeeded, the very next probe ran ~1 ms later,
   * the listener was not bound yet, and the watchdog reported "still unhealthy" about a host
   * that was healthy 200 ms afterwards. This test pins the polling behaviour.
   */
  let probes = 0
  const watchdog = layer.createWatchdog({
    probes: [
      {
        name: 'slow-bind',
        async check() {
          probes += 1
          /** Fail on the first check (death), then fail twice more, then succeed. */
          return probes >= 4 ? { ok: true } : { ok: false, reason: 'NOT_YET' }
        },
      },
    ],
    repair: async () => ({ ok: true, summary: 'fixed' }),
    spawnHost: async () => ({ pid: 7, command: ['x'] }),
    failureThreshold: 1,
    verifyTimeoutMs: 2000,
    verifyIntervalMs: 5,
  })
  await watchdog.tick()
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
  const report = watchdog.report()
  assert.equal(report.recoveries, 1, 'the retry found the host healthy')
  assert.ok(probes >= 4, `verification polled more than once (probes=${probes})`)
})

test('watchdog: a failing repair still spawns, because the next probe decides', async () => {
  const events = []
  const watchdog = layer.createWatchdog({
    probes: [probe('p', [DEAD, OK])],
    repair: async () => ({ ok: false, summary: 'UNRESOLVED' }),
    spawnHost: async () => ({ pid: 9, command: ['x'] }),
    failureThreshold: 1,
    verifyTimeoutMs: 500,
    verifyIntervalMs: 5,
    onEvent: (event) => events.push(event.type),
  })
  await watchdog.tick()
  /**
   * A model may report "unresolved" and still have fixed the fault; a restart costs one process
   * while not restarting leaves the system down on the strength of a self-report.
   */
  assert.ok(events.includes('host-spawned'), 'spawn happened despite the failed repair')
  assert.ok(events.includes('verified'))
})

test('watchdog: the recovery budget ends in exhausted, not an endless loop', async () => {
  const watchdog = layer.createWatchdog({
    probes: [probe('p', [DEAD])],
    repair: async () => ({ ok: true, summary: 'fixed' }),
    spawnHost: async () => ({ pid: 1, command: ['x'] }),
    failureThreshold: 1,
    maxRecoveries: 0,
    verifyTimeoutMs: 10,
    verifyIntervalMs: 1,
  })
  await watchdog.tick()
  assert.equal(watchdog.getState(), 'exhausted')
  /** A tick after exhaustion does nothing: no probe, no repair, no spawn. */
  const before = watchdog.report().probesRun
  await watchdog.tick()
  assert.equal(watchdog.report().probesRun, before)
})

test('watchdog: a throwing probe is a failure with a reason, never a crash', async () => {
  const watchdog = layer.createWatchdog({
    probes: [
      {
        name: 'throws',
        async check() {
          throw new Error('probe exploded')
        },
      },
    ],
    repair: async () => ({ ok: true, summary: '' }),
    spawnHost: async () => ({ pid: 1, command: ['x'] }),
    failureThreshold: 1,
    maxRecoveries: 0,
  })
  await watchdog.tick()
  assert.equal(watchdog.getState(), 'exhausted')
  assert.match(String(watchdog.report().lastReason), /PROBE_THREW/u)
})

test('watchdog: the diagnosis carries the real probe reasons', () => {
  const text = layer.buildDiagnosis('/work', [
    { name: 'pid', reason: 'PID_DEAD', detail: 'pid 123' },
    { name: 'port', reason: 'PORT_CLOSED', detail: ':8080' },
  ])
  assert.match(text, /PID_DEAD/u)
  assert.match(text, /PORT_CLOSED/u)
  assert.match(text, /\/work/u)
})

test('watchdog: the report is stable data an operator can read', async () => {
  const watchdog = layer.createWatchdog({
    probes: [probe('p', [OK])],
    repair: async () => ({ ok: true, summary: '' }),
    spawnHost: async () => ({ pid: 1, command: ['x'] }),
  })
  await watchdog.tick()
  const report = watchdog.report()
  assert.equal(report.probesRun, 1)
  assert.equal(report.deaths, 0)
  assert.deepEqual(report.spawned, [])
})
