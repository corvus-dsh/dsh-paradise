/**
 * ── security-known-limit: 沙箱 fs 白名单不是安全边界（junction 可绕过）──────────────────────────
 *
 * 文件头必须写明的原文（README 已登记，见下）：**「已知边界，见 README 第 4 条：
 * 沙箱只抬高门槛，不是安全边界」**
 *
 * ── 实测得出的、比 README 更精确的一件事 ──────────────────────────────────────────────────────
 *
 * README 第 4 条说：「`within()` 只做词法规范化（`path.resolve`），不解析符号链接 / 目录联接」。
 * 本文件实测后发现这句话**只对了一半**，而它的另一半很重要：
 *
 *   · **worker 内的 `within()`**（`sandbox.ts:230`）走 `realish()` → `fs.realpathSync`，
 *     它**会**解析 junction。源码 L180-188 有一段专门的注释解释这个修复
 *     （「HOW IT IS FIXED. Resolve BOTH sides with fs.realpathSync」）。
 *     → 这条路**不可**绕过。
 *
 *   · **导出的 `isWithinRoots()`**（`sandbox.ts:432`，`readWithin` / `listWithin` 都用它）
 *     只做 `resolve(target)` + `startsWith`，**纯词法**，不碰 realpath。
 *     → 这条路**可以**绕过，本文件用一条真实 junction 证明了它。
 *
 * 也就是说：同一个仓里有**两份判据**，一份解析链接、一份不解析，而导出的那份是不解析的。
 * 这不是「设计上的已知边界」那么简单 —— 已知边界说的是「我们选择不做这个防护」，
 * 而这里的情况是「同一个防护存在两个版本，用户拿到的那个是弱的那一个」。
 *
 * ── 本文件钉什么 ──────────────────────────────────────────────────────────────────────────────
 *
 *   ① 构造真实 junction：沙箱根内的一个目录指向沙箱外
 *   ② 断言 `isWithinRoots` 认为它**在**沙箱内（证明可绕过）
 *   ③ 断言 `readWithin` 真的**读出了**沙箱外的内容（证明漏的是数据，不只是布尔值）
 *   ④ 对照：直接读沙箱外路径**必须被拒**（证明不是「什么都没拦」）
 *   ⑤ can-red：把 `isWithinRoots` 换成 `() => true`，④ 的对照必须失效
 *
 * ── 建不了 junction 时怎么办（不是 skip 了事）──────────────────────────────────────────────────
 *
 * Windows 上 `fs.symlinkSync(target, path, 'junction')` 通常不需要管理员权限，
 * 但在某些受限环境（容器、禁用了开发模式的策略、非 NTFS 卷）会失败。
 * 那时的输出是 **`RESOURCE`**，并写明「本机无法建 junction，该边界未验证」，
 * 且**测试不通过为绿**——一个没验证的边界被默默 skip 掉，等于宣称它不存在。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const sandbox = await import(pathToFileURL(join(ROOT, 'src', 'adapters', 'raw', 'sandbox.ts')).href)

const PAYLOAD = 'SECRET-OUTSIDE-SANDBOX'

/**
 * 建一个「根内目录 junction 指向根外目录」的场景。
 * 返回 null 表示本机建不了 junction（由调用方打印 RESOURCE）。
 */
function makeJunctionScenario () {
  const base = mkdtempSync(join(tmpdir(), 'paradise-junction-'))
  const inside = join(base, 'inside')
  const outside = join(base, 'outside')
  const junction = join(inside, 'escape')
  mkdirSync(inside, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'secret.txt'), PAYLOAD)

  try {
    symlinkSync(outside, junction, 'junction')
  } catch (error) {
    rmSync(base, { recursive: true, force: true })
    return { base: null, error }
  }

  // 确认它真的是一个指向外部的 junction（而不是建了个空目录）
  let pointsOutside = false
  try {
    pointsOutside = realpathSync(junction) === realpathSync(outside)
  } catch {
    pointsOutside = false
  }
  if (!pointsOutside) {
    rmSync(base, { recursive: true, force: true })
    return { base: null, error: new Error('junction 建出来了，但它不指向外部（realpath 不相等）') }
  }
  return { base, inside, outside, junction }
}

test('security-known-limit ①: junction 可绕过 isWithinRoots（导出版本只做词法规范化）', (t) => {
  const scenario = makeJunctionScenario()
  if (scenario.base === null) {
    /**
     * 不是 skip。skip 会让这条在 CI 上永远是灰的，下一个人读报告时看不到「没验证」。
     */
    t.diagnostic(`RESOURCE: 本机无法建立可用的 junction（${scenario.error?.message ?? 'unknown'}）。`)
    t.diagnostic('该边界**未验证**。这不是通过 —— 是「本机测不了」。')
    assert.fail('RESOURCE: 本机无法建 junction，沙箱 junction 绕过这一条边界未验证（不是 skip，是未验证）')
    return
  }

  try {
    const viaJunction = join(scenario.junction, 'secret.txt')

    // ② 核心断言：白名单认为它在内 —— 这就是「可绕过」的定义
    const consideredInside = sandbox.isWithinRoots(viaJunction, [scenario.inside])
    assert.equal(consideredInside, true,
      `isWithinRoots 应把「根内 junction → 根外」判定为在沙箱内（这正是已知边界）。`
      + `实测 false —— 说明这条已修复，请把本文件改成断言「已修复」，不要留着一条永远绿的旧断言。`)

    // ③ 漏的是数据，不只是布尔值
    const leaked = sandbox.readWithin(viaJunction, [scenario.inside])
    assert.equal(leaked, PAYLOAD,
      `readWithin 经 junction 应读出根外内容 ${JSON.stringify(PAYLOAD)}。实测 ${JSON.stringify(leaked.slice(0, 40))}`)

    // ④ 对照：不经 junction 的直读必须被拒 —— 证明不是「什么都没拦」
    assert.throws(
      () => sandbox.readWithin(join(scenario.outside, 'secret.txt'), [scenario.inside]),
      /SANDBOX_DENIED/u,
      '对照失败：直接读沙箱外路径**必须**被拒。若这条也过了，说明整个白名单失效，'
      + '而不是「junction 这一条已知边界」。',
    )
  } finally {
    rmSync(scenario.base, { recursive: true, force: true })
  }
})

test('security-known-limit ② can-red: 把 isWithinRoots 换成 () => true ⇒ ④ 的对照必须失效', () => {
  /**
   * 这条证明 ④（「直读外部必须被拒」）不是恒真的。
   *
   * 做法：用 `() => true` 代替 `isWithinRoots`，重放 ④ 的拒绝逻辑。
   * 在真判据下它会 throw SANDBOX_DENIED；在恒 true 下它不会 throw。
   * 若两者行为相同，说明 ④ 测的不是判据本身。
   */
  const denyCheck = (isWithin) => {
    const target = join('C:', 'definitely', 'outside', 'secret.txt')
    if (!isWithin(target)) throw new Error('SANDBOX_DENIED: read ' + target)
    return 'ALLOWED'
  }

  // 真判据（用源里的 isWithinRoots，把根设成一个不可能包含它的路径）
  const realRootsOnly = [join(tmpdir(), 'paradise-canred-root-does-not-matter')]
  let realThrew = false
  try {
    denyCheck((target) => sandbox.isWithinRoots(target, realRootsOnly))
  } catch (e) {
    realThrew = /SANDBOX_DENIED/u.test(e.message)
  }
  assert.equal(realThrew, true, '真判据下，根外路径必须触发 SANDBOX_DENIED')

  // 恒 true 的桩：必须**不再**抛错，否则这条 can-red 没构造出「判据失效」
  let stubThrew = false
  try {
    denyCheck(() => true)
  } catch {
    stubThrew = true
  }
  assert.equal(stubThrew, false,
    '把 isWithinRoots 换成 () => true 之后，拒绝逻辑必须失效（不再抛错）。'
    + '它仍然抛错，说明这条 can-red 没有真的替换掉判据。')
})

/**
 * ── 这一条是「已修复的那一半」，单独钉住，防止有人把它一起改坏 ────────────────────────────────
 *
 * worker 内的 `within()` 走 realish()/realpathSync，**已经**能识别 junction。
 * 本文件不通过 spawn worker 来测它（那需要构造完整 workerData 与源码字符串），
 * 而是直接钉住那条源码事实：`realish` 用的是 `realpathSync`。
 *
 * 为什么值得钉：如果有人为了「统一两份判据」把 realish 也降级成 resolve，
 * 那 worker 路径会跟着失守，而上面第一条测试**不会红**（它测的是导出 API）。
 */
test('security-known-limit ③: worker 内的 within() 仍然用 realpathSync 解析链接（不要把它一起降级）', () => {
  const source = readFileSync(join(ROOT, 'src', 'adapters', 'raw', 'sandbox.ts'), 'utf8')
  assert.match(source, /fs\.realpathSync\(probe\)/u,
    'worker 内的 realish() 必须继续用 fs.realpathSync 解析链接。'
    + '两份判据里，导出那份弱是已知边界，worker 这份弱就是回归。')
  assert.match(source, /function realish\(target\)/u,
    'realish() 必须还在 —— 它是 worker 路径唯一解析链接的地方')
})
