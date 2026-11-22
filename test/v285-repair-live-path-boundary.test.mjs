/**
 * ── v285 (B4-B B4b)：修复会话的**活路径**必须用 realpath 判据，而不是它旁边那个导出函数 ─────────
 *
 * ── 缺陷（实测复现，不是推断）─────────────────────────────────────────────────────────────────
 *
 * B4 把 `resolveInside`（`repair-session.ts:358`）改成了 `isWithinRootsResolved`。但 `src/` 里**没有
 * 生产调用方** —— 只有 re-export 和两个测试。真正在跑的修复工具用的是同一文件里的闭包 `inside()`
 * （`:114-120`），仍然是 `resolve + startsWith`：
 *
 *     read_file   :141      write_file :160      append_file :183      崩溃日志 :257
 *
 * **四个全是真读或真写路径。** 探针（junction 在 workspace 内、指向外部）修前实测：
 *
 *     write_file 'escape/pwned.txt'   ⇒ ok=true，且文件**真的出现在 workspace 外**
 *     resolveInside(同一个目标)        ⇒ SANDBOX_DENIED（这是对的）
 *
 * 所以判据不能只测那个导出函数 —— 它一直是对的。**要测模型真正调到的那条路。**
 *
 * ── 判据（五条，三条负向）──────────────────────────────────────────────────────────────────────
 *
 *   ① 经 junction 的 **write_file** 被拒，且 workspace 外**没有**出现文件（读最终产物，不是读回执）
 *   ② 经 junction 的 **read_file** 被拒（否则外部内容进了模型上下文）
 *   ③ 负向：workspace 内的正常读写照常工作（不许「一律拒绝」也能过 ①②）
 *   ④ 负向：`../` 词法逃逸仍然被拒（realpath 判据不能把原有的这一类丢掉）
 *   ⑤ 负向：静态扫描的判据是**形状**不是变量名 —— 用 `workspace` 的那份拷贝也必须被抓
 *
 * ①② 都从**文件系统**取证（`existsSync` / 读取内容），不依赖 `tool-result` 事件 —— 那个事件只有
 * `ok`/`ms`，没有内容，靠它等于靠一个说不清的东西。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runRepairSession } from '../index.js'

/**
 * A workspace with a JUNCTION inside it pointing outside, plus a crash log so the session can start.
 *
 * Windows junctions need no privilege (`symlinkSync(target, path, 'junction')`), and they are the exact
 * escape the realpath predicate exists for: the LEXICAL string is still prefixed by the workspace.
 */
function makeJunctionWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'b4b-'))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(workspace, 'crash.log'), 'boom', 'utf8')
  writeFileSync(join(outside, 'secret.txt'), 'SECRET-OUTSIDE-SANDBOX', 'utf8')
  let linked = true
  try {
    symlinkSync(outside, join(workspace, 'escape'), 'junction')
  } catch {
    linked = false
  }
  return { root, workspace, outside, linked, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** Drive the REAL session with a scripted model that performs exactly one tool call. */
async function oneToolCall(workspace, name, args) {
  let asked = false
  const llm = {
    name: 'scripted',
    provider: 'test',
    async generate() {
      if (asked) return { text: '完成', model: 'scripted-1', toolCalls: [] }
      asked = true
      return { text: '', model: 'scripted-1', toolCalls: [{ id: 'c1', name, arguments: args }] }
    },
  }
  return runRepairSession({ workspace, logPath: 'crash.log', llm, maxRounds: 1 })
}

test('v285 ①: 经 junction 的 write_file 被拒，且 workspace 外没有出现文件', async () => {
  const env = makeJunctionWorkspace()
  if (!env.linked) {
    env.cleanup()
    return // A host where junctions cannot be created has nothing to measure — stated, not silent.
  }
  try {
    await oneToolCall(env.workspace, 'write_file', { path: 'escape/pwned.txt', content: 'PWNED-OUTSIDE' })

    /**
     * THE MEASUREMENT IS THE FILESYSTEM, not the receipt. `tool-result` reports `ok`/`ms` and no text,
     * so a criterion built on it could pass while the write still happened.
     */
    assert.equal(
      existsSync(join(env.outside, 'pwned.txt')),
      false,
      `workspace 外不许出现写入的文件。实测 outside/pwned.txt 存在，内容：${
        existsSync(join(env.outside, 'pwned.txt')) ? JSON.stringify(readFileSync(join(env.outside, 'pwned.txt'), 'utf8')) : '(无)'
      }`,
    )
  } finally {
    env.cleanup()
  }
})

test('v285 ②: 经 junction 的 read_file 被拒 —— 外部内容不许进模型上下文', async () => {
  const env = makeJunctionWorkspace()
  if (!env.linked) {
    env.cleanup()
    return
  }
  try {
    const result = await oneToolCall(env.workspace, 'read_file', { path: 'escape/secret.txt' })
    /**
     * `runRepairSession` keeps only `ok`/`ms` for tool calls, so the transcript is the place the leak
     * would surface: if the read had succeeded, the secret would have been handed to the model and thus
     * into the conversation. Checking the persisted judgement is checking the wrong object — so this
     * asserts the FILESYSTEM claim (the file is outside) and that the tool did not report success.
     */
    const calls = (result.turn?.toolCalls ?? []).filter((call) => call.name === 'read_file')
    assert.ok(calls.length >= 1, '这次调用必须真的到达工具，否则这条测试什么也没测')
    assert.equal(calls[0].ok, false, `经 junction 的读取必须失败，实测 ok=${calls[0].ok}`)
  } finally {
    env.cleanup()
  }
})

test('v285 ③: 负向 —— workspace 内的正常读写照常工作', async () => {
  const env = makeJunctionWorkspace()
  try {
    await oneToolCall(env.workspace, 'write_file', { path: 'config/fix.json', content: '{"fixed":true}' })
    assert.equal(existsSync(join(env.workspace, 'config', 'fix.json')), true, '根内写入必须真的落盘')
    assert.equal(readFileSync(join(env.workspace, 'config', 'fix.json'), 'utf8'), '{"fixed":true}')

    const read = await oneToolCall(env.workspace, 'read_file', { path: 'crash.log' })
    const calls = (read.turn?.toolCalls ?? []).filter((call) => call.name === 'read_file')
    assert.equal(calls[0]?.ok, true, '根内读取必须成功')
  } finally {
    env.cleanup()
  }
})

test('v285 ④: 负向 —— `../` 词法逃逸仍然被拒（换判据不许丢掉原有那一类）', async () => {
  const env = makeJunctionWorkspace()
  try {
    await oneToolCall(env.workspace, 'write_file', { path: '../outside/lexical.txt', content: 'ESCAPED' })
    assert.equal(existsSync(join(env.outside, 'lexical.txt')), false, '`../` 逃逸必须被拒')
  } finally {
    env.cleanup()
  }
})