import { describe, expect, it, vi } from 'vitest';
import type { Card, Project } from '../shared/constants.ts';
import { boardScope, EMPTY_FILTERS, hasActiveFilters } from '../src/lib/filters.ts';
import { groupSearch, moveSelection, returnTarget, splitProjects } from '../src/lib/dormant.ts';
import { formatLocalMD, longestReviewWait, reviewWait } from '../src/lib/time.ts';
import { buildUrl, parseLocation } from '../src/lib/url-state.ts';
import { becameDormant, KanbanStore } from '../src/store/store.ts';

let n = 0;
const card = (o: Partial<Card> = {}): Card => ({
  id: ++n, project_id: 'a', title: 'T', description: '', status: 'todo', agent: 'none', priority: 'p2', blocked: false, blocked_reason: '',
  needs_owner: false, branch: null, session_ref: null, tags: [], due_date: null, position: n, archived: false,
  created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', status_changed_at: '2026-10-01T00:00:00.000Z', stale: false, age_days: 0, open_comments: 0, ...o,
});
const project = (o: Partial<Project> = {}): Project => ({
  id: 'a', name: 'A', color: '#fff', description: '', repo_path: null, url: null, status: 'active', handoff: '', sort_order: 0,
  created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', dormant: false, dormant_since: null, ...o,
});

describe("Review wait formatting and 48-hour warning", () => {
  const now = new Date('2026-10-04T00:00:00Z');
  const at = (h: number) => new Date(now.getTime() - h * 3600e3).toISOString();
  it("Less than an hour, hours, and days", () => {
    expect(reviewWait(at(0.2), now).label).toBe("Less than 1 hour");
    expect(reviewWait(at(2), now).label).toBe("2 hr");
    expect(reviewWait(at(23.9), now).label).toBe("23 hr");
    expect(reviewWait(at(24), now).label).toBe("1 day");
    expect(reviewWait(at(74), now).label).toBe("3 days");
  });
  it("Only waits strictly exceeding 48 hours are overdue", () => {
    expect(reviewWait(at(47), now).overdue).toBe(false);
    expect(reviewWait(at(48), now).overdue).toBe(false);
    expect(reviewWait(at(48.01), now).overdue).toBe(true);
    expect(reviewWait(at(72), now).overdue).toBe(true);
  });
  it("Longest review wait ignores other statuses and returns null if absent", () => {
    const cs = [
      { status: 'review', status_changed_at: at(5) },
      { status: 'review', status_changed_at: at(74) },
      { status: 'todo', status_changed_at: at(500) },
    ];
    expect(longestReviewWait(cs, now)).toMatchObject({ label: "3 days", overdue: true });
    expect(longestReviewWait([{ status: 'todo', status_changed_at: at(5) }], now)).toBeNull();
  });
  it("formatLocalMD uses two-digit local calendar dates", () => {
    expect(formatLocalMD(new Date(2026, 9, 4, 1))).toBe('10/04'); 
    expect(formatLocalMD(new Date(2026, 0, 5))).toBe('01/05');
  });
});

describe("Board dormancy filter", () => {
  const projects = [project({ id: 'a' }), project({ id: 'd', dormant: true }), project({ id: 'x', status: 'archived' }), project({ id: 'xd', status: 'archived', dormant: true })];
  const cards = [card({ project_id: 'a' }), card({ project_id: 'd', status: 'done' }), card({ project_id: 'x' }), card({ project_id: 'xd', status: 'done' })];
  it("Hide dormant and archived projects by default; toggling includes dormant", () => {
    expect(boardScope(cards, projects, false).map((c) => c.project_id)).toEqual(['a']);
    expect(boardScope(cards, projects, true).map((c) => c.project_id)).toEqual(['a', 'd']);
  });
  it("Counts exclude cards outside scope", () => {
    const count = (show: boolean, status: string) => boardScope(cards, projects, show).filter((c) => c.status === status).length;
    expect(count(false, 'done')).toBe(0);
    expect(count(true, 'done')).toBe(1);
  });
  it("Dormancy round-trips on board URLs only and activates filters", () => {
    expect(parseLocation('/board', '?dormant=1').filters.dormant).toBe(true);
    expect(parseLocation('/board', '').filters.dormant).toBe(false);
    expect(buildUrl({ view: 'board', filters: { ...EMPTY_FILTERS, dormant: true } })).toBe('/board?dormant=1');
    expect(buildUrl({ view: 'project', projectId: 'a', filters: { ...EMPTY_FILTERS, dormant: true } })).toBe('/p/a');
    expect(hasActiveFilters({ ...EMPTY_FILTERS, dormant: true })).toBe(true);
  });
  it("splitProjects excludes archives and groups dormant projects", () => {
    const r = splitProjects(projects);
    expect(r.active.map((p) => p.id)).toEqual(['a']);
    expect(r.dormant.map((p) => p.id)).toEqual(['d']);
  });
});

describe("Automatic completion event descriptions", () => {
  it("Automatic comment resolution mentions approval", async () => {
    const { describeEvent } = await import('../src/lib/describe.ts');
    expect(describeEvent({ type: 'comment.resolved', card_id: 5, payload: { auto: true } })).toContain("automatically resolved");
    expect(describeEvent({ type: 'comment.resolved', card_id: 5, payload: {} })).toContain("resolved");
  });
});

describe("Default return recipient", () => {
  it("Use assigned Claude or Codex; owner and none default to Codex", () => {
    expect(returnTarget('claude')).toBe('claude');
    expect(returnTarget('codex')).toBe('codex');
    expect(returnTarget('owner')).toBe('codex');
    expect(returnTarget('none')).toBe('codex');
  });
});

describe("Search grouping and keyboard selection", () => {
  it("Group by project order, carry dormancy, and append unknown projects", () => {
    const ps = [project({ id: 'a', name: 'A' }), project({ id: 'd', name: 'D', dormant: true })];
    const cs = [card({ project_id: 'd' }), card({ project_id: 'a' }), card({ project_id: 'a' }), card({ project_id: 'gone' })].map((c) => ({ ...c, match: 'title' as const }));
    const g = groupSearch({ cards: cs }, ps);
    expect(g.map((x) => [x.project_id, x.dormant, x.cards.length])).toEqual([['a', false, 2], ['d', true, 1], ['gone', false, 1]]);
  });
  it("Selection clamps and returns -1 for an empty list", () => {
    expect(moveSelection(0, -1, 3)).toBe(0);
    expect(moveSelection(0, 1, 3)).toBe(1);
    expect(moveSelection(2, 1, 3)).toBe(2);
    expect(moveSelection(0, 1, 0)).toBe(-1);
  });
});

describe('§14.4 active→dormant toast', () => {
  const mkStore = () => new KanbanStore(vi.fn(async () => new Response('{}')) as any);
  it("Only existing active-to-dormant projects trigger a toast", () => {
    expect(becameDormant(project(), project({ dormant: true }))).toBe(true);
    expect(becameDormant(undefined, project({ dormant: true }))).toBe(false);
    expect(becameDormant(project({ dormant: true }), project({ dormant: true }))).toBe(false);
    expect(becameDormant(project(), project({ dormant: true, status: 'archived' }))).toBe(false);
    expect(becameDormant(project({ dormant: true }), project())).toBe(false);
  });
  it("Dormancy broadcast shows a View link once, including owner actions", () => {
    const s = mkStore();
    s.state = { ...s.state, projects: [project({ id: 'p1', name: "Project one" })], cards: [card({ project_id: 'p1', status: 'review' })] };
    const done = card({ project_id: 'p1', status: 'done' });
    const ev = { id: 1, card_id: done.id, project_id: 'p1', actor: 'owner' as const, type: 'card.moved', payload: { to: 'done' }, created_at: '2026-10-04T00:00:00Z' };
    s.applyBroadcast({ event: ev, cards: [done], project: project({ id: 'p1', name: "Project one", dormant: true, dormant_since: ev.created_at }) });
    expect(s.state.projects[0].dormant).toBe(true);
    expect(s.state.toasts).toHaveLength(1);
    expect(s.state.toasts[0]).toMatchObject({ text: "Project one is now dormant", link: { to: '/p/p1', label: "View" } });
    s.applyBroadcast({ event: null, cards: [done], project: project({ id: 'p1', name: "Project one", dormant: true }) });
    expect(s.state.toasts).toHaveLength(1);
    
    s.applyBroadcast({ event: null, cards: [card({ project_id: 'p1' })], project: project({ id: 'p1', name: "Project one" }) });
    expect(s.state.toasts).toHaveLength(1);
  });
});
