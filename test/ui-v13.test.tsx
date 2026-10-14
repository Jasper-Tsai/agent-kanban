// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card, Project } from '../shared/constants.ts';
import { CardBody } from '../src/components/CardView.tsx';
import { CommentsSection } from '../src/components/Comments.tsx';
import { FilterBar } from '../src/components/FilterBar.tsx';
import { SearchOverlay } from '../src/components/SearchOverlay.tsx';
import { ProjectLinks } from '../src/components/Sidebar.tsx';
import { EMPTY_FILTERS } from '../src/lib/filters.ts';
import { navigate } from '../src/lib/router.ts';
import { rejectCard } from '../src/lib/review-actions.ts';
import { store } from '../src/store/store.ts';
import { ui } from '../src/store/ui.ts';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let n = 0;
const card = (o: Partial<Card> = {}): Card => ({
  id: ++n + 100, project_id: 'a', title: "Card", description: '', status: 'review', agent: 'claude', priority: 'p2', blocked: false, blocked_reason: '',
  needs_owner: false, branch: null, session_ref: null, tags: [], due_date: null, position: n, archived: false,
  created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', status_changed_at: '2026-10-01T00:00:00.000Z', stale: false, age_days: 0, open_comments: 0, ...o,
});
const project = (o: Partial<Project> = {}): Project => ({
  id: 'a', name: 'A', color: '#fff', description: '', repo_path: null, url: null, status: 'active', handoff: '', sort_order: 0,
  created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', dormant: false, dormant_since: null, ...o,
});

let host: HTMLDivElement;
let root: Root;
const flush = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const render = async (el: React.ReactElement) => { await act(async () => { root.render(el); }); };
const setValue = async (el: HTMLInputElement | HTMLTextAreaElement, v: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); });
};
const key = async (k: string, init: KeyboardEventInit = {}) => { await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init })); }); };

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  localStorage.clear();
  navigate('/board', { replace: true });
  ui.closeSearch();
  ui.clearCommentFocus();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("Card review wait and 48-hour styling", () => {
  const now = new Date('2026-10-04T00:00:00Z');
  const html = (c: Card) => renderToStaticMarkup(<CardBody card={c} showProject lane={false} now={now} />);
  it("Review cards show wait duration; overdue has late styling; other cards show age", () => {
    const fresh = html(card({ status_changed_at: '2026-10-03T22:00:00Z' }));
    expect(fresh).toContain("Waiting for review 2 hr");
    expect(fresh).not.toContain('wait-chip late');
    const old = html(card({ status_changed_at: '2026-10-01T00:00:00Z' }));
    expect(old).toContain("Waiting for review 3 days");
    expect(old).toContain('wait-chip late');
    const todo = html(card({ status: 'todo' }));
    expect(todo).not.toContain("Waiting for review");
    expect(todo).toContain('card-age');
  });
  it("Review cards show approval and return buttons; mobile uses its move menu", () => {
    expect(html(card())).toContain("Approve");
    expect(html(card({ status: 'in_progress' }))).not.toContain("Approve");
    expect(renderToStaticMarkup(<CardBody card={card()} showProject lane={false} now={now} onMove={() => {}} />)).not.toContain('card-review-actions');
  });
  it("Dormant project cards show a tag", () => {
    expect(renderToStaticMarkup(<CardBody card={card()} showProject lane={false} now={now} dormant />)).toContain("Dormant");
  });
});

describe("Sidebar dormant group", () => {
  const projects = [project({ id: 'a', name: "Active project" }), project({ id: 'd1', name: "Dormant A", dormant: true, dormant_since: '2026-10-03T00:00:00Z' }), project({ id: 'd2', name: "Dormant B", dormant: true, dormant_since: '2026-09-25T00:00:00Z' })];
  it("Collapsed by default; expanding shows local dates after active projects", async () => {
    await render(<ProjectLinks projects={projects} cards={[]} />);
    const head = host.querySelector('.dormant-head') as HTMLButtonElement;
    expect(head.textContent).toContain("Dormant (2)");
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(host.textContent).toContain("Active project");
    expect(host.textContent).not.toContain("Dormant A");
    await act(async () => head.click());
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain("Dormant A");
    expect(host.textContent).toContain('10/03');
    expect(host.textContent).toContain('09/25');
    expect(localStorage.getItem('kanban.sidebar.dormant.open')).toBe('1');
  });
  it("Current dormant project auto-expands; hide empty dormant groups", async () => {
    navigate('/p/d1', { replace: true });
    await render(<ProjectLinks projects={projects} cards={[]} />);
    expect(host.textContent).toContain("Dormant B");
    await render(<ProjectLinks projects={[projects[0]]} cards={[]} />);
    expect(host.querySelector('.dormant-group')).toBeNull();
  });
});

describe("Filter bar dormant chip", () => {
  const setup = async (dormant: boolean, count: number, onChange = vi.fn()) => {
    await render(<FilterBar filters={{ ...EMPTY_FILTERS, dormant }} onChange={onChange} scopeCards={[]} title="All boards" dormantCount={count} />);
    return onChange;
  };
  it("Display count and toggle dormancy; hide when unused", async () => {
    const onChange = await setup(false, 6);
    const btn = host.querySelector('.dormant-toggle') as HTMLButtonElement;
    expect(btn.textContent).toContain("Show dormant (6)");
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    await act(async () => btn.click());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ dormant: true }));
    await setup(false, 0);
    expect(host.querySelector('.dormant-toggle')).toBeNull();
    await setup(true, 0);
    expect(host.querySelector('.dormant-toggle')?.getAttribute('aria-pressed')).toBe('true');
  });
  it("Project pages omit the dormant chip", async () => {
    await render(<FilterBar filters={EMPTY_FILTERS} onChange={() => {}} scopeCards={[]} projectId="a" />);
    expect(host.querySelector('.dormant-toggle')).toBeNull();
  });
});

describe("Global search keyboard controls", () => {
  const result = {
    q: 'sl',
    projects: [],
    truncated: false,
    cards: [
      { ...card({ id: 11, project_id: 'a', title: "First card", status: 'todo' }), match: 'title' },
      { ...card({ id: 12, project_id: 'd', title: "Second card", status: 'done' }), match: 'comment' },
    ],
  };
  const setupStore = () => {
    store.state = { ...store.state, projects: [project({ id: 'a', name: 'A' }), project({ id: 'd', name: 'D', dormant: true })] };
    const get = vi.spyOn(store.rest, 'get').mockResolvedValue(result as any);
    return get;
  };
  const typeQuery = async (q: string) => {
    await setValue(host.querySelector('input[type=search]') as HTMLInputElement, q);
    await flush(260);
  };

  it("Live grouped search supports arrows and Enter without changing background view", async () => {
    const get = setupStore();
    ui.openSearch();
    await render(<SearchOverlay />);
    expect(document.activeElement).toBe(host.querySelector('input[type=search]'));
    await typeQuery('sl');
    expect(get).toHaveBeenCalledWith('/search?q=sl&include_archived=0');
    const rows = [...host.querySelectorAll('.sr-row')];
    expect(rows).toHaveLength(2);
    expect(host.querySelectorAll('.sd-group')[1].textContent).toContain("Dormant");
    expect(rows[0].getAttribute('aria-selected')).toBe('true');
    await key('ArrowDown');
    expect(host.querySelectorAll('.sr-row')[1].getAttribute('aria-selected')).toBe('true');
    await key('ArrowDown'); 
    expect(host.querySelectorAll('.sr-row')[1].getAttribute('aria-selected')).toBe('true');
    await key('ArrowUp');
    expect(host.querySelectorAll('.sr-row')[0].getAttribute('aria-selected')).toBe('true');
    await key('ArrowDown');
    await key('Enter');
    expect(window.location.pathname).toBe('/board');
    expect(window.location.search).toBe('?card=12&lang=en');
    expect(ui.get().search).toBe(false);
  });

  it("Escape closes; archive inclusion refreshes; composing Enter does not open", async () => {
    const get = setupStore();
    ui.openSearch();
    await render(<SearchOverlay />);
    await typeQuery('sl');
    await act(async () => (host.querySelector('.sd-arch input') as HTMLInputElement).click());
    await flush(260);
    expect(get).toHaveBeenLastCalledWith('/search?q=sl&include_archived=1');
    await key('Enter', { isComposing: true });
    expect(new URLSearchParams(window.location.search).get('card')).toBeNull();
    expect(ui.get().search).toBe(true);
    await key('Escape');
    expect(ui.get().search).toBe(false);
  });

  it("Show empty results; blank queries do not send requests", async () => {
    const get = vi.spyOn(store.rest, 'get').mockResolvedValue({ q: 'zzz', projects: [], cards: [], truncated: false } as any);
    ui.openSearch();
    await render(<SearchOverlay />);
    await typeQuery('   ');
    expect(get).not.toHaveBeenCalled();
    await typeQuery('zzz');
    expect(host.querySelector('[data-testid=search-empty]')).not.toBeNull();
  });
});

describe("Focus comments after returning a card", () => {
  const mount = (id: number) => render(<CommentsSection cardId={id} threads={[]} onChanged={() => {}} />);
  it("Requested focus sets the recipient, placeholder, and input focus", async () => {
    await mount(7);
    expect(host.querySelector('textarea')!.getAttribute('placeholder')).not.toBe("What needs fixing?");
    ui.requestCommentFocus(7, 'claude');
    await flush(10);
    const ta = host.querySelector('textarea') as HTMLTextAreaElement;
    expect(document.activeElement).toBe(ta);
    expect(ta.getAttribute('placeholder')).toBe("What needs fixing?");
    expect(host.querySelector('.cm-seg [aria-pressed=true]')!.textContent).toBe('Claude');
    expect(host.querySelector('[data-testid=return-hint]')).not.toBeNull();
    expect(ui.get().commentFocus).toBeNull();
  });
  it("Ignore focus requests for another card", async () => {
    await mount(7);
    ui.requestCommentFocus(8, 'codex');
    await flush(10);
    expect(document.activeElement).not.toBe(host.querySelector('textarea'));
    expect(host.querySelector('.cm-seg [aria-pressed=true]')!.textContent).toBe('Codex');
  });
  it("Return moves first, opens the card, and focuses comments; none defaults to Codex", async () => {
    const setStatus = vi.spyOn(store, 'setStatus').mockResolvedValue(card() as any);
    expect(await rejectCard({ id: 41, agent: 'none' })).toBe(true);
    expect(setStatus).toHaveBeenCalledWith(41, 'in_progress');
    expect(window.location.search).toBe('?card=41&lang=en');
    expect(ui.get().commentFocus).toMatchObject({ cardId: 41, target: 'codex' });
    ui.clearCommentFocus();
    navigate('/board', { replace: true });
    vi.spyOn(store, 'error').mockImplementation(() => {});
    setStatus.mockRejectedValue(new Error('boom'));
    expect(await rejectCard({ id: 42, agent: 'claude' })).toBe(false);
    expect(new URLSearchParams(window.location.search).get('card')).toBeNull();
    expect(ui.get().commentFocus).toBeNull();
  });
});
