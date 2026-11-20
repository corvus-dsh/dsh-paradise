/**
 * ── v276 (B4-0b-2 W3-1): A REFUSAL IS BEHAVIOUR — THE SUBSTRING CHECK COULD NOT TELL ────────────
 *
 * `scripts/preflight.mjs` used to prove the write contract's refusal with:
 *
 *     if (/writeNotImplemented|NOT_IMPLEMENTED/u.test(bundle)) ok(...)
 *
 * Both words appear in COMMENTS in the shipped bundle — three of the four occurrences are prose
 * describing the history of `NOT_IMPLEMENTED`. So deleting the function, or replacing its `throw` with
 * a `return`, left that check GREEN. The check was answering "does the artifact mention refusing",
 * which is a different question from "does it refuse".
 *
 * ── THE THREE LAYERS, WRITTEN DOWN BECAUSE THIS IS THE THIRD TIME ───────────────────────────────
 *
 *   1. the assertion was written in the bug's own syntax (`v270 ②`);
 *   2. the check looked for a SUBSTRING, and a comment satisfied it (graft's separator gate);
 *   3. the baseline recorded only whether a line EXISTED, not how often (memory's read gate);
 *   4. now: the check looked for a WORD, and prose satisfied it.
 *
 * All four compare along a dimension that cannot see the difference they claim to see.
 *
 * ── WHAT THIS FILE PINS ─────────────────────────────────────────────────────────────────────────
 *
 *   ① the refusal THROWS, with the code, naming what it refused — measured by calling it;
 *   ② the profile-dependent refusal (`NOT_WIRED`) is a BEHAVIOUR too, driven through a host that
 *     cannot inject into a live session — this is the confession the deleted §8 heading promised;
 *   ③ the OLD check is re-run against a GUTTED bundle, in a throwaway skeleton, and shown to stay
 *     green — while the new preflight goes red on the same build.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDshAdapters, writeNotImplemented } from '../index.js'

const REPO = fileURLToPath(new URL('..', import.meta.url))

// ── ① the refusal is a throw, not a word ─────────────────────────────────────────────────────

test('v276 ①: writeNotImplemented 抛 code=NOT_IMPLEMENTED，并点名被拒的东西', () => {
  let thrown = null
  try {
    writeNotImplemented('v276 probe 「写路径契约」')
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown !== null, '它必须抛 —— 返回任何东西都是「未实现的写路径返回了成功」')
  assert.equal(thrown.code, 'NOT_IMPLEMENTED', 'code 必须就是这个名字，调用方靠它分支')
  assert.match(String(thrown.message), /v276 probe/u, '消息必须说出被拒的是哪一次调用，不是一句泛泛的「未实现」')
})

// ── ② the profile-dependent confession, driven ──────────────────────────────────────────────

test('v276 ②: 宿主缺能力时 inject 返回 NOT_WIRED（不是悄无声息的成功）', async () => {
  /** An empty ctx: no `sessions`, no `sessionPersistence`, no prompt channel. */
  const adapter = createDshAdapters({}).session
  assert.equal(adapter.capabilities.injectIntoRunning, false, '能力自述必须先说实话')

  const receipt = await adapter.inject({ sessionId: 'v276' }, [{ type: 'text', text: 'hi' }])
  assert.equal(receipt.ok, false, '不可用的动词不许返回 ok:true')
  assert.equal(receipt.error.code, 'NOT_WIRED', '必须是名字化的拒绝，调用方才能分支')
  assert.equal(receipt.error.stage, 'inject', '拒绝必须点名是哪个动词')
  assert.deepEqual(receipt.rendered, [], '没写进去就是没写进去 —— 渲染清单必须为空')

  /** And the empty-input path refuses too, rather than reporting "nothing to do" as success. */
  const empty = await adapter.inject({ sessionId: 'v276' }, [])
  assert.equal(empty.ok, false)
  assert.equal(empty.error.code, 'NOT_WIRED')
})

// ── ③ the old check, re-run against a gutted build ─────────────────────────────────────────

test('v276 ③: 把 throw 改成 return 并重建 ⇒ 新 preflight 红；旧字符串判据仍绿（它就是瞎的）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v276-'))
  try {
    for (const file of ['index.js', 'package.json', 'manifest.json']) cpSync(join(REPO, file), join(root, file))
    for (const dir of ['scripts', 'src', 'dist']) cpSync(join(REPO, dir), join(root, dir), { recursive: true })

    const contract = join(root, 'src', 'write', 'contract.ts')
    const source = readFileSync(contract, 'utf8')
    /**
     * The mutation a careless refactor would ACTUALLY produce: the whole throw becomes a return. The
     * `throw new ParadiseError('NOT_IMPLEMENTED' …)` text leaves the artifact — but the WORDS stay in
     * this file's own docstring, in `UNIFIED_RULES`, and in three comment blocks elsewhere, which is
     * the whole point.
     */
    const body =
      'export function writeNotImplemented(what: string): never {\n' +
      '  throw new ParadiseError(\n' +
      "    'NOT_IMPLEMENTED',\n" +
      "    'unknown',\n" +
      '    `${what} 属于 ${WRITE_LAYER_PHASE}，本层 P1 只交付 read/。` +\n' +
      '      \'写路径没有实现，也不会返回任何"成功"形状的占位。\',\n' +
      '  )\n' +
      '}'
    assert.ok(source.includes(body), '前提：skeleton 里必须找到那个函数体（找不到就说明这段测试已经过期）')
    writeFileSync(
      contract,
      source.replace(body, 'export function writeNotImplemented(what: string): never {\n  return undefined as never\n}'),
      'utf8',
    )

    /** Rebuild inside the skeleton: index.js must match ITS OWN src, or the freshness check masks this. */
    execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs')], { cwd: root, encoding: 'utf8' })

    const bundle = readFileSync(join(root, 'index.js'), 'utf8')
    /**
     * THE RECEIPT: the old predicate is still satisfied by prose. If this ever stops being true, the
     * demonstration is no longer what it claims, and the assertion should fail rather than quietly pass.
     */
    assert.match(bundle, /NOT_IMPLEMENTED/u, '前提：被打坏的 bundle 里仍然有这三个词（在注释里）')
    assert.doesNotMatch(bundle, /throw new ParadiseError\(\s*'NOT_IMPLEMENTED'/u, '前提：抛出的那一段已经没了')

    /** The new preflight must go RED, and for the right reason. */
    let failed = null
    try {
      execFileSync(process.execPath, [join(root, 'scripts', 'preflight.mjs')], { cwd: root, encoding: 'utf8' })
    } catch (error) {
      failed = `${error.stdout ?? ''}${error.stderr ?? ''}${error.status ?? ''}`
    }
    assert.ok(failed !== null, 'preflight 必须失败 —— 一个 return 的「拒绝」就是假成功')
    assert.match(failed, /RETURNED instead of throwing/u, `失败必须点名「返回了」这个行为；actual:\n${String(failed).slice(0, 800)}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})