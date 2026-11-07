/**
 * SPAWN NODE + TIANHE DISPATCHER — the creation primitive and a scheduler over it.
 *
 * WHAT THESE PIN
 *
 * A creation primitive is dangerous in a specific way: it can APPEAR to create an agent while
 * creating nothing. So the tests here care most about the honest signals — `mode`, `warnings`, and
 * refusing a bad input — rather than only about the happy path.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const layer = await import(new URL('../index.js', import.meta.url).href)

function workspace() {
  return mkdtempSync(join(tmpdir(), 'dsh-spawn-'))
}

/** Cleanup without asserting: Windows may hold handles briefly. */
function cleanup(root) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true })
      return
    } catch {
      /* retry, then give up silently */
    }
  }
}

/* ── spawnNode ─────────────────────────────────────────────────────────────────────────── */

test('spawn: creates a node with a tape, a seed on disk, and says which mode it ran in', async () => {
  const root = workspace()
  const receipt = await layer.spawnNode({
    workspace: root,
    context: ['背景：部署排障'],
    prompt: '诊断 SOURCE_DRIFT',
    title: '排障节点',
  })
  assert.equal(receipt.ok, true, JSON.stringify(receipt.error))
  /**
   * NO HOST WAS PASSED, so the honest answer is `portable`. A function that reported `host` here
   * would be claiming an agent exists when only a contract does.
   */
  assert.equal(receipt.mode, 'portable')
  assert.ok(receipt.tape.length > 0, 'the node has a tape')
  assert.ok(receipt.warnings.length > 0, 'the downgrade is stated, not hidden')
  assert.equal(existsSync(receipt.seedPath), true, 'the seed is on disk')
  const seed = JSON.parse(readFileSync(receipt.seedPath, 'utf8'))
  assert.match(seed.prompt, /SOURCE_DRIFT/u)
  assert.ok(seed.tape.length > 0)
  cleanup(root)
})

test('spawn: an empty prompt is REFUSED — an unignited node is not a node', async () => {
  const root = workspace()
  const receipt = await layer.spawnNode({ workspace: root, prompt: '   ' })
  assert.equal(receipt.ok, false)
  assert.equal(receipt.error?.code, 'NO_PROMPT')
  cleanup(root)
})

test('spawn: a relative workspace is ACCEPTED only after resolving to an absolute path', async () => {
  /**
   * MY FIRST ASSERTION WAS WRONG. `spawnNode` calls `resolve()` on the workspace, so a relative
   * input becomes absolute and is accepted — which is correct behaviour: the requirement is "the
   * session has a home", not "the caller typed an absolute string".
   *
   * What must still hold is that the receipt carries the RESOLVED path, so a caller can tell where
   * the node actually lives rather than where it thought it pointed.
   */
  const receipt = await layer.spawnNode({ workspace: 'relative/path', prompt: 'do something' })
  assert.equal(receipt.ok, true)
  assert.equal(receipt.error, undefined)
  assert.match(receipt.workspace, /^([A-Za-z]:[\\/]|\/)/u, 'the receipt reports an absolute path')
  cleanup(receipt.workspace)
})

test('spawn: an empty workspace IS refused', async () => {
  /** This is the case that matters: no home at all, rather than a home expressed oddly. */
  const receipt = await layer.spawnNode({ workspace: '   ', prompt: 'task' })
  assert.equal(receipt.ok, false)
  assert.equal(receipt.error?.code, 'SPAWN_DENIED')
})

test('spawn: the explicit id is honoured, so a retry lands on the same node', async () => {
  const root = workspace()
  const receipt = await layer.spawnNode({ workspace: root, prompt: 'task', id: 'stable-id' })
  assert.equal(receipt.sessionId, 'stable-id')
  assert.match(String(receipt.seedPath), /stable-id\.json/u)
  cleanup(root)
})

test('spawn: context is carried into the node, ahead of the prompt', async () => {
  const root = workspace()
  const receipt = await layer.spawnNode({
    workspace: root,
    context: ['第一段背景', '第二段背景'],
    prompt: '开始工作',
  })
  /**
   * Read the TAPE EVENTS' own text fields rather than a JSON dump of the whole tape.
   *
   * The first version searched the serialised tape for the two strings and then compared their
   * offsets — but the seed also carries the prompt in a separate field, so an offset comparison over
   * a JSON blob compares the wrong positions. Looking at the event payloads is the assertion that
   * actually means "the context came first".
   */
  const surface = receipt.tape
    .map((event) => JSON.stringify(event.data ?? {}))
    .filter((text) => text.includes('背景') || text.includes('开始工作'))
    .join('\n')
  assert.match(surface, /第一段背景/u)
  assert.match(surface, /第二段背景/u)
  assert.ok(surface.indexOf('第一段背景') < surface.indexOf('第二段背景'), 'context keeps its order')
  assert.ok(surface.indexOf('第二段背景') < surface.indexOf('开始工作'), 'the prompt comes last')
  cleanup(root)
})

test('spawn: a title defaults to the first line of the prompt', async () => {
  const root = workspace()
  const receipt = await layer.spawnNode({ workspace: root, prompt: '第一行标题\n第二行细节' })
  assert.equal(receipt.title, '第一行标题')
  cleanup(root)
})

test('spawn: an injected host ctx that lacks capabilities downgrades VISIBLY', async () => {
  const root = workspace()
  /** A ctx object with no services: exactly what a half-initialised harness looks like. */
  const receipt = await layer.spawnNode({ workspace: root, prompt: 'task' }, { get: () => undefined })
  assert.equal(receipt.mode, 'portable')
  assert.ok(
    receipt.warnings.some((warning) => /portable|缺少/u.test(warning)),
    'the caller is told it did not get a host session',
  )
  cleanup(root)
})

test('spawn: canSpawnOnHost is false for no ctx and for an empty one', () => {
  assert.equal(layer.canSpawnOnHost(undefined), false)
  assert.equal(layer.canSpawnOnHost({}), false)
})

/* ── dispatch ──────────────────────────────────────────────────────────────────────────── */

test('dispatch: dependencies are honoured — verify runs after probe and patch', async () => {
  const root = workspace()
  const order = []
  const report = await layer.dispatch(
    [
      { id: 'plan', goal: 'plan it' },
      { id: 'probe', goal: 'probe it', dependsOn: ['plan'] },
      { id: 'patch', goal: 'patch it', dependsOn: ['plan'] },
      { id: 'verify', goal: 'verify it', dependsOn: ['probe', 'patch'] },
    ],
    {
      workspace: root,
      runner: async ({ ticket }) => {
        order.push(ticket.id)
        return { ok: true, output: ticket.id }
      },
    },
  )
  assert.equal(report.receipts.length, 4)
  assert.equal(report.skipped.length, 0)
  assert.ok(order.indexOf('verify') > order.indexOf('probe'))
  assert.ok(order.indexOf('verify') > order.indexOf('patch'))
  cleanup(root)
})

test('dispatch: a ticket whose blocker FAILED is skipped with the reason', async () => {
  const root = workspace()
  const report = await layer.dispatch(
    [
      { id: 'base', goal: 'will fail' },
      { id: 'downstream', goal: 'needs base', dependsOn: ['base'] },
    ],
    {
      workspace: root,
      runner: async ({ ticket }) =>
        ticket.id === 'base' ? { ok: false, error: 'boom' } : { ok: true },
    },
  )
  assert.equal(report.receipts.length, 1, 'only the failing ticket ran')
  assert.equal(report.skipped.length, 1)
  assert.match(report.skipped[0].reason, /base=failed/u, 'the reason names the blocker and its state')
  cleanup(root)
})

test('dispatch: a dependency CYCLE is reported, not spun on', async () => {
  const root = workspace()
  const report = await layer.dispatch(
    [
      { id: 'a', goal: 'x', dependsOn: ['b'] },
      { id: 'b', goal: 'y', dependsOn: ['a'] },
    ],
    { workspace: root, runner: async () => ({ ok: true }) },
  )
  assert.equal(report.receipts.length, 0, 'nothing deadlocked')
  assert.equal(report.skipped.length, 2)
  assert.match(report.skipped[0].reason, /依赖/u)
  cleanup(root)
})

test('dispatch: an unknown dependency id is reported as a ticket defect', async () => {
  const root = workspace()
  const report = await layer.dispatch([{ id: 'a', goal: 'x', dependsOn: ['ghost'] }], {
    workspace: root,
    runner: async () => ({ ok: true }),
  })
  assert.equal(report.skipped.length, 1)
  assert.match(report.skipped[0].reason, /不存在的工单/u)
  cleanup(root)
})

test('dispatch: with no runner, nodes are created and the receipt says so', async () => {
  const root = workspace()
  const report = await layer.dispatch([{ id: 'solo', goal: 'just create me' }], { workspace: root })
  assert.equal(report.receipts.length, 1)
  assert.equal(report.receipts[0].ok, true)
  /**
   * The output must say "not executed" rather than implying work happened. This is the difference
   * between a scheduler that reports and one that pretends.
   */
  assert.match(String(report.receipts[0].output), /未执行/u)
  assert.equal(report.spawned.length, 1)
  cleanup(root)
})

test('dispatch: each ticket gets its own node directory', async () => {
  const root = workspace()
  const report = await layer.dispatch(
    [
      { id: 'one', goal: 'a' },
      { id: 'two', goal: 'b' },
    ],
    { workspace: root, runner: async () => ({ ok: true }) },
  )
  assert.equal(report.spawned.length, 2)
  for (const spawn of report.spawned) {
    assert.ok(spawn.seedPath !== undefined)
    assert.equal(existsSync(spawn.seedPath), true)
  }
  const paths = report.spawned.map((spawn) => spawn.seedPath)
  assert.equal(new Set(paths).size, 2, 'no two nodes share a seed path')
  cleanup(root)
})

test('dispatch: meta is echoed onto the receipt so a collector needs no second lookup', async () => {
  const root = workspace()
  const report = await layer.dispatch([{ id: 'm', goal: 'x', meta: { shard: 7 } }], {
    workspace: root,
    runner: async () => ({ ok: true }),
  })
  assert.deepEqual(report.receipts[0].meta, { shard: 7 })
  cleanup(root)
})
