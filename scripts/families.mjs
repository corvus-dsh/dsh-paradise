#!/usr/bin/env node
/**
 * ── 族划分（分量分析）────────────────────────────────────────────────────────────────────────────
 *
 * 用户裁定（2026-11-12）：extractGoal 搬出去后旧 12 族已失效，**必须重跑**，不能沿用旧图。
 *
 * ── 第一版写错了，这里记下来 ────────────────────────────────────────────────────────────────────
 *
 * 第一版用 `closure.mjs <name>` 取「成员之间的依赖」，但那个命令返回的是**该声明自身的闭包**
 * （对孤立函数恰好是 1 个成员 = 它自己），于是每个成员都被看成没有邻居，
 * 最终合并成 1 个「32 声明 / 1906 行」的假分量 —— 与上一轮的 13 个分量完全不符。
 *
 * 正确做法：用 `who-references.mjs` 拿到每个符号的**引用行**，再判断那一行落在哪个声明的区间里。
 * 「A 引用 B」= B 的某个引用行位于 A 的声明区间内。这是有向边，分量用无向连通。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * 根目录来自 `import.meta.url`，不是写死的本机路径 —— `check-cycles.mjs` 曾在 #118 上
 * 因为写死 `D:/…` 而「本机每次过、CI 每次红」，test/v129 现在专门断言这一点。
 * 第一次写这个脚本时我也写死了，被自己新加的门禁当场抓住（families.mjs 是第一个真正
 * 命中那条正则的脚本，此前它从未匹配到任何文件，所以崩溃一直没暴露）。
 */
const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/u, '')
/**
 * 默认根节点：**必须改成本仓的根**。
 *
 * 从 graft-slice 移植过来时这里是 `'buildTape'` —— observer 里没有那个声明，
 * 于是不带参数跑会得到「0 declaration(s), 0 connected component(s)」，
 * 而 0 看起来像「这个仓没有族」，实际是**量的东西不存在**。
 * observer 的对应根是 `apply`（1,651 行，99% 的体积都在它体内）。
 */
/**
 * ── 参数解析必须**与顺序无关**，否则会产出"这个文件没有族"的假结论 ──────────────────────────────
 *
 * 实测过的一种踩法（用户踩的）：
 *
 *     $ node scripts/families.mjs --src store.ts appendLayer
 *     --src: 0 declaration(s), undefined lines
 *     0 connected component(s), 0 lines in the table
 *
 * 旧的解析是 `const TARGET = process.argv[2] ?? 'applyInner'` —— 它把 `--src` **当成目标是量**，
 * 于是 closure 拿到 `--src` 这个不存在的名字，返回空；而输出里那行 `--src: 0 declaration(s)`
 * 又长得像在说"这个文件没有族"。**那不是没族，是参数吃错了。**
 *
 * 修法：先剥掉 `--src <file>` 这一对，剩下的第一个位置参数才是目标；不依赖谁在前。
 */
const argv = process.argv.slice(2)
const srcIdx = argv.indexOf('--src')
const SRC_FILE = srcIdx >= 0 && argv[srcIdx + 1] !== undefined ? argv[srcIdx + 1] : 'index.ts'
const positional = argv.filter((_, i) => (srcIdx < 0 ? true : i !== srcIdx && i !== srcIdx + 1))
const TARGET = positional[0] ?? 'applyInner'
const SRC = `${REPO}/src/${SRC_FILE}`

const run = (script, args) => {
  try {
    return execFileSync(process.execPath, [REPO + '/scripts/' + script, ...args], { cwd: REPO, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
}

const report = run('closure.mjs', [TARGET])
/**
 * ── 成员正则的 `(\w+)` 漏掉了 `let/var` —— 这就是「1876 vs 1877」那 1 行差的真身 ────────────────
 *
 * `closure.mjs` 打印的 kind 里有 `[let/var]`，而旧正则要求 `\[(\w+)\]`：`/` **不是** `\w`，
 * 于是两个模块级 `let`（`bindingsPath` / `state`）**整条被丢弃**，不进成员表、也不进跨度求和。
 *
 * 差额因此凭空出现 2 行（两个 `let` 各 1 行），而 `FollowTransferResult` 的多算 1 行又把差额
 * 抵消成 **1**（2 − 1 = 1）—— 两个方向相反的缺陷互相掩盖，正是「已知但未解释」最危险的样子。
 * 上一版 NOTE 把差额解释成「闭包内的空行/游离语句」，**那是错的**：闭包里那 2 行是 `let`。
 *
 * 修法：kind 允许 `let/var`（`[\w/]+`），`spanOf` 也要能为它找行（见下）。
 */
/**
 * ── 成员正则的文件名也来自 `--src`（见文件头的 SRC_FILE）────────────────────────────────────────
 *
 * 原写法把 `index\.ts` 写死在正则里：`families.mjs appendLayer`（在 store.ts 里）返回 **0 个声明**，
 * 而 closure 明明报了 225 行 —— 自校验于是红成 `0 != 225`。
 * 那不是"store.ts 没有族"，是**仪器只看得见 index.ts**。
 */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const memberRe = new RegExp(`^\\s+${escapeRe(SRC_FILE)}:(\\w+) \\[([\\w/]+)\\]`, 'gmu')
const members = [...report.matchAll(memberRe)].map((m) => ({ name: m[1], kind: m[2] }))
console.log(`${TARGET}: ${members.length} declaration(s), ${/lines\s*:\s*(\d+)/u.exec(report)?.[1]} lines`)

/**
 * ── AMBIGUOUS MEMBERS LEAVE THE TABLE ENTIRELY ──────────────────────────────────────────────────
 *
 * 用户裁定（2026-11-12）：`name` 移出分量表，单列一行 AMBIGUOUS + 声明点数。
 *
 * 上一版只剔除**边**、仍把 `name` 留在**成员表**里，于是它自己变成一个 1-decl 分量，
 * 把分量数从 13 推到 14 —— 一个「我们测量不了的东西」占据了一个格子，读者会以为那里有个族。
 *
 * 实测：`name` 在整棵树有 17 个声明点（1 个模块级 `export const name` + 16 个函数内局部 `const name`），
 * 对它的任何「引用行」都无法归给某一个符号。判据来自 `who-references --json` 的 `ambiguous` 字段，
 * 消费方不另立一套。
 */
const findingsByMember = new Map()
const ambiguousMembers = []
const ambiguousDeclCounts = new Map()
for (const m of members) {
  let findings
  try {
    findings = JSON.parse(run('who-references.mjs', ['--json', m.name]))
  } catch {
    console.error(`families: cannot parse who-references --json for ${m.name}`)
    continue
  }
  if (findings.some((f) => f.ambiguous === true)) {
    ambiguousMembers.push(m.name)
    ambiguousDeclCounts.set(m.name, findings.filter((f) => f.kind === 'DECL').length)
    continue
  }
  findingsByMember.set(m.name, findings)
}

if (ambiguousMembers.length > 0) {
  const parts = ambiguousMembers.map((n) => `${n} (${ambiguousDeclCounts.get(n)} declaration site(s))`)
  console.log(`AMBIGUOUS — removed from the component table: ${parts.join(', ')}`)
}

const liveMembers = members.filter((m) => !ambiguousMembers.includes(m.name))

/**
 * ── SPANS COME FROM THE COMPILER, NOT FROM A PARSER WRITTEN HERE ─────────────────────────────────
 *
 * The previous implementation was a hand-rolled bracket balancer (`spanOf`). It produced SIX wrong
 * answers in one afternoon on observer, and on `retrieve.ts` it is still wrong in a way that voids the
 * ENTIRE table: `INCIDENT_MARKERS` is an **8-line** array of regex literals, but the balancer counted
 * the `\(` inside `/(报错|抛错|…)/u` as a syntactic paren and kept balancing until some later `}`
 * closed the depth — **1427 lines**. That one phantom component swallowed 68 declarations, and the
 * self-check reported `spans 2717 != closure 1298 (difference 1419)` where **1419 == 1427 − 8**.
 *
 * I tried patching the balancer with a masker (blank strings / regexes / comments before balancing).
 * It fixed `retrieve.ts` and **broke the `index.ts` baseline**: `applyInner` went from 1362 to 704.
 * Reverted.
 *
 * The lesson `move-gate.mjs` already wrote down applies here: **a second parser is a second truth.**
 * `closure.mjs --declarations` emits the compiler's own `getStart()/getEnd()` span table for exactly
 * this reason, so this file now CONSUMES it instead of guessing.
 *
 * When the compiler is absent, this script has no spans and says so: it prints a RESOURCE line and
 * exits 2 (the same convention `closure.mjs` and `test/v201` use). A table built on a missing
 * measurement is worse than no table — that is precisely the failure this rewrite removes.
 */
const RESOURCE_EXIT = 2

const declarationSpans = (() => {
  let stdout
  try {
    stdout = execFileSync(process.execPath, [REPO + '/scripts/closure.mjs', '--declarations'], {
      cwd: REPO, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
    })
  } catch (error) {
    // closure.mjs exits 2 when it cannot load the TypeScript compiler API.
    const status = error.status ?? -1
    console.error(`families: closure --declarations failed (exit ${status}).`)
    console.error('          RESOURCE condition: this package declares no RUNTIME dependencies and CI installs only the declared devDependency (no')
    console.error('          typescript. Without the compiler there are NO spans, and a family table built')
    console.error('          on missing spans is worse than no table (that is how INCIDENT_MARKERS became 1427).')
    console.error('          NOT a pass and NOT a failure — re-run where the compiler is available.')
    process.exit(RESOURCE_EXIT)
  }
  // the banner (compiler version + resolved path) precedes the JSON; the table is the last line
  const json = stdout.trim().split('\n').pop()
  let rows
  try {
    rows = JSON.parse(json)
  } catch {
    console.error('families: closure --declarations did not end with a JSON array.')
    console.error(`          last line began: ${String(json).slice(0, 160)}`)
    process.exit(RESOURCE_EXIT)
  }
  const out = new Map()
  /**
   * ── 只收**本文件**的声明 ────────────────────────────────────────────────────────────────────
   *
   * `--declarations` 给的是整个程序的表（所有 .ts），按文件排序。第一版直接 `byName.set`，
   * 于是 `retrieve.ts` 的 `provenanceOf` 被 `archive.ts` 的同名声明覆盖 —— 跨度变成另一个文件的
   * 4 行，差额报 −33。
   *
   * 这类「静默取到别处的同名项」正是本仓反复踩的坑（`move-gate` 记过 `sleepSync` 的同名歧义、
   * `families` 记过 `name` 的 17 个声明点）。所以这里**按文件过滤**，同名多声明只在**本文件内**
   * 才可能出现，并且那种情况会在下面的 AMBIGUOUS 行里单独列出。
   */
  const wanted = SRC_FILE.replace(/\\/gu, '/')
  for (const row of rows) {
    if (row.file !== wanted) continue
    if (out.has(row.name)) {
      // 同一文件内的同名多声明：不静默取第一个，而是标记出来交给上层
      const prev = out.get(row.name)
      out.set(row.name, { ...prev, duplicate: true })
      continue
    }
    out.set(row.name, row)
  }
  return { rows: rows.filter((row) => row.file === wanted), byName: out }
})()

/** 每个声明的行区间 [start, end]（1-based），**来自编译器**。 */
const spanOf = (name) => {
  const row = declarationSpans.byName.get(name)
  if (row === undefined) return undefined
  return [row.start, row.end]
}


const spans = new Map()
// 跨度对**全部**声明计算（含歧义成员）：自校验需要它，展示只用 liveMembers
for (const m of members) {
  const span = spanOf(m.name, m.kind)
  if (span !== undefined) spans.set(m.name, span)
}

/** owner(line) → 包含该行的最内层声明。 */
const ownerOf = (line) => {
  let best
  for (const [name, [start, end]] of spans) {
    if (line < start || line > end) continue
    if (best === undefined || (end - start) < (spans.get(best)[1] - spans.get(best)[0])) best = name
  }
  return best
}

const memberSet = new Set(liveMembers.map((m) => m.name))
/**
 * ── 根节点不参与连通 ──────────────────────────────────────────────────────────────────────────
 *
 * 闭包是 `buildTape` 的**传递闭包**：它必然引用几乎每一个成员。若把根节点算进连通性，
 * 所有成员都会经由 buildTape 连成一团，得到一个「32 声明 / 1240 行」的假分量 —— 实测过一次。
 *
 * 族划分要回答的是「除了根之外，哪些成员彼此纠缠」，所以根节点被排除在连通之外；
 * 它到每一个族的边被单独记下来，作为「搬迁时根要改几处」的度量。
 */
const ROOT = TARGET
const rootsRefs = new Set()
const edges = new Map(liveMembers.map((m) => [m.name, new Set()]))
const unresolvedRefs = []

/** 边只从**非歧义**成员的 findings 里取；歧义成员已在上面整体移出成员表。 */
for (const name of memberSet) {
  const findings = findingsByMember.get(name) ?? []
  for (const f of findings) {
    /**
     * ── 文件名必须来自 `--src`，不能写死 ────────────────────────────────────────────────────────
     *
     * 这个文件的开头（第 81–84 行）已经记过同一个缺陷：第一版把 `index\.ts` 写死在**成员正则**里，
     * `families.mjs appendLayer`（在 store.ts 里）返回 0 个声明，而 closure 明明报了 225 行。
     *
     * 修了成员正则，**这一行却留了下来**。于是在 `retrieve.ts` 上，所有跨声明的引用行都被丢弃
     * （`f.file` 是 `retrieve.ts`，不等于 `'index.ts'`），图里只剩孤立节点 ——
     * 输出变成 **62 个分量**，而真实值是 19。分量数偏大是「边全丢了」的典型签名：
     * 差额为 0（跨度对），但结构完全错误。
     *
     * 教训：自校验只查了「跨度之和 == 闭包行数」，它抓不到「边丢了」。
     * 一个只验证数字、不验证结构的自校验，会在结构错光的时候照样打绿色。
     */
    if (f.file !== SRC_FILE) continue
    if (f.kind !== 'CODE' && f.kind !== 'TYPE') continue
    const from = ownerOf(f.line)
    if (from === undefined || from === name) continue
    if (!memberSet.has(from)) continue
    if (from === ROOT) { rootsRefs.add(name); continue }
    if (name === ROOT) { rootsRefs.add(from); continue }
    edges.get(from).add(name)
    edges.get(name).add(from) // 无向连通
  }
}

const seen = new Set()
const components = []
for (const name of memberSet) {
  if (seen.has(name)) continue
  const stack = [name]
  const comp = []
  seen.add(name)
  while (stack.length) {
    const cur = stack.pop()
    comp.push(cur)
    for (const next of edges.get(cur) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      stack.push(next)
    }
  }
  components.push(comp)
}

const sizeOf = (name) => {
  const [s, e] = spans.get(name) ?? [0, 0]
  return e - s + 1
}

components.sort((a, b) => {
  const la = a.reduce((s, n) => s + sizeOf(n), 0)
  const lb = b.reduce((s, n) => s + sizeOf(n), 0)
  return lb - la
})

/**
 * ── 自校验的含义（在 observer 上被校准过**三次**，前两次的结论都不完整）────────────────────────
 *
 * **第一版**认为「跨度之和 == 闭包行数」，不等就说明 spanOf 错了。
 *
 * **第二次**：observer 上出现过 `1,876 != 1,877`（差 1）。当时查清了一处真偏差：
 *   `FollowTransferResult` 被数成 5 行，编译器说 4 行 —— 联合的最后一行 `| { … }` 行尾是 `}`，
 *   但它**本身也以 `|` 开头**，旧判据 `!unionMemberLine` 在它上面不成立 ⇒ 跳过 ⇒ 读到紧跟的空行才收尾。
 *   修法：联合成员行只要 depth 归零**且下一行不再以 `|` 开头**就收尾。
 *   修完逐成员跨度之和 = 1,875 == 编译器 1,875（0 差），而闭包总行数是 1,877，差 2。
 *   当时把差 2 解释成「闭包内的非声明行（空行等）」，并把判据放宽成 `跨度之和 <= 闭包总行数`。
 *
 * **这一次（2026-11-13）证明那个解释是错的。** 用 `_scratch/span-audit2.mjs` 逐成员对照编译器，
 * 发现 `closure.mjs` 打印的 kind 里有 `[let/var]`，而成员正则写的是 `\[(\w+)\]` ——
 * **`/` 不是 `\w`**，于是两个模块级 `let` 整条被丢弃，既不入成员表、也不入跨度求和。
 * 差额的实际来源：
 *
 *   · 两个 `let` 各 1 行 ⇒ **+2**（漏算，使和偏小）
 *   · `FollowTransferResult` 旧版多算 1 行 ⇒ **−1**（使和偏大）
 *   · 两个方向相反的缺陷**互相抵消**，差额表现为 1 —— 于是它看起来像"就差点空行"，
 *     实际是两个错误合成的一个数字。**这是最危险的一类：两个 bug 只有单独修才看得见。**
 *
 * 修完两处后：**跨度之和 == 闭包总行数**（observer：1745 == 1745），逐成员与编译器 0 差。
 * 所以判据回到**严格相等**，并且 `> ` 与 `<` 都算缺陷（不再有"正常差额"这一档）。
 *
 * 为什么不再保留 `<=`：一旦允许"少一点也正常"，上面那种"两者互相抵消"就会永远藏得住。
 * 差额必须为 0；如果哪天又不为 0，说明又出现了一个我没找到的行。
 */
const closureLineTotal = Number(/lines\s*:\s*(\d+)/u.exec(report)?.[1])
const spanTotal = members.reduce((s, m) => s + sizeOf(m.name), 0)

const total = spanTotal
const inTable = components.reduce((s, c) => s + c.reduce((q, n) => q + sizeOf(n), 0), 0)
console.log(`\n${components.length} connected component(s), ${inTable} lines in the table (+ ${total - inTable} for the removed ambiguous member = ${total})`)
console.log('行的口径：每个分量的数字是**声明跨度和**（`families.mjs` 自身的 spanOf），')
console.log('          既不是「切除区间」，也不是「`index.ts` 实测净变化」；只用于排序与族大小比较。')
if (spanTotal !== closureLineTotal) {
  console.log(`WARNING: declaration spans total ${spanTotal} != closure total ${closureLineTotal} (difference ${spanTotal - closureLineTotal})`)
  console.log('         spanOf and closure DISAGREE — one of them is counting a line the other is not.')
  console.log('         Do not trust these numbers until the difference is 0. Audit with _scratch/span-audit2.mjs.\n')
} else {
  console.log(`跨度之和 == 闭包总行数（${spanTotal} == ${closureLineTotal}），逐成员与编译器 0 差。\n`)
}
let idx = 0
for (const comp of components) {
  idx += 1
  const sum = comp.reduce((s, n) => s + sizeOf(n), 0)
  console.log(`#${idx}  ${comp.length} decl / ${sum} lines   ${comp.sort((a, b) => sizeOf(b) - sizeOf(a)).join(', ')}`)
}
if (unresolvedRefs.length) console.log(`\nunresolved refs: ${unresolvedRefs.length}`)
