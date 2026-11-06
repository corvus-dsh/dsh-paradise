/**
 * NETWORK STORAGE — the same contract as a local store, plus the one fact a network adds.
 *
 * WHY THIS IS A SEPARATE MODULE FROM `adapters.ts`
 *
 * `StorageAdapter` answers "can I store and fetch a value, atomically". That contract is HONEST ON ONE
 * MACHINE and quietly optimistic across a network: `write` either succeeds or throws, but a remote write
 * can be ACCEPTED and later LOST, or DUPLICATED by a retry, and neither outcome is expressible in the
 * local contract. A caller that cannot tell those apart will double-apply a ticket.
 *
 * So the network tier does not widen `StorageAdapter`; it EXTENDS it with the vocabulary a distributed
 * caller needs, and states which guarantees are real:
 *
 *   - EVERY mutation carries an IDEMPOTENCY KEY. A retry is the same key, so the far side can collapse
 *     two deliveries into one effect. Without this, "the network timed out" and "the write happened" are
 *     indistinguishable, and the only safe caller is one that never retries.
 *
 *   - EVERY read reports WHICH NODE ANSWERED and HOW STALE it might be. A caller making a decision from
 *     a replica needs to know it is making it from a replica.
 *
 *   - A WRITE RETURNS A VERSION, and `compareAndSet` takes a version. This is optimistic concurrency in
 *     the one form that survives a network: "update only if the value is still the one I read".
 *
 * WHAT IS DELIBERATELY ABSENT
 *
 * No consensus, no membership, no leader election, no vector clocks. Those are properties of a specific
 * distributed algorithm, and putting them in a storage interface would force every implementation to
 * pretend it has them. A store that cannot offer real cross-node exclusion says so through `guarantees`,
 * exactly as the local lease says so through `exclusive`.
 *
 * NO HOST NAMES BELOW. See `test/protocol-purity.test.mjs`.
 */

import type { MutationReceipt, ProtocolFailure } from './types.js'
import type { StorageAdapter, StorageReadStatus } from './adapters.js'

/**
 * WHAT A NETWORK STORE CAN HONESTLY PROMISE.
 *
 * Each field is a claim the implementation must be able to defend; a caller reads them BEFORE deciding
 * whether a read is authoritative.
 */
export interface NetworkGuarantees {
  /**
   * Can two nodes' writes be ordered consistently?
   *
   * `true` means the store provides a single linearizable history. A store replicated by gossip says
   * `false` and a caller that needs ordering must use `compareAndSet` and be ready to retry.
   */
  readonly linearizable: boolean
  /**
   * How long a replica may serve a stale value, in milliseconds. `0` means "this call went to the
   * primary", which is the only value that makes a read authoritative.
   */
  readonly staleByMs: number
  /**
   * Does a retry with the same idempotency key produce exactly one effect?
   *
   * `false` is a legitimate answer, and a caller that needs it must not use this store for that write.
   */
  readonly idempotentRetries: boolean
  /**
   * Is `compareAndSet` atomic ACROSS nodes, or only within one?
   *
   * `'none'` means the method exists but is only as strong as one node's local exclusion — the same
   * honesty the local lease states through `exclusive`.
   */
  readonly compareAndSetScope: 'cluster' | 'node' | 'none'
}

/** Where a value came from, and how much it can be trusted. */
export interface NetworkReadReport {
  readonly value: unknown
  /** Same vocabulary as the local read report, so a caller learns one shape. */
  readonly status: StorageReadStatus
  /** Opaque id of the node that answered. Diagnostic; never compared for ordering. */
  readonly servedBy: string
  /** Monotonic version of this value at the serving node. Present when the store numbers writes. */
  readonly version?: number
  /** How stale the answer may be. `0` means authoritative. */
  readonly stalenessMs: number
  readonly warnings: readonly string[]
}

/** One key's write, as a remote side receives it. */
export interface NetworkWriteRequest {
  readonly key: string
  readonly value: unknown
  /**
   * THE KEY THAT MAKES A RETRY SAFE. Same key = same intended effect.
   *
   * REQUIRED, not optional. A network write without one cannot be retried, and a caller that cannot
   * retry is a caller that fails on the first dropped packet.
   */
  readonly idempotencyKey: string
  /** The version the caller read, when it wants an optimistic check. Absent means "overwrite". */
  readonly expectedVersion?: number
}

/**
 * A STORAGE ADAPTER THAT MAY LIVE ON ANOTHER MACHINE.
 *
 * It EXTENDS the local contract rather than replacing it: every member of `StorageAdapter` still means
 * what it meant, so a caller written against the local interface keeps working — it simply cannot use
 * the network-only members. That direction matters: widening an interface must not invalidate the
 * narrow implementation.
 */
export interface NetworkStorageAdapter extends StorageAdapter {
  /** This store's honest self-description. Read it before trusting a read. */
  readonly guarantees: NetworkGuarantees
  /** The node this adapter is currently talking to. Diagnostic only. */
  readonly endpoint: string
  /** The local read report, plus provenance. Falls back to `read` when a store cannot report more. */
  readRemote(key: string): Promise<NetworkReadReport>
  /** A write that survives a retry, because it carries an idempotency key. */
  writeRemote(request: NetworkWriteRequest): Promise<MutationReceipt & { version?: number }>
  /**
   * Update a key only if its version is still the one the caller read.
   *
   * WHY A VERSION AND NOT A PREDICATE: a predicate would have to be EXECUTED on the far side, which
   * means shipping a function across a network. A version is data, and comparing data is the one
   * operation every store can do atomically.
   */
  compareAndSetRemote(
    request: NetworkWriteRequest & { expectedVersion: number },
  ): Promise<{ ok: boolean; version?: number; warnings: string[]; error?: ProtocolFailure }>
  /** Can this adapter reach its node right now? Cheap, and never throws. */
  healthy(): Promise<boolean>
}

/** What a relayed call looks like on the wire. Pure JSON — no functions, no class instances. */
export interface NetworkEnvelope {
  /** The operation name, from a closed vocabulary so a receiver can reject an unknown one. */
  readonly op: 'read' | 'write' | 'remove' | 'keys' | 'compareAndSet' | 'healthy'
  /** Correlation id, so a retry can be recognised as the same call rather than a second one. */
  readonly callId: string
  /** The key the operation addresses. Not a path, not a URL — a key, same rule as the local store. */
  readonly key?: string
  /** The payload, opaque to the protocol. */
  readonly payload?: unknown
  /** Propagated so a caller's own timeout survives a hop. */
  readonly deadlineAt?: number
}
