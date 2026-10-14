import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestCtx } from './helpers/server.ts';

let t: TestCtx;
let cookie: string;
beforeEach(async () => {
  t = makeTestApp();
  cookie = await t.login();
});
afterEach(() => t.cleanup());

async function setup() {
  await t.call('POST', '/api/v1/projects', { token: 'claude', body: { id: 'proj-a', name: 'Project A', repo_path: '/tmp/proj-a' } });
  const r = await t.call('POST', '/api/v1/cards', { token: 'claude', body: { project_id: 'proj-a', title: 'First card' } });
  return r.json.card as { id: number };
}
const ownerComment = (cardId: number, body = 'Why was this approach used?', target = 'codex') =>
  t.call('POST', `/api/v1/cards/${cardId}/comments`, { cookie, body: { body, target } });

describe('Comment CRUD and status transitions', () => {
  it('owner starts open threads and any target defaults to codex', async () => {
    const card = await setup();
    const r = await ownerComment(card.id, 'hi', 'any');
    expect(r.status).toBe(201);
    expect(r.json.comment).toMatchObject({ parent_id: null, author: 'owner', target: 'codex', target_requested: 'any', status: 'open' });
    const c2 = await ownerComment(card.id, 'hi2', 'claude');
    expect(c2.json.comment).toMatchObject({ target: 'claude', target_requested: 'claude' });
    const list = await t.call('GET', `/api/v1/cards/${card.id}/comments`, { token: 'codex' });
    expect(list.json.threads.map((x: any) => x.root.id)).toEqual([r.json.comment.id, c2.json.comment.id]);
  });

  it('omitting a comment target selects codex by default', async () => {
    const card = await setup();
    const r = await t.call('POST', `/api/v1/cards/${card.id}/comments`, { cookie, body: { body: 'Please review' } });
    expect(r.status).toBe(201);
    expect(r.json.comment).toMatchObject({ target: 'codex', target_requested: 'codex' });
  });

  it('agents cannot start threads, WebMCP can, and invalid requests are rejected', async () => {
    const card = await setup();
    for (const token of ['claude', 'codex'] as const) {
      const r = await t.call('POST', `/api/v1/cards/${card.id}/comments`, { token, body: { body: 'x', target: 'codex' } });
      expect(r.status).toBe(403);
    }
    const w = await t.call('POST', `/api/v1/cards/${card.id}/comments`, { cookie, headers: { 'x-kanban-actor': 'webmcp' }, body: { body: 'x', target: 'claude' } });
    expect(w.status).toBe(201);
    expect(w.json.comment.author).toBe('webmcp');
    expect((await t.call('POST', `/api/v1/cards/${card.id}/comments`, { cookie, body: { body: '  ', target: 'codex' } })).status).toBe(400);
    expect((await t.call('POST', `/api/v1/cards/${card.id}/comments`, { cookie, body: { body: 'x', target: 'nobody' } })).status).toBe(400);
    expect((await t.call('POST', `/api/v1/cards/${card.id}/comments`, { cookie, body: { body: 'x'.repeat(20001), target: 'codex' } })).status).toBe(400);
    expect((await ownerComment(9999)).status).toBe(404);
  });

  it('agent replies answer threads and owner followups reopen them', async () => {
    const card = await setup();
    const root = (await ownerComment(card.id)).json.comment;
    const a = await t.call('POST', `/api/v1/comments/${root.id}/replies`, { token: 'codex', body: { body: 'Answer' } });
    expect(a.status).toBe(201);
    expect(a.json.comment).toMatchObject({ parent_id: root.id, author: 'codex', status: null, target: null });
    expect(a.json.root.status).toBe('answered');
    const f = await t.call('POST', `/api/v1/comments/${a.json.comment.id}/replies`, { cookie, body: { body: 'Followup' } });
    expect(f.json.comment.parent_id).toBe(root.id);
    expect(f.json.root.status).toBe('open');
    const detail = await t.call('GET', `/api/v1/cards/${card.id}/comments`, { cookie });
    expect(detail.json.threads[0].replies.map((r: any) => r.author)).toEqual(['codex', 'owner']);
    expect((await t.call('POST', '/api/v1/comments/9999/replies', { cookie, body: { body: 'x' } })).status).toBe(404);
  });

  it('only the owner resolves threads and reopening derives status from the latest author', async () => {
    const card = await setup();
    const root = (await ownerComment(card.id)).json.comment;
    expect((await t.call('POST', `/api/v1/comments/${root.id}/resolve`, { token: 'codex', body: { resolved: true } })).status).toBe(403);
    expect((await t.call('POST', `/api/v1/comments/${root.id}/resolve`, { token: 'claude', body: { resolved: false } })).status).toBe(403);
    expect((await t.call('POST', `/api/v1/comments/${root.id}/resolve`, { cookie, headers: { 'x-kanban-actor': 'webmcp' }, body: { resolved: true } })).status).toBe(403);
    await t.call('POST', `/api/v1/comments/${root.id}/replies`, { token: 'codex', body: { body: 'a' } });
    const res = await t.call('POST', `/api/v1/comments/${root.id}/resolve`, { cookie, body: { resolved: true } });
    expect(res.json.root).toMatchObject({ status: 'resolved' });
    expect(res.json.root.resolved_at).toBeTruthy();
    const re = await t.call('POST', `/api/v1/comments/${root.id}/resolve`, { cookie, body: { resolved: false } });
    expect(re.json.root).toMatchObject({ status: 'answered', resolved_at: null });
    await t.call('POST', `/api/v1/comments/${root.id}/resolve`, { cookie, body: { resolved: true } });
    const follow = await t.call('POST', `/api/v1/comments/${root.id}/replies`, { cookie, body: { body: 'Another question' } });
    expect(follow.json.root).toMatchObject({ status: 'open', resolved_at: null });
    
    const types1 = (await t.call('GET', '/api/v1/events?limit=100', { cookie })).json.events.length;
    await t.call('POST', `/api/v1/comments/${root.id}/resolve`, { cookie, body: { resolved: false } });
    expect((await t.call('GET', '/api/v1/events?limit=100', { cookie })).json.events.length).toBe(types1);
  });

  it('agent replies answer resolved threads', async () => {
    const card = await setup();
    const root = (await ownerComment(card.id)).json.comment;
    await t.call('POST', `/api/v1/comments/${root.id}/resolve`, { cookie, body: { resolved: true } });
    const r = await t.call('POST', `/api/v1/comments/${root.id}/replies`, { token: 'claude', body: { body: 'late' } });
    expect(r.json.root.status).toBe('answered');
  });
});

describe('Inbox, counts and overview', () => {
  it('inbox filters status, target, project and card with context', async () => {
    const card = await setup();
    await t.call('POST', '/api/v1/projects', { token: 'claude', body: { id: 'proj-b', name: 'B' } });
    const cardB = (await t.call('POST', '/api/v1/cards', { token: 'claude', body: { project_id: 'proj-b', title: 'Card B' } })).json.card;
    const c1 = (await ownerComment(card.id, 'one', 'codex')).json.comment;
    const c2 = (await ownerComment(card.id, 'two', 'claude')).json.comment;
    const c3 = (await ownerComment(cardB.id, 'three', 'codex')).json.comment;
    await t.call('POST', `/api/v1/comments/${c1.id}/replies`, { token: 'codex', body: { body: 'done' } });
    const ids = (r: any) => r.json.comments.map((x: any) => x.root.id);
    expect(ids(await t.call('GET', '/api/v1/comments', { token: 'codex' }))).toEqual([c2.id, c3.id]);
    expect(ids(await t.call('GET', '/api/v1/comments?target=codex', { token: 'codex' }))).toEqual([c3.id]);
    expect(ids(await t.call('GET', '/api/v1/comments?status=answered', { token: 'codex' }))).toEqual([c1.id]);
    expect(ids(await t.call('GET', '/api/v1/comments?status=all', { token: 'codex' }))).toEqual([c1.id, c2.id, c3.id]);
    expect(ids(await t.call('GET', '/api/v1/comments?project=proj-b', { token: 'codex' }))).toEqual([c3.id]);
    expect(ids(await t.call('GET', `/api/v1/comments?card_id=${card.id}&status=all`, { token: 'codex' }))).toEqual([c1.id, c2.id]);
    expect((await t.call('GET', '/api/v1/comments?status=bogus', { token: 'codex' })).status).toBe(400);
    const first = (await t.call('GET', '/api/v1/comments?status=all&limit=1', { token: 'codex' })).json.comments[0];
    expect(first.card).toMatchObject({ id: card.id, title: 'First card', project_id: 'proj-a' });
    expect(first.project).toMatchObject({ id: 'proj-a', name: 'Project A', repo_path: '/tmp/proj-a' });
    expect(first.replies).toHaveLength(1);
    
    await t.call('POST', `/api/v1/cards/${cardB.id}/archive`, { token: 'claude' });
    expect(ids(await t.call('GET', '/api/v1/comments', { token: 'codex' }))).toEqual([c2.id]);
  });

  it('open comment counts follow thread state across API views', async () => {
    const card = await setup();
    const get = async () => (await t.call('GET', `/api/v1/cards/${card.id}`, { cookie })).json;
    expect((await get()).card.open_comments).toBe(0);
    const c1 = (await ownerComment(card.id)).json.comment;
    await ownerComment(card.id, 'again', 'claude');
    expect((await get()).card.open_comments).toBe(2);
    expect((await t.call('GET', '/api/v1/cards', { cookie })).json.cards[0].open_comments).toBe(2);
    let ov = (await t.call('GET', '/api/v1/overview', { cookie })).json;
    expect(ov.open_comments).toHaveLength(2);
    expect(ov.open_comments[0]).toMatchObject({ root: { id: c1.id }, card: { id: card.id }, project: { id: 'proj-a' } });
    expect(ov.totals.open_comments).toBe(2);
    await t.call('POST', `/api/v1/comments/${c1.id}/replies`, { token: 'codex', body: { body: 'ok' } });
    expect((await get()).card.open_comments).toBe(1);
    ov = (await t.call('GET', '/api/v1/overview', { cookie })).json;
    expect(ov.open_comments).toHaveLength(1);
    const detail = await get();
    expect(detail.comments).toHaveLength(2);
    expect(detail.comments[0].replies).toHaveLength(1);
  });

  it('overview caps comments and writes refresh card activity', async () => {
    const card = await setup();
    const before = (await t.call('GET', `/api/v1/cards/${card.id}`, { cookie })).json.card.updated_at;
    t.clock.t += 1000;
    for (let i = 0; i < 22; i++) await ownerComment(card.id, `q${i}`);
    const ov = (await t.call('GET', '/api/v1/overview', { cookie })).json;
    expect(ov.open_comments).toHaveLength(20);
    expect(ov.totals.open_comments).toBe(22);
    expect((await t.call('GET', `/api/v1/cards/${card.id}`, { cookie })).json.card.updated_at).not.toBe(before);
  });
});

describe('Events and SSE', () => {
  it('comment lifecycle events include payloads and broadcast', async () => {
    const card = await setup();
    const chunks: string[] = [];
    const off = t.hub.add((c) => chunks.push(c));
    const root = (await ownerComment(card.id, 'x'.repeat(300))).json.comment;
    await t.call('POST', `/api/v1/comments/${root.id}/replies`, { token: 'codex', body: { body: 'Reply body' } });
    await t.call('POST', `/api/v1/comments/${root.id}/resolve`, { cookie, body: { resolved: true } });
    await t.call('POST', `/api/v1/comments/${root.id}/resolve`, { cookie, body: { resolved: false } });
    off();
    const evs = (await t.call('GET', `/api/v1/cards/${card.id}`, { cookie })).json.events as any[];
    const types = evs.map((e) => e.type).reverse().filter((x) => x.startsWith('comment.'));
    expect(types).toEqual(['comment.created', 'comment.replied', 'comment.resolved', 'comment.reopened']);
    const created = evs.find((e) => e.type === 'comment.created');
    expect(created).toMatchObject({ actor: 'owner' });
    expect(created.payload).toMatchObject({ comment_id: root.id, root_id: root.id, target: 'codex', author: 'owner' });
    expect(created.payload.body).toHaveLength(200);
    const replied = evs.find((e) => e.type === 'comment.replied');
    expect(replied).toMatchObject({ actor: 'codex', card_id: card.id });
    expect(replied.payload).toMatchObject({ root_id: root.id, author: 'codex', body: 'Reply body' });
    const sse = chunks.join('');
    for (const ty of ['comment.created', 'comment.replied', 'comment.resolved', 'comment.reopened']) expect(sse).toContain(`"type":"${ty}"`);
    
    expect(sse).toContain('"open_comments"');
  });

  it('owner replies to resolved threads emit reply and reopen events', async () => {
    const card = await setup();
    const root = (await ownerComment(card.id)).json.comment;
    await t.call('POST', `/api/v1/comments/${root.id}/resolve`, { cookie, body: { resolved: true } });
    await t.call('POST', `/api/v1/comments/${root.id}/replies`, { cookie, body: { body: 'Followup' } });
    const types = (await t.call('GET', `/api/v1/cards/${card.id}`, { cookie })).json.events.map((e: any) => e.type);
    expect(types.slice(0, 2)).toEqual(['comment.reopened', 'comment.replied']);
  });
});

describe('Fresh comment schema', () => {
  it('fresh schema includes comments in its single migration', async () => {
    const rows = t.db.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(['0001_init.sql']);
  });
});
