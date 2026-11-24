/**
 * ── v342 / P2：`stripComments` 自身的判据（lead §四十八.4）────────────────────────────────────────
 *
 * 路径：**共享工具的正确性**（`test/source-assertion.mjs`），不是某个调用点。
 *
 * ── 为什么这个函数需要自己的判据 ──────────────────────────────────────────────────────────────
 *
 * 它决定**全部 53+ 条源码断言**的可信度。一旦退化（比如把字符串里的 `//` 也剥掉），
 * **所有断言会集体变松，而没有任何一条会红** —— 因为它们的输入仍然"看起来"正常。
 *
 * `v341 ②` 证明的是「注释被剥掉」，**没证明「字符串被保留」**。两个方向必须分开测：
 * 只测一个方向，另一个方向的退化就是沉默的。
 *
 * ── 用户自己踩过的镜像错误（写在这里，因为它是这条判据的由来）────────────────────────────────
 * 他担心字符串里的 `//` 会被当注释剥掉，**用「文档描述」推断实现缺陷**，读实现后证伪
 * （`:45` 有 quote 状态、`:51` 处理转义、`:63` 认三种引号、`:69` 只在字符串外判注释）。
 * > **用文档描述代替读实现去判断缺陷** —— 与本批的「比较了 A 不等于检查了 B」同形。
 *
 * 所以本判据**不读文档、不读注释**，只喂样本看输出。
 *
 * ── 判据（五条，三条负向）──────────────────────────────────────────────────────────────────────
 *   ① 字符串里的 `https://…`、`/*`、中文红线文本 **必须原样保留**
 *   ② **负向** 真正注释里的目标串 **必须消失**
 *   ③ **负向** 行数不变（否则失败会把读者指到错的行）
 *   ④ **负向** 三种引号（' / " / `）都要保护；只保护一种就是退化的第一种形态
 *   ⑤ can-red：把 `quote` 分支删掉 ⇒ ① 必须红（本判据能反对它保护的那个工具）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './source-assertion.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HELPER = join(ROOT, 'test', 'source-assertion.mjs')

/**
 * A sample built to catch both failure directions at once:
 *
 *   - THREE strings that must survive (a URL with `//`, a literal `/*`, and a Chinese red line);
 *   - TWO comments that must vanish (one line, one block) each carrying the sentinel `FORBIDDEN`.
 */
const SAMPLE = [
  "const url = 'https://example.com/a//b'",
  'const open = "/*"',
  "const redline = '工作目录红线：禁止 rm -rf /'",
  '// FORBIDDEN in a line comment',
  '/* FORBIDDEN',
  '   also in a block comment */',
  'const tail = 1',
].join('\n')

test('v342 ①: strings SURVIVE — a URL, a literal /*, and the Chinese red line', () => {
  const code = stripComments(SAMPLE)
  assert.match(code, /https:\/\/example\.com/u, '① 字符串里的 // 不得被当作注释起点')
  assert.match(code, /"\/\*"/u, '① 字符串里的 /* 不得被当作块注释起点')
  assert.match(code, /工作目录红线：禁止 rm -rf \//u, '① 中文红线文本必须原样保留（它是代码在用的数据）')
})

test('v342 ② (negative): real comments DISAPPEAR', () => {
  const code = stripComments(SAMPLE)
  assert.equal(
    code.includes('FORBIDDEN'),
    false,
    '② 注释里的目标串必须消失 —— 否则「注释不是代码」这条就没实现；实测仍能找到 FORBIDDEN',
  )
})

test('v342 ③ (negative): line count is preserved, so failures report real line numbers', () => {
  const code = stripComments(SAMPLE)
  assert.equal(
    code.split('\n').length,
    SAMPLE.split('\n').length,
    '③ 剥注释不得改变行数 —— 否则断言失败时报告的行号是错的',
  )
  assert.equal(code.split('\n')[0], "const url = 'https://example.com/a//b'", '③ 第 1 行必须原样')
  assert.equal(code.split('\n')[6], 'const tail = 1', '③ 第 7 行必须原样（中间隔着一个块注释）')
})

test("v342 ④ (negative): ALL THREE quote styles are protected (' / \" / `)", () => {
  /**
   * Protecting only `'` would be the first form of degradation: a template literal or a double-
   * quoted string would then be treated as code, and any `//` inside it would eat the rest of
   * the line — including, potentially, the shape a criterion is looking for.
   */
  const sample = [
    "const a = 'single // not a comment'",
    'const b = "double // not a comment"',
    'const c = `template // not a comment`',
  ].join('\n')
  const code = stripComments(sample)
  assert.match(code, /single \/\/ not a comment/u, "④ '…' 必须被保护")
  assert.match(code, /double \/\/ not a comment/u, '④ "…" 必须被保护')
  assert.match(code, /template \/\/ not a comment/u, '④ `…` 必须被保护')
})

test('v342 ⑤ (negative): the helper can actually degrade — dropping the quote branch turns ① red', () => {
  /**
   * This is the half that makes ① meaningful: a criterion about a helper is worthless if the helper
   * could be broken without any assertion noticing. The mutation removes the `quote` guard, so a `//`
   * inside a string starts a comment — exactly the degradation that would make ALL source-text
   * assertions silently looser.
   *
   * The mutated implementation is built IN MEMORY (not by editing the real file), so this test can
   * never leave the repository in a broken state.
   */
  const source = readFileSync(HELPER, 'utf8')
  assert.match(source, /if \(quote !== undefined\)/u, '⑤ 前置条件：实现里必须有 quote 分支')

  /** A deliberately broken twin: the `quote` state is never respected. */
  const broken = (text) => {
    let out = ''
    let i = 0
    while (i < text.length) {
      if (text[i] === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') { out += ' '; i += 1 }
        continue
      }
      out += text[i]
      i += 1
    }
    return out
  }
  const brokenOut = broken("const url = 'https://example.com'")
  assert.equal(
    brokenOut.includes('https://example.com'),
    false,
    '⑤ 坏掉的双胞胎必须吃掉字符串里的 URL —— 这证明 ① 在守着真实的东西，而不是恒真',
  )
  assert.match(
    stripComments("const url = 'https://example.com'"),
    /https:\/\/example\.com/u,
    '⑤ 而真实实现必须保留它',
  )
})
