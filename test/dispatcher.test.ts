import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { makeTestApp, TOKENS, type TestCtx } from './helpers/server.ts';
// @ts-expect-error JavaScript module
import { createDispatcher, createLogger, loadConfig, buildCommand, createApi } from '../dispatcher/kanban-dispatcher.mjs';

let t: TestCtx;
let server: ReturnType<typeof serve>;
let url: string;
let cookie: string;
let work: string; // Temporary directory for fake binaries, state, logs, and repository.
let bin: string;
let repo: string;
const origPath = process.env.PATH;
let n = 0;

// Fake codex and claude executables record argv, cwd, and stdin; a file selects the behavior.
const FAKE = `#!/bin/sh
NAME=$(basename "$0")
D="$FAKE_DIR"
N=1; while ! mkdir "$D/lock-$N" 2>/dev/null; do N=$((N+1)); done
echo "$NAME" > "$D/call-$N.name"
printf '%s\\n' "$@" > "$D/call-$N.argv"
pwd -P > "$D/call-$N.cwd"
[ -n "$KANBAN_DISPATCH_TOKEN" ] && echo yes > "$D/call-$N.tokenenv"
PREV=""
for a in "$@"; do
  if [ "$PREV" = "--mcp-config" ]; then cp "$a" "$D/call-$N.mcp" 2>/dev/null; stat -f %Lp "$a" > "$D/call-$N.mcpmode" 2>/dev/null; echo "$a" > "$D/call-$N.mcppath"; fi
  PREV="$a"
done
PROMPT=$(cat)
printf '%s' "$PROMPT" > "$D/call-$N.prompt"
echo $$ > "$D/call-$N.pid"
MODE=$(cat "$D/mode" 2>/dev/null || echo reply)
ROOT=$(printf '%s' "$PROMPT" | grep -o 'comment_id=[0-9]*' | head -1 | cut -d= -f2)
reply() { curl -s -X POST -H "Authorization: Bearer $FAKE_TOKEN" -H 'Content-Type: application/json' -d "{\\"body\\":\\"$1\\"}" "$FAKE_URL/api/v1/comments/$ROOT/replies" > /dev/null; }
case "$MODE" in
  reply) reply "Result: ok" ;;
  long) reply "$(head -c 500 /dev/zero | tr '\\0' 'x')" ;;
  slow) sleep 0.7; reply "slow ok" ;;
  none) : ;;
  fail) exit 1 ;;
  failthenreply) if [ "$N" -ge 2 ]; then reply "second try ok"; else exit 1; fi ;;
  nonethenreply) if [ "$N" -ge 2 ]; then reply "second try ok"; fi ;;
  hang) sleep 60 & echo $! > "$D/call-$N.childpid"; wait ;;
esac
`;
const setMode = (m: string) => fs.writeFileSync(path.join(work, 'fake', 'mode'), m);
const calls = () => fs.readdirSync(path.join(work, 'fake')).filter((f) => /^call-\d+\.name$/.test(f)).length;
const readCall = (i: number, ext: string) => fs.readFileSync(path.join(work, 'fake', `call-${i}.${ext}`), 'utf8');

async function ownerThread(cardId: number, body = 'Why does this work this way?', target?: string) {
  const r = await t.call('POST', `/api/v1/cards/${cardId}/comments`, { cookie, body: { body, ...(target ? { target } : {}) } });
  expect(r.status).toBe(201);
  return r.json.comment as { id: number };
}
const mkCard = (title = `Card ${++n}`, project = 'dsp') => t.store.createCard(project, { title }, 'system');
const threadOf = async (cardId: number, rootId: number) =>
  (await t.call('GET', `/api/v1/cards/${cardId}/comments`, { token: 'codex' })).json.threads.find((x: any) => x.root.id === rootId);

function makeCfg(over: Record<string, unknown> = {}, disp: Record<string, unknown> = {}) {
  const f = path.join(work, `cfg-${++n}.json`);
  fs.writeFileSync(f, JSON.stringify({ url, tokens: TOKENS, dispatcher: { pumpMs: 50, killGraceMs: 300, ...disp }, ...over }));
  return loadConfig({ KB_CONFIG: f, DISPATCHER_STATE: path.join(work, 'state.json'), DISPATCHER_LOG: path.join(work, 'dispatcher.log'), DISPATCHER_SCRATCH: path.join(work, 'scratch') } as NodeJS.ProcessEnv);
}
const dispatcherFor = (cfg: any, extra: Record<string, unknown> = {}) => createDispatcher({ cfg, ...extra });

beforeAll(async () => {
  t = makeTestApp();
  server = serve({ fetch: t.app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cookie = await t.login();
});
afterAll(async () => {
  await new Promise((r) => { (server as any).closeAllConnections?.(); server.close(r); });
  t.cleanup();
  process.env.PATH = origPath;
});
beforeEach(() => {
  work = fs.mkdtempSync(path.join(t.dir, 'dsp-'));
  bin = path.join(work, 'bin');
  repo = path.join(work, 'repo');
  fs.mkdirSync(bin);
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(work, 'fake'));
  for (const name of ['codex', 'claude']) {
    fs.writeFileSync(path.join(bin, name), FAKE, { mode: 0o755 });
  }
  process.env.PATH = `${bin}:${origPath}`;
  process.env.FAKE_DIR = path.join(work, 'fake');
  process.env.FAKE_TOKEN = TOKENS.codex;
  process.env.FAKE_URL = url;
  setMode('reply');
  // Give each test an isolated project.
  try { t.store.requireProject('dsp'); t.store.updateProject('dsp', { repo_path: repo }, 'system'); } catch { t.store.createProject({ id: 'dsp', name: 'Dispatch Test', repo_path: repo }, 'system'); }
  // Resolve open threads left by earlier tests.
  for (const i of t.store.listInbox({ status: 'all', limit: 200 })) if (i.root.status !== 'resolved') t.store.resolveComment(i.root.id, true, 'owner');
});
afterEach(() => {
  process.env.PATH = origPath;
});

describe('Configuration and command construction', () => {
  it('defaults API and card links to public local/example URLs', () => {
    const file = path.join(work, 'cfg-defaults.json');
    fs.writeFileSync(file, JSON.stringify({ tokens: TOKENS }));
    const c = loadConfig({
      KB_CONFIG: file,
      DISPATCHER_STATE: path.join(work, 'state.json'),
      DISPATCHER_LOG: path.join(work, 'dispatcher.log'),
      DISPATCHER_SCRATCH: path.join(work, 'scratch'),
    } as NodeJS.ProcessEnv);
    expect(c).toMatchObject({ url: 'http://localhost:3600', publicUrl: 'https://kanban.example.com', notifyWebhook: null });
  });

  it('uses public defaults and omits model flags until configured', () => {
    const c = makeCfg();
    expect(c).toMatchObject({ url, publicUrl: 'https://kanban.example.com', maxConcurrent: 2, hourlyCap: 10, timeoutMin: 15, codex: { model: null, effort: null }, claude: { model: null, effort: null }, pollMinutes: 5 });
    const cx = buildCommand(c, 'codex', '/x');
    expect(cx.cmd).toBe('codex');
    expect(cx.args).toEqual([
      'exec', '--skip-git-repo-check', '--ignore-user-config', '--ephemeral',
      '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
      '-c', `mcp_servers.agent-kanban.url="${url}/mcp"`, '-c', 'mcp_servers.agent-kanban.bearer_token_env_var="KANBAN_DISPATCH_TOKEN"',
      '-c', 'mcp_servers.agent-kanban.default_tools_approval_mode="approve"',
      '-c', 'mcp_servers.agent-kanban.enabled_tools=["kanban_get_card","kanban_list_comments","kanban_reply_comment","kanban_list_cards"]',
      ...['apps', 'plugins', 'remote_plugin', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'image_generation', 'multi_agent', 'memories', 'goals'].flatMap((f) => ['--disable', f]),
      '-s', 'read-only', '--cd', '/x', '-',
    ]);
    expect(cx.env).toEqual({ KANBAN_DISPATCH_TOKEN: TOKENS.codex });
    expect(cx.args).not.toContain('-m');
    expect(cx.args.join(' ')).not.toContain('model_reasoning_effort=');
    expect(JSON.stringify(cx.args)).not.toContain(TOKENS.codex); // Token is passed through the environment.
    const cl = buildCommand(c, 'claude', '/x', { mcpConfigPath: '/tmp/m.json' });
    expect(cl.cmd).toBe('claude');
    const arg = (k: string) => cl.args[cl.args.indexOf(k) + 1];
    expect(cl.args[0]).toBe('-p');
    expect(arg('--permission-mode')).toBe('dontAsk');
    expect(arg('--setting-sources')).toBe('');
    expect(arg('--tools')).toBe('Read,Grep,Glob');
    expect(cl.args).not.toContain('--model');
    expect(cl.args).not.toContain('--effort');
    expect(cl.args).toContain('--strict-mcp-config');
    expect(arg('--mcp-config')).toBe('/tmp/m.json');
    expect(arg('--allowedTools')).toBe('mcp__agent-kanban__kanban_get_card,mcp__agent-kanban__kanban_list_comments,mcp__agent-kanban__kanban_reply_comment,mcp__agent-kanban__kanban_list_cards,Read,Grep,Glob');
    const denied = arg('--disallowedTools').split(',');
    for (const x of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'mcp__agent-kanban__kanban_move_card', 'mcp__agent-kanban__kanban_create_card', 'mcp__agent-kanban__kanban_update_card', 'mcp__agent-kanban__kanban_add_note', 'mcp__agent-kanban__kanban_archive_card', 'mcp__agent-kanban__kanban_update_project_handoff', 'mcp__agent-kanban__kanban_create_project']) expect(denied).toContain(x);
    expect(cl.args.join(' ')).not.toContain(TOKENS.claude);
    const o = makeCfg({}, { maxConcurrent: 3, hourlyCap: 4, timeoutMin: 1, codex: { model: 'model-x', effort: 'low' }, claude: { model: 'model-y', effort: 'max' } });
    expect(buildCommand(o, 'claude', '/x').args).toEqual(expect.arrayContaining(['--model', 'model-y', '--effort', 'max']));
    expect(buildCommand(o, 'codex', '/x').args).toEqual(expect.arrayContaining(['-m', 'model-x', 'model_reasoning_effort=low']));
    expect(o).toMatchObject({ maxConcurrent: 3, hourlyCap: 4, timeoutMin: 1, codex: { model: 'model-x', effort: 'low' } });
  });
});

describe('Dispatch, execution, and deduplication', () => {
  it('Codex jobs use fixed argv and the project repository, then record a successful reply', async () => {
    const card = mkCard('Card to reply to');
    const root = await ownerThread(card.id);
    const d = dispatcherFor(makeCfg());
    await d.pollOnce();
    await d.idle();
    expect(calls()).toBe(1);
    expect(readCall(1, 'name').trim()).toBe('codex');
    const argv = readCall(1, 'argv').trim().split('\n');
    expect(argv.slice(0, 4)).toEqual(['exec', '--skip-git-repo-check', '--ignore-user-config', '--ephemeral']);
    expect(argv).not.toContain('-m');
    expect(argv.join(' ')).not.toContain('model_reasoning_effort=');
    expect(argv.slice(-5)).toEqual(['-s', 'read-only', '--cd', repo, '-']);
    expect(fs.existsSync(path.join(work, 'fake', 'call-1.tokenenv'))).toBe(true); // Token is passed through the environment.
    expect(fs.realpathSync(readCall(1, 'cwd').trim())).toBe(fs.realpathSync(repo));
    const prompt = readCall(1, 'prompt');
    expect(prompt).toContain(`card_id=${card.id}`);
    expect(prompt).toContain(`comment_id=${root.id}`);
    expect(prompt).toContain('Card to reply to');
    expect(prompt).toMatch(/Do not edit files or deploy/);
    const th = await threadOf(card.id, root.id);
    expect(th.root.status).toBe('answered');
    expect(th.replies[0]).toMatchObject({ author: 'codex' });
    expect(d.state.threads[root.id]).toMatchObject({ status: 'done', attempts: 1 });
    await d.stop();
  });

  it('Claude jobs use the read-only tool allowlist', async () => {
    const card = mkCard();
    process.env.FAKE_TOKEN = TOKENS.claude;
    const root = await ownerThread(card.id, 'for Claude', 'claude');
    const d = dispatcherFor(makeCfg());
    await d.pollOnce();
    await d.idle();
    expect(calls()).toBe(1);
    expect(readCall(1, 'name').trim()).toBe('claude');
    const argv = readCall(1, 'argv').trim().split('\n');
    expect(argv[0]).toBe('-p');
    expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(argv).toContain('--strict-mcp-config');
    expect(argv[argv.indexOf('--allowedTools') + 1]).toContain('mcp__agent-kanban__kanban_reply_comment');
    expect(argv[argv.indexOf('--allowedTools') + 1]).not.toMatch(/Edit|Write|Bash/);
    // The temporary MCP config contains only the server, has mode 600, and is removed after the job.
    const mcp = JSON.parse(readCall(1, 'mcp'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['agent-kanban']);
    expect(mcp.mcpServers['agent-kanban']).toMatchObject({ type: 'http', url: `${url}/mcp`, headers: { Authorization: `Bearer ${TOKENS.claude}` } });
    expect(readCall(1, 'mcpmode').trim()).toBe('600');
    expect(fs.existsSync(readCall(1, 'mcppath').trim())).toBe(false);
    expect((await threadOf(card.id, root.id)).replies[0].author).toBe('claude');
    await d.stop();
  });

  it('skips resolved or archived threads, dispatches new owner follow-ups once, and keeps state across restarts', async () => {
    const cfg = makeCfg();
    const c1 = mkCard();
    const r1 = await ownerThread(c1.id);
    t.store.replyComment(r1.id, 'First reply', 'codex'); // answered
    const c2 = mkCard();
    const r2 = await ownerThread(c2.id);
    t.store.resolveComment(r2.id, true, 'owner'); // resolved
    const c3 = mkCard();
    await ownerThread(c3.id);
    t.store.archiveCard(c3.id, true, 'system'); // Archived.
    const d = dispatcherFor(cfg);
    await d.pollOnce();
    await d.idle();
    expect(calls()).toBe(0);
    // A new owner follow-up is dispatched
    t.store.replyComment(r1.id, 'One follow-up', 'owner');
    await d.pollOnce();
    await d.idle();
    expect(calls()).toBe(1);
    // Do not dispatch the same message twice.
    await d.pollOnce();
    await d.idle();
    expect(calls()).toBe(1);
    // After restart, the same owner message is not dispatched again
    setMode('none');
    const c4 = mkCard();
    const r4 = await ownerThread(c4.id);
    const d2 = dispatcherFor(cfg);
    await d2.pollOnce();
    await d2.idle(); // none mode: two attempts without a reply become failed
    expect(calls()).toBe(3);
    const d3 = dispatcherFor(cfg);
    expect(d3.state.threads[r4.id]).toMatchObject({ status: 'failed', attempts: 2 });
    await d3.pollOnce();
    await d3.idle();
    expect(calls()).toBe(3);
    await d.stop(); await d2.stop(); await d3.stop();
  });

  it('uses scratchDir when the project repository is unavailable', async () => {
    t.store.updateProject('dsp', { repo_path: path.join(work, 'does-not-exist') }, 'system');
    const card = mkCard();
    await ownerThread(card.id);
    const cfg = makeCfg();
    const d = dispatcherFor(cfg);
    await d.pollOnce();
    await d.idle();
    expect(fs.realpathSync(readCall(1, 'cwd').trim())).toBe(fs.realpathSync(cfg.scratchDir));
    const argv = readCall(1, 'argv').trim().split('\n');
    expect(argv[argv.indexOf('--cd') + 1]).toBe(cfg.scratchDir);
    await d.stop();
  });

  it('retries once, reports terminal failure through a webhook, and does not retry again', async () => {
    const hooks: any[] = [];
    const wh = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => { hooks.push({ ua: req.headers['user-agent'], body: JSON.parse(b) }); res.statusCode = 204; res.end(); });
    });
    await new Promise<void>((r) => wh.listen(0, '127.0.0.1', r));
    const cfg = makeCfg({}, { notifyWebhook: `http://127.0.0.1:${(wh.address() as AddressInfo).port}/hook` });
    const c1 = mkCard();
    const r1 = await ownerThread(c1.id);
    setMode('nonethenreply');
    const d = dispatcherFor(cfg);
    await d.pollOnce();
    await d.idle();
    expect(calls()).toBe(2);
    expect(d.state.threads[r1.id]).toMatchObject({ status: 'done', attempts: 2 });
    // Both attempts fail.
    setMode('fail');
    const c2 = mkCard('Failing card');
    const r2 = await ownerThread(c2.id);
    await d.pollOnce();
    await d.idle();
    expect(calls()).toBe(4);
    expect(d.state.threads[r2.id]).toMatchObject({ status: 'failed', attempts: 2 });
    await d.pollOnce();
    await d.idle();
    expect(calls()).toBe(4); // No further retry.
    const alert = hooks.find((h) => h.body.event === 'dispatcher.job_failed');
    expect(alert).toBeTruthy();
    expect(alert.ua).toMatch(/^agent-kanban-dispatcher\//);
    expect(alert.body).toMatchObject({
      event: 'dispatcher.job_failed', target: 'codex', attempts: 2, reason: 'exit 1', projectId: 'dsp',
      card: { id: c2.id, title: 'Failing card', url: `https://kanban.example.com/p/dsp?card=${c2.id}` },
      comment: { id: r2.id },
    });
    await d.stop();
    await new Promise((r) => wh.close(r));
  }, 20000);
});

describe('Concurrency and limits', () => {
  it('runs up to maxConcurrent jobs and serializes jobs for the same card', async () => {
    setMode('slow');
    const cards = [mkCard(), mkCard(), mkCard()];
    const roots = [] as number[];
    for (const c of cards) roots.push((await ownerThread(c.id)).id);
    const sameCard = await ownerThread(cards[0].id, 'Second thread on the same card'); // same card as cards[0]
    const d = dispatcherFor(makeCfg({}, { maxConcurrent: 2, hourlyCap: 50 }));
    let maxRunning = 0;
    let sameCardOverlap = false;
    const sampler = setInterval(() => {
      maxRunning = Math.max(maxRunning, d.running.size);
      const ids = [...d.running.values()].map((r: any) => r.cardId);
      if (new Set(ids).size !== ids.length) sameCardOverlap = true;
    }, 10);
    await d.pollOnce();
    await d.idle();
    clearInterval(sampler);
    expect(maxRunning).toBe(2);
    expect(sameCardOverlap).toBe(false);
    expect(calls()).toBe(4);
    for (const [i, c] of cards.entries()) expect((await threadOf(c.id, roots[i])).root.status).toBe('answered');
    expect((await threadOf(cards[0].id, sameCard.id)).root.status).toBe('answered');
    await d.stop();
  }, 20000);

  it('leaves jobs queued after the hourly limit is reached', async () => {
    const cards = [mkCard(), mkCard(), mkCard()];
    for (const c of cards) await ownerThread(c.id);
    const d = dispatcherFor(makeCfg({}, { maxConcurrent: 2, hourlyCap: 2 }));
    await d.pollOnce();
    await d.idle();
    expect(calls()).toBe(2);
    expect(d.queue).toHaveLength(1);
    expect(d.startTimes).toHaveLength(2);
    await d.stop();
  });

  it('kills the process tree on timeout and records failure', async () => {
    setMode('hang');
    const card = mkCard();
    const root = await ownerThread(card.id);
    const d = dispatcherFor(makeCfg({}, { timeoutMin: 0.02, killGraceMs: 300 }));
    await d.pollOnce();
    await d.idle();
    expect(calls()).toBe(2);
    expect(d.state.threads[root.id]).toMatchObject({ status: 'failed' });
    for (const i of [1, 2]) {
      const pids = [Number(readCall(i, 'pid')), Number(readCall(i, 'childpid'))];
      for (const pid of pids) {
        let alive = true;
        try { process.kill(pid, 0); } catch { alive = false; }
        expect(alive, `pid ${pid} should be terminated`).toBe(false);
      }
    }
    expect(fs.readFileSync(path.join(work, 'dispatcher.log'), 'utf8')).toContain('reason=timeout');
    await d.stop();
  }, 20000);
});

describe('Claude temporary MCP config cleanup', () => {
  it('removes temporary MCP config after failed and timed out jobs', async () => {
    const tmpCount = () => fs.readdirSync(fs.realpathSync(os.tmpdir())).filter((f) => f.startsWith('kanban-dispatch-')).length;
    const before = tmpCount();
    process.env.FAKE_TOKEN = TOKENS.claude;
    for (const mode of ['fail', 'hang']) {
      setMode(mode);
      const card = mkCard();
      await ownerThread(card.id, 'x', 'claude');
      const d = dispatcherFor(makeCfg({}, { timeoutMin: 0.02, killGraceMs: 300 }));
      await d.pollOnce();
      await d.idle();
      await d.stop();
      for (const i of Array.from({ length: calls() }, (_, k) => k + 1)) {
        const f = path.join(work, 'fake', `call-${i}.mcppath`);
        if (fs.existsSync(f)) expect(fs.existsSync(fs.readFileSync(f, 'utf8').trim())).toBe(false);
      }
      fs.rmSync(path.join(work, 'fake'), { recursive: true }); fs.mkdirSync(path.join(work, 'fake')); setMode(mode);
    }
    expect(tmpCount()).toBe(before);
  }, 30000);
});

describe('SSE event handling and webhook notifications', () => {
  it('dispatches an SSE comment and sends a plain JSON reply event to the configured webhook', async () => {
    const hooks: any[] = [];
    const wh = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => { hooks.push({ ua: req.headers['user-agent'], ct: req.headers['content-type'], body: JSON.parse(b) }); res.statusCode = 204; res.end(); });
    });
    await new Promise<void>((r) => wh.listen(0, '127.0.0.1', r));
    setMode('long');
    const card = mkCard('SSE test card');
    const cfg = makeCfg({}, { notifyWebhook: `http://127.0.0.1:${(wh.address() as AddressInfo).port}/hook`, publicUrl: 'https://kanban.example.com/' });
    const d = dispatcherFor(cfg);
    d.start();
    await new Promise((r) => setTimeout(r, 300)); // Wait for SSE readiness.
    const root = await ownerThread(card.id, 'Question that triggered SSE');
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && hooks.length === 0) await new Promise((r) => setTimeout(r, 50));
    await d.stop();
    await new Promise((r) => { wh.closeAllConnections?.(); wh.close(r); });
    expect(calls()).toBe(1);
    expect(hooks).toHaveLength(1);
    const h = hooks[0];
    expect(h.ua).toMatch(/^agent-kanban-dispatcher\/\d/);
    expect(h.ct).toContain('application/json');
    expect(h.body).toMatchObject({
      event: 'comment.replied', actor: 'codex', commentId: expect.any(Number), rootId: root.id,
      cardId: card.id, projectId: 'dsp', title: 'SSE test card', url: `https://kanban.example.com/p/dsp?card=${card.id}`,
    });
    expect(h.body.body.startsWith('x'.repeat(300))).toBe(true);
    expect(h.body.body.length).toBe(303);
    expect(h.body.body.endsWith('...')).toBe(true);
    expect((await threadOf(card.id, root.id)).root.status).toBe('answered');
  }, 20000);

  it('does not send webhook requests when notifyWebhook is unset', async () => {
    const card = mkCard();
    await ownerThread(card.id);
    const d = dispatcherFor(makeCfg());
    d.start();
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && calls() === 0) await new Promise((r) => setTimeout(r, 50));
    await d.idle();
    await d.stop();
    expect(calls()).toBe(1);
    expect(fs.readFileSync(path.join(work, 'dispatcher.log'), 'utf8')).not.toContain('webhook sent');
  });
});

describe('SSE reconnect behavior', () => {
  it('reconnects with backoff and polls all open threads after reconnecting', async () => {
    const { createApi } = await import('../dispatcher/kanban-dispatcher.mjs' as string);
    const cfg = makeCfg();
    const real = createApi(cfg);
    let opened = 0;
    const api = {
      get: real.get,
      stream: (h: any) => {
        opened++;
        if (opened === 1) {
          h.onReady(); // First connection becomes ready, then closes without events
          setTimeout(() => h.onClose(new Error('boom')), 20);
        } else {
          h.onReady(); // Reconnect readiness triggers a full catch-up poll
        }
        return { close() {} };
      },
    };
    const d = createDispatcher({ cfg, api });
    d.start();
    await new Promise((r) => setTimeout(r, 100));
    const card = mkCard();
    const root = await ownerThread(card.id, 'Comment created while disconnected'); // SSE did not deliver this event
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && opened < 2) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));
    await d.idle();
    await d.stop();
    expect(opened).toBe(2);
    expect(calls()).toBeGreaterThanOrEqual(1);
    expect((await threadOf(card.id, root.id)).root.status).toBe('answered');
    expect(fs.readFileSync(path.join(work, 'dispatcher.log'), 'utf8')).toMatch(/sse closed \(boom\); retry in 1000ms/);
  }, 15000);
});

describe('--dry-run and logs', () => {
  const run = (args: string[], env: Record<string, string>) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile('node', ['dispatcher/kanban-dispatcher.mjs', ...args], { env: { ...process.env, ...env } as NodeJS.ProcessEnv }, (err, stdout, stderr) =>
        resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr }),
      );
    });

  it('--dry-run prints commands without running agents, writing state, or sending webhooks', async () => {
    const c1 = mkCard();
    const r1 = await ownerThread(c1.id, 'dry codex', 'codex');
    const c2 = mkCard();
    const r2 = await ownerThread(c2.id, 'dry claude', 'claude');
    const cfgFile = path.join(work, 'cfg-dry.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ url, tokens: TOKENS, dispatcher: { notifyWebhook: 'http://localhost:9/never' } }));
    const statePath = path.join(work, 'dry-state.json');
    const out = await run(['--dry-run'], { KB_CONFIG: cfgFile, DISPATCHER_STATE: statePath, DISPATCHER_LOG: path.join(work, 'dry.log'), DISPATCHER_SCRATCH: path.join(work, 'scratch') });
    expect(out.code, out.stderr).toBe(0);
    const lines = out.stdout.trim().split('\n').map((l) => JSON.parse(l));
    const a = lines.find((l) => l.root === r1.id);
    const b = lines.find((l) => l.root === r2.id);
    expect(a.command.slice(0, 5)).toEqual(['codex', 'exec', '--skip-git-repo-check', '--ignore-user-config', '--ephemeral']);
    expect(a.command).not.toContain('-m');
    expect(a.command.slice(-5)).toEqual(['-s', 'read-only', '--cd', repo, '-']);
    expect(JSON.stringify(out.stdout)).not.toContain(TOKENS.codex);
    expect(a.cwd).toBe(repo);
    expect(b.command[0]).toBe('claude');
    expect(b.command[1]).toBe('-p');
    expect(b.command).toContain('--strict-mcp-config');
    expect(out.stdout).not.toContain(TOKENS.claude);
    expect(calls()).toBe(0);
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it('logs identifiers and status without comment bodies or tokens, then rotates large files', async () => {
    const card = mkCard();
    await ownerThread(card.id, 'private-content-SECRET-BODY');
    const d = dispatcherFor(makeCfg());
    await d.pollOnce();
    await d.idle();
    await d.stop();
    const log = fs.readFileSync(path.join(work, 'dispatcher.log'), 'utf8');
    expect(log).toMatch(/start root=\d+ card=\d+ target=codex attempt=1/);
    expect(log).toMatch(/done root=\d+/);
    expect(log).not.toContain('SECRET-BODY');
    expect(log).not.toContain(TOKENS.codex);
    expect(log).not.toContain(TOKENS.claude);
    const f = path.join(work, 'rot.log');
    fs.writeFileSync(f, Buffer.alloc(5 * 1024 * 1024 + 10, 97));
    createLogger(f)('after rotate');
    expect(fs.existsSync(f + '.1')).toBe(true);
    expect(fs.readFileSync(f, 'utf8')).toContain('after rotate');
    expect(fs.statSync(f).size).toBeLessThan(200);
  });
});

describe('Network error handling', () => {
  it('keeps the process alive when the API is unreachable', async () => {
    const errors: unknown[] = [];
    const onUncaught = (e: unknown) => errors.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      const cfg = { url: 'http://localhost:1', tokens: TOKENS };
      const api = createApi(cfg);
      await expect(api.get('/comments')).rejects.toBeTruthy();
      const closed = await new Promise<any>((resolve) => {
        api.stream({ onReady() {}, onEvent() {}, onClose: (err: unknown) => resolve(err) });
      });
      expect(closed).toBeTruthy();
      await new Promise((r) => setTimeout(r, 200));
      expect(errors).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  }, 30000);

  it('retries SSE connections with backoff after a connection error', async () => {
    const cfg = makeCfg();
    let opened = 0;
    const api = {
      get: createApi(cfg).get,
      stream: (h: any) => {
        opened++;
        setTimeout(() => h.onClose(Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' })), 10);
        return { close() {} };
      },
    };
    const d = createDispatcher({ cfg, api });
    d.start();
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && opened < 2) await new Promise((r) => setTimeout(r, 50));
    await d.stop();
    expect(opened).toBeGreaterThanOrEqual(2);
    expect(fs.readFileSync(path.join(work, 'dispatcher.log'), 'utf8')).toContain('sse closed (EHOSTUNREACH)');
  }, 15000);
});

describe('Launch agent template rendering', () => {
  it('renders the launch agent plist with configured values and no placeholders', async () => {
    const out = await new Promise<string>((resolve, reject) => {
      execFile('bash', ['scripts/install-dispatcher.sh', '--print'], (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    expect(out).toContain('<string>com.example.agent-kanban-dispatcher</string>');
    expect(out).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(out).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
    expect(out).toMatch(/<key>PATH<\/key>\s*<string>[^<]*\/bin[^<]*<\/string>/);
    expect(out).not.toMatch(/@[A-Z]+@/);
  });

  it('keeps shell installer source ASCII-only', () => {
    for (const f of fs.readdirSync('scripts').filter((x) => x.endsWith('.sh'))) {
      const bad = fs.readFileSync(path.join('scripts', f), 'utf8').split('\n').filter((l) => /\$[A-Za-z_][A-Za-z_0-9]*[^\x00-\x7F]/.test(l));
      expect(bad, f).toEqual([]);
    }
  });
});
