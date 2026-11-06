/**
 * THE AGENT LOOP, WITHOUT A HOST.
 *
 * WHAT THIS PROVES
 *
 *   input → recall → model → tool → tool → tool → answer
 *
 * with no DSH module imported, no event bus, and no session log. The only collaborators are
 * `LLMAdapter`, `MessageAdapter` and a tool map — plain interfaces.
 *
 * WHY A SCRIPTED MODEL
 *
 * There is no provider credential in this environment, and a test that needs one cannot be run
 * by the next person either. The loop's responsibility is the CONTROL FLOW (which round asks
 * for which tool, what gets appended, when it stops), and a scripted adapter tests exactly
 * that. The real provider path is exercised by `adapters/raw/llm.ts`'s own tests.
 *
 * This is stated rather than hidden: a scripted model proves the loop, not the network.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const layer = await import(new URL('../index.js', import.meta.url).href)

/** A model that answers from a script: each call consumes the next step. */
function scriptedLlm(steps) {
  let index = 0
  return {
    name: 'scripted',
    provider: 'test',
    async generate(messages) {
      const step = steps[Math.min(index, steps.length - 1)]
      index += 1
      const next = typeof step === 'function' ? step(messages, index) : step
      return { text: next.text ?? '', toolCalls: next.toolCalls ?? [], model: 'scripted-1' }
    },
  }
}

function memoryTool(name, result, record) {
  return {
    name,
    description: `test tool ${name}`,
    parameters: { type: 'object', properties: {} },
    async execute(args) {
      record.push({ name, args })
      return result
    },
  }
}

test('agent loop: three tool calls complete one task', async () => {
  const calls = []
  const tools = new Map([
    ['read_config', memoryTool('read_config', '{"port":8080,"hostDb":"missing.db"}', calls)],
    ['check_health', memoryTool('check_health', '{"ok":false,"reason":"hostDb unreadable"}', calls)],
    ['write_report', memoryTool('write_report', '{"written":"report.md"}', calls)],
  ])

  const llm = scriptedLlm([
    { toolCalls: [{ id: 'c1', name: 'read_config', arguments: {} }] },
    { toolCalls: [{ id: 'c2', name: 'check_health', arguments: {} }] },
    { toolCalls: [{ id: 'c3', name: 'write_report', arguments: { path: 'report.md' } }] },
    { text: '诊断完成：hostDb 指向不存在的文件，已写入 report.md' },
  ])

  const messages = layer.createMemoryMessages()
  const result = await layer.runAgentTurn('诊断这个服务为什么起不来', { llm, messages, tools })

  assert.equal(result.error, undefined, JSON.stringify(result.error))
  assert.equal(result.rounds, 4, 'three tool rounds plus the final answer')
  assert.equal(result.toolCalls.length, 3, 'every requested tool ran')
  assert.deepEqual(
    result.toolCalls.map((call) => call.name),
    ['read_config', 'check_health', 'write_report'],
    'tools ran in the order the model asked for them',
  )
  assert.ok(result.toolCalls.every((call) => call.ok), 'none of them failed')
  assert.match(result.text, /诊断完成/u, 'the model’s final text is returned')
  assert.equal(calls.length, 3, 'each tool executed exactly once')

  /**
   * The conversation must be faithful: a `tool` message per call, carrying the matching
   * `toolCallId`. A loop that appends the result without the id breaks every provider that
   * correlates calls by id.
   */
  const history = messages.messages()
  const toolMessages = history.filter((message) => message.role === 'tool')
  assert.equal(toolMessages.length, 3)
  assert.deepEqual(toolMessages.map((message) => message.toolCallId), ['c1', 'c2', 'c3'])
})

test('agent loop: a model that answers immediately makes exactly one round', async () => {
  const tools = new Map()
  const llm = scriptedLlm([{ text: '不需要工具' }])
  const messages = layer.createMemoryMessages()
  const result = await layer.runAgentTurn('你好', { llm, messages, tools })
  assert.equal(result.rounds, 1)
  assert.equal(result.toolCalls.length, 0)
  assert.equal(result.text, '不需要工具')
})

test('agent loop: recall context reaches the model', async () => {
  let seenPrompt = ''
  const llm = {
    name: 'capture',
    provider: 'test',
    async generate(messages) {
      const first = messages.find((message) => message.role === 'user')
      seenPrompt = first?.content ?? ''
      return { text: 'ok', toolCalls: [], model: 'capture' }
    },
  }
  const result = await layer.runAgentTurn('部署脚本报错', {
    llm,
    messages: layer.createMemoryMessages(),
    tools: new Map(),
    recall: () => '负知识：部署脚本必报 SOURCE_DRIFT，改用 boundarySeq',
  })
  assert.equal(result.recalled.includes('SOURCE_DRIFT'), true)
  assert.match(seenPrompt, /SOURCE_DRIFT/u, 'the recalled memory is part of the user prompt')
  assert.match(seenPrompt, /部署脚本报错/u, 'the user input is still there')
})

test('agent loop: a throwing tool does not end the turn', async () => {
  const llm = scriptedLlm([
    { toolCalls: [{ id: 'c1', name: 'boom', arguments: {} }] },
    { text: '工具失败了，但我知道了原因' },
  ])
  const tools = new Map([
    [
      'boom',
      {
        name: 'boom',
        description: 'always throws',
        parameters: { type: 'object', properties: {} },
        async execute() {
          throw new Error('disk on fire')
        },
      },
    ],
  ])
  const messages = layer.createMemoryMessages()
  const result = await layer.runAgentTurn('试试', { llm, messages, tools })
  assert.equal(result.rounds, 2, 'the loop continued after the failure')
  assert.equal(result.toolCalls[0].ok, false)
  assert.match(String(result.toolCalls[0].error), /disk on fire/u)
  assert.equal(result.text.includes('工具失败'), true)
  /** The failure must be visible to the model, with isError set. */
  const toolMessage = messages.messages().find((message) => message.role === 'tool')
  assert.equal(toolMessage.isError, true)
  assert.match(toolMessage.content, /disk on fire/u)
})

test('agent loop: an unknown tool is reported back, not thrown', async () => {
  const llm = scriptedLlm([{ toolCalls: [{ id: 'c1', name: 'nonexistent', arguments: {} }] }, { text: '好吧' }])
  const result = await layer.runAgentTurn('调用不存在的工具', { llm, messages: layer.createMemoryMessages(), tools: new Map() })
  assert.equal(result.rounds, 2)
  assert.equal(result.toolCalls[0].ok, false)
  assert.match(String(result.toolCalls[0].error), /no tool named/u)
})

test('agent loop: the round budget ends an endless tool loop', async () => {
  /** A model that never stops asking: without a budget this runs forever. */
  const llm = scriptedLlm([{ toolCalls: [{ id: 'c1', name: 'again', arguments: {} }] }])
  const tools = new Map([
    [
      'again',
      {
        name: 'again',
        description: 'always',
        parameters: { type: 'object', properties: {} },
        async execute() {
          return 'ok'
        },
      },
    ],
  ])
  const result = await layer.runAgentTurn('循环', { llm, messages: layer.createMemoryMessages(), tools, maxRounds: 3 })
  assert.equal(result.rounds, 3)
  assert.equal(result.error?.code, 'ROUND_BUDGET_EXHAUSTED')
})

test('agent loop: a model error ends the turn and is reported', async () => {
  const llm = {
    name: 'failing',
    provider: 'test',
    async generate() {
      return { text: '', toolCalls: [], model: 'x', error: { code: 'PROVIDER_DOWN', message: 'connection refused' } }
    },
  }
  const result = await layer.runAgentTurn('问一句', { llm, messages: layer.createMemoryMessages(), tools: new Map() })
  assert.equal(result.rounds, 1)
  assert.equal(result.error?.code, 'PROVIDER_DOWN')
})

test('agent loop: the conversation accumulates across turns', async () => {
  const llm = scriptedLlm([{ text: '第一轮' }, { text: '第二轮' }])
  const messages = layer.createMemoryMessages()
  await layer.runAgentTurn('第一句', { llm, messages, tools: new Map() })
  const afterFirst = messages.messages().length
  await layer.runAgentTurn('第二句', { llm, messages, tools: new Map() })
  assert.ok(messages.messages().length > afterFirst, 'the second turn appended to the same history')
  assert.equal(messages.messages().filter((message) => message.role === 'user').length, 2)
})

test('agent loop: compact keeps the pinned message and reports what it removed', async () => {
  const messages = layer.createMemoryMessages([{ role: 'system', content: 'PINNED RULE' }])
  messages.pin(0)
  for (let index = 0; index < 40; index += 1) {
    await messages.append({ role: 'user', content: `filler ${index} `.repeat(20) })
  }
  const { removed, kept } = await messages.compact(200)
  assert.ok(removed.length > 0, 'compaction removed something')
  assert.ok(messages.messages()[0].content.includes('PINNED RULE'), 'the pinned message survived')
  assert.equal(messages.messages().length, kept)
})
