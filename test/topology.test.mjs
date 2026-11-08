/**
 * v0.9.1 — TASK TOPOLOGY VIEW: the data the DAG canvas draws, and the layout it ships.
 *
 * WHAT THESE PIN
 *
 *   1. The view NEVER invents a graph. No file = `available: false` with a reason, not an empty
 *      canvas that looks like a rendering bug.
 *   2. The LAYOUT is layered by longest path, so a reader sees "one column right of its deepest
 *      prerequisite" — the property that makes a left-to-right topology readable.
 *   3. A cycle and a dangling dependency are REPORTED, and every node still appears. A view that
 *      silently drops unreachable nodes would be lying about the task's shape.
 *   4. Clicking a node is answered by the data itself: knowledge entries are RESOLVED here, so the
 *      side panel needs no second request, and a pointer that names nothing is marked, not hidden.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Paradise ships ONE bundle (`index.js`), so the view is imported from the package entry rather
 * than a `lib/` path — there is no per-module output here, by design (see scripts/bundle.mjs).
 */
import { readTopology } from '../index.js'

function home() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-topo-'))
  return { root, memory: join(root, 'memory'), knowledge: join(root, 'knowledge') }
}

function writeGraph(memory, nodes, extra = {}) {
  mkdirSync(memory, { recursive: true })
  writeFileSync(
    join(memory, 'task-graph.json'),
    JSON.stringify({ version: 1, id: 'default', goal: '', goalLockedAt: '', nodes, history: [], ...extra }, null, 2),
    'utf8',
  )
}

function writeKnowledge(knowledge, rows) {
  mkdirSync(knowledge, { recursive: true })
  writeFileSync(join(knowledge, 'knowledge.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
}

const node = (id, over = {}) => ({
  id,
  title: id,
  nodeType: '',
  requirements: [],
  status: 'pending',
  dependsOn: [],
  knowledgePointers: [],
  fixed: false,
  harvestedAt: '',
  createdAt: '',
  updatedAt: '',
  ...over,
})

test('topology: no graph file is UNAVAILABLE with a reason, not an empty canvas', () => {
  const { root, memory } = home()
  void memory
  const view = readTopology({ home: root })
  assert.equal(view.available, false)
  assert.match(view.reason, /还没有任务图/u)
  assert.deepEqual(view.nodes, [])
  assert.ok(view.path.endsWith(join('memory', 'task-graph.json')))
})

test('topology: a corrupt graph says it cannot be parsed', () => {
  const { root, memory } = home()
  mkdirSync(memory, { recursive: true })
  writeFileSync(join(memory, 'task-graph.json'), '{ not json', 'utf8')
  const view = readTopology({ home: root })
  assert.equal(view.available, false)
  assert.match(view.reason, /无法解析/u)
})

test('topology: a real graph yields nodes, edges and status counts', () => {
  const { root, memory } = home()
  writeGraph(memory, [
    node('start', { status: 'done', fixed: true }),
    node('phase-1', { title: '分析', nodeType: 'analysis', status: 'done', dependsOn: ['start'] }),
    node('phase-2', { title: '实现', nodeType: 'coding', status: 'active', dependsOn: ['phase-1'] }),
    node('phase-3', { title: '测试', nodeType: 'testing', status: 'pending', dependsOn: ['phase-2'] }),
  ])
  const view = readTopology({ home: root })
  assert.equal(view.available, true)
  assert.equal(view.nodes.length, 4)
  assert.deepEqual(view.counts, { total: 4, pending: 1, active: 1, done: 2, abandoned: 0 })
  assert.deepEqual(
    view.edges.map((edge) => edge.from + '->' + edge.to).sort(),
    ['phase-1->phase-2', 'phase-2->phase-3', 'start->phase-1'],
  )
  const phase2 = view.nodes.find((item) => item.id === 'phase-2')
  assert.deepEqual(phase2.unlocks, ['phase-3'], 'the reverse edge is computed, not stored')
})

test('topology: levels are longest-path, so a node sits right of its DEEPEST prerequisite', () => {
  const { root, memory } = home()
  writeGraph(memory, [
    node('start', { status: 'done', fixed: true }),
    node('a', { dependsOn: ['start'] }),
    node('b', { dependsOn: ['start'] }),
    node('c', { dependsOn: ['a', 'b'] }),
    node('d', { dependsOn: ['c'] }),
  ])
  const view = readTopology({ home: root })
  const level = (id) => view.nodes.find((item) => item.id === id).level
  assert.equal(level('start'), 0)
  assert.equal(level('a'), 1)
  assert.equal(level('b'), 1, 'siblings share a column')
  assert.equal(level('c'), 2, 'a node is one right of its deepest parent, not its shallowest')
  assert.equal(level('d'), 3)
})

test('topology: an independent root is still placed, at column 0', () => {
  const { root, memory } = home()
  writeGraph(memory, [node('start', { status: 'done', fixed: true }), node('orphan')])
  const view = readTopology({ home: root })
  assert.equal(view.nodes.find((item) => item.id === 'orphan').level, 0)
  assert.equal(view.nodes.length, 2, 'nothing disappears for lacking a dependency')
})

test('topology: a cycle is REPORTED and every node still gets a level', () => {
  const { root, memory } = home()
  writeGraph(memory, [
    node('start', { status: 'done', fixed: true }),
    node('a', { dependsOn: ['start', 'c'] }),
    node('b', { dependsOn: ['a'] }),
    node('c', { dependsOn: ['b'] }),
  ])
  const view = readTopology({ home: root })
  assert.equal(view.nodes.length, 4, 'a cycle must not make nodes vanish')
  assert.ok(view.warnings.some((warning) => warning.includes('循环依赖')), JSON.stringify(view.warnings))
  for (const item of view.nodes) assert.equal(typeof item.level, 'number')
})

test('topology: a dangling dependency is reported, not drawn', () => {
  const { root, memory } = home()
  writeGraph(memory, [node('start', { status: 'done', fixed: true }), node('a', { dependsOn: ['ghost'] })])
  const view = readTopology({ home: root })
  assert.ok(view.warnings.some((warning) => warning.includes('ghost')), JSON.stringify(view.warnings))
  assert.deepEqual(view.edges.map((edge) => edge.to), [], 'no edge to a node that does not exist')
})

test('topology: knowledge pointers are RESOLVED so clicking a node needs no second request', () => {
  const { root, memory, knowledge } = home()
  writeGraph(memory, [
    node('start', { status: 'done', fixed: true }),
    node('n1', { nodeType: 'testing', knowledgePointers: ['k1', 'k-gone'] }),
  ])
  writeKnowledge(knowledge, [{ id: 'k1', kind: 'skill', title: '先写测试', tags: ['tdd'], applicable_node_types: ['testing'], body: 'body' }])
  const view = readTopology({ home: root, knowledgeDir: knowledge })
  const n1 = view.nodes.find((item) => item.id === 'n1')
  assert.equal(n1.knowledge.length, 1)
  assert.equal(n1.knowledge[0].title, '先写测试')
  assert.deepEqual(n1.knowledge[0].tags, ['tdd'])
  assert.deepEqual(n1.knowledge[0].nodeTypes, ['testing'])
  assert.deepEqual(n1.missingPointers, ['k-gone'], 'a pointer that names nothing is SHOWN, not hidden')
  assert.equal(view.knowledgeTotal, 1)
})

test('topology: un-harvested finished phases are counted and warned about', () => {
  const { root, memory } = home()
  writeGraph(memory, [
    node('start', { status: 'done', fixed: true }),
    node('done-no-harvest', { status: 'done' }),
    node('done-harvested', { status: 'done', harvestedAt: '2026-01-01T00:00:00.000Z' }),
  ])
  const view = readTopology({ home: root })
  assert.equal(view.unharvested, 1, 'the start node is excluded: it is not a phase')
  assert.ok(view.warnings.some((warning) => warning.includes('没有写入全局知识库')), JSON.stringify(view.warnings))
})

test('topology: the goal and its lock are surfaced', () => {
  const { root, memory } = home()
  writeGraph(memory, [node('start', { status: 'done', fixed: true })], {
    goal: '修好崩溃且四仓全绿',
    goalLockedAt: '2026-01-01T00:00:00.000Z',
  })
  const view = readTopology({ home: root })
  assert.equal(view.goal, '修好崩溃且四仓全绿')
  assert.equal(view.goalLockedAt, '2026-01-01T00:00:00.000Z')
})

test('topology: a missing start node is called out (a hand-edited graph)', () => {
  const { root, memory } = home()
  writeGraph(memory, [node('a')])
  const view = readTopology({ home: root })
  assert.ok(view.warnings.some((warning) => warning.includes('start')), JSON.stringify(view.warnings))
  assert.equal(view.nodes.length, 1, 'the orphan is still presented; the warning explains the shape')
})

test('topology: an empty node list is available-but-empty, not an error', () => {
  const { root, memory } = home()
  writeGraph(memory, [])
  const view = readTopology({ home: root })
  assert.equal(view.available, true)
  assert.equal(view.nodes.length, 0)
  assert.equal(view.counts.total, 0)
})
