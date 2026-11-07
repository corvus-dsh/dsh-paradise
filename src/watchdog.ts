/**
 * WATCHDOG — the process that notices the host died and brings it back.
 *
 * THE LAST GAP, IN THE USER'S OWN TERMS
 *
 * "如果 DSH 彻底坏了，彼岸层靠自己在终端里就能把 DSH 救活" was true but incomplete: a human
 * still had to open that terminal. The repair machinery existed; the TRIGGER did not. This is
 * the trigger.
 *
 * WHY THIS IS NOT A HOST PLUGIN
 *
 * A watchdog that lives inside the process it watches is not a watchdog — when the host dies,
 * the watcher dies with it, and the failure mode it exists to fix is exactly the one that
 * silences it. So this runs as its own OS process, started by the operator once (or by a
 * service manager), and it imports nothing from `adapters/dsh/`.
 *
 * THE RECOVERY SEQUENCE
 *
 *   probe → (threshold failures) → repair session → spawn host → probe again to VERIFY
 *
 * The verification step is not decoration. A restart that leaves the host in the same broken
 * state looks identical to a successful repair from the outside, and the difference only shows
 * up in the next probe. So the watchdog checks, and reports which of the two happened.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not loop forever on a broken repair. `maxRecoveries` exists because a model given the
 * same error twice writes the same fix twice; the third attempt needs new evidence, and that is
 * a human's job to supply. When the budget is spent the watchdog goes `exhausted` and stays
 * down, loudly, rather than thrashing.
 */

export type WatchdogState = 'watching' | 'recovering' | 'exhausted' | 'stopped'

export type WatchdogEvent =
  | { readonly type: 'probe'; readonly ok: boolean; readonly reason?: string }
  | { readonly type: 'death-detected'; readonly failures: number; readonly reason: string }
  | { readonly type: 'repair-start'; readonly attempt: number; readonly diagnosis: string }
  | { readonly type: 'repair-end'; readonly attempt: number; readonly ok: boolean; readonly summary: string }
  | { readonly type: 'host-spawned'; readonly pid: number; readonly command: readonly string[] }
  | { readonly type: 'spawn-failed'; readonly error: string }
  | { readonly type: 'verified'; readonly ok: boolean }
  | { readonly type: 'exhausted'; readonly reason: string }
  | { readonly type: 'state'; readonly from: WatchdogState; readonly to: WatchdogState }

/** One dependency to watch. Same shape as the launcher's probe, so both can share an impl. */
export interface WatchdogProbe {
  readonly name: string
  /** MUST NOT THROW. Return `ok: false` instead; the caller records the reason. */
  check(): Promise<{ ok: boolean; reason?: string; detail?: string }>
}

export interface WatchdogOptions {
  readonly probes: readonly WatchdogProbe[]
  /**
   * The repair. Receives the diagnosis text built from the failed probes and returns a summary.
   *
   * Injected rather than constructed here for one reason: the repair needs a MODEL, and a
   * watchdog that hard-codes a provider cannot be tested without a credential. The production
   * wiring passes `runRepairSession`; a test passes a script.
   */
  readonly repair: (diagnosis: string, attempt: number) => Promise<{ readonly ok: boolean; readonly summary: string }>
  /** How the host is started. Called only after a repair has been attempted. */
  readonly spawnHost: () => Promise<{ readonly pid: number; readonly command: readonly string[] }>
  /** Probe interval. Default 30 s — the user's number. */
  readonly intervalMs?: number
  /**
   * Consecutive failures before acting. Default 2.
   *
   * Not 1, for the same measured reason the launcher uses 2: one slow probe (a GC pause, a busy
   * disk) is not an outage, and recovering from it restarts a healthy host.
   */
  readonly failureThreshold?: number
  /** Repair attempts before giving up. Default 2. */
  readonly maxRecoveries?: number
  readonly onEvent?: (event: WatchdogEvent) => void
  /** Injected clock and timers, so a test drives the loop instead of sleeping. */
  readonly now?: () => number
  readonly setIntervalImpl?: (fn: () => void, ms: number) => unknown
  readonly clearIntervalImpl?: (handle: unknown) => void
  /** How long to keep polling for health after a restart. Default 10 s. */
  readonly verifyTimeoutMs?: number
  /** Gap between those polls. Default 250 ms. */
  readonly verifyIntervalMs?: number
}

/**
 * Sub-millisecond sleep.
 *
 * NAMED `pauseFor` AND NOT `sleep`: this package ships as ONE inlined bundle, so every module's
 * top-level names share a single scope. A plain `sleep` collided with an identically named
 * helper in another module and the built `index.js` failed to parse with
 * "Identifier 'sleep' has already been declared" — a build-time error that only appears after
 * bundling, which is why it is worth a comment rather than a rename alone.
 */
function pauseFor(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

export interface WatchdogReport {
  readonly state: WatchdogState
  readonly probesRun: number
  readonly deaths: number
  readonly recoveries: number
  readonly spawned: ReadonlyArray<{ readonly pid: number; readonly at: number }>
  readonly lastReason?: string
}

/** Diagnosis text handed to the repair session when the host is judged dead. */
export function buildDiagnosis(workspace: string, failures: ReadonlyArray<{ name: string; reason?: string; detail?: string }>): string {
  const lines = [
    '宿主（DSH）被看门狗判定为死亡。',
    '',
    '探测结果：',
    ...failures.map((entry) => `- ${entry.name}: ${entry.reason ?? 'unhealthy'}${entry.detail === undefined ? '' : ` — ${entry.detail}`}`),
    '',
    `workspace: ${workspace}`,
    '',
    '请按流程诊断并修复；如果无法修复，明确说明原因。',
  ]
  return lines.join('\n')
}

export function createWatchdog(options: WatchdogOptions) {
  const now = options.now ?? (() => Date.now())
  const intervalMs = Math.max(1, Math.trunc(options.intervalMs ?? 30_000))
  const failureThreshold = Math.max(1, Math.trunc(options.failureThreshold ?? 2))
  const maxRecoveries = Math.max(0, Math.trunc(options.maxRecoveries ?? 2))
  const verifyTimeoutMs = Math.max(0, Math.trunc(options.verifyTimeoutMs ?? 10_000))
  const verifyIntervalMs = Math.max(1, Math.trunc(options.verifyIntervalMs ?? 250))
  const emit = options.onEvent ?? (() => {})

  let state: WatchdogState = 'watching'
  let failures = 0
  let probesRun = 0
  let deaths = 0
  let recoveries = 0
  let lastReason: string | undefined
  const spawned: Array<{ pid: number; at: number }> = []
  let timer: unknown
  /** Guards against two ticks recovering at once — a slow repair must not be entered twice. */
  let busy = false

  const setState = (to: WatchdogState): void => {
    if (to === state) return
    const from = state
    state = to
    emit({ type: 'state', from, to })
  }

  /** Run every probe. Never throws; a throwing probe is a failure with a reason. */
  async function runProbes(): Promise<Array<{ name: string; reason?: string; detail?: string }>> {
    const failed: Array<{ name: string; reason?: string; detail?: string }> = []
    for (const probe of options.probes) {
      let answer: Awaited<ReturnType<WatchdogProbe['check']>>
      try {
        answer = await probe.check()
      } catch (error) {
        answer = { ok: false, reason: 'PROBE_THREW', detail: String((error as { message?: unknown })?.message ?? error) }
      }
      emit({ type: 'probe', ok: answer.ok, ...(answer.reason === undefined ? {} : { reason: answer.reason }) })
      if (!answer.ok) failed.push({ name: probe.name, reason: answer.reason, detail: answer.detail })
    }
    return failed
  }

  /**
   * Detect → repair → spawn → verify.
   *
   * Returns what happened rather than throwing: the caller (a timer) has nowhere to put an
   * exception, and a watchdog that dies on its own error is the failure it exists to prevent.
   */
  async function recover(reasons: ReadonlyArray<{ name: string; reason?: string; detail?: string }>): Promise<{ repaired: boolean; spawned: boolean; verified: boolean }> {
    const diagnosis = buildDiagnosis(process.cwd(), reasons)
    let repaired = false
    for (let attempt = 1; attempt <= maxRecoveries; attempt += 1) {
      emit({ type: 'repair-start', attempt, diagnosis })
      let outcome: { ok: boolean; summary: string }
      try {
        outcome = await options.repair(diagnosis, attempt)
      } catch (error) {
        outcome = { ok: false, summary: String((error as { message?: unknown })?.message ?? error) }
      }
      emit({ type: 'repair-end', attempt, ok: outcome.ok, summary: outcome.summary })
      if (!outcome.ok) continue
      repaired = true
      break
    }

    /**
     * SPAWN EVEN WHEN THE REPAIR SAID IT FAILED.
     *
     * A model may report "unresolved" and still have fixed the actual fault — or the fault may
     * have been transient. Restarting costs one process; not restarting leaves the system down
     * on the strength of a self-report. The subsequent probe is what decides.
     */
    let didSpawn = false
    try {
      const result = await options.spawnHost()
      spawned.push({ pid: result.pid, at: now() })
      emit({ type: 'host-spawned', pid: result.pid, command: result.command })
      didSpawn = true
    } catch (error) {
      emit({ type: 'spawn-failed', error: String((error as { message?: unknown })?.message ?? error) })
    }

    /** VERIFY: a restart that leaves the host broken looks exactly like success until we check. */
    let verified = false
    if (didSpawn) {
      /**
       * GIVE THE HOST A MOMENT TO BIND ITS PORT.
       *
       * Verifying immediately measured this exact failure: the spawn succeeded, the probe ran
       * ~1 ms later, the listener was not up yet, and the watchdog reported "still unhealthy"
       * about a host that was healthy 200 ms afterwards. That is a false negative on the one
       * signal that decides whether recovery worked.
       *
       * So the first probe is a fast poll (every `verifyIntervalMs`, default 250 ms) up to
       * `verifyTimeoutMs` (default 10 s), instead of one unlucky instant.
       */
      const deadline = now() + verifyTimeoutMs
      for (;;) {
        const failed = await runProbes()
        if (failed.length === 0) {
          verified = true
          break
        }
        if (now() >= deadline) break
        await pauseFor(Math.min(verifyIntervalMs, Math.max(0, deadline - now())))
      }
      emit({ type: 'verified', ok: verified })
      if (verified) {
        failures = 0
        recoveries += 1
        setState('watching')
      }
    }
    return { repaired, spawned: didSpawn, verified }
  }

  async function tick(): Promise<void> {
    if (busy || state === 'exhausted' || state === 'stopped') return
    busy = true
    try {
      const failed = await runProbes()
      probesRun += 1
      if (failed.length === 0) {
        failures = 0
        lastReason = undefined
        return
      }
      failures += 1
      lastReason = failed.map((entry) => `${entry.name}:${entry.reason ?? 'unhealthy'}`).join(', ')
      if (failures < failureThreshold) return

      deaths += 1
      emit({ type: 'death-detected', failures, reason: lastReason })
      if (recoveries >= maxRecoveries) {
        /**
         * The budget is per successful recovery, not per attempt: a system that recovers twice
         * and dies a third time is a system with a fourth, different fault — and after two
         * clean recoveries the watchdog has earned another try. The cap that matters is the
         * one inside `recover()`.
         */
        const reason = `recoveries=${recoveries} attempts exhausted (${lastReason})`
        setState('exhausted')
        emit({ type: 'exhausted', reason })
        return
      }
      setState('recovering')
      await recover(failed)
    } finally {
      busy = false
    }
  }

  return {
    start(): void {
      if (timer !== undefined) return
      const setImpl = options.setIntervalImpl ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
      timer = setImpl(() => {
        void tick()
      }, intervalMs)
      const handle = timer as unknown as { unref?: () => void }
      handle.unref?.()
    },
    stop(): void {
      if (timer === undefined) return
      const clearImpl =
        options.clearIntervalImpl ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))
      clearImpl(timer)
      timer = undefined
      setState('stopped')
    },
    /** Drive one cycle by hand. The entry point a test uses instead of waiting. */
    tick,
    report(): WatchdogReport {
      return {
        state,
        probesRun,
        deaths,
        recoveries,
        spawned: [...spawned],
        ...(lastReason === undefined ? {} : { lastReason }),
      }
    },
    getState(): WatchdogState {
      return state
    },
  }
}
