#!/usr/bin/env node
/**
 * ── check-runtime-deps: `dependencies` MUST stay empty; dev tooling is an allowlist ──────────────
 *
 * WHY THIS EXISTS (lead §31.3): B4-A says 「依赖为空门禁」, but **no code ever wrote that gate**. So the
 * fact "these plugins declare no runtime dependencies" lived only in prose, and prose cannot fail a push.
 *
 * The distinction that matters, and the one a single "deps are empty" sentence blurs:
 *
 *   dependencies      shipped INTO the host when the plugin loads. Must be EMPTY — a plugin that pulls a
 *                     tree into a user's runtime is a different product. This is what B4-A protects.
 *   devDependencies   used by `npm install` on a DEV machine and in CI. `typescript` belongs here because
 *                     `type-budget.mjs` needs a compiler, and requiring a runner to pre-install one is
 *                     exactly the UNDECLARED environment dependency this whole thread is removing —
 *                     measured: a fresh clone with no inherited node_modules fails the check chain.
 *
 * The measured cause (lead §31.2): `node_modules/typescript` = 5.9.3 existed only at the workspace root,
 * inherited by every repo, declared by none. Locally green, fresh clone red.
 *
 * Usage: node scripts/check-runtime-deps.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The ONLY dev dependency allowed today. Adding one is a decision, so it costs an edit to this list. */
const ALLOWED_DEV = new Set(['typescript'])

/** Exact pins only: `^5.9.3` / `~5.9.3` / `*` would let CI silently run a different compiler. */
const EXACT = /^\d+\.\d+\.\d+$/u

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const runtime = Object.keys(manifest.dependencies ?? {})
const dev = Object.keys(manifest.devDependencies ?? {})
const failures = []

if (runtime.length > 0) {
  failures.push(
    `dependencies 必须为空（那是会被装进用户运行时的东西）：实测 ${runtime.join(', ')}`,
  )
}

const unknownDev = dev.filter((name) => !ALLOWED_DEV.has(name))
if (unknownDev.length > 0) {
  failures.push(
    `devDependencies 出现白名单外的键：${unknownDev.join(', ')}。` +
      '白名单在 scripts/check-runtime-deps.mjs 的 ALLOWED_DEV 里 —— 加依赖是一个决定，改它一次。',
  )
}

const notPinned = dev.filter((name) => !EXACT.test(String(manifest.devDependencies?.[name] ?? '')))
if (notPinned.length > 0) {
  failures.push(
    `devDependencies 必须精确锁版本（不要 ^ / ~ / *）：${notPinned
      .map((name) => `${name}@${manifest.devDependencies[name]}`)
      .join(', ')}`,
  )
}

if (failures.length > 0) {
  console.error('runtime-deps: FAILED')
  for (const line of failures) console.error(`  ❌ ${line}`)
  process.exit(1)
}

console.log(
  `runtime-deps: OK — dependencies empty; devDependencies = ${dev.length === 0 ? '(none)' : `{${dev.join(', ')}}`} all allowlisted and exact-pinned`,
)