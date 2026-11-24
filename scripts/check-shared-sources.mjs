#!/usr/bin/env node
/**
 * ── check-shared-sources: 哪些脚本必须逐字节相同，以及对【哪几仓】相同 ────────────────────────────
 *
 * 路径：**门禁脚本**（四仓各一份，`scripts/shared-sources.json` 是唯一清单）。
 *
 * WHY (lead §三十七). 起初只有一个平面清单「四仓逐字节相同」。实测否掉了它：
 *
 *   closure / check-cycles / families / move-gate   memory == paradise，而 graft 与 observer 各有版本
 *
 * 一个会把【合法的不同】报成红的门禁，最后一定被人调松。所以作用域写进数据，并写明仓库名 ——
 * 「其余三仓」这种相对说法会把「谁是基准」藏起来。
 *
 * 判据（五条，三条负向）：
 *   ① all4：清单内每个文件在四仓逐字节相同，红时点名【文件 / 哪一仓 / 两边哈希】
 *   ② paradise+memory：按声明的仓库集合比对
 *   ③ **负向** 清单外的文件**允许**不同 — `type-budget.mjs` 必须在清单外，且专门断言
 *   ④ **负向** 清单**自己**不得允许四仓不同（它必须出现在 all4 里）
 *   ⑤ **负向** 作用域**降级**必须红：某文件四仓实测已经相同、却被声明在更窄的作用域 ⇒ 红
 *      （那是「用更弱的判据给自己开脱」）
 *
 * 「仓库不在工作区」不是通过：打印实际比对的仓数，少于 2 时明写 UNVERIFIED。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE = resolve(ROOT, '..')
const MANIFEST_NAME = 'shared-sources.json'
const REPO_NAME = ROOT.split(/[\\/]/u).pop()

const manifestPath = join(ROOT, 'scripts', MANIFEST_NAME)
if (!existsSync(manifestPath)) {
  console.error(`shared-sources: FAILED — 缺少清单 scripts/${MANIFEST_NAME}`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const scopes = manifest.scopes ?? {}

const digestOf = (path) => createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase().slice(0, 16)

/** A declared repo is only comparable when it is on disk in this workspace. */
const present = (repo) => existsSync(join(WORKSPACE, repo, 'scripts'))

const failures = []
const notes = []
const scopeFiles = new Set()

for (const [scopeName, scope] of Object.entries(scopes)) {
  const files = scope.files ?? []
  const repos = scope.repos ?? []
  const available = repos.filter(present)
  for (const file of files) scopeFiles.add(file)

  if (available.length < 2) {
    notes.push(`${scopeName}: UNVERIFIED — 只有 ${available.length} 个声明仓库在工作区（${repos.join(', ')}），无法比对`)
    continue
  }
  if (available.length < repos.length) {
    notes.push(`${scopeName}: 只比对了 ${available.length}/${repos.length} 个仓库（${available.join(', ')}）—— 缺的那些是 UNVERIFIED`)
  }

  for (const file of files) {
    /** `shared-sources.json` lives in scripts/, everything else is a .mjs — same directory. */
    const hashes = new Map()
    for (const repo of available) {
      const path = join(WORKSPACE, repo, 'scripts', file)
      if (!existsSync(path)) {
        failures.push(`${scopeName} / ${file}: ${repo} 缺这个文件（声明里要求它存在）`)
        continue
      }
      hashes.set(repo, digestOf(path))
    }
    if (hashes.size < 2) continue
    const distinct = new Set(hashes.values())
    if (distinct.size === 1) continue
    const rendered = [...hashes].map(([repo, hash]) => `${repo}=${hash}`).join(' ')
    failures.push(`${scopeName} / ${file}: 声明的仓库之间不一致 —— ${rendered}`)
  }
}

/* ③ 负向：清单外必须允许不同，且 type-budget 必须在清单外。 */
for (const file of manifest.mustStayDivergent?.files ?? []) {
  if (scopeFiles.has(file)) {
    failures.push(
      `③ ${file} 出现在清单里，但它必须【保持各仓不同】—— ` +
        `它的 BASELINE / BASELINE_IDENTITIES 是每仓各自的（${manifest.mustStayDivergent?.why ?? ''}）`,
    )
  }
}

/* ④ 负向：清单自己必须被检查，否则「清单少一条」= 那一仓少检查一条而且是绿的。 */
if (!(scopes.all4?.files ?? []).includes(MANIFEST_NAME)) {
  failures.push(
    `④ ${MANIFEST_NAME} 没有出现在 all4 里 —— 清单自己分叉时没有任何东西会红，` +
      '而分叉的表现是「某仓少检查一条」，它看起来是绿的',
  )
}

/* ⑤ 负向：作用域降级。四仓实测已经相同的文件，不许声明在更窄的作用域里。 */
const all4 = scopes.all4?.repos ?? []
const all4Present = all4.filter(present)
if (all4Present.length === 4) {
  for (const [scopeName, scope] of Object.entries(scopes)) {
    if (scopeName === 'all4') continue
    for (const file of scope.files ?? []) {
      const hashes = all4Present.map((repo) => {
        const path = join(WORKSPACE, repo, 'scripts', file)
        return existsSync(path) ? digestOf(path) : 'ABSENT'
      })
      if (new Set(hashes).size === 1) {
        failures.push(
          `⑤ ${file} 四仓实测【已经逐字节相同】，却被声明在 ${scopeName} 这个更窄的作用域里 —— ` +
            '这是用更弱的判据给自己开脱；把它移回 all4',
        )
      }
    }
  }
}

for (const note of notes) console.log(`  note ${note}`)

if (failures.length > 0) {
  console.error('shared-sources: FAILED')
  for (const line of failures) console.error(`  ❌ ${line}`)
  console.error('\n修法：node scripts/sync-shared.mjs（从基准仓复制到其余声明仓库，并在结束前自检）')
  process.exit(1)
}

const summary = Object.entries(scopes)
  .map(([scopeName, scope]) => `${scopeName}=${(scope.files ?? []).length}`)
  .join(' ')
console.log(
  `shared-sources: OK — ${REPO_NAME}: ${summary}; mustStayDivergent=${(manifest.mustStayDivergent?.files ?? []).join(',') || '(none)'}`,
)