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
 * ── 捕获 clause，好判定这条 import 是不是「仅类型」 ─────────────────────────────────────────────
 *
 * §三十八.3 移植：memory / paradise 早已区分「值环」与「仅类型环」，而这里把两者算成同一件事。
 * `import type` 在产出 JS 时**整条消失**，因此它构不成运行时环 —— 把它报成环会逼人去拆分合法的
 * 类型互引。
 *
 * 第一组捕获是 spec 之前的那段 clause，用它判断 type-only。
 */
/**
 * 两种合法的相对 import 形状，分开匹配 —— 一条正则同时覆盖它们会把 `import.meta` 也算进来。
 *
 * 实测（第一版移植）：一条宽松的 `(?:import|export)\b([^'"]*?)['"](...)` 把
 * `import.meta.dirname` 之后几十个字符处的 `'.json'` 配成了依赖边，于是「未解析的 import」凭空多出 5 条
 * —— 而那 5 条是**数据文件名**，不是模块。**一条正则宽一格，结论就错一片。**
 *
 *   A  带 from：`import { A } from './x'` / `export * from './x'` / `import type { T } from './x'`
 *   B  副作用：  `import './x'`
 */
const IMP_FROM = /(?:^|\n)[ \t]*(?:import|export)\b(?!\s*[.(])([^'"]*?)\bfrom\s+['"](\.[^'"]+)['"]/gu
const IMP_SIDE_EFFECT = /(?:^|\n)[ \t]*import\s+['"](\.[^'"]+)['"]/gu

/**
 * 这条 import / export 是否**只在类型位置**使用。
 *
 * 三种形状都是仅类型：
 *   `import type { X } from`      `export type { X } from`
 *   `import { type A, type B }`    —— 大括号里每一项都以 `type ` 开头
 *   `import type X from`
 *
 * 一条边只要有一处**值**引用，就不是仅类型（保守方向：宁可把它算成运行时边）。
 */
function isTypeOnlyClause (clause) {
  if (/\b(?:import|export)\s+type\b/u.test(clause)) return true
  const braces = /\{([^}]*)\}/u.exec(clause)
  if (braces === null) return false
  const entries = braces[1]
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  if (entries.length === 0) return false
  return entries.every((entry) => /^type\s/u.test(entry))
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

const graph = new Map()      // 全部边（值 + 仅类型）—— 用来找「仅类型环」
const valueGraph = new Map() // 只有值边 —— 用来判定真正的运行时环
const missing = []
for (const f of files) {
  const text = readFileSync(f, 'utf8')
  const outs = new Set()
  const valueOuts = new Set()
  /** A: 带 from 的形状（clause 决定它是不是仅类型）。 */
  for (const m of text.matchAll(IMP_FROM)) {
    const t = target(f, m[2])
    if (t === undefined) { missing.push(`${relative(SRC, f)} -> ${m[2]}`); continue }
    if (t === f) continue
    outs.add(t)
    if (!isTypeOnlyClause(m[1])) valueOuts.add(t)
  }
  /** B: 副作用 import 永远是真值边（它为了副作用而存在）。 */
  for (const m of text.matchAll(IMP_SIDE_EFFECT)) {
    const t = target(f, m[1])
    if (t === undefined) { missing.push(`${relative(SRC, f)} -> ${m[1]}`); continue }
    if (t === f) continue
    outs.add(t)
    valueOuts.add(t)
  }
  graph.set(f, outs)
  valueGraph.set(f, valueOuts)
}

const rel = f => relative(SRC, f).replace(/\\/g, '/')

/** Tarjan 强连通分量：>1 的 SCC 就是环。传哪张图就算哪张。 */
function sccsOf (g) {
  let index = 0
  const idx = new Map(); const low = new Map(); const onStack = new Set(); const stack = []; const found = []
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
      if (comp.length > 1) found.push(comp)
    }
  }
  for (const f of files) if (!idx.has(f)) strongconnect(f)
  return found
}

const sccs = sccsOf(valueGraph)
const allSccs = sccsOf(graph)

const edges = [...graph.values()].reduce((s, o) => s + o.size, 0)
console.log(`nodes: ${files.length}  edges: ${edges}  unresolved: ${missing.length}`)

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

/**
 * ── 仅类型环：报出来，但**不阻断**（§三十八.3）───────────────────────────────────────────────────
 *
 * `import type` 在产出 JS 时整条消失，所以它构不成运行时环。把它报成失败会逼人去拆分合法的类型互引
 * —— 那是「为了门禁变绿而改好代码」的反面：为了让门禁变绿去改**坏**代码。
 *
 * 但它必须**显形**：不报出来，读者就无法区分「没有环」与「有环但都是类型的」。所以它走 NOTE。
 */
const valueKeys = new Set(sccs.map((comp) => comp.map(rel).sort().join('|')))
const typeOnlySccs = allSccs.filter((comp) => !valueKeys.has(comp.map(rel).sort().join('|')))

if (typeOnlySccs.length > 0) {
  console.log(`NOTE: ${typeOnlySccs.length} type-only cycle(s) — \`import type\` is erased at runtime, not a failure:`)
  for (const comp of typeOnlySccs) console.log('  ' + comp.map(rel).join(' ⇄ '))
}

if (sccs.length === 0) {
  console.log('ACYCLIC — no RUNTIME dependency cycle, and every relative import resolved to a file')
} else {
  console.log(`CYCLES: ${sccs.length}`)
  for (const c of sccs) console.log('  ' + c.map(rel).join(' ⇄ '))
  process.exitCode = 1
}
