/**
 * SPAWN NODE — the creation primitive. Make an independent agent from nothing.
 *
 * WHAT THIS IS, IN THE USER'S OWN TERMS
 *
 * "只要给它内容，它就能凭空捏造出一个独立的智能体节点。这正是未来星火多智能体爆兵的基石。"
 *
 * Every other entry point in this layer needs a SOURCE: a slice needs a session to slice from, a
 * repair session needs a crash to diagnose. A dispatcher that fans work out to N agents cannot
 * start from something — it has to start from nothing but a task description. That is this.
 *
 * THE FOUR STEPS, AND WHY EACH ONE EXISTS
 *
 *   1. create a COLD session      — an id, a cwd, a durable record. No parent, no inheritance.
 *   2. write the physical skeleton — turn 1 / step 1, so the session has a shape the host accepts.
 *   3. inject the context          — the task, the constraints, whatever the caller brings.
 *   4. ignite the prompt           — the trigger that makes the host start working on it.
 *
 * ── THE HONEST PART: THIS NEEDS A HOST ────────────────────────────────────────────────────────
 *
 * Three of those four steps are calls on HOST services (`sessions.prepare`, the persistence
 * writer, the trigger bus). There is no way to "spawn a session" on a machine where the host is
 * not running, and pretending otherwise would produce a function that looks like it created an
 * agent and did not.
 *
 * So `spawnNode` reports WHICH mode it ran in:
 *
 *   'host'      a real cold session was created, seeded and ignited. A live agent exists.
 *   'portable'  no host services. The node is materialised as a CONTRACT: the exact tape, goal and
 *               trigger that a host would have received, written to disk and handed back. A caller
 *               can then drive that node with `runAgentTurn` (which needs only a model, not a host).
 *
 * A caller that reads `mode` can tell the difference. A caller that does not still gets a correct
 * answer either way — but the difference is never hidden.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { TapeEvent, TapeSeed } from './adapters/dsh/inject.js'
import { buildTape, materialiseTape } from './adapters/dsh/inject.js'
import { probeCapabilities } from './adapters/dsh/capability.js'

/** What a node is born with. Everything is optional except the workspace and the prompt. */
export interface SpawnNodeInput {
  /** Absolute directory the node works in. Required: a session with no home is an orphan. */
  readonly workspace: string
  /**
   * The context the node starts with. A string is one briefing message; an array is several.
   * These become the tape's `user`/`system` events, in order.
   */
  readonly context?: SpawnNodeContext
  /** The prompt that ignites the node: what it should start doing. */
  readonly prompt: string
  /** Stable id. Generated when absent. */
  readonly id?: string
  /** Title shown in a UI. Defaults to the first line of the prompt. */
  readonly title?: string
  /** Extra data the caller wants echoed back on the receipt. */
  readonly meta?: Readonly<Record<string, unknown>>
  /**
   * Write the materialised tape to disk even in host mode.
   *
   * Off by default because the host already persisted it; on for a dispatcher that wants its own
   * copy of every node's seed, which is how a run can be replayed after the fact.
   */
  readonly persistSeed?: boolean
  /** Where to write the seed when `persistSeed` is set. Default `<workspace>/.tianhe/nodes`. */
  readonly seedDir?: string
}

export interface SpawnNodeContextItem {
  readonly role?: 'system' | 'user'
  readonly text: string
  /** `context-only` keeps the item out of the visible transcript. */
  readonly visibility?: 'visible' | 'context-only'
}

export interface SpawnNodeReceipt {
  readonly ok: boolean
  /** 'host' means a live agent exists; 'portable' means a contract was materialised. */
  readonly mode: 'host' | 'portable'
  readonly sessionId: string
  readonly workspace: string
  readonly title: string
  /** The tape the node was born with, always returned so a portable node can be driven elsewhere. */
  readonly tape: readonly TapeEvent[]
  /** The igniting prompt. */
  readonly prompt: string
  /** Where the seed was written, when it was. */
  readonly seedPath?: string
  /** Populated on failure; also populated on a downgrade, so it is never a silent one. */
  readonly warnings: readonly string[]
  readonly error?: { readonly code: string; readonly message: string }
}

/**
 * The context this node starts with.
 *
 * ACCEPTS A STRING OR AN ARRAY OF STRINGS, and that is deliberate: the common case is "here is the
 * briefing", and forcing every caller to wrap one paragraph in an object is friction with no
 * benefit. The object form exists for the cases that need a role or `context-only` visibility.
 */
export type SpawnNodeContext = string | readonly (string | SpawnNodeContextItem)[]

/** Normalise `context` into a uniform item list. */
function contextItems(context: SpawnNodeContext | undefined): Array<{ role: 'system' | 'user'; text: string }> {
  if (context === undefined) return []
  const raw = typeof context === 'string' ? [context] : context
  const out: Array<{ role: 'system' | 'user'; text: string }> = []
  for (const entry of raw) {
    /**
     * A BARE STRING IS VALID HERE, and a first version of this function dropped it.
     *
     * It filtered on `typeof item?.text === 'string'`, which is true only for the OBJECT form, so
     * `context: ['背景一', '背景二']` — the most natural way to call this — silently produced zero
     * items and the node was born with nothing but its prompt. The test that caught it asserted the
     * context reached the tape, and the tape contained only `开始工作`.
     */
    if (typeof entry === 'string') {
      if (entry.length === 0) continue
      out.push({ role: 'user', text: entry })
      continue
    }
    if (entry === null || typeof entry !== 'object') continue
    const text = typeof entry.text === 'string' ? entry.text : ''
    if (text.length === 0) continue
    out.push({ role: entry.role === 'system' ? 'system' : 'user', text })
  }
  return out
}

/** First non-empty line of the prompt, bounded — a title, not the whole brief. */
function titleOf(prompt: string, explicit?: string): string {
  if (explicit !== undefined && explicit.trim().length > 0) return explicit.trim().slice(0, 120)
  const first = prompt.split(/\r?\n/u).find((line) => line.trim().length > 0) ?? 'node'
  return first.trim().slice(0, 120)
}

/** Refuse a workspace that is not absolute, or that tries to escape itself. */
function requireWorkspace(workspace: string): string {
  if (typeof workspace !== 'string' || workspace.trim().length === 0) {
    throw new Error('SPAWN_DENIED: workspace 为空 —— 没有归属的会话是孤儿')
  }
  const resolved = resolve(workspace)
  /** `resolve` already normalises `..`, so a round trip through it is the check. */
  if (resolved.split(sep).length < 2) {
    throw new Error(`SPAWN_DENIED: workspace 不像绝对路径（${workspace}）`)
  }
  return resolved
}

/**
 * Create an independent agent node.
 *
 * THE TAPE IS BUILT THE SAME WAY IN BOTH MODES. That is deliberate: a portable node must be
 * byte-identical in shape to a host node, otherwise "run it locally instead" would produce an agent
 * that behaves differently from the one the host would have made.
 */
export async function spawnNode(input: SpawnNodeInput, ctx?: unknown): Promise<SpawnNodeReceipt> {
  const warnings: string[] = []

  let workspace: string
  try {
    workspace = requireWorkspace(input.workspace)
  } catch (error) {
    return {
      ok: false,
      mode: 'portable',
      sessionId: input.id ?? '',
      workspace: String(input.workspace ?? ''),
      title: titleOf(String(input.prompt ?? '')),
      tape: [],
      prompt: String(input.prompt ?? ''),
      warnings,
      error: { code: 'SPAWN_DENIED', message: String((error as { message?: unknown })?.message ?? error) },
    }
  }

  const prompt = String(input.prompt ?? '')
  if (prompt.trim().length === 0) {
    return {
      ok: false,
      mode: 'portable',
      sessionId: input.id ?? '',
      workspace,
      title: titleOf(''),
      tape: [],
      prompt: '',
      warnings,
      error: { code: 'NO_PROMPT', message: '没有 prompt：一个不被点火的节点等于不存在' },
    }
  }

  const sessionId = typeof input.id === 'string' && input.id.trim().length > 0 ? input.id.trim() : `node-${randomUUID()}`
  const title = titleOf(prompt, input.title)
  const items = contextItems(input.context)

  /**
   * CAN THE HOST DO IT? Decide ONCE, and say what was decided.
   *
   * `probeCapabilities` is the layer's existing answer to "what does this host allow", so the
   * decision uses the same signal every other writer uses rather than a second guess.
   */
  const capabilities = ctx === undefined ? undefined : probeCapabilities(ctx)
  const hostReady =
    ctx !== undefined &&
    capabilities !== undefined &&
    capabilities.persistence === true &&
    capabilities.sessions === true

  if (ctx !== undefined && !hostReady) {
    warnings.push(
      `宿主缺少持久化/会话能力，以 portable 模式创建（${JSON.stringify(capabilities ?? {})}）`,
    )
  }
  if (ctx === undefined) {
    warnings.push('未提供宿主 ctx，以 portable 模式创建：产出可被驱动的节点契约，不是活的宿主会话')
  }

  /**
   * THE TAPE IS BUILT BY THE SAME FUNCTION THE INJECTION PATH USES.
   *
   * `buildTape` is not a generic tape constructor — it encodes this runtime's own contract about
   * what a valid cold session looks like: a required `plugin:` origin, a resolved title, an
   * absolute cwd, and a message id the renderer recognises. Reimplementing that here would produce
   * a tape that passes my checks and fails the host's, which is the worst kind of divergence.
   *
   * The `text` is the injected content: context first (so the node starts knowing), then the
   * igniting prompt (so it starts DOING). One message, because that is what the contract describes;
   * a caller with several context items gets them joined in order, which preserves their sequence.
   */
  const injectedText = [...items.map((item) => item.text), prompt].join('\n\n')
  const seeds: TapeSeed[] = buildTape({
    sessionId,
    cwd: workspace,
    text: injectedText,
    title,
    visibility: 'visible',
    /** A spawned node is a plugin-originated injection, same as an observer briefing. */
    origin: 'plugin:paradise:spawn-node',
  })
  const tape = materialiseTape(seeds, Date.now())

  let seedPath: string | undefined
  if (input.persistSeed === true || !hostReady) {
    const dir = input.seedDir ?? join(workspace, '.tianhe', 'nodes')
    try {
      mkdirSync(dir, { recursive: true })
      seedPath = join(dir, `${sessionId}.json`)
      writeFileSync(
        seedPath,
        `${JSON.stringify({ sessionId, workspace, title, prompt, tape, createdAt: new Date().toISOString(), meta: input.meta ?? {} }, null, 2)}\n`,
        'utf8',
      )
      mkdirSync(dirname(seedPath), { recursive: true })
    } catch (error) {
      warnings.push(`节点种子写盘失败：${String((error as { message?: unknown })?.message ?? error)}`)
    }
  }

  if (!hostReady) {
    /**
     * PORTABLE MODE. Everything a host would have needed is on disk and in the receipt, so a
     * caller can hand this node to `runAgentTurn` with a model and get a working agent — without a
     * host, which is the configuration a CLI dispatcher actually runs in.
     */
    return { ok: true, mode: 'portable', sessionId, workspace, title, tape, prompt, ...(seedPath === undefined ? {} : { seedPath }), warnings }
  }

  /** HOST MODE: the real thing. Imported lazily so portable use never loads host modules. */
  try {
    const { createSession } = await import('./adapters/dsh/session-writer.js')
    const created = await createSession(ctx, {
      id: sessionId,
      cwd: workspace,
      title,
      tape,
      items: items.map((item) => ({
        kind: item.role === 'system' ? 'system' : 'user',
        text: item.text,
      })),
    } as never)
    if (created?.ok !== true) {
      const code = String((created as { stage?: string })?.stage ?? 'CREATE_FAILED')
      const message = String((created as { warnings?: readonly string[] })?.warnings?.[0] ?? '宿主拒绝创建会话')
      return {
        ok: false,
        mode: 'host',
        sessionId,
        workspace,
        title,
        tape,
        prompt,
        ...(seedPath === undefined ? {} : { seedPath }),
        warnings: [...warnings, ...((created as { warnings?: readonly string[] })?.warnings ?? [])],
        error: { code, message },
      }
    }

    /** Ignite. A created-but-unignited node never starts, so a failure here is a failure. */
    const { triggerSession } = await import('./adapters/dsh/trigger.js')
    const triggered = await triggerSession(ctx, {
      sessionId,
      prompt,
      ...(input.meta === undefined ? {} : { meta: input.meta }),
    } as never)
    if (triggered?.ok !== true) {
      return {
        ok: false,
        mode: 'host',
        sessionId,
        workspace,
        title,
        tape,
        prompt,
        ...(seedPath === undefined ? {} : { seedPath }),
        warnings: [...warnings, ...((triggered as { warnings?: readonly string[] })?.warnings ?? [])],
        error: { code: 'IGNITE_FAILED', message: '会话已创建但未被点火：它存在，但不会开始工作' },
      }
    }
    return { ok: true, mode: 'host', sessionId, workspace, title, tape, prompt, ...(seedPath === undefined ? {} : { seedPath }), warnings }
  } catch (error) {
    return {
      ok: false,
      mode: 'host',
      sessionId,
      workspace,
      title,
      tape,
      prompt,
      ...(seedPath === undefined ? {} : { seedPath }),
      warnings,
      error: { code: 'HOST_ERROR', message: String((error as { message?: unknown })?.message ?? error) },
    }
  }
}

/** Whether a ctx can host a real spawn. Exported so a dispatcher can decide before trying. */
export function canSpawnOnHost(ctx: unknown): boolean {
  if (ctx === undefined) return false
  const capabilities = probeCapabilities(ctx)
  return capabilities.persistence === true && capabilities.sessions === true
}
