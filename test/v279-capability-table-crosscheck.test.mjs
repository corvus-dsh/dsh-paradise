/**
 * ── v279 (B4-0b-2 W3-4 ②): THE CAPABILITY TABLE IS HAND-WRITTEN — NOW IT IS CROSS-CHECKED ────────
 *
 * `REQUIRED_HOST_CAPABILITIES` is a hand-maintained list of five entries, and nothing compared it
 * against the code. Measured on the day this test was written: the source contains EIGHT literal
 * `service(ctx, 'x', 'y')` call sites, and three of them — `sessions.get` (twice), `tools.execute`,
 * `workspaceRegistry.resolveByPath` — were in no table at all. A host upgrade that removed any of them
 * would have produced a named refusal at CALL time (that part is good), but the boot-time drill — the
 * one place that is supposed to catch an upgrade — would have said the host was fine.
 *
 * ── THE TWO DIRECTIONS, AND WHY THE EXEMPTION LIVES AT THE CALL SITE ────────────────────────────
 *
 *   forward:  every call site is either IN the table, or carries `capability-optional:` with a reason;
 *   reverse:  every table entry is actually called somewhere (a requirement nothing calls is a claim).
 *
 * The reason is recorded NEXT TO THE CALL, not in a second central list — because a central exemption
 * list is the same defect one level up: another hand-written claim that drifts from the code. The
 * annotation is only believed when it is adjacent to what it describes, and this test reads it there.
 *
 * ── COMMENTS ARE STRIPPED BEFORE SCANNING, AND THAT MATTERS ─────────────────────────────────────
 *
 * `trigger.ts` explains its history with the sentence 「`service(ctx, 'remote', 'session')` looks for a
 * remote whose `session` property is a FUNCTION」. A naive scanner counts that as a call site — a
 * COMMENT creating a requirement. This batch has already been bitten twice by checks a comment could
 * satisfy; here the danger is the mirror image, and the fix is the same discipline: strip first.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { REQUIRED_HOST_CAPABILITIES } from '../index.js'

const REPO = fileURLToPath(new URL('..', import.meta.url))

/** Strip block and line comments so prose can neither satisfy nor create a requirement. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, ' '))
    .replace(/^\s*\/\/.*$/gmu, '')
    .replace(/(^|[^:])\/\/[^\n]*$/gmu, (_match, prefix) => prefix)
}

function everySourceFile(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) everySourceFile(path, out)
    else if (entry.endsWith('.ts')) out.push(path)
  }
  return out
}

const TABLE = new Set(REQUIRED_HOST_CAPABILITIES.map((entry) => `${entry.service}.${entry.method}`))

/** Every literal two-argument service resolution, with the file and line that made it. */
function callSites() {
  const found = []
  for (const file of everySourceFile(join(REPO, 'src'))) {
    const raw = readFileSync(file, 'utf8')
    const lines = raw.split(/\r?\n/u)
    const stripped = stripComments(raw).split(/\r?\n/u)
    stripped.forEach((line, index) => {
      const match = /service\(\s*ctx\s*,\s*'([A-Za-z]+)'\s*,\s*'([A-Za-z]+)'\s*\)/u.exec(line)
      if (match === null) return
      /**
       * The annotation is read from the RAW text — it is a comment by nature. The lookup window covers
       * the line itself plus the eight above it, which is where a `capability-optional:` block sits.
       */
      const window = lines.slice(Math.max(0, index - 8), index + 1).join('\n')
      found.push({
        key: `${match[1]}.${match[2]}`,
        file: relative(REPO, file).replaceAll('\\', '/'),
        line: index + 1,
        optionalReason: /capability-optional:([^\n]*(?:\n\s*\*[^\n]*)*)/u.exec(window)?.[1]?.trim() ?? '',
      })
    })
  }
  return found
}

test('v279 ①: 正向 —— 每个 service(ctx,…) 调用点要么在表里，要么就地写了 capability-optional 理由', () => {
  const sites = callSites()
  assert.ok(sites.length >= 8, `必须扫到至少 8 个调用点（扫不到就说明扫描失效）；actual: ${sites.length}`)

  const unaccounted = sites.filter((site) => !TABLE.has(site.key) && site.optionalReason.length < 12)
  assert.deepEqual(
    unaccounted.map((site) => `${site.file}:${site.line} ${site.key}`),
    [],
    `这些调用点既不在能力表里，也没有就地理由 —— 宿主升级删掉它们时，引导期会说「宿主没问题」：\n${unaccounted
      .map((site) => `  ${site.file}:${site.line} ${site.key} (reason: ${JSON.stringify(site.optionalReason)})`)
      .join('\n')}`,
  )
})

test('v279 ②: 反向 —— 能力表里每一条都真的被调用（没人调用的要求是声明，不是事实）', () => {
  const called = new Set(callSites().map((site) => site.key))
  const stale = [...TABLE].filter((key) => !called.has(key))
  assert.deepEqual(stale, [], `表里这些条目在源码中找不到调用点 —— 它们只是声明：${stale.join(', ')}`)
})

test('v279 ③: 扫描会剥掉注释 —— 注释里的 service(ctx,…) 不许被当成调用点', () => {
  const sites = callSites()
  const fromComments = sites.filter((site) => site.file === 'src/adapters/dsh/trigger.ts' && site.key === 'remote.session')
  assert.deepEqual(
    fromComments.map((site) => site.line),
    [],
    'trigger.ts 里那句历史解释含 service(ctx, \'remote\', \'session\')，它是**注释**，不许被算成一条要求',
  )

  /** And the reverse check must still see the real call in that same file (`service(ctx, 'remote')`). */
  const trigger = stripComments(readFileSync(join(REPO, 'src', 'adapters', 'dsh', 'trigger.ts'), 'utf8'))
  assert.match(trigger, /service\(ctx, 'remote'\)/u, '一句话被剥掉不等于整个文件被剥掉')
})