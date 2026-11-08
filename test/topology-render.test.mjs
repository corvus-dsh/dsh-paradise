/**
 * THE TOPOLOGY PAGE RENDERS — proven by RUNNING its own script, not by grepping the HTML.
 *
 * ── WHY A DOM SHIM AND NOT A BROWSER ──────────────────────────────────────────────────────────
 *
 * The page is one inlined document: there is no bundler, no test runner in the browser, and no
 * puppeteer in this package. String assertions ("does the HTML contain createElementNS") prove
 * nothing about behaviour — a typo one line further still ships a blank canvas, which is exactly
 * the class of bug the client bundles in this workspace already learned to test against.
 *
 * So the script is EXTRACTED from the served page and EXECUTED against a minimal document. Then the
 * assertions are about the tree it produced: how many node groups, which status colours, whether a
 * click fills the side panel with the requirements and the knowledge entries.
 *
 * The shim is deliberately tiny. Anything the page does NOT do (no layout engine, no CSS) is absent,
 * so if the script starts depending on it this test fails loudly instead of passing by accident.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

/** A node good enough for the page's script: attributes, children, text, events, inline style. */
function makeElement(tag) {
  const element = {
    tagName: String(tag).toUpperCase(),
    attributes: {},
    children: [],
    listeners: {},
    style: {},
    className: '',
    id: '',
    textContent: '',
    innerHTML: '',
    scrollTop: 0,
    scrollHeight: 0,
    value: '',
    setAttribute(name, value) {
      this.attributes[name] = String(value)
      if (name === 'id') this.id = String(value)
    },
    getAttribute(name) {
      return this.attributes[name] ?? null
    },
    appendChild(child) {
      this.children.push(child)
      return child
    },
    /**
     * Real DOM `textContent` is the concatenation of the subtree's text. The shim's plain property
     * would only return a node's own label, so a test asserting "the panel mentions the requirement"
     * would fail against a correctly rendered panel. Computed on read, like the real thing.
     */
    get textContent() {
      if (this.ownText !== undefined) return this.ownText
      return this.children.map((child) => child.textContent ?? '').join('')
    },
    set textContent(value) {
      this.ownText = String(value)
      this.children = []
    },
    addEventListener(name, handler) {
      this.listeners[name] = handler
    },
    /**
     * `innerHTML = ''` is what the page uses to clear a container. Emulating ONLY the empty case is
     * honest: the script never assigns markup, so the shim refuses to pretend it parses any.
     */
    set innerHTMLShim(value) {
      if (value !== '') throw new Error('the topology script must not assign innerHTML markup')
      this.children = []
    },
    querySelector(selector) {
      // The page uses exactly one selector form: 'rect' inside a node group.
      if (selector !== 'rect') throw new Error(`unexpected selector ${selector}`)
      return this.children.find((child) => child.tagName === 'RECT') ?? null
    },
    querySelectorAll(selector) {
      if (selector === 'rect') {
        const out = []
        const walk = (node) => {
          for (const child of node.children) {
            if (child.tagName === 'RECT') out.push(child)
            walk(child)
          }
        }
        walk(this)
        return out
      }
      return []
    },
  }
  // `innerHTML` is an own property on the real DOM; the shim maps it onto children so that a clear
  // via `innerHTML = ''` and one via `children = []` are the same operation.
  Object.defineProperty(element, 'innerHTML', {
    get() {
      return ''
    },
    set(value) {
      if (value !== '') throw new Error('the topology script must not assign innerHTML markup')
      element.children = []
    },
    configurable: true,
  })
  return element
}

/** Build the document the page expects: every id it looks up must exist. */
function makeDocument(ids) {
  const registry = new Map()
  for (const id of ids) {
    const element = makeElement('div')
    element.id = id
    registry.set(id, element)
  }
  return {
    /** Mirrors what `createHarnessServer` serves, plus the ids the script needs. */
    getElementById: (id) => registry.get(id) ?? null,
    createElement: (tag) => makeElement(tag),
    /**
     * `createTextNode` is REAL DOM API and the page legitimately uses it (it appends a text node
     * next to a coloured chip in the legend). A shim that omits it does not test the page, it tests
     * the shim — the first run failed here with `document.createTextNode is not a function`, which
     * is a fact about the harness, not about the view.
     */
    createTextNode: (text) => {
      const node = makeElement('#text')
      node.textContent = String(text)
      return node
    },
    createElementNS: (namespace, tag) => {
      if (namespace !== 'http://www.w3.org/2000/svg') throw new Error(`unexpected namespace ${namespace}`)
      return makeElement(tag)
    },
    querySelector: (selector) => (selector === '.composer' ? makeElement('div') : null),
    registry,
  }
}

/** Walk a tree and return every element whose tag matches. */
function findAll(root, tag) {
  const out = []
  const visit = (node) => {
    if (node.tagName === tag.toUpperCase()) out.push(node)
    for (const child of node.children ?? []) visit(child)
  }
  visit(root)
  return out
}

/**
 * Run the page's script against the shim and return the handles the tests need.
 *
 * ── TWO THINGS THE SHIM MUST DO THAT ARE NOT OBVIOUS ─────────────────────────────────────────
 *
 *   1. STUB THE TIMERS. The page ends with `setInterval(refresh, 5000)`. Executed in Node that is a
 *      live interval, so the process never exits and the suite HANGS instead of failing — the worst
 *      outcome, because CI looks like a slow machine. The stub records the callback and returns a
 *      handle; nothing is scheduled.
 *
 *   2. CLICK THE TOPOLOGY TAB. The DAG is rendered when the tab is opened, not at boot: an empty
 *      container after boot is CORRECT (a user who never asks for the graph should not pay for it),
 *      so the test has to ask, exactly as a person would.
 *
 * `fetch` is stubbed to answer both endpoints, so boot itself is exercised too.
 */
async function boot(pageHtml, topology) {
  const script = pageHtml.slice(pageHtml.indexOf('<script>') + 8, pageHtml.lastIndexOf('</script>'))
  assert.ok(script.includes('renderTopology'), 'the extracted script must be the topology one')

  const ids = [
    'dot', 'llm-mode', 'nodes', 'chat-title', 'transcript', 'input', 'btn-send', 'btn-new',
    'btn-team', 'btn-kill', 'btn-distill', 's-llm', 's-sessions', 's-running', 's-dead',
    's-takeovers', 's-truncations', 'm-skills', 'm-facts', 'm-exp', 'm-neg', 'tickets',
    'g-dog', 'g-host', 'g-at', 'g-detail', 'tab-chat', 'tab-topo', 'topology', 'topo-body',
  ]
  const document = makeDocument(ids)
  const requests = []
  const intervals = []
  const fetchStub = async (path) => {
    requests.push(String(path))
    if (String(path).includes('/api/topology')) return { json: async () => topology }
    return {
      json: async () => ({ llm: 'absent', stats: { sessions: 0, running: 0, dead: 0, takeovers: 0 }, sessions: [], memory: {}, tickets: [], guardian: null }),
    }
  }

  const setIntervalStub = (fn, ms) => {
    intervals.push({ fn, ms })
    return intervals.length
  }
  const clearIntervalStub = () => {}

  const run = new Function(
    'document',
    'fetch',
    'console',
    'setInterval',
    'clearInterval',
    script,
  )
  run(document, fetchStub, console, setIntervalStub, clearIntervalStub)
  // The IIFE boots asynchronously (it awaits refresh()); let its microtasks settle.
  await new Promise((resolve) => setTimeout(resolve, 30))

  // Open the graph, the way a person does: the tab click is what fetches and renders.
  const tab = document.getElementById('tab-topo')
  assert.ok(typeof tab.onclick === 'function', 'the topology tab must be wired')
  tab.onclick()
  await new Promise((resolve) => setTimeout(resolve, 30))

  return { document, requests, ids, intervals }
}

const TOPOLOGY = {
  available: true,
  reason: '',
  graphId: 'default',
  goal: '修好 1046 崩溃',
  goalLockedAt: '2026-11-08T00:00:00.000Z',
  nodes: [
    { id: 'start', title: '开始', phase: '', status: 'done', requirements: [], dependsOn: [], unlocks: ['analyse'], knowledge: [], missingPointers: [], level: 0, harvestedAt: '' },
    { id: 'analyse', title: '定位崩溃', phase: 'analysis', status: 'done', requirements: ['读校验器'], dependsOn: ['start'], unlocks: ['build'], knowledge: [{ id: 'k1', title: '先跑红测', kind: 'skill', tags: ['tdd'], nodeTypes: ['testing'], body: 'x' }], missingPointers: [], level: 1, harvestedAt: '' },
    { id: 'build', title: '写修复', phase: 'coding', status: 'active', requirements: ['承运必须是 user'], dependsOn: ['analyse'], unlocks: [], knowledge: [], missingPointers: ['k-gone'], level: 2, harvestedAt: '' },
  ],
  edges: [
    { from: 'start', to: 'analyse' },
    { from: 'analyse', to: 'build' },
  ],
  counts: { total: 3, pending: 0, active: 1, done: 2, abandoned: 0 },
  knowledgeTotal: 1,
  unharvested: 0,
  warnings: [],
  path: 'x',
}

/**
 * The served page, fetched ONCE for the whole file.
 *
 * WHY CACHED AND WHY `connection: close`. Each call used to start a server, fetch, and close it;
 * `server.close()` waits for open keep-alive sockets, so the suite HUNG instead of failing — the
 * worst possible outcome for a test. One page is enough (it is static markup), and an explicit
 * `connection: close` keeps the socket count at zero so the close is immediate.
 */
let pageCache
async function servedPage() {
  if (pageCache !== undefined) return pageCache
  const { createHarnessServer } = await import('../index.js')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = mkdtempSync(join(tmpdir(), 'dsh-page-'))
  const server = createHarnessServer({ home, port: 0 })
  const started = await server.listen()
  try {
    const response = await fetch(`${started.url}/`, { headers: { connection: 'close' } })
    pageCache = await response.text()
  } finally {
    await server.close()
  }
  return pageCache
}

test('page: the extracted script builds an SVG with one group per node', async () => {
  const html = await servedPage()
  const { document } = await boot(html, TOPOLOGY)
  const box = document.getElementById('topo-body')
  const svgs = findAll(box, 'svg')
  assert.equal(svgs.length, 1, 'exactly one canvas')
  const groups = findAll(svgs[0], 'g')
  assert.equal(groups.length, TOPOLOGY.nodes.length, 'one clickable group per node')
  const rects = findAll(svgs[0], 'rect')
  assert.ok(rects.length >= TOPOLOGY.nodes.length, 'each node draws at least its body rect')
})

test('page: edges are drawn as paths with an arrowhead marker, one per dependency', async () => {
  const html = await servedPage()
  const { document } = await boot(html, TOPOLOGY)
  const svg = findAll(document.getElementById('topo-body'), 'svg')[0]
  const paths = findAll(svg, 'path')
  // One marker path inside <defs>, plus one path per edge.
  const edgePaths = paths.filter((path) => String(path.getAttribute('marker-end') ?? '').includes('topo-arrow'))
  assert.equal(edgePaths.length, TOPOLOGY.edges.length, `${edgePaths.length} edge paths for ${TOPOLOGY.edges.length} edges`)
  assert.equal(findAll(svg, 'marker').length, 1, 'the arrowhead marker exists')
})

test('page: node colour follows status (done green, active amber, pending grey)', async () => {
  const html = await servedPage()
  const { document } = await boot(html, TOPOLOGY)
  const svg = findAll(document.getElementById('topo-body'), 'svg')[0]
  const groups = findAll(svg, 'g').filter((group) => group.children.some((child) => child.tagName === 'RECT'))
  const strokeOf = (index) => groups[index].children.find((child) => child.tagName === 'RECT').getAttribute('stroke')
  assert.equal(strokeOf(0), '#3fb950', 'done = green')
  assert.equal(strokeOf(1), '#3fb950')
  assert.equal(strokeOf(2), '#d29922', 'active = amber')
})

test('page: the active node is drawn thicker than an idle one', async () => {
  const html = await servedPage()
  const { document } = await boot(html, TOPOLOGY)
  const svg = findAll(document.getElementById('topo-body'), 'svg')[0]
  const groups = findAll(svg, 'g').filter((group) => group.children.some((child) => child.tagName === 'RECT'))
  const widthOf = (index) => Number(groups[index].children.find((child) => child.tagName === 'RECT').getAttribute('stroke-width'))
  assert.ok(widthOf(2) > widthOf(0), 'the phase being worked on is visually louder')
})

test('page: column position comes from the level the host computed', async () => {
  const html = await servedPage()
  const { document } = await boot(html, TOPOLOGY)
  const svg = findAll(document.getElementById('topo-body'), 'svg')[0]
  const groups = findAll(svg, 'g').filter((group) => group.children.some((child) => child.tagName === 'RECT'))
  const xOf = (index) => Number(groups[index].children.find((child) => child.tagName === 'RECT').getAttribute('x'))
  assert.ok(xOf(1) > xOf(0), 'level 1 is right of level 0')
  assert.ok(xOf(2) > xOf(1), 'level 2 is right of level 1')
  assert.equal(xOf(1) - xOf(0), xOf(2) - xOf(1), 'columns are evenly spaced')
})

test('page: node labels carry the phase icon and a short description', async () => {
  const html = await servedPage()
  const { document } = await boot(html, TOPOLOGY)
  const svg = findAll(document.getElementById('topo-body'), 'svg')[0]
  const texts = findAll(svg, 'text').map((node) => node.textContent)
  /**
   * THE ICON AND THE LABEL ARE SEPARATE <text> NODES, deliberately: the icon is coloured by status
   * and the label is the foreground colour, so they must be independently styleable. A single node
   * holding both would force one colour on the other.
   */
  assert.ok(texts.includes('◍'), `expected the analysis icon as its own node, got ${JSON.stringify(texts)}`)
  assert.ok(texts.some((text) => text.includes('analysis') && text.includes('定位崩溃')), 'phase and title travel together')
  assert.ok(texts.includes('⚙'), 'the coding icon is present')
  assert.ok(texts.some((text) => text.includes('知识 1')), 'the knowledge count is rendered')
  assert.ok(texts.some((text) => text === '▫'), 'a node with no phase gets the neutral marker, not a wrong icon')
})

test('page: clicking a node fills the side panel with requirements and knowledge', async () => {
  const html = await servedPage()
  const { document } = await boot(html, TOPOLOGY)
  const svg = findAll(document.getElementById('topo-body'), 'svg')[0]
  const groups = findAll(svg, 'g').filter((group) => group.children.some((child) => child.tagName === 'RECT'))
  const analyse = groups[1]
  assert.ok(typeof analyse.listeners.click === 'function', 'the group is clickable')
  analyse.listeners.click()

  // The side panel is the second child of the frame; find it by class.
  const frame = document.getElementById('topo-body').children.find((child) => child.className === 'frame')
  const side = frame.children[1]
  const text = JSON.stringify(side.children.map((child) => child.textContent || child.children?.map((inner) => inner.textContent)))
  assert.ok(text.includes('定位崩溃'), 'the title is shown')
  assert.ok(text.includes('读校验器'), 'the requirements are shown')
  assert.ok(text.includes('先跑红测'), 'the anchored knowledge is shown')
})

test('page: a dangling pointer is shown as broken, not silently dropped', async () => {
  const html = await servedPage()
  const { document } = await boot(html, TOPOLOGY)
  const svg = findAll(document.getElementById('topo-body'), 'svg')[0]
  const groups = findAll(svg, 'g').filter((group) => group.children.some((child) => child.tagName === 'RECT'))
  groups[2].listeners.click()
  const frame = document.getElementById('topo-body').children.find((child) => child.className === 'frame')
  const side = frame.children[1]
  const text = JSON.stringify(side.children.map((child) => child.textContent))
  assert.ok(text.includes('悬空指针'), 'the broken pointer is named')
  assert.ok(text.includes('k-gone'), 'and it says WHICH pointer')
})

test('page: an unavailable graph renders the reason, never a blank canvas', async () => {
  const html = await servedPage()
  const { document } = await boot(html, { available: false, reason: '还没有任务图。', nodes: [], edges: [], warnings: [], counts: { total: 0 }, path: '/x/task-graph.json' })
  const box = document.getElementById('topo-body')
  assert.equal(findAll(box, 'svg').length, 0, 'no canvas is drawn for a graph that does not exist')
  const text = JSON.stringify(box.children.map((child) => child.textContent))
  assert.ok(text.includes('还没有任务图'), 'the reason is shown')
  assert.ok(text.includes('task-graph.json'), 'and the path it looked at')
})

test('page: warnings are rendered above the canvas', async () => {
  const html = await servedPage()
  const { document } = await boot(html, {
    ...TOPOLOGY,
    warnings: ['1 个已完成的阶段没有写入全局知识库。'],
  })
  const box = document.getElementById('topo-body')
  const text = JSON.stringify(box.children.map((child) => child.textContent))
  assert.ok(text.includes('没有写入全局知识库'), 'the warning is visible')
})

test('page: switching to the topology tab fetches /api/topology, once', async () => {
  const html = await servedPage()
  const { requests } = await boot(html, TOPOLOGY)
  const topologyRequests = requests.filter((path) => path.includes('/api/topology'))
  assert.equal(topologyRequests.length, 1, `expected exactly one topology fetch, got ${JSON.stringify(requests)}`)
})

test('page: the graph is NOT rendered until the tab is opened (no cost for a chat-only user)', async () => {
  const html = await servedPage()
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'))
  const ids = ['dot', 'llm-mode', 'nodes', 'chat-title', 'transcript', 'input', 'btn-send', 'btn-new',
    'btn-team', 'btn-kill', 'btn-distill', 's-llm', 's-sessions', 's-running', 's-dead', 's-takeovers',
    's-truncations', 'm-skills', 'm-facts', 'm-exp', 'm-neg', 'tickets', 'g-dog', 'g-host', 'g-at',
    'g-detail', 'tab-chat', 'tab-topo', 'topology', 'topo-body']
  const document = makeDocument(ids)
  const requests = []
  const fetchStub = async (path) => {
    requests.push(String(path))
    return { json: async () => ({ llm: 'absent', stats: {}, sessions: [], memory: {}, tickets: [], guardian: null }) }
  }
  new Function('document', 'fetch', 'console', 'setInterval', 'clearInterval', script)(
    document, fetchStub, console, () => 1, () => {},
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(
    requests.filter((path) => path.includes('/api/topology')).length,
    0,
    'nothing fetches the topology before the tab is opened',
  )
})
