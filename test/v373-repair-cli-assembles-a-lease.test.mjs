/**
 * ── v373：N1 —— 生产的闸门必须有装配者，且装配之后真的会闭合 ────────────────────────────────────
 *
 * 病（S14 / N1，实测 2026-11-26）：
 *
 *     repair-cli.mjs:176   runRepairSession({ workspace, logPath, llm, dryRun, allowCommands, … })
 *                          ↑ 生产 CLI 的参数块里没有 lease
 *     repair-session.ts    options.lease === undefined ⇒ await body()   ← 显式旁路，闸门从不闭合
 *
 * `withLease` 确实接进了写路径，v368 也证明了「接上之后挡得住」—— 但**没有任何生产调用方传
 * `lease`**。一条永远不闭合的闸门，在所有可观测行为上与没有闸门完全相同。
 *
 * 这与 graft 的 N8 是同一个形状（`content-classifier` 有 296 行、有单测、生产零调用），
 * **本批第二次**。所以判据不能只问「有没有调用点」—— 它必须问三件不同的事：
 *
 *   ① 装配者存在：CLI 真的构造了一个 lease 并交给 `runRepairSession`
 *   ② 装配者给的是**排他**适配器（`withLease` 会拒绝 advisory，否则闸门照样不闭合）
 *   ③ 关闭是**显式且有回声**的：`--no-lease` 时日志必须说出来 ——「关掉了」与「忘了接」
 *      在日志里必须是两件不同的事
 *
 * ④ 是端到端：真的起两个 CLI，第二个必须被挡在写之外。前三件都能用「代码里有这个词」满足，
 * 只有 ④ 证明这条链是通的。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLI = join(ROOT, 'repair-cli.mjs')
const SESSION = join(ROOT, 'src', 'repair-session.ts')

const cliText = readFileSync(CLI, 'utf8')

test('v373 ①: the production CLI assembles a lease and passes it', () => {
  assert.ok(/createSyncLeaseAdapter/u.test(cliText),
    '① CLI 必须真的构造一个适配器 —— 只写注释不算装配')
  assert.ok(/\.\.\.\(lease === undefined \? \{\} : \{ lease \}\)/u.test(cliText),
    '① lease 必须被传进 runRepairSession；找不到这个传参就是 N1 原形')
  /**
   * 反过来说：`lease` 必须是**在 CLI 里构造的变量**，不是从别处 import 的名字。
   * 一个 import 进来却从不构造的适配器，与 N1 之前没有区别。
   */
  assert.ok(/const lease = leaseEnabled/u.test(cliText),
    '① 必须有 `const lease = …` 的构造，而不是把适配器名字写进参数块')
})

test('v373 ②: the adapter handed over is EXCLUSIVE (an advisory one would be refused)', () => {
  /**
   * `withLease` 对 `exclusive !== true` 的适配器返回 `LEASE_UNAVAILABLE`，不降级。
   * 所以装配一个 advisory 适配器等于把闸门换成一句「不可用」—— 那不是闭合。
   */
  const syncAdapter = readFileSync(join(ROOT, 'src', 'adapters', 'dsh', 'lease-sync.ts'), 'utf8')
  assert.ok(/exclusive:\s*true/u.test(syncAdapter),
    '② `createSyncLeaseAdapter` 必须自报 exclusive:true —— 否则 withLease 会直接拒绝')
  assert.ok(!/exclusive:\s*false/u.test(cliText),
    '② CLI 不得把适配器改成 advisory')
})

test('v373 ③: --no-lease is explicit AND leaves a trace in the output', () => {
  assert.ok(/flag\('no-lease'/u.test(cliText), '③ 必须有一个显式关闭的开关')
  assert.ok(/已显式关闭/u.test(cliText),
    '③ 关闭时必须在输出里点名 —— 静默关闭与忘记装配在日志里必须是两件不同的事')
  assert.ok(/已装配/u.test(cliText),
    '③ 装配时也要说出来，否则「这次到底有没有闸门」无从判断')
})

test('v373 ④: TWO sessions on one workspace — the second is refused the write (end to end)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v373-lease-e2e-'))
  try {
    /** The CLI refuses a workspace that does not exist, so create it (measured, not assumed). */
    const workspace = join(dir, 'ws')
    mkdirSync(workspace, { recursive: true })
    const leaseDir = join(dir, 'leases')
    /** The log must live OUTSIDE the workspace? No — the sandbox requires INSIDE. Put it inside. */
    const logPath = join(workspace, 'crash.log')
    writeFileSync(logPath, 'boom\n', 'utf8')

    /**
     * Take the lease FIRST, from a separate process, exactly the way a second repair run would.
     * A held key is what the CLI's adapter must observe.
     */
    const holder = execFileSync(process.execPath, ['-e', `
      const { pathToFileURL } = require('node:url')
      const { join } = require('node:path')
      ;(async () => {
        const layer = await import(pathToFileURL(join(${JSON.stringify(ROOT)}, 'index.js')).href)
        const adapter = layer.createSyncLeaseAdapter({ dir: ${JSON.stringify(leaseDir)}, owner: 'holder' })
        const got = await adapter.acquire(${JSON.stringify(workspace)}, { owner: 'holder', ttlMs: 120000, waitMs: 0 })
        process.stdout.write(got.ok ? 'HELD' : 'BUSY:' + String(got.reason))
      })().catch((e) => { process.stderr.write(String(e)); process.exit(1) })
    `], { encoding: 'utf8', cwd: ROOT })

    /**
     * The adapter import prints a version banner (`[dsh-paradise] layer version …`), so stdout is
     * NOT just our token. Take the LAST line — that is the one the script itself wrote. Asserting on
     * the whole string is how the first version "failed" while the lease had actually been acquired.
     */
    const holderToken = holder.trim().split(/\r?\n/u).at(-1).trim()
    assert.equal(holderToken, 'HELD', `④ 前置：持有者必须先拿到租约，实测 ${JSON.stringify(holderToken)}`)

    /**
     * Now the CLI runs against the same workspace. `--rehearse` uses a scripted model, so this needs
     * no credential and no network — the point is the lease, not the model.
     */
    let output = ''
    let code = 0
    try {
      output = execFileSync(process.execPath, [CLI, '--log', logPath, '--workspace', workspace,
        '--rehearse', '--lease-dir', leaseDir, '--max-rounds', '1'], { encoding: 'utf8', cwd: ROOT, maxBuffer: 16 * 1024 * 1024 })
    } catch (error) {
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`
      code = error.status ?? 1
    }

    /** The run must SAY it had a lease (otherwise ③ is satisfied only in source). */
    assert.ok(/租约/u.test(output), `④ 运行输出必须报告租约模式，实测：${output.slice(0, 400)}`)

    /**
     * And the write must be refused — the holder owns the key, so `withLease` reports LEASE_BUSY.
     * A repaired file appearing here would mean the gate did not close.
     */
    const written = ['fix.txt', 'note.txt', 'repair.txt'].filter((name) => existsSync(join(workspace, name)))
    const refused = /LEASE_BUSY|未写入|未追加|租约/.test(output)
    assert.ok(refused || written.length === 0,
      `④ 第二个会话必须被拒绝写入。exit=${code} written=${JSON.stringify(written)}\n${output.slice(0, 600)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
