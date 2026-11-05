/**
 * THE HOST ADAPTER — everything this runtime does differently, in one directory.
 *
 * THE SELF-REPAIR CLAIM, MADE CONCRETE
 *
 * The goal stated for this layer is: when the runtime upgrades, an AI should be able to take
 * `PARADISE_SPEC.md` plus a failing log, edit THIS directory, and never touch the functional layer.
 * That only works if this directory is the complete answer to "what is host-specific?". So it holds:
 *
 *   paths.ts     the directory escaping and the on-disk log layout (measured, not guessed)
 *   policy.ts    which event kinds the view renders, which type each intent writes, the file name
 *   session.ts   the five session verbs, over this runtime's services
 *   storage.ts   durable small state, over this runtime's filesystem conventions
 *   tools.ts     the tool registry, over this runtime's tool service
 *   index.ts     the bundle, so a caller binds one object
 *
 * THE HONESTY CONSTRAINT
 *
 * Not every verb is wired yet. `session.ts` reports which ones it can do through `capabilities`, and
 * a verb it cannot do returns a FAILURE with a code and a stage — never a quiet success. The
 * architecture draft puts the write layer in P2; until then this adapter is a READ-FIRST
 * implementation and says so, because an adapter that pretended to create sessions would be worse
 * than one that admits it cannot.
 *
 * BUILD NOTE: re-exports below are SINGLE-LINE on purpose. The bundler inlines modules into one scope
 * and strips relative imports; a multi-line re-export leaves a bare specifier behind in the output and
 * the composer refuses to ship it. That guard is useful — it caught this file.
 */

import { createDshSessionAdapter } from './session.js'
import { createDshStorageAdapter } from './storage.js'
import { createStorageLeaseAdapter } from '../../lease-adapter.js'
import { assertHostCapabilities } from './assert-capabilities.js'
import { createDshToolAdapter } from './tools.js'
import { configureReadDefaults } from '../../read/disk.js'
import { isRenderedByConversation } from './policy.js'

/** The adapter bundle's name, used in logs and receipts. */
export const DSH_ADAPTER_NAME = 'dsh-0.2.2'

/**
 * Build the whole adapter bundle for this runtime.
 *
 * `ctx` is typed `any` ON PURPOSE: this is the one file allowed to know the host's context shape, and
 * putting a host type in the package's public signatures would drag the concept back into every
 * caller.
 */
export function createDshAdapters(ctx: any, config: { dataDir?: string; strict?: boolean } = {}): {
  name: string
  session: ReturnType<typeof createDshSessionAdapter>
  storage: ReturnType<typeof createDshStorageAdapter>
  lease: ReturnType<typeof createDshLeaseAdapter>
  tools: ReturnType<typeof createDshToolAdapter>
} {
  // The read layer must report renderability the way THIS host renders. Wiring it here keeps the
  // neutral module free of host imports while still giving it the host's answer.
  configureReadDefaults({ isRendered: isRenderedByConversation })

  /**
   * THE UPGRADE DRILL. `strict` turns a missing host API into a NAMED refusal that says which file to
   * edit, instead of a capability quietly switching off and failing somewhere else later.
   *
   * OFF BY DEFAULT, on purpose: a bare context is a legitimate input for the capability probe and the
   * conformance suite, which construct adapters from `{}` to prove that a host with nothing mounted
   * reports `false` rather than pretending. Throwing there would delete that property.
   */
  assertHostCapabilities(ctx, { strict: config.strict === true })

  const storage = createDshStorageAdapter(ctx, config)

  return {
    name: DSH_ADAPTER_NAME,
    session: createDshSessionAdapter(ctx),
    storage,
    /**
     * THE LEASE IS BUILT ON THE STORAGE ADAPTER, not beside it.
     *
     * That is what makes it usable by any plugin that already holds a storage handle, and what makes
     * `exclusive` an honest answer: the lease can only be as atomic as the storage underneath it.
     */
    lease: createStorageLeaseAdapter(storage),
    tools: createDshToolAdapter(ctx),
  }
}
