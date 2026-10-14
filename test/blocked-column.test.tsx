// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card, Project } from '../shared/constants.ts';


const dndProps: { current: any } = { current: null };
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const mod: any = await importOriginal();
  return {
    ...mod,
    DndContext: (props: any) => {
      dndProps.current = props;
      return <mod.DndContext {...props} />;
    },
  };
});

import { Board, BLOCKED_OPEN_KEY } from '../src/components/Board.tsx';
import { MobileBoard } from '../src/components/MobileBoard.tsx';
import { isExtractedBlocked, splitBlocked } from '../src/lib/filters.ts';
import { store } from '../src/store/store.ts';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let n = 0;
const card = (o: Partial<Card> = {}): Card => ({
  id: 1000 + ++n, project_id: 'a', title: `Card ${n}`, description: '', status: 'todo', agent: 'claude', priority: 'p2', blocked: false, blocked_reason: '',
  needs_owner: false, branch: null, session_ref: null, tags: [], due_date: null, position: n, archived: false,
  created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', status_changed_at: new Date().toISOString(), stale: false, age_days: 0, open_comments: 0, ...o,
});
const project = (o: Partial<Project> = {}): Project => ({
  id: 'a', name: 'A', color: '#fff', description: '', repo_path: null, url: null, status: 'active', handoff: '', sort_order: 0,
  created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', dormant: false, dormant_since: null, ...o,
});

let host: HTMLDivElement;
let root: Root;
const render = async (el: React.ReactElement) => { await act(async () => { root.render(el); }); };
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  localStorage.clear();
  dndProps.current = null;
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('splitBlocked / isExtractedBlocked', () => {
  it("Extract unfinished blocked cards; leave done cards and preserve order", () => {
    const todoB = card({ status: 'todo', blocked: true, position: 5 });
    const doingB = card({ status: 'in_progress', blocked: true, position: 1 });
    const backlogB = card({ status: 'backlog', blocked: true, position: 9 });
    const todoB2 = card({ status: 'todo', blocked: true, position: 2 });
    const doneB = card({ status: 'done', blocked: true });
    const plain = card({ status: 'todo' });
    const { blocked, rest } = splitBlocked([doingB, todoB, doneB, plain, backlogB, todoB2]);
    
    expect(blocked.map((c) => c.id)).toEqual([backlogB.id, todoB2.id, todoB.id, doingB.id]);
    expect(rest.map((c) => c.id)).toEqual([doneB.id, plain.id]);
    expect(isExtractedBlocked(doneB)).toBe(false);
    expect(isExtractedBlocked(todoB)).toBe(true);
  });
});

describe("Board blocked column (desktop flat layout)", () => {
  const setup = async (cards: Card[], extra: Partial<React.ComponentProps<typeof Board>> = {}) => {
    const projects = [project()];
    await render(<Board cards={cards} projects={projects} projectMap={new Map(projects.map((p) => [p.id, p]))} openCardId={null} onOpen={() => {}} mode="flat" {...extra} />);
  };
  const col = (label: string) => host.querySelector(`section[aria-label="${label}"]`) as HTMLElement;
  const count = (label: string) => col(label).querySelector('.col-count')!.textContent;

  it("Column order: Backlog, Blocked, Ready, In progress, Review, Done", async () => {
    await setup([card()]);
    expect([...host.querySelectorAll('.board > section')].map((s) => s.getAttribute('aria-label'))).toEqual(["Backlog", "Blocked", "Ready", "In progress", "Review", "Done"]);
  });

  it("Extract blocked todo cards from their original column and show a collapsed count", async () => {
    const b = card({ title: "Blocked card", status: 'todo', blocked: true, blocked_reason: "Waiting for key" });
    await setup([b, card({ title: "Normal card", status: 'todo' })]);
    expect(col("Ready").textContent).toContain("Normal card");
    expect(col("Ready").textContent).not.toContain("Blocked card");
    expect(count("Ready")).toBe('1');
    const blockedCol = col("Blocked");
    expect(blockedCol.classList.contains('collapsed')).toBe(true);
    const strip = blockedCol.querySelector('button.blocked-strip') as HTMLButtonElement;
    expect(strip.getAttribute('aria-expanded')).toBe('false');
    expect(strip.textContent).toContain('1');
    expect(strip.textContent).toContain("Blocked");
    expect(blockedCol.textContent).not.toContain("Blocked card"); 
    expect(host.querySelector('.board')!.classList.contains('blocked-open')).toBe(false);
  });

  it("Show the collapsed strip with zero cards", async () => {
    await setup([card()]);
    const strip = col("Blocked").querySelector('button.blocked-strip') as HTMLButtonElement;
    expect(strip).not.toBeNull();
    expect(strip.textContent).toContain('0');
  });

  it("Expand cards and original status labels; persist collapse preference", async () => {
    const t = card({ title: "Blocked in Ready", status: 'todo', blocked: true });
    const p = card({ title: "Blocked in progress", status: 'in_progress', blocked: true });
    await setup([p, t]);
    await act(async () => (col("Blocked").querySelector('button.blocked-strip') as HTMLButtonElement).click());
    const open = col("Blocked");
    expect(host.querySelector('.board')!.classList.contains('blocked-open')).toBe(true);
    expect(open.classList.contains('collapsed')).toBe(false);
    const titles = [...open.querySelectorAll('.card-title')].map((e) => e.textContent);
    expect(titles).toEqual(["Blocked in Ready", "Blocked in progress"]); 
    const chips = [...open.querySelectorAll('.chip.origin')].map((e) => e.textContent);
    expect(chips).toEqual(["From: Ready", "From: In progress"]);
    expect(open.querySelector('.col-count')!.textContent).toBe('2');
    expect(localStorage.getItem(BLOCKED_OPEN_KEY)).toBe('1');
    
    expect(col("Ready").querySelector('.chip.origin')).toBeNull();
    const collapse = open.querySelector("button[aria-label=\"Collapse blocked column\"]") as HTMLButtonElement;
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    await act(async () => collapse.click());
    expect(col("Blocked").classList.contains('collapsed')).toBe(true);
    expect(localStorage.getItem(BLOCKED_OPEN_KEY)).toBe('0');
  });

  it("Read persisted expansion; safely fall back when storage fails", async () => {
    localStorage.setItem(BLOCKED_OPEN_KEY, '1');
    await setup([card({ blocked: true })]);
    expect(col("Blocked").classList.contains('collapsed')).toBe(false);
    await act(async () => root.unmount());
    root = createRoot(host);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    await setup([card({ blocked: true })]);
    expect(col("Blocked").classList.contains('collapsed')).toBe(true);
    await act(async () => (col("Blocked").querySelector('button.blocked-strip') as HTMLButtonElement).click());
    expect(col("Blocked").classList.contains('collapsed')).toBe(false); 
  });

  it("forceBlockedOpen expands without persisting; collapse is disabled", async () => {
    await setup([card({ blocked: true, title: "Extracted card" })], { forceBlockedOpen: true });
    expect(col("Blocked").classList.contains('collapsed')).toBe(false);
    expect(col("Blocked").textContent).toContain("Extracted card");
    expect(localStorage.getItem(BLOCKED_OPEN_KEY)).toBeNull();
    expect((col("Blocked").querySelector("button[aria-label=\"Collapse blocked column\"]") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Done blocked cards remain in Done", async () => {
    const d = card({ title: "Done with a flag", status: 'done', blocked: true });
    await setup([d]);
    expect(col("Done").textContent).toContain("Done with a flag");
    expect(count("Done")).toBe('1');
    expect(col("Blocked").querySelector('.blocked-strip')!.textContent).toContain('0');
  });

  it("Project compact boards also include a blocked column", async () => {
    await setup([card({ blocked: true, status: 'review', title: "Blocked review card" })], { fixedProject: 'a' });
    expect(host.querySelector('.board.compact')).not.toBeNull();
    expect(col("Review").textContent).not.toContain("Blocked review card");
    expect(count("Review")).toBe('0');
    expect(col("Blocked").querySelector('.blocked-strip')!.textContent).toContain('1');
  });

  it("Swimlanes keep blocked cards in original columns", async () => {
    await setup([card({ blocked: true, title: "Blocked swimlane card", status: 'todo' })], { mode: 'swimlane' });
    expect(host.querySelector('[data-testid="blocked-column"]')).toBeNull();
    expect(host.querySelector('.lanes')!.textContent).toContain("Blocked swimlane card");
  });

  describe("Drag and drop (onDragEnd)", () => {
    const rect = (top: number, height = 100) => ({ top, height, left: 0, width: 100, bottom: top + height, right: 100 });
    const drop = async (activeId: number, overId: number | string, overTop = 0, translatedTop = 0) => {
      await act(async () => {
        dndProps.current.onDragEnd({
          active: { id: activeId, rect: { current: { translated: rect(translatedTop) } } },
          over: { id: overId, rect: rect(overTop) },
        });
      });
    };
    const spies = () => ({
      move: vi.spyOn(store, 'moveCard').mockResolvedValue(true),
      patch: vi.spyOn(store, 'patchCard').mockResolvedValue({} as Card),
    });

    it("Dragging an unblocked card to the blocked strip patches blocked:true", async () => {
      const a = card({ status: 'in_progress' });
      await setup([a]);
      const { move, patch } = spies();
      await drop(a.id, 'blocked');
      expect(patch).toHaveBeenCalledWith(a.id, { blocked: true });
      expect(move).not.toHaveBeenCalled();
    });

    it("Dropping on a blocked card targets the blocked column", async () => {
      const a = card({ status: 'review' });
      const b = card({ status: 'todo', blocked: true });
      await setup([a, b]);
      const { move, patch } = spies();
      await drop(a.id, b.id);
      expect(patch).toHaveBeenCalledWith(a.id, { blocked: true });
      expect(move).not.toHaveBeenCalled();
    });

    it("Reordering blocked cards and dropping done cards are no-ops", async () => {
      const b1 = card({ status: 'todo', blocked: true });
      const b2 = card({ status: 'todo', blocked: true });
      const d = card({ status: 'done' });
      await setup([b1, b2, d]);
      const { move, patch } = spies();
      await drop(b1.id, b2.id);
      await drop(b1.id, 'blocked');
      await drop(d.id, 'blocked');
      expect(patch).not.toHaveBeenCalled();
      expect(move).not.toHaveBeenCalled();
    });

    it("Dragging out moves before clearing blocked; neighbors exclude blocked cards", async () => {
      const b = card({ status: 'todo', blocked: true, position: 50 });
      const hidden = card({ status: 'in_progress', blocked: true, position: 1 }); 
      const x = card({ status: 'in_progress', position: 10 });
      await setup([b, hidden, x]);
      const { move, patch } = spies();
      const order: string[] = [];
      move.mockImplementation(async () => { order.push('move'); return true; });
      patch.mockImplementation(async () => { order.push('patch'); return {} as Card; });
      await drop(b.id, 'col:in_progress');
      expect(move).toHaveBeenCalledTimes(1);
      const [id, status, column, nb] = move.mock.calls[0];
      expect([id, status, nb]).toEqual([b.id, 'in_progress', {}]);
      expect(column).toEqual([{ id: x.id, position: 10 }]); 
      expect(patch).toHaveBeenCalledWith(b.id, { blocked: false });
      expect(order).toEqual(['move', 'patch']);
    });

    it("Failed move preserves the blocked flag", async () => {
      const b = card({ status: 'todo', blocked: true, position: 50 });
      await setup([b]);
      const { move, patch } = spies();
      move.mockResolvedValue(false);
      await drop(b.id, 'col:in_progress');
      expect(move).toHaveBeenCalledTimes(1);
      expect(patch).not.toHaveBeenCalled();
    });

    it("Dropping on a card in the original status still moves and unblocks", async () => {
      const b = card({ status: 'todo', blocked: true, position: 50 });
      const x = card({ status: 'todo', position: 10 });
      const y = card({ status: 'todo', position: 20 });
      await setup([b, x, y]);
      const { move, patch } = spies();
      await drop(b.id, y.id, 0, 0); 
      expect(move).toHaveBeenCalledTimes(1);
      expect(move.mock.calls[0][0]).toBe(b.id);
      expect(move.mock.calls[0][1]).toBe('todo');
      expect(move.mock.calls[0][2]).toEqual([{ id: x.id, position: 10 }, { id: y.id, position: 20 }]);
      expect(move.mock.calls[0][3]).toEqual({ before_id: y.id });
      expect(patch).toHaveBeenCalledWith(b.id, { blocked: false });
    });

    it("Dropping on the original status container also unblocks", async () => {
      const b = card({ status: 'todo', blocked: true });
      await setup([b]);
      const { move, patch } = spies();
      await drop(b.id, 'col:todo');
      expect(move).toHaveBeenCalledTimes(1);
      expect(patch).toHaveBeenCalledWith(b.id, { blocked: false });
    });

    it("Normal reordering only calls moveCard", async () => {
      const x = card({ status: 'todo', position: 10 });
      const y = card({ status: 'todo', position: 20 });
      await setup([x, y]);
      const { move, patch } = spies();
      await drop(x.id, y.id, 0, 90); 
      expect(move).toHaveBeenCalledTimes(1);
      expect(move.mock.calls[0][3]).toEqual({ after_id: y.id });
      expect(patch).not.toHaveBeenCalled();
    });
  });
});

describe("MobileBoard blocked tab", () => {
  const setup = async (cards: Card[]) => {
    const pm = new Map([['a', project()]]);
    await render(<MobileBoard cards={cards} projectMap={pm} openCardId={null} onOpen={() => {}} />);
  };
  const tab = (name: string) => [...host.querySelectorAll('[role="tab"]')].find((t) => t.textContent!.startsWith(name)) as HTMLButtonElement;

  it("Blocked tab follows Backlog; counts and original labels stay consistent", async () => {
    const b = card({ status: 'todo', blocked: true, title: "Mobile blocked card" });
    const n1 = card({ status: 'todo', title: "Mobile normal card" });
    const d = card({ status: 'done', blocked: true, title: "Mobile done card" });
    await setup([b, n1, d]);
    expect([...host.querySelectorAll('[role="tab"]')].map((t) => t.textContent!.replace(/\s+\d+$/, ''))).toEqual(["Backlog", "Blocked", "Ready", "In progress", "Review", "Done"]);
    expect(tab("Blocked").textContent).toBe("Blocked 1");
    expect(tab("Ready").textContent).toBe("Ready 1");
    expect(tab("Done").textContent).toBe("Done 1");
    await act(async () => tab("Ready").click());
    expect(host.querySelector('[role="tabpanel"]')!.textContent).toContain("Mobile normal card");
    expect(host.querySelector('[role="tabpanel"]')!.textContent).not.toContain("Mobile blocked card");
    await act(async () => tab("Blocked").click());
    const panel = host.querySelector('[role="tabpanel"]')!;
    expect(panel.textContent).toContain("Mobile blocked card");
    expect(panel.textContent).toContain("From: Ready");
    await act(async () => tab("Done").click());
    expect(host.querySelector('[role="tabpanel"]')!.textContent).toContain("Mobile done card");
  });

  const openMove = async (title: string) => {
    const a = [...host.querySelectorAll('.card')].find((c) => c.textContent!.includes(title))!;
    await act(async () => (a.querySelector('.move-btn') as HTMLButtonElement).click());
  };
  const modalBtn = (text: string) => [...host.querySelectorAll('.modal .nav-item')].find((b) => b.textContent!.includes(text)) as HTMLButtonElement | undefined;

  it("Move menu marks unblocked cards blocked", async () => {
    const a = card({ status: 'in_progress', title: "Card to block" });
    await setup([a]);
    const patch = vi.spyOn(store, 'patchCard').mockResolvedValue({} as Card);
    await openMove("Card to block");
    expect(modalBtn("Unblock")).toBeUndefined();
    await act(async () => modalBtn("Mark blocked")!.click());
    expect(patch).toHaveBeenCalledWith(a.id, { blocked: true });
  });

  it("Move menu unblocks after moving, including the original status", async () => {
    const b = card({ status: 'todo', blocked: true, title: "Card to unblock" });
    await setup([b]);
    const patch = vi.spyOn(store, 'patchCard').mockResolvedValue({} as Card);
    const move = vi.spyOn(store, 'moveCard').mockResolvedValue(true);
    await act(async () => tab("Blocked").click());
    await openMove("Card to unblock");
    expect(modalBtn("Mark blocked")).toBeUndefined();
    await act(async () => modalBtn("Unblock")!.click());
    expect(patch).toHaveBeenLastCalledWith(b.id, { blocked: false });
    expect(move).not.toHaveBeenCalled();

    await openMove("Card to unblock");
    const same = modalBtn("Ready")!;
    expect(same.disabled).toBe(false); 
    await act(async () => same.click());
    expect(move).toHaveBeenCalledWith(b.id, 'todo', [], {});
    expect(patch).toHaveBeenLastCalledWith(b.id, { blocked: false });
    expect(patch).toHaveBeenCalledTimes(2);
  });
});
