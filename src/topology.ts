/**
 * TASK TOPOLOGY — the DAG view's DATA, read from the same files the memory plugin writes.
 *
 * ── WHY PARADISE READS THE FILES AND NOT A TOOL ───────────────────────────────────────────────
 *
 * The harness is a HOST. It has no `ctx.tools`, no model, and no session — asking it to call
 * `memory_graph_read` would require a plugin runtime it does not have. But the contract between the
 * two layers is already a FILE contract (`task-graph.json`, `knowledge.jsonl`), and reading a file
 * needs nothing but a home directory. So the view reads what the memory layer wrote, which is also
 * why the two halves stay installable independently.
 *
 * ── THE SHAPE IS THE POINT ────────────────────────────────────────────────────────────────────
 *
 * This returns everything the renderer needs and NOTHING it has to compute:
 *
 *   nodes[]   id, title, phase, status, requirements, and the RESOLVED knowledge entries behind
 *             each pointer (so clicking a node does not need a second request)
 *   edges[]   from the `dependsOn` relation, so the renderer draws the graph rather than a list
 *   levels[]  a topological layering — the renderer places a node by `level`, and the LAYOUT
 *             decision (what belongs in the same column) lives here where it can be tested
 *
 * A CYCLE IS REPORTED, NOT HIDDEN: `levels` still assigns every node (falling back to the longest
 * reachable chain), and `warnings` says the graph is not a DAG. A topology view that silently drops
 * nodes because they are unreachable would be lying about the task's shape.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The start node's reserved id, mirrored from the memory layer's contract. */
const START_NODE = 'start'

export interface TopologyNode {
  id: string
  title: string
  phase: string
  status: string
  requirements: string[]
  dependsOn: string[]
  unlocks: string[]
  /** Resolved knowledge entries, in pointer order. An unresolvable pointer is reported, not dropped. */
  knowledge: Array<{ id: string; title: string; kind: string; tags: string[]; nodeTypes: string[]; body: string }>
  /** Pointers that name nothing in the knowledge store — visible so a stale link can be fixed. */
  missingPointers: string[]
  /** Column index for the layout, 0 = the start column. */
  level: number
  harvestedAt: string
}

export interface TopologyEdge {
  from: string
  to: string
}

export interface TopologyView {
  available: boolean
  /** Why the view is empty, when it is. Never a silent blank canvas. */
  reason: string
  graphId: string
  goal: string
  goalLockedAt: string
  nodes: TopologyNode[]
  edges: TopologyEdge[]
  counts: { total: number; pending: number; active: number; done: number; abandoned: number }
  knowledgeTotal: number
  /** Nodes that finished without writing anything into the knowledge base. */
  unharvested: number
  warnings: string[]
  path: string
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const out: Array<Record<string, unknown>> = []
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) out.push(parsed as Record<string, unknown>)
    } catch {
      // One torn line must not hide the rest of the store.
    }
  }
  return out
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * Lay every node out by longest path from a node with no dependencies.
 *
 * WHY NOT "BFS from the start node": a DAG produced by the model may have several roots (`start`,
 * and any node added without `dependsOn`), and a BFS from one of them leaves the others at level 0
 * regardless of where they actually belong. Longest-path layering puts a node one column right of
 * its deepest prerequisite, which is the property a reader expects from a left-to-right topology.
 *
 * Unreachable nodes are assigned by the same loop, so nothing disappears.
 */
function layerNodes(
  ids: readonly string[],
  parentsOf: Map<string, string[]>,
): { levels: Map<string, number>; cyclic: boolean } {
  const levels = new Map<string, number>()
  let cyclic = false
  const visit = (id: string, depth: number, path: Set<string>): number => {
    if (path.has(id)) {
      cyclic = true
      return depth
    }
    const known = levels.get(id)
    if (known !== undefined) return known
    const parents = (parentsOf.get(id) ?? []).filter((parent) => ids.includes(parent))
    if (parents.length === 0) {
      // A ROOT IS COLUMN 0 UNLESS IT IS THE RESERVED START, which is its own origin anyway.
      levels.set(id, 0)
      return 0
    }
    path.add(id)
    let deepest = 0
    for (const parent of parents) deepest = Math.max(deepest, visit(parent, depth + 1, path))
    path.delete(id)
    const level = deepest + 1
    levels.set(id, level)
    return level
  }
  for (const id of ids) visit(id, 0, new Set())
  return { levels, cyclic }
}

export interface TopologyInput {
  /** The harness home: `<home>/memory/task-graph.json` is the graph. */
  home: string
  /** Override for the knowledge store. Default: `<home>/knowledge`, else the global default. */
  knowledgeDir?: string
  /** The caller's home, for the `~/.dsh/global-knowledge` fallback. */
  globalKnowledgeDir?: string
}

export function readTopology(input: TopologyInput): TopologyView {
  const empty = (reason: string, path: string): TopologyView => ({
    available: false,
    reason,
    graphId: '',
    goal: '',
    goalLockedAt: '',
    nodes: [],
    edges: [],
    counts: { total: 0, pending: 0, active: 0, done: 0, abandoned: 0 },
    knowledgeTotal: 0,
    unharvested: 0,
    warnings: [],
    path,
  })

  const path = join(input.home, 'memory', 'task-graph.json')
  if (!existsSync(path)) {
    return empty(
      '还没有任务图。记忆插件在模型第一次调用 memory_graph_update 时才会创建它；' +
        '在那之前这张拓扑图是空的，而不是坏了。',
      path,
    )
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch (error) {
    return empty(`任务图无法解析：${String((error as Error)?.message ?? error)}`, path)
  }

  const knowledgeDir =
    input.knowledgeDir ?? (existsSync(join(input.home, 'knowledge')) ? join(input.home, 'knowledge') : input.globalKnowledgeDir ?? '')
  const knowledge = new Map<string, { id: string; title: string; kind: string; tags: string[]; nodeTypes: string[]; body: string }>()
  if (knowledgeDir.length > 0) {
    for (const row of readJsonl(join(knowledgeDir, 'knowledge.jsonl'))) {
      const id = typeof row.id === 'string' ? row.id : ''
      if (id.length === 0) continue
      knowledge.set(id, {
        id,
        title: typeof row.title === 'string' ? row.title : id,
        kind: row.kind === 'negative' ? 'negative' : 'skill',
        tags: asStringList(row.tags),
        nodeTypes: asStringList(row.applicable_node_types),
        body: typeof row.body === 'string' ? row.body : '',
      })
    }
  }

  const rawNodes = Array.isArray(parsed.nodes) ? parsed.nodes.filter((node): node is Record<string, unknown> => node !== null && typeof node === 'object') : []
  const warnings: string[] = []
  const parentsOf = new Map<string, string[]>()
  const ids: string[] = []
  for (const node of rawNodes) {
    const id = typeof node.id === 'string' ? node.id : ''
    if (id.length === 0) continue
    ids.push(id)
    parentsOf.set(id, asStringList(node.dependsOn ?? node.depends_on))
  }
  if (!ids.includes(START_NODE)) warnings.push(`任务图里没有固定起点 "${START_NODE}"：图被外部改坏了，记忆插件会在下次读取时修复它。`)

  const { levels, cyclic } = layerNodes(ids, parentsOf)
  if (cyclic) {
    warnings.push('任务图不是有向无环图：存在循环依赖。分层按最长可达链给出，但这样的图无法按顺序调度。')
  }

  const edges: TopologyEdge[] = []
  const unlocks = new Map<string, string[]>()
  for (const [id, parents] of parentsOf) {
    for (const parent of parents) {
      if (!ids.includes(parent)) {
        warnings.push(`节点 ${id} 依赖了不存在的节点 ${parent}（悬空依赖）。`)
        continue
      }
      edges.push({ from: parent, to: id })
      const list = unlocks.get(parent) ?? []
      list.push(id)
      unlocks.set(parent, list)
    }
  }

  const counts = { total: 0, pending: 0, active: 0, done: 0, abandoned: 0 }
  const nodes: TopologyNode[] = rawNodes
    .filter((node) => typeof node.id === 'string' && (node.id as string).length > 0)
    .map((node) => {
      const id = node.id as string
      const pointers = asStringList(node.knowledgePointers ?? node.knowledge_pointers)
      const resolved = pointers.map((pointer) => knowledge.get(pointer)).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
      const missing = pointers.filter((pointer) => !knowledge.has(pointer))
      const status = node.status === 'active' || node.status === 'done' || node.status === 'abandoned' ? (node.status as string) : 'pending'
      counts.total += 1
      if (status === 'pending') counts.pending += 1
      else if (status === 'active') counts.active += 1
      else if (status === 'done') counts.done += 1
      else counts.abandoned += 1
      return {
        id,
        title: typeof node.title === 'string' && (node.title as string).trim().length > 0 ? (node.title as string) : id,
        phase: typeof node.nodeType === 'string' ? (node.nodeType as string) : '',
        status,
        requirements: asStringList(node.requirements),
        dependsOn: parentsOf.get(id) ?? [],
        unlocks: unlocks.get(id) ?? [],
        knowledge: resolved,
        missingPointers: missing,
        level: levels.get(id) ?? 0,
        harvestedAt: typeof node.harvestedAt === 'string' ? (node.harvestedAt as string) : '',
      }
    })

  const unharvested = nodes.filter((node) => node.status === 'done' && node.harvestedAt.length === 0 && node.id !== START_NODE).length
  if (unharvested > 0) {
    warnings.push(`${unharvested} 个已完成的阶段没有写入全局知识库：这些阶段的经验会随会话一起消失。`)
  }

  return {
    available: true,
    reason: '',
    graphId: typeof parsed.id === 'string' ? parsed.id : 'default',
    goal: typeof parsed.goal === 'string' ? parsed.goal : '',
    goalLockedAt: typeof parsed.goalLockedAt === 'string' ? parsed.goalLockedAt : '',
    nodes,
    edges,
    counts,
    knowledgeTotal: knowledge.size,
    unharvested,
    warnings,
    path,
  }
}
