/**
 * ── v280 (B4-0b-2 W3-4 ①): R1 IS NOW ENFORCED INSTEAD OF ASKED FOR ───────────────────────────
 *
 * `SELF_HEALING_PROMPT.md` states R1: 「只输出适配层的代码或命令，绝不要输出 `src/protocol/`」 — with the
 * reason spelled out (changing the contract to accommodate one host makes every other host and plugin
 * follow). Nothing checked it. A model that ignored the sentence had its code COMPILED AND EXECUTED, so
 * the recipe for turning one host upgrade into a rewrite for everyone was one sentence away from
 * running.
 *
 * The enforcement is a WHITELIST of WRITE TARGETS read out of the repair source:
 *   · `src/adapters/…`, `adapters/…`, `harness*.{ts,js,mjs}` — allowed (that is the adapter layer);
 *   · anything else — `R1_VIOLATION`, no tool compiled, nothing written, state goes `degraded`.
 *
 * ── WHY IT INSPECTS WRITE TARGETS AND NOT MENTIONED PATHS ──────────────────────────────────────
 *
 * A repair is ALLOWED to read `src/protocol/` — adapting to the protocol is the job. And a comment such
 * as 「we are NOT touching src/protocol/」 must not trip a gate: this batch has now repaired the
 * "comment satisfied the check" mistake three separate times, and the mirror image (a comment TRIGGERS
 * the check) is the same error. So only the arguments of writing calls count.
 *
 * ── THE LIMIT, STATED ─────────────────────────────────────────────────────────────────────────
 *
 * A repair that computes its target at runtime (`writeFileSync(join(dir, name), …)`) cannot be
 * classified statically. This is a whitelist, not a sandbox — a documented gap is cheaper than a
 * heuristic that misfires, because a gate that cries wolf gets switched off.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createLauncher, repairWriteAllowed, repairWriteViolation } from '../index.js'

const REPO = fileURLToPath(new URL('..', import.meta.url))

const NO_TIMERS = { setIntervalImpl: () => ({}), clearIntervalImpl: () => {} }

function failingProbe() {
  return { name: 'v280', async check() { return { ok: false, reason: 'harness 无响应', detail: 'v280' } } }
}

/** A model that always answers with the given repair source. */
function cannedModel(source) {
  return {
    async generate() {
      return { text: `\`\`\`js\n${source}\n\`\`\`` }
    },
  }
}

/** A tool factory that records what it was asked to compile, and never actually writes anything. */
function recordingTools() {
  const defined = []
  return {
    defined,
    tools: {
      async define(request) {
        defined.push(request)
        return { ok: true }
      },
      async execute() {
        return { isError: false, value: 'RENAMED: sessions.prepare -> sessions.reserve' }
      },
    },
  }
}

function launcherWith(source) {
  const { defined, tools } = recordingTools()
  const launcher = createLauncher({
    probes: [failingProbe()],
    llm: cannedModel(source),
    tools,
    maxRepairAttempts: 1,
    failureThreshold: 1,
    intervalMs: 10,
    ...NO_TIMERS,
  })
  return { launcher, defined }
}

// ── ① a repair that writes into src/protocol/ is REFUSED before compilation ─────────────────

test('v280 ①: 修复想写 src/protocol/ ⇒ R1_VIOLATION，且从未被编译执行', async () => {
  const { launcher, defined } = launcherWith(
    "import { writeFileSync } from 'node:fs'\nwriteFileSync('src/protocol/types.ts', 'export const patched = 1')",
  )
  await launcher.tick()

  const attempt = launcher.report().attempts[0]
  assert.ok(attempt !== undefined, '必须有一次尝试记录')
  assert.match(String(attempt.error), /^R1_VIOLATION：/u, `必须点名 R1 越界；actual: ${attempt.error}`)
  assert.match(String(attempt.error), /src\/protocol\/types\.ts/u, '必须说出被拒的目标路径')
  assert.deepEqual(defined, [], '越界的修复不许进入 tools.define —— 「拒绝」发生在编译之前才算拒绝')

  assert.equal(launcher.getState(), 'degraded', '被拒绝的修复之后，状态必须是 degraded（不该谎称在修复）')
  const states = launcher.report().transitions.map((entry) => entry.to)
  assert.deepEqual(states, ['degraded', 'repairing', 'degraded'], `迁移序列必须如实；actual: ${states.join(' → ')}`)
})

// ── ② an adapter-layer repair still compiles and runs (the gate did not block everything) ────

test('v280 ②: 只写 src/adapters/ 的修复照常编译执行（不是「一律拒绝」）', async () => {
  const { launcher, defined } = launcherWith(
    "import { writeFileSync } from 'node:fs'\nwriteFileSync('src/adapters/dsh/session.ts', 'export const patched = 1')",
  )
  await launcher.tick()

  assert.equal(defined.length, 1, '适配层内的修复必须被编译 —— 否则这道门禁只是把 R1 换成「什么都别修」')
  const attempt = launcher.report().attempts[0]
  assert.doesNotMatch(String(attempt?.error ?? ''), /R1_VIOLATION/u)
})

// ── ③ the predicate itself: a MENTION of the protocol is not a WRITE to it ────────────────

test('v280 ③: 提到 src/protocol（读它、或注释里说明不碰它）不算越界', () => {
  assert.equal(repairWriteViolation("const p = '../src/protocol/types.js'"), undefined, '路径字符串不是写目标')
  assert.equal(
    repairWriteViolation("// 我们不改 src/protocol/ —— 只在适配层把签名对上\nimport x from './session.js'"),
    undefined,
    '注释里说不碰协议层，不许被当成碰了',
  )
  assert.equal(
    repairWriteViolation("readFileSync('src/protocol/types.ts', 'utf8')"),
    undefined,
    '读协议是本职：适配就是去对上它',
  )
  assert.equal(repairWriteViolation("writeFileSync('src/read/disk.ts', 'x')"), '写入目标越界：src/read/disk.ts')
  assert.equal(repairWriteViolation("writeFileSync('harness.ts', 'x')"), undefined, 'harness 自身允许')
  assert.equal(repairWriteAllowed('src/adapters/dsh/tool.ts'), true)
  assert.equal(repairWriteAllowed('C:/other/package/src/adapters/x.ts'), false, '仓库之外的绝对路径不许')
})

// ── ④ the docs must say which rules have teeth (TD-25) ────────────────────────────────────

test('v280 ④: SELF_HEALING_PROMPT 必须写明哪几条规则只有提示词（R2/R3/R5 无判据）', () => {
  /**
   * ── WHY A DOCS ASSERTION BELONGS IN THIS FILE ───────────────────────────────────────────────
   *
   * R1 and R4 are now enforced; R2, R3 and R5 are only sentences. Written as a flat list of five,
   * all five READ like requirements — a reader (or a model) plans as if deleting an export and saying
   * nothing would be caught. It would not be (TD-25).
   *
   * The honest form is a table that names the enforcement status of each rule. This test keeps that
   * table from silently reverting to a flat list, which is how the gap got invisible in the first place.
   */
  const prompt = readFileSync(join(REPO, 'SELF_HEALING_PROMPT.md'), 'utf8')
  assert.match(prompt, /WHICH OF THESE ARE ENFORCED, AND WHICH ARE ONLY ASKED FOR/u, '必须有一段说明强制力的表')
  assert.match(prompt, /R1 只改适配层 \| \*\*机械判据\*\*/u, 'R1 必须标为机械判据')
  assert.match(prompt, /R2 不发明 API \| \*\*仅提示词\*\*/u, 'R2 必须标为仅提示词')
  assert.match(prompt, /R3 说明改名或消失 \| \*\*仅提示词\*\*/u, 'R3 必须标为仅提示词')
  assert.match(prompt, /R5 不碰测试 \| \*\*仅提示词\*\*/u, 'R5 必须标为仅提示词')
  assert.match(prompt, /TD-25/u, 'R3 的缺口必须指向登记条目，否则读者无从追')
  /** And each rule's own paragraph repeats its status — a table alone is scrolled past. */
  assert.match(prompt, /无机械判据 —— 只有这段文字。缺口登记为 TD-25/u, 'R3 段落本身也要说出来')
})