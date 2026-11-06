/**
 * PARADISE PROTOCOL — the barrel, and the one exported function every caller uses.
 *
 * WHY THIS FILE IS ALMOST EMPTY
 *
 * A protocol layer that accumulates helpers stops being a protocol. Everything here is either a
 * re-export or a pure function on protocol types. If something needs to know how a host works, it
 * belongs in `src/adapters/<host>/`, not here.
 */

export type {
  SessionRef,
  ContextItem,
  ContextVisibility,
  TriggerMode,
  TurnTrigger,
  LogEvent,
  LogReading,
  MessageOnDisk,
  SessionEvent,
  Unsubscribe,
  MutationReceipt,
  ProtocolFailure,
} from './types.js'

export type {
  ParadiseHost,
  ParadiseDependencies,
  SessionAdapter,
  SessionCapabilities,
  DeletionProbe,
  RenderedItem,
  StorageAdapter,
  StorageReadReport,
  StorageReadStatus,
  ToolAdapter,
  ToolDescriptor,
  ToolOutcome,
} from './adapters.js'

export type { LeaseAdapter, LeaseAttempt, LeaseRecord, LeaseRequest } from './lease.js'
export type { AcquireDecision } from './lease.js'

/**
 * THE NETWORK TIER — a storage contract that survives a hop between machines.
 *
 * Kept in its own module because it answers a DIFFERENT question from `StorageAdapter`: not "can you
 * store this", but "what can you still promise once a network sits between us". The types are exported
 * here so a caller importing the barrel sees one vocabulary.
 */
export type {
  NetworkStorageAdapter,
  NetworkGuarantees,
  NetworkReadReport,
  NetworkWriteRequest,
  NetworkEnvelope,
} from './network.js'

/**
 * THE EXOSKELETON — model, message list, and runtime-created tools.
 *
 * These answer "how does a thought get produced" and "how does a new capability get created", which
 * the three container adapters deliberately do not. They are what makes a standalone harness possible
 * rather than a plugin that can only observe a host's thinking.
 */
export type {
  LLMAdapter,
  GenerateOptions,
  GenerationResult,
  ChatMessage,
  ToolCall,
  ToolSchema,
  MessageAdapter,
  ToolFactory,
  RuntimeTool,
  HarnessBundle,
} from './harness.js'

/**
 * THE ZERO-TRUST FIREWALL — where untrusted text becomes safe-to-place.
 *
 * These are TYPES ONLY: this module defines what a verdict looks like, so an implementation cannot quietly
 * answer "fine" to everything. The value exports live at the package root, next to the other adapters.
 */
export type {
  TrustOrigin,
  InjectionVerdict,
  SanitizeAction,
  SanitizeVerdict,
  FirewallAdapter,
  InjectionShield,
  ActionPolicy,
  ActionVerdict,
  ActionGuard,
  FirewallAuditEntry,
  FirewallInstallation,
} from './firewall.js'
/**
 * `TRUST_ORDER` IS A VALUE, so it is imported and re-exported BARE.
 *
 * A re-export that names a relative source survives into the single-file bundle as a relative specifier and
 * fails at import time — the composer refuses it. This is the THIRD time this shape has been caught in this
 * package, which is the strongest argument for the guard existing.
 *
 * NOTE FOR THE NEXT READER: the guard scans LINES, so writing the offending syntax inside a comment also
 * trips it. That is a false positive, and it is a cheap one to live with — the alternative (a smarter guard
 * that skips comments) is a guard that can be defeated by a comment-shaped edge case.
 */
import { TRUST_ORDER } from './firewall.js'
export { TRUST_ORDER }

import {
  LEASE_RELEASE,
  describeLease,
  isLeaseExpired,
  leaseOwnedBy,
  planAcquire,
  planRelease,
  planRenew,
} from './lease.js'
/**
 * Bare re-exports, not `export … from`: this package ships as ONE inlined bundle and its composer
 * refuses a surviving relative specifier. The guard exists because an `export … from` would be
 * silently unresolved in the shipped file.
 */
export { LEASE_RELEASE, describeLease, isLeaseExpired, leaseOwnedBy, planAcquire, planRelease, planRenew }

import type { ParadiseDependencies, ParadiseHost } from './adapters.js'
import type { ProtocolFailure } from './types.js'

/**
 * The protocol's own error.
 *
 * WHY IT IS HERE AND NOT IN `errors.ts`: that file carries the layer's operational errors, some of
 * which mention a specific host by design (the "layer is missing" message names the package). This
 * one must be expressible by ANY host, so it takes only protocol vocabulary.
 */
export class ProtocolError extends Error {
  readonly code: string
  readonly stage: string
  readonly cause?: unknown

  constructor(code: string, stage: string, message: string, cause?: unknown) {
    super(`[${code}] ${message}`)
    this.name = 'ProtocolError'
    this.code = code
    this.stage = stage
    this.cause = cause
    const original = typeof (cause as any)?.stack === 'string' ? (cause as any).stack : ''
    if (original.length > 0) this.stack = `${this.stack ?? message}\n--- original stack ---\n${original}`
  }

  toFailure(): ProtocolFailure {
    return {
      code: this.code,
      stage: this.stage,
      message: this.message,
      ...(typeof this.stack === 'string' ? { stack: this.stack } : {}),
    }
  }
}

/**
 * Bind a host's adapters into the dependency set a functional layer expects.
 *
 * THE ONE POLICY THIS FUNCTION ENFORCES: a host that lacks a REQUIRED adapter is rejected at bind
 * time, with the missing piece named — not at first use, where the failure looks like a bug in the
 * functional layer. `storage` and `session` are required; `tools` is not, because a functional layer
 * that only reads and writes state does not need a tool registry.
 */
export function bindHost(host: ParadiseHost): ParadiseDependencies {
  const missing: string[] = []
  if (host.session === undefined) missing.push('session')
  if (host.storage === undefined) missing.push('storage')
  if (missing.length > 0) {
    throw new ProtocolError(
      'HOST_INCOMPLETE',
      'bind',
      `宿主 ${JSON.stringify(host.name)} 缺少必需适配器：${missing.join(', ')}。` +
        '该宿主无法承载功能层；这不是降级，是拒绝。',
    )
  }
  return {
    session: host.session!,
    storage: host.storage!,
    ...(host.tools === undefined ? {} : { tools: host.tools }),
  }
}

/**
 * Does this host satisfy the protocol at all?
 *
 * Structural, so a host can be checked without importing anything from this package and without the
 * check agreeing with a name. A test double passes it; a half-built adapter does not.
 */
export function isParadiseHost(value: unknown): value is ParadiseHost {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.name !== 'string' || candidate.name.length === 0) return false
  const adapters = ['session', 'storage', 'tools']
  for (const key of adapters) {
    const adapter = candidate[key]
    if (adapter === undefined) continue
    if (typeof adapter !== 'object' || adapter === null) return false
    if (typeof (adapter as Record<string, unknown>).name !== 'string') return false
  }
  return true
}
