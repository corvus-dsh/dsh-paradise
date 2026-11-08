/**
 * End-to-end check of the topology view: start the real HTTP server, write a real
 * task-graph.json + knowledge.jsonl into its home, and assert what the endpoints return.
 *
 * This is not a unit test of a function — it is the answer to "does the page I am told to open
 * actually serve the data it draws". A projection can be perfect and still never be wired up.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createHarnessServer } = await import('../index.js')

const home = mkdtempSync(join(tmpdir(), 'dsh-topo-e2e-'))
mkdirSync(join(home, 'memory'), { recursive: true })
mkdirSync(join(home, 'knowledge'), { recursive: true })

const node = (id, over) => ({
  id, title: id, nodeType: '', requirements: [], status: 'pending',
  dependsOn: [], knowledgePointers: [], fixed: false, harvestedAt: '',
  createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:00.000Z', ...over,
})
writeFileSync(
  join(home, 'memory', 'task-graph.json'),
  JSON.stringify({
    version: 1, id: 'default', goal: '修好 1046 崩溃', goalLockedAt: '2026-11-08T00:00:00.000Z',
    nodes: [
      node('start', { status: 'done', fixed: true }),
      node('analyse', { title: '定位崩溃', nodeType: 'analysis', status: 'done', dependsOn: ['start'] }),
      node('build', { title: '写修复', nodeType: 'coding', status: 'active', dependsOn: ['analyse'] }),
      node('verify', { title: '跑四仓', nodeType: 'testing', status: 'pending', dependsOn: ['build'], knowledgePointers: ['k1', 'k-missing'] }),
    ],
    history: [], createdAt: '', updatedAt: '',
  }, null, 2),
  'utf8',
)
writeFileSync(
  join(home, 'knowledge', 'knowledge.jsonl'),
  `${JSON.stringify({ id: 'k1', kind: 'skill', title: '先跑红测', tags: ['tdd'], applicable_node_types: ['testing'], body: 'x' })}\n`,
  'utf8',
)

let server
try {
  server = createHarnessServer({ home, port: 0, onListening: () => {} })
  const started = await server.listen()
  const base = started.url

  const page = await fetch(`${base}/`)
  const html = await page.text()
  const assertions = []
  const check = (name, ok, detail = '') => {
    assertions.push({ name, ok })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  }

  check('GET / serves the page', page.status === 200)
  check('the page has a 任务拓扑 tab', html.includes('tab-topo') && html.includes('任务拓扑'))
  check('the page has the topology container', html.includes('id="topology"'))
  check('the page draws SVG (no D3 dependency)', html.includes('createElementNS') && !html.includes('d3.min.js'))

  const topology = await fetch(`${base}/api/topology`)
  const view = await topology.json()
  check('GET /api/topology answers 200', topology.status === 200)
  check('topology is available', view.available === true, view.reason || '')
  check('four nodes', view.nodes.length === 4, JSON.stringify(view.nodes?.map((n) => n.id)))
  check('three edges', view.edges.length === 3, JSON.stringify(view.edges))
  check('levels are layered', JSON.stringify(view.nodes.map((n) => `${n.id}:${n.level}`)) ===
    JSON.stringify(['start:0', 'analyse:1', 'build:2', 'verify:3']))
  const verify = view.nodes.find((n) => n.id === 'verify')
  check('knowledge pointer resolved', verify.knowledge.length === 1 && verify.knowledge[0].title === '先跑红测')
  check('missing pointer reported', JSON.stringify(verify.missingPointers) === JSON.stringify(['k-missing']))
  check('goal + lock surfaced', view.goal === '修好 1046 崩溃' && view.goalLockedAt.length > 0)
  check('status counts', view.counts.done === 2 && view.counts.active === 1 && view.counts.pending === 1, JSON.stringify(view.counts))
  check('unharvested phases reported', view.unharvested === 1, String(view.unharvested))

  const failures = assertions.filter((item) => !item.ok)
  console.log(`\n${assertions.length - failures.length}/${assertions.length} checks passed`)
  process.exitCode = failures.length === 0 ? 0 : 1
} catch (error) {
  console.error('E2E FAILED:', error)
  process.exitCode = 1
} finally {
  try {
    await server?.close()
  } catch {
    // ignore
  }
  rmSync(home, { recursive: true, force: true })
}
