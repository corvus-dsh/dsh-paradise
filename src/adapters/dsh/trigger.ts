/**
 * TRIGGER — make a session start working, and be honest when it does not.
 *
 * PORTED FROM dsh-graft-slice's ignition chain, DELIBERATELY, INCLUDING ITS SCARS. That
 * implementation carries three lessons which are cheap to copy and expensive to rediscover:
 *
 *   1. THE SIGNAL IS A REQUIRED ARGUMENT. This host's `prompt(request, signal)` touches
 *      `signal.throwIfAborted()` on its first line; passing `undefined` killed every ignition before
 *      the prompt was admitted, and the only symptom was one audit line. The signal is always built,
 *      and its abort doubles as the timeout.
 *   2. IDEMPOTENCE IS NOT OPTIONAL. A prompt that was admitted but is not yet visible in the log must
 *      not be admitted twice: a queued duplicate reads to the target as the same instruction given
 *      twice. `alreadyTriggered()` reads the target's own log for the marker before acting.
 *   3. AN UNREADABLE LOG IS "UNKNOWN", NOT "ALREADY DONE". Treating a failed read as success is how a
 *      target stayed permanently inert while the audit said `ok`. Unknown is reported as failure.
 *
 * TWO MODES, AND WHY THEY ARE DISTINCT
 *
 *   `queue`     — deliver at the next natural boundary. Correct for a session that is asleep: this is
 *                 how a freshly written artifact becomes a running agent.
 *   `interrupt` — deliver into the turn that is open RIGHT NOW. Correct for a correction, and the only
 *                 mode that lands while the target is mid-work.
 *
 * A steered prompt that is refused falls back to the other mode rather than being dropped: a hint that
 * arrives at the start of the next turn is still worth more than one that never arrives.
 */

import { PROMPT_MARKER, TRIGGER_TIMEOUT_MS, isPromptText } from './policy.js'
import { service } from './services.js'

/** What one trigger attempt did, with evidence. */
export interface TriggerReceipt {
  ok: boolean
  stage: string
  /** Which channel actually admitted it. */
  channel?: string
  /** The target's log already carried our marker, so nothing was sent. */
  alreadyTriggered?: true
  promptChars?: number
  warnings: string[]
  error?: { code: string; stage: string; message: string }
}

export interface TriggerOptions {
  /** Which mode to try FIRST. The other is used as a fallback. */
  mode?: 'queue' | 'interrupt'
  /** Override the prompt text. The marker is prepended when missing. */
  text?: string
  /** Abandon the attempt after this long. */
  timeoutMs?: number
  /** Skip the log check (tests, or a caller that just created the session). */
  skipIdempotence?: boolean
  /**
   * WHICH MARKER MARKS THIS CALLER'S PROMPTS.
   *
   * The default is this host's historically shared marker, which is what lets an EXISTING session's
   * log (written before this layer existed) still be recognised as already triggered. A caller with
   * its own marker — a different plugin, with prompts already in the field — passes its own text here,
   * and both the idempotence check and the stamping use it.
   *
   * Without this the idempotence check would look for one plugin's marker in another plugin's log and
   * conclude "never triggered", re-prompting a session that is already awake.
   */
  marker?: string
  /**
   * Try the OTHER mode when the first is refused. Default `true`.
   *
   * WHY A CALLER MAY WANT `false`: falling back changes what the user sees — a `queue` prompt that was
   * refused becomes an `interrupt` into a live turn, which is a stronger intervention than requested. A
   * caller whose own contract is "one mode, and a refusal is a REPORTED failure" says `false` here, and
   * keeps its refusal instead of silently escalating.
   */
  fallbackModes?: boolean
}

/**
 * The deadline: an AbortSignal that also doubles as the timeout.
 *
 * `release()` clears the timer on the success path. The rejected `expired` promise is pre-caught so
 * losing the race does not surface as an unhandled rejection.
 */
function deadline(timeoutMs: number): { signal: AbortSignal; release: () => void; expired: Promise<never> } {
  const controller = new AbortController()
  let rejectExpired: (error: Error) => void = () => {}
  const expired = new Promise<never>((_resolve, reject) => {
    rejectExpired = reject
  })
  const timer = setTimeout(() => {
    const error = new Error(`timeout after ${timeoutMs}ms`)
    controller.abort(error)
    rejectExpired(error)
  }, timeoutMs)
  if (typeof (timer as any).unref === 'function') (timer as any).unref()
  expired.catch(() => {})
  return { signal: controller.signal, release: () => clearTimeout(timer), expired }
}

/** Explain WHY the prompt died, in the one line a report keeps. */
function describeFailure(error: unknown, signal: AbortSignal): string {
  const message = String((error as any)?.message ?? error)
  if (signal?.aborted === true) {
    const reason = (signal as any).reason
    const why = typeof reason === 'string' ? reason : String((reason as any)?.message ?? 'deadline')
    return `${message} (aborted: ${why})`
  }
  return message
}

/** Messages that mean "this session does not exist", as opposed to "the read failed". */
const SESSION_MISSING = /not[- ]?found|no such session|SESSION_NOT_FOUND|未知会话/iu

/**
 * Has the target already been triggered by us?
 *
 * Returns `true` only on POSITIVE evidence. A missing session is `false` (it was certainly never
 * triggered — the resume inside `prompt` is what creates the live agent). Any OTHER read failure is
 * reported as unknown, which the caller must treat as failure rather than as done.
 */
export async function alreadyTriggered(
  readSession: ((id: string) => Promise<any>) | undefined,
  sessionId: string,
  marker: string = PROMPT_MARKER,
): Promise<{ known: boolean; triggered: boolean; reason?: string }> {
  if (typeof readSession !== 'function') return { known: false, triggered: false, reason: '无法读取目标日志' }
  let snapshot: any
  try {
    snapshot = await readSession(sessionId)
  } catch (error) {
    const message = String((error as any)?.message ?? error)
    if (SESSION_MISSING.test(message)) return { known: true, triggered: false }
    return { known: false, triggered: false, reason: `cannot read target log: ${message}` }
  }
  const events: any[] =
    snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.events) ? snapshot.events : []
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    const payload = event.data?.message ?? event.data
    const text = payload?.content?.[0]?.text
    if (isPromptText(text, marker)) return { known: true, triggered: true }
  }
  return { known: true, triggered: false }
}

/**
 * Admit ONE trigger prompt, through the first channel that works.
 *
 * Never throws: every failure is a receipt. A caller that believes ignition happened and does not see
 * work starting has no way to tell a slow start from a broken channel, so the outcome is always stated.
 */
export async function triggerSession(
  ctx: any,
  sessionId: string,
  options: TriggerOptions = {},
  /** The mode words this HOST's prompt request accepts — see `TriggerOptions.dialect`. */
  dialect: { queue: string; interrupt: string } = {
    queue: 'queue',
    interrupt: 'interrupt',
  },
): Promise<TriggerReceipt> {
  const warnings: string[] = []
  const marker = typeof options.marker === 'string' && options.marker.trim().length > 0 ? options.marker.trim() : PROMPT_MARKER
  const prompt = (() => {
    const custom = typeof options.text === 'string' ? options.text.trim() : ''
    if (custom.length === 0) return marker
    return custom.startsWith(marker) ? custom : `${marker} ${custom}`
  })()

  if (options.skipIdempotence !== true) {
    const query = service(ctx, 'sessionQuery', 'readSession')
    const readSession =
      typeof query === 'object' && query !== null && typeof (query as any).readSession === 'function'
        ? (id: string) => (query as any).readSession(id)
        : undefined
    const prior = await alreadyTriggered(readSession, sessionId, marker)
    if (prior.triggered) {
      return {
        ok: true,
        stage: 'trigger:already',
        alreadyTriggered: true,
        promptChars: prompt.length,
        warnings,
      }
    }
    if (!prior.known && prior.reason !== undefined) {
      // UNKNOWN is a failure, so the caller can retry rather than believe a lie.
      return {
        ok: false,
        stage: 'trigger:preflight',
        promptChars: prompt.length,
        warnings,
        error: { code: 'TARGET_LOG_UNREADABLE', stage: 'trigger', message: prior.reason },
      }
    }
  }

  const request = (mode: 'queue' | 'interrupt'): Record<string, unknown> => ({
    requestId: `paradise-trigger-${sessionId}-${Date.now().toString(36)}`,
    sessionId,
    // THE HOST'S WORD, not the protocol's: see `dialect`.
    mode: mode === 'interrupt' ? dialect.interrupt : dialect.queue,
    content: [{ type: 'text', text: prompt }],
  })

  const controller = service(ctx, 'sessionController', 'prompt')
  /**
   * THE REMOTE FACE, resolved WITHOUT asking for a method named `session`.
   *
   * `service(ctx, 'remote', 'session')` looks for a remote whose `session` property is a FUNCTION — but
   * this host's `remote.session` is an OBJECT carrying `prompt`. The method-filtered lookup therefore
   * returned `undefined` and silently dropped the fallback channel, so a host with only the Remote face
   * reported "no channel" while its prompt was one property away. Resolving the service plainly and
   * unwrapping `.session` afterwards is what the original code did, and what this host needs.
   */
  const remote = service(ctx, 'remote')
  const channels: Array<[string, (mode: 'queue' | 'interrupt', signal: AbortSignal) => Promise<unknown>]> = []
  if (typeof controller === 'object' && controller !== null && typeof (controller as any).prompt === 'function') {
    channels.push([`sessionController.prompt`, (mode, signal) => (controller as any).prompt(request(mode), signal)])
  }
  const remoteSession = (remote as any)?.session ?? remote
  if (typeof remoteSession === 'object' && remoteSession !== null && typeof (remoteSession as any).prompt === 'function') {
    channels.push([`remote.session.prompt`, (mode, signal) => (remoteSession as any).prompt(request(mode), signal)])
  }
  if (channels.length === 0) {
    return {
      ok: false,
      stage: 'trigger:channel',
      promptChars: prompt.length,
      warnings,
      error: {
        code: 'NO_TRIGGER_CHANNEL',
        stage: 'trigger',
        message: '没有可用的点火通道（sessionController.prompt 与 remote.session.prompt 都未挂载）',
      },
    }
  }

  const primary = options.mode === 'interrupt' ? 'interrupt' : 'queue'
  const modes: Array<'queue' | 'interrupt'> =
    options.fallbackModes === false
      ? [primary]
      : primary === 'interrupt'
        ? ['interrupt', 'queue']
        : ['queue', 'interrupt']
  const failures: string[] = []
  for (const [label, run] of channels) {
    for (const mode of modes) {
      const { signal, release, expired } = deadline(options.timeoutMs ?? TRIGGER_TIMEOUT_MS)
      try {
        const settled = await Promise.race([run(mode, signal), expired])
        // A reply that explicitly says `accepted: false` is a refusal, not an admission.
        const accepted = settled !== null && typeof settled === 'object' ? (settled as any).accepted !== false : true
        if (accepted) {
          return { ok: true, stage: `trigger:${mode}`, channel: `${label}(${mode})`, promptChars: prompt.length, warnings }
        }
        failures.push(`${label}(${mode}): 未被接受`)
      } catch (error) {
        failures.push(`${label}(${mode}): ${describeFailure(error, signal)}`)
      } finally {
        release()
      }
    }
  }
  return {
    ok: false,
    stage: 'trigger:channel',
    promptChars: prompt.length,
    warnings,
    error: { code: 'TRIGGER_REFUSED', stage: 'trigger', message: failures.join(' | ') },
  }
}
