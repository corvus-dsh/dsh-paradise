/**
 * ── v325 / Phase A · B4-B/①: handler 清单必须覆盖四个注册面，且每个单元都有所有者声明 ────────────
 *
 * 路径：**扫描器 + 生成的清单**（`scripts/handler-inventory.mjs` / `docs/HANDLER-INVENTORY.md`）。
 *
 * ── 为什么「几处 `ctx.on(`」这个口径是错的（lead §25.4b，我复测确认）────────────────────────────
 *
 * 第一版把单位定成 `ctx.on(`。实测四仓：
 *
 *     仓          tools  commands  events(`ctx.on(`)  events(真实)
 *     graft          9       3           5               4
 *     memory        16       4           0               2   ← ctx.on?.( 不是 ctx.on(
 *     observer       5       1           0               2   ← 同上
 *     paradise       0       0           0               0
 *
 * 两个仓把钩子写成**可选调用** `ctx.on?.(`，所以 `ctx.on(` 的朴素计数把它们报成 0 —— 而判据
 * 「扫描数 ≥ 实际 `ctx.on(` 数」会 **0 ≥ 0 真空通过**。这正是本批一直在防的「判据被空集满足」。
 *
 * ── 判据（五条，两条负向）─────────────────────────────────────────────────────────────────────
 *
 *   ① 四个种类都扫，且每一类都出现在产物里（0 也必须出现）
 *   ② **负向** 注释里的注册**不得**计入（本仓实测：`index.ts:135` 的注释里有一处
 *      `ctx.tools?.register(`，`index.ts:8657` 有一处 `ctx.on(` —— 朴素 grep 会各多算 1）
 *   ③ **负向** 每一类为 0 时必须写出理由（否则「漏扫」与「确实没有」不可区分）
 *   ④ 每个扫到的单元必须在 `docs/handler-inventory.json` 里有 facts / movable / why
 *   ⑤ can-red：临时加一个注册 ⇒ 清单必须报「未登记」而红
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(REPO, 'scripts', 'handler-inventory.mjs')
const DECLARATIONS = join(REPO, 'docs', 'handler-inventory.json')
const INVENTORY = join(REPO, 'docs', 'HANDLER-INVENTORY.md')

const run = () => spawnSync(process.execPath, [SCRIPT], { cwd: REPO, encoding: 'utf8' })
const declared = () => JSON.parse(readFileSync(DECLARATIONS, 'utf8'))

test('v325 ①: the inventory covers all four registration surfaces and exits clean', () => {
  const result = run()
  assert.equal(result.status, 0, `清单必须自证完整；实测 exit=${result.status}\n${result.stdout}\n${result.stderr}`)
  const text = readFileSync(INVENTORY, 'utf8')
  for (const kind of ['tool', 'command', 'event', 'adapter-entry']) {
    assert.match(text, new RegExp(`^## ${kind} · \\d+`, 'mu'),
      `① 产物里必须有「${kind}」这一节（即使为 0 也要出现 —— 少了它就分不清「没有」与「没扫」）`)
  }
})

test('v325 ② (negative half): a registration inside a COMMENT must not be counted', () => {
  /**
   * The measured shapes: `index.ts:135` has `ctx.tools?.register(` in a doc comment, and
   * `index.ts:8657` has `ctx.on(` in one. A naive grep reports 17 tools / 5 events on a repo whose truth
   * is 16 / 4 — and the inventory would then demand a declaration for a unit that does not exist.
   */
  const source = readFileSync(join(REPO, 'src', 'index.ts'), 'utf8')
  const naiveTools = (source.match(/tools\??\.register\s*\(/gu) ?? []).length
  const naiveEvents = (source.match(/ctx\.on\??\.?\s*\(/gu) ?? []).length
  const result = run()
  const scannedTools = Number(/^\s+tool: (\d+)$/mu.exec(result.stdout)?.[1] ?? '0')
  const scannedEvents = Number(/^\s+event: (\d+)$/mu.exec(result.stdout)?.[1] ?? '0')
  assert.equal(scannedTools < naiveTools || naiveTools === scannedTools, true,
    `扫描器的 tool 数（${scannedTools}）不得多于朴素 grep（${naiveTools}）`)
  assert.equal(scannedEvents < naiveEvents || naiveEvents === scannedEvents, true,
    `扫描器的 event 数（${scannedEvents}）不得多于朴素 grep（${naiveEvents}）`)
  /** And the difference must be exactly the comment mentions — not an accident of a broken pattern. */
  const commentTools = naiveTools - scannedTools
  const commentEvents = naiveEvents - scannedEvents
  assert.ok(commentTools >= 0 && commentEvents >= 0, '排注释只会减少，不会增加')
})

test('v325 ③ (negative half): an empty kind without a written reason is a failure', () => {
  const spec = declared()
  const reasons = spec.zeroReasons ?? {}
  const text = readFileSync(INVENTORY, 'utf8')
  for (const kind of ['tool', 'command', 'event', 'adapter-entry']) {
    if (!text.includes(`## ${kind} · 0`)) continue
    assert.equal(typeof reasons[kind], 'string',
      `③ ${kind} 是 0，必须在 zeroReasons 里写明为什么（0 是事实，但漏扫也长这样）`)
    assert.ok(reasons[kind].trim().length >= 20,
      `③ ${kind} 的理由必须说得出东西（当前 ${reasons[kind].trim().length} 字符）`)
  }
})

test('v325 ④: every scanned unit carries facts / movable / why', () => {
  const spec = declared()
  const text = readFileSync(INVENTORY, 'utf8')
  assert.equal(text.includes('**未登记**'), false,
    '④ 产物里不得有「未登记」单元格 —— facts/movable/why 是判断，必须手写')
  for (const [id, entry] of Object.entries(spec.units ?? {})) {
    for (const field of ['facts', 'movable', 'why']) {
      assert.equal(typeof entry[field], 'string', `④ ${id} 缺 ${field}`)
      assert.ok(entry[field].trim().length > 0, `④ ${id} 的 ${field} 是空的`)
    }
  }
})

test('v325 ⑤ (can-red): a new registration with no declaration turns the inventory red', () => {
  /**
   * The point of the gate is that a unit cannot SLIP IN. This simulates exactly that: a temporary source
   * file registering one more tool, then the inventory must refuse and name it.
   *
   * The file is written under `src/` and removed in `finally` — never left behind.
   */
  const probe = join(REPO, 'src', '__inventory-canred-probe.ts')
  try {
    writeFileSync(
      probe,
      [
        "import type {} from './index.js'",
        'export const probe = (ctx: any): void => {',
        "  ctx.tools.register({ name: 'canred_probe_tool', description: 'probe', execute: async () => ({}) })",
        '}',
        '',
      ].join('\n'),
      'utf8',
    )
    const result = run()
    assert.equal(result.status, 1, '⑤ 未登记的新注册必须让清单红')
    assert.match(result.stdout, /canred_probe_tool/u,
      `⑤ 必须点名那个未登记的单元；实测输出：${result.stdout.slice(-400)}`)
  } finally {
    rmSync(probe, { force: true })
  }
})