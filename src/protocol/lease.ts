/**
 * LEASE — mutual exclusion over keyed durable state, with FENCING.
 *
 * THE PROBLEM THIS SOLVES, IN THIS ECOSYSTEM'S OWN TERMS
 *
 * Two background jobs now touch the same durable state: `harvest` (the memory plugin's background
 * extraction) and `graft` (the slicing plugin's physical handoff). Both are triggered by turns, both
 * can be running in more than one process — a restarted host alongside a half-shut-down one, a CLI
 * harvest alongside the desktop — and both read-modify-write documents that were never designed for
 * concurrent writers. The plugins already carry a `mkdir`-based file lock, which works but is:
 *
 *   - FILESYSTEM-SHAPED. It takes a path, so only a plugin that owns the directory can use it.
 *   - NOT FENCED. A holder that stalls past its own timeout can wake up and write over a newer
 *     generation, because nothing in the write path knows "you are stale".
 *   - NOT RECOVERABLE. A crashed holder leaves a directory that a later process must guess about.
 *
 * A lease fixes the third and the second, and the first is fixed by building it on `StorageAdapter`
 * (keys, not paths) instead of on `mkdir`.
 *
 * WHAT MAKES IT A LEASE AND NOT A LOCK
 *
 *   1. IT EXPIRES. A lease is valid until `expiresAt`. A holder that dies stops blocking anyone after
 *      that moment, so there is no state a rescue has to guess about.
 *   2. IT IS GENERATION-STAMPED. Every acquisition BUMPS `epoch`. That number is the FENCING TOKEN: a
 *      holder may only renew or release the exact epoch it acquired, so a stalled process whose lease
 *      has since expired cannot come back and overwrite its successor's work — its CAS simply fails.
 *   3. IT EXPOSES WHO HOLDS IT. A refusal answers with the current holder, because "busy" without a
 *      name is not actionable.
 *
 * WHAT IT IS NOT
 *
 * Not a distributed consensus protocol. It gives mutual exclusion and stale-writer rejection for
 * several processes on ONE host, over a storage adapter whose `compareAndSet` is atomic. Across hosts
 * on a shared filesystem it degrades exactly as far as that filesystem does — which is why
 * `LeaseAdapter.exclusive` states whether real exclusion is available, instead of pretending.
 *
 * NO HOST NAMES BELOW. See `test/protocol-purity.test.mjs`.
 */

import type { MutationReceipt } from './types.js'

/** A held (or expired) claim on one key. */
export interface LeaseRecord {
  /** The key this lease protects. Stored INSIDE the record so a torn write is detectable. */
  readonly key: string
  /** Opaque holder identity — a process, a job, a plugin. Never parsed by this layer. */
  readonly owner: string
  /**
   * THE FENCING TOKEN. Monotonically increasing per key; every acquisition bumps it.
   *
   * A writer that wants to prove it is still the current holder presents its epoch, and a stale one
   * fails the comparison instead of silently overwriting newer state.
   */
  readonly epoch: number
  /** When this holder took it, for an audit line. */
  readonly acquiredAt: number
  /** When it stops being valid without a renewal. */
  readonly expiresAt: number
  /**
   * A caller-supplied tag, carried for DIAGNOSTICS.
   *
   * WHY IT MUST BE PERSISTED RATHER THAN REMEMBERED BY THE HOLDER: the only moment anyone needs it is
   * when the holder is NOT answering — a caller that cannot take the lease wants to say WHO has it and
   * WHAT they were doing. A label kept in the waiter's own memory would be missing from exactly that
   * message.
   */
  readonly label?: string
}

/** What an acquisition attempt produced, including WHY it was refused. */
export interface LeaseAttempt {
  readonly ok: boolean
  readonly stage: string
  readonly lease?: LeaseRecord
  /** Present when refused: who is in the way, and until when. */
  readonly holder?: LeaseRecord
  readonly warnings: readonly string[]
  readonly reason?: string
}

/** Knobs a caller supplies. All optional: the adapter owns the defaults. */
export interface LeaseRequest {
  /** How long the claim stays valid without renewal. */
  readonly ttlMs?: number
  /** Who is asking. Defaults to this process, which is right for every caller today. */
  readonly owner?: string
  /** How long to wait for a held lease before giving up. Zero means "do not wait". */
  readonly waitMs?: number
  /** Injectable clock, so expiry is testable without sleeping. */
  readonly now?: number
  /** A tag that travels WITH the record, so a blocked caller can name the holder's purpose. */
  readonly label?: string
}

export interface LeaseAdapter {
  readonly name: string
  /**
   * CAN THIS HOST PROVIDE REAL EXCLUSION?
   *
   * `true` means `acquire` is decided by an atomic read-modify-write, so two simultaneous callers
   * cannot both win. `false` means the adapter can only read and write, and the answer is ADVISORY —
   * a caller that needs a guarantee must refuse rather than trust it.
   */
  readonly exclusive: boolean
  acquire(key: string, request?: LeaseRequest): Promise<LeaseAttempt>
  /** Extend an existing claim. Fails if the epoch is no longer current. */
  renew(lease: LeaseRecord, request?: LeaseRequest): Promise<LeaseAttempt>
  /** Give up a claim. Fails (and says so) if the epoch is no longer current. */
  release(lease: LeaseRecord): Promise<MutationReceipt>
  /** Who holds this key, if anyone and not expired. */
  inspect(key: string): Promise<LeaseRecord | undefined>
}

/**
 * WHAT `verify` RETURNS TO MEAN "REMOVE THE KEY".
 *
 * A release is a read-modify-write like any other — it must be checked against the epoch before it
 * deletes, or a stale holder could delete its successor's claim — but its RESULT is the absence of a
 * document rather than a document. A sentinel keeps that inside the one atomic primitive instead of
 * adding a second, subtly different, compare-and-remove.
 */
export const LEASE_RELEASE = Symbol.for('paradise.lease.release')

/* ── pure helpers: the rules, stated once and testable without a host ───────────────────────── */

/** Is this claim no longer valid at `now`? A missing/garbled `expiresAt` counts as expired. */
export function isLeaseExpired(lease: LeaseRecord | undefined, now: number = Date.now()): boolean {
  if (lease === undefined) return true
  const expiresAt = Number(lease.expiresAt)
  if (!Number.isFinite(expiresAt)) return true
  return expiresAt <= now
}

/**
 * Is `candidate` the SAME GENERATION as `current`?
 *
 * THE FENCE. Both facts are required: an owner match alone would let a process that restarted with a
 * recycled id write over its successor, and an epoch match alone would let a DIFFERENT owner that
 * happens to hold the same epoch through a torn write do the same.
 */
export function leaseOwnedBy(current: LeaseRecord | undefined, candidate: LeaseRecord | undefined): boolean {
  if (current === undefined || candidate === undefined) return false
  return current.owner === candidate.owner && Number(current.epoch) === Number(candidate.epoch)
}

/** One line for an audit log, so a refusal can name the holder without a second lookup. */
export function describeLease(lease: LeaseRecord | undefined): string {
  if (lease === undefined) return '无持有者'
  const ttl = Number(lease.expiresAt) - Date.now()
  return `持有者=${lease.owner} epoch=${lease.epoch} 剩余≈${Math.max(0, Math.round(ttl / 1000))}s`
}

/* ── the DECISIONS, written once and shared by every driver ────────────────────────────────── */

/**
 * WHY THESE ARE PURE FUNCTIONS RATHER THAN TWO IMPLEMENTATIONS
 *
 * A caller with an asynchronous storage handle and a caller with a plain synchronous one need
 * different DRIVERS — one awaits a host's `compareAndSet`, the other does an exclusive file create —
 * but they must not need different RULES. If the acquisition rule lived inside each driver, the two
 * would drift on the exact questions that matter (is an expired lease takeable? does re-acquiring my
 * own lease bump the epoch? may a stale holder renew?), and the two callers would disagree about who
 * holds a key without either being obviously wrong.
 *
 * So the drivers do only I/O, and the decisions live here: same inputs, same answer, whoever asks.
 */

/** What an acquisition decided. */
export type AcquireDecision =
  | { readonly ok: true; readonly lease: LeaseRecord }
  | { readonly ok: false; readonly holder?: LeaseRecord }

/**
 * MAY THIS CALLER TAKE THE KEY?
 *
 * Two cases are NOT refusals, and both matter:
 *   - no record at all;
 *   - an EXPIRED record (a dead holder must not pin a key forever);
 *   - our OWN live record — re-acquiring what we already hold is a renewal in effect, and refusing it
 *     would make a retry loop spin against itself. It still BUMPS the epoch: a re-acquire is a new
 *     generation even for the same owner, which invalidates any earlier claim that owner still holds.
 */
export function planAcquire(
  key: string,
  current: LeaseRecord | undefined,
  request: { owner: string; now: number; ttlMs: number; label?: string },
): AcquireDecision {
  if (current !== undefined && current.owner !== request.owner && !isLeaseExpired(current, request.now)) {
    return { ok: false, holder: current }
  }
  const epoch = Math.max(0, Number(current?.epoch) || 0) + 1
  return {
    ok: true,
    lease: {
      key,
      owner: request.owner,
      epoch,
      acquiredAt: request.now,
      expiresAt: request.now + request.ttlMs,
      ...(request.label === undefined ? {} : { label: request.label }),
    },
  }
}

/**
 * MAY THIS HOLDER EXTEND ITS CLAIM? `undefined` means no.
 *
 * THE FENCE, IN ONE CONDITION: owner AND epoch must both still match, and the lease must not have
 * expired. Any of the three failing means this generation is over.
 */
export function planRenew(
  current: LeaseRecord | undefined,
  held: LeaseRecord,
  request: { now: number; ttlMs: number },
): LeaseRecord | undefined {
  if (current === undefined) return undefined
  if (current.owner !== held.owner || current.epoch !== held.epoch) return undefined
  if (isLeaseExpired(current, request.now)) return undefined
  return { ...current, expiresAt: request.now + request.ttlMs }
}

/**
 * MAY THIS HOLDER GIVE THE KEY UP? `undefined` means no.
 *
 * The same fence as `planRenew`, and it matters MORE here: deleting a successor's claim would hand the
 * key to a third writer while the successor still believes it is alone. A refused release is the
 * CORRECT outcome for a stale holder, not an error to work around.
 */
export function planRelease(current: LeaseRecord | undefined, held: LeaseRecord): typeof LEASE_RELEASE | undefined {
  if (current === undefined) return undefined
  if (current.owner !== held.owner || current.epoch !== held.epoch) return undefined
  return LEASE_RELEASE
}
