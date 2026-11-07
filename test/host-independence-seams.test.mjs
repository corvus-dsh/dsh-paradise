/**
 * THE HOST-INDEPENDENCE SEAMS — pinned so they cannot silently close again.
 *
 * WHY THIS FILE EXISTS
 *
 * `dsh-graft-slice` and `dsh-observer` each grew a provider seam so they can run where there is no host.
 * The end-to-end proofs live in `_scratch/` (which `npm test` does not run), so without this file a future
 * change could delete the seam and nothing would turn red until a deployment discovered it — during an
 * outage, which is the worst possible moment.
 *
 * WHAT IS ASSERTED, AND WHY EACH ONE MATTERS
 *
 *   1. the seam EXISTS and is exported from the plugin entry (a caller imports the plugin, not internals);
 *   2. with NOTHING installed, resolution behaves exactly as shipped (no seam = host path);
 *   3. with something installed, THAT is what gets used — including a `null` answer falling through;
 *   4. an injected provider does not leak into the next caller (the seam is a deployment choice, not a
 *      global that silently rewrites behaviour).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const WORKSPACE = join(import.meta.dirname, '..', '..')
const graftEntry = join(WORKSPACE, 'dsh-graft-slice', 'index.js')
const observerEntry = join(WORKSPACE, 'dsh-observer', 'index.js')
const graftUrl = pathToFileURL(graftEntry).href
const observerUrl = pathToFileURL(observerEntry).href

/**
 * ── THESE SEAMS LIVE IN SIBLING REPOSITORIES, AND CI DOES NOT HAVE THEM ──────────────────────
 *
 * The file pins seams that live in `dsh-graft-slice` and `dsh-observer`: it imports THEIR entry
 * points to prove the provider hooks exist. That is the right way to test a seam — from a caller,
 * through the public export — but it means the test needs those repos checked out BESIDE this one.
 *
 * In this workspace they are siblings, so it passes. In CI only `corvus-dsh/dsh-paradise` is
 * checked out, so the files are absent and every case failed with `Cannot find module`.
 *
 * THE CHOICE, AND WHY IT IS `skip` AND NOT `assert`:
 *
 *   - Failing would make CI permanently red for a missing REPOSITORY, not a missing capability.
 *     A red build that everyone knows is red is worse than no build: it trains people to ignore it.
 *   - Silently passing would be the exact lie this project refuses: it would report "the seams are
 *     verified" when nothing was verified.
 *
 * So the cases are SKIPPED with a reason naming which repo is missing, and the skip COUNT is visible
 * in the output. The seam is verified wherever the code actually lives — i.e. whenever the workspace
 * is complete, which is the only configuration where the assertion means anything.
 */
const haveGraft = existsSync(graftEntry)
const haveObserver = existsSync(observerEntry)
const missing = [
  haveGraft ? undefined : 'dsh-graft-slice',
  haveObserver ? undefined : 'dsh-observer',
].filter((name) => name !== undefined)
const workspaceSkip =
  missing.length === 0
    ? false
    : `sibling repo not checked out: ${missing.join(', ')} — this seam is verified when the full workspace is present`

test('graft: the gateway seam is exported from the plugin entry', { skip: workspaceSkip }, async () => {
  const graft = await import(graftUrl)
  assert.equal(typeof graft.setHostGateway, 'function', 'setHostGateway must be reachable from index.js')
  assert.equal(typeof graft.hasHostGateway, 'function')
  assert.equal(graft.hasHostGateway(), false, 'nothing installed by default — the host path is the default')
})

test('graft: an installed gateway is OBSERVED, and clearing it restores the host path', { skip: workspaceSkip }, async () => {
  const graft = await import(graftUrl)
  const gateway = {
    name: 'test-gateway',
    writesThroughParadise: false,
    async isTaken() { return false },
    async readLog() { throw new Error('not used in this test') },
  }
  graft.setHostGateway(gateway)
  assert.equal(graft.hasHostGateway(), true, 'an installed gateway must be visible')
  graft.setHostGateway(undefined)
  assert.equal(graft.hasHostGateway(), false, 'clearing must restore the shipped path')
})

test('graft: with no gateway, an empty ctx is refused for a HOST reason (not a logic error)', { skip: workspaceSkip }, async () => {
  const graft = await import(graftUrl)
  graft.setHostGateway(undefined)
  const emptyCtx = { logger: {}, get: () => undefined, on: () => {} }
  /**
   * THE POINT OF THIS ASSERTION IS THE ERROR CODE. A bare ctx must fail because the HOST is absent —
   * `PERSISTENCE_REQUIRED` — and not because the pipeline reached into a missing service and threw a
   * `TypeError`. Those two look similar in a log and mean opposite things: one is "this deployment needs
   * a gateway", the other is "the plugin is broken".
   */
  await assert.rejects(
    () => graft.graftSliceAndInject(emptyCtx, { autoGraft: false }, 'no-such-source', 'no-such-target'),
    (error) => {
      assert.equal(error.code, 'PERSISTENCE_REQUIRED', `got ${error.code}`)
      return true
    },
  )
})

test('graft: the paradise write provider is a SEPARATE seam from the gateway', { skip: workspaceSkip }, async () => {
  const graft = await import(graftUrl)
  /**
   * TWO SEAMS, TWO JOBS. The gateway answers "what is a session"; the provider answers "who writes the
   * target". A deployment may have one and not the other (a machine that can read logs but has no live
   * handles), so they must not be collapsed into one switch.
   */
  assert.equal(typeof graft.setParadiseWriteProvider, 'function')
  assert.equal(typeof graft.hasParadiseWriteProvider, 'function')
  assert.equal(graft.hasParadiseWriteProvider(), false)
  graft.setParadiseWriteProvider(() => ({ ok: true, reason: '', session: undefined }))
  assert.equal(graft.hasParadiseWriteProvider(), true)
  graft.setParadiseWriteProvider(undefined)
  assert.equal(graft.hasParadiseWriteProvider(), false)
})

test('observer: the write-adapter seam is exported and defaults to the host path', { skip: workspaceSkip }, async () => {
  const observer = await import(observerUrl)
  const internals = observer.injectionInternals
  assert.equal(typeof internals?.setWriteAdapterProvider, 'function', 'the seam must be on the plugin surface')
  assert.equal(typeof internals?.hasWriteAdapterProvider, 'function')
  assert.equal(internals.hasWriteAdapterProvider(), false)
})

test('observer: an injected provider is used, and answered per call', { skip: workspaceSkip }, async () => {
  const observer = await import(observerUrl)
  const internals = observer.injectionInternals
  let asked = 0
  internals.setWriteAdapterProvider(() => {
    asked += 1
    return {
      ok: true,
      session: {
        name: 'injected',
        capabilities: {
          create: true, trigger: true, injectIntoIdle: true, injectIntoRunning: true,
          readLog: true, subscribe: false, verifyDeletion: true, unavailable: [],
        },
        async create() { return { ok: true, stage: 'create', warnings: [] } },
        async trigger() { return { ok: true, stage: 'trigger', warnings: [] } },
      },
      layerName: 'injected',
    }
  })
  try {
    const first = await internals.ensureWriteAdapter({})
    const second = await internals.ensureWriteAdapter({})
    assert.equal(asked, 2, 'the provider must be consulted on EVERY call, not cached once')
    assert.equal(first.ok, true)
    assert.equal(first.session.name, 'injected')
    assert.equal(second.ok, true)
  } finally {
    internals.setWriteAdapterProvider(undefined)
  }
  assert.equal(internals.hasWriteAdapterProvider(), false)
})

test('observer: a provider that answers null falls THROUGH to the host path', { skip: workspaceSkip }, async () => {
  const observer = await import(observerUrl)
  const internals = observer.injectionInternals
  internals.setWriteAdapterProvider(() => null)
  try {
    /**
     * `null` MEANS "NO OPINION". A caller that owns only some contexts must not be forced to fabricate an
     * answer for the rest — and the rest must therefore resolve exactly as they always did. In this
     * workspace the layer resolves, so `ok` is whatever the real path says; what must NOT happen is a
     * crash or a fabricated success.
     */
    const result = await internals.ensureWriteAdapter({})
    assert.equal(typeof result.ok, 'boolean', 'a null answer must fall through, not blow up')
  } finally {
    internals.setWriteAdapterProvider(undefined)
  }
})
