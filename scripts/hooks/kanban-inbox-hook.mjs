#!/usr/bin/env node
// kanban-inbox-hook is a dependency-free SessionStart hook for Claude Code and Codex (Node.js 20 or newer).
// Usage: kanban-inbox-hook --agent claude|codex [--format text|json]
// It reads hook JSON from stdin for cwd, resolves the real path, and makes one GET request to /session-brief.
// The server selects the project by repo_path prefix and returns a summary capped at 1,500 characters.
// The summary may include the project handoff, active and review cards, their latest handoff notes, and targeted open comments.
// Text output is the default. JSON output uses hookSpecificOutput.additionalContext.
// Errors exit with code 0 and no output so the hook never blocks a session. Total timeout: 3 seconds.
// Config: ~/.config/agent-kanban/config.json; KB_CONFIG and KB_URL can override it.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOTAL_TIMEOUT_MS = 3000;
const DEFAULT_URL = 'http://localhost:3600';

// Exit quietly after the global timeout.
setTimeout(() => process.exit(0), TOTAL_TIMEOUT_MS).unref?.();
const deadline = Date.now() + TOTAL_TIMEOUT_MS - 150;

function parseCli(argv) {
  const o = { agent: 'claude', format: 'text' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--agent') o.agent = argv[++i];
    else if (argv[i] === '--format') o.format = argv[++i];
  }
  return o;
}

function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    const chunks = [];
    const finish = () => { clearTimeout(t); process.stdin.destroy(); resolve(Buffer.concat(chunks).toString('utf8')); };
    const t = setTimeout(finish, timeoutMs);
    process.stdin.on('data', (d) => chunks.push(d));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

function loadConfig() {
  const file = process.env.KB_CONFIG || path.join(os.homedir(), '.config', 'agent-kanban', 'config.json');
  let cfg = {};
  if (fs.existsSync(file)) cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    url: (process.env.KB_URL || cfg.url || DEFAULT_URL).replace(/\/+$/, ''),
    tokens: cfg.tokens || {},
  };
}

function requestOnce(base, method, pathname, token, timeoutMs) {
  const u = new URL(base + pathname);
  const lib = u.protocol === 'https:' ? https : http;
  const opts = { method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } };
  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

async function api(cfg, token, pathname) {
  const left = () => Math.max(300, deadline - Date.now());
  return requestOnce(cfg.url, 'GET', '/api/v1' + pathname, token, left());
}

const canon = (p) => { const r = path.resolve(p); try { return fs.realpathSync(r); } catch { return r; } };

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (!['claude', 'codex'].includes(cli.agent)) return;
  let cwd = process.cwd();
  try {
    const j = JSON.parse(await readStdin(800));
    if (j && typeof j.cwd === 'string' && j.cwd) cwd = j.cwd;
  } catch { /* Use process.cwd() if stdin is missing or invalid. */ }
  const cfg = loadConfig();
  const token = cfg.tokens[cli.agent] || process.env.KB_TOKEN;
  if (!token) return;
  // Project matching and summary formatting are handled by the server in one request.
  // Send the real path first and the original path as a fallback when they differ.
  const real = canon(cwd);
  const raw = path.resolve(cwd);
  const qs = new URLSearchParams({ agent: cli.agent });
  qs.append('cwd', real);
  if (raw !== real) qs.append('cwd', raw);
  const brief = await api(cfg, token, `/session-brief?${qs}`);
  const text = typeof brief?.text === 'string' ? brief.text.trim() : '';
  if (!text) return;
  const payload = cli.format === 'json' ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }) : text;
  await new Promise((resolve) => process.stdout.write(payload + '\n', resolve));
}

function isDirectRun() {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isDirectRun()) main().then(() => process.exit(0), () => process.exit(0));
