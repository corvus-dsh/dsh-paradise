// 依赖图环检测：加 import 修类型错误时，唯一真正的危险是「引入环」。
// 输出：节点数、边数、所有环（若有）。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ── THE REPO PATH MUST BE DERIVED, NOT TYPED ─────────────────────────────────────────────────────
 *
 * The first version hard-coded `D:/持久层能力架构/dsh-graft-slice` — this machine's absolute path.
 * It passed every local run and failed on its very first CI run (#118, step 19) because on the
 * runner there is no `D:` drive at all. Every other script in this directory already derives the
 * root from `import.meta.url`; this one did not, and nothing local could catch it.
 *
 * A path constant that only exists on one machine is not a configuration, it is a bug with a
 * delayed report — and the delay is exactly one push.
 */
const REPO = fileURLToPath(new URL('..', import.meta.url))
/**
 * `GRAFT_CHECK_CYCLES_SRC` lets a test point this at a TEMPORARY copy of src/.
 *
 * Measured: `test/v144` proves the unresolved-edge failure by injecting a bad import into
 * `src/core/layout.ts` and restoring it in a `finally`. Node's test runner runs FILES in parallel,
 * so any other test that reads the tree during that window sees a broken repo — the suite failed
 * intermittently with "v144" while v144 itself passed in isolation.
 *
 * A test that mutates the real tree is a test that fails other tests. The override makes the
 * injection happen in a copy, so nothing outside the test can observe it.
 */
const SRC = process.env.GRAFT_CHECK_CYCLES_SRC !== undefined && process.env.GRAFT_CHECK_CYCLES_SRC !== ''
  ? resolve(process.env.GRAFT_CHECK_CYCLES_SRC)
  : join(REPO, 'src')

function walk (dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (e.endsWith('.ts') && !e.includes('.bak')) out.push(p)
  }
  return out
}

const files = walk(SRC)

/**
 * ── `import type` 是**运行时不存在**的边，不能和值导入混在一起算环 ──────────────────────────────
 *
 * 移植到本仓时实测到的一处真实差异：`check-cycles` 在 dsh-memory 上报了 1 个环
 *
 *     retrieve.ts ⇄ filter.ts
 *
 * 但逐边看，其中**只有一条是值导入**：
 *
 *     retrieve.ts -> filter.ts   值导入（selectApplicableSkillsDetailed）
 *     filter.ts   -> retrieve.ts **`import type { MemoryHit }`** —— 运行时被擦除
 *
 * TypeScript 的 `import type` 在产出 JS 时整条消失，所以它**不构成运行时环**。
 * 把它算进去，会把「类型层面互相引用」误报成「运行时死锁风险」——
 * 而这两件事的处置完全不同：前者可以长期存在，后者必须拆。
 *
 * 所以这里把边分成两类，**两条环都报，但分开说**：
 *   · 值环（value cycle）—— 运行时会真的转圈，这才是 `check-cycles` 该拦的；
 *   · 仅类型环（type-only cycle）—— 只在类型检查里存在，信息项，不阻断。
 *
 * 判据：`import type X from './y'` 与 `import { type X } from './y'` 都算 type-only；
 * 一条 import 里同时有值成员和 `type` 成员的，保守算**值导入**（宁可多报不可漏报）。
 */
const IMP = /(?:^|\n)\s*(?:import|export)\s+([^'"\n]*?)\s+from\s+['"](\.[^'"]+)['"]/gu
const IMP_BARE = /(?:^|\n)\s*(?:import|export)\s+['"](\.[^'"]+)['"]/gu

/** 这个 import 子句是不是 type-only？ */
function isTypeOnlyClause (clause) {
  const trimmed = clause.trim()
  // `import type { X } from` / `import type X from`
  if (/^type\s/u.test(trimmed)) return true
  // `import { type X, type Y } from` —— 全部成员都带 type 才算
  const braced = /^\{([\s\S]*)\}$/u.exec(trimmed)
  if (braced !== null) {
    const members = braced[1].split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    return members.length > 0 && members.every((m) => /^type\s/u.test(m))
  }
  return false
}

/**
 * 解析相对 spec 到真实文件。
 *
 * ── `.ts` 扩展名是真实语法，解析器必须认识它 ─────────────────────────────────────────────────────
 *
 * 第一版只剥离 `.js`，于是 `./model-wording.ts` 被拼成 `model-wording.ts.ts`，解析失败，
 * 那条边落进 `unresolved`。而 ACYCLIC 是在**忽略了一条边**的基础上算出来的 ——
 * 如果那条边恰好是环的一部分，结论就是错的。
 *
 * 用户点出了这一点：「ACYCLIC 不能建立在不认识的边上」。
 *
 * `src/contracts/model-wording.contracts.ts` 确实用 `.ts` 结尾，而且是**刻意的**：
 * 它只被测试直接加载，Node 不走 `.js`→`.ts` 重写，所以那条 import 必须写真实扩展名。
 * 结论：这不是异常，是这个仓库的一种合法 import 形状，解析器本来就该支持。
 */
function target (fromFile, spec) {
  const base = resolve(dirname(fromFile), spec.replace(/\.(?:js|ts)$/u, ''))
  for (const cand of [base + '.ts', join(base, 'index.ts')]) {
    try { if (statSync(cand).isFile()) return cand } catch { /* not this one */ }
  }
  return undefined
}

/**
 * 两张图：值图（阻断）与类型图（信息）。
 * 值图只收非 type-only 的 import；类型图收全部。
 */
const graph = new Map()
const typeGraph = new Map()
const missing = []
for (const f of files) {
  const text = readFileSync(f, 'utf8')
  const outs = new Set()
  const typeOuts = new Set()
  for (const m of text.matchAll(IMP)) {
    const clause = m[1]
    const spec = m[2]
    const t = target(f, spec)
    if (t === undefined) { missing.push(`${relative(SRC, f)} -> ${spec}`); continue }
    if (t === f) continue
    typeOuts.add(t)
    if (!isTypeOnlyClause(clause)) outs.add(t)
  }
  // `import './x.js'`（纯副作用）没有 from 子句，一律算值导入
  for (const m of text.matchAll(IMP_BARE)) {
    const t = target(f, m[1])
    if (t === undefined) { missing.push(`${relative(SRC, f)} -> ${m[1]}`); continue }
    if (t === f) continue
    typeOuts.add(t)
    outs.add(t)
  }
  graph.set(f, outs)
  typeGraph.set(f, typeOuts)
}

const rel = f => relative(SRC, f).replace(/\\/g, '/')

/** Tarjan：>1 的 SCC 就是环。抽成函数，因为要对两张图各跑一次。 */
function stronglyConnected (g) {
  let index = 0
  const idx = new Map(); const low = new Map(); const onStack = new Set(); const stack = []; const sccs = []
  function strongconnect (v) {
    idx.set(v, index); low.set(v, index); index += 1
    stack.push(v); onStack.add(v)
    for (const w of g.get(v) ?? []) {
      if (!idx.has(w)) { strongconnect(w); low.set(v, Math.min(low.get(v), low.get(w))) }
      else if (onStack.has(w)) { low.set(v, Math.min(low.get(v), idx.get(w))) }
    }
    if (low.get(v) === idx.get(v)) {
      const comp = []
      let w
      do { w = stack.pop(); onStack.delete(w); comp.push(w) } while (w !== v)
      if (comp.length > 1) sccs.push(comp)
    }
  }
  for (const f of files) if (!idx.has(f)) strongconnect(f)
  return sccs
}

const sccs = stronglyConnected(graph)
const typeSccs = stronglyConnected(typeGraph)

/** 仅类型环 = 类型图里有、值图里没有的那些（按成员集合比较）。 */
const keyOf = (comp) => comp.map(rel).sort().join('|')
const valueKeys = new Set(sccs.map(keyOf))
const typeOnlySccs = typeSccs.filter((comp) => !valueKeys.has(keyOf(comp)))

const edges = [...graph.values()].reduce((s, o) => s + o.size, 0)
const typeEdges = [...typeGraph.values()].reduce((s, o) => s + o.size, 0)
console.log(`nodes: ${files.length}  value edges: ${edges}  all edges (incl. type-only): ${typeEdges}  unresolved: ${missing.length}`)

/**
 * ── AN ACYCLICITY CLAIM CANNOT REST ON AN EDGE NOBODY UNDERSTANDS ───────────────────────────────
 *
 * Measured: the first run printed `unresolved: 1` — `contracts/model-wording.contracts.ts ->
 * ./model-wording.ts` — and then printed `ACYCLIC` anyway. That is the wrong shape for a verdict:
 * if the unparsed edge happened to close a cycle, "ACYCLIC" would be false while looking green.
 *
 * The cause was the resolver stripping only `.js`, so `./model-wording.ts` became
 * `model-wording.ts.ts` and missed (that import is deliberately `.ts` — the file is loaded by Node
 * directly, and Node does not rewrite `.js` → `.ts`).
 *
 * Fixed in the resolver — but the DISPLAY problem was the real one, so an unresolved edge is now a
 * FAILURE, not a footnote. A green verdict must cover every edge it saw.
 */
if (missing.length > 0) {
  console.error('FAIL: these relative imports could not be resolved to a file, so the graph is incomplete:')
  for (const line of missing) console.error(`  ${line}`)
  console.error('A cycle check over a partial graph proves nothing. Fix the specifier or teach the resolver the shape.')
  process.exit(1)
}

if (sccs.length === 0) {
  console.log('ACYCLIC — no VALUE dependency cycle, and every relative import resolved to a file')
} else {
  console.log(`VALUE CYCLES: ${sccs.length}`)
  for (const c of sccs) console.log('  ' + c.map(rel).join(' ⇄ '))
  process.exitCode = 1
}

/**
 * 仅类型环：**报出来，但不阻断**。
 *
 * 为什么单独报而不是丢掉：它是真实存在的耦合（一处改签名会牵连另一处），
 * 但它不构成运行时风险，处置方式也不同（可以长期共存，也可以在合适时把共享类型抽到第三个文件）。
 * 丢掉它会让「文件之间到底怎么耦合」这个问题少一半答案。
 */
if (typeOnlySccs.length > 0) {
  console.log(`NOTE: ${typeOnlySccs.length} type-only cycle(s) — import type is erased at runtime, not a failure:`)
  for (const c of typeOnlySccs) {
    const members = c.map(rel)
    console.log('  ' + members.join(' ⇄ '))
    // 把每条边是不是 type-only 摆出来，读者不用自己猜
    for (const from of c) {
      const valueOut = graph.get(from) ?? new Set()
      const typeOut = typeGraph.get(from) ?? new Set()
      for (const to of c) {
        if (from === to || !typeOut.has(to)) continue
        const kind = valueOut.has(to) ? 'VALUE' : 'type-only'
        console.log(`     ${rel(from)} -> ${rel(to)} : ${kind}`)
      }
    }
  }
}
