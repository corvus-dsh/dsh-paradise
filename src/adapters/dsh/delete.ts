/**
 * DELETE — remove a half-built artifact, and do not claim it is gone unless it is.
 *
 * THE DISTINCTION THIS FILE EXISTS FOR
 *
 * "The delete method returned" and "the artifact is gone" are different facts. Reporting the first as
 * the second is how a phantom session survives a rollback that claimed success — a session that
 * appears in the sidebar, opens to an empty transcript, and is titled nothing.
 *
 * So the sequence is: stat (is it there?) → try each removal the host offers → stat again (is it
 * really gone?) → if it is still there, MARK it. Three outcomes, all reported separately:
 *
 *   removed              — verified absent afterwards
 *   removed unverifiable — a removal API ran, but the host has no `stat` to confirm it
 *   still present        — every attempt ran and it is still there; the artifact gets a title that
 *                          says so, because an unmarked empty session is indistinguishable from a
 *                          session that hatched but never received its content
 *
 * The marking step matters more than it looks: it is the ONE thing this layer can do to a cold
 * artifact that the slicing layer cannot, and it is why a failed hatch is diagnosable a week later.
 */

import { service } from './services.js'

/** The outcome of a removal, with the evidence behind it. */
export interface DeleteReceipt {
  ok: boolean
  stage: string
  /** Verified absent afterwards. */
  removed: boolean
  /** Whether the artifact was verified ABSENT, PRESENT, or could not be asked. */
  verified: 'absent' | 'present' | 'unverifiable'
  /** A title was written to mark it broken (only when it could not be removed). */
  marked: boolean
  /** Every step that ran, in order, including the ones that failed. */
  notes: string[]
  warnings: string[]
  error?: { code: string; stage: string; message: string }
}

/** Ask the host whether the artifact is there. `undefined` means "this host cannot answer". */
async function artifactPresence(persistence: any, sessionId: string): Promise<'absent' | 'present' | 'unverifiable'> {
  if (typeof persistence !== 'object' || persistence === null) return 'unverifiable'
  if (typeof persistence.stat !== 'function') return 'unverifiable'
  try {
    const stat = await persistence.stat(sessionId)
    return stat === undefined || stat === null ? 'absent' : 'present'
  } catch {
    // A stat that throws cannot answer the question.
    return 'unverifiable'
  }
}

/**
 * Remove a session, layered and honest.
 *
 * Every removal the host might offer is tried in the order that is most likely to be respected, and
 * each attempt is RECORDED whether or not it worked — "no API existed" and "the API ran and did
 * nothing" lead to completely different fixes, and a report that merges them wastes the next hour.
 */
export async function deleteSession(ctx: any, sessionId: string, reason: string): Promise<DeleteReceipt> {
  const notes: string[] = []
  const warnings: string[] = []
  const persistence = service(ctx, 'sessionPersistence', 'create')
  const persistenceAny = service(ctx, 'sessionPersistence')
  const sessions = service(ctx, 'sessions', 'get')

  const before = await artifactPresence(persistenceAny, sessionId)
  if (before === 'absent') {
    notes.push('artifact absent before rollback: nothing to remove')
    return {
      ok: true,
      stage: 'delete:absent',
      removed: false,
      verified: 'absent',
      marked: false,
      notes,
      warnings,
    }
  }

  /* 1. the store's own "forget a prepared artifact" hook, if it has one */
  for (const method of ['discardPrepared', 'discard', 'forget']) {
    if (typeof persistenceAny !== 'object' || persistenceAny === null) break
    if (typeof (persistenceAny as any)[method] !== 'function') continue
    try {
      await (persistenceAny as any)[method](sessionId)
      notes.push(`persistence.${method}`)
    } catch (error) {
      notes.push(`persistence.${method} failed: ${String((error as any)?.message ?? error)}`)
    }
    break
  }

  /* 2. an explicit remove/delete, if it has one */
  for (const method of ['remove', 'delete']) {
    if (typeof persistenceAny !== 'object' || persistenceAny === null) break
    if (typeof (persistenceAny as any)[method] !== 'function') continue
    try {
      await (persistenceAny as any)[method](sessionId)
      notes.push(`persistence.${method}`)
    } catch (error) {
      notes.push(`persistence.${method} failed: ${String((error as any)?.message ?? error)}`)
    }
    break
  }

  /* 3. drop it from the live store, when it is there at all */
  if (typeof sessions === 'object' && sessions !== null && typeof (sessions as any).get === 'function') {
    try {
      if ((sessions as any).get(sessionId) !== undefined) {
        for (const method of ['remove', 'delete', 'dispose']) {
          if (typeof (sessions as any)[method] !== 'function') continue
          try {
            await (sessions as any)[method](sessionId)
            notes.push(`sessions.${method}`)
          } catch (error) {
            notes.push(`sessions.${method} failed: ${String((error as any)?.message ?? error)}`)
          }
          break
        }
      }
    } catch {
      // A throwing `get` is simply "not in the live store".
    }
  }

  const after = await artifactPresence(persistenceAny, sessionId)
  let removed = false
  if (after === 'absent') {
    removed = true
  } else if (after === 'unverifiable') {
    /**
     * NO STAT TO ASK. The strongest honest claim is "a removal API ran", and it is LABELLED as
     * unverifiable rather than dressed up as verified — the draft's rule, and the reason this field
     * exists at all.
     */
    removed = notes.some((note) => /^persistence\.(discardPrepared|discard|forget|remove|delete)$/u.test(note))
    if (removed) notes.push('removal unverifiable: no persistence.stat on this host')
  } else {
    notes.push('artifact still present after every removal attempt')
  }

  /* 4. if it cannot be deleted, it must not look usable */
  let marked = false
  if (!removed && typeof persistenceAny === 'object' && persistenceAny !== null && typeof (persistenceAny as any).open === 'function') {
    try {
      const handle = await (persistenceAny as any).open(sessionId)
      if (typeof handle === 'object' && handle !== null && typeof handle.append === 'function') {
        await handle.append([
          {
            type: 'session/title',
            seq: 0,
            time: Date.now(),
            data: { title: `[孵化失败] ${sessionId}`, messageSeqs: [], source: { kind: 'user' } },
          },
        ])
        if (typeof handle.flush === 'function') await handle.flush()
        if (typeof handle.close === 'function') await handle.close()
        marked = true
        notes.push('marked [孵化失败]')
      }
    } catch (error) {
      notes.push(`mark failed: ${String((error as any)?.message ?? error)}`)
    }
  }

  if (!removed && !marked) {
    warnings.push(`无法删除也无法标记 ${sessionId} —— 它会以一个空壳留在侧边栏（原因：${reason}）`)
  }

  return {
    ok: removed || marked || before === 'absent',
    stage: removed ? 'delete:removed' : marked ? 'delete:marked' : 'delete:failed',
    removed,
    verified: after,
    marked,
    notes,
    warnings,
    ...(removed || marked
      ? {}
      : {
          error: {
            code: 'DELETE_FAILED',
            stage: 'delete',
            message: `删除失败且无法标记：${notes.join('; ') || '宿主没有提供任何删除接口'}`,
          },
        }),
  }
}

/**
 * Verify a deletion WITHOUT performing one.
 *
 * The protocol's `verifyDeletion` capability answers "can this host confirm an absence?", which is a
 * different question from "please delete this" — a caller deciding whether to trust its own rollback
 * needs the first one.
 */
export async function verifyDeletion(ctx: any, sessionId: string): Promise<DeleteReceipt> {
  const persistence = service(ctx, 'sessionPersistence')
  const presence = await artifactPresence(persistence, sessionId)
  return {
    ok: presence !== 'unverifiable',
    stage: `verify:${presence}`,
    removed: presence === 'absent',
    verified: presence,
    marked: false,
    notes:
      presence === 'unverifiable'
        ? ['persistence.stat 不可用：无法核实删除']
        : [],
    warnings: [],
    ...(presence === 'unverifiable'
      ? {
          error: {
            code: 'VERIFY_UNAVAILABLE',
            stage: 'verify',
            message: '宿主没有 persistence.stat，"删除成功"在这里无法被证实',
          },
        }
      : {}),
  }
}
