/**
 * PUBLISH — workspace attachment and client announcement. **P2: contract only, not implemented.**
 *
 * WHY THIS IS HOST-SPECIFIC AND THEREFORE LIVES HERE
 *
 * "Attach the session to a workspace group and tell the client it exists" is this runtime's idea of
 * appearing in a sidebar. A different harness may have no sidebar, no workspace registry, and no
 * announcement event. The protocol models the OUTCOME (`SessionRef` exists and is findable); how a
 * given host makes something findable is its own business.
 *
 * THE TWO STEPS, AND THEIR DIFFERENT SEVERITIES
 *
 *   1. workspace registry resolve + attach — cosmetic grouping. A failure means "ungrouped", never
 *      "the artifact is invalid".
 *   2. client announcement — the client learns the session exists ONLY from this event on this host.
 *      A failure means the user must refresh to see it.
 *
 * Both must land in the receipt's `warnings`, never be swallowed, and never turn a good artifact into
 * a reported failure.
 */

import { writeNotImplemented } from '../../write/contract.js'

/** What the receipt must carry once this is implemented. */
export interface PublishReceipt {
  ok: boolean
  workspaceAttached: boolean
  clientAnnounced: boolean
  /** Non-fatal problems, stated. An empty array is a claim, so it must be earned. */
  warnings: string[]
}

/** The capability names this layer needs, as THIS host spells them. */
export const PUBLISH_CAPABILITIES = ['workspaceRegistry.resolveByPath', 'ctx.emit'] as const

export function publishNotImplemented(): never {
  return writeNotImplemented('publish(workspace/announce)')
}
