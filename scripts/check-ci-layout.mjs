#!/usr/bin/env node
/**
 * ── check-ci-layout: the three `mv ../dsh-*` lines have a PRECONDITION, and it was unchecked ────
 *
 * WHAT THE LAYOUT ASSUMES. Each `ci.yml` checks siblings out into `.siblings/<repo>` and then does
 *
 *     mv .siblings/dsh-paradise ../dsh-paradise
 *
 * `..` is the PARENT of `$GITHUB_WORKSPACE`, which equals the repository root **only because the self
 * checkout has no `path:`**. Give the self checkout a `path: self` and the repository lands in
 * `$GITHUB_WORKSPACE/self`, so `..` is still the workspace — and every `mv` lands one directory too high,
 * outside the workspace where the probes look.
 *
 * WHY A COMMENT WOULD NOT DO (lead §三十五.2): a comment is not executed. The next person who adds `path:`
 * will not read it and CI will not turn red. Measured state when this was written: all four repositories
 * have `hasPath=False` on their self checkout — true today, enforced nowhere.
 *
 * WHY IT MATTERS MORE THAN IT LOOKS: when those `mv`s miss, the symptom is **253 layout failures**, which
 * took two rounds to prove were not product defects. The next person will not have that conclusion in
 * hand, and will start looking for 253 bugs.
 *
 * RULES
 *   ① a checkout with NO `repository:` (the self checkout) must NOT have `path:`
 *   ② NEGATIVE: a checkout WITH `repository:` (a sibling) MUST have `path:` — a sibling that lands on top
 *      of the repository itself would overwrite files silently, which is worse than a missing directory
 *   ③ when ① fails, the message NAMES the `mv` lines that will land in the wrong place
 *
 * Usage: node scripts/check-ci-layout.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CI = join(ROOT, '.github', 'workflows', 'ci.yml')

let text
try {
  text = readFileSync(CI, 'utf8')
} catch {
  console.log('ci-layout: OK — no ci.yml in this repository, nothing to check')
  process.exit(0)
}

const lines = text.split('\n')

/** Every `actions/checkout` step, with the `repository:`/`path:` it declares within the next 10 lines. */
const checkouts = []
lines.forEach((line, index) => {
  if (!line.includes('actions/checkout@')) return
  let repository = null
  let path = null
  for (let i = index; i < Math.min(lines.length, index + 12); i += 1) {
    const repo = /^\s+repository:\s*(\S+)/u.exec(lines[i])
    if (repo !== null) repository = repo[1]
    const p = /^\s+path:\s*(\S+)/u.exec(lines[i])
    if (p !== null) path = p[1]
    /* Stop at the next step so a following checkout's fields are not attributed to this one. */
    if (i > index && /^\s+- (name|uses):/u.test(lines[i])) break
  }
  checkouts.push({ line: index + 1, repository, path })
})

const mvLines = lines
  .map((line, index) => ({ line: index + 1, text: line.trim() }))
  .filter((entry) => /^mv\s+\.siblings\//u.test(entry.text))

const failures = []

for (const entry of checkouts) {
  const self = entry.repository === null
  if (self && entry.path !== null) {
    failures.push(
      `ci.yml:${entry.line} 自家仓 checkout 带了 \`path: ${entry.path}\` —— 这三行 mv 会搬到错的位置：\n` +
        mvLines.map((mv) => `      ci.yml:${mv.line}  ${mv.text}`).join('\n') +
        '\n      `..` 只有在自家 checkout 位于 workspace 根时才等于「兄弟仓的父目录」。',
    )
  }
  if (!self && entry.path === null) {
    failures.push(
      `ci.yml:${entry.line} 兄弟仓 checkout（${entry.repository}）没有 \`path:\` —— 它会落在仓库根上，` +
        '覆盖本仓文件，比「缺目录」更糟',
    )
  }
}

if (failures.length > 0) {
  console.error('ci-layout: FAILED')
  for (const line of failures) console.error(`  ❌ ${line}`)
  process.exit(1)
}

const siblings = checkouts.filter((entry) => entry.repository !== null).length
console.log(
  `ci-layout: OK — self checkout has no path:${mvLines.length} \`mv ../dsh-*\` line(s) resolve to the parent of the workspace; ${siblings} sibling checkout(s) each declare a path:`,
)
