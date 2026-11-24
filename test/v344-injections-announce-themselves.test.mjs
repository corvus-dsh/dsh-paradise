/**
 * ── v344：环境变量先分类，`input-override` 必须自述（lead §五十三.2）──────────────────────────────
 *
 * 上一版只扫 `process.env.GRAFT_[A-Z_]+`——**名字以 `GRAFT_` 开头才在门内**。实测有名字不带这个
 * 前缀、却确确实实改掉输入的点：
 *
 *   `PPM_CORRECTIONS_JSON`      整张「格式修正豁免表」被替换（门禁的例外清单！）
 *   `DSH_VALIDATOR_NODE_MODULES` 换掉校验器所用依赖（换掉认证依据）
 *   `DSH_GRAFT_DATA_DIR`        数据目录
 *   `DSH_MEMORY_DIR`            恢复写进哪个 store
 *
 * 上一版结构上看不见它们，因为**「一个具体的名字」被当成了「一个性质」**。
 *
 * 这一版改成 **性质 + 一次分类**：
 *
 *   1. 扫 `scripts/**\/*.mjs` 里**所有** `process.env.*` 读取（不限前缀）；
 *   2. 每个变量必须在 `docs/env-inputs.json` 里被分类为 `config` / `diagnostic` /
 *      `input-override`，**未分类即红**（「没有人做过的决定不许通过」）；
 *   3. 只有 `input-override` 必须自述。
 *
 * ── 为什么 `config` / `diagnostic` 不要求打印 ─────────────────────────────────────────────────
 *
 * `DSH_HOME` / `CI` / `GITHUB_TOKEN` 是**真配置**，不是「改掉被测输入」。要求它们打印会把判据变
 * 成噪声，然后被第一个人关掉（§四十八.2）。**宽一格的判据会惩罚正确代码，然后被第一个需要它的人
 * 关掉**——所以「不要求」这一句被写进数据文件的 `_comment`，也写在这里。
 *
 * 判据：① 人口+分类 ② ②的负向自检（三种答案各验一次） ③ 真实进程只在注入时自述。
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
const REGISTRY = join(ROOT, 'docs', 'env-inputs.json')

const CLASSES = ['config', 'diagnostic', 'input-override']

/**
 * Read one module's environment reads and decide, per variable, whether the module complies.
 *
 * `classification` is `{ VARIABLE: class }`. Returns `{ variable, class, announced, guarded }[]`.
 *
 * The announcement must be BOTH a string `injected via <VAR>` (greppable) and behind a guard that
 * names the variable or an alias of it — an unconditional line cannot report an exception.
 * Comments are stripped first: a comment DESCRIBING the convention is not the convention.
 */
export function auditInjectionPoints (source, classification) {
  const code = stripComments(source)
  const found = []
  const seen = new Set()
  const names = [...code.matchAll(/process\.env(?:\.([A-Za-z_$][\w$]*)|\[['"]([^'"]+)['"]\])/gu)]
  for (const match of names) {
    const variable = match[1] ?? match[2]
    if (seen.has(variable)) continue
    seen.add(variable)
    const announced = code.includes(`injected via ${variable}`)
    const aliasPattern = new RegExp(`const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:String\\()?process\\.env(?:\\.${variable}\\b|\\[['"]${variable}['"]\\])`, 'gu')
    const aliases = [...code.matchAll(aliasPattern)].map((alias) => alias[1])
    const guardTargets = [`process\\.env\\.${variable}`, ...aliases.map((alias) => `\\b${alias}\\b`)]
    /**
     * Test the CONDITION, not the whole line: measured, matching the full line accepted a guard on a
     * DIFFERENT variable whose printed string merely contained the alias.
     */
    const conditions = [...code.matchAll(/if\s*\(([^)]*)\)/gu)].map((condition) => condition[1])
    const guarded = conditions.some((condition) => guardTargets.some((target) => new RegExp(target, 'u').test(condition)))
    found.push({ variable, class: classification[variable], announced, guarded })
  }
  return found
}

test('v344 ①: every environment read is CLASSIFIED, and every input-override announces itself', () => {
  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'))
  assert.ok(Array.isArray(registry._comment) && registry._comment.join('').length > 100,
    'docs/env-inputs.json must carry a non-empty _comment: the three classes and the 「config 不要求打印」 rule live there, and a rule in a data file needs the file to say it')
  const classification = registry.variables
  assert.ok(classification !== null && typeof classification === 'object', 'env-inputs.json must have a "variables" object')

  for (const [variable, cls] of Object.entries(classification)) {
    assert.ok(CLASSES.includes(cls), `${variable} is classified "${cls}", which is not one of ${CLASSES.join(' / ')}`)
  }

  const offenders = []
  let variables = 0
  let files = 0
  let overrides = 0
  for (const entry of readdirSync(SCRIPTS)) {
    if (!entry.endsWith('.mjs')) continue
    const points = auditInjectionPoints(readFileSync(join(SCRIPTS, entry), 'utf8'), classification)
    if (points.length === 0) continue
    files += 1
    for (const point of points) {
      variables += 1
      if (point.class === undefined) {
        offenders.push(`${entry}: ${point.variable} is read but NOT CLASSIFIED in docs/env-inputs.json — nobody decided whether it changes the measured input`)
        continue
      }
      if (point.class !== 'input-override') continue
      overrides += 1
      if (!point.announced) offenders.push(`${entry}: ${point.variable} is an input-override but never announces itself as "injected via ${point.variable}"`)
      else if (!point.guarded) offenders.push(`${entry}: ${point.variable} announces itself outside a guard on that same variable — an unconditional line cannot report an exception`)
    }
  }

  /** An empty population is not a pass: this criterion is about a set, so the set must exist. */
  assert.ok(files >= 4, `expected at least 4 scripts to read an environment variable, measured ${files} — the scan is not looking at the right place`)
  assert.ok(overrides >= 3, `expected at least 3 input-override points, measured ${overrides} — a classification that marks nothing as an override cannot police anything`)
  assert.deepEqual(offenders, [], `environment inputs that do not account for themselves:\n  ${offenders.join('\n  ')}`)
  console.log(`v344: ${variables} environment read(s) across ${files} script(s); ${overrides} input-override(s), all classified and announced`)
})

test('v344 ② (negative half): the audit can say NO — unclassified, unannounced, and the config exemption', () => {
  /**
   * Four answers the audit must tell apart. Without them, ① passes for the same reason a scanner that
   * returns an empty array passes: because nothing reached it.
   */
  const unclassified = auditInjectionPoints("const x = process.env.PPM_CORRECTIONS_JSON\n", {})
  assert.equal(unclassified.length, 1, 'the scan must SEE a variable it has no classification for')
  assert.equal(unclassified[0].class, undefined, 'an unclassified variable must be reportable')

  const overrideSilent = auditInjectionPoints("const x = process.env.SOME_OVERRIDE\n", { SOME_OVERRIDE: 'input-override' })
  assert.equal(overrideSilent[0].announced, false, 'an input-override without an announcement must be reported')

  /** The exemption must actually exempt: a config variable is NOT required to announce. */
  const configured = auditInjectionPoints("const x = process.env.DSH_HOME\n", { DSH_HOME: 'config' })
  assert.equal(configured[0].class, 'config', 'a config variable must stay out of the announcement requirement')
  assert.equal(configured[0].announced, false, 'and its silence must not be an offender — 宽一格的判据会惩罚正确代码')

  /** A comment describing the convention is NOT the convention — this is why the scan strips comments. */
  const commentOnly = [
    'const x = process.env.SOME_OVERRIDE',
    '// 变量生效时打印一行 injected via SOME_OVERRIDE（本注释不算实现）',
  ].join('\n')
  assert.equal(auditInjectionPoints(commentOnly, { SOME_OVERRIDE: 'input-override' })[0].announced, false,
    'a comment describing the convention must not count as the convention')

  /** The alias extension must not become "any if counts". */
  const announced = [
    'const x = process.env.SOME_OVERRIDE',
    "if (process.env.SOME_OVERRIDE !== undefined) console.error(`t: x = ${x} (injected via SOME_OVERRIDE)`)",
  ].join('\n')
  assert.equal(auditInjectionPoints(announced, { SOME_OVERRIDE: 'input-override' })[0].guarded, true,
    'a guarded announcement must be recognised')

  const wrongGuard = [
    'const x = process.env.SOME_OVERRIDE',
    "if (process.env.OTHER !== undefined) console.error(`t: x = ${x} (injected via SOME_OVERRIDE)`)",
  ].join('\n')
  assert.equal(auditInjectionPoints(wrongGuard, { SOME_OVERRIDE: 'input-override' })[0].guarded, false,
    'a guard on a different variable must not count as guarding this one')

  const unguarded = [
    'const x = process.env.SOME_OVERRIDE',
    "console.error(`t: x = ${x} (injected via SOME_OVERRIDE)`)",
  ].join('\n')
  assert.equal(auditInjectionPoints(unguarded, { SOME_OVERRIDE: 'input-override' })[0].guarded, false,
    'an announcement printed unconditionally must be reported')

  const aliasGuard = [
    'const flag = process.env.SOME_OVERRIDE',
    "if (flag) console.error(`t: x = ${x} (injected via SOME_OVERRIDE)`)",
  ].join('\n')
  assert.equal(auditInjectionPoints(aliasGuard, { SOME_OVERRIDE: 'input-override' })[0].guarded, true,
    'a guard through an alias OF THIS variable is correct code and must be accepted (§四十八.2)')

  /** The bracket form is a read too — `process.env['X']` must not be invisible. */
  const bracketed = auditInjectionPoints("const x = process.env['SOME_OVERRIDE']\n", { SOME_OVERRIDE: 'input-override' })
  assert.equal(bracketed.length, 1, "process.env['X'] must be found")
  assert.equal(bracketed[0].variable, 'SOME_OVERRIDE', 'the bracket form must yield the same variable name')
})

test('v344 ③: a real process announces the input only when it is actually injected, and on stderr', () => {
  const copy = mkdtempSync(join(tmpdir(), 'v344-src-'))
  try {
    mkdirSync(join(copy, 'src'), { recursive: true })
    writeFileSync(join(copy, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
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
