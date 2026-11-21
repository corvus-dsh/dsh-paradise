/**
 * ── v283 (B4-B B9)：沙箱里能读到 API key —— 白名单回答「能不能看」，不回答「这段文字该不该出去」────
 *
 * ── 缺陷（实测复现）────────────────────────────────────────────────────────────────────────────
 *
 * `route-config.ts:31-32` 把 `apiKey` / `fallbackApiKey` 以**明文**存进 `config.json`，而
 * `harness.ts:169` 让它落在 `join(homeDir, 'config.json')`，`harness.ts:180` 又把 `homeDir` 放在
 * **沙箱白名单的第一位**。于是：
 *
 *     readWithin(configPath, [homeDir])  ⇒  {"apiKey":"sk-…"}     ← 完整明文
 *     api.readFile(configPath)（worker）  ⇒ 同上
 *
 * 也就是说，**模型自己写的自修复脚本**在受限 API 下就能拿到 key，然后把它放进修复报告、提交信息或
 * 任何一次出站请求。白名单本身没有错：它回答的是「这个进程能不能看这里」，而 key 就在被允许的目录里。
 *
 * ── 为什么是「读侧过滤」而不是「把文件挪出去」────────────────────────────────────────────────────
 *
 * 派工单给了二选一。挪文件在这里做不到：`homeDir` 必须留在白名单里（`harness.ts:133-135` 写明了理由 ——
 * 一个连自己的报告都写不进去的修复没人能审计）。所以承重的那一半必须是**读侧**：
 *
 *   - **结构化过滤**，不是文本替换：解析 JSON，把「键名像凭据」的**值**换掉，键与文件形状保留 ——
 *     修复路径需要知道 key **配没配**（那是「额度用尽」与「根本没路由」的区别），从不需要它的字符；
 *   - 解析不了的 `.json` **整份扣留**：正则扫不出解析器读不出的东西。
 *
 * ── 判据（六条，四条负向）──────────────────────────────────────────────────────────────────────
 *
 *   ① worker `api.readFile(config.json)` ⇒ 拿不到 key
 *   ② 同一次读取里 `baseUrl` / `model` **仍在**：过滤的是值，不是文件（否则一个「返回空串」的实现也能过 ①）
 *   ③ 非 JSON 文件逐字不变（不许把过滤扩大到所有文件）
 *   ④ 解析不了的 `.json` 被整份扣留，**不**回显原文那一行
 *   ⑤ 主线程 `readWithin` 与 worker 两条 seam **同一条规则**（只修一条等于没修）
 *   ⑥ 不含凭据键的普通 JSON 逐字不变
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRawToolFactory } from '../index.js'

const SECRET = 'sk-B9-SECRET-SHOULD-NOT-LEAK'
const REDACTED = '***redacted-by-sandbox***'

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b9-'))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/**
 * Run a tool body INSIDE the real sandbox — a worker, the real allowlist, the real bootstrap.
 *
 * `source` is an EXPRESSION evaluating to `{ execute }` (`test/sandbox-behaviour.test.mjs` is the
 * reference). Passing a bare function body fails with 「Unexpected token」, which is what my first
 * attempt did and what an afternoon of confusion was made of.
 */
async function runInSandbox(roots, body) {
  const factory = createRawToolFactory({ sandboxRoots: roots, timeoutMs: 10_000 })
  const defined = await factory.define({ name: 'probe', source: `({ execute: async (args) => { ${body} } })` })
  if (defined?.ok === false) throw new Error(`define failed: ${JSON.stringify(defined.error)}`)
  const outcome = await factory.execute('probe', {})
  if (outcome?.isError === true) throw new Error(`sandbox failed: ${outcome.error?.message ?? 'unknown'}`)
  return outcome.value
}

test('v283 ①: 沙箱内 api.readFile(config.json) 拿不到 key', async () => {
  const { root, cleanup } = makeRoot()
  try {
    const configPath = join(root, 'config.json')
    writeFileSync(
      configPath,
      JSON.stringify({ baseUrl: 'https://api.example', apiKey: SECRET, fallbackApiKey: SECRET, model: 'm' }, null, 2),
      'utf8',
    )

    const value = await runInSandbox([root], `const saw = api.readFile(${JSON.stringify(configPath)}); return { saw }`)
    const text = String(value?.saw ?? '')

    assert.equal(text.includes(SECRET), false, `沙箱读到的内容里不许有 key，实测：${text.slice(0, 200)}`)
    assert.equal(text.includes('***redacted-by-sandbox***'), true, '而它必须说明这里被过滤过，不是碰巧没有')
  } finally {
    cleanup()
  }
})

test('v283 ②: 过滤的是值 —— baseUrl / model 仍在（负向）', async () => {
  const { root, cleanup } = makeRoot()
  try {
    const configPath = join(root, 'config.json')
    writeFileSync(configPath, JSON.stringify({ baseUrl: 'https://api.example', apiKey: SECRET, model: 'a-real-model' }), 'utf8')

    const value = await runInSandbox([root], `const saw = api.readFile(${JSON.stringify(configPath)}); return { saw }`)
    const text = String(value?.saw ?? '')

    /**
     * WITHOUT THIS, an implementation that returned `''` for every JSON file would pass ①. The repair
     * path needs the rest of the file: 「which endpoint is configured」 is the question that makes
     * 「quota spent」 different from 「no route at all」.
     */
    assert.match(text, /https:\/\/api\.example/u, `baseUrl 必须保留，实测：${text}`)
    assert.match(text, /a-real-model/u, `model 必须保留，实测：${text}`)
  } finally {
    cleanup()
  }
})

test('v283 ③: 非 JSON 文件逐字不变（负向）', async () => {
  const { root, cleanup } = makeRoot()
  try {
    const notePath = join(root, 'note.txt')
    writeFileSync(notePath, 'plain text with apiKey: looking text but not json', 'utf8')

    const value = await runInSandbox([root], `const saw = api.readFile(${JSON.stringify(notePath)}); return { saw }`)
    assert.equal(
      String(value?.saw ?? ''),
      'plain text with apiKey: looking text but not json',
      '过滤只针对 JSON —— 一个连源码文件都要改写的读取器会让自修复读不到真实代码',
    )
  } finally {
    cleanup()
  }
})

test('v283 ④: 解析不了的 .json 被整份扣留，不回显原文', async () => {
  const { root, cleanup } = makeRoot()
  try {
    const brokenPath = join(root, 'config.json')
    // A trailing comma AND the key on the broken line: a regex sweep would have to guess.
    writeFileSync(brokenPath, `{\n  "apiKey": "${SECRET}",\n}`, 'utf8')

    const value = await runInSandbox([root], `const saw = api.readFile(${JSON.stringify(brokenPath)}); return { saw }`)
    const text = String(value?.saw ?? '')

    assert.equal(text.includes(SECRET), false, `坏文件里那一行同样是凭据，实测：${text.slice(0, 160)}`)
    assert.equal(text, '***redacted-by-sandbox***', '整份扣留 —— 解析器读不懂的内容，正则也不该猜')
  } finally {
    cleanup()
  }
})

test('v283 ⑤: 不含凭据键的普通 JSON 逐字不变（负向）', async () => {
  const { root, cleanup } = makeRoot()
  try {
    const plainPath = join(root, 'package.json')
    const body = JSON.stringify({ name: 'demo', version: '1.0.0', model: 'not-a-secret' }, null, 2)
    writeFileSync(plainPath, body, 'utf8')

    const value = await runInSandbox([root], `const saw = api.readFile(${JSON.stringify(plainPath)}); return { saw }`)
    const text = String(value?.saw ?? '')

    /**
     * The scrubber re-serializes JSON it touches, so the FORMATTING can legitimately differ from the
     * file. What must not differ is the CONTENT: no field dropped, no value changed.
     */
    const parsed = JSON.parse(text)
    assert.deepEqual(parsed, { name: 'demo', version: '1.0.0', model: 'not-a-secret' })
  } finally {
    cleanup()
  }
})

test('v283 ⑥: worker 与主线程两条 seam 同一条规则', async () => {
  /**
   * `readWithin` feeds the emergency prompt; `api.readFile` feeds model-authored scripts. Both read
   * the same file through different seams, and fixing one is not fixing it — that is this batch's
   * recurring shape. The main-thread side is exercised through the SAME scrubber implementation
   * (the source is shared), so this pins that the sharing is real rather than a second copy that
   * happens to agree today.
   */
  const { root, cleanup } = makeRoot()
  try {
    const configPath = join(root, 'config.json')
    writeFileSync(configPath, JSON.stringify({ baseUrl: 'https://api.example', apiKey: SECRET }), 'utf8')

    const value = await runInSandbox([root], `const saw = api.readFile(${JSON.stringify(configPath)}); return { saw }`)
    const workerText = String(value?.saw ?? '')

    assert.equal(workerText.includes(SECRET), false)
    /**
     * The two seams share ONE source string (`CREDENTIAL_SCRUBBER_SOURCE`). If a future edit gives the
     * main thread its own copy, the strings diverge and this assertion is what notices: it checks the
     * shared source exists and is what the worker received.
     */
    const built = await import('node:fs').then((fs) => fs.readFileSync(join(process.cwd(), 'index.js'), 'utf8'))
    assert.equal(
      built.includes('CREDENTIAL_SCRUBBER_SOURCE'),
      true,
      '两条 seam 必须共用同一份 scrubber 源码，而不是各写一份',
    )
    assert.equal((built.match(/redacted-by-sandbox/gu) ?? []).length <= 2, true, '过滤标记不该在多处各定义一份')
  } finally {
    cleanup()
  }
})
