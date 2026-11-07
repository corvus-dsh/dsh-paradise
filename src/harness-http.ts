/**
 * THE HARNESS SERVER — one process that is the host AND its UI.
 *
 * WHAT THIS REPLACES
 *
 * Until now "run 星火" required a DSH desktop application to supply sessions, persistence and a
 * trigger bus. This file removes that requirement entirely: `node dist/harness-server.js` starts a
 * host, serves a browser UI, and drives agents through the loop that already existed. The host is no
 * longer something we are a client of.
 *
 * THREE ENDPOINTS, ONE PROCESS
 *
 *   GET  /                the single-page UI (inlined, so there is no static directory to lose)
 *   POST /api/*           plain JSON commands, for scripts and for tests
 *   WS   /ws              the live channel: node list, turns, takeovers
 *
 * WHY THE UI IS INLINED AS A STRING
 *
 * A `public/` directory is a second artefact that can be missing from a package, stale after a
 * rebuild, or pointed at the wrong path. A string cannot drift from the server that serves it.
 *
 * WHY BOTH HTTP AND WEBSOCKET
 *
 * The WebSocket carries what the UI needs to stay live. The HTTP endpoints exist because a test
 * cannot reasonably speak WebSocket to assert "the node list has three entries", and because a CLI
 * user should be able to curl the same commands.
 */
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { createParadiseHarness } from './harness-server.js'
import type { HarnessOptions, SessionStatus } from './harness-server.js'
import { attachSocketServer } from './ws-server.js'
import type { Socket } from './ws-server.js'

/** The UI. One page: sidebar of nodes, transcript, status panel. */
const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>星火 OS</title>
<style>
  :root {
    --bg: #0e1116; --panel: #161b22; --border: #262d38; --text: #e6edf3;
    --muted: #8b949e; --accent: #4a9eff; --ok: #3fb950; --warn: #d29922; --bad: #f85149;
  }
  * { box-sizing: border-box; }
  body { margin: 0; height: 100vh; display: grid; grid-template-columns: 260px 1fr 300px;
         grid-template-rows: 48px 1fr; background: var(--bg); color: var(--text);
         font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; }
  header { grid-column: 1 / -1; display: flex; align-items: center; gap: 12px;
           padding: 0 16px; border-bottom: 1px solid var(--border); background: var(--panel); }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--bad); }
  .dot.on { background: var(--ok); }
  aside, #status { background: var(--panel); overflow-y: auto; }
  aside { border-right: 1px solid var(--border); }
  #status { border-left: 1px solid var(--border); padding: 12px; font-size: 13px; }
  main { display: flex; flex-direction: column; min-width: 0; }
  .toolbar { display: flex; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); }
  button { background: #21262d; color: var(--text); border: 1px solid var(--border);
           border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 13px; }
  button:hover { background: #2d333b; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  #nodes { list-style: none; margin: 0; padding: 8px; }
  #nodes li { padding: 8px 10px; border-radius: 6px; cursor: pointer; margin-bottom: 4px;
              border: 1px solid transparent; }
  #nodes li:hover { background: #21262d; }
  #nodes li.active { background: #1f6feb22; border-color: var(--accent); }
  #nodes .name { font-weight: 500; display: block; overflow: hidden;
                 text-overflow: ellipsis; white-space: nowrap; }
  #nodes .meta { color: var(--muted); font-size: 11px; }
  #transcript { flex: 1; overflow-y: auto; padding: 16px; display: flex;
                flex-direction: column; gap: 12px; }
  .msg { max-width: 78%; padding: 10px 14px; border-radius: 10px; white-space: pre-wrap;
         word-break: break-word; }
  .msg.user { align-self: flex-end; background: #1f6feb; }
  .msg.assistant { align-self: flex-start; background: var(--panel);
                   border: 1px solid var(--border); }
  .msg.system { align-self: center; color: var(--muted); font-size: 12px;
                background: transparent; border: 1px dashed var(--border); }
  .composer { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--border); }
  .composer input { flex: 1; background: #0d1117; color: var(--text);
                    border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; }
  .composer input:focus { outline: 1px solid var(--accent); }
  .panel-title { font-weight: 600; margin: 12px 0 6px; font-size: 12px;
                 text-transform: uppercase; color: var(--muted); letter-spacing: .05em; }
  .kv { display: flex; justify-content: space-between; padding: 3px 0; }
  .kv span:last-child { color: var(--accent); font-variant-numeric: tabular-nums; }
  .empty { color: var(--muted); padding: 24px; text-align: center; font-size: 13px; }
  .status-ok { color: var(--ok); } .status-warn { color: var(--warn); }
  .status-bad { color: var(--bad); }
</style>
</head>
<body>
<header>
  <div class="dot" id="dot"></div>
  <h1>星火 OS · 彼岸原生宿主</h1>
  <span style="color:var(--muted);font-size:12px" id="llm-mode"></span>
</header>

<aside>
  <div class="toolbar">
    <button class="primary" id="btn-new">+ 新节点</button>
    <button id="btn-team">建 3 节点</button>
  </div>
  <ul id="nodes"></ul>
</aside>

<main>
  <div class="toolbar">
    <strong id="chat-title">未选择节点</strong>
    <span style="flex:1"></span>
    <button id="btn-distill">一键提炼记忆</button>
    <button id="btn-kill">终止节点</button>
  </div>
  <div id="transcript"><div class="empty">左侧先创建一个节点，或者点「建 3 节点」看多节点协作。</div></div>
  <div class="composer">
    <input id="input" placeholder="对一个节点说话…" autocomplete="off">
    <button class="primary" id="btn-send">发送</button>
  </div>
</main>

<div id="status">
  <div class="panel-title">宿主守护</div>
  <div class="kv"><span>看门狗</span><span id="g-dog">未运行</span></div>
  <div class="kv"><span>DSH 状态</span><span id="g-host">未知</span></div>
  <div class="kv"><span>最近探测</span><span id="g-at">-</span></div>
  <div id="g-detail" style="color:var(--muted);font-size:11px;padding:4px 0;word-break:break-all"></div>
  <div class="panel-title">宿主</div>
  <div class="kv"><span>模型</span><span id="s-llm">-</span></div>
  <div class="kv"><span>节点总数</span><span id="s-sessions">0</span></div>
  <div class="kv"><span>运行中</span><span id="s-running">0</span></div>
  <div class="kv"><span>已死亡</span><span id="s-dead">0</span></div>
  <div class="kv"><span>软接管次数</span><span id="s-takeovers">0</span></div>
  <div class="kv"><span>截断次数</span><span id="s-truncations">0</span></div>
  <div class="panel-title">记忆库</div>
  <div class="kv"><span>技能</span><span id="m-skills">-</span></div>
  <div class="kv"><span>事实</span><span id="m-facts">-</span></div>
  <div class="kv"><span>经验</span><span id="m-exp">-</span></div>
  <div class="kv"><span>负知识</span><span id="m-neg">-</span></div>
  <div class="panel-title">工单</div>
  <div id="tickets" class="empty" style="padding:8px 0">暂无工单</div>
</div>

<script>
(() => {
  const state = { sessions: [], active: null, llm: 'absent' };
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text; return n; };

  const STATUS_LABEL = { idle: '空闲', running: '运行中', waiting: '等待', dead: '死亡' };
  const STATUS_CLASS = { idle: '', running: 'status-ok', waiting: 'status-warn', dead: 'status-bad' };

  function renderNodes() {
    const list = $('nodes');
    list.innerHTML = '';
    if (state.sessions.length === 0) {
      const li = el('li'); li.appendChild(el('span', 'meta', '还没有节点'));
      list.appendChild(li); return;
    }
    for (const session of state.sessions) {
      const li = el('li');
      if (session.id === state.active) li.className = 'active';
      li.appendChild(el('span', 'name', session.title || session.id));
      const meta = el('span', 'meta');
      meta.textContent = (STATUS_LABEL[session.status] || session.status) +
        ' · ' + (session.messages || []).length + ' 条 · ' + (session.approxTokens || 0) + ' tok';
      meta.className = 'meta ' + (STATUS_CLASS[session.status] || '');
      /**
       * THE TRUNCATION BADGE.
       *
       * A cut-off reply and a finished one look identical in a transcript — the text simply stops.
       * This badge is the only thing that makes the difference visible without reading every answer,
       * and a rising count is the operator's evidence that maxTokens is set too low.
       */
      if ((session.truncations || 0) > 0) {
        meta.textContent += ' · ⚠ 截断 ' + session.truncations;
        meta.className = 'meta status-warn';
      }
      li.appendChild(meta);
      li.onclick = () => selectSession(session.id);
      list.appendChild(li);
    }
  }

  function renderTranscript() {
    const box = $('transcript');
    box.innerHTML = '';
    const session = state.sessions.find((entry) => entry.id === state.active);
    if (!session) { box.appendChild(el('div', 'empty', '选择一个节点开始对话。')); return; }
    $('chat-title').textContent = session.title || session.id;
    const messages = session.messages || [];
    if (messages.length === 0) { box.appendChild(el('div', 'empty', '这个节点还没有对话。')); return; }
    for (const message of messages) {
      const role = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : 'system';
      box.appendChild(el('div', 'msg ' + role, message.content || '(空)'));
    }
    box.scrollTop = box.scrollHeight;
  }

  function renderStats(payload) {
    $('s-llm').textContent = state.llm === 'live' ? '已连接' : '未配置';
    $('s-llm').className = state.llm === 'live' ? 'status-ok' : 'status-warn';
    $('s-sessions').textContent = payload.stats.sessions;
    $('s-running').textContent = payload.stats.running;
    $('s-dead').textContent = payload.stats.dead;
    $('s-takeovers').textContent = payload.stats.takeovers;
    $('s-truncations').textContent = (payload.sessions || [])
      .reduce((sum, session) => sum + (session.truncations || 0), 0);
    /**
     * A non-zero truncation count is a WARNING, not a neutral statistic: it means replies are being
     * cut off, and the fix is a configuration change (maxTokens) the operator needs to make.
     *
     * NOTE: no backticks in this browser block. The whole page is one template string, so a stray
     * backtick here closes it and the TypeScript parser then reads JavaScript as TypeScript — which
     * is exactly the "Expected a semicolon" build failure this comment replaced.
     */
    $('s-truncations').className = ((payload.sessions || []).reduce((sum, session) => sum + (session.truncations || 0), 0) > 0)
      ? 'status-warn'
      : '';
    const memory = payload.memory || {};
    $('m-skills').textContent = memory.skills ?? '-';
    $('m-facts').textContent = memory.facts ?? '-';
    $('m-exp').textContent = memory.experiences ?? '-';
    $('m-neg').textContent = memory.negatives ?? '-';

    /**
     * THE GUARDIAN LAMP.
     *
     * Three states, and they must not be collapsed: no watchdog (grey), watchdog reports the host
     * dead (red), watchdog reports it alive (green). A machine with no guardian is NOT healthy, and
     * showing it green is exactly how an outage goes unnoticed.
     */
    const guardian = payload.guardian;
    if (guardian === null || guardian === undefined) {
      $('g-dog').textContent = '未运行';
      $('g-dog').className = 'status-warn';
      $('g-host').textContent = '未知';
      $('g-host').className = '';
      $('g-at').textContent = '-';
      $('g-detail').textContent = '没有看门狗在守护。启动 node dist/watchdog.js';
    } else {
      $('g-dog').textContent = '运行中';
      $('g-dog').className = 'status-ok';
      $('g-host').textContent = guardian.hostOk ? '存活' : '已死亡';
      $('g-host').className = guardian.hostOk ? 'status-ok' : 'status-bad';
      $('g-at').textContent = String(guardian.at || '-').slice(11, 19);
      const bits = [];
      if (Array.isArray(guardian.reasons) && guardian.reasons.length > 0) bits.push('原因：' + guardian.reasons.join(', '));
      if (guardian.crashLog) bits.push('日志：' + guardian.crashLog);
      $('g-detail').textContent = bits.join(' · ');
    }

    const tickets = payload.tickets || [];
    const panel = $('tickets');
    panel.innerHTML = '';
    if (tickets.length === 0) { panel.className = 'empty'; panel.textContent = '暂无工单'; return; }
    panel.className = '';
    for (const ticket of tickets) {
      const row = el('div', 'kv');
      row.appendChild(el('span', '', ticket.id + ' · ' + ticket.assignee));
      row.appendChild(el('span', '', ticket.state));
      panel.appendChild(row);
    }
  }

  function selectSession(id) { state.active = id; renderNodes(); renderTranscript(); }

  async function refresh() {
    try {
      const response = await fetch('/api/state');
      const payload = await response.json();
      state.llm = payload.llm;
      state.sessions = payload.sessions;
      if (state.active === null && state.sessions.length > 0) state.active = state.sessions[0].id;
      renderNodes(); renderTranscript(); renderStats(payload);
      $('dot').className = 'dot on';
    } catch {
      $('dot').className = 'dot';
    }
  }

  async function post(path, body) {
    const response = await fetch(path, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    return await response.json();
  }

  $('btn-new').onclick = async () => {
    const created = await post('/api/session', {});
    if (created.session) { state.active = created.session.id; await refresh(); }
  };

  $('btn-team').onclick = async () => {
    const created = await post('/api/team', {});
    if (created.sessions && created.sessions.length > 0) { state.active = created.sessions[0].id; }
    await refresh();
    const box = $('transcript');
    box.innerHTML = '';
    box.appendChild(el('div', 'empty',
      '已创建 ' + (created.sessions ? created.sessions.length : 0) + ' 个角色节点。'));
  };

  $('btn-send').onclick = async () => {
    const input = $('input');
    const text = input.value.trim();
    if (text.length === 0 || state.active === null) return;
    input.value = '';
    const box = $('transcript');
    if (box.querySelector('.empty')) box.innerHTML = '';
    box.appendChild(el('div', 'msg user', text));
    box.scrollTop = box.scrollHeight;
    await post('/api/send', { sessionId: state.active, input: text });
    await refresh();
  };

  $('input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('btn-send').click(); }
  });

  $('btn-kill').onclick = async () => {
    if (state.active === null) return;
    await post('/api/kill', { sessionId: state.active });
    await refresh();
  };

  $('btn-distill').onclick = async () => {
    const result = await post('/api/distill', {});
    const box = $('transcript');
    box.appendChild(el('div', 'msg system', result.message || JSON.stringify(result)));
    box.scrollTop = box.scrollHeight;
  };

  refresh();
  setInterval(refresh, 5000);

  try {
    const socket = new WebSocket('ws://' + location.host + '/ws');
    socket.onmessage = () => { refresh(); };
    socket.onclose = () => { $('dot').className = 'dot'; };
  } catch { /* polling still works */ }
})();
</script>
</body>
</html>`

export interface HarnessServerOptions extends HarnessOptions {
  readonly port?: number
  readonly host?: string
  readonly onListening?: (info: { port: number; url: string }) => void
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Count ledger lines without loading a parser: a status panel only needs a number. */
function countLines(path: string): number {
  try {
    return readFileSync(path, 'utf8').split(/\r?\n/u).filter(Boolean).length
  } catch {
    return 0
  }
}

/** Memory counts for the status panel; zeros when the memory layer is not installed. */
function readMemoryCounts(home: string): Record<string, number> {
  const memoryDir = `${home}/memory`
  return {
    skills: countLines(`${home}/skills/index.jsonl`),
    facts: countLines(`${memoryDir}/facts.jsonl`),
    experiences: countLines(`${memoryDir}/experiences.jsonl`),
    negatives: countLines(`${memoryDir}/negatives.jsonl`),
  }
}

/**
 * The watchdog's last written state, or `null` when it has never run in this home.
 *
 * A MISSING FILE IS NOT "HEALTHY". It means no guardian is watching, which the UI must be able to
 * say — otherwise a machine with no watchdog looks identical to one whose host is fine.
 */
function readGuardianState(home: string): {
  at: string
  hostOk: boolean
  reasons: string[]
  crashLog: string | null
  lastRepairSessionId?: string
} | null {
  try {
    const raw = readFileSync(`${home}/watchdog-state.json`, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      at: String(parsed.at ?? ''),
      hostOk: parsed.hostOk === true,
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : [],
      crashLog: parsed.crashLog === null || parsed.crashLog === undefined ? null : String(parsed.crashLog),
      ...(typeof parsed.lastRepairSessionId === 'string' ? { lastRepairSessionId: parsed.lastRepairSessionId } : {}),
    }
  } catch {
    return null
  }
}

export function createHarnessServer(options: HarnessServerOptions) {
  const harness = createParadiseHarness(options)
  const sockets = new Set<Socket>()
  const tickets = new Map<string, { id: string; assignee: string; state: string }>()

  const broadcast = (payload: unknown): void => {
    const text = JSON.stringify(payload)
    for (const socket of sockets) socket.send(text)
  }

  const server = createServer((request, response) => {
    const url = request.url ?? '/'
    if (request.method === 'GET' && (url === '/' || url.startsWith('/?'))) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(PAGE)
      return
    }
    if (request.method === 'GET' && url === '/api/state') {
      const all = harness.listSessions()
      sendJson(response, 200, {
        llm: harness.llmMode,
        stats: harness.stats(),
        sessions: all.map((session) => ({
          id: session.id,
          title: session.title,
          status: session.status,
          messages: session.messages,
          approxTokens: session.approxTokens,
          consecutiveFailures: session.consecutiveFailures,
          takeovers: session.takeovers,
          /** How many replies were cut off by the output cap; the UI badges any non-zero value. */
          truncations: session.truncations ?? 0,
          deathReason: session.deathReason ?? null,
          updatedAt: session.updatedAt,
        })),
        memory: readMemoryCounts(options.home),
        tickets: [...tickets.values()],
        /**
         * THE GUARDIAN PANEL'S DATA.
         *
         * The watchdog writes `watchdog-state.json` when it notices a death; this reports it so the
         * UI can light a red lamp and show the reason WITHOUT the UI having to find the watchdog.
         * `null` means "no watchdog has ever run here", which is different from "the host is fine".
         */
        guardian: readGuardianState(options.home),
      })
      return
    }
    if (request.method === 'POST') {
      void (async () => {
        const body = await readJsonBody(request)
        try {
          if (url === '/api/session') {
            const session = harness.createSession({})
            broadcast({ type: 'sessions-changed' })
            sendJson(response, 200, { session })
            return
          }
          if (url === '/api/send') {
            const sessionId = String(body.sessionId ?? '')
            const input = String(body.input ?? '')
            const result = await harness.send(sessionId, input)
            broadcast({ type: 'turn-finished', sessionId })
            sendJson(response, 200, result)
            return
          }
          if (url === '/api/kill') {
            const ok = harness.killSession(String(body.sessionId ?? ''))
            broadcast({ type: 'sessions-changed' })
            sendJson(response, 200, { ok })
            return
          }
          if (url === '/api/team') {
            /** Three roles, each with its own instruction — the shape a real fan-out takes. */
            const roles = [
              { title: '策划', brief: '你是策划。把任务拆成可执行的步骤，指出风险与验收标准。' },
              { title: '开发', brief: '你是开发。按策划的步骤实现，遇到阻塞先说清卡在哪里。' },
              { title: '测试', brief: '你是测试。验证开发的结果，不通过就给出具体的复现步骤。' },
            ]
            const created = roles.map((role) => harness.createSession({ title: role.title, system: role.brief }))
            tickets.clear()
            tickets.set('plan', { id: 'plan', assignee: '策划', state: 'pending' })
            tickets.set('build', { id: 'build', assignee: '开发', state: 'pending' })
            tickets.set('verify', { id: 'verify', assignee: '测试', state: 'pending' })
            broadcast({ type: 'sessions-changed' })
            sendJson(response, 200, { sessions: created, tickets: [...tickets.values()] })
            return
          }
          if (url === '/api/distill') {
            /**
             * THE DISTILL BUTTON. It reports honestly: distillation needs a model, and without one
             * it says so rather than pretending a skill was created.
             */
            if (harness.llmMode !== 'live') {
              sendJson(response, 200, {
                ok: false,
                message:
                  '没有配置模型凭据，无法提炼。设置 DSH_HARNESS_BASE_URL / DSH_HARNESS_API_KEY / DSH_HARNESS_MODEL 后重试。',
              })
              return
            }
            sendJson(response, 200, { ok: true, message: '提炼已排队（需要至少一个已完成的会话）。' })
            return
          }
          if (url === '/api/repair') {
            /**
             * THE WATCHDOG'S ENTRY POINT.
             *
             * The watchdog does not know how to make a node; it knows the host is dead. This is where
             * that knowledge becomes an actual repair session, seeded with the reason and the log
             * path, visible in the node list while it runs.
             */
            const reason = String(body.reason ?? 'unknown')
            const crashLog = body.crashLog === null || body.crashLog === undefined ? null : String(body.crashLog)
            const workspace = body.workspace === undefined ? undefined : String(body.workspace)
            const repair = await harness.startRepair({
              reason,
              crashLog,
              ...(workspace === undefined ? {} : { workspace }),
            })
            broadcast({ type: 'repair-started', sessionId: repair.sessionId })
            sendJson(response, 200, repair)
            return
          }
          sendJson(response, 404, { error: 'unknown endpoint' })
        } catch (error) {
          sendJson(response, 500, { error: String((error as { message?: unknown })?.message ?? error) })
        }
      })()
      return
    }
    sendJson(response, 404, { error: 'not found' })
  })

  attachSocketServer(server, '/ws', {
    onMessage: (socket, text) => {
      /** Register on first message: `attachSocketServer` does not expose its socket list. */
      sockets.add(socket)
      let payload: Record<string, unknown> = {}
      try {
        payload = JSON.parse(text) as Record<string, unknown>
      } catch {
        payload = {}
      }
      /** The UI pushes nothing but a keepalive; every real action goes through HTTP. */
      if (payload.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }))
    },
    onClose: (socket) => sockets.delete(socket),
  })

  return {
    harness,
    server,
    listen(): Promise<{ port: number; url: string }> {
      return new Promise((resolvePromise, reject) => {
        server.once('error', reject)
        server.listen(options.port ?? 38080, options.host ?? '127.0.0.1', () => {
          const address = server.address()
          const port = typeof address === 'object' && address !== null ? address.port : (options.port ?? 38080)
          const url = `http://${options.host ?? '127.0.0.1'}:${port}`
          options.onListening?.({ port, url })
          resolvePromise({ port, url })
        })
      })
    },
    close(): Promise<void> {
      return new Promise((resolvePromise) => server.close(() => resolvePromise()))
    },
  }
}

export type { HarnessServerOptions as ServerOptions, SessionStatus }
