import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { makeTestApp, TOKENS, type TestCtx } from './helpers/server.ts';

let t: TestCtx;
let server: ReturnType<typeof serve>;
let url: string;
let cfgFile: string;
let repo: string;
const HOOK = path.resolve('scripts/hooks/kanban-inbox-hook.mjs');

function hook(args: string[], stdin: string | null, env: Record<string, string> = {}, cwd?: string): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('KB_')));
    const t0 = Date.now();
    const p = spawn('node', [HOOK, ...args], { env: { ...base, KB_CONFIG: cfgFile, ...env } as NodeJS.ProcessEnv, cwd });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - t0 }));
    if (stdin !== null) p.stdin.end(stdin);
    else p.stdin.end();
  });
}

beforeAll(async () => {
  t = makeTestApp();
  server = serve({ fetch: t.app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cfgFile = path.join(t.dir, 'hook-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ url, tokens: TOKENS }), { mode: 0o600 });
  repo = path.join(t.dir, 'repo-x');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  repo = fs.realpathSync(repo); // The hook resolves symlinks before matching repo_path.
  t.store.createProject({ id: 'hk', name: 'Hook Project', repo_path: repo }, 'system');
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  t.cleanup();
});

describe('kanban-inbox-hook', () => {
  it('exits successfully with no output when the project has no context', async () => {
    const r = await hook(['--agent', 'codex'], JSON.stringify({ cwd: repo, hook_event_name: 'SessionStart' }));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('prints the server session brief for the selected agent', async () => {
    const cookie = await t.login();
    t.store.updateProject('hk', { handoff: 'Across cards: first do A, then do B' }, 'system');
    const card = t.store.createCard('hk', { title: 'Card with issue', status: 'in_progress', agent: 'codex' }, 'system');
    t.store.addNote(card.id, '[handoff] Completed A, next: B', 'claude');
    for (let i = 0; i < 7; i++) await t.call('POST', `/api/v1/cards/${card.id}/comments`, { cookie, body: { body: `Issue ${i} ` + 'y'.repeat(100), target: 'codex' } });
    await t.call('POST', `/api/v1/cards/${card.id}/comments`, { cookie, body: { body: 'Only for Claude', target: 'claude' } });
    const r = await hook(['--agent', 'codex'], JSON.stringify({ cwd: path.join(repo, 'src') }));
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith('Agent Kanban | Project Hook Project (hk)')).toBe(true);
    expect(r.stdout).toContain('Project handoff: Across cards: first do A, then do B');
    expect(r.stdout).toContain('Open comments (targeted to Codex; total 7 comments):');
    expect(r.stdout.match(/Comment \d+ \| Issue/g)).toHaveLength(5);
    expect(r.stdout).toContain(`- #${card.id} [In progress] Card with issue | Codex | Handoff: Completed A, next: B`);
    expect(r.stdout).toContain('kb brief');
    expect(r.stdout).toContain('kanban_reply_comment');
    expect(r.stdout).not.toContain('Only for Claude');
    expect([...r.stdout].length).toBeLessThanOrEqual(1501); // Includes the trailing newline.
    const c = await hook(['--agent', 'claude'], JSON.stringify({ cwd: repo }));
    expect(c.stdout).toContain('Open comments (targeted to Claude; total 1 comments):');
    expect(c.stdout).toContain('Only for Claude');
  });

  it('makes one session-brief request with the real and original cwd paths', async () => {
    const http = await import('node:http');
    const seen: string[] = [];
    const spy = http.createServer((q, s) => { seen.push(q.url ?? ''); s.setHeader('content-type', 'application/json'); s.end(JSON.stringify({ text: 'Fake summary' })); });
    await new Promise<void>((r) => spy.listen(0, '127.0.0.1', r));
    const link = path.join(t.dir, 'link-to-repo');
    fs.symlinkSync(repo, link);
    const r = await hook(['--agent', 'codex'], JSON.stringify({ cwd: link }), { KB_URL: `http://127.0.0.1:${(spy.address() as AddressInfo).port}` });
    await new Promise((res) => spy.close(res));
    expect(r.stdout).toBe('Fake summary\n');
    expect(seen).toHaveLength(1);
    const u = new URL(seen[0], 'http://x');
    expect(u.pathname).toBe('/api/v1/session-brief');
    expect(u.searchParams.get('agent')).toBe('codex');
    expect(u.searchParams.getAll('cwd')).toEqual([fs.realpathSync(repo), link]); // Real path first, original path as fallback.
  });

  it('emits hookSpecificOutput.additionalContext as JSON', async () => {
    const r = await hook(['--agent', 'claude', '--format', 'json'], JSON.stringify({ cwd: repo }));
    const j = JSON.parse(r.stdout);
    expect(j.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(j.hookSpecificOutput.additionalContext).toContain('Agent Kanban');
    expect(j.hookSpecificOutput.additionalContext).toContain('Project handoff: Across cards');
  });

  it('uses process.cwd() when stdin is empty and returns no output for an unmatched directory', async () => {
    const withCwd = await hook(['--agent', 'claude'], null, {}, repo);
    expect(withCwd.stdout).toContain('Agent Kanban');
    const none = await hook(['--agent', 'claude'], JSON.stringify({ cwd: '/nowhere/else' }));
    expect(none.code).toBe(0);
    expect(none.stdout).toBe('');
  });

  it('exits quietly for missing config, missing token, invalid stdin, and unknown agents', async () => {
    const cases: [string[], string | null, Record<string, string>][] = [
      [['--agent', 'claude'], JSON.stringify({ cwd: repo }), { KB_CONFIG: path.join(t.dir, 'nope.json'), KB_URL: 'http://127.0.0.1:1' }],
      [['--agent', 'claude'], JSON.stringify({ cwd: repo }), { KB_CONFIG: (() => { const f = path.join(t.dir, 'notoken.json'); fs.writeFileSync(f, JSON.stringify({ url, tokens: {} })); return f; })() }],
      [['--agent', 'claude'], '{not json', {}],
      [['--agent', 'gemini'], JSON.stringify({ cwd: repo }), {}],
      [['--agent', 'claude'], JSON.stringify({ cwd: repo }), { KB_CONFIG: (() => { const f = path.join(t.dir, 'bad.json'); fs.writeFileSync(f, '{broken'); return f; })() }],
    ];
    for (const [args, stdin, env] of cases) {
      const r = await hook(args, stdin, env);
      expect(r.code, JSON.stringify(args)).toBe(0);
      expect(r.stdout).toBe('');
    }
  });

  it('exits quietly on network errors, server errors, and timeouts', async () => {
    const down = await hook(['--agent', 'claude'], JSON.stringify({ cwd: repo }), { KB_URL: 'http://127.0.0.1:1' });
    expect(down.code).toBe(0);
    expect(down.stdout).toBe('');
    // A server that never responds.
    const http = await import('node:http');
    const hang = http.createServer(() => {});
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r));
    const port = (hang.address() as AddressInfo).port;
    const slow = await hook(['--agent', 'claude'], JSON.stringify({ cwd: repo }), { KB_URL: `http://127.0.0.1:${port}` });
    hang.closeAllConnections?.();
    await new Promise((r) => hang.close(r));
    expect(slow.code).toBe(0);
    expect(slow.stdout).toBe('');
    expect(slow.ms).toBeLessThan(3600);
    const err500 = http.createServer((_q, s) => { s.statusCode = 500; s.end('x'); });
    await new Promise<void>((r) => err500.listen(0, '127.0.0.1', r));
    const r5 = await hook(['--agent', 'claude'], JSON.stringify({ cwd: repo }), { KB_URL: `http://127.0.0.1:${(err500.address() as AddressInfo).port}` });
    await new Promise((r) => err500.close(r));
    expect(r5.code).toBe(0);
    expect(r5.stdout).toBe('');
  }, 15000);
});

describe('print-codex-hook-trust', () => {
  it('prints the trust entry for kanban-inbox-hook with a SHA-256 hash', async () => {
    const f = path.join(t.dir, 'hooks.json');
    fs.writeFileSync(f, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo other' }, { type: 'command', command: 'node /x/kanban-inbox-hook --agent codex' }] }] } }));
    const out = await new Promise<string>((resolve) => {
      const p = spawn('node', [path.resolve('scripts/hooks/print-codex-hook-trust.mjs'), f]);
      let s = '';
      p.stdout.on('data', (d) => (s += d));
      p.on('close', () => resolve(s));
    });
    expect(out).toContain(`[hooks.state."${f}:session_start:0:1"]`);
    expect(out).toMatch(/trusted_hash = "sha256:[0-9a-f]{64}"/);
    expect(out).not.toContain(':0:0"]');
  });
});
