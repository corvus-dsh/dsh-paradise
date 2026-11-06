/**
 * THE RAW HOST ADAPTERS — `adapters/raw/`.
 *
 * WHAT THIS DIRECTORY IS, IN ONE SENTENCE: everything the layer needs that requires NO host at all,
 * implemented against `node:fs` and `fetch` so a standalone harness can run on a bare machine.
 *
 * WHY IT IS `raw` AND NOT A SECOND HOST NAME
 *
 * `adapters/<name>/` is the pattern for "one host's differences". This directory is the opposite case:
 * it is what REMAINS TRUE ON EVERY MACHINE — a file is a file, an HTTP POST is an HTTP POST. It names
 * a CAPABILITY LEVEL, not a product, which is why it can be shipped rather than rewritten per host.
 *
 * WHAT IT PROVIDES
 *
 *   llm.ts        an LLMAdapter over plain `fetch` (OpenAI-compatible wire format)
 *   messages.ts   a MessageAdapter holding the conversation as an array, with a real token budget
 *   tools.ts      a ToolFactory that compiles source text into a callable tool
 *
 * WHAT IT DELIBERATELY DOES NOT PROVIDE
 *
 * A SessionAdapter. "A conversation container" is the ONE concept that genuinely differs per host —
 * which is why `_scratch/naked-node-bootstrap.mjs` writes its own in 200 lines rather than importing
 * one from here. Shipping a "default session" would make every harness inherit a shape it did not
 * choose, and the whole point of the protocol is that it did not have to.
 *
 * ONE MORE THING THIS FILE DOES: it is the assembly point, so a harness binds ONE object the way
 * `createDshAdapters` binds one. That shape is what makes a launcher able to swap the whole bundle.
 */

import { createRawLlm } from './llm.js'
import type { RawLlmOptions } from './llm.js'
import { isQuotaExhausted } from './llm.js'
import { createRawMessages } from './messages.js'
import type { RawMessageOptions } from './messages.js'
import { createRawToolFactory } from './tools.js'
import type { RawToolFactoryOptions } from './tools.js'
import { createBareIgnition } from './ignition.js'
import type { IgnitionOptions, IgnitionReceipt, IgnitionSession, IgnitionTriggerInput } from './ignition.js'
import type { HarnessBundle, LLMAdapter, MessageAdapter, ToolFactory } from '../../protocol/index.js'

/** The bundle's name, used in logs and receipts. */
export const RAW_ADAPTER_NAME = 'raw-node'

/**
 * Build the whole raw bundle.
 *
 * EVERY PIECE IS OPTIONAL, because the same reason `ParadiseHost` keeps its adapters optional: a script
 * that only formats a message should not have to own an API key. A caller that omits `llm` gets a
 * bundle whose `llm` is `undefined` — and a caller that needs one gets a NAMED error at construction,
 * not a crash at call time.
 */
export function createRawAdapters(config: {
  llm?: RawLlmOptions
  messages?: RawMessageOptions
  tools?: RawToolFactoryOptions
} = {}): HarnessBundle & { llm?: LLMAdapter; messages?: MessageAdapter; tools?: ToolFactory } {
  return {
    name: RAW_ADAPTER_NAME,
    ...(config.llm === undefined ? {} : { llm: createRawLlm(config.llm) }),
    messages: createRawMessages(config.messages ?? {}),
    ...(config.tools === undefined ? { tools: createRawToolFactory() } : { tools: createRawToolFactory(config.tools) }),
  }
}

export { createRawLlm, createRawMessages, createRawToolFactory, createBareIgnition, isQuotaExhausted }
export type { RawLlmOptions, RawMessageOptions, RawToolFactoryOptions }
export type { ToolRunner } from './llm.js'
/**
 * THE IGNITION VERB'S TYPES — exported because a deployment must be able to NAME what it is wiring.
 *
 * `IgnitionSession` in particular is the narrow contract a caller satisfies: read a log, append one
 * message. A caller that has a full `SessionAdapter` satisfies it structurally and does not have to
 * convert.
 */
export type { IgnitionOptions, IgnitionReceipt, IgnitionSession, IgnitionTriggerInput }
/**
 * ROUTE CONFIGURATION — the durability half of route hijacking.
 *
 * Exported because a repair tool needs to REWRITE the endpoint, and an operator needs to READ what is
 * currently configured. Both are file operations, so they live outside the LLM adapter, which must stay a
 * transport and not a config manager.
 *
 * IMPORT + BARE EXPORT, NOT `export … from` — the composer inlines every module into one scope and
 * refuses a surviving relative specifier. This is the second time that guard caught the same mistake in
 * this file, which is exactly what a guard is for.
 */
import {
  defaultRouteConfigPath,
  readRouteConfig,
  resolveFallbackRoute,
  rewriteRouteConfig,
  routeConfigExists,
} from './route-config.js'
import type { ResolvedRoute, RouteConfig } from './route-config.js'

export { defaultRouteConfigPath, readRouteConfig, resolveFallbackRoute, rewriteRouteConfig, routeConfigExists }
export type { ResolvedRoute, RouteConfig }
/** Referenced so the imported types are not flagged as unused under type-stripping builds. */
export type RouteConfigShape = RouteConfig
export type ResolvedRouteShape = ResolvedRoute
