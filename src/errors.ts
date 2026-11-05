/**
 * The error vocabulary of the paradise layer.
 *
 * WHY `stage` IS MANDATORY HERE (draft §6.1, row 4)
 *
 * The two existing plugins disagree on error shape: one throws a bare code+message with no stage, the
 * other carries `code + stage` and the caller attributes by stage. The stricter one wins, because
 * "which of the seven steps failed?" is the question every incident starts with, and a bare message
 * does not answer it.
 *
 * `ParadiseError` therefore ALWAYS has `code`, `stage` and the original `stack`, and an error crossing
 * the boundary from anywhere else is wrapped rather than rethrown bare.
 *
 * THE STAGE NAMES ARE DELIBERATELY GENERIC. They describe WHERE in a write a failure happened — not
 * which function of which host was called. A stage called `create` is meaningful on any runtime; a
 * stage named after one runtime's service method would not be.
 */

export type ParadiseStage =
  | 'locate'      // finding the artifact (path, header)
  | 'prepare'     // reserving a detached container
  | 'create'      // committing the container
  | 'append'      // writing events into it
  | 'flush'       // making the write durable
  | 'verify'      // cold read-back
  | 'discard'     // rollback
  | 'read'        // disk / cold read
  | 'publish'     // workspace attach + client announce
  | 'ignite'      // triggerTurn
  | 'unknown'

export class ParadiseError extends Error {
  readonly code: string
  readonly stage: ParadiseStage
  /** The original error, when this wraps one. */
  readonly cause?: unknown

  constructor(code: string, stage: ParadiseStage, message: string, cause?: unknown) {
    // The code is part of the message so the host log is greppable without a structured reader.
    super(`[${code}] ${message}`)
    this.name = 'ParadiseError'
    this.code = code
    this.stage = stage
    this.cause = cause
    const originalStack = typeof (cause as any)?.stack === 'string' ? (cause as any).stack : ''
    if (originalStack.length > 0) {
      this.stack = `${this.stack ?? message}\n--- original stack ---\n${originalStack}`
    }
  }
}

/** Wrap anything into a `ParadiseError` without losing the original message or stack. */
export function asParadiseError(
  error: unknown,
  fallbackCode: string,
  fallbackStage: ParadiseStage,
): ParadiseError {
  if (error instanceof ParadiseError) return error
  const message = String((error as any)?.message ?? error)
  return new ParadiseError(fallbackCode, fallbackStage, message, error)
}

/**
 * The one error a MISSING dependency must produce.
 *
 * Draft §7 risk 2 states the danger: paradise is a third package, and if its activation fails the
 * two plugins that depend on it must not simply die. But the opposite failure is worse and quieter —
 * a caller that silently keeps running on a code path it believes is supported while every read
 * returns empty. So a dependency that is absent, or present with a different shape, is a NAMED
 * error with a stated consequence; the caller decides whether to degrade, and says so.
 */
export class ParadiseUnavailableError extends ParadiseError {
  /** What the caller can still do without this layer. */
  readonly consequence: string

  constructor(message: string, consequence: string, cause?: unknown) {
    super('PARADISE_UNAVAILABLE', 'locate', message, cause)
    this.name = 'ParadiseUnavailableError'
    this.consequence = consequence
  }
}
