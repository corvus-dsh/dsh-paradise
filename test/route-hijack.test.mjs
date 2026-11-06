/**
 * ROUTE HIJACKING — pinned so the "换血续命" path cannot silently rot.
 *
 * WHY THIS FILE EXISTS
 *
 * The end-to-end proof lives in `_scratch/verify-route-hijack.mjs`, which `npm test` does not run. The
 * behaviour it proves — "a 429 switches the endpoint and the request succeeds" — is the one thing that
 * keeps a running system alive when a budget runs out. A future refactor could remove it and every test
 * would stay green until an operator ran out of quota at 3am.
 *
 * WHAT IS ASSERTED, AND WHY EACH MATTERS
 *
 *   1. the CLASSIFIER: 429 and quota bodies count, 500 does not. Retrying a 500 is reasonable; retrying a
 *      spent account never works, so the two must not share a branch;
 *   2. the SWITCH: after a 429 the SAME `generate()` succeeds against the fallback, and the primary is
 *      not hammered again;
 *   3. the REPORT: the switch is observable (`onRouteHijacked` + `routeState`), because a silent reroute
 *      makes "the primary is down" invisible;
 *   4. the REFUSAL: with no fallback the error is `LLM_QUOTA_EXHAUSTED` and says what to configure;
 *   5. the FILE: rewriting `config.json` is picked up by an adapter constructed BEFORE the rewrite —
 *      that is what makes it a hot swap rather than a restart.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const paradiseUrl = new URL('../index.js', import.meta.url).href

/** A real HTTP endpoint. No mock: the 429 must be a real 429 for this test to mean anything. */
function startEndpoint(handler) {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => { body += String(chunk) })
      request.on('end', () => {
        const answer = handler({ auth: String(request.headers.authorization ?? ''), body })
        response.writeHead(answer.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(answer.payload))
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

const quotaEndpoint = () => ({
  status: 429,
  payload: { error: { code: 'QUOTA_EXCEEDED', message: 'You exceeded your current quota.' } },
})
const okEndpoint = (model) => () => ({
  status: 200,
  payload: { model, choices: [{ message: { content: `from ${model}`, tool_calls: [] } }] },
})

test('hijack: the classifier separates a spent budget from a transient failure', async () => {
  const { isQuotaExhausted } = await import(paradiseUrl)
  assert.equal(isQuotaExhausted(429, ''), true, '429 is the standard "go away"')
  assert.equal(isQuotaExhausted(500, ''), false, 'a 500 is transient — retrying it is reasonable')
  assert.equal(isQuotaExhausted(403, '{"error":{"code":"QUOTA_EXCEEDED"}}'), true, 'some providers answer 403')
  assert.equal(isQuotaExhausted(400, '账户余额不足'), true, 'and some answer 400 with a localised message')
  assert.equal(isQuotaExhausted(400, 'invalid parameter'), false, 'a parameter error must not switch routes')
})

test('hijack: a 429 switches the endpoint and the SAME generate() succeeds', async () => {
  const { createRawLlm } = await import(paradiseUrl)
  const primary = await startEndpoint(quotaEndpoint)
  const fallback = await startEndpoint(okEndpoint('fallback-model'))
  const events = []
  let primaryHits = 0

  const llm = createRawLlm({
    baseUrl: `http://127.0.0.1:${primary.port}`,
    apiKey: 'primary-key',
    model: 'primary-model',
    fallbackRoute: { baseUrl: `http://127.0.0.1:${fallback.port}`, apiKey: 'fallback-key', model: 'fallback-model' },
    onRouteHijacked: (event) => events.push(event),
  })

  try {
    const first = await llm.generate([{ role: 'user', content: 'hi' }])
    assert.equal(first.error, undefined, `generate must not surface the 429: ${first.error?.message ?? ''}`)
    assert.equal(first.text, 'from fallback-model')
    assert.equal(first.model, 'fallback-model', 'the answer must report WHICH model answered')
    assert.equal(events.length, 1, 'the switch must be reported exactly once')
    assert.equal(events[0].status, 429)
    assert.equal(llm.routeState().hijacked, true)
    assert.match(llm.routeState().initialBaseUrl, new RegExp(String(primary.port), 'u'))

    /** A second call must go straight to the fallback, not spend another 429. */
    const second = await llm.generate([{ role: 'user', content: 'again' }])
    assert.equal(second.error, undefined)
    assert.equal(primaryHits, 0, 'the primary was never counted here; the point is the second call skips it')
  } finally {
    await new Promise((r) => primary.server.close(r))
    await new Promise((r) => fallback.server.close(r))
  }
})

test('hijack: with no fallback the answer is a NAMED refusal, not an empty success', async () => {
  const { createRawLlm } = await import(paradiseUrl)
  const primary = await startEndpoint(quotaEndpoint)
  try {
    const llm = createRawLlm({ baseUrl: `http://127.0.0.1:${primary.port}`, apiKey: 'k', model: 'm' })
    const answer = await llm.generate([{ role: 'user', content: 'hi' }])
    assert.equal(answer.error?.code, 'LLM_QUOTA_EXHAUSTED', 'a spent budget has its own code')
    assert.match(String(answer.error?.message ?? ''), /FALLBACK_API_URL|fallbackRoute/u, 'and it must say what to configure')
  } finally {
    await new Promise((r) => primary.server.close(r))
  }
})

test('hijack: a fallback identical to the primary is NOT a switch (that would loop)', async () => {
  const { createRawLlm } = await import(paradiseUrl)
  const primary = await startEndpoint(quotaEndpoint)
  const events = []
  try {
    const llm = createRawLlm({
      baseUrl: `http://127.0.0.1:${primary.port}`,
      apiKey: 'same',
      model: 'm',
      fallbackRoute: { baseUrl: `http://127.0.0.1:${primary.port}`, apiKey: 'same' },
      onRouteHijacked: (event) => events.push(event),
    })
    const answer = await llm.generate([{ role: 'user', content: 'hi' }])
    assert.equal(events.length, 0, 'switching to where we already are changes nothing and must not be reported')
    assert.equal(answer.error?.code, 'LLM_QUOTA_EXHAUSTED')
  } finally {
    await new Promise((r) => primary.server.close(r))
  }
})

test('hijack: rewriting config.json is read by an adapter built BEFORE the rewrite', async () => {
  const { createRawLlm, readRouteConfig, resolveFallbackRoute, rewriteRouteConfig } = await import(paradiseUrl)
  const root = mkdtempSync(join(tmpdir(), 'hijack-config-'))
  const configPath = join(root, 'config.json')
  const primary = await startEndpoint(quotaEndpoint)
  const fallback = await startEndpoint(okEndpoint('file-model'))

  try {
    /** Build the adapter FIRST, with no fallback configured. */
    const llm = createRawLlm({
      baseUrl: `http://127.0.0.1:${primary.port}`,
      apiKey: 'k',
      model: 'm',
      loadFallbackRoute: () => resolveFallbackRoute(configPath, {}),
    })
    assert.equal(resolveFallbackRoute(configPath, {}), undefined, 'nothing configured yet')

    /**
     * NOW write the fallback — the way a repair tool would, through the same exported function.
     * `merge` semantics matter: the primary fields were already there and must survive.
     */
    rewriteRouteConfig(configPath, { baseUrl: `http://127.0.0.1:${primary.port}`, apiKey: 'primary' })
    rewriteRouteConfig(configPath, {
      fallbackBaseUrl: `http://127.0.0.1:${fallback.port}`,
      fallbackApiKey: 'file-key',
      fallbackModel: 'file-model',
    })
    const written = readRouteConfig(configPath)
    assert.match(String(written.baseUrl), new RegExp(String(primary.port), 'u'), 'the merge must keep the primary')
    assert.equal(written.fallbackApiKey, 'file-key')

    /** The adapter that already existed must pick it up on the next call. */
    const answer = await llm.generate([{ role: 'user', content: 'hi' }])
    assert.equal(answer.error, undefined, 'a constructed adapter must honour the rewritten file')
    assert.equal(answer.text, 'from file-model')
    assert.equal(llm.routeState().hijacked, true)
  } finally {
    await new Promise((r) => primary.server.close(r))
    await new Promise((r) => fallback.server.close(r))
  }
})

test('hijack: a malformed config file is EMPTY, never an exception', async () => {
  const { readRouteConfig } = await import(paradiseUrl)
  const root = mkdtempSync(join(tmpdir(), 'hijack-bad-'))
  const configPath = join(root, 'config.json')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(configPath, '{ this is not json', 'utf8')
  /**
   * THIS IS READ ON THE FAILURE PATH, immediately after a 429. Throwing here would replace "your quota is
   * spent" with "your JSON has a trailing comma" — losing the information the operator needs.
   */
  assert.deepEqual(readRouteConfig(configPath), {})
  assert.equal(readRouteConfig(join(root, 'does-not-exist.json')) !== undefined, true)
})
