/**
 * PUBLISH — workspace attachment and client announcement. **IMPLEMENTED — this file is the CONTRACT,
 * `session-writer.ts` is the implementation.**
 *
 * ── THE DEFECT THIS FILE USED TO CARRY (fixed 2026-11-09, 批次 D) ─────────────────────────────
 *
 * Its first line said "P2: contract only, not implemented", and it exported
 * `publishNotImplemented()`, which threw `NOT_IMPLEMENTED`. Both were FALSE, and had been for a while:
 * the real publishing runs inside `createColdSession` in `../dsh/session-writer.ts` (see
 * `stage = 'publish'`, ~line 419) — resolve the workspace by path, create it when missing, attach the
 * session, then `ctx.emit('api-session/added', summary)`, with every failure pushed into `warnings`.
 * The old file was an orphan contract nobody called, describing an implementation that had moved on
 * without it. A reader who trusted it would conclude the feature did not exist.
 *
 * ── WHY THIS IS HOST-SPECIFIC AND THEREFORE LIVES HERE ────────────────────────────────────────
 *
 * "Attach the session to a workspace group and tell the client it exists" is this runtime's idea of
 * appearing in a sidebar. A different harness may have no sidebar, no workspace registry, and no
 * announcement event. The protocol models the OUTCOME (`SessionRef` exists and is findable); how a
 * given host makes something findable is its own business.
 *
 * ── THE TWO STEPS, AND THEIR DIFFERENT SEVERITIES ─────────────────────────────────────────────
 *
 *   1. workspace registry resolve + attach — cosmetic grouping. A failure means "ungrouped", never
 *      "the artifact is invalid".
 *   2. client announcement — the client learns the session exists ONLY from this event on this host.
 *      A failure means the user must refresh to see it.
 *
 * Both land in the receipt's `warnings`, are never swallowed, and never turn a good artifact into a
 * reported failure. Note the announcement is additionally guarded by `assertSessionSummary` (P1-3):
 * an unresolvable payload is SKIPPED and reported rather than emitted, because a summary the peer
 * cannot key by is silent on every side.
 */

/**
 * What the write receipt carries for the publishing stage.
 *
 * `WriteReceipt` in `../dsh/session-writer.ts` `extends` this interface, which is what makes the
 * contract real rather than aspirational: if the writer stops reporting one of these fields, the type
 * error appears in the writer, not months later in a consumer.
 */
export interface PublishReceipt {
  /** Publishing never fails the write: an artifact already on disk is never reported as an error. */
  ok: boolean
  /** The session joined a workspace group. `false` is REPORTED, and the sidebar may not show it. */
  workspaceAttached: boolean
  /** The client was told the session exists. `false` means "a refresh is needed to see it". */
  clientAnnounced: boolean
  /** Non-fatal problems, stated. An empty array is a claim, so it must be earned. */
  warnings: string[]
}

/** The capability names this layer needs for publishing, as THIS host spells them. */
export const PUBLISH_CAPABILITIES = ['workspaceRegistry.resolveByPath', 'ctx.emit'] as const

/**
 * The publishing stage is implemented; the old blocking helper is gone on purpose.
 *
 * KEPT AS A COMMENT, NOT AS CODE: `publishNotImplemented()` used to live here and threw
 * `NOT_IMPLEMENTED`. It had no caller — the write path publishes inline — so leaving a thrower in the
 * public surface advertised an unimplemented state that did not exist. `grep publishNotImplemented`
 * is now empty in this repository, which is the acceptance condition the audit asked for.
 */
