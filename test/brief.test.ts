import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CARD_BRIEF_TEMPLATE } from '../shared/constants.ts';
import { BRIEF_LIMITS, SESSION_LIMITS, projectForCwd } from '../server/brief.ts';
import { makeTestApp, type TestCtx } from './helpers/server.ts';

let t: TestCtx;
let cookie: string;
beforeEach(async () => { t = makeTestApp(); cookie = await t.login(); });
afterEach(() => t.cleanup());

const len = (s: string) => Array.from(s).length;
const brief = async (id: number, full = false, token: 'claude' | 'codex' = 'claude') => {
  const r = await t.call('GET', `/api/v1/cards/${id}/brief${full ? '?full=1' : ''}`, { token });
  expect(r.status).toBe(200);
  return r.json;
};
const session = (cwds: string[], agent = 'codex', token: 'claude' | 'codex' = 'codex') =>
  t.call('GET', `/api/v1/session-brief?${new URLSearchParams([['agent', agent], ...cwds.map((c) => ['cwd', c])])}`, { token });
const mkProject = (id: string, repo: string | null = `/work/${id}`, extra: Record<string, unknown> = {}) =>
  t.store.createProject({ id, name: `Project ${id}`, repo_path: repo, ...extra } as any, 'system');
const comment = (cardId: number, body: string, target = 'codex') => t.call('POST', `/api/v1/cards/${cardId}/comments`, { cookie, body: { body, target } });

describe('Task brief template', () => {
  it('shared and CLI templates contain the same five sections', () => {
    for (const h of ['## Goal', '## Scope', '## Acceptance', '## Related files and documents', '## Key decisions']) expect(CARD_BRIEF_TEMPLATE).toContain(h);
    const src = fs.readFileSync('cli/kb.mjs', 'utf8');
    const m = /const CARD_BRIEF_TEMPLATE = `([\s\S]*?)`;/.exec(src);
    expect(m?.[1]).toBe(CARD_BRIEF_TEMPLATE);
  });
});

describe('GET /cards/:id/brief', () => {
  it('brief contains card fields, description and project handoff', async () => {
    mkProject('p1', '/work/p1', { handoff: 'Project-level handoff' });
    const card = t.store.createCard('p1', { title: 'A card', description: CARD_BRIEF_TEMPLATE, branch: 'feat/x', agent: 'claude', priority: 'p1' }, 'claude');
    const b = await brief(card.id);
    expect(b.card).toMatchObject({ id: card.id, title: 'A card', status: 'todo', agent: 'claude', priority: 'p1', branch: 'feat/x', blocked: false, needs_owner: false, project_id: 'p1' });
    expect(b.description).toMatchObject({ text: CARD_BRIEF_TEMPLATE, truncated: false });
    expect(b.handoff_note).toBeNull();
    expect(b.recent_notes).toEqual([]);
    expect(b.project_handoff).toMatchObject({ text: 'Project-level handoff', truncated: false });
    expect(b.truncated).toBe(false);
    expect(b.text).toContain('# #' + card.id + ' A card');
    expect(b.text).toContain('## Goal');
    expect(b.text).toContain('Project-level handoff');
  });

  it('blocked and owner-decision flags appear in structured and rendered briefs', async () => {
    mkProject('p1');
    const card = t.store.createCard('p1', { title: 'x' }, 'claude');
    t.store.updateCard(card.id, { blocked: true, blocked_reason: 'Waiting for API key', needs_owner: true }, 'claude');
    const b = await brief(card.id);
    expect(b.card).toMatchObject({ blocked: true, blocked_reason: 'Waiting for API key', needs_owner: true });
    expect(b.text).toContain('Blocked: Waiting for API key');
    expect(b.text).toContain('Awaiting owner decision');
  });

  it('long descriptions are truncated unless full output is requested', async () => {
    mkProject('p1');
    const desc = 'x'.repeat(BRIEF_LIMITS.description + 500);
    const card = t.store.createCard('p1', { title: 'x', description: desc }, 'claude');
    const b = await brief(card.id);
    expect(len(b.description.text)).toBe(BRIEF_LIMITS.description);
    expect(b.description).toMatchObject({ truncated: true, total_chars: desc.length });
    expect(b.truncated).toBe(true);
    expect(b.text).toContain(`of ${desc.length} characters`);
    const f = await brief(card.id, true);
    expect(f.full).toBe(true);
    expect(f.description.text).toBe(desc);
    expect(f.description.truncated).toBe(false);
    expect(f.truncated).toBe(false);
  });

  it('latest handoff is selected and other recent notes do not duplicate it', async () => {
    mkProject('p1');
    const card = t.store.createCard('p1', { title: 'x' }, 'claude');
    const add = (body: string, actor: 'claude' | 'codex' = 'claude') => t.store.addNote(card.id, body, actor).note;
    add('Old progress 1');
    add('[handoff] First handoff');
    add('Progress 2');
    const second = add('  [Handoff] Second handoff: Next step B', 'codex');
    add('Progress 3');
    add('Progress 4');
    add('Progress 5');
    const b = await brief(card.id);
    expect(b.handoff_note).toMatchObject({ id: second.id, actor: 'codex' });
    expect(b.handoff_note.body).toContain('Second handoff');
    expect(b.recent_notes.map((n: any) => n.body)).toEqual(['Progress 3', 'Progress 4', 'Progress 5']);
    expect(b.text).toContain('Latest handoff note');
    expect(b.text).toContain('Second handoff: Next step B');
    expect(b.text).not.toContain('First handoff');
    expect(b.truncated).toBe(true); 
    
    const last = add('[handoff] Closing handoff');
    const b2 = await brief(card.id);
    expect(b2.handoff_note.id).toBe(last.id);
    expect(b2.recent_notes.map((n: any) => n.id)).not.toContain(last.id);
    expect(b2.recent_notes.map((n: any) => n.body)).toEqual(['Progress 3', 'Progress 4', 'Progress 5']);
    
    const f = await brief(card.id, true);
    expect(f.recent_notes).toHaveLength(7);
  });

  it('brief without a handoff includes the latest three notes', async () => {
    mkProject('p1');
    const card = t.store.createCard('p1', { title: 'x' }, 'claude');
    for (let i = 1; i <= 5; i++) t.store.addNote(card.id, `n${i}`, 'claude');
    const b = await brief(card.id);
    expect(b.handoff_note).toBeNull();
    expect(b.recent_notes.map((n: any) => n.body)).toEqual(['n3', 'n4', 'n5']);
  });

  it('notes, comments and project handoffs have independent limits', async () => {
    mkProject('p1', '/work/p1', { handoff: 'H'.repeat(BRIEF_LIMITS.projectHandoff + 200) });
    const card = t.store.createCard('p1', { title: 'x' }, 'claude');
    t.store.addNote(card.id, '[handoff] ' + 'a'.repeat(BRIEF_LIMITS.handoffNote + 300), 'claude');
    t.store.addNote(card.id, 'b'.repeat(BRIEF_LIMITS.otherNote + 100), 'claude');
    await comment(card.id, 'c'.repeat(BRIEF_LIMITS.commentRoot + 100));
    const b = await brief(card.id);
    expect(len(b.handoff_note.body)).toBe(BRIEF_LIMITS.handoffNote);
    expect(b.handoff_note.truncated).toBe(true);
    expect(len(b.recent_notes[0].body)).toBe(BRIEF_LIMITS.otherNote);
    expect(len(b.open_comments.threads[0].body)).toBe(BRIEF_LIMITS.commentRoot);
    expect(len(b.project_handoff.text)).toBe(BRIEF_LIMITS.projectHandoff);
    expect(b.project_handoff.truncated).toBe(true);
    const f = await brief(card.id, true);
    expect(len(f.project_handoff.text)).toBe(BRIEF_LIMITS.projectHandoff + 200);
    expect(len(f.handoff_note.body)).toBe(len('[handoff] ') + BRIEF_LIMITS.handoffNote + 300);
    expect(len(f.open_comments.threads[0].body)).toBe(BRIEF_LIMITS.commentRoot + 100);
  });

  it('brief includes up to five open threads and full mode includes all', async () => {
    mkProject('p1');
    const card = t.store.createCard('p1', { title: 'x' }, 'claude');
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) ids.push((await comment(card.id, `Question ${i}`)).json.comment.id);
    await t.call('POST', `/api/v1/comments/${ids[0]}/replies`, { token: 'codex', body: { body: 'Answered' } }); // → answered
    const b = await brief(card.id);
    expect(b.open_comments.total).toBe(6);
    expect(b.open_comments.threads).toHaveLength(BRIEF_LIMITS.commentThreads);
    expect(b.open_comments.threads.map((x: any) => x.id)).toEqual(ids.slice(1, 6));
    expect(b.text).toContain('6 threads; showing first 5 threads');
    expect(b.truncated).toBe(true);
    const f = await brief(card.id, true);
    expect(f.open_comments.threads).toHaveLength(6);
  });

  it('combined brief respects its character budget and preserves handoff content', async () => {
    mkProject('p1', '/work/p1', { handoff: 'H'.repeat(5000) });
    const card = t.store.createCard('p1', { title: 'T'.repeat(150), description: 'D'.repeat(9000), branch: 'b'.repeat(80) }, 'claude');
    t.store.addNote(card.id, '[handoff] ' + 'a'.repeat(3000), 'claude');
    for (let i = 0; i < 5; i++) t.store.addNote(card.id, `n${i}` + 'b'.repeat(2000), 'claude');
    for (let i = 0; i < 8; i++) {
      await comment(card.id, 'c'.repeat(800));
    }
    const b = await brief(card.id);
    expect(len(b.text)).toBeLessThanOrEqual(BRIEF_LIMITS.total);
    expect(b.description.truncated).toBe(true);
    expect(len(b.description.text)).toBeGreaterThanOrEqual(BRIEF_LIMITS.descriptionFloor);
    expect(b.text).toContain('a'.repeat(100)); 
    const f = await brief(card.id, true);
    expect(len(f.text)).toBeGreaterThan(BRIEF_LIMITS.total);
    expect(f.truncated).toBe(false);
  });

  it('brief validates IDs, full query and authentication', async () => {
    expect((await t.call('GET', '/api/v1/cards/99999/brief', { token: 'claude' })).status).toBe(404);
    expect((await t.call('GET', '/api/v1/cards/abc/brief', { token: 'claude' })).status).toBe(400);
    mkProject('p1');
    const card = t.store.createCard('p1', { title: 'x' }, 'claude');
    expect((await t.call('GET', `/api/v1/cards/${card.id}/brief?full=maybe`, { token: 'claude' })).status).toBe(400);
    expect((await t.call('GET', `/api/v1/cards/${card.id}/brief`)).status).toBe(401);
    expect((await t.call('GET', `/api/v1/cards/${card.id}/brief`, { cookie })).status).toBe(200); 
  });
});

describe('Longest project path matching', () => {
  const ps = [
    { id: 'a', repo_path: '/work/app' },
    { id: 'b', repo_path: '/work/app/packages/web' },
    { id: 'c', repo_path: '/work/app-two' },
    { id: 'd', repo_path: null },
    { id: 'e', repo_path: '/', status: 'active' },
    { id: 'f', repo_path: '/work/old', status: 'archived' },
    { id: 'g', repo_path: '/work/trail/' },
  ];
  const id = (cwds: string[]) => projectForCwd(ps, cwds)?.id ?? null;
  it('nested projects use the longest path with boundary normalization', () => {
    expect(id(['/work/app'])).toBe('a');
    expect(id(['/work/app/src/deep'])).toBe('a');
    expect(id(['/work/app/packages/web/src'])).toBe('b');
    expect(id(['/work/app-two/x'])).toBe('c');
    expect(id(['/work/app-tw'])).toBeNull();
    expect(id(['/work/apple'])).toBeNull();
    expect(id(['/work/trail/x'])).toBe('g');
    expect(id(['/work/app/packages/../src'])).toBe('a');
  });
  it('unrelated, relative, archived and root paths do not match', () => {
    expect(id(['/elsewhere'])).toBeNull();
    expect(id(['work/app'])).toBeNull();
    expect(id(['/work/old/x'])).toBeNull();
    expect(id([''])).toBeNull();
  });
  it('multiple working directory candidates use the longest match', () => {
    expect(id(['/private/x', '/work/app/packages/web'])).toBe('b');
    expect(id(['/work/app', '/work/app-two'])).toBe('c');
  });
});

describe('GET /session-brief', () => {
  it('unmatched working directories return empty text', async () => {
    mkProject('p1', '/work/p1');
    const r = await session(['/somewhere/else']);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ text: '' });
    const noRepo = await session(['/work/p10']);
    expect(noRepo.json).toEqual({ text: '' });
  });

  it('nested working directories match the deepest project', async () => {
    const a = mkProject('mono', '/work/mono', { handoff: 'Outer handoff' });
    const b = mkProject('mono-web', '/work/mono/web', { handoff: 'Inner handoff' });
    t.store.createCard(a.id, { title: 'Outer active card', status: 'in_progress' }, 'claude');
    t.store.createCard(b.id, { title: 'Inner active card', status: 'in_progress' }, 'claude');
    const outer = (await session(['/work/mono/docs'])).json;
    expect(outer.project.id).toBe('mono');
    expect(outer.text).toContain('Outer handoff');
    expect(outer.text).not.toContain('Inner');
    const inner = (await session(['/work/mono/web/src'])).json;
    expect(inner.project.id).toBe('mono-web');
    expect(inner.text).toContain('Inner active card');
    expect(inner.text).not.toContain('Outer active card');
  });

  it('session brief limits handoffs and active cards while prioritizing handoff notes', async () => {
    mkProject('p1', '/work/p1', { handoff: 'P'.repeat(400) });
    const c1 = t.store.createCard('p1', { title: 'T'.repeat(100), status: 'in_progress', agent: 'codex' }, 'claude');
    t.store.addNote(c1.id, '[handoff] ' + 'h'.repeat(200), 'claude');
    t.store.addNote(c1.id, 'Newer ordinary progress', 'claude');
    const c2 = t.store.createCard('p1', { title: 'Review card', status: 'review' }, 'claude');
    t.store.addNote(c2.id, 'Only ordinary note ' + 'n'.repeat(200), 'claude');
    t.store.createCard('p1', { title: 'Not started', status: 'todo' }, 'claude');
    t.store.createCard('p1', { title: 'Backlog card', status: 'backlog' }, 'claude');
    const r = (await session(['/work/p1/src'])).json;
    expect(len(r.project_handoff)).toBe(SESSION_LIMITS.projectHandoff);
    const byId = Object.fromEntries(r.cards.map((c: any) => [c.id, c]));
    expect(Object.keys(byId).map(Number).sort()).toEqual([c1.id, c2.id].sort());
    expect(len(byId[c1.id].title)).toBeLessThanOrEqual(SESSION_LIMITS.cardTitle + 1);
    expect(byId[c1.id].note).toMatch(/^Handoff: h+…$/); 
    expect(len(byId[c1.id].note)).toBeLessThanOrEqual(len('Handoff: ') + SESSION_LIMITS.cardNote + 1);
    expect(byId[c2.id].note).toMatch(/^Latest: Only ordinary note n+…$/);
    expect(r.text).not.toContain('Not started');
    expect(r.text).not.toContain('Backlog card');
    expect(r.text).toContain('kb brief');
    expect(r.text).toContain('Project Project p1 (p1)');
  });

  it('up to five cards prioritize the selected agent', async () => {
    mkProject('p1', '/work/p1');
    for (let i = 0; i < 6; i++) t.store.createCard('p1', { title: `Other ${i}`, status: 'in_progress', agent: 'claude' }, 'claude');
    const mine = t.store.createCard('p1', { title: 'My card', status: 'review', agent: 'codex' }, 'claude');
    const r = (await session(['/work/p1'], 'codex')).json;
    expect(r.cards).toHaveLength(SESSION_LIMITS.cards);
    expect(r.cards[0].id).toBe(mine.id);
    expect(r.text).toContain('7 cards; showing 5');
  });

  it('inbox comments are filtered by agent and capped at five', async () => {
    mkProject('p1', '/work/p1');
    const card = t.store.createCard('p1', { title: 'Card with questions', status: 'in_progress' }, 'claude');
    for (let i = 0; i < 7; i++) await comment(card.id, `Question for codex ${i} ` + 'y'.repeat(120), 'codex');
    await comment(card.id, 'Only for claude', 'claude');
    const cx = (await session(['/work/p1'], 'codex')).json;
    expect(cx.comments).toHaveLength(SESSION_LIMITS.comments);
    expect(cx.comments[0]).toMatchObject({ card_id: card.id });
    expect(len(cx.comments[0].excerpt)).toBeLessThanOrEqual(SESSION_LIMITS.commentExcerpt + 1);
    expect(cx.text).toContain('targeted to Codex; total 7 comments');
    expect(cx.text).not.toContain('Only for claude');
    const cl = (await session(['/work/p1'], 'claude', 'claude')).json;
    expect(cl.comments).toHaveLength(1);
    expect(cl.text).toContain('Only for claude');
    expect(cl.text).toContain('targeted to Claude; total 1 comments');
  });

  it('answered comments no longer appear in session context', async () => {
    mkProject('p1', '/work/p1');
    const card = t.store.createCard('p1', { title: 'x' }, 'claude');
    const a = (await comment(card.id, 'Answered question')).json.comment;
    await t.call('POST', `/api/v1/comments/${a.id}/replies`, { token: 'codex', body: { body: 'Answer' } });
    const r = (await session(['/work/p1'])).json;
    expect(r.comments).toEqual([]);
    expect(r.text).toBe('');
  });

  it('empty session context retains project metadata', async () => {
    mkProject('p1', '/work/p1');
    t.store.createCard('p1', { title: 'Just todo' }, 'claude');
    const r = (await session(['/work/p1'])).json;
    expect(r.text).toBe('');
    expect(r.project).toEqual({ id: 'p1', name: 'Project p1' });
  });

  it('session output obeys its total character limit and retains hints', async () => {
    mkProject('p1', '/work/p1', { handoff: 'H'.repeat(900) });
    for (let i = 0; i < 6; i++) {
      const c = t.store.createCard('p1', { title: 'TT'.repeat(60), status: 'in_progress', agent: 'codex' }, 'claude');
      t.store.addNote(c.id, '[handoff] ' + 'n'.repeat(500), 'claude');
      await comment(c.id, 'q'.repeat(500), 'codex');
    }
    const r = (await session(['/work/p1'])).json;
    expect(len(r.text)).toBeLessThanOrEqual(SESSION_LIMITS.total);
    expect(r.text.startsWith('Agent Kanban | Project')).toBe(true);
    expect(r.text).toContain('kb brief');
    expect(r.text).toContain('Project handoff: ');
    expect(r.truncated).toBe(true);
  });

  it('multiple working directory candidates may match', async () => {
    mkProject('p1', '/var/work/p1', { handoff: 'Handoff' });
    const r = (await session(['/private/var/work/p1', '/var/work/p1'])).json;
    expect(r.project.id).toBe('p1');
  });

  it('session query parameters and authentication are validated', async () => {
    mkProject('p1', '/work/p1');
    expect((await t.call('GET', '/api/v1/session-brief?cwd=/work/p1', { token: 'codex' })).status).toBe(400);
    expect((await t.call('GET', '/api/v1/session-brief?cwd=/work/p1&agent=unsupported', { token: 'codex' })).status).toBe(400);
    expect((await t.call('GET', '/api/v1/session-brief?agent=codex', { token: 'codex' })).status).toBe(400);
    expect((await t.call('GET', '/api/v1/session-brief?agent=codex&cwd=', { token: 'codex' })).status).toBe(400);
    const many = new URLSearchParams([['agent', 'codex'], ...Array.from({ length: 5 }, (): [string, string] => ['cwd', '/work/p1'])]);
    expect((await t.call('GET', `/api/v1/session-brief?${many}`, { token: 'codex' })).status).toBe(400);
    expect((await t.call('GET', '/api/v1/session-brief?agent=codex&cwd=/work/p1')).status).toBe(401);
  });
});
