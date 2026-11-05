/**
 * The NEUTRAL policy helpers — no host vocabulary, no host constants.
 *
 * WHAT IS LEFT AFTER THE HOST-SPECIFIC PARTS MOVED OUT
 *
 * Everything that was a fact about one runtime now lives in `adapters/<host>/policy.ts`: which event
 * kinds its view renders, which type it writes for each intent, the durable file name, the plugin
 * marker's exact spelling. This file keeps only the shape questions that any adapter can answer for
 * itself, plus one string check that is genuinely universal.
 *
 * The distinction matters for the self-repair goal: when a runtime changes its rendering rules, an
 * AI edits `adapters/<host>/policy.ts` and stops. If these constants were still here, it would be
 * editing the layer every plugin depends on.
 */

/**
 * The minimum shape of a provenance marker, as a PATTERN rather than a value.
 *
 * `<namespace>:<owner>:<name>` — e.g. `plugin:observer:briefing`. The protocol requires provenance on
 * every injected item; this is the one spelling rule that is not host-specific, because it exists to
 * be parsed by OTHER tools (a slicer deciding what a human said), not by any runtime.
 */
const PROVENANCE_PATTERN = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/u

/**
 * Is this a well-formed provenance marker?
 *
 * A marker that parses is not automatically trusted — it is a claim, and the adapter decides whether
 * to honour it. But a marker that does NOT parse is definitely wrong, and catching that here means
 * every adapter does not have to.
 */
export function isWellFormedProvenance(origin: unknown): boolean {
  return typeof origin === 'string' && PROVENANCE_PATTERN.test(origin)
}

/** Normalise a caller's intent to the two values the protocol allows. */
export function normaliseVisibility(value: unknown): 'visible' | 'context-only' {
  return value === 'context-only' ? 'context-only' : 'visible'
}

/** A stable, opaque session key derived from a prefix and a counter — no host semantics implied. */
export function opaqueId(prefix: string, counter: number): string {
  return `${prefix}-${counter.toString(36)}-${Date.now().toString(36)}`
}
