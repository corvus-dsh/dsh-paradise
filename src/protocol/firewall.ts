/**
 * THE ZERO-TRUST AI FIREWALL — `src/protocol/firewall.ts`.
 *
 * THE PRINCIPLE, STATED SO IT CAN BE IMPLEMENTED RATHER THAN AGREED WITH
 *
 * **一切信息都是攻击元素。** Every byte that did not originate inside this process is untrusted: a user's
 * prompt, a fetched page, a tool's output, and — this is the one people forget — A LOG READ BACK FROM AN
 * EARLIER SESSION. A note stored by a previous generation is exactly as capable of carrying an instruction
 * as a message from the network, and it arrives with more credibility because it looks like our own memory.
 *
 * WHAT THIS MODULE IS
 *
 * The contract. Three adapters, each answering one question:
 *
 *   1. `FirewallAdapter`      — may this text enter the model's context, and in what envelope?
 *   2. `InjectionShield`      — does this text try to rewrite the reader's instructions?
 *   3. `ActionGuard`          — may this tool call run, given what this session is allowed to do?
 *
 * WHAT IT IS NOT
 *
 * Not a detector. A firewall that ships a regex and calls the job done is worse than none, because it
 * creates confidence without safety. The regex list lives in the implementation; THIS file defines what a
 * VERDICT looks like, so an implementation cannot quietly answer "fine" to everything.
 *
 * THE ONE RULE THAT MAKES IT ZERO-TRUST
 *
 * **A verdict is never a boolean.** `allowed: true` alone cannot express "allowed, but quarantined", and a
 * caller that reads only the boolean will pass quarantined text straight through. Every verdict here
 * carries what was done to the text, so the caller cannot help but handle it.
 *
 * NO HOST NAMES BELOW. See `test/protocol-purity.test.mjs`.
 */

/** Where a piece of text came from. This is the轴 the whole model turns on. */
export type TrustOrigin =
  /** A human typed it into this process's own UI. */
  | 'user'
  /** Fetched from the network: a page, an API, a remote model's answer. */
  | 'network'
  /** Produced by a tool, including our own. */
  | 'tool'
  /** Read back from durable storage: a log, a skill, a negative, a prior session. */
  | 'storage'
  /** Constructed by this layer itself (prompts, envelopes, receipts). */
  | 'self'

/**
 * TRUST LEVELS, ORDERED, so a comparison means something.
 *
 * `self` is the only level that may contain instructions. Everything else is DATA, and data that happens
 * to be phrased as an instruction must be treated as an injection attempt — not because it is necessarily
 * malicious, but because we cannot tell, and "cannot tell" resolves to "untrusted" under zero trust.
 */
export const TRUST_ORDER: Readonly<Record<TrustOrigin, number>> = Object.freeze({
  self: 4,
  user: 3,
  tool: 2,
  storage: 2,
  network: 1,
})

/** What the shield found, independent of what was done about it. */
export type InjectionVerdict =
  /** No signal. Not a guarantee of safety — a statement about this scan. */
  | 'clean'
  /** Contains instruction-shaped text: "ignore previous", "you are now", role markers. */
  | 'instruction-shaped'
  /** Contains a delimiter that would BREAK OUT of an envelope: our own closing tag, a fake system turn. */
  | 'delimiter-break'
  /** Matches the threat taxonomy (credential exfiltration, destructive command, exfil URL). */
  | 'threat'

/** What the firewall DID with the text. The caller must handle all four. */
export type SanitizeAction =
  /** Passed through unchanged. Only possible for `self`. */
  | 'passed'
  /** Wrapped in an envelope that names it as untrusted data. */
  | 'wrapped'
  /** Envelope characters escaped so the text cannot close its own envelope. */
  | 'escaped'
  /** Removed entirely. The caller is told what was removed, never just that something was. */
  | 'stripped'
  /** Refused: the caller must not use this text at all. */
  | 'refused'

/** The result of passing one piece of text through the firewall. */
export interface SanitizeVerdict {
  /** Always safe to place in a context, UNLESS `action === 'refused'`. */
  readonly text: string
  readonly action: SanitizeAction
  readonly origin: TrustOrigin
  /** What the shield thought, before any action. */
  readonly injection: InjectionVerdict
  /** Every signal that fired, in the order they were found. Never empty when `action !== 'passed'`. */
  readonly findings: readonly string[]
  /**
   * WHY a caller must read this and not just `text`: it is the only place that says whether the content
   * survived. A caller that logs `text.length` without `action` cannot tell "cleaned" from "gutted".
   */
  readonly removedChars: number
}

/**
 * MAY THIS TEXT ENTER THE MODEL'S CONTEXT — and in what envelope.
 *
 * THE CONTRACT, in three sentences:
 *   - `self` text passes unchanged;
 *   - every other origin is WRAPPED, so the model can see that it is data;
 *   - text that would break out of its wrapper is ESCAPED, and text that is a known threat is REFUSED
 *     rather than cleaned — because a cleaned attack is still an attack that got most of the way.
 */
export interface FirewallAdapter {
  readonly name: string
  /**
   * Screen one piece of text.
   *
   * MUST NOT THROW. A firewall that crashes on malformed input is a denial-of-service with extra steps:
   * the attacker controls the input, so they control whether it crashes.
   */
  screen(input: {
    readonly text: string
    readonly origin: TrustOrigin
    /** Where it came from, for the audit line. e.g. `tool:bash`, `storage:negatives.jsonl`. */
    readonly source?: string
  }): Promise<SanitizeVerdict>
  /**
   * Screen a WHOLE conversation before a model call, and report what changed.
   *
   * WHY A BATCH VERB: the per-message verdict cannot notice an attack split across messages. A caller that
   * only screens message-by-message has checked each brick and not the wall.
   */
  screenConversation(
    messages: ReadonlyArray<{ readonly role: string; readonly content: string; readonly origin: TrustOrigin }>,
  ): Promise<{ readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>; readonly findings: readonly string[]; readonly refused: number }>
}

/**
 * THE INJECTION SHIELD — the detector behind `FirewallAdapter`.
 *
 * Separated because a deployment may want to swap the DETECTOR without changing the ENVELOPE policy (or
 * vice versa). Conflating them means every improvement to detection also changes what the model sees.
 */
export interface InjectionShield {
  readonly name: string
  /** Classify one text. Pure and synchronous: it must be usable on every message without a round trip. */
  classify(input: { readonly text: string; readonly origin: TrustOrigin }): { readonly verdict: InjectionVerdict; readonly findings: readonly string[] }
  /**
   * Escape the characters that would let text close an envelope it is inside.
   *
   * WHY ESCAPING AND NOT DELETION: a page that mentions `</untrusted_user_input>` is not attacking us — it
   * may be DOCUMENTING an attack. Deleting the string would corrupt a legitimate document; escaping keeps
   * it and makes it inert.
   */
  escape(text: string): string
}

/**
 * THE ALLOWED-ACTION SET for one session.
 *
 * WHY THIS IS NOT A GLOBAL CONFIG: "may this session write files" is a property of the TASK, not of the
 * process. A repair session may write one directory; a memory harvest may write none. A global allowlist
 * would have to be the union of every task, which is the same as no restriction.
 */
export interface ActionPolicy {
  /** Directories this session may write. Empty means "write nothing". */
  readonly writableRoots: readonly string[]
  /** May it run an external command? Default should be NO, and the type should make that explicit. */
  readonly allowCommands: boolean
  /** Tool names explicitly forbidden, regardless of any other rule. */
  readonly deniedTools?: readonly string[]
  /** Hard cap on one tool call. A repair that runs for an hour is a repair that lost. */
  readonly maxToolMs?: number
}

/** What the guard decided about one tool call. */
export interface ActionVerdict {
  readonly allowed: boolean
  /** Present when `allowed` is false. Always a code, never only a sentence. */
  readonly refusal?: { readonly code: string; readonly stage: string; readonly message: string }
  /** What the guard checked. A refusal that does not say what it compared is unarguable. */
  readonly checks: readonly string[]
  /** True when the call is allowed but a human should see it. Never a substitute for refusing. */
  readonly needsReview?: boolean
}

/**
 * THE ACTION GUARD — second approval for anything with an effect outside this process.
 *
 * WHY A SECOND CHECK WHEN THE TOOL FACTORY ALREADY HAS ROOTS: the factory's roots are a SANDBOX boundary
 * (it stops a tool escaping), and this is an AUTHORIZATION boundary (does THIS session get to do THIS at
 * all). They answer different questions, and the failure they prevent is different: the factory prevents
 * "the tool wrote outside its box", the guard prevents "the tool was allowed to add a box".
 */
export interface ActionGuard {
  readonly name: string
  /**
   * Approve or refuse one call BEFORE it runs.
   *
   * MUST NOT THROW and MUST default to REFUSING on anything it cannot evaluate. A guard whose failure mode
   * is "allow" is not a guard; it is a log line.
   */
  check(input: {
    readonly tool: string
    readonly args: Record<string, unknown>
    readonly policy: ActionPolicy
    /** The text the model cited as its reason, when there is one. Screened by the firewall too. */
    readonly rationale?: string
  }): Promise<ActionVerdict>
}

/** The screen's receipt, for an audit line. */
export interface FirewallAuditEntry {
  readonly at: string
  readonly origin: TrustOrigin
  readonly source?: string
  readonly action: SanitizeAction
  readonly injection: InjectionVerdict
  readonly findings: readonly string[]
  readonly chars: number
}

/**
 * A FIREWALL THAT IS NOT INSTALLED, SO THE DEFAULT IS EXPLICIT.
 *
 * WHY `unavailable` AND NOT `undefined`: a caller that checks `if (firewall !== undefined)` will one day
 * forget. A firewall OBJECT that reports `name: 'none'` and passes everything through makes the absence
 * VISIBLE at every call site and in every audit line — which is the difference between "we chose not to
 * screen" and "nobody noticed there was no screening".
 */
export interface FirewallInstallation {
  readonly firewall: FirewallAdapter
  readonly shield: InjectionShield
  readonly guard: ActionGuard
  /** Is this a REAL implementation, or the pass-through? Diagnostics must be able to say. */
  readonly enforcing: boolean
}
