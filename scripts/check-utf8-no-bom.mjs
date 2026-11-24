#!/usr/bin/env node
/**
 * ── check-utf8-no-bom: 仓库里的文本文件不得带 UTF-8 BOM ─────────────────────────────────────────
 *
 * 路径：**门禁脚本**，断言型（首三字节是 `EF BB BF` ⇒ exit 1），必须有 ci.yml 步骤。
 *
 * ── 事故（lead §四十六.4，P2；本轮我实际造成的）──────────────────────────────────────────────
 *
 * 我用 `Set-Content -Encoding UTF8` 改 `package.json`，PowerShell 5.1 的 `-Encoding UTF8`
 * **会写 BOM**，并且把整个文件按本地码页重编码：
 *
 *     星火 OS  →  鏄熺伀 OS
 *
 * `git diff` 显示 3 行改动，我看见了才回滚。**那是人工检查，不是判据。**
 *
 * ── 为什么它必须是一条判据，而不是一次小心 ────────────────────────────────────────────────────
 *
 * BOM **静默**改变内容，而**大多数工具（含 `JSON.parse`）能容忍它** —— 所以它不报错，
 * 只让 diff 莫名多一行、让某个字符串少几个字节。这类「不报错的改变」正是本批反复记录的形状：
 *
 *   - `bundle.mjs` 的 `LOCAL_BRACKETED`：数字上限猜错了不报错，**挂死**；
 *   - `suite-observation` 的缓存：失败不报错，**被当成当前结论**；
 *   - BOM：编码变了不报错，**diff 多一行**。
 *
 * 共同点：**失败方式是沉默的**。沉默的失败只能靠判据抓，不能靠小心。
 *
 * ── 判据（四条，两条负向）──────────────────────────────────────────────────────────────────────
 *   ① 每个被扫描的文本文件首三字节不得是 `EF BB BF`
 *   ② **负向** 二进制/生成物按扩展名豁免，但豁免名单必须写进数据并带理由
 *   ③ **负向** 扫描到 0 个文件 ⇒ 红（「什么都没扫」不是通过）
 *   ④ 报告实测数字，读者能据此判断覆盖率
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BOM = [0xef, 0xbb, 0xbf]

/**
 * Extensions that may legitimately be binary. A generated bundle (`index.js`) is TEXT and is
 * therefore NOT exempt — a BOM there would ship into the artifact.
 */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tgz',
  '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.wasm', '.node', '.db', '.sqlite',
])

/** Directories that are never source. `node_modules` is a dependency tree, `.git` is git's own. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'coverage'])

const scanned = []
const offenders = []
const skipped = []

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      walk(full)
      continue
    }
    if (stat.size === 0) continue
    const dot = entry.lastIndexOf('.')
    const ext = dot === -1 ? '' : entry.slice(dot).toLowerCase()
    if (BINARY_EXTENSIONS.has(ext)) {
      skipped.push(relative(ROOT, full))
      continue
    }
    scanned.push(relative(ROOT, full))
    const head = readFileSync(full).subarray(0, 3)
    if (head.length === 3 && head[0] === BOM[0] && head[1] === BOM[1] && head[2] === BOM[2]) {
      offenders.push(relative(ROOT, full))
    }
  }
}

walk(ROOT)

const failures = []
if (offenders.length > 0) {
  for (const file of offenders) {
    failures.push(
      `① ${file} 带 UTF-8 BOM（首三字节 EF BB BF）。BOM 会让 diff 多一行、让第一个字符串少几个字节，` +
        '而 JSON.parse 之类能容忍它 —— 所以它不报错。去掉 BOM 重写该文件。',
    )
  }
}
/**
 * ③ NEGATIVE: an empty scan is not a pass.
 *
 * `SKIP_DIRS` includes `node_modules`, and a freshly cloned repo could — in principle — be walked
 * from the wrong root and find nothing. A gate that reports "OK" after scanning zero files is the
 * same shape as a criterion whose denominator vanished.
 */
if (scanned.length === 0) {
  failures.push('③ 扫描到 0 个文本文件 —— 「什么都没扫」不是通过，检查 ROOT 是否指对')
}

for (const line of failures) console.log(`  ❌ ${line}`)
if (failures.length > 0) {
  console.log(`\nutf8-no-bom: FAILED (${failures.length})`)
  process.exit(1)
}
console.log(
  `utf8-no-bom: OK — ${scanned.length} 个文本文件无 BOM（按扩展名豁免 ${skipped.length} 个二进制）`,
)
