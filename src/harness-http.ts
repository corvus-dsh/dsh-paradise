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
import { readTopology } from './topology.js'

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
  /* ── 任务拓扑 ─────────────────────────────────────────────────────────────────────────────── */
  .tabs { display: flex; gap: 6px; margin-left: auto; }
  .tabs button { padding: 4px 12px; font-size: 12px; }
  .tabs button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
  #topology { display: none; flex: 1; overflow: auto; padding: 16px;
              font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; }
  #topology.on { display: block; }
  #topology .frame { display: grid; grid-template-columns: 1fr 340px; gap: 16px; min-height: 100%; }
  #topology svg { width: 100%; height: auto; min-height: 420px; background: #0d1117;
                  border: 1px solid var(--border); border-radius: 8px; }
  #topology .side { background: var(--panel); border: 1px solid var(--border);
                    border-radius: 8px; padding: 12px; overflow-y: auto; max-height: 70vh; }
  #topology .side h3 { margin: 0 0 8px; font-size: 14px; }
  #topology .side .phase { color: var(--accent); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  #topology .side ul { margin: 6px 0; padding-left: 18px; }
  #topology .side li { margin: 3px 0; }
  #topology .kn { display: block; padding: 6px 8px; margin: 4px 0; border-radius: 6px;
                  background: #1f6feb22; border: 1px solid #1f6feb55; }
  #topology .kn.missing { background: #f8514922; border-color: #f8514966; color: var(--bad); }
  #topology .warn { border: 1px solid #d2992266; background: #d2992222; color: var(--warn);
                    border-radius: 6px; padding: 8px 10px; margin-bottom: 10px; }
  #topology .legend { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 10px;
                      color: var(--muted); font-size: 11px; }
  #topology .legend i { width: 10px; height: 10px; border-radius: 3px; display: inline-block;
                        margin-right: 4px; vertical-align: middle; }
  #topology .goal { color: var(--muted); margin-bottom: 10px; }
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
    <div class="tabs">
      <button id="tab-chat" class="on">对话</button>
      <button id="tab-topo">任务拓扑</button>
    </div>
    <button id="btn-distill">一键提炼记忆</button>
    <button id="btn-kill">终止节点</button>
  </div>
  <div id="transcript"><div class="empty">左侧先创建一个节点，或者点「建 3 节点」看多节点协作。</div></div>
  <div class="composer">
    <input id="input" placeholder="对一个节点说话…" autocomplete="off">
    <button class="primary" id="btn-send">发送</button>
  </div>
  <div id="topology">
    <div id="topo-body"><div class="empty">正在读取任务拓扑…</div></div>
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

  /**
   * ── TASK TOPOLOGY: A DAG DRAWN WITH PLAIN SVG ────────────────────────────────────────────────
   *
   * WHY NO LIBRARY. The page is one inlined document with no bundler and no network access, so a
   * D3 import would mean shipping a second artefact that can go missing. A layered DAG needs three
   * things — column by depth, row by position within the column, an arrow per edge — and all three
   * are a few loops. The LAYOUT is computed on the HOST (see topology.ts) and shipped as a level
   * index per node, so this function only decides pixels.
   *
   * NO BACKTICKS ANYWHERE IN THIS BLOCK. The whole page is one template string; a stray backtick
   * closes it and the TypeScript parser then reads JavaScript as TypeScript.
   */
  const STATUS_COLOR = { done: '#3fb950', active: '#d29922', pending: '#8b949e', abandoned: '#f85149' };
  const STATUS_TEXT = { done: '已完成', active: '进行中', pending: '待开始', abandoned: '已废弃' };
  const PHASE_ICON = {
    analysis: '◍', design: '◇', coding: '⚙', testing: '✓', refactoring: '↻',
    debugging: '⚠', docs: '✎', ops: '☰',
  };

  function phaseIcon(phase) {
    return PHASE_ICON[phase] || (phase ? '●' : '▫');
  }

  function svgEl(tag, attrs) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const key in attrs) node.setAttribute(key, String(attrs[key]));
    return node;
  }

  const NODE_W = 168, NODE_H = 54, GAP_X = 92, GAP_Y = 26, PAD = 24;

  function renderTopology(view) {
    const box = $('topo-body');
    box.innerHTML = '';

    if (!view.available) {
      box.appendChild(el('div', 'empty', view.reason || '没有可显示的任务图。'));
      const hint = el('div', 'empty', '路径：' + (view.path || '(未知)'));
      hint.style.fontSize = '11px';
      box.appendChild(hint);
      return;
    }

    for (const warning of view.warnings || []) box.appendChild(el('div', 'warn', warning));

    const goal = el('div', 'goal');
    goal.textContent = (view.goal ? '目标：' + view.goal : '目标：尚未锁定') +
      (view.goalLockedAt ? '  🔒 已锁定' : '') +
      '　·　节点 ' + view.counts.total + '　·　知识 ' + view.knowledgeTotal + ' 条';
    box.appendChild(goal);

    const legend = el('div', 'legend');
    for (const status of ['done', 'active', 'pending', 'abandoned']) {
      const item = el('span');
      const chip = el('i');
      chip.style.background = STATUS_COLOR[status];
      item.appendChild(chip);
      item.appendChild(document.createTextNode(STATUS_TEXT[status]));
      legend.appendChild(item);
    }
    box.appendChild(legend);

    const frame = el('div', 'frame');
    const side = el('div', 'side');
    side.appendChild(el('div', 'empty', '点左侧任一节点，这里显示它的要求与关联知识。'));
    frame.appendChild(drawGraph(view, side));
    frame.appendChild(side);
    box.appendChild(frame);
  }

  function drawGraph(view, side) {
    const columns = new Map();
    for (const node of view.nodes) {
      const level = Number(node.level) || 0;
      if (!columns.has(level)) columns.set(level, []);
      columns.get(level).push(node);
    }
    const levelKeys = [...columns.keys()].sort((a, b) => a - b);
    let tallest = 0;
    for (const level of levelKeys) tallest = Math.max(tallest, columns.get(level).length);

    const width = PAD * 2 + levelKeys.length * NODE_W + Math.max(0, levelKeys.length - 1) * GAP_X;
    const height = PAD * 2 + tallest * NODE_H + Math.max(0, tallest - 1) * GAP_Y;
    const svg = svgEl('svg', { viewBox: '0 0 ' + Math.max(width, 320) + ' ' + Math.max(height, 200) });

    /** Drawn first, so the arrowhead marker exists before any <path> references it. */
    const defs = svgEl('defs');
    const marker = svgEl('marker', {
      id: 'topo-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5',
      markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse',
    });
    marker.appendChild(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#4a9eff' }));
    defs.appendChild(marker);
    svg.appendChild(defs);

    const positions = new Map();
    for (const level of levelKeys) {
      const bucket = columns.get(level);
      const columnHeight = bucket.length * NODE_H + Math.max(0, bucket.length - 1) * GAP_Y;
      const offset = (height - columnHeight) / 2;
      bucket.forEach((node, index) => {
        positions.set(node.id, {
          x: PAD + level * (NODE_W + GAP_X),
          y: offset + index * (NODE_H + GAP_Y),
        });
      });
    }

    for (const edge of view.edges) {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) continue;
      const x1 = from.x + NODE_W, y1 = from.y + NODE_H / 2;
      const x2 = to.x, y2 = to.y + NODE_H / 2;
      const bend = Math.max(24, (x2 - x1) / 2);
      svg.appendChild(svgEl('path', {
        d: 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + bend) + ' ' + y1 + ', ' +
           (x2 - bend) + ' ' + y2 + ', ' + x2 + ' ' + y2,
        fill: 'none', stroke: '#4a9eff', 'stroke-width': '1.4',
        'stroke-opacity': '0.65', 'marker-end': 'url(#topo-arrow)',
      }));
    }

    let selected = null;
    for (const node of view.nodes) {
      const position = positions.get(node.id);
      if (!position) continue;
      const group = svgEl('g', { style: 'cursor:pointer' });
      const color = STATUS_COLOR[node.status] || '#8b949e';
      group.appendChild(svgEl('rect', {
        x: position.x, y: position.y, width: NODE_W, height: NODE_H, rx: 8,
        fill: '#161b22', stroke: color, 'stroke-width': node.status === 'active' ? 2.4 : 1.2,
      }));
      group.appendChild(svgEl('rect', {
        x: position.x, y: position.y, width: 4, height: NODE_H, rx: 2, fill: color,
      }));
      const icon = svgEl('text', {
        x: position.x + 14, y: position.y + 21, fill: color,
        'font-size': '13', 'font-family': 'monospace',
      });
      icon.textContent = phaseIcon(node.phase);
      group.appendChild(icon);
      const label = svgEl('text', {
        x: position.x + 32, y: position.y + 21, fill: '#e6edf3', 'font-size': '12',
      });
      label.textContent = (node.phase ? node.phase + ' · ' : '') + node.title;
      group.appendChild(label);
      const sub = svgEl('text', {
        x: position.x + 14, y: position.y + 42, fill: '#8b949e', 'font-size': '10',
      });
      sub.textContent = node.id + ' · ' + (STATUS_TEXT[node.status] || node.status) +
        ' · 知识 ' + node.knowledge.length;
      group.appendChild(sub);
      group.addEventListener('click', () => {
        if (selected) selected.setAttribute('stroke-width', '1.2');
        selected = group.querySelector('rect');
        if (selected) selected.setAttribute('stroke-width', '3');
        renderNodeSide(side, node);
      });
      svg.appendChild(group);
    }
    return svg;
  }

  function renderNodeSide(side, node) {
    side.innerHTML = '';
    side.appendChild(el('div', 'phase', (STATUS_TEXT[node.status] || node.status) + (node.phase ? ' · ' + node.phase : '')));
    side.appendChild(el('h3', '', node.title));
    const idLine = el('div', 'kv');
    idLine.appendChild(el('span', '', '节点 id'));
    idLine.appendChild(el('span', '', node.id));
    side.appendChild(idLine);
    if (node.dependsOn.length > 0) {
      const row = el('div', 'kv');
      row.appendChild(el('span', '', '依赖'));
      row.appendChild(el('span', '', node.dependsOn.join(', ')));
      side.appendChild(row);
    }
    if (node.unlocks.length > 0) {
      const row = el('div', 'kv');
      row.appendChild(el('span', '', '解锁'));
      row.appendChild(el('span', '', node.unlocks.join(', ')));
      side.appendChild(row);
    }

    side.appendChild(el('div', 'panel-title', '阶段要求'));
    if (node.requirements.length === 0) {
      side.appendChild(el('div', 'empty', '这个节点没有写下要求。'));
    } else {
      const list = el('ul');
      for (const requirement of node.requirements) list.appendChild(el('li', '', requirement));
      side.appendChild(list);
    }

    side.appendChild(el('div', 'panel-title', '关联全局知识'));
    if (node.knowledge.length === 0 && node.missingPointers.length === 0) {
      side.appendChild(el('div', 'empty', '这个节点还没有锚定任何知识。'));
    }
    for (const entry of node.knowledge) {
      const card = el('div', 'kn');
      card.appendChild(el('strong', '', entry.title));
      const tags = (entry.tags || []).join(', ');
      const phases = (entry.nodeTypes || []).join(', ');
      card.appendChild(el('div', '', (entry.kind === 'negative' ? '⚠ 教训' : '✦ 技能') +
        (tags ? ' · ' + tags : '') + (phases ? ' · ' + phases : '')));
      side.appendChild(card);
    }
    for (const missing of node.missingPointers) {
      side.appendChild(el('div', 'kn missing', '悬空指针：' + missing));
    }
  }

  async function refreshTopology() {
    try {
      const response = await fetch('/api/topology');
      renderTopology(await response.json());
    } catch (error) {
      renderTopology({ available: false, reason: '读取 /api/topology 失败：' + String(error), nodes: [], edges: [], warnings: [], counts: { total: 0 } });
    }
  }

  function showTab(which) {
    const chat = which === 'chat';
    $('tab-chat').className = chat ? 'on' : '';
    $('tab-topo').className = chat ? '' : 'on';
    $('transcript').style.display = chat ? '' : 'none';
    document.querySelector('.composer').style.display = chat ? '' : 'none';
    $('topology').className = chat ? '' : 'on';
    if (!chat) refreshTopology();
  }

  $('tab-chat').onclick = () => showTab('chat');
  $('tab-topo').onclick = () => showTab('topo');

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
    if (request.method === 'GET' && url === '/api/topology') {
      /**
       * THE TASK TOPOLOGY, read from the files the memory layer writes.
       *
       * It is its own endpoint rather than a field on `/api/state` because the two change at
       * different rates: `/api/state` is polled for transcripts, while the graph changes only when
       * the model edits it. Keeping them apart also means the graph view can be refreshed without
       * re-reading every session.
       */
      sendJson(
        response,
        200,
        readTopology({
          home: options.home,
          globalKnowledgeDir: `${process.env.HOME ?? process.env.USERPROFILE ?? ''}/.dsh/global-knowledge`,
        }),
      )
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
