/**
 * ── memory 的模块登记门禁（从 dsh-observer 的 `test/module-registry.test.mjs` 移植）───────
 *
 * 守什么：`MODULE-REGISTRY.md` 与 `src/*.ts` **双向**一致。
 *
 * ── 为什么双向都要查（这句是移植时加的理解）──────────────────────────────────────────────────
 *
 *   只查「表里的文件是否存在」→ 新模块可以悄悄不进表（代码在长、图不动）；
 *   只查「磁盘上的文件是否进表」→ 表里可以留已删除模块的行。
 * 两个方向都查，才叫登记表。第三个方向：依赖列必须指向真实存在的模块。
 *
 * ── 本仓与 observer 的差别 ───────────────────────────────────────────────────────────────────
 *
 * observer 的被覆盖目录是 `src/core`；本仓是**扁平 `src/`**（27 个 .ts 都在同一层），
 * 所以 COVERED_DIRS 只有一个 `src`。这也意味着文件名可能只是 `index.ts` 这种无前缀形态，
 * 行内模块名统一写成 `src/<file>` 以免歧义。
 *
 * 表头写明分母算法：`endsWith('.ts')`。`src/` 下没有 `.bak-cut`；换成别的目录时要先确认这一点。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'


const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REGISTRY = join(ROOT, 'MODULE-REGISTRY.md')
const COVERED_DIRS = ['src']

/**
 * `| \`src/x.ts\` | 职责 | 导出 | 依赖 |`  —— 以及 `| \`src/store/x.ts\` | … |`
 *
 * ── 字符集必须包含下划线 ────────────────────────────────────────────────────────────────────
 *
 * 第一版照抄 observer 的 `[a-z0-9-]+`，can-red 注入 `__unregistered.ts` 时**门禁没有红** ——
 * 因为下划线不在字符集里，那一行根本没被解析成"一行"，于是"表里的幽灵行"和"磁盘上的新文件"
 * 两个方向都看不见它。**一个读不进表的文件名，等于一个不受监管的文件名。**
 *
 * 改成 `[a-z0-9_-]+`（下划线、连字符、字母、数字）。
 *
 * ── 2026-11-15：路径必须允许**一层子目录** ─────────────────────────────────────────────────────
 *
 * 前半段是 `(?:src\/)?` —— 它只接受扁平的 `src/x.ts`。`src/store/clock.ts` 与
 * `src/retrieve/interning.ts` 因此**一行都读不进来**，而 `modulesOnDisk()` 当时也只扫了一层，
 * 两边"一致地看不见" → 8 个模块长期在守护之外，双向断言全绿。
 *
 * 这是本文件开头那句「读不进表的文件名 = 不受监管的文件名」的**第二次**发生：
 * 第一次是下划线，这次是斜杠。两次的形状一样 —— **解析器的字符集比真实的文件名窄**。
 *
 * ── 2026-11-16：**第三次**，同一个形状，这次是「层数」而不是字符集 ───────────────────────────
 *
 * 移植到 paradise 时，正则写的是 `(?:[a-z0-9_-]+\/)?` —— **可选的一层**子目录。
 * 而本仓的路径是两层：`src/adapters/dsh/assert-capabilities.ts`、`src/adapters/raw/firewall.ts`。
 * 于是**一条都读不进来**，第一次跑测试就报「26 个模块在磁盘上但没登记」，而表里明明有 54 行。
 *
 * 一次就够了：`(?:[a-z0-9_-]+\/)*` —— 层级数不是判据的一部分，**能不能读进来才是**。
 * 这条修正不改任何一条断言的严厉程度：它只是让解析器看见真实存在的文件。
 */
const ROW = /^\|\s*`((?:src\/)?(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.ts)`\s*\|([^|]*)\|([^|]*)\|([^|]*)\|\s*$/gmu

const readRows = () => {
  assert.ok(existsSync(REGISTRY), 'MODULE-REGISTRY.md must exist (it is the only authority on module coverage)')
  const text = readFileSync(REGISTRY, 'utf8')
  const rows = []
  for (const m of text.matchAll(ROW)) {
    rows.push({
      module: m[1].startsWith('src/') ? m[1] : `src/${m[1]}`,
      duty: m[2].trim(),
      exports: m[3].trim(),
      deps: m[4].trim(),
    })
  }
  return rows
}

/**
 * ── RECURSIVE: `src/store/*.ts` and `src/retrieve/*.ts` are modules too ────────────────────────
 *
 * The first version was `readdirSync(dir)` only — one level. When the store split introduced
 * `src/store/`, five modules became invisible to both directions of this gate at once; the
 * retrieve split then added three more. Nine modules ran for months with no registry coverage
 * while the suite stayed green, because **the scanner and the table were blind in the same way**.
 *
 * A directory walk is the fix, and the `endsWith('.ts')` denominator is unchanged (that is what
 * MODULE-REGISTRY.md documents as the counting rule).
 */
const modulesOnDisk = () => {
  const out = []
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childAbs = join(abs, entry.name)
      const childRel = `${rel}/${entry.name}`
      if (entry.isDirectory()) { walk(childAbs, childRel); continue }
      if (!entry.name.endsWith('.ts')) continue
      out.push(childRel)
    }
  }
  for (const dir of COVERED_DIRS) walk(join(ROOT, dir), dir)
  return out.sort()
}

test('every module on disk is REGISTERED (a new file cannot slip in silently)', () => {
  const registered = new Set(readRows().map((r) => r.module))
  const missing = modulesOnDisk().filter((m) => !registered.has(m))
  assert.deepEqual(missing, [], `these module(s) exist under src/ but are NOT in MODULE-REGISTRY.md: ${missing.join(', ')}`)
})

test('every row in the registry points at a file that EXISTS (a deleted module cannot linger)', () => {
  const onDisk = new Set(modulesOnDisk())
  const phantom = readRows().map((r) => r.module).filter((m) => !onDisk.has(m))
  assert.deepEqual(phantom, [], `these row(s) name a module that no longer exists: ${phantom.join(', ')}`)
})

test('every row declares a one-line duty and its exports', () => {
  for (const row of readRows()) {
    assert.notEqual(row.duty.length, 0, `${row.module}: the duty column is empty — a registry without "what for" is a file list`)
    assert.notEqual(row.exports.length, 0, `${row.module}: the exports column is empty`)
  }
})

test('the dependency column only names modules that EXIST (no dangling dependency)', () => {
  const onDisk = new Set(modulesOnDisk())
  for (const row of readRows()) {
    if (row.deps === '—' || row.deps.length === 0) continue
    for (const dep of splitDeps(row.deps)) {
      assert.ok(onDisk.has(dep.module), `${row.module}: dependency "${dep.raw}" does not exist under src/`)
    }
  }
})

/**
 * 依赖列里一项的解析。
 *
 * `x.ts (type-only)` 与 `x.ts` 是**两种不同的边**：前者运行时被擦除，后者真的会执行。
 * 门禁必须区分它们，否则一个仅类型环会让"表不能成环"这条永远红 ——
 * 而那条环恰恰是合法的（见 MODULE-REGISTRY.md 的说明）。
 */
function splitDeps (cell) {
  return cell.split(',').map((s) => s.trim()).filter((s) => s.length > 0).map((raw) => {
    // 同 ROW 的第三次修正：依赖列里的模块名也是**可以带两层以上目录**的
    // （`adapters/dsh/policy.ts`、`protocol/lease.ts`）。只接受扁平名会让这些边
    // 静默变成「不存在的模块」，而方向③的断言就查不到它们。
    const m = /^`?((?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.ts)`?\s*(\(type-only\))?$/u.exec(raw.replace(/^`|`$/gu, ''))
    const module = m === null ? raw.replace(/`/gu, '').replace(/\s*\(type-only\)$/u, '') : m[1]
    return {
      raw,
      module: module.startsWith('src/') ? module : `src/${module}`,
      typeOnly: m !== null && m[2] !== undefined,
    }
  })
}

test('the registry has no VALUE cycle (type-only edges are erased at runtime and do not count)', () => {
  const rows = readRows()
  const graph = new Map(rows.map((r) => [
    r.module,
    r.deps === '—'
      ? []
      : splitDeps(r.deps).filter((d) => !d.typeOnly).map((d) => d.module),
  ]))

  const state = new Map()
  const visit = (node, trail) => {
    if (state.get(node) === 'done') return undefined
    if (state.get(node) === 'active') return [...trail, node]
    state.set(node, 'active')
    for (const next of graph.get(node) ?? []) {
      const cycle = visit(next, [...trail, node])
      if (cycle !== undefined) return cycle
    }
    state.set(node, 'done')
    return undefined
  }

  for (const node of graph.keys()) {
    const cycle = visit(node, [])
    assert.equal(cycle, undefined, `the registry's VALUE dependencies contain a cycle: ${cycle?.join(' -> ')}`)
  }
})

test('every type-only edge is REALLY type-only in the source (the label cannot lie)', () => {
  /**
   * 这条防的是「把一条值依赖标成 type-only 来骗过成环检查」。
   * 判据：源文件里指向该模块的那条 import 必须以 `import type` 或 `{ type X }` 出现，
   * 且**不存在**任何指向同一模块的值导入。
   */
  for (const row of readRows()) {
    if (row.deps === '—') continue
    const text = readFileSync(join(ROOT, row.module), 'utf8')
    for (const dep of splitDeps(row.deps)) {
      if (!dep.typeOnly) continue
      /**
       * ── 2026-11-16：**第四次**同一个形状，这次是「只比最后一段」 ─────────────────────────────
       *
       * 上一版写的是 `i.spec.split('/').pop() === targetBase`。对扁平的 `src/x.ts` 恰好成立，
       * 因为两边都只剩 `x`。但本仓的依赖目标是 `protocol/index.ts`、`adapters/dsh/policy.ts`，
       * 而 import 是 `'../../protocol/index.js'` —— 只比最后一段得到 `index` vs `protocol/index`，
       * **永远不相等**，于是「标签为真」这条断言把一个真 type-only 边报成「没有这样的 import」。
       *
       * 判据改成**解析后的同一性**：把 import 说明符相对声明的文件解析成 `src/…` 路径，再比。
       * 这与 `check-cycles.mjs` 的做法一致（相对解析，不猜目录层级）。
       */
      const declaredDir = posix.dirname(dep.module)
      const resolved = [...text.matchAll(/^[ \t]*(?:import|export)[^\n]*from\s+['"](\.[^'"]+)['"]/gmu)]
        .map((m) => {
          const spec = m[1].replace(/\.(?:js|ts)$/u, '')
          const asPath = posix.normalize(posix.join(posix.dirname(row.module), spec)) + '.ts'
          const asIndex = asPath.replace(/\.ts$/u, '/index.ts')
          return { spec, line: m[0], asPath, asIndex }
        })
        // 同一条边有两种写法：`../protocol` → `protocol/index.ts`，以及 `../protocol/lease`
        // → `protocol/lease.ts`。命中任一即算指向同一个模块。
        .filter((i) => i.asPath === dep.module || i.asIndex === dep.module || i.asPath === posix.join(declaredDir, posix.basename(dep.module)))
      assert.ok(resolved.length > 0, `${row.module}: claims a type-only edge to ${dep.module} but has no such import`)
      const hasValue = resolved.some((i) => !/^\s*(?:import|export)\s+type\b/u.test(i.line) && !/\{\s*type\b/u.test(i.line))
      assert.equal(hasValue, false, `${row.module}: labels ${dep.module} as type-only, but at least one import of it is a VALUE import: ${resolved.map((i) => i.line.trim()).join(' | ')}`)
    }
  }
})

/**
 * ── 分布数字：**打印**，但不在文档里冻结 ────────────────────────────────────────────────────────
 *
 * MODULE-REGISTRY.md 曾有一节「现状分布（实测，非估计）」，里面写着「36 个模块 / 14,722 行 /
 * 3 个超 800 / 最大 index.ts」。五次搬运里它过时了四次，最后一次是 retrieve 拆分的第五步
 * （新模块进表了，那一节的「36」没跟着变成 37）。
 *
 * 这不是笔误问题，是**形状问题**：文档里写死的实测数字没有任何门禁会因为过时而红 ——
 * 而「实测」两个字恰恰是它最像证据、最该被信任的地方。
 *
 * 处置：数字由这条测试**打印**（`t.diagnostic`，跑测试就能看到当前值），文档只留命令。
 * 断言部分只查一件事：这些数字与表**自洽**（磁盘模块数 == 表行数），
 * 真正的一致性由上面那六条负责，这里不重复。
 */
test('distribution: 模块数 / 总行数 / 超 800 / 最大文件（打印给文档引用，不在文档里冻结）', (t) => {
  const files = modulesOnDisk()
  const sizes = files.map((rel) => {
    const parts = readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/gu, '\n').split('\n')
    return { rel, lines: parts[parts.length - 1] === '' ? parts.length - 1 : parts.length }
  })
  const total = sizes.reduce((s, x) => s + x.lines, 0)
  const over = sizes.filter((x) => x.lines > 800).sort((a, b) => b.lines - a.lines)
  const max = sizes.reduce((a, b) => (b.lines > a.lines ? b : a))
  const byDir = new Map()
  for (const { rel } of sizes) {
    const dir = rel.split('/').length > 2 ? rel.split('/')[1] : '(扁平 src/)'
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1)
  }
  const layout = [...byDir.entries()].map(([d, n]) => `${d} ${n}`).join(' + ')

  t.diagnostic(`模块数 ${files.length}（${layout}）`)
  t.diagnostic(`总行数 ${total}`)
  t.diagnostic(`> 800 行 ${over.length} 个（${over.map((x) => `${x.rel} ${x.lines}`).join('、') || '无'}）`)
  t.diagnostic(`最大文件 ${max.rel} ${max.lines} 行（占 ${(max.lines / total * 100).toFixed(1)}%）`)

  assert.equal(files.length, readRows().length,
    '磁盘上的模块数与登记表的行数不一致 —— 双向一致性由上面那两条负责，这里只做一次交叉核对')
})
