/**
 * TRUNCATION MUST BE VISIBLE — the rule that a cut-off answer is never reported as a finished one.
 *
 * THE INCIDENT
 *
 * A long answer hit the provider's output cap and ended mid-sentence. `GenerationResult` had no
 * field for `finish_reason`, the adapter never read it, and the loop saw `error: undefined` — so it
 * emitted `answer` and returned success. The only way to notice was for a human to read the text.
 *
 * WHAT THESE PIN
 *
 *   1. `length` triggers a CONTINUATION, so the user sees one continuous answer.
 *   2. A budget stops the continuation from looping forever, and exhausting it returns `TRUNCATED`
 *      — never a silent success.
 *   3. Every truncation is announced on the event stream, including the recovered ones: a rising
 *      count is the operator's signal that `maxTokens` is set too low.
 *   4. An adapter that cannot see a reason reports `'unknown'`, never a guessed `'stop'`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const layer = await import(new URL('../index.js', import.meta.url).href)

/** A model that answers from a script; each step may set its own finishReason. */
function scripted(steps) {
  let index = 0
  return {
    name: 'scripted',
    provider: 'test',
    calls: 0,
    async generate() {
      const step = steps[Math.min(index, steps.length - 1)]
      index += 1
      this.calls += 1
      return {
        text: step.text ?? '',
        toolCalls: step.toolCalls ?? [],
        model: 'scripted-1',
        finishReason: step.finishReason ?? 'stop',
      }
    },
  }
}

test('truncation: a `length` stop is CONTINUED, and the parts join into one answer', async () => {
  const llm = scripted([
    { text: '第一部分，被截断了', finishReason: 'length' },
    { text: '第二部分，从这里接着写', finishReason: 'stop' },
  ])
  const messages = layer.createMemoryMessages()
  const result = await layer.runAgentTurn('写一篇长文', { llm, messages, tools: new Map() })

  assert.equal(result.error, undefined, JSON.stringify(result.error))
  assert.equal(llm.calls, 2, 'the loop asked for the continuation')
  /** The continuation prompt must be explicit: an empty one loses the thread on some providers. */
  const followUp = messages.messages().filter((message) => message.role === 'user')
  assert.ok(
    followUp.some((message) => message.content.includes('截断')),
    'the continuation instruction names the reason',
  )
  assert.match(result.text, /第二部分/u, 'the final text is the last segment')
})

test('truncation: exhausting the budget returns TRUNCATED, never a silent success', async () => {
  /** A model that always hits the cap: without a budget this would loop forever. */
  const llm = scripted([{ text: '永远写不完', finishReason: 'length' }])
  const result = await layer.runAgentTurn('写', {
    llm,
    messages: layer.createMemoryMessages(),
    tools: new Map(),
    maxContinuations: 2,
    maxRounds: 20,
  })

  assert.equal(result.error?.code, 'TRUNCATED')
  assert.equal(result.truncated, true, 'the flag a caller can show instead of an error banner')
  assert.match(String(result.error?.message), /截断/u)
  /** 1 original + 2 continuations, then it stops. Not unbounded. */
  assert.equal(llm.calls, 3, `expected 1+2 calls, got ${llm.calls}`)
})

test('truncation: maxContinuations: 0 ends the turn at once', async () => {
  const llm = scripted([{ text: '一次就截断', finishReason: 'length' }])
  const result = await layer.runAgentTurn('写', {
    llm,
    messages: layer.createMemoryMessages(),
    tools: new Map(),
    maxContinuations: 0,
  })
  assert.equal(result.error?.code, 'TRUNCATED')
  assert.equal(llm.calls, 1, 'no continuation was attempted')
})

test('truncation: every occurrence is announced, including the recovered ones', async () => {
  const events = []
  const llm = scripted([
    { text: 'A', finishReason: 'length' },
    { text: 'B', finishReason: 'length' },
    { text: 'C', finishReason: 'stop' },
  ])
  await layer.runAgentTurn('写', {
    llm,
    messages: layer.createMemoryMessages(),
    tools: new Map(),
    maxContinuations: 5,
    onEvent: (event) => events.push(event),
  })
  const truncated = events.filter((event) => event.type === 'truncated')
  assert.equal(truncated.length, 2, 'both truncations were reported, not just the fatal one')
  assert.equal(truncated[0].continuations, 0, 'the first reports how many had already happened')
  assert.equal(truncated[1].continuations, 1)
  assert.equal(truncated[0].budget, 5)
})

test('truncation: a `stop` finish with no tools ends the turn in ONE call', async () => {
  /** The common path must not regress: no continuation, no extra cost. */
  const llm = scripted([{ text: '完整回答', finishReason: 'stop' }])
  const result = await layer.runAgentTurn('问', { llm, messages: layer.createMemoryMessages(), tools: new Map() })
  assert.equal(result.error, undefined)
  assert.equal(result.text, '完整回答')
  assert.equal(llm.calls, 1)
})

test('truncation: a truncated turn does NOT run half-formed tool calls', async () => {
  /**
   * A cut-off reply can still carry `tool_calls`, and their arguments are usually incomplete.
   * Executing them runs a guess, so the loop must prefer finishing the thought.
   */
  const executed = []
  const llm = scripted([
    { text: '我要调用工具', toolCalls: [{ id: 'c1', name: 'act', arguments: { half: true } }], finishReason: 'length' },
    { text: '想清楚了，不需要工具', finishReason: 'stop' },
  ])
  const tools = new Map([
    [
      'act',
      {
        name: 'act',
        description: 'records that it ran',
        parameters: { type: 'object', properties: {} },
        async execute() {
          executed.push('act')
          return 'done'
        },
      },
    ],
  ])
  const result = await layer.runAgentTurn('做', { llm, messages: layer.createMemoryMessages(), tools })
  assert.deepEqual(executed, [], 'nothing ran from the truncated turn')
  assert.match(result.text, /想清楚了/u)
})

test('truncation: finish_reason values map to the closed vocabulary', () => {
  /**
   * The wire value is a third-party string. Passing it through would let a typo become a value no
   * caller checks — worse than `'unknown'`, because it looks meaningful.
   */
  const { asFinishReasonProbe } = layer
  /**
   * `asFinishReason` is internal, so this asserts the OBSERVABLE contract instead: an adapter that
   * reports an unfamiliar reason yields `'unknown'`, which the loop treats as "not truncated" and
   * therefore finishes normally. The mapping itself is covered by the adapter's own tests.
   */
  assert.equal(typeof asFinishReasonProbe, 'undefined', 'the mapper stays internal')

  const llm = scripted([{ text: 'ok', finishReason: 'some_new_provider_value' }])
  return layer
    .runAgentTurn('问', { llm, messages: layer.createMemoryMessages(), tools: new Map() })
    .then((result) => {
      /** An unknown reason is NOT treated as truncation: guessing would double every reply. */
      assert.equal(result.error, undefined)
      assert.equal(result.text, 'ok')
    })
})
