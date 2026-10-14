import { t as tr } from '../i18n/index.ts';
import { useSyncExternalStore } from 'react';
import type { Actor, Card, Comment, CommentTargetRequested, KanbanEvent, Project, Status } from '../../shared/constants.ts';
import { computePosition } from '../../shared/position.ts';
import { ApiFailure, createRestClient, type RestClient } from '../lib/api.ts';
import { describeEvent } from '../lib/describe.ts';

export interface Toast {
  id: number;
  actor: Actor | null;
  text: string;
  event?: KanbanEvent;
  kind: 'event' | 'error';
  
  link?: { to: string; label: string };
}


export function becameDormant(prev: Project | undefined, next: Project): boolean {
  return !!prev && !prev.dormant && next.dormant && next.status !== 'archived';
}

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  resolve: (ok: boolean) => void;
}

export interface State {
  auth: 'loading' | 'in' | 'out';
  loaded: boolean;
  error: string | null;
  projects: Project[];
  cards: Card[];
  connected: boolean;
  lastSyncAt: string | null;
  
  version: number;
  toasts: Toast[];
  confirm: ConfirmRequest | null;
}

const INITIAL: State = {
  auth: 'loading',
  loaded: false,
  error: null,
  projects: [],
  cards: [],
  connected: false,
  lastSyncAt: null,
  version: 0,
  toasts: [],
  confirm: null,
};

export type EventListener = (e: KanbanEvent) => void;

export class KanbanStore {
  state: State = INITIAL;
  private listeners = new Set<() => void>();
  private eventListeners = new Set<EventListener>();
  private es: EventSource | null = null;
  private hadError = false;
  private toastSeq = 0;
  readonly rest: RestClient;

  constructor(fetchImpl?: (i: string, init?: RequestInit) => Promise<Response>) {
    this.rest = createRestClient({ fetchImpl, onUnauthorized: () => this.handleUnauthorized() });
  }

  
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getState = () => this.state;
  private set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }
  onEvent(fn: EventListener) {
    this.eventListeners.add(fn);
    return () => {
      this.eventListeners.delete(fn);
    };
  }

  private handleUnauthorized() {
    if (this.state.auth === 'in') {
      this.disconnect();
      this.set({ auth: 'out', loaded: false, projects: [], cards: [] });
    }
  }

  
  async init() {
    try {
      await this.rest.get('/auth/me');
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 401) this.set({ auth: 'out' });
      else this.set({ auth: 'out', error: tr('ui184') });
      return;
    }

    this.disconnect();
    this.set({ auth: 'in', loaded: false, error: null, projects: [], cards: [] });
    try {
      await this.loadAll();
      this.connect();
    } catch (e) {
      this.handleInitialLoadFailure(e);
    }
  }

  async login(password: string) {
    await this.rest.post('/auth/login', { password });
    this.disconnect();
    this.set({ auth: 'in', loaded: false, error: null, projects: [], cards: [] });
    try {
      await this.loadAll();
    } catch (e) {
      this.handleInitialLoadFailure(e);
      throw e;
    }
    this.connect();
  }

  
  async retryInitialLoad() {
    if (this.state.auth !== 'in' || this.state.loaded) return;
    this.set({ error: null });
    try {
      await this.loadAll();
      this.connect();
    } catch (e) {
      this.handleInitialLoadFailure(e);
    }
  }

  private handleInitialLoadFailure(e: unknown) {
    const error = this.loadErrorMessage(e);
    if (e instanceof ApiFailure && e.status === 401) {
      this.disconnect();
      this.set({ auth: 'out', loaded: false, projects: [], cards: [], error });
      return;
    }
    this.set({ error });
  }

  private loadErrorMessage(e: unknown): string {
    return e instanceof Error && e.message ? e.message : tr('ui260');
  }

  async logout() {
    try {
      await this.rest.post('/auth/logout', {});
    } catch {
      /* ignore */
    }
    this.disconnect();
    this.set({ auth: 'out', loaded: false, projects: [], cards: [], toasts: [] });
  }

  
  async loadAll() {
    const [p, c] = await Promise.all([this.rest.get<{ projects: Project[] }>('/projects'), this.rest.get<{ cards: Card[] }>('/cards')]);
    this.set({ projects: p.projects, cards: c.cards, loaded: true, error: null, lastSyncAt: new Date().toISOString(), version: this.state.version + 1 });
  }

  // ---- SSE ----
  connect() {
    if (this.es || typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/v1/stream');
    this.es = es;
    es.onopen = () => {
      this.set({ connected: true });
      if (this.hadError) {
        this.hadError = false;
        void this.loadAll().catch(() => {});
      }
    };
    es.onerror = () => {
      this.hadError = true;
      this.set({ connected: false });
    };
    es.addEventListener('kanban', (m) => {
      try {
        this.applyBroadcast(JSON.parse((m as MessageEvent).data));
      } catch {
        /* ignore malformed */
      }
    });
  }

  disconnect() {
    this.es?.close();
    this.es = null;
    this.set({ connected: false });
  }

  
  async refreshProjects() {
    try {
      const r = await this.rest.get<{ projects: Project[] }>('/projects');
      for (const p of r.projects) this.upsertProject(p, false);
      this.set({ version: this.state.version + 1 });
    } catch {
      /* ignore */
    }
  }

  applyBroadcast(b: { event: KanbanEvent | null; cards?: Card[]; project?: Project }) {
    if (b.cards?.length) this.upsertCards(b.cards, false);
    if (b.project) {
      const prev = this.state.projects.find((x) => x.id === b.project!.id);
      this.upsertProject(b.project, false);
      if (becameDormant(prev, b.project)) {
        this.pushToast({ actor: null, text: tr('ui261', b.project.name), kind: 'event', link: { to: `/p/${b.project.id}`, label: tr('ui262') } });
      }
    }
    this.set({ version: this.state.version + 1, lastSyncAt: new Date().toISOString() });
    if (b.event) {
      this.eventListeners.forEach((l) => l(b.event!));
      if (b.event.actor !== 'owner') this.pushToast({ actor: b.event.actor, text: describeEvent(b.event), event: b.event, kind: 'event' });
    }
  }

  upsertCards(cards: Card[], bump = true) {
    const map = new Map(this.state.cards.map((c) => [c.id, c]));
    for (const c of cards) {
      if (c.archived) map.delete(c.id);
      else map.set(c.id, c);
    }
    this.set({ cards: [...map.values()], ...(bump ? { version: this.state.version + 1 } : {}) });
    if (bump && !this.state.connected) void this.refreshProjects();
  }

  upsertProject(p: Project, bump = true) {
    const list = this.state.projects.some((x) => x.id === p.id) ? this.state.projects.map((x) => (x.id === p.id ? p : x)) : [...this.state.projects, p];
    list.sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at));
    this.set({ projects: list, ...(bump ? { version: this.state.version + 1 } : {}) });
  }

  // ---- Toast / Confirm ----
  pushToast(t: Omit<Toast, 'id'>) {
    const id = ++this.toastSeq;
    this.set({ toasts: [...this.state.toasts.slice(-3), { id, ...t }] });
    setTimeout(() => this.dismissToast(id), 4000);
  }
  dismissToast(id: number) {
    this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) });
  }
  error(e: unknown) {
    this.pushToast({ actor: null, text: e instanceof Error ? e.message : String(e), kind: 'error' });
  }

  confirm(req: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
    return new Promise((resolve) => {
      this.state.confirm?.resolve(false);
      this.set({ confirm: { ...req, resolve: (ok) => { this.set({ confirm: null }); resolve(ok); } } });
    });
  }

  
  async createCard(input: Record<string, unknown>): Promise<Card> {
    const r = await this.rest.post<{ card: Card }>('/cards', input);
    this.upsertCards([r.card]);
    return r.card;
  }
  async patchCard(id: number, patch: Record<string, unknown>): Promise<Card> {
    const r = await this.rest.patch<{ card: Card }>(`/cards/${id}`, patch);
    this.upsertCards([r.card]);
    return r.card;
  }
  
  async setStatus(id: number, status: Status): Promise<Card> {
    const r = await this.rest.post<{ card: Card }>(`/cards/${id}/move`, { status });
    this.upsertCards([r.card]);
    return r.card;
  }
  async addNote(id: number, body: string) {
    const r = await this.rest.post<{ card: Card }>(`/cards/${id}/notes`, { body });
    this.upsertCards([r.card]);
  }
  async createComment(cardId: number, body: string, target: CommentTargetRequested) {
    const r = await this.rest.post<{ comment: Comment; card: Card }>(`/cards/${cardId}/comments`, { body, target });
    this.upsertCards([r.card]);
    return r.comment;
  }
  async replyComment(commentId: number, body: string) {
    const r = await this.rest.post<{ comment: Comment; root: Comment; card: Card }>(`/comments/${commentId}/replies`, { body });
    this.upsertCards([r.card]);
    return r;
  }
  async resolveComment(commentId: number, resolved: boolean) {
    const r = await this.rest.post<{ root: Comment; card: Card }>(`/comments/${commentId}/resolve`, { resolved });
    this.upsertCards([r.card]);
    return r;
  }
  async archiveCard(id: number, archived = true) {
    const r = await this.rest.post<{ card: Card }>(`/cards/${id}/archive`, { archived });
    this.upsertCards([r.card]);
  }
  async patchProject(id: string, patch: Record<string, unknown>) {
    const r = await this.rest.patch<{ project: Project }>(`/projects/${id}`, patch);
    this.upsertProject(r.project);
  }

  
  async moveCard(id: number, status: Status, column: { id: number; position: number }[], nb: { before_id?: number; after_id?: number }): Promise<boolean> {
    const prev = this.state.cards;
    const card = prev.find((c) => c.id === id);
    if (!card) return false;
    const { position } = computePosition(column, nb);
    this.set({ cards: prev.map((c) => (c.id === id ? { ...c, status, position } : c)) });
    try {
      const body: Record<string, unknown> = { status };
      if (nb.before_id) body.before_id = nb.before_id;
      else if (nb.after_id) body.after_id = nb.after_id;
      const r = await this.rest.post<{ card: Card }>(`/cards/${id}/move`, body);
      this.upsertCards([r.card]);
      return true;
    } catch (e) {
      this.set({ cards: prev });
      void this.loadAll().catch(() => {});
      this.error(e);
      return false;
    }
  }
}

export const store = new KanbanStore();

export function useStore(): State {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
