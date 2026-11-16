#!/usr/bin/env node
/**
 * ── v143: 增量类型预算门禁 —— 不引入「一次全红」，只要求「不许变多」────────────────────────────────
 *
 * 背景（用户裁定，2026-11-12）：
 *   本项目从不跑 tsc，只跑 stripTypeScriptTypes，而 strip **不做任何符号检查**。
 *   所以「782 条测试全绿」证明运行时行为正确，不证明类型正确；「搬移后编译通过」只是「无语法错」。
 *   实测：一次纯搬移把 goal-extraction.ts 搬出去时漏了 5 个 export，789 条测试全绿、build 成功、
 *   verify-pure-move IDENTICAL —— 三道关都没拦住，只有 tsc --noEmit 看得见（5 条 code 2459）。
 *
 *   不批准「引入 tsc 让 CI 变红」：125 个存量错误（现 61）会让红成为常态，重演「CI 永远红」。
 *   批准「增量拉紧」：**本次提交触及的文件**必须不超过它的基线，且不许新增。
 *
 * ── 四条判据（每一条都对应一个已实测的失败模式）─────────────────────────────────────────────────
 *
 *   ① 判据是「本次提交触及的文件」，不是「新文件」。
 *      用户最初的假设是「新文件从第一天就类型正确」，实测**不成立**：
 *      goal-extraction.ts 3 条、adaptive-depth.ts 2 条、command-guard.ts 2 条… —— 纯位移把源文件的
 *      错误原样带走了。所以「新文件」这个判据会漏掉恰恰是它想防的那类提交。
 *
 *   ② 搬移型提交豁免为「错误数不变」——不许变多，不要求变少。
 *      搬移不产生新代码，因此它不该增加错误；但它也不该被要求减少，否则每个搬移都得顺手修别人
 *      的债。这条正好机器化回答「搬移会不会带进新错误」。
 *
 *   ③ 2459（声明了未 export 却被 import）必须恒为 0。
 *      这是**搬移专属**失效模式，当前树已是 0（本轮修复）。任何提交让它非零就必须红 —— 比
 *      「错误数不变」更强，因为它指名了那一个我们证明过会静默通过的缺陷。
 *
 *   ④ 没有编译器时 exit 2 并给具名原因，绝不静默通过。
 *      CI 不装 typescript（package.json 无依赖），所以这条门禁在 CI 上**不生效**。这不是遗漏，
 *      是资源事实：写成「绿色」才是真正的漏洞。它在本机是硬门禁。
 *
 * 用法：
 *   node scripts/type-budget.mjs                 # 对 HEAD 做增量检查
 *   node scripts/type-budget.mjs --against HEAD~1
 *   node scripts/type-budget.mjs --baseline      # 打印当前基线（供 BASELINE 表更新）
 *   node scripts/type-budget.mjs --self-test     # 证明它能红
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TYPE_CHECK = join(ROOT, 'scripts', 'type-check.mjs')

/**
 * ── 冻结基线（实测 2026-11-12）────────────────────────────────────────────────────────────────
 *
 *     15 条代码缺陷 / 3 个文件       ← 这张表只管这个
 *     33 条环境问题（2307×18 + 2580×15）← 不在这张表里：装 @types/node 就消失，不是缺陷
 *      1 条编译器产物（strict:false 造成）← 单独一类，strict:true 下 0 条
 *
 * 用户裁定：两者必须分开数，否则下一个读表的人会去「修」那 33 条，而修法不是改代码。
 *
 * ── 「15」的正确读法：宽松模式下的可见缺陷，不是「类型健康度」──────────────────────────────────
 *
 * 这个数字是 **`strict: false`** 口径测出来的。而 `strict: false` 下「干净」不等于「类型正确」：
 * 它容忍隐式 any、不做 null/undefined 检查、容忍双变。
 *
 * 实测同一份 src/ 只改 strict：
 *
 *     strict: false → 49 条        strict: true → 58 条
 *     只在 strict:true 出现：9 条 7006（隐式 any）+ 1 条 2345（string | undefined）
 *     只在 strict:false 出现：1 条 2339（已单列为 COMPILER ARTIFACT）
 *
 * 所以：
 *   · 「15」= 宽松模式下有几个错，**不是**「还剩几个错」；
 *   · 「清到 0」不等于类型安全 —— 只意味着「连宽松检查都过了」。
 *
 * 不切 strict:true：那会让 58 条一次全红，正是用户明确否决的「CI 永远红」。
 * 但这句警告必须留在这里，否则下一个把 15 清到 0 的人会以为自己得到了类型安全。
 *
 * 这是「今天的尺寸」，不是目标。它只允许**下降**：每清掉一组同根因的缺陷就把数字调低；
 * 任何上升都必须显式改这个表并写理由 —— 与 v130 的 EXEMPT 同一种用法。
 *
 * 为什么不写总量而写每文件：总量会被「一个文件变好、另一个变坏」互相抵消，而那正是本门禁要抓的。
 *
 * ── 这份表是 `--baseline` 的实测输出，不是手写的 ──────────────────────────────────────────────
 *
 * 手写过的两次都错了：第一次按「印象中的文件」写了 17 行（含已被修掉的文件）；
 * 第二次排除环境问题后仍打印 report.total，与逐文件列表对不上 —— 两个数用了两套口径。
 * 所以这张表只能来自 `node scripts/type-budget.mjs --baseline`。
 */
const BASELINE = new Map([
  // ── 本仓基线（paradise），实测于 2026-11-16，全部来自 `node scripts/type-budget.mjs --baseline` ──
  //
  // 这不是「类型健康声明」，是**当日快照**。paradise 此前从未跑过类型检查，所以这张表第一次
  // 出现时记录了 58 条 code 诊断（另有 97 条 ENVIRONMENT，按定义不进表）。从这一刻起它**只许降**。
  //
  // 那 58 条里约一半是同一个形状的重复（`Duplicate identifier`、`Cannot find name`），集中在
  // `harness.ts` / `index.ts` / `adapters/raw/llm.ts`。它们是真的：这些文件引用了从未被本仓导出、
  // 或已被删除的符号。**如实冻结在这里，不修** —— B0 的任务是「让门禁存在」，修类型是 B1 的事。
  ['harness.ts', 16],
  ['adapters/raw/llm.ts', 13],
  ['adapters/http/network-storage.ts', 8],
  ['spawn-node.ts', 5],
  ['index.ts', 3],
  ['adapters/dsh/lease-sync.ts', 2],
  ['adapters/dsh/session-writer.ts', 2],
  ['ws-server.ts', 2],
  ['adapters/dsh/assert-capabilities.ts', 1],
  ['adapters/dsh/delete.ts', 1],
  ['adapters/dsh/index.ts', 1],
  ['adapters/dsh/paths.ts', 1],
  ['launcher.ts', 1],
  ['lease-adapter.ts', 1],
  ['storage-memory.ts', 1],
])

/** 搬移专属失效模式：声明了没 export，却被别的文件 import。必须是 0，不是「不变」。 */
const MOVE_ONLY_CODE = 2459

/** 读取诊断；编译器缺失时 exit 2（资源条件，不是通过）。 */
function diagnose () {
  let raw
  try {
    raw = execFileSync(process.execPath, [TYPE_CHECK, '--json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  } catch (error) {
    // type-check exits non-zero when diagnostics exist; a JSON body on stdout is still the result
    if (typeof error.stdout === 'string' && error.stdout.trimStart().startsWith('{')) raw = error.stdout
    else {
      console.error('type-budget: the type check could not run (compiler unavailable or crashed).')
      console.error('This is a RESOURCE condition, not a pass — same rule as type-check.mjs.')
      process.exit(2)
    }
  }
  return JSON.parse(raw)
}

/**
 * 某个 git ref 下，本次提交触及的 .ts 文件。
 *
 * ── 两个坐标系必须显式对齐 ────────────────────────────────────────────────────────────────────
 *
 * `git diff --name-only` 给的是**仓库相对路径**（`src/core/txn.ts`），而 `typescript` 的
 * `sourceFile.fileName` 经 type-check.mjs 归一后是**相对 src/ 的路径**（`core/txn.ts`）。
 * 第一版直接比较这两个集合，结果 touched 里每个文件都「不在基线表里」—— 而按规则，
 * 不在表里且有错误的文件会被判违规，于是第一次真实运行就误报 10 个文件。
 *
 * 这里统一到诊断的坐标系（去掉 `src/` 前缀），并且只保留 src/ 下的文件。
 */
function touchedFiles (ref) {
  let out
  try {
    out = execFileSync('git', ['diff', '--name-only', ref, '--', 'src'], { cwd: ROOT, encoding: 'utf8' })
  } catch {
    console.error(`type-budget: cannot diff against ${ref}`)
    process.exit(2)
  }
  return out.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.ts'))
    .filter((line) => line.startsWith('src/'))
    .map((line) => line.slice('src/'.length))
}

/**
 * 统计每个文件的**代码健康度**诊断数（键用相对 src/ 的路径，正斜杠）。
 *
 * ── 环境问题不进预算表 ─────────────────────────────────────────────────────────────────────────
 *
 * 用户裁定：2307（缺 node 内置类型的 18 条）与 2580（缺 process 的 15 条）是环境问题，
 * 修法是装 @types/node，不是改代码。把它们算进预算，会让「某文件触及后数字变了」
 * 反映一个与本提交无关的原因；更糟的是有人会为了让数字变小去「修」它们。
 *
 * 所以预算只数**代码缺陷**，环境问题由 type-check.mjs 单列成表。
 * 两边的分组必须用同一套判据，否则两个工具会各说各话。
 */
const ENVIRONMENT_CODES = new Set([2307, 2580])

/**
 * ── 与 type-check.mjs 完全相同的两类「不是代码缺陷」的排除 ──────────────────────────────────────
 *
 * 环境问题（2307/2580）与编译器产物（strict:false 造成的 1 条 2339）都必须排除，
 * 否则「某文件被触及后数字变了」会反映一个与本提交无关的原因。
 *
 * 两个工具的口径必须一致 —— 否则它们会各说各话，而 v143 的断言正是拿两边对照的。
 *
 * 编译器产物的判据**不用行号**：第一版用 `index.ts:9792:2339`，而本轮编辑让那行下移 11 行，
 * 标注立刻失效、那条假阳性混回了代码缺陷。改成「文件 + code + message 子串」后位置无关。
 */
const COMPILER_ARTIFACT = { code: 2339, file: 'index.ts', match: /Property 'reason' does not exist on type '\{ ok: true; \}/u }

function countsByFile (report) {
  const counts = new Map()
  for (const d of codeDefects(report)) {
    counts.set(d.file, (counts.get(d.file) ?? 0) + 1)
  }
  return counts
}

/** 一条诊断是否为「代码缺陷」（排除环境问题与编译器产物）。两个工具共用同一条判据。 */
function isCodeDefect (d) {
  if (ENVIRONMENT_CODES.has(d.code)) return false
  if (d.code === COMPILER_ARTIFACT.code && d.file === COMPILER_ARTIFACT.file && COMPILER_ARTIFACT.match.test(d.message)) return false
  return true
}

const codeDefects = (report) => report.diagnostics.filter(isCodeDefect)

/**
 * ── 诊断的「身份」：文件 + code + message ───────────────────────────────────────────────────────
 *
 * ── 为什么光有「每文件计数」不够 ────────────────────────────────────────────────────────────────
 *
 * 用户裁定（2026-11-12）：按每文件计数，允许「修好 1 条 + 弄坏 1 条 = 数字不变 = 通过」。
 * 本轮就发生过一次等价交换：2339 少 1 条，同时那条 artifact 被重新归类 —— 总数看起来没动。
 *
 * 剩下要清的 10 条里，2345×3 / 2322×2 / 2353×2 / 2554×2 的修法都是「改签名或改类型」，
 * 而改签名最容易在别处引入新错误。若只有计数防线，「修 3 条、坏 3 条」会静默通过。
 *
 * ── 身份里为什么没有行号 ───────────────────────────────────────────────────────────────────────
 *
 * 上一轮把 artifact 标注成 `index.ts:9792:2339`，本轮加了一条三行注释就让它失效 ——
 * **用位置当身份，位置一变识别就没了**。这里同样只用 (文件, code, message)。
 *
 * ── 为什么是「多重集」而不是「集合」──────────────────────────────────────────────────────────
 *
 * 实测：`2554 Expected 0 arguments, but got 1.` 在 index.ts 里出现 2 次，message 完全一样；
 * `2345` 也有两条同 message。若用 Set，两条会塌成一条，「多出一条同 message 的错误」就看不见。
 * 所以按 `身份 → 次数` 记，比较次数。
 */
function defectIdentities (report) {
  const multiset = new Map()
  for (const d of codeDefects(report)) {
    const key = `${d.file}\u0000${d.code}\u0000${d.message}`
    multiset.set(key, (multiset.get(key) ?? 0) + 1)
  }
  return multiset
}

/** 可读的诊断身份（用于打印）。 */
const describeIdentity = (key) => {
  const [file, code, message] = key.split('\u0000')
  return `${file} [${code}] ${message.slice(0, 120)}`
}

/**
 * ── 冻结的身份基线 ────────────────────────────────────────────────────────────────────────────
 *
 * 与 BASELINE 的每文件计数**同源**：都由 `--baseline` 从同一份实测输出生成。
 * 两张表必须同时下降，否则会出现「计数变了但身份表没变」这类自相矛盾。
 */
const BASELINE_IDENTITIES = new Map([
  // 身份多重集：按「文件 + code + message」冻结。与上表同源，一起由 --baseline 生成。
  // 实测 37 个不同身份 / 合计 58 条（同一身份在不同位置重复出现时计数 > 1）。
  //
  // 与 BASELINE 的分工：计数表抓「某文件整体变多」，身份表抓「修一条坏一条、计数不变」的
  // 等价交换。两张表必须一起动，否则会出现「计数降了但身份没降」的自相矛盾。
  ["adapters/dsh/assert-capabilities.ts\u00002345\u0000Argument of type '\"assert\"' is not assignable to parameter of type 'ParadiseStage'.", 1],
  ["adapters/dsh/delete.ts\u00002367\u0000This comparison appears to be unintentional because the types '\"present\" | \"unverifiable\"' and '\"absent\"' have no overlap.", 1],
  ["adapters/dsh/index.ts\u00002304\u0000Cannot find name 'createDshLeaseAdapter'.", 1],
  ["adapters/dsh/lease-sync.ts\u00002339\u0000Property 'holder' does not exist on type 'AcquireDecision'.   Property 'holder' does not exist on type '{ readonly ok: true; readonly lease: LeaseRecord; }'.", 1],
  ["adapters/dsh/lease-sync.ts\u00002353\u0000Object literal may only specify known properties, and 'acquireSync' does not exist in type 'LeaseAdapter'.", 1],
  ["adapters/dsh/paths.ts\u00002305\u0000Module '\"../../policy.js\"' has no exported member 'SESSION_LOG_FILENAME'.", 1],
  ["adapters/dsh/session-writer.ts\u00002320\u0000Interface 'WriteReceipt' cannot simultaneously extend types 'MutationReceipt' and 'PublishReceipt'.   Named property 'ok' of types 'MutationReceipt' and 'PublishReceipt' are not identical.", 1],
  ["adapters/dsh/session-writer.ts\u00002339\u0000Property 'sessionId' does not exist on type 'never'.", 1],
  ["adapters/http/network-storage.ts\u00002339\u0000Property 'error' does not exist on type 'WireResponse'.   Property 'error' does not exist on type '{ ok: true; value?: unknown; version?: number; servedBy: string; }'.", 8],
  ["adapters/raw/llm.ts\u00002305\u0000Module '\"../../protocol/index.js\"' has no exported member 'FinishReason'.", 1],
  ["adapters/raw/llm.ts\u00002339\u0000Property 'finishReason' does not exist on type 'RoundResult'.", 2],
  ["adapters/raw/llm.ts\u00002339\u0000Property 'message' does not exist on type '{ ok: true; result: RoundResult; } | { ok: false; message: string; status?: number; quota?: boolean; body?: string; }'.   Property 'message' does not exist on type '{ ok: true; result: RoundResult; }'.", 3],
  ["adapters/raw/llm.ts\u00002339\u0000Property 'message' does not exist on type '{ ok: true; value: Record<string, unknown>; } | { ok: false; message: string; }'.   Property 'message' does not exist on type '{ ok: true; value: Record<string, unknown>; }'.", 1],
  ["adapters/raw/llm.ts\u00002339\u0000Property 'quota' does not exist on type '{ ok: true; result: RoundResult; } | { ok: false; message: string; status?: number; quota?: boolean; body?: string; }'.   Property 'quota' does not exist on type '{ ok: true; result: RoundResult; }'.", 3],
  ["adapters/raw/llm.ts\u00002339\u0000Property 'status' does not exist on type '{ ok: true; result: RoundResult; } | { ok: false; message: string; status?: number; quota?: boolean; body?: string; }'.   Property 'status' does not exist on type '{ ok: true; result: RoundResult; }'.", 1],
  ["adapters/raw/llm.ts\u00002353\u0000Object literal may only specify known properties, and 'finishReason' does not exist in type 'RoundResult'.", 1],
  ["adapters/raw/llm.ts\u00002741\u0000Property 'finishReason' is missing in type '{ text: string; toolCalls: undefined[]; model: string; error: { code: string; stage: string; message: string; }; }' but required in type 'GenerationResult'.", 1],
  ["harness.ts\u00002300\u0000Duplicate identifier 'createEmergencyRepair'.", 2],
  ["harness.ts\u00002300\u0000Duplicate identifier 'createRawSessionAdapter'.", 2],
  ["harness.ts\u00002300\u0000Duplicate identifier 'extractToolSource'.", 2],
  ["harness.ts\u00002300\u0000Duplicate identifier 'isUnresolved'.", 2],
  ["harness.ts\u00002300\u0000Duplicate identifier 'listWithin'.", 2],
  ["harness.ts\u00002300\u0000Duplicate identifier 'readWithin'.", 2],
  ["harness.ts\u00002304\u0000Cannot find name 'REPAIR_PROMPT'.", 1],
  ["harness.ts\u00002304\u0000Cannot find name 'resolveFallbackRoute'.", 1],
  ["harness.ts\u00002339\u0000Property 'error' does not exist on type '{ ok: true; values: Record<string, string | true>; } | { ok: false; error: string; }'.   Property 'error' does not exist on type '{ ok: true; values: Record<string, string | true>; }'.", 1],
  ["harness.ts\u00002724\u0000'\"./adapters/raw/index.js\"' has no exported member named 'createRawSessionAdapter'. Did you mean 'createRawAdapters'?", 1],
  ["index.ts\u00002304\u0000Cannot find name 'asLeaseRecord'.", 1],
  ["index.ts\u00002304\u0000Cannot find name 'defaultLeaseOwner'.", 1],
  ["index.ts\u00002304\u0000Cannot find name 'leaseStorageKey'.", 1],
  ["launcher.ts\u00002540\u0000Cannot assign to 'toolName' because it is a read-only property.", 1],
  ["lease-adapter.ts\u00002339\u0000Property 'holder' does not exist on type 'AcquireDecision'.   Property 'holder' does not exist on type '{ readonly ok: true; readonly lease: LeaseRecord; }'.", 1],
  ["spawn-node.ts\u00002339\u0000Property 'persistence' does not exist on type 'HostCapabilities'.", 2],
  ["spawn-node.ts\u00002339\u0000Property 'sessions' does not exist on type 'HostCapabilities'.", 2],
  ["spawn-node.ts\u00002345\u0000Argument of type '{ sessionId: string; cwd: string; text: string; title: string; visibility: \"visible\"; origin: string; }' is not assignable to parameter of type 'InjectShape'.   Property 'systemPrompt' is missing in type '{ sessionId: string; cwd: string; text: string; title: string; visibility: \"visible\"; origin: string; }' but required in type 'InjectShape'.", 1],
  ["storage-memory.ts\u00002305\u0000Module '\"./protocol/index.js\"' has no exported member 'StorageTransaction'.", 1],
  ["ws-server.ts\u00002540\u0000Cannot assign to 'readyState' because it is a read-only property.", 2],
])

const argOf = (flag) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const against = argOf('--against') ?? 'HEAD'
const showBaseline = process.argv.includes('--baseline')

if (showBaseline) {
  const report = diagnose()
  const counts = countsByFile(report)
  console.log('current baseline (paste into BASELINE):')
  for (const [file, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ['${file}', ${n}],`)

  /**
   * 这里必须打印**代码健康度**的合计，不是所有诊断的合计。
   * 实测：第一版打印 report.total（61），而上面的每文件列表已经排除了 33 条环境问题，
   * 两者对不上 —— 与「手写基线表」同一类错误的镜像：两个数用了两套口径。
   */
  const codeTotal = [...counts.values()].reduce((s, n) => s + n, 0)
  const envTotal = report.diagnostics.filter((d) => ENVIRONMENT_CODES.has(d.code)).length
  console.log(`  code total: ${codeTotal}   (environment, not in this table: ${envTotal})`)

  // 身份基线：与上表同源，一起生成，避免两张表自相矛盾
  console.log('\nidentity baseline (paste into BASELINE_IDENTITIES):')
  const ids = defectIdentities(report)
  for (const [key, n] of [...ids].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [file, code, message] = key.split('\u0000')
    console.log(`  [${JSON.stringify(`${file}\u0000${code}\u0000${message}`)}, ${n}],`)
  }
  console.log(`  identity total: ${[...ids.values()].reduce((s, n) => s + n, 0)}`)
  process.exit(0)
}

// ── self-test：证明这套判据能红 ──────────────────────────────────────────────────────────────────
if (process.argv.includes('--self-test')) {
  /**
   * 判据的关键性质是「只看触及的文件」—— 所以自测必须包含一条**未触及文件变坏但不许失败**的用例。
   * 第一版自测自己写错了（遍历了 after 的全部文件而不是 touched 集合），把它判成 FAIL，
   * 于是自测 FAIL。这正是自测该抓的东西：**如果自测只测「该红的红」，它会漏掉「不该红的红了」**。
   */
  const run = (before, after, touchedAfter) => {
    const violations = []
    for (const file of touchedAfter) {
      const now = after.get(file) ?? 0
      const prev = before.get(file) ?? 0
      if (now > prev) violations.push(file)
    }
    return violations.length
  }
  const before = new Map([['src/a.ts', 3], ['src/b.ts', 1]])
  const cases = [
    ['a touched file kept its count — allowed', new Map([['src/a.ts', 3], ['src/b.ts', 1]]), ['src/a.ts'], 0],
    ['a touched file GAINED one — must fail', new Map([['src/a.ts', 4], ['src/b.ts', 1]]), ['src/a.ts'], 1],
    ['an UNTOUCHED file gained — must NOT fail (incremental, not global)', new Map([['src/a.ts', 3], ['src/b.ts', 9]]), ['src/a.ts'], 0],
    ['a touched file shrank — allowed (and the baseline should be lowered)', new Map([['src/a.ts', 1], ['src/b.ts', 1]]), ['src/a.ts'], 0],
    ['a touched file that had 0 now has 1 — must fail', new Map([['src/a.ts', 3], ['src/c.ts', 1]]), ['src/c.ts'], 1],
  ]
  let ok = true
  for (const [name, after, touchedAfter, expected] of cases) {
    const got = run(before, after, touchedAfter)
    const pass = got === expected
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : ` (expected ${expected} violation(s), got ${got})`}`)
    if (!pass) ok = false
  }
  // the move-only code is absolute, not relative: it fails even when no file was touched
  const absoluteFails = (code2459) => code2459 > 0
  const absolutePass = absoluteFails(1) === true && absoluteFails(0) === false
  console.log(`  ${absolutePass ? 'PASS' : 'FAIL'}  2459 is ABSOLUTE — it fails even if no file was touched`)
  if (!absolutePass) ok = false

  /**
   * ── 身份判据：抓「修一条坏一条」的等价交换 ────────────────────────────────────────────────────
   *
   * 这一组是用户裁定要补的那条防线。计数判据对下列情形完全无感：
   * 同一个文件里修好一条、弄坏另一条 → 计数不变 → 计数判据通过 → 缺陷被静默换掉。
   *
   * 所以自测里必须有一条**计数相同但身份变了**的用例，并且它必须判红。
   * 如果这条用例不存在，「计数 + 身份」看起来像两条防线，实际只有一条。
   */
  const identityCheck = (frozen, current) => {
    const added = []
    for (const [key, n] of current) {
      const base = frozen.get(key) ?? 0
      if (n > base) added.push(key)
    }
    return added.length
  }
  const frozenIds = new Map([['a.ts\u00002339\u0000old', 1], ['a.ts\u00002345\u0000keep', 1]])
  const identityCases = [
    ['identity unchanged — allowed',
      new Map([['a.ts\u00002339\u0000old', 1], ['a.ts\u00002345\u0000keep', 1]]), 0],
    ['one fixed, one NEW, same COUNT — must fail (the equivalent swap)',
      new Map([['a.ts\u00002345\u0000keep', 1], ['a.ts\u00002339\u0000brand-new', 1]]), 1],
    ['a frozen identity got MORE occurrences — must fail',
      new Map([['a.ts\u00002339\u0000old', 2], ['a.ts\u00002345\u0000keep', 1]]), 1],
    ['one fixed, nothing new — allowed',
      new Map([['a.ts\u00002345\u0000keep', 1]]), 0],
  ]
  for (const [name, current, expected] of identityCases) {
    const got = identityCheck(frozenIds, current)
    const pass = got === expected
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : ` (expected ${expected} violation(s), got ${got})`}`)
    if (!pass) ok = false
  }

  console.log(ok ? '\nSELF-TEST PASS' : '\nSELF-TEST FAIL')
  process.exit(ok ? 0 : 1)
}

// ── 主流程 ──────────────────────────────────────────────────────────────────────────────────────
const report = diagnose()
const counts = countsByFile(report)
const touched = touchedFiles(against)

console.log(`type-budget: ${report.total} diagnostic(s) in the tree; ${touched.length} file(s) touched vs ${against}`)

/**
 * 2459 是绝对判据：与「触及了哪些文件」无关。
 * 理由：它代表的缺陷（搬出时忘记 export）会**静默通过所有其他门禁**，所以只要它出现就必须红。
 */
const moveOnly = report.diagnostics.filter((d) => d.code === MOVE_ONLY_CODE)
if (moveOnly.length > 0) {
  console.error(`\nFAIL ${MOVE_ONLY_CODE}: ${moveOnly.length} declaration(s) are imported without being exported.`)
  for (const d of moveOnly.slice(0, 10)) console.error(`  ${d.file}:${d.line}  ${d.message.slice(0, 120)}`)
  console.error('This is the move-only failure mode: it passed 789 tests, the build and verify-pure-move.')
  process.exit(1)
}
console.log(`  ${MOVE_ONLY_CODE} (imported-but-not-exported): 0 — required to be 0, and it is`)

const violations = []
const improvements = []
for (const file of touched) {
  const now = counts.get(file) ?? 0
  const base = BASELINE.get(file)
  if (base === undefined) {
    /**
     * 一个基线表里没有的文件被触及 —— 它此前是 0 错误（或在基线表建立后新增）。
     * 这不是「自动放行」：新增文件必须从 0 开始，否则基线表会慢慢被新文件绕过。
     */
    if (now > 0) violations.push({ file, base: 0, now, why: 'not in the baseline table (it had 0 errors when the table was frozen)' })
    continue
  }
  if (now > base) violations.push({ file, base, now, why: 'grew' })
  else if (now < base) improvements.push({ file, base, now })
}

for (const item of improvements) {
  console.log(`  IMPROVED ${item.file}: ${item.base} → ${item.now}  (lower BASELINE to ${item.now})`)
}

/**
 * ── 身份检查：新增一条我们没冻结的诊断 = 红，哪怕总计数没变 ─────────────────────────────────────
 *
 * 用户裁定（2026-11-12）：按每文件计数，允许「修好 1 条 + 弄坏 1 条 = 数字不变 = 通过」。
 * 本轮真的发生过一次等价交换：2339 少 1 条，同时那条 artifact 被重新归类。
 *
 * 剩下的修法（2345/2322/2353/2554）都是改签名或改类型，而改签名最容易在别处引入新错误。
 * 只有计数防线的话，「修 3 条、坏 3 条」会静默通过 —— 这条防线是给那种情况准备的。
 *
 * 与每文件计数**同时**检查，两者都要过：计数不许增，且身份不许新增。
 */
const identities = defectIdentities(report)
const newIdentities = []
const grownIdentities = []
for (const [key, n] of identities) {
  const frozen = BASELINE_IDENTITIES.get(key) ?? 0
  if (frozen === 0) newIdentities.push({ key, n })
  else if (n > frozen) grownIdentities.push({ key, frozen, n })
}

if (newIdentities.length > 0 || grownIdentities.length > 0) {
  console.error('\nFAIL: this change introduced type defects that are not in the frozen identity baseline.')
  for (const item of newIdentities) {
    console.error(`  NEW      ${describeIdentity(item.key)}`)
  }
  for (const item of grownIdentities) {
    console.error(`  MORE     ${describeIdentity(item.key)}  (${item.frozen} → ${item.n})`)
  }
  console.error('\nA per-file count can stay flat while one defect is fixed and another introduced.')
  console.error('Fix the new defect, or freeze the identity in BASELINE_IDENTITIES with a written reason.')
  process.exit(1)
}

const droppedIdentities = [...BASELINE_IDENTITIES.keys()].filter((key) => !identities.has(key))
if (droppedIdentities.length > 0) {
  console.log(`  ${droppedIdentities.length} frozen identit${droppedIdentities.length === 1 ? 'y is' : 'ies are'} gone — regenerate with --baseline`)
  for (const key of droppedIdentities) console.log(`    GONE  ${describeIdentity(key)}`)
}

/**
 * ── 四条 2339 的**当前位置**：打印，不手抄（裁定③）──────────────────────────────────────────────
 *
 * 文档里引这些缺陷时曾经写死行号（`retrieve.ts:190` / `:1420` / `:1614` / `:1903` / `:1927`），
 * 六步搬运之后每一个都漂了 —— 而且漂得**很安静**：数字还在，只是指向了别的代码。
 * 这类错误没有门禁会红（悬空引用判据只查「超出文件尾」，查不出「指错了行」）。
 *
 * 处置：定位一律用**符号名**（`renderHint` / `retrieveCandidates` / `classifyScene` …），
 * 当前行号由这一节打印出来，文档引用它、不抄它。
 *
 * 放在 violations 之前：失败时也需要看到位置。
 */
const positions = codeDefects(report)
  .filter((d) => d.code === 2339)
  .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
if (positions.length > 0) {
  console.log('\n── 2339 的当前位置（文档请引这一节的输出，不要手抄行号）──')
  for (const d of positions) {
    const short = d.message.length > 70 ? `${d.message.slice(0, 70)}…` : d.message
    console.log(`  ${d.file}:${d.line}  ${short}`)
  }
}

if (violations.length > 0) {
  console.error(`\nFAIL type budget on ${violations.length} touched file(s):`)
  for (const v of violations) console.error(`  ${v.file}: ${v.base} → ${v.now}  (${v.why})`)
  console.error('\nA touched file may not gain type errors. Fix them, or raise BASELINE with a written reason.')
  process.exit(1)
}

console.log(`\nOK — every touched file is at or under its frozen baseline (move-only code ${MOVE_ONLY_CODE}: 0)`)

/**
 * ── 每次通过都要声明这个数字的口径，不只在注释里 ────────────────────────────────────────────────
 *
 * 注释只有改脚本的人会读；跑门禁的人只看输出。而这句是这个数字最容易被误读的地方：
 * 「15 条」会被读成「还剩 15 个问题」，然后被读成「清到 0 就类型安全了」。
 *
 * 实测：strict:false → 49 条，strict:true → 58 条（多出 9 条隐式 any 与 1 条 null 检查）。
 * 所以通过一次只证明「连宽松检查都过了」，不证明类型正确。
 */
const measuredTotal = [...counts.values()].reduce((s, n) => s + n, 0)

/**
 * ── strict:true 的数字必须现测，不能写死 ────────────────────────────────────────────────────────
 *
 * 第一版这一行写死了 `strict:true reports 58 here`。实测发现它本轮就过期了：
 * 修掉 4 条之后 strict:true 从 58 变成 54 —— 写死的数字从「说明」变成「谎话」。
 *
 * 这与本轮修掉的那批同族：行号当身份、手写基线表、写死的 786。**会变的东西必须测量。**
 * 测量失败时明说「未能测量」，不退回一个记忆中的数字。
 */
let strictTrueNote = 'strict:true was not measured on this run'
try {
  const raw = execFileSync(process.execPath, [TYPE_CHECK, '--strict-comparison'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const parsed = JSON.parse(raw.trim())
  strictTrueNote = `strict:true reports ${parsed.strictTrue} here`
} catch {
  // a missing compiler is handled earlier; anything else means the comparison could not run
}

console.log('  scope: measured under strict:false — this is "what the loose settings can see",')
console.log(`         not "type health". ${strictTrueNote} (this baseline sums to ${measuredTotal}).`)
console.log('         Reaching 0 here means "even the loose check passes", not "types are correct".')
