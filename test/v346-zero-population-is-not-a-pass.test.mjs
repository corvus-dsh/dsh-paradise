/**
 * ── v346：零人口不得 `exit 0`（lead §五十三.3 ②）─────────────────────────────────────────────────
 *
 * 实测（注入一个**存在的空目录**）：
 *
 *   check-cycles   `nodes: 0  edges: 0` + 「ACYCLIC」                      → exit 0 ✗
 *   closure        `calibration samples: … NOT FOUND ×3`                  → exit 0 ✗
 *   who-references `declarations: 0 · references: 0 (files: none)`        → exit 0 ✗
 *   move-gate      `NOT FOUND in src/ — cannot measure what it cannot locate` → exit 1 ✓
 *
 * 前三个把「我什么都没量到」报成了通过。而 `closure` 那三行 `NOT FOUND` **在本仓是合法输出**
 * （每仓 `SAMPLES` 各不相同，函数改名后就该 NOT FOUND）——**「被指向空树」与「本仓样本改名了」
 * 在旧输出上无法区分**（§〇 34）。
 *
 * 正确形态本仓已有两处，不需要发明：`verify-pure-move` 的 `VACUOUS / exit 2`。
 *
 * **为什么三个一起测**：它们犯的是同一个错，修一处会在另一处复发（§四十六）。
 *
 * 判据（每个工具三条）：
 *
 *   ① 空目录 ⇒ `exit 2` + `VACUOUS` + 「NOT a pass」
 *   ② 不存在的路径 ⇒ `exit 1` 并点名变量（不是一条 `ENOENT … scandir` 裸栈）
 *   ③ **合法树仍 `exit 0` 且不出现 `VACUOUS`** —— 防的是这些守卫退化成「永远红」
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const TOOLS = [
  { label: 'check-cycles', script: 'check-cycles.mjs', variable: 'GRAFT_CHECK_CYCLES_SRC', args: [] },
  { label: 'who-references', script: 'who-references.mjs', variable: 'GRAFT_WHO_REFS_SRC', args: ['v346ProbeSymbol'] },
  { label: 'closure', script: 'closure.mjs', variable: 'GRAFT_CLOSURE_SRC', args: [] },
]

const runTool = (tool, injected) => {
  const env = { ...process.env }
  if (injected === undefined) delete env[tool.variable]
  else env[tool.variable] = injected
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', tool.script), ...tool.args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  return { code: result.status ?? 1, stdout, stderr, out: `${stdout}${stderr}` }
}

for (const tool of TOOLS) {
  test(`v346 ${tool.label} ①: an EMPTY tree is VACUOUS and exits 2, never 0`, () => {
    const empty = mkdtempSync(join(tmpdir(), `v346-empty-${tool.script}-`))
    try {
      const { code, out } = runTool(tool, empty)
      assert.equal(code, 2, `${tool.label}: zero source files must exit 2 (a resource condition, never a pass), got ${code}:\n${out}`)
      assert.match(out, /VACUOUS/u, `${tool.label}: the output must say VACUOUS so nobody reads it as a pass:\n${out}`)
      assert.match(out, /NOT a pass/u, `${tool.label}: the output must say this is not a pass:\n${out}`)
      /**
       * The old verdicts are the thing being removed — a green word next to VACUOUS would still be
       * quotable by the next reader.
       */
      assert.doesNotMatch(out, /ACYCLIC|IDENTICAL/u, `${tool.label}: a vacuous run must not print a green verdict:\n${out}`)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  test(`v346 ${tool.label} ②: a NONEXISTENT injected path is refused BY NAME`, () => {
    const missing = join(tmpdir(), `v346-missing-${tool.script}-${process.pid}-${Date.now()}`)
    const { code, out } = runTool(tool, missing)
    assert.equal(code, 1, `${tool.label}: a nonexistent injected directory must exit 1, got ${code}:\n${out}`)
    assert.match(out, new RegExp(tool.variable, 'u'), `${tool.label}: the refusal must name ${tool.variable}:\n${out}`)
    assert.match(out, /is not an existing directory/u, `${tool.label}: the refusal must say what is wrong:\n${out}`)
  })

  test(`v346 ${tool.label} ③: a REAL tree still exits 0 and never says VACUOUS`, () => {
    /**
     * The guard must not degenerate into a permanent red. This is the half that makes ① mean
     * something: a tool that always exits 2 would satisfy ① and be useless.
     */
    const { code, out } = runTool(tool, undefined)
    assert.equal(code, 0, `${tool.label}: the real repository must still exit 0, got ${code}:\n${out.slice(-2000)}`)
    assert.doesNotMatch(out, /VACUOUS/u, `${tool.label}: the real repository is NOT vacuous:\n${out.slice(-2000)}`)
  })
}
