import { DONE_VISIBLE_DAYS, STATUSES, WIP_LIMITS, type Agent, type Card, type Priority, type Project, type Status } from '../../shared/constants.ts';

export interface Filters {
  q: string;
  agent: Agent | '';
  priority: Priority | '';
  blocked: boolean;
  needs_owner: boolean;
  tag: string;
  
  dormant: boolean;
}

export const EMPTY_FILTERS: Filters = { q: '', agent: '', priority: '', blocked: false, needs_owner: false, tag: '', dormant: false };


export function hasActiveFilters(f: Filters): boolean {
  return !!(f.q || f.agent || f.priority || f.blocked || f.needs_owner || f.tag || f.dormant);
}

export function matchesFilters(c: Card, f: Filters): boolean {
  if (f.agent && c.agent !== f.agent) return false;
  if (f.priority && c.priority !== f.priority) return false;
  if (f.blocked && !c.blocked) return false;
  if (f.needs_owner && !c.needs_owner) return false;
  if (f.tag && !c.tags.includes(f.tag)) return false;
  const q = f.q.trim().toLowerCase();
  if (q) {
    const hay = [c.title, c.description, c.branch ?? '', c.tags.join(' '), `#${c.id}`, c.project_id].join('\n').toLowerCase();
    if (!hay.includes(q.replace(/^#/, '#'))) return false;
  }
  return true;
}

export function applyFilters(cards: Card[], f: Filters): Card[] {
  return cards.filter((c) => matchesFilters(c, f));
}

export function sortByPosition(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => a.position - b.position || a.id - b.id);
}

export function groupByStatus(cards: Card[]): Record<Status, Card[]> {
  const out = Object.fromEntries(STATUSES.map((s) => [s, [] as Card[]])) as Record<Status, Card[]>;
  for (const c of sortByPosition(cards)) out[c.status].push(c);
  return out;
}


export function visibleDone(cards: Card[], now: Date, showAll: boolean, days = DONE_VISIBLE_DAYS): Card[] {
  if (showAll) return cards;
  const cutoff = now.getTime() - days * 86400e3;
  return cards.filter((c) => Date.parse(c.status_changed_at) >= cutoff);
}

export function isOverWip(status: Status, count: number): boolean {
  const lim = WIP_LIMITS[status];
  return lim !== undefined && count > lim;
}

export function allTags(cards: Card[]): string[] {
  return [...new Set(cards.flatMap((c) => c.tags))].sort((a, b) => a.localeCompare(b));
}


export function boardScope(cards: Card[], projects: Project[], showDormant: boolean): Card[] {
  const ok = new Set(projects.filter((p) => p.status !== 'archived' && (showDormant || !p.dormant)).map((p) => p.id));
  return cards.filter((c) => ok.has(c.project_id));
}


export function isExtractedBlocked(c: Pick<Card, 'blocked' | 'status'>): boolean {
  return c.blocked && c.status !== 'done';
}


export function splitBlocked(cards: Card[]): { blocked: Card[]; rest: Card[] } {
  const blocked: Card[] = [];
  const rest: Card[] = [];
  for (const c of cards) (isExtractedBlocked(c) ? blocked : rest).push(c);
  const order = (c: Card) => STATUSES.indexOf(c.status);
  blocked.sort((a, b) => order(a) - order(b) || a.position - b.position || a.id - b.id);
  return { blocked, rest };
}
