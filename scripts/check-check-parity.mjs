#!/usr/bin/env node
/**
 * ── CHECK PARITY: A GATE THAT RUNS LOCALLY MUST RUN ON A PUSH ───────────────────────────────────
 *
 * 五形态之二「门禁不咬」的可执行最小检查。派工单的判据是「CI 必须执行 `npm run check`」——
 * 但那句话有两个问题，所以这里实现的是它的**实质**而不是字面：
 *
 *   1. 有些仓的 `check` 里带着「先 build 再测」的构建步骤，而 CI 把 build 拆成独立 step；
 *      逐字要求「CI 跑 npm run check」会强迫 CI 重复构建，或者强迫 check 不构建。
 *   2. 逐字要求会掩盖真正的缺陷：**两份清单各自维护**才是问题，而「都跑 check」只是一个
 *      恰好能对上的写法。
 *
 * 所以判据是：`package.json` 的 `check` 里每一个 `node scripts/*.mjs` 步骤，都必须在 `ci.yml`
 * 里出现过。少一个 ⇒ 红。这样「本地全绿、CI 从没跑过它」不可能再发生，而两份清单仍然可以是
 * 两份（构建步骤的拆法可以不同）。
 *
 * ── 实测的两个真缺陷（2026-11-21，写这个脚本的时候） ────────────────────────────────────────
 *
 *   dsh-memory · `check` 跑 `check-cycles.mjs`，ci.yml **一次都没有**。
 *                `check` 跑 `check-frontmatter-reads.mjs`，ci.yml **一次都没有**。
 *
 * 前者的后果是依赖环只在本地被发现；后者是**本批刚修的那个缺陷**（三份 `\s*` 拷贝）的门禁——
 * 也就是说：修完之后，如果有人在 CI 之外引入一份新拷贝，**没有任何东西会红**。
 *
 * ── 不覆盖什么（写在脚本里，不留给读者猜） ──────────────────────────────────────────────────
 *
 *   · 它不判断某个 step 在 CI 里「有没有用」——只判断它在不在。
 *   · 它不覆盖 `test` 脚本（`npm test` 与 `node --test` 的对应关系由各仓自己的写法决定）。
 *   · 它不覆盖「CI 的 step 在本地没有对应物」这个方向：CI 可以为了环境原因多跑东西。
 *   · 它不是「CI 真的跑过」的证据 —— 那是 Actions 页面的事，本脚本只证明**接线存在**。
 *
 * 用法：node scripts/check-check-parity.mjs [--json]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * THE ROOT IS THE CALLER'S DIRECTORY (measured, W5-1's lesson): deriving it from `import.meta.url`
 * makes the gate answer about its own repository no matter which tree it was pointed at.
 */
const REPO = process.cwd()
const PKG = join(REPO, 'package.json')
const CI = join(REPO, '.github', 'workflows', 'ci.yml')

/**
 * A step that the `check` script runs but CI may legitimately handle differently.
 *
 * `build.mjs` is the one real case: every repository's CI builds in its own step first, so demanding
 * it appear as `node scripts/build.mjs` in ci.yml would fail four repositories for a cosmetic reason.
 * The exemption is a NAME, not a pattern — and the exemption list is asserted to stay short below.
 */
const NOT_REQUIRED_IN_CI = new Map([
  ['build.mjs', 'the CI builds in its own step (`npm run build` / `npm run build:all`), which is the same module'],
  ['build-harness.mjs', 'same: paradise CI runs `npm run build:all` before the gates'],
])

/** `node scripts/x.mjs` steps of a `check` script, in order, as bare file names. */
export function gateStepsOf(checkScript) {
  const out = []
  for (const raw of String(checkScript ?? '').split('&&')) {
    const step = raw.trim()
    const match = /^node\s+scripts\/([\w.-]+\.mjs)\b/u.exec(step)
    if (match !== null) out.push(match[1])
  }
  return out
}

/**
 * Every script a workflow file REACHES, as bare file names.
 *
 * ── TWO WAYS A WORKFLOW NAMES A SCRIPT ────────────────────────────────────────────────────────
 *
 *   paradise ci.yml   `run: npm run preflight`     ← through a package script
 *   memory  ci.yml    `run: node scripts/check-readme-counts.mjs`   ← directly
 *
 * The first version matched only `scripts/x.mjs`, so paradise was reported as MISSING a gate it
 * actually runs — a FALSE RED. That is the mirror of the defect this file exists to catch.
 *
 * ── AND THEN THE FIX PRODUCED A FALSE GREEN, WHICH IS WORSE ──────────────────────────────────
 *
 * Expanding `npm run <script>` through package.json made the gate match the string wherever it
 * appeared — **including in comments**. `memory/ci.yml` contains, in a comment explaining why the
 * suite runs twice:
 *
 *     # child process, so `npm run check` runs the suite twice — that is a known, accepted cost
 *
 * With comments included, `npm run check` expanded to the ENTIRE `check` script, so every step of it
 * counted as "already in CI" — and the two genuinely missing gates (`check-cycles`,
 * `check-frontmatter-reads`) disappeared from the report. **A comment satisfied the gate.**
 *
 * Measured both ways: without comment stripping, memory reported `6/6 OK`; with it, the two real
 * gaps came back. So comments are stripped BEFORE any matching, exactly as
 * `check-frontmatter-reads.mjs` skips comment lines for the same reason: a check that a comment can
 * satisfy is not a check.
 */
const stripComments = (text) =>
  String(text)
    .split(/\r?\n/u)
    .filter((line) => !/^\s*#/u.test(line))
    .join('\n')

export function mentionedInCi(ciText, pkgScripts = {}) {
  /** Strip comments FIRST: everything below must see only what the workflow executes. */
  const live = stripComments(ciText)
  const direct = [...live.matchAll(/(?<![\w/])scripts\/([\w.-]+\.mjs)/gu)].map((match) => match[1])
  const viaNpm = []
  for (const match of live.matchAll(/npm\s+run\s+([\w:-]+)/gu)) {
    const body = String(pkgScripts?.[match[1]] ?? '')
    for (const inner of body.matchAll(/scripts\/([\w.-]+\.mjs)/gu)) viaNpm.push(inner[1])
  }
  return new Set([...direct, ...viaNpm])
}

/**
 * The comparison.
 *
 * Three distinct failures, because they mean three different things:
 *
 *   missing  — a gate runs locally and never on a push ⇒ refuse (this is the whole point)
 *   orphan   — ci.yml names a script that is not on disk ⇒ refuse (a rename that CI still calls)
 *   widened  — the exemption list grew beyond the two build steps ⇒ refuse (an exemption is a hole
 *              with a label; a third one needs its own argument)
 */
export function evaluate({ gateSteps, ciMentions, onDisk, exemptions }) {
  const missing = gateSteps.filter((name) => !ciMentions.has(name) && !exemptions.has(name))
  const orphans = [...ciMentions].filter((name) => !onDisk.has(name))
  const widened = [...exemptions.keys()].filter((name) => !['build.mjs', 'build-harness.mjs'].includes(name))
  return { missing, orphans, widened }
}

function main() {
  let pkg
  let ciText
  try {
    pkg = JSON.parse(readFileSync(PKG, 'utf8'))
  } catch (error) {
    console.log(`check-parity: FAILED TO START — cannot read ${PKG}: ${String(error?.message ?? error)}`)
    return 1
  }
  try {
    ciText = readFileSync(CI, 'utf8')
  } catch {
    /**
     * A repository with no workflow cannot answer this question. Refuse rather than pass: 「not
     * found」 and 「nothing to check」 are different facts (this batch's §〇 17).
     */
    console.log(`check-parity: FAILED TO START — ${CI} does not exist, so 「本地与 CI 一致」 cannot be answered`)
    return 1
  }

  const gateSteps = gateStepsOf(pkg?.scripts?.check)
  if (gateSteps.length === 0) {
    console.log('check-parity: FAILED TO START — `scripts.check` names no `node scripts/*.mjs` step')
    return 1
  }

  const onDisk = new Set(
    (() => {
      try {
        return readdirSafe(join(REPO, 'scripts'))
      } catch {
        return []
      }
    })(),
  )
  const verdict = evaluate({
    gateSteps,
    ciMentions: mentionedInCi(ciText, pkg?.scripts),
    onDisk,
    exemptions: NOT_REQUIRED_IN_CI,
  })

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ gateSteps, ci: [...mentionedInCi(ciText, pkg?.scripts)].sort(), ...verdict }, null, 2))
    return verdict.missing.length + verdict.orphans.length + verdict.widened.length === 0 ? 0 : 1
  }

  const problems = []
  for (const name of verdict.missing) {
    problems.push(
      `${name} runs in \`npm run check\` but is NOT a step in ci.yml — ` +
        '「本地全绿而 CI 从没跑过它」正是这一条要挡的形状。接入 CI，或把它从 check 里去掉。',
    )
  }
  for (const name of verdict.orphans) {
    problems.push(`${name} is named by ci.yml but does not exist under scripts/ — a rename CI still calls`)
  }
  for (const name of verdict.widened) {
    problems.push(
      `${name} is in NOT_REQUIRED_IN_CI but is not a build step — ` +
        'the exemption list may only hold the two build scripts; a third needs its own argument',
    )
  }

  if (problems.length === 0) {
    console.log(
      `check-parity: OK — all ${gateSteps.length} gate step(s) of \`check\` are wired in ci.yml ` +
        `(${NOT_REQUIRED_IN_CI.size} build step(s) exempt by name)`,
    )
    return 0
  }
  console.log(`check-parity: ${problems.length} problem(s)`)
  for (const problem of problems) console.log(`  ${problem}`)
  return 1
}

/** `readdirSync`, imported lazily so a missing directory is a catchable fact rather than a crash. */
function readdirSafe(dir) {
  // eslint-disable-next-line n/no-sync -- a gate may be synchronous; it runs once and exits
  return readdirSyncImpl(dir)
}

import { readdirSync as readdirSyncImpl } from 'node:fs'

process.exitCode = main()