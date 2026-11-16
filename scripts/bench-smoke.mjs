#!/usr/bin/env node
/**
 * ── bench-smoke: 一个仓的纯函数微基准，**记录基线，不设阈值** ──────────────────────────────────
 *
 * 这个脚本永远 exit 0。它不是一个门禁，是一个**量具**：B0.5 只要求把今天的数字记下来，
 * 好让未来某一天有人能指着它说「这里慢了 3 倍」——而那个判断需要波动范围，现在还没有。
 *
 * ── 两件事它必须做到，否则它就是一个昂贵的 `console.log` ─────────────────────────────────────
 *
 *   ① 报**中位数**，不是平均值。一次 GC 或一个调度抖动就能把平均值拉走 30%，
 *      而中位数对这种长尾免疫。单次测量没有意义，所以内部重复 ROUNDS 轮，每轮 n 次，
 *      报每轮 per-call 耗时的中位数。
 *
 *   ② 自带 can-red：如果被测函数被换成空实现，中位数必须**显著更低**。
 *      没有这条，「测了一个不存在的函数」和「测了一个很快的函数」在输出上长得一样。
 *      这是「防空集恒绿」在性能测量上的对应物，和 v205/v130 的 can-red 是同一个动机。
 *
 * 用法：
 *   node scripts/bench-smoke.mjs            # 正常输出
 *   node scripts/bench-smoke.mjs --json     # 只输出一行 JSON（给别人读）
 *
 * 输出格式（固定，便于 grep 与跨仓对比）：
 *   bench-smoke: <name> median=<x>ms (n=100000)
 */

import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const N = 100_000
const ROUNDS = 7

/**
 * ── 被测目标：一个真实的纯函数 ────────────────────────────────────────────────────────────────
 *
 * `load()` 返回 { name, fn, input, sourceFile }。
 * `sourceFile` 用来在输出里带上被调代码的哈希——即使 can-red 自检没做，
 * 读的人也能核对「测的确实是那个函数」，而不是一个同名的替身。
 */
const TARGET = {
  name: 'isWellFormedProvenance',
  async load () {
    /**
     * ── 这个测的是一条正则：provenance 标记的格式契约 ──────────────────────────────────────────
     *
     * 选它的理由：纯函数（无状态、无 IO、无 Date.now）、输入固定，
     * 且它守的是「一个 marker 能不能被解析」这条契约 —— 变慢在这里意味着正则退化了，
     * 那是能被看见且值得知道的事。
     *
     * ── 第一版为什么是错的（can-red 自检抓出来的）────────────────────────────────────────────
     * 第一版我把 input 写成了**对象** `{ origin, at }`，而它签名是 `(origin: unknown)`，
     * 内部第一句就是 `typeof origin === 'string' && ...` —— 传对象直接短路返回 false。
     * 实测 separation=0.44x（比空函数还"快"），NO-SIGNAL。
     * 那不是函数的问题，是**我喂错了输入**，量具当场指了出来。
     * 改成字符串后 separation=4.64x，SIGNAL-OK。
     *
     * ── 为什么不是 `opaqueId` ─────────────────────────────────────────────────────────────────
     * 它 2.6e-4 ms/call 的耗时更漂亮，但它内部调 `Date.now()` —— **不是纯函数**，
     * 每轮输入都不同，基线不可复现。所以否掉。纯函数是这个量具的前提，不是加分项。
     */
    const mod = await import(pathToFileURL(join(ROOT, 'src', 'policy.ts')).href)
    return {
      fn: mod.isWellFormedProvenance,
      input: 'session-abc123:42',
      sourceFile: join(ROOT, 'src', 'policy.ts'),
    }
  },
}

/** 每轮跑 n 次，返回该轮的 per-call 毫秒数。 */
function round (fn, input, n) {
  const started = process.hrtime.bigint()
  for (let i = 0; i < n; i += 1) fn(input)
  return Number(process.hrtime.bigint() - started) / 1e6 / n
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}

const fmt = (x) => {
  // per-call 很小，用科学计数会难读；保留 6 位有效数字
  if (x === 0) return '0'
  if (x < 1e-4) return x.toExponential(3)
  return x.toPrecision(6)
}

const sourceHash = (file) => {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12)
  } catch {
    return 'unavailable'
  }
}

const json = process.argv.includes('--json')
const log = json ? () => {} : (s) => process.stdout.write(s + '\n')

const { fn, input, sourceFile } = await TARGET.load()

if (typeof fn !== 'function') {
  // 加载不到就不是「绿」——但本脚本永远 exit 0，所以必须把这件事喊出来
  console.log(`bench-smoke: ${TARGET.name} UNAVAILABLE (the function could not be loaded; NOT a measurement)`)
  process.exit(0)
}

/* 真函数：ROUNDS 轮，取中位数 */
const realRounds = []
for (let r = 0; r < ROUNDS; r += 1) realRounds.push(round(fn, input, N))
const realMedian = median(realRounds)

/**
 * ── can-red：空实现必须更快 ────────────────────────────────────────────────────────────────────
 *
 * 这不是在测空函数，是在证明「这个量具能区分做了事和没做事」。
 * 若两者分不开（比值 ≈ 1），说明本脚本测的是**调用开销**而不是函数体，
 * 于是它对未来的回归完全无知——那种情况下输出里必须写明 NO-SIGNAL，而不是装作测到了。
 */
const emptyRounds = []
for (let r = 0; r < ROUNDS; r += 1) emptyRounds.push(round(() => {}, input, N))
const emptyMedian = median(emptyRounds)

const separation = emptyMedian === 0 ? Infinity : realMedian / emptyMedian
const hasSignal = separation >= 2

log(`bench-smoke: ${TARGET.name} median=${fmt(realMedian)}ms (n=${N})`)
log(`  rounds=${ROUNDS} real=[${realRounds.map(fmt).join(', ')}]`)
log(`  spread=${fmt(((Math.max(...realRounds) - Math.min(...realRounds)) / realMedian) * 100)}% of median`)
log(`  can-red: empty=${fmt(emptyMedian)}ms  separation=${separation === Infinity ? 'inf' : separation.toFixed(2)}x  ${hasSignal ? 'SIGNAL-OK' : 'NO-SIGNAL (the timer may be measuring call overhead, not the function body)'}`)
log(`  source: ${sourceFile.replace(ROOT, '.').replaceAll('\\\\', '/').replaceAll('\\', '/')} sha256=${sourceHash(sourceFile)}`)
log('  verdict: baseline only — NO THRESHOLD. A threshold needs a known normal range; see docs/PERF-BASELINE-2026-11-16.md')

if (json) {
  console.log(JSON.stringify({
    name: TARGET.name,
    n: N,
    rounds: ROUNDS,
    medianMs: realMedian,
    realRounds,
    emptyMedianMs: emptyMedian,
    separation,
    hasSignal,
    sourceFile,
  }))
}

// 永远 exit 0：这是量具，不是门禁
process.exit(0)
