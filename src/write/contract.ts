/**
 * WRITE — the written contract for the session-writing layer, plus the refusal for what it does not do.
 *
 * ── THE HEADER USED TO SAY 「P2: contract only, deliberately unimplemented」 ────────────────────
 *
 * That was true when it was written and stopped being true when the machinery landed: the write path
 * lives in `../adapters/dsh/session-writer.ts` (prepare → build → validate → create → append → flush
 * → close → cold-read verify) and `../adapters/dsh/delete.ts` (delete, then verify by `stat`). A
 * header that still says "unimplemented" is the documentation form of the false success this batch
 * keeps removing: it tells a reader the write layer will refuse, so nobody looks for the refusal.
 *
 * WHAT THIS FILE IS NOW:
 *   · `WRITE_LAYER_PHASE` — how far the contract has been SATISFIED, read by callers deciding whether
 *     to use the write path at all;
 *   · `CARRYING_MESSAGE_RULE` — the one rule about the message a plugin writes;
 *   · `writeNotImplemented(what)` — the refusal for verbs that are STILL unimplemented. It throws, and
 *     `scripts/preflight.mjs` now measures that by CALLING it (B4-0b-2 W3-1): a comment containing the
 *     words `NOT_IMPLEMENTED` used to satisfy the old substring check, which is why the check was
 *     wrong and not merely old.
 *
 * WHAT MUST BE TRUE OF ANY WRITE PATH (draft §6.1 — the stricter existing implementation wins each row):
 *
 *   1. WRITE-THEN-VERIFY uses the FULL validator, never "just compare count/seq/type". graft's
 *      `assertColdLog` and observer's `assertInjectTape` both do the full pass; the loose version
 *      once let a lost `surfaceOp` and a changed role through.
 *   2. DELETE MUST BE VERIFIED — `stat` before and after; when the host cannot `stat`, the receipt
 *      says `removalUnverifiable` instead of claiming the artifact is gone.
 *   3. A COLD ARTIFACT MUST BE MARKABLE — `persistence.open` + a title write. Only a LIVE session
 *      may be appended to; a cold one cannot be reached through `sessions.get`.
 *   4. ERRORS CARRY `code + stage + stack` (`../errors.js`).
 *   5. RESOLVE BY THE METHOD ABOUT TO BE CALLED (`../host/services.js`), one candidate per call.
 *   6. IGNITION IS A SEPARATE VERB, default OFF. Neither plugin ignites on the caller's behalf.
 *   7. THE CARRYING MESSAGE IS VISIBLE BY DEFAULT — `user/message` plus a `plugin:<owner>:<name>`
 *      marker. An invisible role is allowed only explicitly, and the receipt must say
 *      `rendered: false` with the reason.
 *
 * NOTHING HERE MAY RETURN A SUCCESS. An unimplemented write path that answers `ok: true` is the exact
 * class of lie (`{ok:true}` with nothing on disk) this ecosystem was built to remove.
 */

import { ParadiseError } from '../errors.js'

/** How far the write layer has got. Read by callers that must decide whether to use it at all. */
export const WRITE_LAYER_PHASE = 'P2' as const

/** Throw the ONE honest answer an unimplemented write path can give. */
export function writeNotImplemented(what: string): never {
  throw new ParadiseError(
    'NOT_IMPLEMENTED',
    'unknown',
    `${what} 属于 ${WRITE_LAYER_PHASE}，本层 P1 只交付 read/。` +
      '写路径没有实现，也不会返回任何"成功"形状的占位。',
  )
}

/**
 * The carrying-message rule, as data rather than a comment.
 *
 * This is the single most expensive lesson in this repository's history: an injected
 * `developer/message` is written correctly and rendered nowhere. Making the rule a value means a
 * later test can assert on it and a later adapter must read it rather than restate it.
 */
export const CARRYING_MESSAGE_RULE = {
  /** The default event type for injected context — the one the conversation renders. */
  defaultType: 'user/message',
  /** What marks a message as plugin-authored, so a later slice never replays it as a human order. */
  markerPrefix: 'plugin:',
  /** Roles the projection renders. */
  visibleRoles: ['user'],
  /** Roles it does not, and which must therefore be reported as `rendered: false`. */
  invisibleRoles: ['developer', 'system'],
} as const

/** The seven unified rules, as data, so a cross-implementation test can enumerate them. */
export const UNIFIED_RULES: ReadonlyArray<{ id: string; rule: string; source: string }> = [
  { id: 'verify-full', rule: '写后重跑全量校验器', source: 'graft.assertColdLog / observer.assertInjectTape' },
  { id: 'delete-verified', rule: '删除必须 stat 前后各一次；不能核实则报 removalUnverifiable', source: 'observer.artifactIsGone' },
  { id: 'cold-markable', rule: '冷产物用 persistence.open 写标记；只有 live 才能 append', source: 'observer mark-broken' },
  { id: 'error-stage', rule: '错误必须带 code + stage + stack', source: 'observer.InjectError' },
  { id: 'resolve-by-method', rule: '按将被调用的方法解析服务，一次调用只用一个候选', source: 'observer.resolveService' },
  { id: 'ignite-separate', rule: '点火是独立动词，默认不调用', source: 'both plugins' },
  { id: 'message-visible', rule: '承载消息默认可见（user/message + plugin: 标记）', source: 'P0 事故' },
]
