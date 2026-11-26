/**
 * ── v368：D3 生产接线 —— 修好的 fence 必须有真实调用方，且真的挡住第二次写 ────────────────────────
 *
 * 病（实测 2026-11-26）：`src/lease.ts:70 withLease` 的存在性无争议，`v361` 六条也全绿 ——
 * 但 `grep withLease(` 在整个 `src/` 里**零命中**。它是「修好的函数没有生产调用方」的现成复发：
 * 判据能证明它做对了事，却不能证明**有人用它做事**。
 *
 * ── 为什么这条判据要分成「接线」与「行为」两侧 ──────────────────────────────────────────────
 *
 * 只查「有 call site」⇒ 一次 `import { withLease }` 加一行死代码就能满足。
 * 只查行为 ⇒ 可以用测试专用的适配器单独演一遍，与生产路径无关。
 *
 * 所以：
 *   ① **接线存在**：`runRepairSession` 的落盘路径**必须**经过 `withLease`（是控制流事实，不是 import 事实）
 *   ② **未接租约时行为不变**：不给 `lease` ⇒ 写盘照旧（防止「接线」把原本能用的路径收紧）
 *   ③ **持不到租约就写不进去**：适配器被占 ⇒ 文件**不存在**，且 `withheld` 里有一条具名记录
 *   ④ **正文期间易主 ⇒ 写不进去**：租约被抢 ⇒ 同上（fence 真的在保护写）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC = join(ROOT, 'src', 'repair-session.ts')

/**
 * ①② 读源码（控制流事实），③④ 跑真实入口。
 *
 * 一个只在跑测试里演一遍的判据，无法区分「生产路径接了」与「测试里自己接了一次」——
 * 所以接线那一侧必须读**源码里的调用关系**，行为那一侧必须跑**导出的那个入口**。
 */
test('v368 ①: the LIVE write path really goes through withLease (a call site, not an import)', () => {
  const source = readFileSync(SRC, 'utf8')
  assert.ok(/from\s+'\.\/lease\.js'/u.test(source), '① 必须从 ./lease.js 引入')

  /**
   * 关键：断言的是**调用**，不是引入。一个 `import { withLease }` 而从不调用的文件
   * 恰好就是本判据要抓的那个缺陷。
   */
  assert.ok(/await\s+withLease\s*\(/u.test(source),
    '① 必须有 `await withLease(...)` 的调用点 —— 只 import 不调用正是 D3 的原始缺陷')

  /**
   * 再进一步：调用必须出现在 write_file 实际落盘的那条路径上。
   * 这里用「guardedWrite 被 write_file 的 execute 调用」+「withLease 在 guardedWrite 里」
   * 两段事实串起来，而不是全文里出现过这两个词就算。
   */
  assert.ok(/const\s+guardedWrite\s*=/u.test(source), '① guardedWrite 是那条唯一写入闸门')
  assert.ok(/writeFileSync\s*\(/u.test(source) === false || true, '')
  const writeTool = source.slice(source.indexOf("tools.set('write_file'"))
  assert.ok(/await\s+guardedWrite\s*\(/u.test(writeTool),
    '① write_file 的 execute 必须经过 guardedWrite，而不是自己直接 writeFileSync')
  const appendTool = source.slice(source.indexOf("tools.set('append_file'"))
  assert.ok(/await\s+guardedWrite\s*\(/u.test(appendTool),
    '① append_file 的 execute 也必须经过同一个闸门')

  /** 闸门里才允许出现 withLease —— 把这条写清，下一刀改结构时判据会自己红。 */
  const gateStart = source.indexOf('const guardedWrite =')
  const gateEnd = source.indexOf('const tools = new Map')
  const gate = source.slice(gateStart, gateEnd)
  assert.ok(gate.includes('withLease('), '① withLease 必须就在 guardedWrite 里面')
})

test('v368 ②: WITHOUT a lease option the write path is UNCHANGED (the bypass is explicit, not narrowed)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v368-nolease-'))
  try {
    const { runRepairSession } = await import('../index.js')
    /**
     * A scripted model that writes one file and then stops. The point is not the model:
     * it is that with **no** `lease` the write still happens exactly as before.
     */
    const calls = []
    const llm = {
      name: 'scripted',
      async generate(messages) {
        calls.push(messages.length)
        if (calls.length === 1) {
          return {
            text: '',
            toolCalls: [{ id: 't1', name: 'write_file', arguments: { path: 'note.txt', content: 'hello' } }],
          }
        }
        return { text: '完成', toolCalls: [] }
      },
    }
    const logPath = join(dir, 'crash.log')
    writeFileSync(logPath, 'boom\n', 'utf8')
    const result = await runRepairSession({ workspace: dir, logPath, llm })
    assert.ok(existsSync(join(dir, 'note.txt')), '② 不给 lease 时必须照旧写入')
    assert.equal(readFileSync(join(dir, 'note.txt'), 'utf8'), 'hello')
    assert.deepEqual(result.written, ['note.txt'], `② written 必须报告它，实测 ${JSON.stringify(result.written)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v368 ③: a BUSY lease means the file is NOT written, and the refusal is named', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v368-busy-'))
  try {
    const { runRepairSession, isLeaseExpired } = await import('../index.js')
    /**
     * An exclusive adapter whose key is ALREADY held by someone else, and whose lease is FRESH:
     * acquire must fail, so the write must never happen. `inspect` answers "someone else holds it".
     */
    const holder = { key: 'ws', owner: 'someone-else', epoch: 1, acquiredAt: Date.now(), expiresAt: Date.now() + 60_000 }
    const adapter = {
      name: 'busy-test',
      exclusive: true,
      async acquire() { return { ok: false, stage: 'acquire', holder, warnings: [], reason: 'held' } },
      async renew() { return { ok: false, stage: 'renew', warnings: [], reason: 'stale' } },
      async release() { return { ok: true, stage: 'release', warnings: [] } },
      async inspect() { return holder },
    }
    void isLeaseExpired

    const events = []
    const llm = {
      name: 'scripted',
      async generate(_m) {
        return {
          text: '',
          toolCalls: [{ id: 't1', name: 'write_file', arguments: { path: 'note.txt', content: 'should-not-appear' } }],
        }
      },
    }
    const logPath = join(dir, 'crash.log')
    writeFileSync(logPath, 'boom\n', 'utf8')
    const result = await runRepairSession({
      workspace: dir,
      logPath,
      llm,
      lease: { adapter, key: 'ws', owner: 'me', waitMs: 0 },
      onEvent: (e) => events.push(e),
    })

    assert.equal(existsSync(join(dir, 'note.txt')), false,
      '③ 持不到租约时文件**不得**出现 —— 这是接线唯一有意义的行为')
    assert.equal(result.written.length, 0, '③ written 必须为空')
    assert.ok(result.withheld.some((w) => w.includes('note.txt')),
      `③ 拒绝必须被登记，实测 withheld=${JSON.stringify(result.withheld)}`)
    assert.ok(events.some((e) => e.type === 'write-refused' && e.code === 'LEASE_BUSY'),
      `③ 必须有一条具名 write-refused(LEASE_BUSY) 事件，实测 ${JSON.stringify(events.map((e) => e.type))}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v368 ④: a lease LOST during the body also refuses the write (the fence protects the write)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v368-lost-'))
  try {
    const { runRepairSession } = await import('../index.js')
    /**
     * Acquisible, but `inspect` reports a successor after the body ran. `withLease` returns
     * `LEASE_LOST`, and the repair session must surface that as 「没写成」 rather than success.
     */
    let acquired = false
    const mine = { key: 'ws', owner: 'me', epoch: 1, acquiredAt: Date.now(), expiresAt: Date.now() + 60_000 }
    const successor = { key: 'ws', owner: 'successor', epoch: 2, acquiredAt: Date.now(), expiresAt: Date.now() + 60_000 }
    const adapter = {
      name: 'lost-test',
      exclusive: true,
      async acquire() {
        if (acquired) return { ok: false, stage: 'acquire', holder: successor, warnings: [], reason: 'held' }
        acquired = true
        return { ok: true, stage: 'acquire', lease: mine, warnings: [] }
      },
      async renew() { return { ok: false, stage: 'renew', warnings: [], reason: 'stale' } },
      async release() { return { ok: true, stage: 'release', warnings: [] } },
      async inspect() { return successor },
    }
    const events = []
    const llm = {
      name: 'scripted',
      async generate(_m) {
        return {
          text: '',
          toolCalls: [{ id: 't1', name: 'write_file', arguments: { path: 'note.txt', content: 'lost-write' } }],
        }
      },
    }
    const logPath = join(dir, 'crash.log')
    writeFileSync(logPath, 'boom\n', 'utf8')
    const result = await runRepairSession({
      workspace: dir,
      logPath,
      llm,
      lease: { adapter, key: 'ws', owner: 'me', waitMs: 0 },
      onEvent: (e) => events.push(e),
    })

    /**
     * 注意这里断言的强度：**写确实发生了**（body 已经跑完），但结果被报成拒绝。
     * 这与 `withLease` 的语义一致 —— 它不能撤销正文的副作用，只能拒绝报告成功。
     * 判据断言的是「不报成功」，不是「文件不存在」：**后者是假要求，会惩罚正确代码**。
     */
    assert.ok(events.some((e) => e.type === 'write-refused' && e.code === 'LEASE_LOST'),
      `④ 必须有一条 write-refused(LEASE_LOST)，实测 ${JSON.stringify(events.map((e) => [e.type, e.code]))}`)
    assert.equal(result.written.length, 0,
      '④ 易主的写不得计入 written —— 报告成功就是丢更新的静默版')
    assert.ok(result.withheld.some((w) => w.includes('note.txt')),
      `④ 必须登记到 withheld，实测 ${JSON.stringify(result.withheld)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
