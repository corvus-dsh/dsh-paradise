/**
 * ── v220：`.github/workflows/*.yml` 必须过 YAML 的 plain-scalar 判据 ───────────────────────────────
 *
 * ── 为什么需要这条（真实事故，2026-11-17）───────────────────────────────────────────────────────
 *
 * dsh-memory 推了 6 个提交，CI 立刻红了 —— 但**一个 job 都没有**：
 *
 *   run 44002473416   conclusion=failure   jobs=0   check_runs=0
 *   GitHub 上该 workflow 的 name 回落成了文件路径 `.github/workflows/ci.yml`（正常是 `CI`）
 *
 * 原因是一行新增的步骤名里有一个 `: `（冒号+空格）：
 *
 *   - name: Incremental type budget (RESOURCE-aware: no compiler on the runner)
 *
 * YAML 规定 plain scalar 不得包含 `: ` —— 它会被当作 mapping 指示符，**整个 workflow 解析失败**。
 * 同型的第二处：`dsh-paradise/.github/workflows/ci.yml` 的 `Gates (new: cycles / ...)`。
 *
 * ── 这一条最毒的地方不是「语法错」，而是「错得安静」──────────────────────────────────────────────
 *
 *   · `npm run check` 全绿 —— 四仓的 check 都从不解析 `.github/workflows/`；
 *   · CI 确实红了，但**没有 job 日志可读**：没有失败步骤名、没有 error 行，只有 0 个 job；
 *   · 于是「门禁到底装上了没有」，本地与 CI 双双给不出答案。
 *
 * 本仓已有的门禁（cycles / type-budget / readme-counts / v205…v219）全部依赖「CI 跑得起来」；
 * 这一行让它们一条都没跑。**门禁的安装动作本身破坏了门禁。**
 *
 * ── 判据（三条，都是零误报的形状）────────────────────────────────────────────────────────────────
 *
 * 只扫**结构行**（跳过块标量正文），且**先剥掉引号内的文本**，然后在行里查：
 *
 *   1. `: `（冒号+空格）—— mapping 指示符 ⇒ 解析失败；
 *   2. ` #`（空格+井号）—— 注释起始 ⇒ 值被**悄悄截断**（写得像个值，其实被丢掉）；
 *   3. tab 缩进 —— YAML 禁止用 tab 缩进（tab 只允许出现在块标量正文里，那里我们不看）。
 *
 * ── 为什么必须「剥引号」+「跳过块标量」───────────────────────────────────────────────────────────
 *
 * 修好的那一行**本身仍然含 `: `**，只是它在引号里：
 *
 *   - name: "Incremental type budget (RESOURCE-aware: no compiler on the runner)"
 *
 * 而 `run: |` 的正文是 **shell 代码**，里面天然有大量 `: ` 与 ` #`（`echo '| metric | count |'`、
 * `grep -E '...# '`、shell 注释）。一条不做这两件事的扫描器，要么**放过修复前的那一行**，
 * 要么**把一大片 shell 全报红** —— 两种都会让人把判据关掉，而关掉的判据等于没有。
 *
 * 同一个道理用于本文件的 ⑥：引号里的 `: `/` #`、块标量正文里的 `: `/` #` 都**不许报**。
 *
 * ── 为什么放 test/ 而不是 scripts/ ──────────────────────────────────────────────────────────────
 *
 * `scripts/*.mjs` 在 graft 侧被 `v129` 要求逐个分类（GATE/TOOL/…）；放 `test/` 不必再动那张表。
 * 本文件**零依赖**（只用 node: 内置）⇒ 在 CI 上真跑，不是 TD-M15 里那 13 条之一。
 *
 * 四仓逐字节相同（与 `run-gate.mjs` 同一个理由：一条判据，四仓一个实现）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const WORKFLOW_DIR = join(REPO, '.github', 'workflows')

/**
 * 仓里的全部 workflow 文件（`.yml` / `.yaml`）。
 *
 * **不是只扫 `ci.yml`**：`publish.yml` 今天是干净的，但下一个人会往它里面加东西 ——
 * 一条只认 `ci.yml` 的判据会在那天安静地放过。目录不存在时返回空数组，由 ② 负责报红
 * （空集恒绿是这类扫描器最常见的死法）。
 */
export const workflowFiles = () => {
  if (!existsSync(WORKFLOW_DIR)) return []
  return readdirSync(WORKFLOW_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.ya?ml$/u.test(e.name))
    .map((e) => ({ abs: join(WORKFLOW_DIR, e.name), rel: `.github/workflows/${e.name}` }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

/**
 * 剥掉单/双引号内的文本：引号里的 `: ` 与 ` #` 是**合法内容**，不是陷阱。
 * （只做这一层剥壳就够了 —— 我们不是在写 YAML 解析器，是在抓「没加引号」这一类形状。）
 */
export const stripQuoted = (s) =>
  s.replace(/"(?:[^"\\]|\\.)*"/gu, '""').replace(/'[^']*'/gu, "''")

const PAD = /^[ \t]*/u
const BLOCK_SCALAR = /^[|>][+-]?\d*$/u

/**
 * 扫一份 workflow 文本，返回 `{ violations, checked }`。
 *
 * `checked` 是**防「空转恒绿」的计数器**：如果块标量状态机写坏了、整份文件都被当成标量正文，
 * `checked` 会掉到 0 —— 测试 ② 会红。扫描器最危险的失败方式不是误报，是**静悄悄地什么都不看**。
 */
export const scanWorkflowText = (text) => {
  const violations = []
  let checked = 0
  let blockIndent = -1
  const lines = text.replace(/\r\n/gu, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const pad = (line.match(PAD) ?? [''])[0]
    if (blockIndent >= 0) {
      // 块标量正文：空行仍在正文内；缩进比键更深仍是正文；缩进退回来 ⇒ 正文结束
      if (line.trim() === '' || pad.length > blockIndent) continue
      blockIndent = -1
    }
    if (line.trim() === '') continue
    if (pad.includes('\t')) {
      violations.push({ line: i + 1, what: 'tab-indent', detail: 'tab 缩进（YAML 只允许空格缩进）', text: line })
      continue
    }
    const body = line.slice(pad.length)
    if (body.startsWith('#')) continue // 整行注释
    checked += 1
    const bare = stripQuoted(body)
    if (bare.includes(' #')) {
      violations.push({
        line: i + 1,
        what: 'inline-comment',
        detail: '行里的 ` #` 会把后面的内容变成注释 —— 写上去的值被悄悄丢掉（要它当内容就必须加引号）',
        text: line,
      })
    }
    const sep = bare.search(/:(?=\s|$)/u)
    if (sep >= 0) {
      const value = bare.slice(sep + 1).trim()
      if (value.includes(': ')) {
        violations.push({
          line: i + 1,
          what: 'colon-space',
          detail: 'plain scalar 里的 `: `（冒号+空格）被当作 mapping 指示符 ⇒ 整个 workflow 解析失败（run 创建了，但 0 个 job）',
          text: line,
        })
      }
      if (BLOCK_SCALAR.test(value)) blockIndent = pad.length
    }
  }
  return { violations, checked }
}

const readWorkflows = () =>
  workflowFiles().map((f) => ({ ...f, report: scanWorkflowText(readFileSync(f.abs, 'utf8')) }))

// ── 测试 ───────────────────────────────────────────────────────────────────────────────────────

test('v220 ①: .github/workflows/ 下每个 workflow 都过了 plain-scalar 判据', () => {
  const files = workflowFiles()
  const bad = []
  for (const f of files) {
    for (const v of scanWorkflowText(readFileSync(f.abs, 'utf8')).violations) {
      bad.push(`${f.rel}:${v.line}  [${v.what}]  ${v.detail}\n        ${v.text.trim()}`)
    }
  }
  assert.deepEqual(bad, [],
    '这些 workflow 行会让**整个 workflow 解析失败**（或把值悄悄截断）——'
    + '症状是 run 被创建但产出 0 个 job，所有门禁一条都不跑，本地却全绿。\n'
    + '处方：`name:` / `run:` 的值里凡有 `: ` 或 ` #`，加引号（**不要**为了绕过解析器去删字符 ——'
    + '那是让内容迁就工具）：\n  ' + bad.join('\n  '))
})

test('v220 ②: 扫描器不是空转（文件数 / ci.yml / 被检查的结构行数都必须 > 0）', () => {
  const files = workflowFiles()
  assert.ok(files.length > 0, '.github/workflows/ 下一个 .yml 都没扫到 —— 路径可能写错了')
  assert.ok(files.some((f) => f.rel.endsWith('/ci.yml')), '扫描结果里没有 ci.yml —— 路径可能写错了')
  const checked = readWorkflows().reduce((n, f) => n + f.report.checked, 0)
  assert.ok(checked > 50,
    `只检查了 ${checked} 行结构行 —— 块标量状态机可能把整份文件当成了标量正文，那会让本判据恒绿`)
})

test('v220 ③ can-red: 值里的 `: ` 必须被点名', () => {
  const r = scanWorkflowText('jobs:\n  x:\n    steps:\n      - name: probe (a: b)\n        run: echo hi\n')
  assert.deepEqual(r.violations.map((v) => v.what), ['colon-space'])
  assert.equal(r.violations[0].line, 4, '行号要指向真实的那一行')
})

test('v220 ④ can-red: 值里的 ` #` 必须被点名（值被悄悄截断）', () => {
  const r = scanWorkflowText('jobs:\n  x:\n    runs-on: ubuntu-latest # 我以为是值的一部分\n')
  assert.deepEqual(r.violations.map((v) => v.what), ['inline-comment'])
  assert.equal(r.violations[0].line, 3)
})

test('v220 ⑤ can-red: tab 缩进必须被点名', () => {
  const r = scanWorkflowText('jobs:\n\tx: 1\n')
  assert.deepEqual(r.violations.map((v) => v.what), ['tab-indent'])
})

test('v220 ⑥ can-red: 引号内的 `: `/` #`、块标量正文里的 shell 文本 —— 一律不许报', () => {
  const clean = [
    'name: CI',
    'on:',
    '  push:',
    '    branches: [main, master]',
    'jobs:',
    '  build:',
    '    steps:',
    '      - name: "带 (a: b) 与 # 的值"', // 引号里都是合法内容
    '        run: |',
    '          # 块标量正文：这是 shell 注释，不是 YAML 注释',
    '          echo "ratio: 1 # 2"', // 正文里的 `: ` 与 ` #` 是文本
    '        shell: bash',
    '',
  ].join('\n')
  const r = scanWorkflowText(clean)
  assert.deepEqual(r.violations, [], '合法写法被误报了 —— 误报会让人把判据关掉')
  assert.ok(r.checked >= 8, `只检查了 ${r.checked} 行结构行 —— 块标量正文没被正确跳过（或跳过了太多）`)
})
