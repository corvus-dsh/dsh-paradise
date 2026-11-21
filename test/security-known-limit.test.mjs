/**
 * ── security-known-limit: junction 判据**已修**，两条路各司其职 ────────────────────────────────
 *
 * 本文件的前身（B4-0b-1 之前）钉的是一条**已知边界**：
 *
 *   · worker 内的 `within()` 走 `realish()` → `fs.realpathSync`，**不可绕过**；
 *   · 导出的 `isWithinRoots()` 只做 `resolve() + startsWith`，**纯词法、可绕过**；
 *   · 于是 `readWithin` / `listWithin` 经 junction 能读出根外内容 —— 实测漏的是数据，不只是布尔值。
 *
 * ── 用户裁定（2026-11-19，选 ②）与 W1-1 落地 ─────────────────────────────────────────────────────
 *
 * 保留两份判据，但**名字说出强度**：
 *
 *   · `isWithinRootsResolved` —— realpath 版。**任何真读/真写路径一律用它**（`readWithin` /
 *     `listWithin` 已改）；
 *   · `isWithinRootsLexical`  —— 词法版。只用于维修沙箱的**快速预检**，那里的调用方随后会把路径
 *     交给真正做检查的一侧。
 *   · 裸名 `isWithinRoots` **已删除**：它当时就指向弱实现，留一个 deprecated 别名等于把那个谎继续
 *     挂着。
 *
 * ── 本文件现在钉什么（全部必须能红）─────────────────────────────────────────────────────────────
 *
 *   ① 真实 junction：`…Lexical` 认为它在根内（证明这确实只是词法），而 `…Resolved` 认为它在根外；
 *   ② `readWithin` 经 junction **必须被拒**（这是从「漏数据」变成「拦住」的那一条）；
 *   ③ 对照：不经 junction 的根内读**必须成功** —— 证明 ② 不是「拦掉一切」；
 *   ④ 直读根外**必须被拒** —— 证明白名单还在工作；
 *   ⑤ 静态：真读/真写路径不得引用 `…Lexical`（否则判定强度又会被偷偷降回去）；
 *   ⑥ 裸名 `isWithinRoots` 不许再导出（否则旧调用方会静默拿回弱判据）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as sandbox from '../src/adapters/raw/sandbox.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SANDBOX_SOURCE = readFileSync(join(HERE, '..', 'src', 'adapters', 'raw', 'sandbox.ts'), 'utf8')

/**
 * ── THE SCAN, AND WHY IT IS A SEPARATE PREDICATE ────────────────────────────────────────────
 *
 * `hasLexicalBoundary` answers one question about SOURCE TEXT: does this file build a containment
 * check out of `resolve()` plus a `startsWith(root…)` comparison — i.e. a boundary that a junction can
 * walk through?
 *
 * It is excluded from comment lines for the reason this batch learned three times: a check that a
 * comment can satisfy is not a check, and equally one that a comment can TRIP is a check people delete.
 * The two predicates in `sandbox.ts` are named in the whitelist, because their job is to be that
 * comparison.
 */
const LEXICAL_SHAPE = /startsWith\([^)]*root[^)]*\)|startsWith\(`\$\{[^}]*root[^}]*\}/u

export function hasLexicalBoundary(source) {
  const code = String(source)
    .split(/\r?\n/u)
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/u.test(line))
    .join('\n')
  return LEXICAL_SHAPE.test(code) && /\bresolve\s*\(/u.test(code)
}

/**
 * Files under `src/` that still build a lexical containment boundary.
 *
 * `adapters/raw/sandbox.ts` is exempt **by name and for one reason**: it DEFINES the two predicates,
 * and the lexical one exists on purpose as a pre-check whose caller re-checks with the realpath one.
 * Everything else that appears here is a call site that lost the strong check.
 */
export function lexicalBoundaryOffenders(root = join(HERE, '..', 'src')) {
  const exempt = new Set([join('adapters', 'raw', 'sandbox.ts')])
  const offenders = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue
      const rel = relative(root, path)
      if (exempt.has(rel)) continue
      if (hasLexicalBoundary(readFileSync(path, 'utf8'))) offenders.push(rel.split('\\').join('/'))
    }
  }
  walk(root)
  return offenders.sort()
}

const PAYLOAD = 'SECRET-OUTSIDE-SANDBOX'

function makeJunctionScenario() {
  const base = join(tmpdir(), `paradise-junction-${process.pid}-${Date.now().toString(36)}`)
  const inside = join(base, 'inside')
  const outside = join(base, 'outside')
  const junction = join(inside, 'link')
  try {
    mkdirSync(inside, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), PAYLOAD, 'utf8')
    symlinkSync(outside, junction, 'junction')
    const real = (() => {
      try {
        return readFileSync(join(junction, 'secret.txt'), 'utf8')
      } catch {
        return ''
      }
    })()
    if (real !== PAYLOAD) {
      rmSync(base, { recursive: true, force: true })
      return { base: null, error: new Error('junction 建出来了，但读不到外部内容') }
    }
    return { base, inside, outside, junction }
  } catch (error) {
    rmSync(base, { recursive: true, force: true })
    return { base: null, error }
  }
}

test('known-limit ①: junction —— 词法版判「在内」，realpath 版判「在外」', (t) => {
  const scenario = makeJunctionScenario()
  if (scenario.base === null) {
    t.diagnostic(`RESOURCE: 本机无法建立可用的 junction（${scenario.error?.message ?? 'unknown'}）。`)
    t.diagnostic('该边界**未验证**。这不是通过 —— 是「本机测不了」。')
    assert.fail('RESOURCE: 本机无法建 junction，沙箱 junction 边界未验证（不是 skip，是未验证）')
    return
  }
  try {
    const viaJunction = join(scenario.junction, 'secret.txt')
    assert.equal(
      sandbox.isWithinRootsLexical(viaJunction, [scenario.inside]),
      true,
      '词法版**应当**判它在内 —— 这就是「词法」的定义，也是它只能做预检的理由',
    )
    assert.equal(
      sandbox.isWithinRootsResolved(viaJunction, [scenario.inside]),
      false,
      'realpath 版必须看穿 junction —— 否则真读路径还会漏',
    )
  } finally {
    rmSync(scenario.base, { recursive: true, force: true })
  }
})

test('known-limit ②: readWithin 经 junction **必须被拒**（从漏数据 → 拦住）', (t) => {
  const scenario = makeJunctionScenario()
  if (scenario.base === null) {
    t.diagnostic(`RESOURCE: 本机无法建立可用的 junction（${scenario.error?.message ?? 'unknown'}）。`)
    assert.fail('RESOURCE: 本机无法建 junction，readWithin 的 junction 边界未验证')
    return
  }
  try {
    const viaJunction = join(scenario.junction, 'secret.txt')
    assert.throws(
      () => sandbox.readWithin(viaJunction, [scenario.inside]),
      /SANDBOX_DENIED/u,
      `readWithin 必须拒绝 junction 指向根外的读；若这里读出了 ${JSON.stringify(PAYLOAD)}，说明 W1-1 退化`,
    )
  } finally {
    rmSync(scenario.base, { recursive: true, force: true })
  }
})

test('known-limit ③: 对照 —— 根内普通文件仍读得到（② 不是「拦掉一切」）', (t) => {
  const scenario = makeJunctionScenario()
  if (scenario.base === null) {
    t.diagnostic(`RESOURCE: 本机无法建立可用的 junction（${scenario.error?.message ?? 'unknown'}）。`)
    assert.fail('RESOURCE: 本机无法建 junction，对照未验证')
    return
  }
  try {
    const insideFile = join(scenario.inside, 'plain.txt')
    writeFileSync(insideFile, 'INSIDE-OK', 'utf8')
    assert.equal(sandbox.readWithin(insideFile, [scenario.inside]), 'INSIDE-OK')
  } finally {
    rmSync(scenario.base, { recursive: true, force: true })
  }
})

test('known-limit ④: 直读根外**必须被拒**（白名单还在工作）', () => {
  const outside = join(tmpdir(), `paradise-outside-${process.pid}-${Date.now().toString(36)}`)
  mkdirSync(outside, { recursive: true })
  try {
    writeFileSync(join(outside, 'secret.txt'), PAYLOAD, 'utf8')
    const inside = join(tmpdir(), `paradise-inside-${process.pid}-${Date.now().toString(36)}`)
    mkdirSync(inside, { recursive: true })
    try {
      assert.throws(() => sandbox.readWithin(join(outside, 'secret.txt'), [inside]), /SANDBOX_DENIED/u)
    } finally {
      rmSync(inside, { recursive: true, force: true })
    }
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

test('known-limit ⑤: 静态 —— 真读/真写路径不得引用词法版', () => {
  /**
   * The whole point of W1-1 is that the WEAK version must never guard a real read again. Reading the
   * source is the only way to keep that true after someone "simplifies" a call site.
   */
  for (const fn of ['readWithin', 'listWithin']) {
    const start = SANDBOX_SOURCE.indexOf(`export function ${fn}(`)
    assert.notEqual(start, -1, `${fn} 必须存在`)
    const body = SANDBOX_SOURCE.slice(start, SANDBOX_SOURCE.indexOf('\n}\n', start))
    assert.match(body, /isWithinRootsResolved/u, `${fn} 必须用 realpath 版判据`)
    assert.equal(/isWithinRootsLexical/u.test(body), false, `${fn} 不许用词法版 —— 那就是这一条要修的东西`)
  }
})

test('known-limit ⑤b: 扫描面是**全 `src/`**，不是只有 sandbox.ts（B4-B B4）', () => {
  /**
   * ── WHY THIS CASE EXISTS AT ALL ─────────────────────────────────────────────────────────────
   *
   * ⑤ above is correct and useless for the defect it was meant to prevent: it reads TWO FUNCTION
   * BODIES inside ONE FILE. `src/repair-session.ts`'s `resolveInside` carried the same weak shape —
   * `resolve()` + `startsWith(root + sep)` — from before W1-1 until B4-B, and **nothing failed**,
   * because the check never looked at that file.
   *
   * That is the 「修一份拷贝」 shape one level up: the guard was fixed, the guarded SURFACE was not.
   *
   * So this case scans every `.ts` under `src/` for the lexical boundary pattern, and the only
   * permitted places are the ones whose job IS to be lexical (the sandbox module that DEFINES the two
   * predicates, and tests/comment lines which are excluded).
   */
  const offenders = lexicalBoundaryOffenders()
  assert.deepEqual(
    offenders,
    [],
    `这些文件在用词法判据圈定读写边界（junction 可穿透）：\n  ${offenders.join('\n  ')}\n` +
      '用 `isWithinRootsResolved`；确实只能做预检的地方请更新这份白名单并写清理由。',
  )
})

test('known-limit ⑤c: 扫描面能红 —— 一段合成的词法判据必须被点名', () => {
  /**
   * A scan over an empty set reports no problems. This drives the SAME predicate the scan uses with a
   * source that carries the defect, so 「0 offenders」 can only mean 「I looked and found none」.
   */
  const synthetic = [
    'export function looksInside(workspace: string, target: string): string {',
    '  const root = resolve(workspace)',
    '  const absolute = resolve(root, target)',
    '  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) throw new Error("no")',
    '  return absolute',
    '}',
    '',
  ].join('\n')
  assert.equal(hasLexicalBoundary(synthetic), true, '合成样本必须被判为词法边界 —— 否则扫描面是空的')
  assert.equal(hasLexicalBoundary('const x = 1\n'), false, '普通代码不许被误报')
})

test('known-limit ⑥: 裸名 isWithinRoots 不许再导出（旧调用方不许静默拿回弱判据）', () => {
  assert.equal(
    Object.prototype.hasOwnProperty.call(sandbox, 'isWithinRoots'),
    false,
    '裸名已删除；留下它等于让下一个调用方在不知道强度的情况下拿到词法版',
  )
  /** 两个新名字都必须是函数，否则上面的断言会在「根本没导出」时假绿。 */
  assert.equal(typeof sandbox.isWithinRootsLexical, 'function')
  assert.equal(typeof sandbox.isWithinRootsResolved, 'function')
})