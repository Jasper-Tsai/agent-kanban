import { describe, expect, it } from 'vitest';
import type { Card } from '../shared/constants.ts';
import { computePosition } from '../shared/position.ts';
import { applyFilters, EMPTY_FILTERS, groupByStatus, hasActiveFilters, isOverWip, matchesFilters, visibleDone } from '../src/lib/filters.ts';
import { buildUrl, parseLocation } from '../src/lib/url-state.ts';
import { ageShort, agoLong, formatLocal, formatLocalDay, formatLocalTime, staleFor } from '../src/lib/time.ts';
import { commentExcerpt, describeEvent, toastText } from '../src/lib/describe.ts';
import { isSubmitShortcut } from '../src/components/Comments.tsx';
import { buildNavigateUrl } from '../src/webmcp/navigate.ts';

let n = 0;
const mk = (o: Partial<Card> = {}): Card => ({
  id: ++n, project_id: 'p1', title: 'T', description: '', status: 'todo', agent: 'none', priority: 'p2', blocked: false, blocked_reason: '',
  needs_owner: false, branch: null, session_ref: null, tags: [], due_date: null, position: n * 1024, archived: false,
  created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', status_changed_at: '2026-10-01T00:00:00.000Z', stale: false, age_days: 0, open_comments: 0, ...o,
});

describe("Filters", () => {
  const cards = [
    mk({ title: "Alpha release", agent: 'claude', tags: ['infra'], branch: 'feat/alpha' }),
    mk({ title: 'Beta', agent: 'codex', priority: 'p0', blocked: true }),
    mk({ title: 'Gamma', needs_owner: true, description: "Needs DEPLOY confirmation" }),
  ];
  it("Individual filter conditions", () => {
    expect(applyFilters(cards, { ...EMPTY_FILTERS, agent: 'claude' }).map((c) => c.title)).toEqual(["Alpha release"]);
    expect(applyFilters(cards, { ...EMPTY_FILTERS, priority: 'p0' }).map((c) => c.title)).toEqual(['Beta']);
    expect(applyFilters(cards, { ...EMPTY_FILTERS, blocked: true }).map((c) => c.title)).toEqual(['Beta']);
    expect(applyFilters(cards, { ...EMPTY_FILTERS, needs_owner: true }).map((c) => c.title)).toEqual(['Gamma']);
    expect(applyFilters(cards, { ...EMPTY_FILTERS, tag: 'infra' }).map((c) => c.title)).toEqual(["Alpha release"]);
  });
  it("Search title, description, branch, tags, and ID without case sensitivity", () => {
    const q = (s: string) => applyFilters(cards, { ...EMPTY_FILTERS, q: s }).map((c) => c.title);
    expect(q('deploy')).toEqual(['Gamma']);
    expect(q('feat/alpha')).toEqual(["Alpha release"]);
    expect(q('INFRA')).toEqual(["Alpha release"]);
    expect(q("release")).toEqual(["Alpha release"]);
    expect(q(`#${cards[1].id}`)).toEqual(['Beta']);
    expect(q('nothing')).toEqual([]);
  });
  it("Filters use AND; hasActiveFilters", () => {
    expect(matchesFilters(cards[0], { ...EMPTY_FILTERS, agent: 'claude', priority: 'p0' })).toBe(false);
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, blocked: true })).toBe(true);
  });
  it("Status grouping, WIP warning, and 14-day done visibility", () => {
    const a = mk({ status: 'todo', position: 20 });
    const b = mk({ status: 'todo', position: 10 });
    expect(groupByStatus([a, b]).todo.map((c) => c.id)).toEqual([b.id, a.id]);
    expect(isOverWip('in_progress', 6)).toBe(false);
    expect(isOverWip('in_progress', 7)).toBe(true);
    expect(isOverWip('review', 6)).toBe(true);
    expect(isOverWip('todo', 99)).toBe(false);
    const now = new Date('2026-10-03T00:00:00Z');
    const recent = mk({ status: 'done', status_changed_at: '2026-09-20T00:00:00Z' });
    const old = mk({ status: 'done', status_changed_at: '2026-09-18T23:59:00Z' });
    expect(visibleDone([recent, old], now, false).map((c) => c.id)).toEqual([recent.id]);
    expect(visibleDone([recent, old], now, true)).toHaveLength(2);
  });
});

describe("URL state", () => {
  it("Route parsing", () => {
    expect(parseLocation('/', '').view).toBe('overview');
    expect(parseLocation('/board', '').view).toBe('board');
    expect(parseLocation('/activity', '').view).toBe('activity');
    expect(parseLocation('/p/my-project', '')).toMatchObject({ view: 'project', projectId: 'my-project' });
    expect(parseLocation('/p/Bad_ID', '').view).toBe('overview');
    expect(parseLocation('/board/', '').view).toBe('board');
  });
  it("Filters, layout, and card round-trip through the URL", () => {
    const url = buildUrl({
      view: 'board', layout: 'swimlane', card: 12,
      filters: { q: "release x", agent: 'codex', priority: 'p1', blocked: true, needs_owner: true, tag: 'infra', dormant: true },
    });
    expect(url).toContain('dormant=1');
    expect(url).toContain('layout=swimlane');
    expect(url).toContain('card=12');
    const [path, search] = url.split('?');
    const r = parseLocation(path, `?${search}`);
    expect(r).toMatchObject({ view: 'board', layout: 'swimlane', card: 12, filters: { q: "release x", agent: 'codex', priority: 'p1', blocked: true, needs_owner: true, tag: 'infra', dormant: true } });
  });
  it("Defaults omitted; invalid values ignored; activity actor and project", () => {
    expect(buildUrl({ view: 'board', layout: 'flat', filters: EMPTY_FILTERS })).toBe('/board');
    expect(buildUrl({ view: 'overview' })).toBe('/');
    expect(parseLocation('/board', '?agent=zzz&priority=p9&card=abc&layout=weird').filters).toMatchObject({ agent: '', priority: '' });
    expect(parseLocation('/board', '?card=abc').card).toBeNull();
    const u = buildUrl({ view: 'activity', activityActor: 'codex', activityProject: 'agent-kanban' });
    expect(u).toBe('/activity?actor=codex&project=agent-kanban');
    expect(parseLocation('/activity', '?actor=codex&project=agent-kanban')).toMatchObject({ activityActor: 'codex', activityProject: 'agent-kanban' });
  });
  it('kanban_navigate → URL', () => {
    expect(buildNavigateUrl({ view: 'board', layout: 'swimlane', filters: { blocked: true } })).toBe('/board?layout=swimlane&blocked=1');
    expect(buildNavigateUrl({ view: 'project', project: 'my-project', card: 7 })).toBe('/p/my-project?card=7');
    expect(() => buildNavigateUrl({ view: 'project' })).toThrow(/project/);
    expect(() => buildNavigateUrl({ view: 'nope' as any })).toThrow();
  });
});

describe('Local time formatting', () => {
  it('formats the browser local calendar and clock', () => {
    const midnight = new Date(2026, 9, 3, 0, 0);
    expect(formatLocal(midnight)).toBe('2026-10-03 00:00');
    expect(formatLocalTime(new Date(2026, 9, 4, 0, 30))).toBe('00:30');
    expect(formatLocal(new Date(2026, 9, 4, 0, 30))).toBe('2026-10-04 00:30');
    expect(formatLocalTime(new Date(2026, 9, 3, 23, 59))).toBe('23:59');
  });
  it('uses local calendar days for today and yesterday', () => {
    const now = new Date(2026, 9, 4, 1);
    expect(formatLocalDay(new Date(2026, 9, 4, 1, 30), now)).toBe('Today');
    expect(formatLocalDay(new Date(2026, 9, 3, 18), now)).toBe('Yesterday');
    expect(formatLocalDay(new Date(2026, 8, 20), now)).toBe('9/20');
  });
  it('formats elapsed time', () => {
    const now = new Date('2026-10-03T12:00:00Z');
    expect(ageShort('2026-10-03T11:18:00Z', now)).toBe('42 min');
    expect(ageShort('2026-10-03T09:00:00Z', now)).toBe('3 hr');
    expect(ageShort('2026-10-01T12:00:00Z', now)).toBe('2 days');
    expect(ageShort('2026-10-03T12:00:00Z', now)).toBe('Just now');
    expect(agoLong('2026-10-03T11:18:00Z', now)).toBe('42 minutes ago');
    expect(agoLong('2026-09-27T12:00:00Z', now)).toBe('6 days ago');
    expect(staleFor(26)).toBe('26 hr');
    expect(staleFor(144)).toBe('6 days');
  });
});

describe("Event descriptions", () => {
  it("Toast for moving a card to review", () => {
    const e = { id: 1, card_id: 12, project_id: 'p', actor: 'codex' as const, type: 'card.moved', payload: { from: 'in_progress', to: 'review', title: 'x' }, created_at: '' };
    expect(toastText(e)).toBe("Codex moved #12 to Review");
    expect(describeEvent({ type: 'card.updated', card_id: 3, payload: { changes: { priority: {}, blocked: {} } } })).toBe("updated #3 (Priority, Blocked)");
    expect(toastText({ ...e, actor: 'webmcp', type: 'card.archived', payload: { archived: true } })).toBe("Browser agent archived #12");
  });
});

describe("Shared position calculation", () => {
  const col = [{ id: 1, position: 1024 }, { id: 2, position: 2048 }, { id: 3, position: 3072 }];
  it("Insertion positions", () => {
    expect(computePosition([], {})).toEqual({ position: 1024, renumber: false });
    expect(computePosition(col, {}).position).toBe(4096);
    expect(computePosition(col, { before_id: 1 }).position).toBe(0);
    expect(computePosition(col, { before_id: 2 }).position).toBe(1536);
    expect(computePosition(col, { after_id: 2 }).position).toBe(2560);
    expect(computePosition(col, { after_id: 3 }).position).toBe(4096);
    expect(computePosition(col, { after_id: 1, before_id: 2 }).position).toBe(1536);
    expect(computePosition([{ id: 1, position: 1 }, { id: 2, position: 1 + 1e-9 }], { after_id: 1 }).renumber).toBe(true);
  });
});

describe("Comment event descriptions", () => {
  const ev = (type: string, actor: any, payload: Record<string, unknown> = {}): any => ({ id: 1, card_id: 12, project_id: 'p1', actor, type, payload, created_at: '2026-10-03T00:00:00.000Z' });
  it("Comment reply toast", () => {
    expect(toastText(ev('comment.replied', 'codex', { body: 'x' }))).toBe("Codex replied to a comment on #12");
    expect(toastText(ev('comment.created', 'webmcp', { target: 'claude' }))).toBe("Browser agent commented on #12 for Claude");
    expect(describeEvent(ev('comment.resolved', 'owner'))).toBe("resolved comments on #12");
    expect(describeEvent(ev('comment.reopened', 'owner'))).toBe("reopened comments on #12");
  });
  it("Activity excerpts only show created and replied comments", () => {
    expect(commentExcerpt(ev('comment.replied', 'codex', { body: "Conclusion" }))).toBe("Conclusion");
    expect(commentExcerpt(ev('comment.resolved', 'owner', { body: "Conclusion" }))).toBe('');
    expect(commentExcerpt(ev('card.moved', 'codex'))).toBe('');
  });
  it("Cmd or Ctrl + Enter submits without interrupting composition", () => {
    const k = (o: any) => ({ key: 'Enter', metaKey: false, ctrlKey: false, ...o });
    expect(isSubmitShortcut(k({ metaKey: true }))).toBe(true);
    expect(isSubmitShortcut(k({ ctrlKey: true }))).toBe(true);
    expect(isSubmitShortcut(k({}))).toBe(false);
    expect(isSubmitShortcut(k({ metaKey: true, nativeEvent: { isComposing: true } }))).toBe(false);
    expect(isSubmitShortcut({ key: 'a', metaKey: true, ctrlKey: false })).toBe(false);
  });
});
