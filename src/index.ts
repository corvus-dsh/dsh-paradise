/**
 * 彼岸层 — the physical layer under the session plugins, now with a HOST-NEUTRAL PROTOCOL on top.
 *
 * THE TWO HALVES OF THIS PACKAGE
 *
 *   `src/protocol/`  the contract: three adapters (session / storage / tools) and host-neutral value
 *                    types. It names NO host and NO host concept — a test enforces that.
 *   `src/adapters/`  implementations of that contract. `<host>/` holds everything that is a fact
 *                    about one runtime: its service names, its log layout, its rendering rules.
 *
 *   `src/read/`      host-neutral readers. The frame-by-frame decoder takes a path (or a deriver) and
 *                    never learns a directory scheme.
 *
 * WHY THE SPLIT IS THE WHOLE DELIVERABLE
 *
 * The goal is not tidiness; it is that a runtime upgrade should be answerable by editing
 * `adapters/<host>/` alone. That claim is only true if the protocol cannot express a host fact and
 * the readers cannot import one. Both are now checked mechanically rather than promised:
 *
 *   - `test/protocol-purity.test.mjs` fails if `src/protocol/` names a host or a host concept;
 *   - `src/read/disk.ts` takes `derivePath` as an option instead of importing a layout;
 *   - `src/adapters/memory/` is a complete implementation with NO host at all, so "the protocol is
 *     implementable" is demonstrated on every test run.
 *
 * WHAT IS STILL THE OLD SHAPE
 *
 * `dshEscapeSessionDirName` / `sessionLogPath` are re-exported from the host adapter because the
 * plugins still call them directly. That is the next migration, not a finished one — an honest layer
 * says which parts are still coupled.
 */

import { isRenderedByConversation, PLUGIN_SOURCE_PREFIX } from './adapters/dsh/policy.js'
import { escapeSessionDirName, sessionLogPath } from './adapters/dsh/paths.js'
import { configureReadDefaults, readDiskEventTypes, readDiskEvents } from './read/disk.js'
import { probeCapabilities } from './adapters/dsh/capability.js'
import { service } from './adapters/dsh/services.js'
import { ParadiseError, ParadiseUnavailableError, asParadiseError } from './errors.js'
import { CARRYING_MESSAGE_RULE, UNIFIED_RULES, WRITE_LAYER_PHASE, writeNotImplemented } from './write/contract.js'
import { PUBLISH_CAPABILITIES, publishNotImplemented } from './adapters/dsh/publish.js'
import { ProtocolError, bindHost, isParadiseHost } from './protocol/index.js'
import { createDshAdapters, DSH_ADAPTER_NAME } from './adapters/dsh/index.js'
import { deleteSession, verifyDeletion } from './adapters/dsh/delete.js'
import {
  BRIEFING_ID_PREFIX,
  InjectShapeError,
  SURFACE_TYPES,
  assertTape,
  buildTape,
  describeRendered,
  isAbsoluteCwd,
  materialiseTape,
  resolveTitle,
  shortSessionTag,
} from './adapters/dsh/inject.js'
import { createMemoryHost } from './adapters/memory/index.js'
import { createStorageLeaseAdapter } from './lease-adapter.js'
import { createSyncLeaseAdapter, guardSteals } from './adapters/dsh/lease-sync.js'
import {
  assertHostCapabilities,
  assertHostCapabilitiesOnBoot,
  probeHostCapabilities,
  REQUIRED_HOST_CAPABILITIES,
} from './adapters/dsh/assert-capabilities.js'
import { withLease } from './lease.js'
import { createMemoryStorageAdapter } from './storage-memory.js'
import { chooseStorageTier, parseStorageTier, STORAGE_TIERS } from './storage-tiers.js'
import { RAW_ADAPTER_NAME, createRawAdapters, createRawLlm, createRawMessages, createRawToolFactory } from './adapters/raw/index.js'
import { createBareIgnition } from './adapters/raw/index.js'
import {
  createActionGuard,
  createEnforcingFirewall,
  createFirewall,
  createInjectionShield,
  createNonEnforcingFirewall,
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
  UNTRUSTED_PREAMBLE,
} from './adapters/raw/index.js'
/**
 * THE TRUST SCALE is a value a CALLER compares against (`TRUST_ORDER[a] > TRUST_ORDER[b]`), which a type
 * cannot express. Re-exported here so a deployment does not have to reach into `protocol/` for it.
 */
import { TRUST_ORDER } from './protocol/firewall.js'
import {
  defaultRouteConfigPath,
  isQuotaExhausted,
  readRouteConfig,
  resolveFallbackRoute,
  rewriteRouteConfig,
  routeConfigExists,
} from './adapters/raw/index.js'
import { REPAIR_PROMPT, createLauncher } from './launcher.js'
import { connectNetworkNode, startNetworkNode } from './adapters/http/network-storage.js'
import type { NetworkClientOptions, NetworkServer, NetworkServerOptions } from './adapters/http/network-storage.js'

/**
 * `verifyDeletion` is exposed under a qualified name because the adapter directory already exports a
 * function of that name for its own callers, and the bundle inlines everything into ONE scope — two
 * `verifyDeletion` declarations would be a duplicate-identifier error at import time.
 */
const verifySessionDeletion = verifyDeletion

/** Version probe, printed at import time so the host log proves which copy is live. */
export const VERSION = '0.4.0'
export const PACKAGE_NAME = 'dsh-paradise'
console.log(`[dsh-paradise] layer version ${VERSION} (P1: read + protocol)`)

/**
 * The host's service resolver, re-exported under its historical name.
 *
 * It is `service` inside `adapters/dsh/` (the adapter's own vocabulary) and `resolveService` here, for
 * two reasons: the observer already imports it under this name, and the resolution RULE it implements
 * — "prefer the accessor that actually has the method you are about to call" — is worth naming in the
 * public surface even after the implementation moved host-side.
 *
 * Written as an alias of the inlined adapter function. NOTE the bundler inlines every module into ONE
 * scope and strips the `import` statement, so the imported name does not exist at runtime — only the
 * ORIGINAL declaration does. The alias therefore points at `service`, the declaration that survives.
 */
export const resolveService = service

/** The plugin name the Loader looks for. This layer registers no tools and serves no client half. */
export const name = 'dsh-paradise'

/**
 * No hard service dependencies.
 *
 * Everything this layer touches it probes first (`probeCapabilities`), and every capability it cannot
 * find is REPORTED rather than assumed. Declaring `inject` would make a profile that merely wants the
 * disk reader refuse to activate — the wrong trade for a read-first layer.
 */
export const inject: string[] = []

/** The neutral reader gets a rendering answer from whichever adapter is in play. */
configureReadDefaults({ isRendered: isRenderedByConversation })

/**
 * Mount the layer.
 *
 * It registers nothing and writes nothing. At activation it PROVES ITSELF: reports the version,
 * probes the host, and says what is missing — because a dependent's decision to degrade depends on
 * this answer being available before it starts.
 */
export function apply(ctx: any, _config: Record<string, unknown> = {}): void {
  /**
   * THE UPGRADE DRILL, ON BY DEFAULT AT BOOT.
   *
   * This runs when the plugin is mounted against a host — which, after an upgrade, is the FIRST code of
   * ours to see the new API surface. A missing required API must stop the load with a refusal that names
   * the file to edit, not switch a capability off and fail somewhere else later.
   *
   * STRICT HERE, LENIENT AT CONSTRUCTION. `createDshAdapters({})` must keep reporting `false` instead of
   * throwing (the probe and the conformance suite depend on that), so strictness is defaulted at the one
   * moment that is operational rather than structural. `PARADISE_STRICT_HOST=0` opts a deliberately bare
   * profile out; `=1` forces it back on.
   */
  let bootAssertion: ReturnType<typeof assertHostCapabilitiesOnBoot> | undefined
  try {
    bootAssertion = assertHostCapabilitiesOnBoot(ctx)
  } catch (error) {
    /**
     * A NAMED REFUSAL, AND IT KEEPS ITS STACK. Rethrowing the same error rather than wrapping it means
     * the message the log shows is the one the drill produced — with every missing API and its `editIn`
     * line — instead of a generic "probe failed" that loses the instruction an AI needs.
     */
    ctx?.logger?.error?.(`[dsh-paradise] ${VERSION} REFUSED TO MOUNT: ${String((error as any)?.message ?? error)}`)
    throw error
  }
  try {
    const capabilities = probeCapabilities(ctx)
    const missing = capabilities.unavailable.length
    if (bootAssertion.missing.length > 0) {
      /**
       * REACHABLE ONLY WHEN THE OVERRIDE IS SET: the strict path above throws. Logging it anyway keeps
       * the two answers (required-API table vs capability probe) visible side by side, because they can
       * disagree — one names APIs, the other names CONSEQUENCES for the write layer.
       */
      ctx?.logger?.warn?.(
        `[dsh-paradise] ${VERSION} mounted with ${bootAssertion.missing.length} MISSING required API(s) ` +
          `(strict host assertion disabled by PARADISE_STRICT_HOST=0): ` +
          bootAssertion.missing.map((item) => `${item.service}${item.method === undefined ? '' : `.${item.method}`}`).join(', '),
      )
    }
    if (missing === 0) {
      ctx?.logger?.info?.(
        `[dsh-paradise] ${VERSION} mounted: all probed capabilities present (read layer is host-independent)`,
      )
    } else {
      ctx?.logger?.info?.(
        `[dsh-paradise] ${VERSION} mounted: ${missing} capability(ies) unavailable for the WRITE layer ` +
          `(${capabilities.unavailable.map((item) => item.capability).join(', ')}); the READ layer is unaffected`,
      )
    }
  } catch (error) {
    const wrapped = asParadiseError(error, 'PARADISE_PROBE_FAILED', 'locate')
    ctx?.logger?.warn?.(`[dsh-paradise] capability probe failed: ${wrapped.message}`)
  }
}

export const activate = apply

/* ── the public surface ────────────────────────────────────────────────────────────────────── */

export {
  /* protocol — the contract */
  ProtocolError,
  bindHost,
  isParadiseHost,
  /* adapters */
  createDshAdapters,
  /**
   * THE NEUTRAL NAME FOR THE SAME FUNCTION.
   *
   * WHY IT EXISTS: a functional layer that only depends on the CONTRACT must not have to write a host's name
   * in its own type definitions. `dsh-graft-slice`'s bridge declared `createDshAdapters(ctx)` in its
   * interface, which means that plugin's source named a runtime it is supposed to be independent of — the
   * precise coupling the protocol layer exists to remove.
   *
   * `createAdapters` is the same function under a name that says what it does rather than which runtime it
   * targets. The old name stays exported because it is already referenced by the plugins and their tests;
   * removing it would be a breaking change dressed as tidying.
   */
  createDshAdapters as createAdapters,
  createMemoryHost,
  DSH_ADAPTER_NAME,
  /* read (host-neutral) */
  readDiskEvents,
  readDiskEventTypes,
  configureReadDefaults,
  /* the host's own layout, still called directly by the plugins — the next migration */
  sessionLogPath,
  escapeSessionDirName,
  /* host probing */
  probeCapabilities,
  /* host policy, re-exported so a caller can report renderability */
  isRenderedByConversation,
  PLUGIN_SOURCE_PREFIX,
  /* errors */
  ParadiseError,
  ParadiseUnavailableError,
  asParadiseError,
  /* write/publish contracts (P3) — exported so a dependent can SEE the phase, never call success */
  CARRYING_MESSAGE_RULE,
  UNIFIED_RULES,
  WRITE_LAYER_PHASE,
  PUBLISH_CAPABILITIES,
  writeNotImplemented,
  publishNotImplemented,
  /* the removal machinery, for a plugin's own rollback */
  deleteSession,
  verifySessionDeletion,
  /* the lease: one host-neutral implementation over any StorageAdapter, plus the one safe caller */
  createStorageLeaseAdapter,
  /**
   * The SYNCHRONOUS driver, for a caller whose critical sections cannot await.
   *
   * Same rules (`planAcquire` / `planRenew` / `planRelease`), different I/O. Exported because
   * `dsh-memory`'s store is synchronous end to end, and converting it to async would change its
   * signatures and every caller — a behaviour change, not a refactor.
   */
  createSyncLeaseAdapter,
  /* the upgrade drill: a missing host API becomes a named refusal naming the file to edit */
  assertHostCapabilities,
  probeHostCapabilities,
  REQUIRED_HOST_CAPABILITIES,
  /** Diagnostics: how many abandoned guards were reclaimed. */
  guardSteals,
  withLease,
  /**
   * THE L0/L1 STORAGE TIERS.
   *
   * `chooseStorageTier` is the ONE place that decides which engine is live and how a failure degrades, so
   * plugins do not each re-implement "memory, but fall back to file" and drift.
   */
  createMemoryStorageAdapter,
  chooseStorageTier,
  parseStorageTier,
  STORAGE_TIERS,
  defaultLeaseOwner,
  asLeaseRecord,
  leaseStorageKey,
  /**
   * THE RAW (HOST-FREE) ADAPTERS.
   *
   * Shipped values, not types: a launcher must be able to build a bare-mode bundle without importing a
   * host directory. `RAW_ADAPTER_NAME` is exported so a log says which bundle is live.
   */
  RAW_ADAPTER_NAME,
  createRawAdapters,
  createRawLlm,
  createRawMessages,
  createRawToolFactory,
  /**
   * THE BARE-METAL TRIGGER — "make this session start working" without a host.
   *
   * A migrator on a bare machine asks the layer for `binding.triggers`; this is what a deployment puts
   * there. Without it the migrator correctly reports `TRIGGER_UNAVAILABLE` — which is honest, and is not
   * the same as working.
   */
  createBareIgnition,
  /**
   * THE ZERO-TRUST FIREWALL.
   *
   * `createEnforcingFirewall()` is the one a deployment should install. The non-enforcing variant is
   * exported on purpose: a caller that declines to screen must be able to SAY so, and a diagnostic that
   * cannot distinguish "clean" from "never looked" is worse than no firewall.
   */
  createEnforcingFirewall,
  createNonEnforcingFirewall,
  createFirewall,
  createInjectionShield,
  createActionGuard,
  UNTRUSTED_OPEN,
  UNTRUSTED_CLOSE,
  UNTRUSTED_PREAMBLE,
  TRUST_ORDER,
  /** The dual-mode supervisor and the prompt its repairs are built from. */
  createLauncher,
  REPAIR_PROMPT,
  /**
   * THE NETWORK TIER, IMPLEMENTED — two HTTP endpoints and a client.
   *
   * Shipped values rather than types, for the same reason the raw adapters are: a caller that wants to
   * prove the network contract carries across a socket must be able to START a node, not merely describe
   * one.
   */
  startNetworkNode,
  connectNetworkNode,
  /**
   * ROUTE HIJACKING — the pieces a caller needs to swap an exhausted key without a restart.
   *
   * `isQuotaExhausted` is exported so a caller can classify a failure the same way the adapter does,
   * instead of re-implementing the "429 or a quota body" rule and drifting from it.
   */
  isQuotaExhausted,
  defaultRouteConfigPath,
  readRouteConfig,
  resolveFallbackRoute,
  rewriteRouteConfig,
  routeConfigExists,
}

export type {
  /* protocol value types */
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
  /* protocol adapters */
  ParadiseHost,
  ParadiseDependencies,
  SessionAdapter,
  SessionCapabilities,
  RenderedItem,
  StorageAdapter,
  StorageReadReport,
  StorageReadStatus,
  ToolAdapter,
  ToolDescriptor,
  ToolOutcome,
  /* the lease */
  LeaseAdapter,
  LeaseAttempt,
  LeaseRecord,
  LeaseRequest,
  /* the network tier — the storage contract that survives a hop between machines */
  NetworkStorageAdapter,
  NetworkGuarantees,
  NetworkReadReport,
  NetworkWriteRequest,
  NetworkEnvelope,
  /* the exoskeleton — what a standalone harness needs beyond a container */
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
} from './protocol/index.js'

export type { WithLeaseResult } from './lease.js'
export type { NetworkClientOptions, NetworkServer, NetworkServerOptions } from './adapters/http/network-storage.js'
export type { ResolvedRoute, RouteConfig } from './adapters/raw/route-config.js'
export type { IgnitionOptions, IgnitionReceipt, IgnitionSession, IgnitionTriggerInput } from './adapters/raw/ignition.js'

import { LEASE_RELEASE, describeLease, isLeaseExpired, leaseOwnedBy } from './protocol/lease.js'
/** Bare, for the same reason as every other re-export here: this package ships as one inlined bundle. */
export { LEASE_RELEASE, describeLease, isLeaseExpired, leaseOwnedBy }

export type { DiskReading, DiskBriefing, DiskReadOptions, PathProbe, PathDeriver } from './read/disk.js'
export type { HostCapabilities } from './adapters/dsh/capability.js'
export type { ParadiseStage } from './errors.js'

/**
 * THE AGENT LOOP — the piece that makes this a harness rather than a library.
 *
 * Without it the four repositories could store, slice and observe, but nothing turned a user
 * sentence into a sequence of tool calls without a HOST driving it. Exported bare, like every
 * other module here, because this package ships as one inlined bundle.
 */
import { createMemoryMessages, runAgentTurn } from './agent-loop.js'
export { createMemoryMessages, runAgentTurn }
export type { AgentLoopEvent, AgentLoopOptions, AgentTool, AgentTurnResult } from './agent-loop.js'

/**
 * THE REPAIR SESSION — self-repair that does not live inside the thing it repairs.
 *
 * A supervisor whose repair path runs inside the host dies with the host. This one needs a
 * terminal: `runRepairSession` plus REAL tools (read/write/run/restart), all paths confined to
 * the workspace, with `dryRun` for review before trust.
 */
import { REPAIR_TOOL_NAMES, joinPath, resolveInside, runRepairSession } from './repair-session.js'
export { REPAIR_TOOL_NAMES, joinPath, resolveInside, runRepairSession }
export type { RepairSessionEvent, RepairSessionOptions, RepairSessionResult } from './repair-session.js'

/**
 * THE WATCHDOG — the trigger, as its own process.
 *
 * The repair machinery existed but nothing fired it; a human still had to open a terminal. A
 * watchdog inside the host would die with the host, so `watchdog.ts` imports only the protocol
 * and runs as a separate OS process.
 */
import { buildDiagnosis, createWatchdog } from './watchdog.js'
export { buildDiagnosis, createWatchdog }
export type { WatchdogEvent, WatchdogOptions, WatchdogProbe, WatchdogReport, WatchdogState } from './watchdog.js'

/**
 * SPAWN NODE — the creation primitive.
 *
 * Every other entry point needs a SOURCE: a slice needs a session, a repair needs a crash. A
 * dispatcher that fans work out to N agents cannot start from something. This starts from nothing
 * but a task description, and it reports whether it made a live host session or a drivable contract.
 */
import { canSpawnOnHost, spawnNode } from './spawn-node.js'
export { canSpawnOnHost, spawnNode }
export type { SpawnNodeContextItem, SpawnNodeInput, SpawnNodeReceipt } from './spawn-node.js'

/**
 * TIANHE DISPATCHER — tickets in, receipts out, nodes in between.
 *
 * A minimal scheduler over `spawnNode`: a plain-JSON ticket names who does what, the dispatcher
 * turns it into a node, and receipts come back. Dependency handling is explicit and a cycle is
 * reported rather than spun on.
 */
import { dispatch } from './dispatcher.js'
export { dispatch }
export type { DispatchReport, DispatcherEvent, DispatcherOptions, NodeRunner, TianheReceipt, TianheTicket } from './dispatcher.js'

/**
 * THE NATIVE HARNESS — this layer as the host, not a client of one.
 *
 * Everything above needed a host to supply sessions and a trigger. This supplies them: a session
 * store, the turn loop, a tool registry, and the ignition that `spawnNode` was missing.
 */
import { createParadiseHarness } from './harness-server.js'
export { createParadiseHarness }
export type { HarnessEvent, HarnessOptions, HarnessSessionState, ParadiseHarness, SessionStatus, TurnResult } from './harness-server.js'

/**
 * THE HARNESS SERVER — the host and its browser UI in one process.
 *
 * `node dist/harness-server.js` starts it. The UI is inlined as source text so it cannot drift from
 * the server that serves it, and the WebSocket is implemented on Node built-ins so a fresh machine
 * needs no install to see the console.
 */
import { createHarnessServer } from './harness-http.js'
export { createHarnessServer }
export type { HarnessServerOptions } from './harness-http.js'

/**
 * Test seam: the write SHAPE functions.
 *
 * These moved here from `dsh-observer/src/core/observer-inject.ts`, together with their tests: a
 * validator that no longer participates in any write path must not have its tests left behind in the
 * plugin, or the plugin's suite would certify code nothing calls.
 */
export const writeShapeInternals = {
  buildTape,
  materialiseTape,
  assertTape,
  describeRendered,
  isAbsoluteCwd,
  resolveTitle,
  shortSessionTag,
  InjectShapeError,
  BRIEFING_ID_PREFIX,
  SURFACE_TYPES,
}

/** Test seam: the pure pieces, reachable without a host. */
export const paradiseInternals = {
  escapeSessionDirName,
  sessionLogPath,
  readDiskEvents,
  readDiskEventTypes,
  probeCapabilities,
  resolveService,
  isRenderedByConversation,
  ParadiseError,
  ParadiseUnavailableError,
  asParadiseError,
  CARRYING_MESSAGE_RULE,
  UNIFIED_RULES,
  WRITE_LAYER_PHASE,
  ProtocolError,
  bindHost,
  isParadiseHost,
  createDshAdapters,
  createMemoryHost,
  /* the write machinery, exposed for the plugins' own rollback and for tests */
  deleteSession,
  verifySessionDeletion,
  VERSION,
}
