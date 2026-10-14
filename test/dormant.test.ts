import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestCtx } from './helpers/server.ts';

let t: TestCtx;
let cookie: string;
beforeEach(async () => {
  t = makeTestApp();
  cookie = await t.login();
});
afterEach(() => t.cleanup());

const J = (method: string, url: string, body?: unknown) => t.call(method, url, { cookie, body });
const W = (method: string, url: string, body?: unknown) => t.call(method, url, { cookie, body, headers: { 'x-kanban-actor': 'webmcp' } });
const A = (method: string, url: string, body?: unknown) => t.call(method, url, { token: 'claude', body });
const proj = async (id: string) => (await t.call('GET', '/api/v1/projects', { cookie })).json.projects.find((p: any) => p.id === id);
const mkProject = (id: string) => t.call('POST', '/api/v1/projects', { token: 'claude', body: { id, name: `Project ${id}` } });
const mkCard = async (project_id: string, status: string, extra: Record<string, unknown> = {}) =>
  (await t.call('POST', '/api/v1/cards', { token: 'claude', body: { project_id, title: `Card ${status}`, status, ...extra } })).json.card as { id: number };

describe("Owner completion resolves outstanding work", () => {
  async function reviewCardWithThreads() {
    await mkProject('p1');
    const card = await mkCard('p1', 'review', { needs_owner: true });
    const r1 = (await J('POST', `/api/v1/cards/${card.id}/comments`, { body: 'q1', target: 'codex' })).json.comment;
    const r2 = (await J('POST', `/api/v1/cards/${card.id}/comments`, { body: 'q2', target: 'claude' })).json.comment;
    await A('POST', `/api/v1/comments/${r2.id}/replies`, { body: 'a2' }); // r2 → answered
    const r3 = (await J('POST', `/api/v1/cards/${card.id}/comments`, { body: 'q3', target: 'codex' })).json.comment;
    await J('POST', `/api/v1/comments/${r3.id}/resolve`, { resolved: true });
    return { card, roots: [r1, r2, r3] };
  }
  const threads = async (id: number) => (await J('GET', `/api/v1/cards/${id}/comments`)).json.threads.map((x: any) => x.root.status);

  it("PATCH owner completion clears needs_owner and resolves open or answered threads", async () => {
    const { card } = await reviewCardWithThreads();
    const r = await J('PATCH', `/api/v1/cards/${card.id}`, { status: 'done' });
    expect(r.json.card).toMatchObject({ status: 'done', needs_owner: false, open_comments: 0 });
    expect(await threads(card.id)).toEqual(['resolved', 'resolved', 'resolved']);
    const ev = (await J('GET', `/api/v1/events?limit=50`)).json.events;
    const auto = ev.filter((e: any) => e.type === 'comment.resolved' && e.payload.auto === true);
    expect(auto).toHaveLength(2); 
    expect(auto.every((e: any) => e.actor === 'owner')).toBe(true);
    expect(ev.some((e: any) => e.type === 'card.moved' && e.payload.to === 'done')).toBe(true);
    const det = (await J('GET', `/api/v1/cards/${card.id}`)).json.comments.map((x: any) => x.root.resolved_at);
    expect(det.every(Boolean)).toBe(true);
  });

  it("POST move owner completion resolves threads and broadcasts events", async () => {
    const { card } = await reviewCardWithThreads();
    const seen: string[] = [];
    t.hub.add((chunk) => seen.push(chunk));
    const r = await J('POST', `/api/v1/cards/${card.id}/move`, { status: 'done' });
    expect(r.json.card).toMatchObject({ status: 'done', needs_owner: false });
    expect(await threads(card.id)).toEqual(['resolved', 'resolved', 'resolved']);
    expect(seen.join('').match(/comment\.resolved/g)?.length).toBe(2);
  });

  it("Completion overrides simultaneous needs_owner:true", async () => {
    const { card } = await reviewCardWithThreads();
    const r = await J('PATCH', `/api/v1/cards/${card.id}`, { status: 'done', needs_owner: true });
    expect(r.json.card.needs_owner).toBe(false);
  });

  it("Agent tokens and webmcp completion do not resolve threads", async () => {
    for (const via of ['claude', 'webmcp'] as const) {
      const { card } = await reviewCardWithThreads();
      const move = via === 'claude' ? A : W;
      const r = await move('POST', `/api/v1/cards/${card.id}/move`, { status: 'done' });
      expect(r.json.card).toMatchObject({ status: 'done', needs_owner: true });
      expect(await threads(card.id)).toEqual(['open', 'answered', 'resolved']);
      const r2 = await move('PATCH', `/api/v1/cards/${card.id}`, { status: 'in_progress' });
      expect(r2.status).toBe(200);
      const r3 = await move('PATCH', `/api/v1/cards/${card.id}`, { status: 'done' });
      expect(r3.json.card.needs_owner).toBe(true);
      expect(await threads(card.id)).toEqual(['open', 'answered', 'resolved']);
    }
  });

  it("Same-column sorting and unfinished moves do not resolve threads", async () => {
    await mkProject('p1');
    const card = await mkCard('p1', 'review', { needs_owner: true });
    await J('POST', `/api/v1/cards/${card.id}/move`, { status: 'in_progress' });
    expect((await J('GET', `/api/v1/cards/${card.id}`)).json.card.needs_owner).toBe(true);
  });
});

describe("Derived dormant state", () => {
  it("Empty and completed projects are dormant; unfinished cards reactivate them", async () => {
    await mkProject('p1');
    expect(await proj('p1')).toMatchObject({ dormant: true });
    expect((await proj('p1')).dormant_since).toBeTruthy();
    const c = await mkCard('p1', 'review');
    expect(await proj('p1')).toMatchObject({ dormant: false, dormant_since: null });
    await J('POST', `/api/v1/cards/${c.id}/move`, { status: 'done' });
    expect(await proj('p1')).toMatchObject({ dormant: true });
    await mkCard('p1', 'backlog');
    expect((await proj('p1')).dormant).toBe(false);
  });

  it("Every unfinished status keeps the project active", async () => {
    for (const st of ['backlog', 'todo', 'in_progress', 'review']) {
      await mkProject(`s-${st.replace('_', '')}`);
      await mkCard(`s-${st.replace('_', '')}`, st);
      expect((await proj(`s-${st.replace('_', '')}`)).dormant).toBe(false);
    }
  });

  it("Open comments reactivate completed projects; agent replies restore dormancy", async () => {
    await mkProject('p1');
    const c = await mkCard('p1', 'done');
    expect((await proj('p1')).dormant).toBe(true);
    const root = (await J('POST', `/api/v1/cards/${c.id}/comments`, { body: 'x', target: 'codex' })).json.comment;
    expect((await proj('p1')).dormant).toBe(false);
    await A('POST', `/api/v1/comments/${root.id}/replies`, { body: 'ok' });
    expect((await proj('p1')).dormant).toBe(true);
    await J('POST', `/api/v1/comments/${root.id}/replies`, { body: "Follow up" });
    expect((await proj('p1')).dormant).toBe(false);
  });

  it("Archived cards and their comments do not affect dormancy", async () => {
    await mkProject('p1');
    const c = await mkCard('p1', 'todo');
    expect((await proj('p1')).dormant).toBe(false);
    await J('POST', `/api/v1/cards/${c.id}/archive`);
    expect((await proj('p1')).dormant).toBe(true);
    const d = await mkCard('p1', 'done');
    await J('POST', `/api/v1/cards/${d.id}/comments`, { body: 'x', target: 'codex' });
    expect((await proj('p1')).dormant).toBe(false);
    await J('POST', `/api/v1/cards/${d.id}/archive`);
    expect((await proj('p1')).dormant).toBe(true);
  });

  it("Dormancy is independent of project status; overview includes review backlog", async () => {
    await mkProject('p1');
    await mkProject('p2');
    await mkProject('p3');
    await J('PATCH', '/api/v1/projects/p2', { status: 'paused' });
    await J('PATCH', '/api/v1/projects/p3', { status: 'archived' });
    const c = await mkCard('p1', 'review');
    t.clock.t += 49 * 3600e3;
    await mkCard('p1', 'review'); 
    const ov = (await J('GET', '/api/v1/overview')).json;
    const byId = Object.fromEntries(ov.projects.map((p: any) => [p.id, p]));
    expect(byId.p1).toMatchObject({ dormant: false, review_overdue: 1 });
    expect(byId.p2).toMatchObject({ dormant: true, status: 'paused', review_overdue: 0 });
    expect(byId.p3).toBeUndefined();
    expect((await proj('p3')).dormant).toBe(true);
    void c;
  });

  it("Dormant timestamp uses the latest project event", async () => {
    await mkProject('p1');
    const c = await mkCard('p1', 'review');
    t.clock.t += 3600e3;
    await J('POST', `/api/v1/cards/${c.id}/move`, { status: 'done' });
    const p = await proj('p1');
    expect(p.dormant_since).toBe(new Date(t.clock.t).toISOString());
  });

  it("include_dormant defaults to true; false excludes dormant cards", async () => {
    await mkProject('act');
    await mkProject('dor');
    await mkCard('act', 'todo');
    await mkCard('dor', 'done');
    const all = (await J('GET', '/api/v1/cards')).json.cards;
    expect(all.map((c: any) => c.project_id).sort()).toEqual(['act', 'dor']);
    expect((await t.call('GET', '/api/v1/cards?include_dormant=true', { token: 'codex' })).json.cards).toHaveLength(2);
    const some = (await J('GET', '/api/v1/cards?include_dormant=false')).json.cards;
    expect(some.map((c: any) => c.project_id)).toEqual(['act']);
    expect((await J('GET', '/api/v1/cards?include_dormant=maybe')).status).toBe(400);
  });
});

describe('§14.4 GET /search', () => {
  it("Search title, description, branch, tags, comments, and IDs; archived excluded", async () => {
    await mkProject('act');
    await mkProject('dor');
    const a = await mkCard('act', 'todo', { title: "Alpha feature", description: 'needle-in-desc' });
    const b = await mkCard('dor', 'done', { title: "Old card", branch: 'feat/zeta-branch', tags: ['legacy-tag'] });
    const c = await mkCard('dor', 'done', { title: "Another card" });
    await J('POST', `/api/v1/cards/${c.id}/comments`, { body: "Comment contains unique-word", target: 'codex' });
    const s = async (q: string, extra = '') => (await J('GET', `/api/v1/search?q=${encodeURIComponent(q)}${extra}`)).json;
    expect((await s('alpha')).cards.map((x: any) => [x.id, x.match])).toEqual([[a.id, 'title']]);
    expect((await s('needle')).cards[0]).toMatchObject({ id: a.id, match: 'description' });
    expect((await s('zeta')).cards[0]).toMatchObject({ id: b.id, match: 'branch' });
    expect((await s('legacy')).cards[0]).toMatchObject({ id: b.id, match: 'tag' });
    expect((await s('unique-word')).cards[0]).toMatchObject({ id: c.id, match: 'comment' });
    expect((await s(`#${a.id}`)).cards[0]).toMatchObject({ id: a.id, match: 'id' });
    const byProject = await s("Project dor");
    expect(byProject.projects.map((p: any) => p.id)).toEqual(['dor']);
    expect(byProject.projects[0].dormant).toBe(false); 
    
    await J('POST', `/api/v1/cards/${a.id}/archive`);
    expect((await s('alpha')).cards).toEqual([]);
    expect((await s('alpha', '&include_archived=1')).cards.map((x: any) => x.id)).toEqual([a.id]);
    
    expect(await s('')).toMatchObject({ cards: [], projects: [], truncated: false });
    expect((await s('%')).cards).toEqual([]);
  });

  it("Search caps at 50 results and requires authentication", async () => {
    await mkProject('act');
    for (let i = 0; i < 53; i++) await mkCard('act', 'todo', { title: `bulk ${i}` });
    const r = await t.call('GET', '/api/v1/search?q=bulk', { token: 'codex' });
    expect(r.status).toBe(200);
    expect(r.json.cards).toHaveLength(50);
    expect(r.json.truncated).toBe(true);
    expect((await t.call('GET', '/api/v1/search?q=bulk')).status).toBe(401);
  });
});

describe("SSE broadcasts include project dormancy", () => {
  it("Card updates broadcast dormancy; approval completes the project", async () => {
    await mkProject('p1');
    const c = await mkCard('p1', 'review');
    const seen: any[] = [];
    t.hub.add((chunk) => {
      const m = /data: (.*)\n/.exec(chunk);
      if (m) seen.push(JSON.parse(m[1]));
    });
    await J('POST', `/api/v1/cards/${c.id}/move`, { status: 'done' });
    const withCards = seen.filter((b) => b.cards?.length);
    expect(withCards.at(-1).project).toMatchObject({ id: 'p1', dormant: true });
    await mkCard('p1', 'todo');
    expect(seen.filter((b) => b.cards?.length).at(-1).project).toMatchObject({ id: 'p1', dormant: false, dormant_since: null });
  });
});
