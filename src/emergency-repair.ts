/**
 * THE EMERGENCY REPAIR SESSION — `src/emergency-repair.ts`.
 *
 * WHAT THIS IS
 *
 * The step between "the host is dead" and "a repair exists". It creates a SESSION on the bare-metal
 * adapter, assembles it out of `developer/message` (the standing repair protocol) and `user/message`
 * (the crash stack and the source under repair), ignites it through the protocol's own `trigger`, and
 * returns what the model produced.
 *
 * WHY A SESSION AND NOT A SINGLE PROMPT
 *
 * Because the user asked for the shape the slicing plugin already uses, and that shape is right for a
 * reason worth stating: a REPAIR is multi-round in practice. Round one sees the stack; round two sees
 * the source it asked for; round three executes and sees the error. A single prompt cannot carry that.
 * A session can, and it can be READ BACK afterwards — which is what makes "why did it do that?"
 * answerable instead of a matter of faith.
 *
 * WHAT THIS MODULE DOES NOT DO
 *
 * It does not execute the repair. Executing is the launcher's job, through the ToolFactory, and keeping
 * those two apart is what lets a caller DRY-RUN the diagnosis without giving the model a loaded gun.
 */

import type {
  ChatMessage,
  LLMAdapter,
  MessageAdapter,
  SessionAdapter,
  SessionRef,
  ToolFactory,
  TurnTrigger,
} from './protocol/index.js'
import type { GenerationResult } from './protocol/index.js'

/** What a repair session is given, and what it must answer. */
export interface RepairBrief {
  /** The failure as observed — probe name, reason, and any stack text. */
  readonly failure: string
  /** The stack trace, when there is one. Empty string is legitimate (a hang has no stack). */
  readonly stack?: string
  /**
   * Source under repair, as named documents.
   *
   * NAMED, not concatenated: a model that cannot tell which file it is reading will write a patch for
   * the wrong one, and the failure looks like a wrong fix rather than a wrong brief.
   */
  readonly sources?: ReadonlyArray<{ readonly path: string; readonly content: string }>
  /** Extra instruction the caller wants in the setup message. */
  readonly extraInstruction?: string
}

export interface RepairSessionResult {
  /** The session this ran in, so a human can read the transcript afterwards. */
  readonly ref?: SessionRef
  /** What the model produced, verbatim. */
  readonly text: string
  /** The generation result, when a model was called. */
  readonly generation?: GenerationResult
  /** Every message that went into the session, so the brief is auditable. */
  readonly injected: readonly ChatMessage[]
  readonly ok: boolean
  readonly error?: string
}

/**
 * THE STANDING SETUP — what the session is told it is.
 *
 * WHY IT IS SEPARATE FROM `SELF_HEALING_PROMPT.md`: that document is for a human or an AI READING the
 * repository. This constant is what goes into the conversation. They say the same thing at different
 * lengths, and keeping them apart means the long version can stay pedagogical without bloating every
 * request.
 */
export const EMERGENCY_SETUP = `你是一个紧急维修会话，运行在一个宿主已经失效的机器上。

你的处境：
- 宿主（提供会话与工具的那个进程）已经不健康或已经死亡。
- 你手边有：崩溃信息、相关源码、以及一个受限的工具工厂。
- 你**没有**交互式终端，也不会有人在中途回答你。

你的任务只有一个：产出一个能**被直接编译成工具源码**的修复方案。

硬性要求：
1. 只输出一个 JavaScript 对象字面量，形如：
   { description: "...", parameters: { type: "object", properties: {} }, execute: async (args) => { ...; return "结果" } }
2. execute 必须是 async，返回字符串。它会在一个**受限沙箱**里运行：
   - 可以调用 api.readFile(path) / api.writeFile(path, content) / api.listDir(path) / api.exists(path) / api.log(msg)
   - 只能访问被允许的目录，越界会抛 SANDBOX_DENIED
   - require / process 被遮蔽为 undefined
3. 不要输出解释、不要代码围栏、不要前后缀 —— 只输出那个对象。
4. 如果**无法修复**，让 execute 返回 "UNRESOLVED: <原因与建议>"。这是合法且有价值的答案。
   猜一个修复比承认修不好更糟：一个错误的"已修复"会让人停止寻找真因。`

/** Build the material message: failure + stack + sources, in that order. */
function renderBrief(brief: RepairBrief): string {
  const parts: string[] = ['## 故障', brief.failure]
  if (typeof brief.stack === 'string' && brief.stack.trim().length > 0) {
    parts.push('', '## 崩溃堆栈', '```', brief.stack.trim().slice(0, 20_000), '```')
  } else {
    parts.push('', '## 崩溃堆栈', '（没有堆栈：这可能是一次挂死而不是崩溃，先判断进程是否还活着）')
  }
  for (const source of brief.sources ?? []) {
    parts.push('', `## 源码 · ${source.path}`, '```', source.content.slice(0, 30_000), '```')
  }
  if (typeof brief.extraInstruction === 'string' && brief.extraInstruction.length > 0) {
    parts.push('', '## 附加要求', brief.extraInstruction)
  }
  return parts.join('\n')
}

export interface EmergencyRepairOptions {
  readonly session: SessionAdapter
  readonly llm: LLMAdapter
  /** Where the conversation lives, when the caller wants it projected into messages too. */
  readonly messages?: MessageAdapter
  readonly tools?: ToolFactory
  /** Injected clock, so a test can assert the id without waiting. */
  readonly now?: () => number
  /** Workspace for the session. Required by the protocol and never guessed. */
  readonly cwd: string
  /** Prefix for the session id, so a diagnostic can find repair sessions. */
  readonly idPrefix?: string
}

export function createEmergencyRepair(options: EmergencyRepairOptions) {
  const now = options.now ?? (() => Date.now())
  const prefix = options.idPrefix ?? 'repair'

  return {
    /**
     * RUN ONE REPAIR SESSION.
     *
     * THE ORDER IS LOAD-BEARING:
     *   1. create the session            — a container first, so a crash during assembly is visible
     *   2. inject the setup              — `developer/message`, read but never answered
     *   3. inject the material           — `user/message`, the thing that gets answered
     *   4. trigger                       — through the PROTOCOL verb, not a private call
     *   5. ask the model                 — the executor behind `trigger`
     *
     * Step 4 going through `trigger` is the point: a harness that bypassed its own protocol for the one
     * operation it cares most about would never exercise the path that has to work in production.
     */
    async run(brief: RepairBrief): Promise<RepairSessionResult> {
      const id = `${prefix}-${now().toString(36)}`
      const injected: ChatMessage[] = [
        { role: 'system', content: EMERGENCY_SETUP },
        { role: 'user', content: renderBrief(brief) },
      ]

      let ref: SessionRef | undefined
      try {
        const created = await options.session.create({
          cwd: options.cwd,
          id,
          title: `紧急维修 ${id}`,
          items: [
            { visibility: 'context-only', text: EMERGENCY_SETUP, origin: 'plugin:paradise:repair-setup' },
            { visibility: 'visible', text: renderBrief(brief), origin: 'plugin:paradise:repair-material' },
          ],
        })
        if (created.ok !== true || created.session === undefined) {
          return { text: '', injected, ok: false, error: `创建维修会话失败：${created.error?.message ?? 'unknown'}（stage=${created.stage}）` }
        }
        ref = created.session

        /** Project into the caller's message list too, when it has one. */
        await options.messages?.appendMany(injected)

        /**
         * THE MODEL IS THE EXECUTOR BEHIND `trigger`. Wired here, once, so the protocol verb does
         * something real and the adapter's `capabilities.trigger` is honest.
         */
        const generation = await options.llm.generate(injected, {
          system: EMERGENCY_SETUP,
          maxTokens: 4000,
        })

        const triggered = await options.session.trigger(ref, {
          text: '开始诊断并产出修复脚本',
          mode: 'queue',
          origin: 'plugin:paradise:repair-trigger',
        } as TurnTrigger)

        if (generation.error !== undefined) {
          return {
            ref,
            text: generation.text,
            generation,
            injected,
            ok: false,
            error: `模型调用失败：${generation.error.message}`,
          }
        }

        /** Record the answer in the session, so the transcript is complete after the fact. */
        await options.session.inject(ref, [
          { visibility: 'visible', text: generation.text, origin: 'plugin:paradise:repair-answer' },
        ])
        await options.messages?.append({ role: 'assistant', content: generation.text })

        return {
          ref,
          text: generation.text,
          generation,
          injected,
          ok: true,
          ...(triggered.ok === true ? {} : { error: `点火回执不成功：${triggered.error?.message ?? triggered.stage}` }),
        }
      } catch (error) {
        return { ...(ref === undefined ? {} : { ref }), text: '', injected, ok: false, error: String((error as any)?.message ?? error) }
      }
    },
  }
}

/**
 * STRIP A MODEL'S FENCES. Exported because both the launcher and this module need the identical rule,
 * and two copies of "how do I get the code out of this reply" is how a repair that works in one path
 * fails in the other.
 */
export function extractToolSource(text: string): string {
  const trimmed = String(text ?? '').trim()
  if (trimmed.length === 0) return trimmed

  /**
   * STEP 1 — A FENCE AROUND THE WHOLE REPLY. The cleanest signal, and the shape the prompt asks for.
   */
  const whole = trimmed.match(/^```[a-z]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/iu)
  if (whole !== null && typeof whole[1] === 'string') return whole[1].trim()

  /**
   * STEP 2 — A FENCE ANYWHERE IN THE REPLY. THIS IS THE CASE THAT USED TO BREAK IN PRODUCTION.
   *
   * The old rule was `^```…```$`: a fence had to wrap the ENTIRE reply. A model that writes one
   * sentence before the block -- "我来诊断。```js … ```" -- therefore did not match, its prose was
   * compiled as JavaScript, and the loop died with:
   *
   *     TOOL_FAILED: Invalid or unexpected token
   *
   * MEASURED, not theorised: `_scratch/e2e-selfheal.mjs` scenario B reproduced it, and the message
   * named neither the cause nor the cure. A model being chatty is not a repair failure, and rejecting
   * a working repair over presentation is the worst possible place to be strict.
   *
   * When several blocks are present, the one carrying `execute` wins: a model often shows a
   * before/after diff or an unrelated snippet earlier in the reply, and picking the first block blindly
   * would compile the wrong one.
   */
  const blocks = [...trimmed.matchAll(/```[a-z]*[ \t]*\r?\n([\s\S]*?)```/giu)]
  if (blocks.length > 0) {
    const chosen = blocks.find((block) => /\bexecute\b/u.test(block[1] ?? '')) ?? blocks[0]
    const inner = chosen?.[1]
    if (typeof inner === 'string' && inner.trim().length > 0) return inner.trim()
  }

  /**
   * STEP 3 — NO FENCE AT ALL, BUT PROSE AROUND THE OBJECT. Some models answer in ordinary Markdown
   * without fences ("修复方案如下：{ … } 以上。"), and that is a complete, usable answer.
   */
  const inline = extractBalancedObject(trimmed)
  if (inline !== undefined) return inline

  /** STEP 4 — NOTHING RECOGNISABLE. Return it unchanged, so the compile error names the real text. */
  return trimmed
}

/**
 * THE OUTERMOST BALANCED `{…}` THAT CARRIES `execute`, or `undefined`.
 *
 * WHY A SCANNER AND NOT A REGEX: `{` and `}` appear inside the tool's own strings and object literals
 * (`parameters: { type: 'object' }`, a message containing a brace), so a greedy or lazy regex ends the
 * object at the wrong brace and produces source that compiles into something else entirely. This walks
 * the text once, skipping string literals and comments, and returns the slice where depth returns to
 * zero.
 *
 * The returned slice is a bare object literal, which is exactly what the compile contract expects:
 * `new Function('return (' + source + ')')`. Parentheses the model wrapped it in are simply dropped.
 */
function extractBalancedObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined

  let depth = 0
  let quote: string | undefined
  let escaped = false

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]

    if (quote !== undefined) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = undefined
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }

    /** A `}` inside a comment is not a closing brace. Skip the comment wholesale. */
    if (ch === '/' && text[i + 1] === '/') {
      const newline = text.indexOf('\n', i)
      if (newline < 0) break
      i = newline
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end < 0) break
      i = end + 1
      continue
    }

    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        const candidate = text.slice(start, i + 1)
        /** Only a slice that carries the contract is worth returning; otherwise keep looking is pointless. */
        return /\bexecute\b/u.test(candidate) ? candidate : undefined
      }
    }
  }
  return undefined
}

/**
 * DOES A REPAIR ANSWER MEAN "I CANNOT"?
 *
 * Checked in one place so the launcher and any other consumer cannot disagree about whether an answer
 * is a fix or a refusal. The marker is `UNRESOLVED` because both the prompt and `SELF_HEALING_PROMPT.md`
 * ask for it by that name.
 */
export function isUnresolved(text: string): boolean {
  return /UNRESOLVED/u.test(extractToolSource(text))
}
