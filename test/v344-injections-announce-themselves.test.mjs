/**
 * ── v344：环境变量先分类，`input-override` 必须自述，且两边的说法必须一致（lead §五十五.3）───────
 *
 * 上一版把这条判据从「名字前缀」改成了「性质 + 一次分类」，方向对；但**分类是这条链上唯一没人审核
 * 的一步**。实测（lead 做的）：
 *
 *     把 GRAFT_ACCEPT_DIRTY_TREE 从 input-override 改成 config
 *     ⇒ v344 打印 "9 input-override(s)"（原 10），仍然 3/3 全绿
 *
 * 而它正是**免去脏树检查**的那一个变量，它自己的公告写着 `dirty-tree binding is WAIVED`。
 * **代码说「我改了输入」，数据说「它是配置」，两个工件互相矛盾——而判据只读其中一个。**
 *
 * 所以这一版加**双向一致性**：
 *
 *   ① 分类为 `input-override` 却无公告           ⇒ 红（原有一半）
 *   ② 代码含 `injected via <VAR>`（或打印了这条（公告形）） 而分类是 config/diagnostic ⇒ 红（新增）
 *
 * 另外两条「让决定被写下来」（§五十五.3 的 P2）：
 *
 *   ③ `config` / `diagnostic` 条目必须写 `why` —— 否则「它是配置」这句话没有作者；
 *   ④ `input-override` 条目必须写 `behavioural-evidence`：要么是一个真实断言了「打印路径 == 注入值」
 *      的测试文件，要么是 `none` + `reason`。**登记缺口，而不是假装覆盖。**
 *
 * ── 为什么 `config` / `diagnostic` 不要求打印 ─────────────────────────────────────────────────
 *
 * `DSH_HOME` / `CI` / `GITHUB_TOKEN` 是**真配置**，不是「改掉被测输入」。要求它们打印会把判据变成
 * 噪声，然后被第一个人关掉（§四十八.2）。**宽一格的判据会惩罚正确代码，然后被第一个需要它的人关掉。**
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './source-assertion.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPTS = join(ROOT, 'scripts')
const REGISTRY = join(ROOT, 'docs', 'env-inputs.json')

export const CLASSES = ['config', 'diagnostic', 'input-override']

const escapeForRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/**
 * Read one module's environment reads and say, per variable, whether the module's CODE accounts for it.
 *
 * `variables` maps a variable to `{ class, why?, 'behavioural-evidence'?, reason? }`.
 * Returns `{ variable, entry, announced, guarded }[]`. Comments are stripped first: a comment that
 * DESCRIBES the convention is not the convention.
 */
export function auditInjectionPoints (source, variables) {
  const code = stripComments(source)
  const found = []
  const seen = new Set()
  const names = [...code.matchAll(/process\.env(?:\.([A-Za-z_$][\w$]*)|\[['"]([^'"]+)['"]\])/gu)]
  for (const match of names) {
    const variable = match[1] ?? match[2]
    if (seen.has(variable)) continue
    seen.add(variable)
    /**
     * Word-boundary tail: without it, `CI` would be "announced" by any line mentioning `CIRCLE_CI`.
     * Measured class of bug: the whole criterion family here is about a NAME standing in for a FACT.
     */
    const announced = new RegExp(`injected via ${escapeForRegExp(variable)}(?![A-Za-z0-9_])`, 'u').test(code)
    const aliasPattern = new RegExp(`const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:String\\()?process\\.env(?:\\.${escapeForRegExp(variable)}\\b|\\[['"]${escapeForRegExp(variable)}['"]\\])`, 'gu')
    const aliases = [...code.matchAll(aliasPattern)].map((alias) => alias[1])
    const guardTargets = [`process\\.env\\.${escapeForRegExp(variable)}`, ...aliases.map((alias) => `\\b${escapeForRegExp(alias)}\\b`)]
    /**
     * Test the CONDITION, not the whole line: measured, matching the full line accepted a guard on a
     * DIFFERENT variable whose printed string merely contained the alias.
     */
    const conditions = [...code.matchAll(/if\s*\(([^)]*)\)/gu)].map((condition) => condition[1])
    const guarded = conditions.some((condition) => guardTargets.some((target) => new RegExp(target, 'u').test(condition)))
    found.push({ variable, entry: variables[variable], announced, guarded })
  }
  return found
}

/**
 * The whole per-file verdict. Exported so the negative half can exercise the SAME rules the positive
 * half enforces — a re-implementation in the test would be a second source of truth.
 */
export function auditFile (source, variables, options = {}) {
  const exists = options.exists ?? (() => true)
  const offenders = []
  let overrides = 0
  let gaps = 0
  for (const point of auditInjectionPoints(source, variables)) {
    const { variable, entry } = point
    if (entry === undefined) {
      offenders.push(`${variable}: read but NOT CLASSIFIED in docs/env-inputs.json — nobody decided whether it changes the measured input`)
      continue
    }
    if (!CLASSES.includes(entry.class)) {
      offenders.push(`${variable}: classified "${entry.class}", which is not one of ${CLASSES.join(' / ')}`)
      continue
    }
    if (entry.class === 'input-override') {
      overrides += 1
      if (!point.announced) {
        offenders.push(`${variable}: is an input-override but never announces itself as "injected via ${variable}"`)
      } else if (!point.guarded) {
        offenders.push(`${variable}: announces itself outside a guard on that same variable — an unconditional line cannot report an exception`)
      }
      const evidence = entry['behavioural-evidence']
      if (evidence === undefined || evidence === '') {
        offenders.push(`${variable}: is an input-override with no "behavioural-evidence" — say which test proves the announcement equals the injected value, or "none" plus a reason`)
      } else if (evidence === 'none') {
        gaps += 1
        if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
          offenders.push(`${variable}: evidence is "none" with no "reason" — an unregistered gap is indistinguishable from an oversight`)
        }
      } else if (!exists(evidence)) {
        offenders.push(`${variable}: behavioural-evidence points at "${evidence}", which does not exist`)
      }
    } else {
      if (point.announced) {
        offenders.push(`${variable}: classified "${entry.class}" but the code announces it as an injected input — two artifacts disagree, and only one of them is read`)
      }
      if (typeof entry.why !== 'string' || entry.why.trim() === '') {
        offenders.push(`${variable}: classified "${entry.class}" with no "why" — the decision is recorded but its author is not`)
      }
    }
  }
  return { offenders, overrides, gaps }
}

test('v344 ①: every environment read is classified; overrides announce themselves; the two artifacts agree', () => {
  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'))
  assert.ok(Array.isArray(registry._comment) && registry._comment.join('').length > 100,
    'docs/env-inputs.json must carry a non-empty _comment: the three classes and the 「config 不要求打印」 rule live there')
  const variables = registry.variables
  assert.ok(variables !== null && typeof variables === 'object', 'env-inputs.json must have a "variables" object')

  const exists = (evidence) => existsSync(join(ROOT, ...evidence.split('/')))
  const offenders = []
  let files = 0
  let reads = 0
  let overrides = 0
  let gaps = 0
  for (const entry of readdirSync(SCRIPTS)) {
    if (!entry.endsWith('.mjs')) continue
    const points = auditInjectionPoints(readFileSync(join(SCRIPTS, entry), 'utf8'), variables)
    if (points.length === 0) continue
    files += 1
    reads += points.length
    const verdict = auditFile(readFileSync(join(SCRIPTS, entry), 'utf8'), variables, { exists })
    overrides += verdict.overrides
    gaps += verdict.gaps
    for (const line of verdict.offenders) offenders.push(`${entry}: ${line}`)
  }

  assert.ok(files >= 4, `expected at least 4 scripts to read an environment variable, measured ${files} — the scan is not looking at the right place`)
  assert.ok(overrides >= 3, `expected at least 3 input-override points, measured ${overrides} — a classification that marks nothing as an override cannot police anything`)
  assert.deepEqual(offenders, [], `environment inputs that do not account for themselves:\n  ${offenders.join('\n  ')}`)
  /** The gap count is printed, not hidden: a registered gap must stay visible in the report. */
  console.log(`v344: ${reads} environment read(s) across ${files} script(s); ${overrides} input-override(s), all classified and announced; ${gaps} registered without behavioural evidence`)
})

test('v344 ② (negative half): the audit can say NO to each disagreement it exists to catch', () => {
  /**
   * Built by concatenation, not with an escaped backtick: `check-test-separators` rightly refuses a
   * literal backslash inside a template (it cannot tell `\`` from a Windows path), and a criterion
   * that trips another criterion's guard teaches people to skip the guard.
   */
  const announcedLine = (name) => 'console.error("t: x = " + x + " (injected via ' + name + ')\")'
  const override = { class: 'input-override', 'behavioural-evidence': 'test/v344-injections-announce-themselves.test.mjs' }
  const silentOverride = { class: 'input-override', 'behavioural-evidence': 'none', reason: 'no injected run exists yet' }

  const unclassified = auditFile('const x = process.env.PPM_CORRECTIONS_JSON\n', {})
  assert.equal(unclassified.offenders.length, 1, 'an unclassified variable must be reported')
  assert.equal(unclassified.overrides, 0, 'and it must not silently count as an override')

  const silent = auditFile('const x = process.env.SOME_OVERRIDE\n', { SOME_OVERRIDE: override })
  assert.equal(silent.offenders.length, 1, 'an input-override without an announcement must be reported')
  assert.equal(silent.overrides, 1, 'the population must still see it')

  /**
   * ── THE ROUND'S DEFECT, EXACTLY (lead §五十五.3) ────────────────────────────────────────────────
   *
   * A variable whose code announces `injected via X` but whose registry entry says `config`. Measured
   * on the previous version: the classification swap turned ten overrides into nine and the criterion
   * stayed green, because it only ever read ONE of the two artifacts.
   */
  const contested = auditFile(
    ['const x = process.env.SOME_VAR', announcedLine('SOME_VAR')].join('\n'),
    { SOME_VAR: { class: 'config', why: 'I decided it is configuration' } },
  )
  assert.equal(contested.offenders.some((line) => /classified "config" but the code announces it/u.test(line)), true,
    'a variable the code announces as an injected input must not be classified config — the two artifacts must agree')
  assert.equal(contested.overrides, 0, 'and it must not be counted as an override either')

  /** `config` may stay silent, but the DECISION must be written down. */
  const configured = auditFile('const x = process.env.DSH_HOME\n', { DSH_HOME: { class: 'config', why: 'real configuration' } })
  assert.deepEqual(configured.offenders, [], 'a config variable with a why and no announcement is compliant')
  const configuredNoWhy = auditFile('const x = process.env.DSH_HOME\n', { DSH_HOME: { class: 'config' } })
  assert.equal(configuredNoWhy.offenders.length, 1, 'a classification without a why is an author-less decision')

  /** Registered gaps must be counted, and an empty reason must not pass as a registered gap. */
  const gap = auditFile('const x = process.env.SOME_OVERRIDE\n' + `if (process.env.SOME_OVERRIDE) ${announcedLine('SOME_OVERRIDE')}\n`, { SOME_OVERRIDE: silentOverride })
  assert.deepEqual(gap.offenders, [], 'a guarded announcement with a registered gap is compliant')
  assert.equal(gap.gaps, 1, 'the gap must be counted so it stays visible')
  const gapNoReason = auditFile('const x = process.env.SOME_OVERRIDE\n' + `if (process.env.SOME_OVERRIDE) ${announcedLine('SOME_OVERRIDE')}\n`, { SOME_OVERRIDE: { class: 'input-override', 'behavioural-evidence': 'none' } })
  assert.equal(gapNoReason.offenders.length, 1, 'a gap without a reason is an oversight wearing a registration')

  /** Evidence must point at something that exists. */
  const danglingEvidence = auditFile(
    'const x = process.env.SOME_OVERRIDE\n' + `if (process.env.SOME_OVERRIDE) ${announcedLine('SOME_OVERRIDE')}\n`,
    { SOME_OVERRIDE: override },
    { exists: () => false },
  )
  assert.equal(danglingEvidence.offenders.some((line) => /does not exist/u.test(line)), true,
    'behavioural-evidence pointing at a missing file must be reported')

  /** The alias extension must not become "any if counts". */
  const wrongGuard = ['const x = process.env.SOME_OVERRIDE', `if (process.env.OTHER) ${announcedLine('SOME_OVERRIDE')}`].join('\n')
  assert.equal(auditInjectionPoints(wrongGuard, { SOME_OVERRIDE: override })[0].guarded, false,
    'a guard on a different variable must not count as guarding this one')
  const unguarded = ['const x = process.env.SOME_OVERRIDE', announcedLine('SOME_OVERRIDE')].join('\n')
  assert.equal(auditInjectionPoints(unguarded, { SOME_OVERRIDE: override })[0].guarded, false,
    'an announcement printed unconditionally must be reported')
  const aliasGuard = ['const flag = process.env.SOME_OVERRIDE', `if (flag) ${announcedLine('SOME_OVERRIDE')}`].join('\n')
  assert.equal(auditInjectionPoints(aliasGuard, { SOME_OVERRIDE: override })[0].guarded, true,
    'a guard through an alias OF THIS variable is correct code and must be accepted (§四十八.2)')

  /** A comment describing the convention is NOT the convention. */
  const commentOnly = ['const x = process.env.SOME_OVERRIDE', `// 生效时打印一行 injected via SOME_OVERRIDE（本注释不算实现）`].join('\n')
  assert.equal(auditInjectionPoints(commentOnly, { SOME_OVERRIDE: override })[0].announced, false,
    'a comment describing the convention must not count as the convention')

  /** Word boundary: `CI` must not be "announced" by a line about `CIRCLE_CI`. */
  const lookalike = `console.error('t: (injected via CIRCLE_CI)')\nconst x = process.env.CI\n`
  assert.equal(auditInjectionPoints(lookalike, { CI: { class: 'config', why: 'x' } })[0].announced, false,
    'a variable name must not be announceable by a LONGER name that contains it')

  /** The bracket form is a read too. */
  const bracketed = auditInjectionPoints("const x = process.env['SOME_OVERRIDE']\n", { SOME_OVERRIDE: override })
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
