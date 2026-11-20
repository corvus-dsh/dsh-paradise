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

import { createLauncher, repairWriteAllowed, repairWriteViolation } from '../index.js'

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