#!/usr/bin/env node
// agent-kanban-dispatcher is a dependency-free Node.js service for macOS launchd (Node.js 24 or newer).
// It subscribes to SSE, dispatches open comment threads last updated by the owner to Codex or Claude,
// and can POST plain JSON events to an optional notification webhook. Jobs may only read and reply.
//
// Usage: kanban-dispatcher.mjs [--dry-run] [--once]
//   --dry-run prints the commands that would run without executing jobs or writing state.
//   --once polls once, waits for due jobs, and exits.
// Config: ~/.config/agent-kanban/config.json (shared with kb; KB_CONFIG and KB_URL can override it).
// Example: { url, tokens: { codex, claude }, dispatcher: { notifyWebhook, publicUrl,
//   maxConcurrent: 2, hourlyCap: 10, timeoutMin: 15, scratchDir, pollMinutes: 5,
//   codex: { model, effort }, claude: { model, effort } } }
// Path overrides: DISPATCHER_STATE, DISPATCHER_LOG, and DISPATCHER_SCRATCH.
// Codex and Claude must have the agent-kanban MCP server configured for card reads and comment replies.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '1.2.0';
const DEFAULT_URL = 'http://localhost:3600';
const DEFAULT_PUBLIC_URL = 'https://kanban.example.com';
const HUMAN = new Set(['owner']);
const AGENT_NAME = { claude: 'Claude', codex: 'Codex' };
const LOG_MAX_BYTES = 5 * 1024 * 1024;

// ---------- Configuration ----------
export function loadConfig(env = process.env) {
  const file = env.KB_CONFIG || path.join(os.homedir(), '.config', 'agent-kanban', 'config.json');
  let cfg = {};
  if (fs.existsSync(file)) cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const d = cfg.dispatcher || {};
  const home = os.homedir();
  return {
    url: (env.KB_URL || cfg.url || DEFAULT_URL).replace(/\/+$/, ''),
    tokens: cfg.tokens || {},
    notifyWebhook: d.notifyWebhook || cfg.notifyWebhook || null,
    mcpUrl: d.mcpUrl || null,
    publicUrl: (d.publicUrl || cfg.publicUrl || DEFAULT_PUBLIC_URL).replace(/\/+$/, ''),
    maxConcurrent: d.maxConcurrent ?? 2,
    hourlyCap: d.hourlyCap ?? 10,
    timeoutMin: d.timeoutMin ?? 15,
    pollMinutes: d.pollMinutes ?? 5,
    pumpMs: d.pumpMs ?? 15000,
    killGraceMs: d.killGraceMs ?? 2000,
    scratchDir: env.DISPATCHER_SCRATCH || d.scratchDir || path.join(home, '.local', 'state', 'agent-kanban', 'scratch'),
    statePath: env.DISPATCHER_STATE || path.join(home, '.local', 'state', 'agent-kanban', 'dispatcher.json'),
    logPath: env.DISPATCHER_LOG || path.join(home, '.local', 'state', 'agent-kanban', 'dispatcher.log'),
    // Model and effort flags are omitted unless explicitly configured.
    codex: { model: d.codex?.model || null, effort: d.codex?.effort || null },
    claude: { model: d.claude?.model || null, effort: d.claude?.effort || null },
  };
}

// ---------- Logging (record IDs and status only; rotate at 5 MB) ----------
export function createLogger(file, now = () => new Date()) {
  return (msg) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, file + '.1');
      } catch { /* File does not exist yet. */ }
      fs.appendFileSync(file, `${now().toISOString()} ${msg}\n`);
    } catch { /* Logging failures do not stop dispatch. */ }
  };
}

// ---------- HTTP ----------

function rawRequest(cfg, method, pathname, { body, headers = {}, timeoutMs = 20000, onResponse } = {}) {
  const u = new URL(cfg.url + pathname);
  const lib = u.protocol === 'https:' ? https : http;
  const payload = body === undefined ? null : JSON.stringify(body);
  const opts = {
    method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search,
    headers: { Accept: 'application/json', ...headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
  };
  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (res) => {
      if (onResponse) return onResponse(res, req, resolve, reject);
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* Non-JSON response. */ }
        resolve({ status: res.statusCode, json });
      });
    });
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.on('socket', (sock) => sock.on('error', () => {})); // The request error handler handles socket errors.
    if (payload) req.write(payload);
    req.end();
  });
}

export function createApi(cfg) {
  const token = cfg.tokens.codex || cfg.tokens.claude || process.env.KB_TOKEN;
  const authHeaders = { Authorization: `Bearer ${token}` };
  async function get(pathname) {
    if (!token) throw new Error('Missing API token');
    const res = await rawRequest(cfg, 'GET', '/api/v1' + pathname, { headers: authHeaders });
    if (res.status >= 400) throw new Error(`HTTP ${res.status} ${pathname.split('?')[0]}`);
    return res.json;
  }
  /** Open SSE and return { close }. Call onReady, onEvent, and onClose(err) as events arrive. */
  function stream({ onReady, onEvent, onClose }) {
    let req = null;
    let closed = false;
    const finish = (err) => { if (!closed) { closed = true; onClose(err); } };
    const attempt = () => {
      rawRequest(cfg, 'GET', '/api/v1/stream', {
        headers: { ...authHeaders, Accept: 'text/event-stream' }, timeoutMs: 0,
        onResponse: (res, r) => {
          req = r;
          if (res.statusCode !== 200) { res.resume(); return finish(new Error(`HTTP ${res.statusCode}`)); }
          r.setTimeout(0); // Keep SSE open; the server sends periodic pings.
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            buf += chunk;
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              let ev = 'message';
              const data = [];
              for (const line of block.split('\n')) {
                if (line.startsWith(':')) continue;
                if (line.startsWith('event:')) ev = line.slice(6).trim();
                else if (line.startsWith('data:')) data.push(line.slice(5).trim());
              }
              if (ev === 'ready') onReady();
              else if (ev === 'kanban' && data.length) { try { onEvent(JSON.parse(data.join('\n'))); } catch { /* Ignore malformed event data. */ } }
            }
          });
          res.on('end', () => finish(null));
          res.on('error', finish);
        },
      }).catch((e) => {
        finish(e);
      });
    };
    attempt();
    return { close: () => { closed = true; req?.destroy(); } };
  }
  return { get, stream };
}

// ---------- Prompt and command construction ----------
export function buildPrompt(item, target) {
  const { root, card } = item;
  return [
    `You are the ${AGENT_NAME[target]} agent assigned to reply to a comment thread.`,
    `Card #${card.id} "${card.title}" (project ${item.project.id}) has an open thread assigned to you (thread ID ${root.id}).`,
    '',
    'Follow these steps:',
    `1. Read the card and complete thread with agent-kanban MCP tool kanban_get_card (card_id=${card.id}). If needed, use kanban_list_comments or inspect source files read-only.`,
    `2. Reply in the thread with kanban_reply_comment (comment_id=${root.id}). Use clear English, lead with the answer, and distinguish verified facts, inferences, and unknowns.`,
    '',
    'Constraints: read and reply only. Do not edit files or deploy, and do not run commands that change system state. If a code change is needed, describe the suggested change and its impact for the owner to decide.',
    'Stop after posting the reply. No other output is needed.',
  ].join('\n');
}

// Restrict jobs to reading and replying with explicit tool allowlists.
export const JOB_MCP_TOOLS = ['kanban_get_card', 'kanban_list_comments', 'kanban_reply_comment', 'kanban_list_cards'];
const DK_WRITE_TOOLS = ['kanban_create_card', 'kanban_update_card', 'kanban_move_card', 'kanban_add_note', 'kanban_archive_card', 'kanban_update_project_handoff', 'kanban_create_project', 'kanban_get_overview', 'kanban_list_events', 'kanban_list_projects', 'kanban_get_brief'];
const CLAUDE_ALLOWED = [...JOB_MCP_TOOLS.map((t) => `mcp__agent-kanban__${t}`), 'Read', 'Grep', 'Glob'].join(',');
const CLAUDE_DENIED = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', ...DK_WRITE_TOOLS.map((t) => `mcp__agent-kanban__${t}`)].join(',');
// Disable Codex features that could expose additional tools.
const CODEX_DISABLED_FEATURES = ['apps', 'plugins', 'remote_plugin', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'image_generation', 'multi_agent', 'memories', 'goals'];
export const JOB_TOKEN_ENV = 'KANBAN_DISPATCH_TOKEN';

export const mcpUrl = (cfg) => cfg.mcpUrl || `${cfg.url}/mcp`;

/** Build a command. Claude receives an MCP config path created and removed by the caller. */
export function buildCommand(cfg, target, cwd, { mcpConfigPath = '<tmp>/mcp.json' } = {}) {
  if (target === 'codex') {
    const args = ['exec', '--skip-git-repo-check',
      // Ignore user config to prevent inherited tools and permission settings.
      '--ignore-user-config', '--ephemeral',
      '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
      '-c', `mcp_servers.agent-kanban.url="${mcpUrl(cfg)}"`,
      '-c', `mcp_servers.agent-kanban.bearer_token_env_var="${JOB_TOKEN_ENV}"`,
      // Pre-approve only the four read/reply tools in the allowlist.
      '-c', 'mcp_servers.agent-kanban.default_tools_approval_mode="approve"',
      '-c', `mcp_servers.agent-kanban.enabled_tools=[${JOB_MCP_TOOLS.map((t) => `"${t}"`).join(',')}]`];
    if (cfg.codex.model) args.push('-m', cfg.codex.model);
    if (cfg.codex.effort) args.push('-c', `model_reasoning_effort=${cfg.codex.effort}`);
    for (const f of CODEX_DISABLED_FEATURES) args.push('--disable', f);
    args.push('-s', 'read-only', '--cd', cwd, '-');
    return { cmd: 'codex', args, env: { [JOB_TOKEN_ENV]: cfg.tokens.codex || '' } };
  }
  const args = ['-p',
    '--permission-mode', 'dontAsk', // Reject tools outside the allowlist.
    '--setting-sources', '', // Do not load user, project, or local settings.
    '--tools', 'Read,Grep,Glob', // Built-in tool allowlist.
    '--strict-mcp-config', '--mcp-config', mcpConfigPath, // Use only the agent-kanban MCP server.
    '--allowedTools', CLAUDE_ALLOWED, '--disallowedTools', CLAUDE_DENIED];
  if (cfg.claude.model) args.push('--model', cfg.claude.model);
  if (cfg.claude.effort) args.push('--effort', cfg.claude.effort);
  return { cmd: 'claude', args, env: {} };
}

/** Create a private temporary MCP config for Claude and always remove it after use. */
export function prepareCommand(cfg, target, cwd) {
  if (target !== 'claude') return { spec: buildCommand(cfg, target, cwd), cleanup() {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-dispatch-'));
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'agent-kanban': { type: 'http', url: mcpUrl(cfg), headers: { Authorization: `Bearer ${cfg.tokens.claude || ''}` } } } }), { mode: 0o600 });
  return { spec: buildCommand(cfg, target, cwd, { mcpConfigPath: file }), cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Already removed. */ } } };
}

// ---------- State ----------
function loadState(file) {
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); if (s && typeof s.threads === 'object') return s; } catch { /* Start with empty state. */ }
  return { threads: {} };
}
function saveState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  } catch { /* A later restart may dispatch the job again. */ }
}

const lastMessage = (item) => (item.replies.length ? item.replies[item.replies.length - 1] : item.root);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Dispatcher ----------
export function createDispatcher(opts) {
  const cfg = opts.cfg;
  const log = opts.log ?? createLogger(cfg.logPath);
  const api = opts.api ?? createApi(cfg);
  const dryRun = !!opts.dryRun;
  const now = opts.now ?? (() => Date.now());
  const state = dryRun ? { threads: {} } : loadState(cfg.statePath);
  const queue = []; // { rootId, cardId }
  const running = new Map(); // rootId -> { cardId, child }
  const startTimes = [];
  const notified = new Set();
  const dryOut = opts.dryOut ?? ((o) => console.log(JSON.stringify(o)));
  const idleWaiters = [];
  let stopped = false;
  let pumpTimer = null;
  let pollTimer = null;
  let sse = null;
  let backoff = 1000;
  const persist = () => { if (!dryRun) saveState(cfg.statePath, state); };

  const cardRunning = (cardId) => [...running.values()].some((r) => r.cardId === cardId);
  const hourlyUsed = () => { const cut = now() - 3600e3; while (startTimes.length && startTimes[0] <= cut) startTimes.shift(); return startTimes.length; };

  /** Return the latest message ID when an open thread should be dispatched. */
  function dueKey(item) {
    if (item.root.status !== 'open') return null;
    const last = lastMessage(item);
    if (!HUMAN.has(last.author)) return null;
    const st = state.threads[item.root.id];
    if (st && st.lastId === last.id && (st.status === 'done' || st.status === 'failed' || (st.status === 'running' && running.has(item.root.id)))) return null;
    if (st && st.lastId === last.id && st.attempts >= 2) return null;
    if (st && st.lastId > last.id) return null;
    return last.id;
  }

  function enqueue(item) {
    const key = dueKey(item);
    if (key == null) return false;
    if (queue.some((q) => q.rootId === item.root.id)) return false;
    // Queue new owner comments while a job is running; the pump waits for the card's current job.
    queue.push({ rootId: item.root.id, cardId: item.card.id });
    log(`queue root=${item.root.id} card=${item.card.id} msg=${key} target=${item.root.target}`);
    return true;
  }

  async function fetchItem(cardId, rootId) {
    const r = await api.get(`/comments?status=all&card_id=${cardId}&limit=200`);
    return (r.comments || []).find((i) => i.root.id === rootId) || null;
  }

  async function evaluateCard(cardId, rootId) {
    try {
      const r = await api.get(`/comments?status=open&card_id=${cardId}&limit=200`);
      for (const item of r.comments || []) if (rootId == null || item.root.id === rootId) enqueue(item);
    } catch (e) { log(`error evaluate card=${cardId} ${e.message}`); }
    await pump();
  }

  async function pollOnce() {
    try {
      const r = await api.get('/comments?status=open&limit=200');
      for (const item of r.comments || []) enqueue(item);
    } catch (e) { log(`error poll ${e.message}`); }
    await pump();
  }

  let pumping = false;
  let pumpAgain = false;
  async function pump() {
    if (stopped) return;
    if (pumping) { pumpAgain = true; return; }
    pumping = true;
    try {
      do {
        pumpAgain = false;
        await pumpPass();
      } while (pumpAgain && !stopped);
    } finally {
      pumping = false;
    }
    notifyIdle();
  }

  async function pumpPass() {
    {
      for (let guard = 0; guard < 1000 && !stopped; guard++) {
        if (running.size >= cfg.maxConcurrent) break;
        if (hourlyUsed() >= cfg.hourlyCap) break;
        const idx = queue.findIndex((q) => !cardRunning(q.cardId));
        if (idx < 0) break;
        const [q] = queue.splice(idx, 1);
        let item;
        try { item = await fetchItem(q.cardId, q.rootId); } catch (e) { log(`error refetch root=${q.rootId} ${e.message}`); continue; }
        if (!item || dueKey(item) == null) continue; // The thread changed while queued.
        void runJob(item);
      }
    }
  }

  // For --once and tests, a full queue counts as idle when the hourly cap blocks it.
  const isIdle = () => running.size === 0 && !pumping && (queue.length === 0 || hourlyUsed() >= cfg.hourlyCap);
  function notifyIdle() {
    if (isIdle()) while (idleWaiters.length) idleWaiters.shift()();
  }
  function idle() {
    return isIdle() ? Promise.resolve() : new Promise((r) => idleWaiters.push(r));
  }

  function resolveCwd(item) {
    const repo = item.project.repo_path;
    try { if (repo && fs.statSync(repo).isDirectory()) return repo; } catch { /* Use the scratch directory. */ }
    fs.mkdirSync(cfg.scratchDir, { recursive: true });
    return cfg.scratchDir;
  }

  function runChild(spec, cwd, prompt, rootId) {
    return new Promise((resolve) => {
      const child = spawn(spec.cmd, spec.args, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...spec.env } });
      const entry = running.get(rootId);
      if (entry) entry.child = child;
      let settled = false;
      let timedOut = false;
      const done = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
      const killTree = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* Already exited. */ } } };
      const timer = setTimeout(() => {
        timedOut = true;
        killTree('SIGTERM');
        setTimeout(() => killTree('SIGKILL'), cfg.killGraceMs).unref?.();
      }, cfg.timeoutMin * 60e3);
      child.stdout.resume();
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.on('error', (e) => done({ ok: false, reason: `spawn: ${e.code || e.message}` }));
      child.on('close', (code, signal) => {
        killTree('SIGKILL'); // Kill any remaining child processes.
        done(timedOut ? { ok: false, reason: 'timeout' } : { ok: code === 0, reason: code === 0 ? 'exit0' : `exit ${code ?? signal}` });
      });
      child.stdin.end(prompt);
    });
  }

  async function runJob(item) {
    const rootId = item.root.id;
    const target = item.root.target || 'codex';
    const lastId = lastMessage(item).id;
    const st = (state.threads[rootId] = state.threads[rootId]?.lastId === lastId ? state.threads[rootId] : { lastId, attempts: 0, status: 'running' });
    running.set(rootId, { cardId: item.card.id, child: null });
    let failure = 'unknown';
    try {
      while (st.attempts < 2 && !stopped) {
        st.attempts += 1;
        st.status = 'running';
        persist();
        startTimes.push(now());
        const cwd = resolveCwd(item);
        const { spec, cleanup } = prepareCommand(cfg, target, cwd);
        log(`start root=${rootId} card=${item.card.id} target=${target} attempt=${st.attempts} cwd=${path.basename(cwd)}`);
        let res;
        try { res = await runChild(spec, cwd, buildPrompt(item, target), rootId); } finally { cleanup(); }
        let replied = false;
        try {
          const fresh = await fetchItem(item.card.id, rootId);
          replied = !!fresh && fresh.replies.some((r) => r.author === target && r.id > lastId);
        } catch (e) { log(`error verify root=${rootId} ${e.message}`); }
        if (replied) {
          st.status = 'done';
          persist();
          log(`done root=${rootId} attempt=${st.attempts} (${res.reason})`);
          return;
        }
        failure = res.reason === 'exit0' ? 'no_reply' : res.reason;
        log(`fail root=${rootId} attempt=${st.attempts} reason=${failure}`);
      }
      if (stopped) return;
      st.status = 'failed';
      persist();
      await notifyWebhook({
        event: 'dispatcher.job_failed',
        target,
        attempts: st.attempts,
        reason: failure,
        projectId: item.project.id,
        card: { id: item.card.id, title: item.card.title, url: cardUrl(item.project.id, item.card.id) },
        comment: { id: rootId },
      });
    } finally {
      running.delete(rootId);
      // Recheck the thread after the job; newer owner comments may be ready.
      await evaluateCard(item.card.id, rootId);
      notifyIdle();
    }
  }

  const cardUrl = (project, cardId) => `${cfg.publicUrl}/p/${encodeURIComponent(project)}?card=${cardId}`;

  async function notifyWebhook(payload) {
    if (!cfg.notifyWebhook || dryRun) return;
    try {
      const res = await fetch(cfg.notifyWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': `agent-kanban-dispatcher/${VERSION}` },
        body: JSON.stringify(payload),
      });
      if (!res.ok) log(`webhook http=${res.status}`);
      else log('webhook sent');
    } catch (e) { log(`webhook error ${e.code || e.message}`); }
  }

  async function notifyReply(ev) {
    const p = ev.payload || {};
    if (!p.comment_id || notified.has(p.comment_id)) return;
    notified.add(p.comment_id);
    let body = String(p.body ?? '');
    try {
      const item = await fetchItem(ev.card_id, p.root_id);
      const c = item && [item.root, ...item.replies].find((x) => x.id === p.comment_id);
      if (c) body = c.body;
    } catch { /* Use the body included in the event. */ }
    const text = [...body];
    await notifyWebhook({
      event: 'comment.replied',
      actor: ev.actor,
      commentId: p.comment_id,
      rootId: p.root_id,
      cardId: ev.card_id,
      projectId: ev.project_id,
      title: p.title ?? '',
      body: text.length > 300 ? text.slice(0, 300).join('') + '...' : body,
      url: cardUrl(ev.project_id, ev.card_id),
    });
  }

  async function handleBroadcast(b) {
    const ev = b?.event;
    if (!ev || !String(ev.type).startsWith('comment.') || ev.card_id == null) return;
    if (ev.type === 'comment.replied' && AGENT_NAME[ev.actor]) void notifyReply(ev);
    await evaluateCard(ev.card_id, ev.payload?.root_id ?? null);
  }

  function connect() {
    if (stopped) return;
    sse = api.stream({
      onReady: () => { backoff = 1000; log('sse ready'); void pollOnce(); }, // Poll all open threads after reconnect.
      onEvent: (b) => { handleBroadcast(b).catch((e) => log(`error event ${e.message}`)); },
      onClose: (err) => {
        if (stopped) return;
        log(`sse closed${err ? ` (${err.code || err.message})` : ''}; retry in ${backoff}ms`);
        setTimeout(connect, backoff).unref?.();
        backoff = Math.min(backoff * 2, 60000);
      },
    });
  }

  return {
    log, state, queue, running, pollOnce, pump, idle, evaluateCard, handleBroadcast, startTimes,
    /** Start the persistent service. */
    start() {
      log(`dispatcher ${VERSION} start url=${new URL(cfg.url).host}`);
      connect();
      void pollOnce();
      pollTimer = setInterval(() => void pollOnce(), cfg.pollMinutes * 60e3);
      pumpTimer = setInterval(() => void pump(), cfg.pumpMs);
    },
    /** --dry-run: print commands without running jobs. */
    async dryRunOnce() {
      const r = await api.get('/comments?status=open&limit=200');
      for (const item of r.comments || []) {
        if (dueKey(item) == null) continue;
        const cwd = (() => { const repo = item.project.repo_path; try { if (repo && fs.statSync(repo).isDirectory()) return repo; } catch { /* */ } return cfg.scratchDir; })();
        const target = item.root.target || 'codex';
        const spec = buildCommand(cfg, target, cwd);
        dryOut({ root: item.root.id, card: item.card.id, target, cwd, command: [spec.cmd, ...spec.args], stdin: 'prompt', promptChars: buildPrompt(item, target).length });
      }
    },
    async stop() {
      stopped = true;
      clearInterval(pollTimer);
      clearInterval(pumpTimer);
      sse?.close();
      for (const r of running.values()) { try { process.kill(-r.child.pid, 'SIGKILL'); } catch { /* */ } }
    },
  };
}

// ---------- CLI ----------
async function main() {
  const argv = process.argv.slice(2);
  const cfg = loadConfig();
  const dryRun = argv.includes('--dry-run');
  const once = argv.includes('--once');
  const d = createDispatcher({ cfg, dryRun });
  if (dryRun) { await d.dryRunOnce(); return; }
  if (once) { await d.pollOnce(); await d.idle(); await d.stop(); return; }
  // Log unexpected network errors and keep running; SSE and polling use backoff.
  process.on('uncaughtException', (e) => d.log(`uncaught ${e.code || ''} ${e.message}`));
  process.on('unhandledRejection', (e) => d.log(`unhandled ${e?.code || ''} ${e?.message || e}`));
  d.start();
  const bye = async () => { await d.stop(); process.exit(0); };
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}

function isDirectRun() {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isDirectRun()) main().catch((e) => { console.error(`dispatcher: ${e.message}`); process.exit(1); });
