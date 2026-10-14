import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { CARD_BRIEF_TEMPLATE } from '../shared/constants.ts';
import { makeTestApp, TOKENS, type TestCtx } from './helpers/server.ts';

let t: TestCtx;
let server: ReturnType<typeof serve>;
let cfgFile: string;
let url: string;

function kb(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CODEX_') && !k.startsWith('KB_') && k !== 'CLAUDECODE'));
    execFile('node', ['cli/kb.mjs', ...args], { env: { ...base, KB_CONFIG: cfgFile, NO_COLOR: '1', ...env } as NodeJS.ProcessEnv }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr });
    });
  });
}

beforeAll(async () => {
  t = makeTestApp();
  server = serve({ fetch: t.app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cfgFile = path.join(t.dir, 'kb-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ url, tokens: TOKENS }), { mode: 0o600 });
  t.store.createProject({ id: 'demo', name: 'Demo Project' }, 'system');
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  t.cleanup();
});

describe('kb CLI against a local test server', () => {
  it('creates, moves, notes, and lists a card while recording its actor', async () => {
    const add = await kb(['add', 'Sample card', '-p', 'demo', '-a', 'codex', '--prio', 'p1', '-d', 'Sample description', '--json']);
    expect(add.code, add.stderr).toBe(0);
    const card = JSON.parse(add.stdout).card;
    expect(card).toMatchObject({ title: 'Sample card', project_id: 'demo', agent: 'codex', priority: 'p1', description: 'Sample description', status: 'todo' });

    const mv = await kb(['mv', String(card.id), 'doing', '--json', '--as', 'codex']);
    expect(JSON.parse(mv.stdout).card.status).toBe('in_progress');

    const note = await kb(['note', String(card.id), 'First step complete', '--json']);
    expect(JSON.parse(note.stdout).note.body).toBe('First step complete');

    const ls = await kb(['ls', '-p', 'demo', '-s', 'doing', '--json']);
    const cards = JSON.parse(ls.stdout);
    expect(cards.map((c: any) => c.id)).toEqual([card.id]);

    const detail = (await t.call('GET', `/api/v1/cards/${card.id}`, { token: 'claude' })).json;
    const actors = Object.fromEntries(detail.events.map((e: any) => [e.type, e.actor]));
    expect(actors['card.created']).toBe('codex'); // Default actor.
    expect(actors['card.moved']).toBe('codex'); // --as codex.
    expect(actors['note.added']).toBe('codex');
  });

  it('takes, blocks, asks, updates, hands off, and displays a card', async () => {
    const card = JSON.parse((await kb(['add', 'Another card', '-p', 'demo', '--json'])).stdout).card;
    const take = JSON.parse((await kb(['take', String(card.id), '--as', 'codex', '--json'])).stdout).card;
    expect(take).toMatchObject({ agent: 'codex', status: 'in_progress' });
    const blk = JSON.parse((await kb(['block', String(card.id), 'Waiting for design', '--json'])).stdout).card;
    expect(blk).toMatchObject({ blocked: true, blocked_reason: 'Waiting for design' });
    const unb = JSON.parse((await kb(['unblock', String(card.id), '--json'])).stdout).card;
    expect(unb).toMatchObject({ blocked: false, blocked_reason: '' });
    await kb(['ask', String(card.id), 'Should this be released?']);
    const set = JSON.parse((await kb(['set', String(card.id), 'branch=feat/x', 'prio=p0', 'tags=a,b', 'session=job-1', '--json'])).stdout).card;
    expect(set).toMatchObject({ branch: 'feat/x', priority: 'p0', tags: ['a', 'b'], session_ref: 'job-1', needs_owner: true });
    await kb(['handoff', 'demo', 'Next: deploy']);
    const show = JSON.parse((await kb(['show', String(card.id), '--json'])).stdout);
    expect(show.notes[0].body).toContain('Should this be released?');
    const proj = JSON.parse((await kb(['projects', '--json'])).stdout).find((p: any) => p.id === 'demo');
    expect(proj.counts.in_progress).toBeGreaterThanOrEqual(1);
    expect(t.store.requireProject('demo').handoff).toBe('Next: deploy');
    const human = await kb(['ls', '--mine', '--as', 'codex']);
    expect(human.stdout).toContain('Another card');
  });

  it('answer clears the owner flag and optionally adds a note', async () => {
    const card = JSON.parse((await kb(['add', 'Waiting for owner', '-p', 'demo', '--json'])).stdout).card;
    const id = String(card.id);
    await kb(['ask', id, 'Choose option A or B?']);
    expect(JSON.parse((await kb(['show', id, '--json'])).stdout).card.needs_owner).toBe(true);

    const withNote = await kb(['answer', id, 'Choose', 'A,', 'release', '--json']);
    expect(withNote.code, withNote.stderr).toBe(0);
    const j = JSON.parse(withNote.stdout);
    expect(j.card).toMatchObject({ id: card.id, needs_owner: false });
    expect(j.note.body).toBe('Choose A, release');
    const show = JSON.parse((await kb(['show', id, '--json'])).stdout);
    expect(show.card.needs_owner).toBe(false);
    expect(show.notes.map((n: any) => n.body)).toContain('Choose A, release');

    // Answering without text clears only the flag.
    await kb(['ask', id, 'Follow-up question']);
    const notesBefore = JSON.parse((await kb(['show', id, '--json'])).stdout).notes.length;
    const bare = await kb(['answer', id, '--json']);
    expect(bare.code, bare.stderr).toBe(0);
    expect(JSON.parse(bare.stdout).card.needs_owner).toBe(false);
    expect(JSON.parse((await kb(['show', id, '--json'])).stdout).notes.length).toBe(notesBefore);
    const human = await kb(['answer', id]);
    expect(human.stdout).toContain(`#${id}`);
    expect((await kb(['answer'])).code).toBe(1);
  });

  it('set ask and blocked flags; reject invalid values', async () => {
    const card = JSON.parse((await kb(['add', 'Flag card', '-p', 'demo', '--json'])).stdout).card;
    const id = String(card.id);
    const askOn = JSON.parse((await kb(['set', id, 'ask=1', '--json'])).stdout).card;
    expect(askOn.needs_owner).toBe(true);
    const askOff = JSON.parse((await kb(['set', id, 'ask=0', '--json'])).stdout).card;
    expect(askOff.needs_owner).toBe(false);

    const blkOn = JSON.parse((await kb(['set', id, 'blocked=1', '--json'])).stdout).card;
    expect(blkOn.blocked).toBe(true);
    await kb(['block', id, 'Waiting on an external dependency']);
    const blkOff = JSON.parse((await kb(['set', id, 'blocked=0', '--json'])).stdout).card;
    expect(blkOff).toMatchObject({ blocked: false, blocked_reason: '' });

    const bad = await kb(['set', id, 'ask=yes']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('must be 0 or 1');
    expect((await kb(['set', id, 'blocked=2'])).code).toBe(1);
  });

  it('archives a card and restores it with --undo', async () => {
    const card = JSON.parse((await kb(['add', 'Card to archive', '-p', 'demo', '--json'])).stdout).card;
    const id = String(card.id);
    const ids = async () => JSON.parse((await kb(['ls', '-p', 'demo', '--json'])).stdout).map((c: any) => c.id);
    expect(await ids()).toContain(card.id);

    const arch = await kb(['archive', id, '--json']);
    expect(arch.code, arch.stderr).toBe(0);
    expect(JSON.parse(arch.stdout).card).toMatchObject({ id: card.id, archived: true });
    expect(await ids()).not.toContain(card.id);

    const undo = await kb(['archive', id, '--undo', '--json']);
    expect(undo.code, undo.stderr).toBe(0);
    expect(JSON.parse(undo.stdout).card).toMatchObject({ id: card.id, archived: false });
    expect(await ids()).toContain(card.id);

    expect((await kb(['archive', id])).stdout).toContain('archived');
    expect((await kb(['archive', id, '--undo'])).stdout).toContain('unarchived');
    expect((await kb(['archive', '99999'])).stderr).toContain('card_not_found');
  });

  it('creates and updates a project and rejects invalid input', async () => {
    const add = await kb(['project', 'add', 'kb-proj', 'KB Sample Project', '--color', '#5FCB8F', '--repo', '/tmp/kb-proj', '--url', 'https://kanban.example.com', '--desc', 'One sentence', '--json']);
    expect(add.code, add.stderr).toBe(0);
    expect(JSON.parse(add.stdout).project).toMatchObject({ id: 'kb-proj', name: 'KB Sample Project', color: '#5FCB8F', repo_path: '/tmp/kb-proj', url: 'https://kanban.example.com', description: 'One sentence', status: 'active' });
    const dup = await kb(['project', 'add', 'kb-proj', 'dup']);
    expect(dup.code).toBe(1);
    expect(dup.stderr).toContain('project_exists');
    expect((await kb(['project', 'add', 'Bad_ID', 'x'])).code).toBe(1);
    expect((await kb(['project', 'add', 'kb-p2', 'x', '--color', 'red'])).stderr).toContain('#RRGGBB');
    const set = await kb(['project', 'set', 'kb-proj', 'name=Renamed Project', 'color=#E8956A', 'repo=none', 'url=https://kanban.example.com/next', 'desc=Updated description', 'status=paused', '--json']);
    expect(set.code, set.stderr).toBe(0);
    expect(JSON.parse(set.stdout).project).toMatchObject({ name: 'Renamed Project', color: '#E8956A', repo_path: null, url: 'https://kanban.example.com/next', description: 'Updated description', status: 'paused' });
    expect((await kb(['project', 'set', 'kb-proj', 'status=weird'])).code).toBe(1);
    expect((await kb(['project', 'set', 'kb-proj', 'nope=1'])).stderr).toContain('Unsupported field');
    expect((await kb(['project', 'set', 'missing-proj', 'name=x'])).stderr).toContain('project_not_found');
    expect((await kb(['project'])).code).toBe(1);
    // Archived projects are hidden from overview but remain available through /projects.
    await kb(['project', 'set', 'kb-proj', 'status=archived']);
    const ov = JSON.parse((await kb(['projects', '--json'])).stdout);
    expect(ov.some((p: any) => p.id === 'kb-proj')).toBe(false);
    expect(t.store.requireProject('kb-proj').status).toBe('archived');
  });

  it('fills the card brief template and places -d text in its goal section', async () => {
    const plain = JSON.parse((await kb(['add', 'No template', '-p', 'demo', '--json'])).stdout).card;
    expect(plain.description).toBe('');
    const tpl = await kb(['add', 'With template', '-p', 'demo', '--template', '--json']);
    expect(tpl.code, tpl.stderr).toBe(0);
    expect(JSON.parse(tpl.stdout).card.description).toBe(CARD_BRIEF_TEMPLATE);
    const withGoal = JSON.parse((await kb(['add', 'With goal', '-p', 'demo', '--template', '-d', 'Help the next agent continue', '--json'])).stdout).card;
    expect(withGoal.description).toBe(CARD_BRIEF_TEMPLATE.replace('(One or two sentences: what should be achieved)', 'Help the next agent continue'));
    expect(withGoal.description).toContain('## Key decisions');
  });

  it('adds the handoff prefix once and keeps regular notes unchanged', async () => {
    const card = JSON.parse((await kb(['add', 'Handoff card', '-p', 'demo', '--json'])).stdout).card;
    const id = String(card.id);
    const h = await kb(['note', id, '--handoff', 'Completed A; next: B; key file: x.ts; open questions: none', '--json']);
    expect(h.code, h.stderr).toBe(0);
    expect(JSON.parse(h.stdout).note.body).toBe('[handoff] Completed A; next: B; key file: x.ts; open questions: none');
    const again = JSON.parse((await kb(['note', id, '--handoff', '[handoff] Existing prefix', '--json'])).stdout).note.body;
    expect(again).toBe('[handoff] Existing prefix');
    const plain = JSON.parse((await kb(['note', id, 'Regular', 'progress', '--json'])).stdout).note.body;
    expect(plain).toBe('Regular progress');
    const both = await kb(['note', id, 'extra', '--handoff', 'x']);
    expect(both.code).toBe(1);
    expect(both.stderr).toContain('--handoff');
    expect((await kb(['note', id, '--handoff', '   '])).code).toBe(1);
    expect((await kb(['note', id])).code).toBe(1);
    expect((await kb(['note', id, '--handoff'])).code).toBe(1); // Missing text.
    expect((await kb(['note', id, '--handoff', 'Done'])).stdout).toContain('handoff note');
  });

  it('prints the card brief, truncates normal output, and supports full and JSON modes', async () => {
    const desc = '## Goal\n' + 'x'.repeat(4500);
    const card = JSON.parse((await kb(['add', 'Brief card', '-p', 'demo', '-d', desc, '--json'])).stdout).card;
    const id = String(card.id);
    await kb(['note', id, '--handoff', 'Completed A; next: B']);
    await kb(['note', id, 'Regular progress update']);
    const b = await kb(['brief', id]);
    expect(b.code, b.stderr).toBe(0);
    expect(b.stdout).toContain(`# #${id} Brief card`);
    expect(b.stdout).toContain('Completed A; next: B');
    expect(b.stdout).toContain('Regular progress update');
    expect(b.stdout).toContain('truncated');
    expect([...b.stdout].length).toBeLessThanOrEqual(8000);
    const f = await kb(['brief', id, '--full']);
    expect(f.stdout).toContain('x'.repeat(4500));
    expect(f.stdout).not.toContain('truncated');
    const j = JSON.parse((await kb(['brief', id, '--json'])).stdout);
    expect(j.handoff_note.body).toContain('Completed A');
    expect(j.description.truncated).toBe(true);
    expect((await kb(['brief'])).code).toBe(1);
    expect((await kb(['brief', '99999'])).stderr).toContain('card_not_found');
    expect((await kb(['help'])).stdout).toMatch(/kb brief <id> \[--full\][\s\S]*--template[\s\S]*--handoff/);
  });

  it('reports invalid status, missing token, and API errors with a nonzero exit code', async () => {
    const bad = await kb(['mv', '1', 'nonsense']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('Unknown status');
    const nf = await kb(['show', '99999']);
    expect(nf.code).toBe(1);
    expect(nf.stderr).toContain('card_not_found');
    const noTok = path.join(t.dir, 'no-token.json');
    fs.writeFileSync(noTok, JSON.stringify({ url, tokens: {} }));
    const r = await kb(['ls'], { KB_CONFIG: noTok });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('token');
    const wrong = path.join(t.dir, 'wrong-token.json');
    fs.writeFileSync(wrong, JSON.stringify({ url, tokens: { codex: 'nope' } }));
    const r2 = await kb(['ls'], { KB_CONFIG: wrong });
    expect(r2.code).toBe(1);
    expect(r2.stderr).toContain('401');
  });

  it('detects actors in the documented precedence order', async () => {
    const actorFor = async (extra: string[], env: Record<string, string>) => {
      const r = await kb(['add', 'who', '-p', 'demo', '--json', ...extra], env);
      expect(r.code, r.stderr).toBe(0);
      const id = JSON.parse(r.stdout).card.id;
      return (await t.call('GET', `/api/v1/cards/${id}`, { token: 'claude' })).json.events[0].actor;
    };
    // Explicit selections take precedence.
    expect(await actorFor([], { KB_AGENT: 'codex' })).toBe('codex');
    expect(await actorFor(['--as', 'claude'], { KB_AGENT: 'codex', CODEX_THREAD_ID: 'x' })).toBe('claude');
    expect(await actorFor(['--as', 'codex'], { CLAUDECODE: '1' })).toBe('codex');
    expect(await actorFor([], { KB_AGENT: 'claude', CODEX_THREAD_ID: 'x' })).toBe('claude');
    // Codex markers take precedence over CLAUDECODE.
    expect(await actorFor([], { CODEX_THREAD_ID: 'thread-1' })).toBe('codex');
    expect(await actorFor([], { CODEX_SANDBOX: 'seatbelt' })).toBe('codex');
    expect(await actorFor([], { CODEX_SANDBOX_NETWORK_DISABLED: '1' })).toBe('codex');
    // A Codex subprocess may inherit CLAUDECODE.
    expect(await actorFor([], { CLAUDECODE: '1', CODEX_THREAD_ID: 'thread-1' })).toBe('codex');
    // CLAUDECODE selects Claude when no Codex marker is present.
    expect(await actorFor([], { CLAUDECODE: '1' })).toBe('claude');
    // The public-edition fallback actor is Codex.
    expect(await actorFor([], {})).toBe('codex');
    // Unsupported actor values are rejected.
    const bad = await kb(['ls'], { KB_AGENT: 'gemini' });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('accepts only codex or claude');
  });

  it('uses KB_URL to override the configured server URL', async () => {
    const f = path.join(t.dir, 'url-override.json');
    fs.writeFileSync(f, JSON.stringify({ url: 'http://localhost:1', tokens: TOKENS }));
    const r = await kb(['projects', '--json'], { KB_CONFIG: f, KB_URL: url });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).some((p: any) => p.id === 'demo')).toBe(true);
  });

  it('uses UTC by default and honors KANBAN_TIMEZONE', async () => {
    const card = JSON.parse((await kb(['add', 'Timezone card', '-p', 'demo', '--json'])).stdout).card;
    const timestamp = card.updated_at;
    const format = (timeZone: string) => new Intl.DateTimeFormat('en-US', {
      timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(timestamp)).replace(/\s+/g, ' ');
    const defaultOutput = await kb(['show', String(card.id)]);
    expect(defaultOutput.stdout).toContain(format('UTC'));
    const zonedOutput = await kb(['show', String(card.id)], { KANBAN_TIMEZONE: 'America/Los_Angeles' });
    expect(zonedOutput.stdout).toContain(format('America/Los_Angeles'));
  });
});

describe('kb comments, inbox, and replies', () => {
  let cookie: string;
  const ownerComment = async (cardId: number, body: string, target?: string) =>
    (await t.call('POST', `/api/v1/cards/${cardId}/comments`, { cookie, body: { body, ...(target ? { target } : {}) } })).json.comment;

  it('lists targeted open comments and supports filters, brief output, and replies', async () => {
    cookie = await t.login();
    t.store.createProject({ id: 'inb', name: 'Inbox Project' }, 'system');
    const card = t.store.createCard('inb', { title: 'Card to reply to' }, 'system');
    const forCodex = await ownerComment(card.id, 'Question for Codex\nSecond line');
    expect(forCodex.target).toBe('codex');
    const forClaude = await ownerComment(card.id, 'Question for Claude: ' + 'x'.repeat(120), 'claude');

    const codexInbox = JSON.parse((await kb(['inbox', '--as', 'codex', '--json'])).stdout);
    expect(codexInbox.map((i: any) => i.root.id)).toEqual([forCodex.id]);
    const claudeInbox = JSON.parse((await kb(['inbox', '--as', 'claude', '--json'])).stdout);
    expect(claudeInbox.map((i: any) => i.root.id)).toEqual([forClaude.id]);
    const all = JSON.parse((await kb(['inbox', '--all-targets', '-p', 'inb', '--json'])).stdout);
    expect(all.map((i: any) => i.root.id)).toEqual([forCodex.id, forClaude.id]);
    expect(JSON.parse((await kb(['inbox', '-p', 'demo', '--all-targets', '--json'])).stdout)).toEqual([]);

    const brief = await kb(['inbox', '--as', 'claude', '--brief']);
    const line = brief.stdout.trim();
    expect(line.startsWith(`#${card.id} Card to reply to | Comment ${forClaude.id} | Question for Claude:`)).toBe(true);
    expect([...line.split('|')[2].trim()].length).toBeLessThanOrEqual(83);
    expect(line.endsWith('...')).toBe(true);
    expect((await kb(['inbox', '--as', 'codex'])).stdout).toContain('Question for Codex');

    const list = await kb(['comments', String(card.id)]);
    expect(list.stdout).toContain('Question for Codex');
    expect(JSON.parse((await kb(['comments', String(card.id), '--json'])).stdout)).toHaveLength(2);
    expect((await kb(['comments', '99999'])).stderr).toContain('card_not_found');

    const rep = await kb(['reply', String(forCodex.id), 'Answer:', 'yes', '--as', 'codex', '--json']);
    expect(rep.code, rep.stderr).toBe(0);
    expect(JSON.parse(rep.stdout)).toMatchObject({ comment: { author: 'codex', body: 'Answer: yes' }, root: { status: 'answered' } });
    expect(JSON.parse((await kb(['inbox', '--as', 'codex', '--json'])).stdout)).toEqual([]);
    expect((await kb(['reply', String(forClaude.id), 'Done', '--as', 'claude'])).stdout).toContain('Replied to comment thread');
    expect((await kb(['reply', String(forClaude.id)])).code).toBe(1);
    expect((await kb(['reply', '99999', 'x'])).stderr).toContain('comment_not_found');
  });

  it('matches the longest repo_path prefix at path boundaries', async () => {
    cookie ||= await t.login();
    const base = path.join(t.dir, 'repos');
    t.store.createProject({ id: 'mono', name: 'Mono', repo_path: path.join(base, 'mono') }, 'system');
    t.store.createProject({ id: 'mono-sub', name: 'Mono Sub', repo_path: path.join(base, 'mono', 'packages', 'sub') }, 'system');
    const a = t.store.createCard('mono', { title: 'A' }, 'system');
    const b = t.store.createCard('mono-sub', { title: 'B' }, 'system');
    const ca = await ownerComment(a.id, 'for mono');
    const cb = await ownerComment(b.id, 'for sub');
    const ids = async (cwd: string) => JSON.parse((await kb(['inbox', '--cwd', cwd, '--json'])).stdout).map((i: any) => i.root.id);
    expect(await ids(path.join(base, 'mono'))).toEqual([ca.id]);
    expect(await ids(path.join(base, 'mono', 'src', 'deep'))).toEqual([ca.id]);
    expect(await ids(path.join(base, 'mono', 'packages', 'sub'))).toEqual([cb.id]); // Longest matching prefix.
    expect(await ids(path.join(base, 'mono', 'packages', 'sub', 'x'))).toEqual([cb.id]);
    expect(await ids(path.join(base, 'mono-other'))).toEqual([]); // Not a path-boundary match.
    expect(await ids('/nowhere')).toEqual([]);
    const none = await kb(['inbox', '--cwd', '/nowhere']);
    expect(none.code).toBe(0);
    expect((await kb(['inbox', '--cwd', '/nowhere', '--brief'])).stdout).toBe('');
  });
});
