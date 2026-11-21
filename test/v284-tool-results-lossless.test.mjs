/**
 * ── v284 (B4-B B0b)：paradise 的每条宿主校验 seam 都必须返回**无损 JSON** ────────────────────────
 *
 * ── 这条门禁的来历 ───────────────────────────────────────────────────────────────────────────────
 *
 * graft 的 `graft_prepare` 曾返回一个**自有 `undefined` 键**：`JSON.stringify` 丢掉它，所以本地检查
 * 全绿；宿主校验的是**无损 JSON**，`undefined` 不可无损表示 ⇒ 整个返回值被拒 ⇒ 主流程无法调用。
 * 发现它的是**用户截图**。
 *
 * ── paradise 的特殊之处：它注册 0 个工具 ─────────────────────────────────────────────────────────
 *
 * `apply` 一个工具都不注册（`src/index.ts:134` 明写「this layer registers no tools」）。所以「扫每个
 * 注册工具」在这里**没有主语** —— 但这不是结论，而是一条要**核实**的事实：本文件 ① 把「注册数为 0」
 * 变成一个断言，理由写在里面。若将来它开始注册工具，① 会红，提醒把扫描补上。
 *
 * paradise 真正过宿主校验的是两条 seam：
 *
 *   A. **raw tool factory 的信封** —— 自修复工具（模型自己写的）执行后的 `{ isError, value }`
 *   B. **DSH tool adapter 的信封** —— 本层与宿主之间最后一道形状关口
 *
 * ── 找到了什么（实测，修前）──────────────────────────────────────────────────────────────────────
 *
 * 一个只写文件、不 `return` 任何东西的工具体 —— **自修复脚本最自然的写法** —— 返回 `undefined`，
 * 于是信封是 `{ isError: false, value: undefined }`，即 `$.value = undefined`。三处都这样：
 * factory 的进程内分支、factory 的沙箱分支、以及 DSH adapter。**这是 B0 的同族，而且发生在专门用来
 * 自修复的那一层。**
 *
 * ── 判据（五条，三条负向）──────────────────────────────────────────────────────────────────────
 *
 *   ① 核实：`apply` 注册 0 个工具（不是假设）；若变了要红并让人来补扫描
 *   ② 工具体返回 `undefined` ⇒ 信封**没有** `value` 这个自有键
 *   ③ 负向：返回了值 ⇒ `value` 必须在（不许用「一律省略」通过 ②）
 *   ④ 负向：抛异常 / 未知工具 / 沙箱拒绝 ⇒ 错误信封也必须无损
 *   ⑤ 负向：DSH adapter 的信封同一条规则（只修 factory 等于没修）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, createDshAdapters, createRawToolFactory } from '../index.js'

/** The host's rule. Returns PATHS, so a failure names where instead of saying 「invalid」. */
function losslessProblems(value, path = '$', seen = new Set()) {
  if (value === undefined) return [`${path} = undefined`]
  if (value === null) return []
  const type = typeof value
  if (type === 'number') return Number.isFinite(value) ? [] : [`${path} = ${String(value)}（非有限数）`]
  if (type === 'string' || type === 'boolean' || type === 'bigint') return []
  if (type === 'function') return [`${path} = function`]
  if (type === 'symbol') return [`${path} = symbol`]
  if (seen.has(value)) return [`${path} = 循环引用`]
  seen.add(value)
  const problems = []
  if (Array.isArray(value)) {
    value.forEach((item, index) => problems.push(...losslessProblems(item, `${path}[${index}]`, seen)))
  } else {
    for (const key of Object.keys(value)) {
      problems.push(...losslessProblems(value[key], `${path}.${key}`, seen))
    }
    for (const symbol of Object.getOwnPropertySymbols(value)) {
      problems.push(`${path}.${String(symbol)} = symbol 键`)
    }
  }
  seen.delete(value)
  return problems
}

const define = (factory, name, body) =>
  factory.define({ name, source: `({ execute: async (args) => { ${body} } })` })

test('v284 ①: paradise 注册 0 个工具 —— 这是**核实的**事实，不是假设', () => {
  const registered = []
  const ctx = {
    tools: { register: (definition) => registered.push(definition?.name ?? definition) },
    on: () => {},
    logger: { info() {}, warn() {}, error() {} },
    get: () => undefined,
    emit: () => {},
  }
  /**
   * `apply` refuses at activation when the host lacks its required APIs (measured:
   * `HOST_CAPABILITY_MISSING`). That refusal is the documented honesty, so it is caught here — the
   * thing under test is the REGISTRATION COUNT, not whether a bare ctx is a legal host.
   */
  try {
    apply(ctx, {})
  } catch (error) {
    assert.match(String(error?.message ?? error), /HOST_CAPABILITY_MISSING/u, '只接受「宿主能力缺失」这一种拒绝')
  }
  assert.deepEqual(
    registered,
    [],
    `paradise 现在注册了工具（${registered.join(', ')}）—— 这条门禁的前提变了，请把 v284 扩展成逐工具扫描`,
  )
})

test('v284 ②: 工具体返回 undefined ⇒ 信封没有 value 这个自有键', async () => {
  const factory = createRawToolFactory({})
  await define(factory, 'writes-only', 'return undefined')
  const result = await factory.execute('writes-only', {})

  const problems = losslessProblems(result)
  assert.deepEqual(problems, [], `信封必须无损，实测越界：${problems.join('; ')}`)
  assert.equal(
    Object.prototype.hasOwnProperty.call(result, 'value'),
    false,
    '没有返回值时 value 必须**缺席**；存在且为 undefined 正是宿主拒绝的那一形状',
  )
  assert.equal(result.isError, false, '而它仍然是一次成功的执行')
})

test('v284 ③: 负向 —— 返回了值 ⇒ value 必须在（不许「一律省略」也能过 ②）', async () => {
  const factory = createRawToolFactory({})
  await define(factory, 'returns-value', 'return { ok: true, n: 1 }')
  const result = await factory.execute('returns-value', {})

  assert.deepEqual(losslessProblems(result), [])
  assert.deepEqual(result.value, { ok: true, n: 1 }, '返回了值就必须带着它')
})

test('v284 ④: 负向 —— 错误信封也必须无损', async () => {
  const factory = createRawToolFactory({})
  await define(factory, 'throws', 'throw new Error("boom")')
  const thrown = await factory.execute('throws', {})
  assert.deepEqual(losslessProblems(thrown), [], '抛异常的信封同样过宿主校验')
  assert.equal(thrown.isError, true)

  const unknown = await factory.execute('no-such-tool', {})
  assert.deepEqual(losslessProblems(unknown), [], '未知工具的信封同样过宿主校验')
  assert.equal(unknown.isError, true)

  /**
   * SANDBOX MODE IS A SEPARATE BRANCH with its own `{ isError: false, value }`. Fixing only the
   * in-process one would leave the branch that actually runs model-authored code unfixed.
   */
  const root = mkdtempSync(join(tmpdir(), 'b0b-para-'))
  const sandboxed = createRawToolFactory({ sandboxRoots: [root] })
  await sandboxed.define({ name: 'sandboxed-writes-only', source: '({ execute: async () => { return undefined } })' })
  const sandboxResult = await sandboxed.execute('sandboxed-writes-only', {})
  assert.deepEqual(losslessProblems(sandboxResult), [], '沙箱分支的信封同样过宿主校验')
  assert.equal(sandboxResult.isError, false)
})

test('v284 ⑤: 负向 —— DSH adapter 的信封同一条规则（只修 factory 等于没修）', async () => {
  /**
   * This adapter is the LAST seam between a repair tool and the host. It re-wraps whatever the inner
   * registry returned, so it can reintroduce the shape even when the factory is correct.
   */
  const hostToolResult = { isError: false, value: undefined }
  const ctx = {
    get: (name) =>
      name === 'tools'
        ? { execute: async () => hostToolResult }
        : undefined,
    on: () => {},
    logger: { info() {}, warn() {}, error() {} },
  }
  const adapters = createDshAdapters(ctx)
  const outcome = await adapters.tools.execute({ name: 'inner-tool', args: {} })

  const problems = losslessProblems(outcome)
  assert.deepEqual(problems, [], `DSH adapter 的信封必须无损，实测：${problems.join('; ')}`)
  assert.equal(
    Object.prototype.hasOwnProperty.call(outcome, 'value'),
    false,
    '内层没有返回值时，外层信封也不许带一个 undefined 的键',
  )
})
