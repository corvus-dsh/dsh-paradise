/**
 * ── v344：每一个 `process.env.GRAFT_*` 读取点都必须能自述（lead §五十.4）───────────────────────
 *
 * 纪律：
 *
 *   > 凡是为可测性而开的环境变量，必须在被使用时打印一行「我改了哪个输入」。
 *   > 没有这一行的注入点，等于一个静默的 override。
 *
 * 为什么它必须**机械化**而不是逐个手改：我按这条纪律去数，实际找到的不是裁定里说的三个，
 * 而是**七个**（`closure` / `check-cycles` / `move-gate` / `verify-pure-move` / `who-references` /
 * `run-gate` / `verify-bundle`）。**「我记得补过哪些」这件事本身就是不可靠的**——这正是
 * §四十七那句「判据必须只依赖它自己构造的输入」的镜像：**审计结论不能依赖作者的记忆。**
 *
 * ── 为什么这一条必须是源码文本判据，且必须 `stripComments` ────────────────────────────────────
 *
 * 本判据的断言是「文件里存在 `injected via <VAR>`」。而**解释这个约定的注释里就写着
 * `injected via`**——裸匹配会让每一个写了说明、却没写代码的文件通过，**判据会绿得毫无意义**。
 * 这是 §四十六那条纪律的原样重现，所以这里第一件事就是剥注释。
 *
 * 判据：
 *
 *   ① 机械：`scripts/*.mjs` 里每个 `process.env.GRAFT_X` 读取，剥注释后必须伴随
 *      `injected via GRAFT_X`，且该打印必须**由同一个变量守卫**（`if (... process.env.GRAFT_X ...)`）。
 *   ② ②的负向自检：扫描器喂「读了但不打印」的合成源码必须**报出来**，喂「读了且打印」的必须不报。
 *      —— 一个只会说「都合格」的扫描器，和没有扫描器一样。
 *   ③ 行为：真实进程跑 `check-cycles.mjs`，注入时打印、不注入时不打印。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './source-assertion.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPTS = join(ROOT, 'scripts')

/**
 * Find every injected-input variable a file reads, and say for each whether the file announces it.
 *
 * Returns `{ variable, announced, guarded }[]`. The announcement must be BOTH:
 *   - a string containing `injected via <VAR>` (so a reader, and this criterion, can grep it), and
 *   - guarded by the same variable (so the line reports reality instead of always printing).
 *
 * ── WHY THE GUARD MAY NAME AN ALIAS, AND WHY THAT IS NOT A LOOSENING ─────────────────────────────
 *
 * First version required the guard to spell `process.env.GRAFT_X` inline. That flagged
 * `verify-pure-move.mjs`, whose guard reads `if (INJECTED_REPO)` where
 * `const INJECTED_REPO = process.env.GRAFT_PURE_MOVE_REPO !== undefined && ...`.
 *
 * **That code is correct.** What this criterion must police is 「结论依赖什么」——「打印是否真的由注入
 * 生效决定」，不是「守卫是否把变量名拼写在同一行」。一个正确的间接写法被罚，判据就会被人为了
 * 让正确代码通过而放宽，然后第一个需要它的人把它关掉（§四十八.2 的教训）。
 *
 * So an alias is accepted ONLY when its initializer reads THAT SAME variable, and the synthetic
 * negative in ② proves the extension did not become "any `if`".
 */
export function auditInjectionPoints (source) {
  const code = stripComments(source)
  const found = []
  const seen = new Set()
  for (const match of code.matchAll(/process\.env\.(GRAFT_[A-Z_]+)/gu)) {
    const variable = match[1]
    if (seen.has(variable)) continue
    seen.add(variable)
    const announced = code.includes(`injected via ${variable}`)
    const aliases = [...code.matchAll(new RegExp(`const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*process\\.env\\.${variable}\\b`, 'gu'))]
      .map((alias) => alias[1])
    const guardTargets = [`process\\.env\\.${variable}`, ...aliases.map((alias) => `\\b${alias}\\b`)]
    /**
     * Test the CONDITION, not the whole line. Measured: matching `if \(...target` against the full
     * line accepted `if (process.env.GRAFT_OTHER_SRC !== undefined) console.log(\`… ${SRC} …\`)` —
     * because `SRC` (an alias of the variable) appears in the PRINTED string, not in the guard.
     * A guard has to be the thing that decides whether the line runs.
     */
    const conditions = [...code.matchAll(/if\s*\(([^)]*)\)/gu)].map((condition) => condition[1])
    const guarded = conditions.some((condition) => guardTargets.some((target) => new RegExp(target, 'u').test(condition)))
    found.push({ variable, announced, guarded })
  }
  return found
}

test('v344 ①: every GRAFT_* injectable input announces itself, and the announcement is guarded', () => {
  const offenders = []
  let variables = 0
  let files = 0
  for (const entry of readdirSync(SCRIPTS)) {
    if (!entry.endsWith('.mjs')) continue
    const points = auditInjectionPoints(readFileSync(join(SCRIPTS, entry), 'utf8'))
    if (points.length === 0) continue
    files += 1
    for (const point of points) {
      variables += 1
      if (!point.announced) offenders.push(`${entry}: ${point.variable} is read but never printed as "injected via ${point.variable}"`)
      else if (!point.guarded) offenders.push(`${entry}: ${point.variable} is printed, but not behind an "if (... process.env.${point.variable} ...)" guard — an unconditional line cannot report an exception`)
    }
  }
  /** An empty set is not a pass: this criterion is about a population, so the population must exist. */
  assert.ok(files >= 4, `expected at least 4 scripts to read a GRAFT_* input, measured ${files} — the scan is not looking at the right place`)
  assert.deepEqual(offenders, [], `injection points that do not announce themselves:\n  ${offenders.join('\n  ')}`)
  console.log(`v344: ${variables} injection point(s) across ${files} script(s) all name their input`)
})

test('v344 ② (negative half): the audit itself can say NO — an unannounced read is reported', () => {
  /**
   * Without this half, ① passes for the same reason a scanner that returns an empty array always
   * passes: because nothing reached it. The synthetic sources below are the two answers the scanner
   * must be able to tell apart, and the silent one is exactly the shape this criterion forbids.
   */
  const silent = [
    "const SRC = process.env.GRAFT_EXAMPLE_SRC !== undefined ? process.env.GRAFT_EXAMPLE_SRC : 'src'",
  ].join('\n')
  const announced = [
    'const SRC = process.env.GRAFT_EXAMPLE_SRC !== undefined ? process.env.GRAFT_EXAMPLE_SRC : \'src\'',
    "if (process.env.GRAFT_EXAMPLE_SRC !== undefined) console.log(`example: src = ${SRC} (injected via GRAFT_EXAMPLE_SRC)`)",
  ].join('\n')
  /** A comment that merely DESCRIBES the convention must not count as the convention. */
  const commentOnly = [
    'const SRC = process.env.GRAFT_EXAMPLE_SRC',
    "// 变量生效时打印一行 injected via GRAFT_EXAMPLE_SRC（本注释不算实现）",
  ].join('\n')

  const silentPoints = auditInjectionPoints(silent)
  assert.equal(silentPoints.length, 1, 'the scanner must still SEE the variable it refuses')
  assert.equal(silentPoints[0].announced, false, 'an unannounced read must be reported as unannounced')

  const announcedPoints = auditInjectionPoints(announced)
  assert.equal(announcedPoints[0].announced, true, 'a guarded announcement must be recognised')
  assert.equal(announcedPoints[0].guarded, true, 'the guard must be recognised')

  const commentPoints = auditInjectionPoints(commentOnly)
  assert.equal(commentPoints[0].announced, false,
    'a comment describing the convention is NOT the convention — this is why the scan strips comments')

  /**
   * The alias extension must not become "any `if` counts". Two shapes prove it still says no:
   * a guard on a DIFFERENT variable, and a print that is not behind any condition at all.
   */
  const wrongGuard = [
    'const SRC = process.env.GRAFT_EXAMPLE_SRC',
    "if (process.env.GRAFT_OTHER_SRC !== undefined) console.log(`example: src = ${SRC} (injected via GRAFT_EXAMPLE_SRC)`)",
  ].join('\n')
  assert.equal(auditInjectionPoints(wrongGuard)[0].guarded, false,
    'a guard on a different variable must not count as guarding this one')

  const unguarded = [
    'const SRC = process.env.GRAFT_EXAMPLE_SRC',
    "console.log(`example: src = ${SRC} (injected via GRAFT_EXAMPLE_SRC)`)",
  ].join('\n')
  assert.equal(auditInjectionPoints(unguarded)[0].guarded, false,
    'an announcement printed unconditionally must be reported — it cannot report an exception')

  const aliasGuard = [
    'const INJECTED = process.env.GRAFT_EXAMPLE_SRC !== undefined && process.env.GRAFT_EXAMPLE_SRC !== \'\'',
    "if (INJECTED) console.log(`example: src = ${SRC} (injected via GRAFT_EXAMPLE_SRC)`)",
  ].join('\n')
  assert.equal(auditInjectionPoints(aliasGuard)[0].guarded, true,
    'a guard through an alias OF THIS variable is correct code and must be accepted')
})

test('v344 ③: a real process announces the input only when it is actually injected', () => {
  const copy = mkdtempSync(join(tmpdir(), 'v344-src-'))
  try {
    mkdirSync(join(copy, 'src'), { recursive: true })
    writeFileSync(join(copy, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
    /** Both channels: the announcement is on STDERR (stdout is the tool's product). */
    const run = (injected) => {
      const env = { ...process.env }
      if (injected === undefined) delete env.GRAFT_CHECK_CYCLES_SRC
      else env.GRAFT_CHECK_CYCLES_SRC = join(copy, 'src')
      const result = spawnSync(process.execPath, [join(SCRIPTS, 'check-cycles.mjs')], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
    }

    const injected = run(copy)
    assert.match(injected.out, /check-cycles: src = .*\(injected via GRAFT_CHECK_CYCLES_SRC\)/u,
      `an injected run must name the tree it measured:\n${injected.out}`)
    assert.ok(injected.out.includes(join(copy, 'src')), `the announced path must be the injected one:\n${injected.out}`)
    assert.doesNotMatch(injected.stdout, /injected via/u,
      `the announcement must NOT go to stdout — stdout is the product (measured: it broke move-gate --json):\n${injected.stdout}`)

    const plain = run(undefined)
    assert.doesNotMatch(plain.out, /injected via GRAFT_CHECK_CYCLES_SRC/u,
      `a run with no injection must not claim one:\n${plain.out}`)
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
})
