#!/usr/bin/env node
// kb is a dependency-free agent-kanban CLI. Requires Node.js 20 or newer.
// Config file: ~/.config/agent-kanban/config.json (chmod 600).
// Example: { "url": "https://kanban.example.com", "tokens": { "claude": "...", "codex": "..." } }
// Environment: KB_CONFIG overrides the config path; KB_URL overrides the URL; KB_AGENT selects codex or claude.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const DEFAULT_URL = 'http://localhost:3600';
const STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done'];
const STATUS_ALIAS = { doing: 'in_progress', inprogress: 'in_progress', 'in-progress': 'in_progress', wip: 'in_progress' };
const STATUS_LABEL = { backlog: 'Backlog', todo: 'To do', in_progress: 'In progress', review: 'Review', done: 'Done' };
const AGENT_LABEL = { codex: 'Codex', claude: 'Claude', owner: 'Owner', none: 'Unassigned' };
const AGENTS = ['codex', 'claude', 'owner', 'none'];
const TOKEN_ACTORS = ['codex', 'claude'];
const PRIOS = ['p0', 'p1', 'p2', 'p3'];
// Keep this copy aligned with shared/constants.ts and test/brief.test.ts.
const CARD_BRIEF_TEMPLATE = `## Goal
(One or two sentences: what should be achieved)
## Scope
(What is included and excluded)
## Acceptance
(How completion is verified)
## Related files and documents
(Repository paths, design docs, PRs, branches)
## Key decisions
(Date, decision, reason; add newer decisions below)
`;
const HANDOFF_PREFIX = '[handoff]';
const BRIEF_MAX_CHARS = 8000;

class KbError extends Error {}
const fail = (msg) => { throw new KbError(msg); };

// ---------- Output ----------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);
const red = (s) => c('31', s);
const yellow = (s) => c('33', s);
const green = (s) => c('32', s);
const cyan = (s) => c('36', s);
const magenta = (s) => c('35', s);
const STATUS_COLOR = { backlog: dim, todo: cyan, in_progress: yellow, review: magenta, done: green };
const AGENT_COLOR = { codex: cyan, claude: (s) => c('38;5;215', s), owner: magenta, none: dim };

const dateFormatter = new Intl.DateTimeFormat('en-US', { timeZone: process.env.KANBAN_TIMEZONE || 'UTC', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtTime = (iso) => dateFormatter.format(new Date(iso)).replace(/\s+/g, ' ');
function fmtAge(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr`;
  return `${Math.floor(s / 86400)} d`;
}
const strWidth = (s) => [...String(s).replace(/\x1b\[[0-9;]*m/g, '')].length;
const pad = (s, w) => String(s) + ' '.repeat(Math.max(0, w - strWidth(s)));

function printTable(rows) {
  if (!rows.length) return;
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => strWidth(r[i]))));
  for (const r of rows) console.log(r.map((cell, i) => (i === r.length - 1 ? cell : pad(cell, widths[i]))).join('  ').trimEnd());
}

// ---------- Configuration ----------
function loadConfig() {
  const file = process.env.KB_CONFIG || path.join(os.homedir(), '.config', 'agent-kanban', 'config.json');
  let cfg = {};
  if (fs.existsSync(file)) {
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail(`Invalid JSON in config file ${file}: ${e.message}`); }
  }
  return {
    file,
    url: (process.env.KB_URL || cfg.url || DEFAULT_URL).replace(/\/+$/, ''),
    tokens: cfg.tokens || {},
  };
}

// Codex subprocess markers. CLAUDECODE is checked after Codex markers because Codex may inherit it.
const CODEX_MARKERS = ['CODEX_THREAD_ID', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED'];

/** Actor precedence: --as, KB_AGENT, Codex markers, CLAUDECODE, then Codex. */
function detectActor(flag, env = process.env) {
  const a = flag || env.KB_AGENT
    || (CODEX_MARKERS.some((k) => env[k]) ? 'codex' : env.CLAUDECODE ? 'claude' : 'codex');
  if (!TOKEN_ACTORS.includes(a)) fail(`--as / KB_AGENT accepts only codex or claude (received ${a})`);
  return a;
}
const resolveActor = (flag) => detectActor(flag);

// ---------- HTTP ----------
function requestOnce(base, method, pathname, headers, payload) {
  const u = new URL(base + pathname);
  const lib = u.protocol === 'https:' ? https : http;
  const opts = { method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, headers };
  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.setTimeout(20000, () => req.destroy(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function api(cfg, actor, method, pathname, body) {
  const token = cfg.tokens[actor] || process.env.KB_TOKEN;
  if (!token) fail(`Missing token for ${actor} in ${cfg.file} (tokens.${actor})`);
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
  let res;
  try { res = await requestOnce(cfg.url, method, '/api/v1' + pathname, headers, payload); }
  catch (e) { fail(`Unable to connect to ${cfg.url}: ${e.code || e.message}`); }
  if (res.status >= 400) {
    const err = res.json?.error;
    const e = new KbError(err ? `${err.message} (${err.code}, HTTP ${res.status})` : `HTTP ${res.status}`);
    e.status = res.status; e.body = res.json;
    throw e;
  }
  return res.json;
}

// ---------- Commands ----------
const normStatus = (s) => {
  const k = String(s).toLowerCase();
  const v = STATUS_ALIAS[k] || k;
  if (!STATUSES.includes(v)) fail(`Unknown status "${s}"; use backlog|todo|doing (= in_progress)|review|done`);
  return v;
};
const normId = (s) => {
  const n = Number(String(s ?? '').replace(/^#/, ''));
  if (!Number.isInteger(n) || n <= 0) fail(`Invalid card ID: ${s ?? '(missing)'}`);
  return n;
};
const need = (v, usage) => { if (v === undefined || v === '') fail(`Usage: ${usage}`); return v; };

function cardLine(card) {
  const flags = [card.blocked ? red('Blocked') : '', card.needs_owner ? yellow('Needs owner') : '', card.stale ? yellow('Stale') : ''].filter(Boolean).join(' ');
  return [
    dim('#' + card.id),
    (STATUS_COLOR[card.status] || ((x) => x))(STATUS_LABEL[card.status]),
    (AGENT_COLOR[card.agent] || ((x) => x))(AGENT_LABEL[card.agent]),
    card.priority.toUpperCase(),
    dim(card.project_id),
    card.title + (flags ? '  ' + flags : ''),
    dim(fmtAge(card.updated_at)),
  ];
}

const CM_STATUS_LABEL = { open: 'Open', answered: 'Answered', resolved: 'Resolved' };
const firstChars = (text, n) => { const t = String(text).replace(/\s+/g, ' ').trim(); const a = [...t]; return a.length > n ? a.slice(0, n).join('') + '...' : t; };

const canonPath = (p) => { const r = path.resolve(p); try { return fs.realpathSync(r); } catch { return r; } };
const withinPath = (here, repo) => here === repo || here.startsWith(repo.endsWith(path.sep) ? repo : repo + path.sep);

/** Find the project whose repo_path is the longest path-boundary prefix of cwd. */
function projectForCwd(projects, cwd) {
  const hereRaw = path.resolve(cwd);
  const hereReal = canonPath(cwd);
  let best = null;
  let bestLen = -1;
  for (const p of projects) {
    if (!p.repo_path) continue;
    for (const [here, repo] of [[hereRaw, path.resolve(p.repo_path)], [hereReal, canonPath(p.repo_path)]]) {
      if (withinPath(here, repo) && repo.length > bestLen) { best = p; bestLen = repo.length; }
    }
  }
  return best;
}

function printThread(t, indent = '') {
  const r = t.root;
  const st = CM_STATUS_LABEL[r.status] || r.status;
  const stc = r.status === 'open' ? yellow : r.status === 'resolved' ? green : cyan;
  console.log(`${indent}${dim('Comment ' + r.id)} ${AGENT_LABEL[r.author] || r.author} -> ${AGENT_LABEL[r.target] || r.target}  ${stc(st)}  ${dim(fmtTime(r.created_at))}`);
  console.log(`${indent}  ${r.body.replace(/\n/g, '\n' + indent + '  ')}`);
  for (const x of t.replies) {
    console.log(`${indent}  ${dim('- ' + x.id)} ${(AGENT_COLOR[x.author] || ((y) => y))(AGENT_LABEL[x.author] || x.author)} ${dim(fmtTime(x.created_at))}`);
    console.log(`${indent}    ${x.body.replace(/\n/g, '\n' + indent + '    ')}`);
  }
}

const COMMANDS = {
  async projects(ctx) {
    const o = await api(ctx.cfg, ctx.actor, 'GET', '/overview');
    if (ctx.json) return out(o.projects.map((p) => ({ id: p.id, name: p.name, status: p.status, counts: p.counts, blocked: p.blocked, needs_owner: p.needs_owner, stale: p.stale, dormant: p.dormant, dormant_since: p.dormant_since, last_activity: p.last_activity })));
    printTable([['ID', 'Name', 'Backlog', 'To do', 'In progress', 'Review', 'Done', 'Blocked', 'Needs owner', 'Last activity'],
      ...o.projects.map((p) => [p.id, p.name + (p.dormant ? ' (paused)' : ''), p.counts.backlog, p.counts.todo, p.counts.in_progress, p.counts.review, p.counts.done,
        p.blocked ? red(p.blocked) : p.blocked, p.needs_owner ? yellow(p.needs_owner) : p.needs_owner, dim(fmtTime(p.last_activity) + (p.stale ? ' Stale' : ''))])]);
  },

  async ls(ctx) {
    const { v } = ctx;
    const qs = new URLSearchParams();
    if (v.p) qs.set('project', v.p);
    if (v.s) qs.set('status', normStatus(v.s));
    if (v.a) qs.set('agent', v.a);
    if (v.blocked) qs.set('blocked', '1');
    if (v.mine) qs.set('agent', ctx.actor);
    const r = await api(ctx.cfg, ctx.actor, 'GET', '/cards' + (qs.size ? `?${qs}` : ''));
    if (ctx.json) return out(r.cards);
    if (!r.cards.length) return console.log(dim('(No matching cards)'));
    const order = (x) => STATUSES.indexOf(x.status);
    printTable(r.cards.slice().sort((a, b) => order(a) - order(b) || a.position - b.position).map(cardLine));
  },

  async show(ctx) {
    const id = normId(ctx.pos[0]);
    const d = await api(ctx.cfg, ctx.actor, 'GET', `/cards/${id}`);
    if (ctx.json) return out(d);
    const k = d.card;
    console.log(`${bold('#' + k.id + ' ' + k.title)}${k.archived ? dim(' (archived)') : ''}`);
    const rows = [
      ['Project', k.project_id], ['Status', (STATUS_COLOR[k.status] || ((x) => x))(STATUS_LABEL[k.status]) + (k.stale ? yellow(' (stale)') : '')],
      ['Agent', AGENT_LABEL[k.agent]], ['Priority', k.priority.toUpperCase()],
      ['Flags', [k.blocked ? red(`Blocked: ${k.blocked_reason || '(no reason provided)'}`) : '', k.needs_owner ? yellow('Needs owner decision') : ''].filter(Boolean).join('  ') || dim('-')],
      ['Branch', k.branch || dim('-')], ['Session', k.session_ref || dim('-')], ['Tags', k.tags.join(', ') || dim('-')], ['Due', k.due_date || dim('-')],
      ['Created', fmtTime(k.created_at)], ['Updated', fmtTime(k.updated_at)],
    ];
    for (const [a, b] of rows) console.log(`  ${pad(dim(a), 8)}${b}`);
    if (k.description) console.log(`\n${k.description}`);
    if (d.notes.length) {
      console.log(`\n${bold('Notes')}`);
      for (const n of d.notes) console.log(`  ${dim(fmtTime(n.created_at))} ${(AGENT_COLOR[n.actor] || ((x) => x))(AGENT_LABEL[n.actor] || n.actor)}  ${n.body.replace(/\n/g, '\n      ')}`);
    }
    if (d.events.length) {
      console.log(`\n${bold('Events')}`);
      for (const e of d.events.slice(0, 10)) console.log(`  ${dim(fmtTime(e.created_at))} ${(AGENT_COLOR[e.actor] || ((x) => x))(AGENT_LABEL[e.actor] || e.actor)}  ${e.type}`);
    }
  },

  async inbox(ctx) {
    const { v } = ctx;
    const qs = new URLSearchParams({ status: 'open' });
    if (!v['all-targets']) qs.set('target', ctx.actor);
    let project = v.p;
    if (v.cwd) {
      const { projects } = await api(ctx.cfg, ctx.actor, 'GET', '/projects');
      const hit = projectForCwd(projects, v.cwd);
      if (!hit) {
        if (ctx.json) return out([]);
        if (!v.brief) console.log(dim('(No project matches this working directory)'));
        return;
      }
      project = hit.id;
    }
    if (project) qs.set('project', project);
    const { comments } = await api(ctx.cfg, ctx.actor, 'GET', `/comments?${qs}`);
    if (ctx.json) return out(comments);
    if (!comments.length) { if (!v.brief) console.log(dim('(No open comments)')); return; }
    if (v.brief) {
      for (const i of comments) {
        const last = i.replies.length ? i.replies[i.replies.length - 1] : i.root;
        console.log(`#${i.card.id} ${i.card.title} | Comment ${i.root.id} | ${firstChars(last.body, 80)}`);
      }
      return;
    }
    for (const i of comments) {
      console.log(`${bold('#' + i.card.id + ' ' + i.card.title)} ${dim(i.project.id)}`);
      printThread(i, '  ');
      console.log('');
    }
  },

  async comments(ctx) {
    const id = normId(ctx.pos[0]);
    const r = await api(ctx.cfg, ctx.actor, 'GET', `/cards/${id}/comments`);
    if (ctx.json) return out(r.threads);
    if (!r.threads.length) return console.log(dim('(This card has no comments)'));
    for (const t of r.threads) { printThread(t); console.log(''); }
  },

  async reply(ctx) {
    const id = normId(ctx.pos[0]);
    const text = need(ctx.pos.slice(1).join(' '), 'kb reply <comment_id> "<text>"');
    const r = await api(ctx.cfg, ctx.actor, 'POST', `/comments/${id}/replies`, { body: text });
    done(ctx, r, `Replied to comment thread ${r.root.id} (status: ${CM_STATUS_LABEL[r.root.status]})`);
  },

  async brief(ctx) {
    const id = normId(ctx.pos[0]);
    const r = await api(ctx.cfg, ctx.actor, 'GET', `/cards/${id}/brief${ctx.v.full ? '?full=1' : ''}`);
    if (ctx.json) return out(r);
    // Keep a final 8,000-character limit for non-full output.
    const chars = [...r.text];
    if (!ctx.v.full && chars.length > BRIEF_MAX_CHARS) console.log(chars.slice(0, BRIEF_MAX_CHARS - 3).join('') + '...');
    else process.stdout.write(r.text.endsWith('\n') ? r.text : r.text + '\n');
  },

  async add(ctx) {
    const title = need(ctx.pos[0], 'kb add "<title>" -p <proj> [-s todo] [-a codex] [--prio p1] [-d "desc"] [--template]');
    const { v } = ctx;
    const body = { project_id: need(v.p, 'kb add "<title>" -p <project> ... (missing -p)'), title };
    if (v.s) body.status = normStatus(v.s);
    if (v.a) body.agent = v.a;
    if (v.prio) body.priority = v.prio;
    if (v.template) {
      // Place -d text in the goal section and keep the remaining prompts.
      body.description = v.d ? CARD_BRIEF_TEMPLATE.replace('(One or two sentences: what should be achieved)', v.d) : CARD_BRIEF_TEMPLATE;
    } else if (v.d) body.description = v.d;
    const r = await api(ctx.cfg, ctx.actor, 'POST', '/cards', body);
    done(ctx, r, `${green('Created')} #${r.card.id} ${r.card.title}`);
  },

  async mv(ctx) {
    const id = normId(ctx.pos[0]);
    const status = normStatus(need(ctx.pos[1], 'kb mv <id> <backlog|todo|doing|review|done>'));
    const r = await api(ctx.cfg, ctx.actor, 'POST', `/cards/${id}/move`, { status });
    done(ctx, r, `#${id} -> ${STATUS_LABEL[r.card.status]}`);
  },

  async take(ctx) {
    const id = normId(ctx.pos[0]);
    const r = await api(ctx.cfg, ctx.actor, 'PATCH', `/cards/${id}`, { agent: ctx.actor, status: 'in_progress' });
    done(ctx, r, `#${id} assigned to ${AGENT_LABEL[ctx.actor]} -> In progress`);
  },

  async note(ctx) {
    const id = normId(ctx.pos[0]);
    const usage = 'kb note <id> "<text>" / kb note <id> --handoff "<completed work / next step / key files / open questions>"';
    let text;
    if (ctx.v.handoff !== undefined) {
      if (ctx.pos.length > 1) fail(`Put --handoff text after the flag without extra positional arguments. Usage: ${usage}`);
      const t = need(ctx.v.handoff.trim(), usage);
      text = t.toLowerCase().startsWith(HANDOFF_PREFIX) ? t : `${HANDOFF_PREFIX} ${t}`;
    } else text = need(ctx.pos.slice(1).join(' '), usage);
    const r = await api(ctx.cfg, ctx.actor, 'POST', `/cards/${id}/notes`, { body: text });
    done(ctx, r, ctx.v.handoff !== undefined ? `Added a handoff note to #${id}` : `Added a note to #${id}`);
  },

  async block(ctx) {
    const id = normId(ctx.pos[0]);
    const reason = need(ctx.pos.slice(1).join(' '), 'kb block <id> "<reason>"');
    const r = await api(ctx.cfg, ctx.actor, 'PATCH', `/cards/${id}`, { blocked: true, blocked_reason: reason });
    done(ctx, r, `#${id} ${red('Blocked')}: ${reason}`);
  },

  async unblock(ctx) {
    const id = normId(ctx.pos[0]);
    const r = await api(ctx.cfg, ctx.actor, 'PATCH', `/cards/${id}`, { blocked: false, blocked_reason: '' });
    done(ctx, r, `#${id} is unblocked`);
  },

  async ask(ctx) {
    const id = normId(ctx.pos[0]);
    const q = need(ctx.pos.slice(1).join(' '), 'kb ask <id> "<question>"');
    const r = await api(ctx.cfg, ctx.actor, 'PATCH', `/cards/${id}`, { needs_owner: true });
    const n = await api(ctx.cfg, ctx.actor, 'POST', `/cards/${id}/notes`, { body: `[Needs owner decision] ${q}` });
    done(ctx, { card: n.card, note: n.note }, `#${id} ${yellow('Needs owner decision')}: ${q}`);
    void r;
  },

  async answer(ctx) {
    const id = normId(ctx.pos[0]);
    const text = ctx.pos.slice(1).join(' ');
    const r = await api(ctx.cfg, ctx.actor, 'PATCH', `/cards/${id}`, { needs_owner: false });
    if (!text) return done(ctx, r, `Cleared the owner-decision flag on #${id}`);
    const n = await api(ctx.cfg, ctx.actor, 'POST', `/cards/${id}/notes`, { body: text });
    done(ctx, { card: n.card, note: n.note }, `Cleared the owner-decision flag on #${id}: ${text}`);
  },

  async archive(ctx) {
    const id = normId(ctx.pos[0]);
    const undo = !!ctx.v.undo;
    const r = await api(ctx.cfg, ctx.actor, 'POST', `/cards/${id}/archive`, undo ? { archived: false } : {});
    done(ctx, r, undo ? `#${id} unarchived` : `#${id} archived`);
  },

  async project(ctx) {
    const sub = ctx.pos[0];
    const { v } = ctx;
    const HEX = /^#[0-9A-Fa-f]{6}$/;
    const nullable = (x) => (x === '' || x === 'none' || x === 'null' ? null : x);
    if (sub === 'add') {
      const id = need(ctx.pos[1], 'kb project add <id> "<name>" [--color #RRGGBB] [--repo path] [--url url] [--desc text]');
      const name = need(ctx.pos.slice(2).join(' '), 'kb project add <id> "<name>" [--color #RRGGBB] [--repo path] [--url url] [--desc text]');
      const body = { id, name };
      if (v.color) { if (!HEX.test(v.color)) fail('--color must be #RRGGBB'); body.color = v.color; }
      if (v.repo) body.repo_path = v.repo;
      if (v.url) body.url = v.url;
      if (v.desc) body.description = v.desc;
      const r = await api(ctx.cfg, ctx.actor, 'POST', '/projects', body);
      return done(ctx, r, `${green('Created project')} ${r.project.id} (${r.project.name})`);
    }
    if (sub === 'set') {
      const id = need(ctx.pos[1], 'kb project set <id> key=value ... (name|color|repo|url|desc|status)');
      const pairs = ctx.pos.slice(2);
      if (!pairs.length) fail('Usage: kb project set <id> key=value ... (name|color|repo|url|desc|status)');
      const body = {};
      for (const p of pairs) {
        const i = p.indexOf('=');
        if (i < 1) fail(`Invalid assignment: ${p} (expected key=value)`);
        const key = p.slice(0, i);
        const val = p.slice(i + 1);
        switch (key) {
          case 'name': body.name = val; break;
          case 'color':
            if (!HEX.test(val)) fail('color must be #RRGGBB');
            body.color = val; break;
          case 'repo': case 'repo_path': body.repo_path = nullable(val); break;
          case 'url': body.url = nullable(val); break;
          case 'desc': case 'description': body.description = val; break;
          case 'status':
            if (!['active', 'paused', 'archived'].includes(val)) fail('status must be active|paused|archived');
            body.status = val; break;
          default: fail(`Unsupported field: ${key}`);
        }
      }
      const r = await api(ctx.cfg, ctx.actor, 'PATCH', `/projects/${encodeURIComponent(id)}`, body);
      return done(ctx, r, `Updated project ${id} (${Object.keys(body).join(', ')})`);
    }
    fail('Usage: kb project add <id> "<name>" [...] / kb project set <id> key=value ...');
  },

  async handoff(ctx) {
    const proj = need(ctx.pos[0], 'kb handoff <proj> "<text>"');
    const text = need(ctx.pos.slice(1).join(' '), 'kb handoff <proj> "<text>"');
    const r = await api(ctx.cfg, ctx.actor, 'PATCH', `/projects/${encodeURIComponent(proj)}`, { handoff: text });
    done(ctx, r, `Updated handoff for ${proj}`);
  },

  async set(ctx) {
    const id = normId(ctx.pos[0]);
    const pairs = ctx.pos.slice(1);
    if (!pairs.length) fail('Usage: kb set <id> key=value ... (branch|session|prio|agent|title|desc|due|tags|status|ask|blocked)');
    const body = {};
    for (const p of pairs) {
      const i = p.indexOf('=');
      if (i < 1) fail(`Invalid assignment: ${p} (expected key=value)`);
      const key = p.slice(0, i);
      const val = p.slice(i + 1);
      const nullable = (x) => (x === '' || x === 'none' || x === 'null' ? null : x);
      const flag = (k) => { if (val !== '0' && val !== '1') fail(`${k} must be 0 or 1`); return val === '1'; };
      switch (key) {
        case 'branch': body.branch = nullable(val); break;
        case 'session': case 'session_ref': body.session_ref = nullable(val); break;
        case 'prio': case 'priority':
          if (!PRIOS.includes(val)) fail(`prio must be ${PRIOS.join('|')}`);
          body.priority = val; break;
        case 'agent':
          if (!AGENTS.includes(val)) fail(`agent must be ${AGENTS.join('|')}`);
          body.agent = val; break;
        case 'title': body.title = val; break;
        case 'desc': case 'description': body.description = val; break;
        case 'due': case 'due_date': body.due_date = nullable(val); break;
        case 'tags': body.tags = val ? val.split(',').map((s) => s.trim()).filter(Boolean) : []; break;
        case 'status': body.status = normStatus(val); break;
        case 'ask': body.needs_owner = flag('ask'); break;
        case 'blocked':
          body.blocked = flag('blocked');
          if (!body.blocked) body.blocked_reason = '';
          break;
        default: fail(`Unsupported field: ${key}`);
      }
    }
    const r = await api(ctx.cfg, ctx.actor, 'PATCH', `/cards/${id}`, body);
    done(ctx, r, `Updated #${id} (${Object.keys(body).join(', ')})`);
  },
};

function out(x) { console.log(JSON.stringify(x, null, 2)); }
function done(ctx, result, human) { if (ctx.json) out(result); else console.log(human); }

const HELP = `kb - Agent Kanban CLI

  kb projects                         List projects and counts
  kb ls [-p proj] [-s status] [-a agent] [--blocked] [--mine]
  kb show <id>
  kb brief <id> [--full]              Show the brief, handoff notes, recent notes, open comments, and project handoff (8,000 characters max unless --full)
  kb add "<title>" -p <project> [-s todo] [-a codex] [--prio p1] [-d "desc"] [--template]
                                      --template fills the description with the brief template; -d text replaces the goal prompt
  kb mv <id> <status>                 backlog|todo|doing|review|done (doing = in_progress)
  kb take <id>                        Assign this actor and set status=in_progress
  kb note <id> "<text>"
  kb note <id> --handoff "<text>"     Add a [handoff] prefix for completed work, next steps, key files, and open questions
  kb block <id> "<reason>"  /  kb unblock <id>
  kb ask <id> "<question>"            Set the owner-decision flag and add a note
  kb answer <id> ["<text>"]           Clear the owner-decision flag and optionally add a note
  kb archive <id> [--undo]            Archive a card; --undo restores it
  kb handoff <project> "<text>"       Replace the project handoff
  kb project add <id> "<name>" [--color #RRGGBB] [--repo path] [--url url] [--desc text]
  kb project set <id> key=value ...   name= color= repo= url= desc= status=active|paused|archived
  kb inbox [-p project] [--cwd <path>] [--all-targets] [--brief]   List open comments, optionally scoped to a project or working directory
  kb comments <card_id>               List a card's comment threads
  kb reply <comment_id> "<text>"      Reply to a comment thread using any comment ID in the thread
  kb set <id> key=value ...           branch= session= prio= agent= title= desc= due= tags= status= ask=0|1 blocked=0|1

Global options: --json prints JSON; --as codex|claude selects the actor
  Actor precedence: --as > KB_AGENT > Codex markers > CLAUDECODE > codex
Config file: ~/.config/agent-kanban/config.json (override with KB_CONFIG)
Time zone: KANBAN_TIMEZONE (default: UTC)
`;

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' }, as: { type: 'string' }, help: { type: 'boolean', short: 'h' },
        p: { type: 'string', short: 'p' }, s: { type: 'string', short: 's' }, a: { type: 'string', short: 'a' },
        d: { type: 'string', short: 'd' }, prio: { type: 'string' }, blocked: { type: 'boolean' }, mine: { type: 'boolean' }, undo: { type: 'boolean' },
        full: { type: 'boolean' }, template: { type: 'boolean' }, handoff: { type: 'string' },
        cwd: { type: 'string' }, 'all-targets': { type: 'boolean' }, brief: { type: 'boolean' },
        color: { type: 'string' }, repo: { type: 'string' }, url: { type: 'string' }, desc: { type: 'string' },
      },
    });
  } catch (e) { fail(e.message); }
  const { values: v, positionals } = parsed;
  const [cmd, ...pos] = positionals;
  if (v.help || !cmd || cmd === 'help') { console.log(HELP); return; }
  const handler = COMMANDS[cmd];
  if (!handler) fail(`Unknown command: ${cmd} (run kb help for usage)`);
  const cfg = loadConfig();
  const actor = resolveActor(v.as);
  await handler({ cfg, actor, v, pos, json: !!v.json });
}

main(process.argv.slice(2)).catch((e) => {
  if (e instanceof KbError) {
    if (process.argv.includes('--json')) console.error(JSON.stringify({ error: { message: e.message, status: e.status ?? null } }));
    else console.error(`kb: ${e.message}`);
    process.exit(1);
  }
  console.error(e);
  process.exit(2);
});
