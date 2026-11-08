/**
 * START THE STARFIRE CONSOLE — the harness server's Web UI, with a demo task graph on first run.
 *
 * ── WHY THIS SCRIPT EXISTS ─────────────────────────────────────────────────────────────────────
 *
 * `dist/harness.js` is the WATCHDOG (a supervisor that watches a pid file and can build a repair
 * session). It is not the UI. The UI is `createHarnessServer(...).listen()`, and until now nothing in
 * this package started it — so "open the topology view" required writing a Node one-liner.
 *
 * ── THE DEMO GRAPH ────────────────────────────────────────────────────────────────────────────
 *
 * With no graph on disk the topology view is CORRECTLY empty ("还没有任务图"). That is the honest
 * answer, but it makes the view impossible to look at before a model has used it. So when the home
 * has no `task-graph.json` AND `--seed-demo` is passed, this writes a small real-shaped graph: one
 * start node, four phases, a locked goal, real knowledge entries, and one deliberately dangling
 * pointer so the "missing pointer" path is visible too.
 *
 * The seed is OFF by default and never overwrites: an existing graph is left exactly as it is.
 *
 *   node scripts/serve-console.mjs                    # UI on http://127.0.0.1:38080/ (empty graph)
 *   node scripts/serve-console.mjs --seed-demo        # …with a demo graph to look at
 *   node scripts/serve-console.mjs --port=38080 --home=.starfire-console
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createHarnessServer } from '../index.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = new Map()
for (const raw of process.argv.slice(2)) {
  const match = /^--([^=]+)(?:=(.*))?$/u.exec(raw)
  if (match !== null) args.set(match[1], match[2] ?? 'true')
}

const home = resolve(String(args.get('home') ?? join(root, '.starfire-console')))
const port = Number(args.get('port') ?? 38080)
const seedDemo = args.get('seed-demo') === 'true'

mkdirSync(join(home, 'memory'), { recursive: true })

/** A demo graph, written only when there is nothing to overwrite. */
function seed() {
  const graphPath = join(home, 'memory', 'task-graph.json')
  if (existsSync(graphPath)) {
    process.stdout.write(`graph already present, left untouched: ${graphPath}\n`)
    return
  }
  const at = new Date().toISOString()
  const node = (id, over) => ({
    id,
    title: id,
    nodeType: '',
    requirements: [],
    status: 'pending',
    dependsOn: [],
    knowledgePointers: [],
    fixed: false,
    harvestedAt: '',
    createdAt: at,
    updatedAt: at,
    ...over,
  })
  writeFileSync(
    graphPath,
    JSON.stringify(
      {
        version: 1,
        id: 'default',
        goal: '让四仓测试全绿，并把这次教训写进全局知识库',
        goalLockedAt: at,
        nodes: [
          node('start', { title: '开始', status: 'done', fixed: true }),
          node('analyse', {
            title: '定位 1046 崩溃',
            nodeType: 'analysis',
            status: 'done',
            dependsOn: ['start'],
            requirements: ['读宿主校验器', '确认 pre-step 只写 user/message'],
            knowledgePointers: ['session-event-role-contract'],
            harvestedAt: at,
          }),
          node('build', {
            title: '改承运 + 改注册 id',
            nodeType: 'coding',
            status: 'active',
            dependsOn: ['analyse'],
            requirements: ['pre-step 承运必须是 user', 'client 注册 id 用包名'],
            knowledgePointers: ['session-event-role-contract', 'client-registration-id'],
          }),
          node('verify', {
            title: '四仓回归',
            nodeType: 'testing',
            status: 'pending',
            dependsOn: ['build'],
            requirements: ['1461 项全绿', '真机重启验证'],
            knowledgePointers: ['red-test-first'],
          }),
          node('release', {
            title: '发版',
            nodeType: 'ops',
            status: 'pending',
            dependsOn: ['verify'],
            requirements: ['bump 版本', '推送 main 与 tag'],
            knowledgePointers: ['ghost-pointer-demo'],
          }),
        ],
        history: [],
        createdAt: at,
        updatedAt: at,
      },
      null,
      2,
    ),
    'utf8',
  )
  const knowledgeDir = join(home, 'knowledge')
  mkdirSync(knowledgeDir, { recursive: true })
  writeFileSync(
    join(knowledgeDir, 'knowledge.jsonl'),
    [
      { id: 'session-event-role-contract', kind: 'skill', title: 'pre-step 承运只能是 user', tags: ['dsh', 'session'], applicable_node_types: ['coding', 'debugging'], body: 'DSH 把 pre-step messages 一律 append 成 user/message。' },
      { id: 'client-registration-id', kind: 'skill', title: 'client 注册 id 必须等于包名', tags: ['dsh', 'plugin'], applicable_node_types: ['coding'], body: '宿主按 package.json name 建 boot graph row。' },
      { id: 'red-test-first', kind: 'skill', title: '先跑红测', tags: ['testing'], applicable_node_types: ['testing'], body: '先证明修复有效，再动手。' },
      { id: 'no-role-inference', kind: 'negative', title: '不要凭语义猜宿主契约', tags: ['dsh'], applicable_node_types: ['debugging'], body: '读源码而不是推断；一次推断错误就炸了整个进程。' },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n',
    'utf8',
  )
  process.stdout.write(`demo graph written: ${graphPath}\n`)
}

if (seedDemo) seed()

const server = createHarnessServer({ home, port })
const started = await server.listen()
process.stdout.write(
  [
    '',
    '星火控制台已启动',
    `  界面      ${started.url}/`,
    `  任务拓扑  ${started.url}/         （页头点「任务拓扑」标签）`,
    `  数据      ${started.url}/api/topology`,
    `  home      ${home}`,
    '',
    'Ctrl+C 停止。',
    '',
  ].join('\n'),
)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void server.close().finally(() => process.exit(0))
  })
}
