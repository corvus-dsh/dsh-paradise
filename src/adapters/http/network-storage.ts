/**
 * A REAL NETWORK STORE — `src/adapters/http/network-storage.ts`.
 *
 * WHAT THIS IS: two HTTP endpoints and a client, so `NetworkStorageAdapter` stops being a type and starts
 * being something that moves bytes between processes. A `serve` side owns a keyed store; a `connect` side
 * speaks to it and reports what it can honestly promise.
 *
 * WHY `node:http` AND NOT A FRAMEWORK: the point is to prove the PROTOCOL carries across a socket, not to
 * demonstrate an ecosystem. A dependency here would also mean the bare-machine harness needs it, and the
 * whole arc of this work is that it does not.
 *
 * WHAT IT HONESTLY GUARANTEES, AND WHY EACH FIELD IS DEFENSIBLE
 *
 *   linearizable: true          — ONE server process owns the state. There is no replica to lag.
 *   staleByMs: 0                — every read is a request to that process; there is nothing to be stale.
 *   idempotentRetries: true     — the server keeps an idempotency ledger, so a retried write with the same
 *                                 key returns the FIRST result instead of applying twice.
 *   compareAndSetScope: 'node'  — the CAS is atomic WITHIN the server. Two servers would not agree, and
 *                                 this field says so instead of pretending.
 *
 * THE IDEMPOTENCY LEDGER IS THE INTERESTING PART
 *
 * A retry is indistinguishable from a new request at the wire level — that is the entire difficulty of a
 * network store. So the server records `idempotencyKey → result` and answers a repeat with the recorded
 * result. Without it, "the client timed out and retried" becomes two writes, and every caller downstream
 * has to be defensive.
 *
 * WHAT THIS IS NOT
 *
 * Not a consensus protocol, not replicated, not authenticated. It is the smallest thing that makes the
 * network contract TESTABLE, which is what a protocol needs before anything is built on it.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type {
  MutationReceipt,
  NetworkEnvelope,
  NetworkGuarantees,
  NetworkReadReport,
  NetworkStorageAdapter,
  NetworkWriteRequest,
  ProtocolFailure,
} from '../../protocol/index.js'

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * THE SERVER — one process owns the state
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

interface StoredValue {
  value: unknown
  version: number
}

export interface NetworkServerOptions {
  /** The id this node reports to clients. Diagnostic; never compared for ordering. */
  readonly nodeId: string
  readonly host?: string
  /** `0` means "let the OS pick", which is what a test wants. */
  readonly port?: number
  /** How long an idempotency key is remembered. Default 10 minutes. */
  readonly idempotencyTtlMs?: number
}

export interface NetworkServer {
  readonly nodeId: string
  readonly port: number
  readonly url: string
  /** Stop accepting, and close. Resolves when the handle is closed. */
  close(): Promise<void>
  /** Everything this node currently holds. For assertions, not for callers. */
  snapshot(): Record<string, StoredValue>
}

/** The JSON shape every response uses. `ok: false` carries a `ProtocolFailure`. */
type WireResponse =
  | { ok: true; value?: unknown; version?: number; servedBy: string }
  | { ok: false; error: ProtocolFailure; servedBy: string }

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

/**
 * START A NODE.
 *
 * THE STATE IS A PLAIN MAP AND THAT IS CORRECT HERE: everything enters through one `handle()` call, and
 * Node runs it to completion without interleaving — so each request is atomic with respect to the others.
 * A mutex would be theatre; a WORKER would be a different, slower design with the same guarantee.
 */
export async function startNetworkNode(options: NetworkServerOptions): Promise<NetworkServer> {
  const store = new Map<string, StoredValue>()
  const idempotency = new Map<string, { at: number; response: WireResponse }>()
  const ttl = Math.max(1, Math.trunc(options.idempotencyTtlMs ?? 600_000))

  const expiry = (): void => {
    const cutoff = Date.now() - ttl
    for (const [key, entry] of idempotency) if (entry.at < cutoff) idempotency.delete(key)
  }

  /**
   * ONE REQUEST, HANDLED. The only place that mutates `store`.
   *
   * `envelope.op` is a CLOSED vocabulary and an unknown op is REFUSED rather than ignored — a receiver
   * that silently ignores an operation it does not understand is a receiver that reports success for
   * work it never did.
   */
  function handle(envelope: NetworkEnvelope): WireResponse {
    const servedBy = options.nodeId
    switch (envelope.op) {
      case 'healthy':
        return { ok: true, servedBy }

      case 'read': {
        const key = String(envelope.key ?? '')
        const entry = store.get(key)
        return { ok: true, value: entry?.value, version: entry?.version ?? 0, servedBy }
      }

      case 'keys': {
        const prefix = typeof envelope.payload === 'string' ? envelope.payload : undefined
        const keys = [...store.keys()].filter((key) => prefix === undefined || key.startsWith(prefix))
        return { ok: true, value: keys, servedBy }
      }

      case 'write': {
        const payload = envelope.payload as NetworkWriteRequest | undefined
        if (payload === undefined || typeof payload.key !== 'string') {
          return { ok: false, servedBy, error: { code: 'BAD_REQUEST', stage: 'write', message: '缺少 key' } }
        }
        /**
         * THE IDEMPOTENCY CHECK RUNS FIRST — before any mutation.
         *
         * A repeat answers with the ORIGINAL result, including its version. Answering with a NEW version
         * would tell the caller its retry changed something, which is exactly the lie this ledger exists
         * to prevent.
         */
        const recorded = idempotency.get(payload.idempotencyKey)
        if (recorded !== undefined) return recorded.response

        const current = store.get(payload.key)
        if (payload.expectedVersion !== undefined && (current?.version ?? 0) !== payload.expectedVersion) {
          const conflict: WireResponse = {
            ok: false,
            servedBy,
            error: {
              code: 'VERSION_CONFLICT',
              stage: 'write',
              message: `期望版本 ${payload.expectedVersion}，实际 ${current?.version ?? 0}`,
            },
          }
          /**
           * A CONFLICT IS NOT RECORDED AS AN IDEMPOTENT RESULT: the same key retried later might succeed
           * (the other writer may have moved on), and caching the refusal would make the key permanently
           * unwritable for that client.
           */
          return conflict
        }
        const version = (current?.version ?? 0) + 1
        store.set(payload.key, { value: payload.value, version })
        const answer: WireResponse = { ok: true, version, servedBy }
        expiry()
        idempotency.set(payload.idempotencyKey, { at: Date.now(), response: answer })
        return answer
      }

      case 'remove': {
        const key = String(envelope.key ?? '')
        const existed = store.delete(key)
        return { ok: true, value: existed, servedBy }
      }

      case 'compareAndSet': {
        const payload = envelope.payload as (NetworkWriteRequest & { expectedVersion: number }) | undefined
        if (payload === undefined || typeof payload.key !== 'string') {
          return { ok: false, servedBy, error: { code: 'BAD_REQUEST', stage: 'compareAndSet', message: '缺少 key' } }
        }
        const recorded = idempotency.get(payload.idempotencyKey)
        if (recorded !== undefined) return recorded.response
        const current = store.get(payload.key)
        if ((current?.version ?? 0) !== payload.expectedVersion) {
          return {
            ok: false,
            servedBy,
            error: { code: 'VERSION_CONFLICT', stage: 'compareAndSet', message: `期望 ${payload.expectedVersion}，实际 ${current?.version ?? 0}` },
          }
        }
        const version = (current?.version ?? 0) + 1
        store.set(payload.key, { value: payload.value, version })
        const answer: WireResponse = { ok: true, version, servedBy }
        idempotency.set(payload.idempotencyKey, { at: Date.now(), response: answer })
        return answer
      }

      default: {
        const op = String((envelope as { op?: unknown }).op ?? '(missing)')
        return { ok: false, servedBy, error: { code: 'UNKNOWN_OP', stage: 'dispatch', message: `未知操作 ${op}` } }
      }
    }
  }

  const server: Server = createServer((request, response) => {
    void (async () => {
      try {
        if (request.method !== 'POST') {
          send(response, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', stage: 'dispatch', message: '只接受 POST' } })
          return
        }
        const raw = await readBody(request)
        let envelope: NetworkEnvelope
        try {
          envelope = JSON.parse(raw) as NetworkEnvelope
        } catch {
          send(response, 400, { ok: false, error: { code: 'BAD_JSON', stage: 'parse', message: raw.slice(0, 200) } })
          return
        }
        if (typeof envelope?.op !== 'string' || typeof envelope?.callId !== 'string') {
          send(response, 400, { ok: false, error: { code: 'BAD_ENVELOPE', stage: 'parse', message: '缺少 op 或 callId' } })
          return
        }
        send(response, 200, handle(envelope))
      } catch (error) {
        send(response, 500, { ok: false, error: { code: 'SERVER_ERROR', stage: 'handle', message: String((error as any)?.message ?? error) } })
      }
    })()
  })

  await new Promise<void>((ready, failed) => {
    server.once('error', failed)
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      server.removeListener('error', failed)
      ready()
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : (options.port ?? 0)

  return {
    nodeId: options.nodeId,
    port,
    url: `http://${options.host ?? '127.0.0.1'}:${port}`,
    async close(): Promise<void> {
      await new Promise<void>((done) => server.close(() => done()))
    },
    snapshot(): Record<string, StoredValue> {
      return Object.fromEntries(store)
    },
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * THE CLIENT — a NetworkStorageAdapter over fetch
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */

export interface NetworkClientOptions {
  /** Where the node lives, e.g. `http://127.0.0.1:12345`. */
  readonly endpoint: string
  /** Injected for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch
  /** Per-call budget. A network store without a deadline hangs a caller. Default 10s. */
  readonly timeoutMs?: number
  /** How many times a timed-out call is retried with the SAME idempotency key. Default 2. */
  readonly retries?: number
  /** Injected so a retry test does not need real clock time. */
  readonly now?: () => number
}

/**
 * `ok` RECEIPTS, NAMED SO THE BUNDLE'S SINGLE SCOPE DOES NOT COLLIDE.
 *
 * The package ships as ONE inlined file, so every module shares one scope — and `adapters/memory/`
 * already declares a `receipt` helper. The composer caught it as a duplicate identifier.
 *
 * THE NAME IS NOT COSMETIC: two helpers with the same name in one scope means whichever loads first wins,
 * and the two would then have to agree forever. A qualified name makes the ownership visible.
 */
function networkReceipt(stage: string, warnings: string[] = []): MutationReceipt {
  return { ok: true, stage, warnings }
}

function networkFailure(stage: string, message: string, code = 'NETWORK_ERROR'): MutationReceipt {
  return { ok: false, stage, warnings: [], error: { code, stage, message } }
}

/**
 * CONNECT TO A NODE.
 *
 * THE GUARANTEES ARE COMPUTED FROM WHAT THE SERVER SAYS IT IS, not from optimism: this client talks to ONE
 * endpoint, so `linearizable` and `staleByMs: 0` are true of THAT node — and `compareAndSetScope` is
 * `'node'` because a second node would not participate. A client pointed at a replica would need different
 * answers, and it would get them from a different constructor rather than from a flag here.
 */
export function connectNetworkNode(options: NetworkClientOptions): NetworkStorageAdapter & { close?(): void } {
  const endpoint = options.endpoint.replace(/\/+$/u, '')
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? 10_000))
  const retries = Math.max(0, Math.trunc(options.retries ?? 2))
  const now = options.now ?? (() => Date.now())
  let counter = 0

  const guarantees: NetworkGuarantees = {
    linearizable: true,
    staleByMs: 0,
    idempotentRetries: true,
    compareAndSetScope: 'node',
  }

  /** One envelope, one POST, with a deadline that actually fires. */
  async function call(envelope: NetworkEnvelope): Promise<WireResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`超时 ${timeoutMs}ms`)), timeoutMs)
    if (typeof (timer as any).unref === 'function') (timer as any).unref()
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...envelope, deadlineAt: now() + timeoutMs }),
        signal: controller.signal,
      })
      const payload = (await response.json()) as WireResponse
      return payload
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * A WRITE THAT SURVIVES A TIMEOUT.
   *
   * THE KEY IS THE WHOLE MECHANISM: the same `idempotencyKey` on every attempt means the server can
   * collapse them into one effect. Without it, retrying is a bet — and a bet is not a contract.
   */
  async function writeWithRetry(request: NetworkWriteRequest, op: 'write' | 'compareAndSet'): Promise<WireResponse> {
    let lastError = ''
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await call({ op, callId: request.idempotencyKey, key: request.key, payload: request })
      } catch (error) {
        lastError = String((error as any)?.message ?? error)
        /**
         * A CONFLICT IS NOT RETRIED. The server answered — it just said no. Retrying a refusal turns one
         * lost race into N lost races and hides the fact that another writer is active.
         */
        if (/VERSION_CONFLICT/u.test(lastError)) break
      }
    }
    return {
      ok: false,
      servedBy: '',
      error: { code: 'NETWORK_WRITE_FAILED', stage: op, message: lastError || '未知错误' },
    }
  }

  const adapter: NetworkStorageAdapter & { close?(): void } = {
    name: 'http-network-storage',
    tier: 'file',
    endpoint,
    guarantees,

    /* ── the local StorageAdapter contract, answered over the wire ───────────────────── */

    async read(key: string): Promise<unknown> {
      /** Wrapped for the same reason as `readRemote`: a store that throws on a dropped packet is unusable. */
      try {
        const answer = await call({ op: 'read', callId: `r-${++counter}`, key })
        return answer.ok ? answer.value : undefined
      } catch {
        return undefined
      }
    },

    async write(key: string, value: unknown): Promise<MutationReceipt> {
      const answer = await writeWithRetry({ key, value, idempotencyKey: `w-${++counter}-${now().toString(36)}` }, 'write')
      if (!answer.ok) return networkFailure('write', answer.error.message, answer.error.code)
      return networkReceipt('write')
    },

    async remove(key: string): Promise<MutationReceipt> {
      try {
        const answer = await call({ op: 'remove', callId: `d-${++counter}`, key })
        return answer.ok ? networkReceipt('remove') : networkFailure('remove', answer.error.message, answer.error.code)
      } catch (error) {
        return networkFailure('remove', String((error as any)?.message ?? error))
      }
    },

    async keys(prefix?: string): Promise<string[]> {
      try {
        const answer = await call({ op: 'keys', callId: `k-${++counter}`, payload: prefix })
        return answer.ok && Array.isArray(answer.value) ? (answer.value as string[]) : []
      } catch {
        return []
      }
    },

    /* ── the network-only members ──────────────────────────────────────────────────── */

    async readRemote(key: string): Promise<NetworkReadReport> {
      /**
       * A READ MUST NEVER THROW — the protocol says so, and the first version of this method did anyway.
       *
       * Measured against a closed port: `fetch` rejects with `TypeError: fetch failed` (here: "bad port"),
       * and because the call was not wrapped, that exception escaped `readRemote` and took the caller down.
       * A store probe is DIAGNOSTIC — the one thing it must never do is kill the thing it is diagnosing.
       *
       * THE STATUS FOR THIS CASE IS `corrupt`, NOT `missing`: "I could not reach the store" and "the store
       * says you never wrote it" are opposite facts, and a caller that confuses them will overwrite data
       * it still has.
       */
      let answer: WireResponse
      try {
        answer = await call({ op: 'read', callId: `rr-${++counter}`, key })
      } catch (error) {
        return {
          value: undefined,
          status: 'corrupt',
          servedBy: '',
          stalenessMs: 0,
          warnings: [`网络读取失败：${String((error as any)?.message ?? error)}`],
        }
      }
      if (!answer.ok) {
        return {
          value: undefined,
          status: 'corrupt',
          servedBy: answer.servedBy,
          stalenessMs: 0,
          warnings: [answer.error.message],
        }
      }
      return {
        value: answer.value,
        /**
         * `missing` VERSUS `ok` IS DECIDED BY THE VERSION, not by `undefined`.
         *
         * A store can legitimately hold `null` — and a caller that treats `null` as "absent" will overwrite
         * a deliberate deletion marker with a fresh value. Version 0 means "never written".
         */
        status: answer.version === 0 ? 'missing' : 'ok',
        servedBy: answer.servedBy,
        ...(answer.version === undefined ? {} : { version: answer.version }),
        stalenessMs: 0,
        warnings: [],
      }
    },

    async writeRemote(request: NetworkWriteRequest): Promise<MutationReceipt & { version?: number }> {
      const answer = await writeWithRetry(request, 'write')
      if (!answer.ok) return { ...networkFailure('writeRemote', answer.error.message, answer.error.code) }
      return { ...networkReceipt('writeRemote'), ...(answer.version === undefined ? {} : { version: answer.version }) }
    },

    async compareAndSetRemote(request: NetworkWriteRequest & { expectedVersion: number }): Promise<{
      ok: boolean
      version?: number
      warnings: string[]
      error?: ProtocolFailure
    }> {
      const answer = await writeWithRetry(request, 'compareAndSet')
      if (!answer.ok) return { ok: false, warnings: [], error: answer.error }
      return { ok: true, warnings: [], ...(answer.version === undefined ? {} : { version: answer.version }) }
    },

    async healthy(): Promise<boolean> {
      try {
        const answer = await call({ op: 'healthy', callId: `h-${++counter}` })
        return answer.ok === true
      } catch {
        return false
      }
    },
  }

  return adapter
}
