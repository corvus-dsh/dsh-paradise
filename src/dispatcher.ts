/**
 * TIANHE DISPATCHER — tickets in, receipts out, nodes in between.
 *
 * WHAT THIS IS
 *
 * A minimal scheduler built on `spawnNode`. A ticket says WHO should do WHAT; the dispatcher turns
 * it into a node, lets the node report, and collects the receipts. That is the whole loop, and it
 * is deliberately small: a scheduler that also owns retries, priorities and placement cannot be
 * verified in one sitting, and this one exists to prove the PRIMITIVE works under fan-out.
 *
 * WHY TICKETS ARE PURE JSON
 *
 * A ticket has to survive being written to a file, sent over a socket, and read by a process that
 * shares no memory with the writer. Anything richer than JSON breaks that, and the moment a ticket
 * needs a live object it stops being dispatchable. `TianheTicket` is therefore plain data by
 * construction.
 *
 * ── WHAT "DISPATCH" MEANS WITHOUT A HOST ──────────────────────────────────────────────────────
 *
 * `spawnNode` reports `mode: 'host' | 'portable'`. On a host, a dispatched ticket produces a LIVE
 * agent. Everywhere else it produces a materialised node contract written to disk.
 *
 * The dispatcher handles both through ONE interface (`NodeRunner`): give it a spawned node, get
 * back a receipt. On a host that runner is the host's own agent loop; in a CLI it is `runAgentTurn`.
 * Keeping the seam here is what lets the same dispatcher prove itself in both places.
 *
 * A HOSTLESS DISPATCH IS NOT A FAKE DISPATCH. The node is created, seeded, written and returned; the
 * runner decides what "execute" means. What would be dishonest is silently reporting success for
 * work nobody did — so a runner that cannot execute must say so, and the receipt carries `error`.
 */
import type { SpawnNodeInput, SpawnNodeReceipt } from './spawn-node.js'
import { spawnNode } from './spawn-node.js'
import type { TapeEvent } from './adapters/dsh/inject.js'

/** A unit of work. Plain JSON: writable, sendable, inspectable. */
export interface TianheTicket {
  /** Stable identity. Used as the spawned session id so a retry lands on the same node. */
  readonly id: string
  /** What this node must accomplish, in the user's own words. */
  readonly goal: string
  /** Context the node starts with. Strings, because a ticket must survive serialisation. */
  readonly context?: readonly string[]
  /** Which node should do it. Free-form; the dispatcher does not interpret it beyond routing. */
  readonly assignee?: string
  /** Tickets that must complete before this one may start. */
  readonly dependsOn?: readonly string[]
  /** Anything the caller wants echoed back. */
  readonly meta?: Readonly<Record<string, unknown>>
}

/** What a runner may return. `ok:false` must carry a reason — silence is not a result. */
export interface TianheReceipt {
  readonly ticketId: string
  readonly sessionId: string
  readonly ok: boolean
  /** The node's own output. Free-form text; the dispatcher does not parse it. */
  readonly output?: string
  readonly error?: string
  readonly ms: number
  /** Echoed from the ticket so a collector can group receipts without a second lookup. */
  readonly meta?: Readonly<Record<string, unknown>>
}

/**
 * Executes one spawned node.
 *
 * THE ONLY PLACE HOST-SPECIFIC BEHAVIOUR LIVES. A host runner drives the live session; a CLI runner
 * calls `runAgentTurn`. Everything above this line is identical in both deployments.
 */
export type NodeRunner = (node: {
  readonly ticket: TianheTicket
  readonly spawn: SpawnNodeReceipt
  /** What the node was seeded with, so a runner need not re-read the file. */
  readonly tape: readonly TapeEvent[]
}) => Promise<{ ok: boolean; output?: string; error?: string }>

export interface DispatcherOptions {
  /** Where nodes work. Each node gets a subdirectory so their files cannot collide. */
  readonly workspace: string
  /** Absent means portable spawns only, which the receipts will show. */
  readonly ctx?: unknown
  /** How the node is executed. Absent means "create and record, do not execute". */
  readonly runner?: NodeRunner
  /** Fan-out cap. Default 4: enough to prove concurrency, small enough to read in a log. */
  readonly maxConcurrent?: number
  readonly onEvent?: (event: DispatcherEvent) => void
}

export type DispatcherEvent =
  | { readonly type: 'ticket-spawned'; readonly ticketId: string; readonly sessionId: string; readonly mode: string }
  | { readonly type: 'ticket-done'; readonly ticketId: string; readonly ok: boolean; readonly ms: number }
  | { readonly type: 'ticket-skipped'; readonly ticketId: string; readonly reason: string }

export interface DispatchReport {
  readonly receipts: readonly TianheReceipt[]
  readonly spawned: readonly SpawnNodeReceipt[]
  /** Tickets that never ran, with the reason (a cyclic dependency, a failed blocker). */
  readonly skipped: ReadonlyArray<{ readonly ticketId: string; readonly reason: string }>
  readonly totalMs: number
}

/**
 * Run a batch of tickets.
 *
 * DEPENDENCY HANDLING IS DELIBERATELY SIMPLE AND DELIBERATELY EXPLICIT: a ticket runs when every
 * ticket in `dependsOn` has completed successfully. A ticket whose blocker failed is SKIPPED with
 * that reason, not silently dropped — a dispatcher that hides an unrun ticket makes a partial run
 * look complete.
 *
 * A CYCLE IS DETECTED, NOT SPUN ON. If a pass makes no progress and tickets remain, they are
 * reported as skipped with `dependency cycle or unmet blocker`. That is the difference between a
 * scheduler that reports a problem and one that hangs.
 */
export async function dispatch(tickets: readonly TianheTicket[], options: DispatcherOptions): Promise<DispatchReport> {
  const started = Date.now()
  const emit = options.onEvent ?? (() => {})
  const maxConcurrent = Math.max(1, Math.trunc(options.maxConcurrent ?? 4))
  const receipts: TianheReceipt[] = []
  const spawned: SpawnNodeReceipt[] = []
  const skipped: Array<{ ticketId: string; reason: string }> = []

  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]))
  const status = new Map<string, 'pending' | 'running' | 'ok' | 'failed' | 'skipped'>(
    tickets.map((ticket) => [ticket.id, 'pending' as const]),
  )

  /** A ticket may start when every blocker is `ok`; if any blocker failed, it can never start. */
  const readyNow = (ticket: TianheTicket): boolean => {
    for (const dependency of ticket.dependsOn ?? []) {
      const state = status.get(dependency)
      if (state === 'ok') continue
      if (state === undefined) return true
      /** Unknown blocker or a failed one: not ready. An unknown id is reported below. */
      return false
    }
    return true
  }

  /** Unknown dependency ids are a ticket defect, and saying so beats waiting forever. */
  for (const ticket of tickets) {
    for (const dependency of ticket.dependsOn ?? []) {
      if (!byId.has(dependency)) {
        status.set(ticket.id, 'skipped')
        skipped.push({ ticketId: ticket.id, reason: `dependsOn 指向不存在的工单「${dependency}」` })
        emit({ type: 'ticket-skipped', ticketId: ticket.id, reason: 'unknown dependency' })
      }
    }
  }

  /** One node's whole life: spawn, run, receipt. */
  const runOne = async (ticket: TianheTicket): Promise<void> => {
    status.set(ticket.id, 'running')
    const ticketStarted = Date.now()
    const nodeWorkspace = `${options.workspace.replace(/[/\\]+$/u, '')}/${ticket.id}`
    const input: SpawnNodeInput = {
      workspace: nodeWorkspace,
      prompt: ticket.goal,
      ...(ticket.context === undefined ? {} : { context: ticket.context }),
      id: `tianhe-${ticket.id}`,
      title: ticket.assignee === undefined ? ticket.id : `${ticket.id} · ${ticket.assignee}`,
      ...(ticket.meta === undefined ? {} : { meta: ticket.meta }),
    }
    let spawn: SpawnNodeReceipt
    try {
      spawn = await spawnNode(input, options.ctx)
    } catch (error) {
      receipts.push({
        ticketId: ticket.id,
        sessionId: input.id ?? '',
        ok: false,
        error: `spawn 失败：${String((error as { message?: unknown })?.message ?? error)}`,
        ms: Date.now() - ticketStarted,
        ...(ticket.meta === undefined ? {} : { meta: ticket.meta }),
      })
      status.set(ticket.id, 'failed')
      emit({ type: 'ticket-done', ticketId: ticket.id, ok: false, ms: Date.now() - ticketStarted })
      return
    }
    spawned.push(spawn)
    emit({ type: 'ticket-spawned', ticketId: ticket.id, sessionId: spawn.sessionId, mode: spawn.mode })

    if (!spawn.ok) {
      receipts.push({
        ticketId: ticket.id,
        sessionId: spawn.sessionId,
        ok: false,
        error: spawn.error?.message ?? 'spawn 未成功',
        ms: Date.now() - ticketStarted,
        ...(ticket.meta === undefined ? {} : { meta: ticket.meta }),
      })
      status.set(ticket.id, 'failed')
      emit({ type: 'ticket-done', ticketId: ticket.id, ok: false, ms: Date.now() - ticketStarted })
      return
    }

    /**
     * NO RUNNER MEANS "CREATE AND RECORD".
     *
     * That is a legitimate outcome for a caller that only wants the node contract — and it is
     * reported as `ok: true` with an explicit note, not as work that happened. A runner that cannot
     * execute returns `ok: false` with its reason, which is how a hostless dispatch avoids claiming
     * it did something.
     */
    if (options.runner === undefined) {
      receipts.push({
        ticketId: ticket.id,
        sessionId: spawn.sessionId,
        ok: true,
        output: `节点已创建（${spawn.mode}），未执行：调用方未提供 runner`,
        ms: Date.now() - ticketStarted,
        ...(ticket.meta === undefined ? {} : { meta: ticket.meta }),
      })
      status.set(ticket.id, 'ok')
      emit({ type: 'ticket-done', ticketId: ticket.id, ok: true, ms: Date.now() - ticketStarted })
      return
    }

    try {
      const result = await options.runner({ ticket, spawn, tape: spawn.tape })
      receipts.push({
        ticketId: ticket.id,
        sessionId: spawn.sessionId,
        ok: result.ok,
        ...(result.output === undefined ? {} : { output: result.output }),
        ...(result.error === undefined ? {} : { error: result.error }),
        ms: Date.now() - ticketStarted,
        ...(ticket.meta === undefined ? {} : { meta: ticket.meta }),
      })
      status.set(ticket.id, result.ok ? 'ok' : 'failed')
      emit({ type: 'ticket-done', ticketId: ticket.id, ok: result.ok, ms: Date.now() - ticketStarted })
    } catch (error) {
      receipts.push({
        ticketId: ticket.id,
        sessionId: spawn.sessionId,
        ok: false,
        error: String((error as { message?: unknown })?.message ?? error),
        ms: Date.now() - ticketStarted,
        ...(ticket.meta === undefined ? {} : { meta: ticket.meta }),
      })
      status.set(ticket.id, 'failed')
      emit({ type: 'ticket-done', ticketId: ticket.id, ok: false, ms: Date.now() - ticketStarted })
    }
  }

  /** Waves: run everything ready, in bounded parallel, then recompute readiness. */
  for (;;) {
    const pending = tickets.filter((ticket) => status.get(ticket.id) === 'pending' && readyNow(ticket))
    if (pending.length === 0) break
    for (let index = 0; index < pending.length; index += maxConcurrent) {
      const wave = pending.slice(index, index + maxConcurrent)
      await Promise.all(wave.map((ticket) => runOne(ticket)))
    }
  }

  /** Whatever is still pending has a blocker that will never succeed. Say which and why. */
  for (const ticket of tickets) {
    if (status.get(ticket.id) !== 'pending') continue
    const blockers = (ticket.dependsOn ?? []).filter((dependency) => status.get(dependency) !== 'ok')
    status.set(ticket.id, 'skipped')
    const reason =
      blockers.length > 0
        ? `依赖未成功：${blockers.map((id) => `${id}=${status.get(id) ?? 'missing'}`).join(', ')}`
        : '依赖成环，无法推进'
    skipped.push({ ticketId: ticket.id, reason })
    emit({ type: 'ticket-skipped', ticketId: ticket.id, reason })
  }

  return { receipts, spawned, skipped, totalMs: Date.now() - started }
}
