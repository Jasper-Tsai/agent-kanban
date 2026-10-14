import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestApp, PASSWORD, TOKENS, type TestCtx } from './helpers/server.ts';
import { runBackup, listBackups } from '../server/backup.ts';
import { nextLocalTime } from '../server/time.ts';

let t: TestCtx;
beforeEach(() => {
  t = makeTestApp();
});
afterEach(() => t.cleanup());

async function mkProject(id = 'proj-a', token: 'claude' | 'codex' = 'claude') {
  const r = await t.call('POST', '/api/v1/projects', { token, body: { id, name: `Project ${id}` } });
  expect(r.status).toBe(201);
  return r.json.project;
}
async function mkCard(project_id: string, title: string, extra: Record<string, unknown> = {}, token: 'claude' | 'codex' = 'claude') {
  const r = await t.call('POST', '/api/v1/cards', { token, body: { project_id, title, ...extra } });
  expect(r.status).toBe(201);
  return r.json.card;
}

describe('Authentication', () => {
  it('health is public and protected API routes require authentication', async () => {
    const h = await t.call('GET', '/api/v1/health');
    expect(h.status).toBe(200);
    expect(h.json).toMatchObject({ ok: true, db: 'ok' });
    for (const p of ['/api/v1/cards', '/api/v1/overview', '/api/v1/projects', '/api/v1/events', '/api/v1/stream']) {
      const r = await t.call('GET', p);
      expect(r.status, p).toBe(401);
      expect(r.json.error.code).toBe('unauthorized');
    }
  });

  it('password login sets secure session cookies and rejects invalid passwords', async () => {
    const bad = await t.app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'kanban' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    expect(bad.status).toBe(401);
    const res = await t.app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'kanban' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    const sc = res.headers.get('set-cookie')!;
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/Secure/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    expect(sc).toMatch(/Path=\//);
    expect(sc).toMatch(/Max-Age=34560000/); 
    const cookie = sc.split(';')[0];
    const me = await t.call('GET', '/api/v1/auth/me', { cookie });
    expect(me.json).toEqual({ ok: true, actor: 'owner' });
  });

  it('tampered session cookies are rejected', async () => {
    const cookie = await t.login();
    const tampered = cookie.slice(0, -3) + 'abc';
    expect((await t.call('GET', '/api/v1/cards', { cookie: tampered })).status).toBe(401);
  });

  it('login rate limiting expires after fifteen minutes', async () => {
    const attempt = (pw: string) =>
      t.app.request('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'kanban' },
        body: JSON.stringify({ password: pw }),
      });
    for (let i = 0; i < 5; i++) expect((await attempt('x' + i)).status).toBe(401);
    const blocked = await attempt(PASSWORD); 
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    t.clock.t += 15 * 60 * 1000 + 1000;
    expect((await attempt(PASSWORD)).status).toBe(200);
  });

  it('API tokens determine actors and invalid tokens are rejected', async () => {
    await mkProject();
    const c1 = await mkCard('proj-a', 'by claude', {}, 'claude');
    const c2 = await mkCard('proj-a', 'by codex', {}, 'codex');
    const ev = await t.call('GET', '/api/v1/events', { token: 'claude' });
    const byCard = (id: number) => ev.json.events.find((e: any) => e.card_id === id && e.type === 'card.created');
    expect(byCard(c1.id).actor).toBe('claude');
    expect(byCard(c2.id).actor).toBe('codex');
    const bad = await t.call('GET', '/api/v1/cards', { headers: { authorization: 'Bearer nope' } });
    expect(bad.status).toBe(401);
    
    const forged = await t.call('POST', '/api/v1/cards', { token: 'claude', headers: { 'x-kanban-actor': 'webmcp' }, body: { project_id: 'proj-a', title: 'forged' } });
    expect(forged.status).toBe(201);
    const ev2 = await t.call('GET', '/api/v1/events?limit=1', { token: 'claude' });
    expect(ev2.json.events[0].actor).toBe('claude');
  });

  it('cookie writes require CSRF protection while token writes do not', async () => {
    await mkProject();
    const cookie = await t.login();
    const body = JSON.stringify({ project_id: 'proj-a', title: 'csrf' });
    const base = { 'content-type': 'application/json', cookie };
    const r1 = await t.app.request('/api/v1/cards', { method: 'POST', headers: base, body });
    expect(r1.status).toBe(403);
    const r2 = await t.app.request('/api/v1/cards', { method: 'POST', headers: { ...base, 'x-requested-with': 'kanban' }, body });
    expect(r2.status).toBe(201);
    const r3 = await t.app.request('http://kanban.test/api/v1/cards', { method: 'POST', headers: { ...base, host: 'kanban.test', origin: 'http://kanban.test' }, body });
    expect(r3.status).toBe(201);
    const r4 = await t.app.request('http://kanban.test/api/v1/cards', { method: 'POST', headers: { ...base, host: 'kanban.test', origin: 'http://evil.example' }, body });
    expect(r4.status).toBe(403);
    
    const g = await t.app.request('/api/v1/cards', { headers: { cookie } });
    expect(g.status).toBe(200);
  });

  it('WebMCP actor overrides require cookie authentication', async () => {
    await mkProject();
    const cookie = await t.login();
    const r = await t.call('POST', '/api/v1/cards', { cookie, headers: { 'x-kanban-actor': 'webmcp' }, body: { project_id: 'proj-a', title: 'via webmcp' } });
    expect(r.status).toBe(201);
    const ev = await t.call('GET', '/api/v1/events?limit=1', { cookie });
    expect(ev.json.events[0]).toMatchObject({ actor: 'webmcp', type: 'card.created' });
    const r2 = await t.call('POST', '/api/v1/cards', { cookie, headers: { 'x-kanban-actor': 'codex' }, body: { project_id: 'proj-a', title: 'spoof' } });
    expect(r2.status).toBe(400);
    const r3 = await t.call('POST', '/api/v1/cards', { cookie, body: { project_id: 'proj-a', title: 'plain' } });
    expect(r3.status).toBe(201);
    const ev3 = await t.call('GET', '/api/v1/events?limit=1', { cookie });
    expect(ev3.json.events[0].actor).toBe('owner');
  });

  it('responses include security headers', async () => {
    const r = await t.call('GET', '/api/v1/health');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(r.headers.get('content-security-policy')).not.toContain('unsafe-inline');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBe('same-origin');
  });
});

describe('Project and card CRUD', () => {
  it('project creation validates slugs and updates handoffs', async () => {
    const p1 = await mkProject('alpha');
    const p2 = await mkProject('beta');
    expect(p1.color).not.toBe(p2.color);
    expect((await t.call('POST', '/api/v1/projects', { token: 'claude', body: { id: 'Bad_ID', name: 'x' } })).status).toBe(400);
    expect((await t.call('POST', '/api/v1/projects', { token: 'claude', body: { id: 'alpha', name: 'dup' } })).status).toBe(409);
    const patched = await t.call('PATCH', '/api/v1/projects/alpha', { token: 'codex', body: { handoff: '## Next steps\nDo X' } });
    expect(patched.json.project.handoff).toContain('Next steps');
    const ev = await t.call('GET', '/api/v1/events?project=alpha', { token: 'claude' });
    expect(ev.json.events[0]).toMatchObject({ type: 'project.updated', actor: 'codex' });
    expect(ev.json.events[0].payload.changes.handoff.to).toContain('Do X');
    expect((await t.call('PATCH', '/api/v1/projects/nope', { token: 'claude', body: { name: 'x' } })).status).toBe(404);
  });

  it('card defaults, validation, notes, events and update diffs', async () => {
    await mkProject();
    const card = await mkCard('proj-a', '  First card  ');
    expect(card).toMatchObject({ title: 'First card', status: 'todo', agent: 'none', priority: 'p2', blocked: false, needs_owner: false, tags: [], archived: false });
    expect((await t.call('POST', '/api/v1/cards', { token: 'claude', body: { project_id: 'proj-a', title: '' } })).status).toBe(400);
    expect((await t.call('POST', '/api/v1/cards', { token: 'claude', body: { project_id: 'proj-a', title: 'x'.repeat(201) } })).status).toBe(400);
    expect((await t.call('POST', '/api/v1/cards', { token: 'claude', body: { project_id: 'nope', title: 'x' } })).status).toBe(404);
    expect((await t.call('POST', '/api/v1/cards', { token: 'claude', body: { project_id: 'proj-a', title: 'x', due_date: '2026-02-31' } })).status).toBe(400);
    expect((await t.call('POST', '/api/v1/cards', { token: 'claude', body: { project_id: 'proj-a', title: 'x', priority: 'p9' } })).status).toBe(400);

    const upd = await t.call('PATCH', `/api/v1/cards/${card.id}`, { token: 'codex', body: { agent: 'codex', priority: 'p0', blocked: true, blocked_reason: 'Waiting for design', tags: ['a', 'b'], branch: 'feat/x' } });
    expect(upd.status).toBe(200);
    expect(upd.json.card).toMatchObject({ agent: 'codex', priority: 'p0', blocked: true, blocked_reason: 'Waiting for design', tags: ['a', 'b'], branch: 'feat/x' });

    const note = await t.call('POST', `/api/v1/cards/${card.id}/notes`, { token: 'codex', body: { body: 'Completed some work' } });
    expect(note.status).toBe(201);
    const detail = await t.call('GET', `/api/v1/cards/${card.id}`, { token: 'claude' });
    expect(detail.json.notes).toHaveLength(1);
    expect(detail.json.notes[0]).toMatchObject({ actor: 'codex', body: 'Completed some work' });
    const types = detail.json.events.map((e: any) => e.type);
    expect(types).toEqual(['note.added', 'card.updated', 'card.created']);
    const updated = detail.json.events.find((e: any) => e.type === 'card.updated');
    expect(updated.payload.changes.priority).toEqual({ from: 'p2', to: 'p0' });
    expect(updated.payload.changes.agent).toEqual({ from: 'none', to: 'codex' });
    expect((await t.call('GET', '/api/v1/cards/9999', { token: 'claude' })).status).toBe(404);
    expect((await t.call('POST', `/api/v1/cards/${card.id}/notes`, { token: 'claude', body: { body: '  ' } })).status).toBe(400);
  });

  it('no-op updates preserve timestamps and event history', async () => {
    await mkProject();
    const card = await mkCard('proj-a', 'same');
    t.clock.t += 3600e3;
    const r = await t.call('PATCH', `/api/v1/cards/${card.id}`, { token: 'claude', body: { title: 'same', priority: 'p2' } });
    expect(r.json.card.updated_at).toBe(card.updated_at);
    const d = await t.call('GET', `/api/v1/cards/${card.id}`, { token: 'claude' });
    expect(d.json.events).toHaveLength(1);
  });

  it('card filters select matching cards', async () => {
    await mkProject('p1');
    await mkProject('p2');
    const a = await mkCard('p1', 'alpha task', { agent: 'claude', tags: ['infra'], branch: 'feat/alpha' });
    const b = await mkCard('p2', 'beta task', { status: 'review', needs_owner: true });
    const c = await mkCard('p2', 'gamma', { blocked: true, blocked_reason: 'x', status: 'in_progress', agent: 'codex' });
    const q = async (qs: string) => (await t.call('GET', `/api/v1/cards?${qs}`, { token: 'claude' })).json.cards.map((x: any) => x.id).sort();
    expect(await q('project=p1')).toEqual([a.id]);
    expect(await q('status=review')).toEqual([b.id]);
    expect(await q('agent=codex')).toEqual([c.id]);
    expect(await q('blocked=1')).toEqual([c.id]);
    expect(await q('needs_owner=true')).toEqual([b.id]);
    expect(await q('q=ALPHA')).toEqual([a.id]);
    expect(await q('q=feat/alpha')).toEqual([a.id]);
    expect(await q('tag=infra')).toEqual([a.id]);
    expect(await q('q=%25')).toEqual([]); 
    t.clock.t += 1000;
    await t.call('PATCH', `/api/v1/cards/${c.id}`, { token: 'claude', body: { title: 'gamma2' } });
    expect(await q(`updated_since=${encodeURIComponent(new Date(t.clock.t - 500).toISOString())}`)).toEqual([c.id]);
    await t.call('POST', `/api/v1/cards/${a.id}/archive`, { token: 'claude', body: {} });
    expect(await q('')).toEqual([b.id, c.id].sort());
    expect(await q('include_archived=1')).toEqual([a.id, b.id, c.id].sort());
    expect((await t.call('GET', '/api/v1/cards?status=bogus', { token: 'claude' })).status).toBe(400);
  });

  it('archiving and restoring emit card events', async () => {
    await mkProject();
    const card = await mkCard('proj-a', 'to archive');
    const r = await t.call('POST', `/api/v1/cards/${card.id}/archive`, { token: 'claude' });
    expect(r.json.card.archived).toBe(true);
    const r2 = await t.call('POST', `/api/v1/cards/${card.id}/archive`, { token: 'claude', body: { archived: false } });
    expect(r2.json.card.archived).toBe(false);
    const d = await t.call('GET', `/api/v1/cards/${card.id}`, { token: 'claude' });
    const arch = d.json.events.filter((e: any) => e.type === 'card.archived');
    expect(arch.map((e: any) => e.payload.archived)).toEqual([false, true]);
  });
});

describe('Movement and positions', () => {
  async function setup() {
    await mkProject();
    const a = await mkCard('proj-a', 'A', { status: 'todo' });
    const b = await mkCard('proj-a', 'B', { status: 'todo' });
    const c = await mkCard('proj-a', 'C', { status: 'todo' });
    return { a, b, c };
  }
  const order = async (status: string) =>
    (await t.call('GET', `/api/v1/cards?status=${status}`, { token: 'claude' })).json.cards.map((x: any) => x.title);

  it('new cards are appended to their column', async () => {
    const { a, b, c } = await setup();
    expect(b.position).toBeGreaterThan(a.position);
    expect(c.position).toBeGreaterThan(b.position);
  });

  it('moving without neighbors appends and emits a movement event', async () => {
    const { a, b } = await setup();
    t.clock.t += 5000;
    const r = await t.call('POST', `/api/v1/cards/${a.id}/move`, { token: 'codex', body: { status: 'review' } });
    expect(r.status).toBe(200);
    expect(r.json.card.status).toBe('review');
    expect(r.json.card.status_changed_at).toBe(new Date(t.clock.t).toISOString());
    const r2 = await t.call('POST', `/api/v1/cards/${b.id}/move`, { token: 'codex', body: { status: 'review' } });
    expect(r2.json.card.position).toBeGreaterThan(r.json.card.position);
    expect(await order('review')).toEqual(['A', 'B']);
    const ev = await t.call('GET', `/api/v1/cards/${a.id}`, { token: 'claude' });
    expect(ev.json.events[0]).toMatchObject({ type: 'card.moved', actor: 'codex', payload: { from: 'todo', to: 'review' } });
  });

  it('neighbor positions determine insertion order', async () => {
    const { a, b, c } = await setup();
    
    await t.call('POST', `/api/v1/cards/${c.id}/move`, { token: 'claude', body: { status: 'todo', before_id: a.id } });
    expect(await order('todo')).toEqual(['C', 'A', 'B']);
    
    await t.call('POST', `/api/v1/cards/${c.id}/move`, { token: 'claude', body: { status: 'todo', after_id: a.id } });
    expect(await order('todo')).toEqual(['A', 'C', 'B']);
    const cards = (await t.call('GET', '/api/v1/cards?status=todo', { token: 'claude' })).json.cards;
    const pos = Object.fromEntries(cards.map((x: any) => [x.title, x.position]));
    expect(pos.C).toBeCloseTo((pos.A + pos.B) / 2);
    
    await t.call('POST', `/api/v1/cards/${a.id}/move`, { token: 'claude', body: { status: 'todo', after_id: b.id } });
    expect(await order('todo')).toEqual(['C', 'B', 'A']);
    
    await t.call('POST', `/api/v1/cards/${a.id}/move`, { token: 'claude', body: { status: 'todo', after_id: c.id, before_id: b.id } });
    expect(await order('todo')).toEqual(['C', 'A', 'B']);
  });

  it('cross-column movement validates neighbors and same-column reorder emits no movement event', async () => {
    const { a, b } = await setup();
    const x = await mkCard('proj-a', 'X', { status: 'review' });
    await t.call('POST', `/api/v1/cards/${a.id}/move`, { token: 'claude', body: { status: 'review', before_id: x.id } });
    expect(await order('review')).toEqual(['A', 'X']);
    const bad = await t.call('POST', `/api/v1/cards/${b.id}/move`, { token: 'claude', body: { status: 'done', before_id: x.id } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('invalid_neighbor');
    const self = await t.call('POST', `/api/v1/cards/${b.id}/move`, { token: 'claude', body: { status: 'todo', before_id: b.id } });
    expect(self.status).toBe(400);
    const before = (await t.call('GET', `/api/v1/cards/${x.id}`, { token: 'claude' })).json.events.length;
    await t.call('POST', `/api/v1/cards/${x.id}/move`, { token: 'claude', body: { status: 'review', before_id: a.id } });
    expect((await t.call('GET', `/api/v1/cards/${x.id}`, { token: 'claude' })).json.events.length).toBe(before);
    expect(await order('review')).toEqual(['X', 'A']);
  });

  it('exhausted position gaps renumber the column without changing order', async () => {
    await mkProject();
    const a = await mkCard('proj-a', 'A');
    const z = await mkCard('proj-a', 'Z');
    
    let last = z;
    for (let i = 0; i < 45; i++) {
      const n = await mkCard('proj-a', `n${i}`, { status: 'backlog' });
      await t.call('POST', `/api/v1/cards/${n.id}/move`, { token: 'claude', body: { status: 'todo', after_id: a.id } });
      last = n;
    }
    const cards = (await t.call('GET', '/api/v1/cards?status=todo', { token: 'claude' })).json.cards;
    expect(cards[0].title).toBe('A');
    expect(cards[1].title).toBe('n44');
    expect(cards.at(-1).title).toBe('Z');
    const ps = cards.map((c: any) => c.position);
    expect([...ps].sort((x: number, y: number) => x - y)).toEqual(ps);
    expect(new Set(ps).size).toBe(ps.length);
    expect(last).toBeTruthy();
  });

  it('status patches use movement semantics', async () => {
    const { a } = await setup();
    t.clock.t += 1000;
    const r = await t.call('PATCH', `/api/v1/cards/${a.id}`, { token: 'claude', body: { status: 'in_progress' } });
    expect(r.json.card.status_changed_at).toBe(new Date(t.clock.t).toISOString());
    const d = await t.call('GET', `/api/v1/cards/${a.id}`, { token: 'claude' });
    expect(d.json.events.map((e: any) => e.type)).toEqual(['card.moved', 'card.created']);
    const both = await t.call('PATCH', `/api/v1/cards/${a.id}`, { token: 'claude', body: { status: 'review', agent: 'claude' } });
    expect(both.status).toBe(200);
    const d2 = await t.call('GET', `/api/v1/cards/${a.id}`, { token: 'claude' });
    expect(d2.json.events.slice(0, 2).map((e: any) => e.type).sort()).toEqual(['card.moved', 'card.updated']);
  });
});

describe('Staleness, age and overview', () => {
  it('staleness uses status thresholds and notes refresh activity', async () => {
    await mkProject();
    const ip = await mkCard('proj-a', 'ip', { status: 'in_progress' });
    const td = await mkCard('proj-a', 'td', { status: 'todo' });
    const rv = await mkCard('proj-a', 'rv', { status: 'review' });
    const bl = await mkCard('proj-a', 'bl', { status: 'backlog' });
    const dn = await mkCard('proj-a', 'dn', { status: 'done' });
    const get = async () => Object.fromEntries((await t.call('GET', '/api/v1/cards', { token: 'claude' })).json.cards.map((c: any) => [c.title, c]));
    t.clock.t += 23 * 3600e3;
    let c = await get();
    expect([c.ip.stale, c.td.stale, c.rv.stale]).toEqual([false, false, false]);
    t.clock.t += 2 * 3600e3; // 25h
    c = await get();
    expect([c.ip.stale, c.td.stale, c.rv.stale]).toEqual([true, false, false]);
    expect(c.ip.age_days).toBeCloseTo(25 / 24, 1);
    t.clock.t += 24 * 3600e3; // 49h
    c = await get();
    expect([c.ip.stale, c.td.stale, c.rv.stale, c.bl.stale, c.dn.stale]).toEqual([true, true, true, false, false]);
    await t.call('POST', `/api/v1/cards/${ip.id}/notes`, { token: 'claude', body: { body: 'still alive' } });
    c = await get();
    expect(c.ip.stale).toBe(false);
    expect(td.id).toBeTruthy();
    expect(rv.id).toBeTruthy();
    expect(bl.id).toBeTruthy();
    expect(dn.id).toBeTruthy();
  });

  it('overview counts statuses, flags and agents', async () => {
    await mkProject('p1');
    await mkProject('p2');
    await mkCard('p1', 'a', { status: 'in_progress', agent: 'claude' });
    await mkCard('p1', 'b', { status: 'review', needs_owner: true, priority: 'p0' });
    await mkCard('p2', 'c', { status: 'todo', blocked: true, blocked_reason: 'r' });
    await mkCard('p2', 'd', { status: 'done', blocked: true });
    const e = await mkCard('p2', 'e', { status: 'todo', needs_owner: true });
    await t.call('POST', `/api/v1/cards/${e.id}/archive`, { token: 'claude' });
    const r = await t.call('GET', '/api/v1/overview', { token: 'claude' });
    const p1 = r.json.projects.find((p: any) => p.id === 'p1');
    expect(p1.counts).toEqual({ backlog: 0, todo: 0, in_progress: 1, review: 1, done: 0 });
    expect(p1.agents.claude).toBe(1);
    expect(p1.needs_owner).toBe(1);
    expect(r.json.focus.map((c: any) => c.title)).toEqual(['b', 'c']);
    expect(r.json.totals).toMatchObject({ needs_owner: 1, blocked: 1 });
    
    t.clock.t += 80 * 3600e3;
    const r2 = await t.call('GET', '/api/v1/overview', { token: 'claude' });
    expect(r2.json.projects.find((p: any) => p.id === 'p2').stale).toBe(true);
    expect(r2.json.projects.find((p: any) => p.id === 'p2').stale_for_hours).toBeGreaterThanOrEqual(80);
  });
});

describe('Events API', () => {
  it('event filtering and pagination', async () => {
    await mkProject('p1');
    await mkProject('p2');
    for (let i = 0; i < 5; i++) await mkCard('p1', `c${i}`, {}, i % 2 ? 'codex' : 'claude');
    await mkCard('p2', 'other', {}, 'codex');
    const page1 = await t.call('GET', '/api/v1/events?limit=3', { token: 'claude' });
    expect(page1.json.events).toHaveLength(3);
    expect(page1.json.next_before).toBe(page1.json.events[2].id);
    const page2 = await t.call('GET', `/api/v1/events?limit=3&before=${page1.json.next_before}`, { token: 'claude' });
    expect(page2.json.events[0].id).toBeLessThan(page1.json.events[2].id);
    const codex = await t.call('GET', '/api/v1/events?actor=codex&project=p1', { token: 'claude' });
    expect(codex.json.events.every((e: any) => e.actor === 'codex' && e.project_id === 'p1')).toBe(true);
    expect(codex.json.events).toHaveLength(2);
  });
});

describe('SSE', () => {
  it('writes broadcast and streams send keepalive messages', async () => {
    t.cleanup();
    t = makeTestApp();
    const handle = (await import('../server/app.ts')).createApp({ config: t.config, db: t.db, pingMs: 30 });
    await mkProject();
    const res = await handle.app.request('/api/v1/stream', { headers: { authorization: `Bearer ${TOKENS.claude}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const readUntil = async (re: RegExp) => {
      const deadline = Date.now() + 3000;
      while (!re.test(buf) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
      }
      return re.test(buf);
    };
    expect(await readUntil(/event: ready/)).toBe(true);
    handle.store.createCard('proj-a', { title: 'live' }, 'codex');
    expect(await readUntil(/event: kanban[\s\S]*"type":"card\.created"/)).toBe(true);
    expect(buf).toContain('"actor":"codex"');
    expect(await readUntil(/: ping/)).toBe(true);
    await reader.cancel();
  });
});

describe('WebMCP discovery and SPA', () => {
  it('public discovery exposes tool metadata without data', async () => {
    const r = await t.call('GET', '/.well-known/webmcp');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(r.json.tools).toHaveLength(14);
    const names = r.json.tools.map((x: any) => x.name);
    expect(names).toEqual([
      'kanban_get_overview', 'kanban_list_cards', 'kanban_get_card', 'kanban_get_view', 'kanban_create_card',
      'kanban_update_card', 'kanban_move_card', 'kanban_add_note', 'kanban_archive_card', 'kanban_update_project_handoff', 'kanban_navigate',
      'kanban_list_comments', 'kanban_add_comment', 'kanban_reply_comment',
    ]);
    for (const tool of r.json.tools) {
      expect(Object.keys(tool).sort()).toEqual(['annotations', 'description', 'inputSchema', 'name']);
      expect(tool.inputSchema.type).toBe('object');
    }
    const ro = r.json.tools.filter((x: any) => x.annotations.readOnlyHint).map((x: any) => x.name);
    expect(ro).toEqual(['kanban_get_overview', 'kanban_list_cards', 'kanban_get_card', 'kanban_get_view', 'kanban_list_comments']);
    expect(r.json.tools.find((x: any) => x.name === 'kanban_archive_card').annotations.consequentialHint).toBe(true);
    expect(JSON.stringify(r.json)).not.toMatch(/proj-a|scrypt|kbt_/);
  });

  it('malformed static paths return 400 and unbuilt frontend returns 404', async () => {
    for (const p of ['/%E0%A4%A', '/%', '/foo/%zz', '/assets/%E0%A4%A.js']) {
      const r = await t.call('GET', p);
      expect(r.status, p).toBe(400);
    }
    expect((await t.call('GET', '/board')).status).toBe(404); 
  });

  it('unknown API paths return JSON 404', async () => {
    const r = await t.call('GET', '/api/v1/nope', { token: 'claude' });
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('not_found');
  });
});

describe('Demo seed import', () => {
  it('seed imports only into empty databases and preserves ordering and system events', async () => {
    t.cleanup();
    t = makeTestApp({ seed: true });
    const seed = JSON.parse(fs.readFileSync(path.resolve('server/seed/seed.json'), 'utf8'));
    const nCards = seed.projects.reduce((n: number, p: any) => n + p.cards.length, 0);
    const projects = (await t.call('GET', '/api/v1/projects', { token: 'claude' })).json.projects;
    expect(projects).toHaveLength(seed.projects.length);
    expect(projects.map((p: any) => p.id)).toEqual(seed.projects.map((p: any) => p.id));
    const cards = (await t.call('GET', '/api/v1/cards', { token: 'claude' })).json.cards;
    expect(cards).toHaveLength(nCards);
    for (const status of ['backlog', 'todo', 'in_progress', 'review', 'done']) {
      const ps = cards.filter((c: any) => c.status === status).map((c: any) => c.position);
      expect(new Set(ps).size).toBe(ps.length);
      expect(ps).toEqual([...ps].sort((a, b) => a - b));
    }
    const ev = (await t.call('GET', '/api/v1/events?limit=200', { token: 'claude' })).json.events;
    expect(ev.length).toBe(seed.projects.length + nCards);
    expect(ev.every((e: any) => e.actor === 'system')).toBe(true);
    const decision = cards.find((c: any) => c.title === 'Choose the API versioning policy');
    expect(decision).toMatchObject({ needs_owner: true, priority: 'p2' });
    expect(projects.map((p: any) => p.id)).toEqual(['demo-api', 'demo-web', 'docs-site']);
    
    const { createApp } = await import('../server/app.ts');
    const again = createApp({ config: t.config, db: t.db });
    expect(again.store.listProjects()).toHaveLength(seed.projects.length);
  });
});

describe('Migrations', () => {
  it('checksum mismatches and missing migration files reject startup', async () => {
    const mdir = fs.mkdtempSync(path.join(t.dir, 'mig-'));
    for (const f of fs.readdirSync('server/migrations')) fs.copyFileSync(path.join('server/migrations', f), path.join(mdir, f));
    const dir = fs.mkdtempSync(path.join(t.dir, 'db-'));
    const first = makeTestApp({ dir, migrationsDir: mdir });
    first.close();
    
    fs.appendFileSync(path.join(mdir, '0001_init.sql'), '\n-- tampered\n');
    expect(() => makeTestApp({ dir, migrationsDir: mdir })).toThrow(/checksum mismatch.*0001_init\.sql/);
    
    fs.copyFileSync('server/migrations/0001_init.sql', path.join(mdir, '0001_init.sql'));
    fs.writeFileSync(path.join(mdir, '0003_extra.sql'), 'CREATE TABLE extra_t (id INTEGER);');
    const again = makeTestApp({ dir, migrationsDir: mdir });
    const names = again.db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map((r: any) => r.name);
    expect(names).toEqual(['0001_init.sql', '0003_extra.sql']);
    again.close();
    fs.rmSync(path.join(mdir, '0003_extra.sql'));
    expect(() => makeTestApp({ dir, migrationsDir: mdir })).toThrow(/missing/);
  });
});

describe('Backups', () => {
  it('backup snapshots use configured dates and retain fourteen files', async () => {
    await mkProject();
    await mkCard('proj-a', 'backup me');
    const dir = path.join(t.dir, 'backups');
    const base = Date.parse('2026-09-01T00:00:00Z');
    for (let i = 0; i < 17; i++) runBackup(t.db, dir, new Date(base + i * 86400e3));
    const files = listBackups(dir);
    expect(files).toHaveLength(14);
    expect(files[0]).toBe('kanban-20260904.db');
    expect(files.at(-1)).toBe('kanban-20260917.db');
    
    const r = runBackup(t.db, dir, new Date('2026-09-17T16:30:00Z'));
    expect(path.basename(r.file)).toBe('kanban-20260917.db');
    const { DatabaseSync } = await import('node:sqlite');
    const copy = new DatabaseSync(r.file, { readOnly: true });
    expect((copy.prepare('SELECT COUNT(*) c FROM cards').get() as any).c).toBe(1);
    copy.close();
  });

  it('next scheduled UTC backup is at 03:40', () => {
    
    expect(new Date(nextLocalTime(new Date('2026-10-03T00:00:00Z'), 3, 40)).toISOString()).toBe('2026-10-03T03:40:00.000Z');
    
    expect(new Date(nextLocalTime(new Date('2026-10-02T18:00:00Z'), 3, 40)).toISOString()).toBe('2026-10-03T03:40:00.000Z');
  });
});
