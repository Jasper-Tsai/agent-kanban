import { getTimezone } from './time.ts';
import type { DB } from './db.ts';
import { tx } from './db.ts';
import {
  type Actor,
  type Card,
  type Comment,
  type CommentTargetRequested,
  type CommentThread,
  type InboxItem,
  type KanbanEvent,
  type Note,
  type Project,
  type Status,
  PROJECT_PALETTE,
  REVIEW_WAIT_WARN_HOURS,
  type SearchMatch,
  type SearchResult,
  STALE_HOURS,
  STATUSES,
} from '../shared/constants.ts';
import { computePosition, POSITION_STEP } from '../shared/position.ts';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type Row = Record<string, any>;

export interface Broadcast {
  event: KanbanEvent | null;
  cards?: Card[];
  project?: Project;
}

export type Publish = (b: Broadcast) => void;

export const CARD_FIELDS = [
  'title',
  'description',
  'status',
  'agent',
  'priority',
  'blocked',
  'blocked_reason',
  'needs_owner',
  'branch',
  'session_ref',
  'tags',
  'due_date',
] as const;
type CardField = (typeof CARD_FIELDS)[number];

const CARD_SELECT = `SELECT c.*, (SELECT COUNT(*) FROM comments m WHERE m.card_id = c.id AND m.parent_id IS NULL AND m.status = 'open') AS open_comments FROM cards c`;
const HUMAN_ACTORS: readonly Actor[] = ['owner', 'webmcp'];

export function createStore(db: DB, now: () => Date, publish: Publish = () => {}, timezone = getTimezone()) {
  const nowIso = () => now().toISOString();
  
  const publishCards: Publish = (b) => {
    const pid = b.cards?.[0]?.project_id;
    publish(pid ? { ...b, project: requireProject(pid) } : b);
  };

  function rowToCard(r: Row): Card {
    const t = now().getTime();
    const updated = Date.parse(r.updated_at);
    const limitH = STALE_HOURS[r.status as Status];
    const stale = !r.archived && limitH !== undefined && t - updated > limitH * 3600e3;
    let tags: string[] = [];
    try {
      tags = JSON.parse(r.tags);
    } catch {
      /* keep [] */
    }
    return {
      id: r.id,
      project_id: r.project_id,
      title: r.title,
      description: r.description,
      status: r.status,
      agent: r.agent,
      priority: r.priority,
      blocked: !!r.blocked,
      blocked_reason: r.blocked_reason,
      needs_owner: !!r.needs_owner,
      branch: r.branch,
      session_ref: r.session_ref,
      tags,
      due_date: r.due_date,
      position: r.position,
      archived: !!r.archived,
      created_at: r.created_at,
      updated_at: r.updated_at,
      status_changed_at: r.status_changed_at,
      stale,
      open_comments: Number(r.open_comments ?? 0),
      age_days: Math.round(((t - Date.parse(r.status_changed_at)) / 86400e3) * 100) / 100,
    };
  }

  function rowToEvent(r: Row): KanbanEvent {
    return { id: r.id, card_id: r.card_id, project_id: r.project_id, actor: r.actor, type: r.type, payload: JSON.parse(r.payload), created_at: r.created_at };
  }

  function dormantMap(): Map<string, string | null> {
    const rows = db
      .prepare(
        `SELECT p.id,
           (SELECT MAX(e.created_at) FROM events e WHERE e.project_id = p.id) AS last_event,
           p.updated_at, p.created_at
         FROM projects p
         WHERE NOT EXISTS (SELECT 1 FROM cards c WHERE c.project_id = p.id AND c.archived = 0 AND c.status != 'done')
           AND NOT EXISTS (SELECT 1 FROM comments m JOIN cards c ON c.id = m.card_id
                           WHERE c.project_id = p.id AND c.archived = 0 AND m.parent_id IS NULL AND m.status = 'open')`,
      )
      .all() as Row[];
    return new Map(rows.map((r) => [r.id as string, (r.last_event ?? r.updated_at ?? r.created_at) as string]));
  }

  const rowToProject = (r: Row, dormant: Map<string, string | null> = dormantMap()): Project => ({
    dormant: dormant.has(r.id),
    dormant_since: dormant.get(r.id) ?? null,
    id: r.id,
    name: r.name,
    color: r.color,
    description: r.description,
    repo_path: r.repo_path,
    url: r.url,
    status: r.status,
    handoff: r.handoff,
    sort_order: r.sort_order,
    created_at: r.created_at,
    updated_at: r.updated_at,
  });

  function recordEvent(card_id: number | null, project_id: string, actor: Actor, type: string, payload: Record<string, unknown>): KanbanEvent {
    const created_at = nowIso();
    const res = db
      .prepare('INSERT INTO events (card_id, project_id, actor, type, payload, created_at) VALUES (?,?,?,?,?,?)')
      .run(card_id, project_id, actor, type, JSON.stringify(payload), created_at);
    return { id: Number(res.lastInsertRowid), card_id, project_id, actor, type, payload, created_at };
  }

  // ---------- projects ----------
  function getProjectRow(id: string): Row | undefined {
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
  }
  function requireProject(id: string): Project {
    const r = getProjectRow(id);
    if (!r) throw new ApiError(404, 'project_not_found', `Project not found: ${id}`);
    return rowToProject(r);
  }
  function listProjects(): Project[] {
    const dm = dormantMap();
    return (db.prepare('SELECT * FROM projects ORDER BY sort_order, created_at, id').all() as Row[]).map((r) => rowToProject(r, dm));
  }

  function createProject(input: Partial<Project> & { id: string; name: string }, actor: Actor): Project {
    const result = tx(db, () => {
      if (getProjectRow(input.id)) throw new ApiError(409, 'project_exists', `Project ${input.id} already exists`);
      const count = (db.prepare('SELECT COUNT(*) c FROM projects').get() as Row).c as number;
      const max = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM projects').get() as Row).m as number;
      const ts = nowIso();
      db.prepare(
        `INSERT INTO projects (id,name,color,description,repo_path,url,status,handoff,sort_order,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        input.id,
        input.name,
        input.color ?? PROJECT_PALETTE[count % PROJECT_PALETTE.length],
        input.description ?? '',
        input.repo_path ?? null,
        input.url ?? null,
        input.status ?? 'active',
        input.handoff ?? '',
        input.sort_order ?? max + 1,
        ts,
        ts,
      );
      const project = requireProject(input.id);
      const event = recordEvent(null, project.id, actor, 'project.created', { name: project.name });
      return { project, event };
    });
    publish({ event: result.event, project: result.project });
    return result.project;
  }

  function updateProject(id: string, patch: Partial<Project>, actor: Actor): Project {
    const result = tx(db, () => {
      const before = requireProject(id);
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const keys = ['name', 'color', 'description', 'repo_path', 'url', 'status', 'handoff', 'sort_order'] as const;
      for (const k of keys) {
        if (k in patch && (patch as any)[k] !== undefined && (patch as any)[k] !== (before as any)[k]) {
          changes[k] = { from: (before as any)[k], to: (patch as any)[k] };
        }
      }
      if (!Object.keys(changes).length) return { project: before, event: null };
      const sets = Object.keys(changes).map((k) => `${k} = ?`);
      db.prepare(`UPDATE projects SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(
        ...Object.values(changes).map((c) => c.to as any),
        nowIso(),
        id,
      );
      const project = requireProject(id);
      const event = recordEvent(null, id, actor, 'project.updated', { name: project.name, changes });
      return { project, event };
    });
    if (result.event) publish({ event: result.event, project: result.project });
    return result.project;
  }

  // ---------- cards ----------
  function getCardRow(id: number): Row | undefined {
    return db.prepare(`${CARD_SELECT} WHERE c.id = ?`).get(id) as Row | undefined;
  }
  function requireCard(id: number): Card {
    const r = getCardRow(id);
    if (!r) throw new ApiError(404, 'card_not_found', `Card not found: #${id}`);
    return rowToCard(r);
  }
  const getCard = (id: number) => requireCard(id);

  function columnCards(status: Status, excludeId?: number): { id: number; position: number }[] {
    return db
      .prepare('SELECT id, position FROM cards WHERE status = ? AND archived = 0 AND id != ? ORDER BY position, id')
      .all(status, excludeId ?? -1) as any;
  }

  function endPosition(status: Status, excludeId?: number): number {
    const col = columnCards(status, excludeId);
    return col.length ? col[col.length - 1].position + POSITION_STEP : POSITION_STEP;
  }

  function renumberColumn(status: Status, excludeId?: number): Card[] {
    const col = columnCards(status, excludeId);
    const upd = db.prepare('UPDATE cards SET position = ? WHERE id = ?');
    col.forEach((c, i) => {
      c.position = (i + 1) * POSITION_STEP;
      upd.run(c.position, c.id);
    });
    return col.map((c) => rowToCard(getCardRow(c.id)!));
  }

  interface ListFilter {
    project?: string;
    status?: Status;
    agent?: string;
    priority?: string;
    blocked?: boolean;
    needs_owner?: boolean;
    q?: string;
    tag?: string;
    include_archived?: boolean;
    updated_since?: string;
    
    include_dormant?: boolean;
  }

  function listCards(f: ListFilter = {}): Card[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (!f.include_archived) where.push('c.archived = 0');
    if (f.project) (where.push('c.project_id = ?'), params.push(f.project));
    if (f.status) (where.push('c.status = ?'), params.push(f.status));
    if (f.agent) (where.push('c.agent = ?'), params.push(f.agent));
    if (f.priority) (where.push('c.priority = ?'), params.push(f.priority));
    if (f.blocked !== undefined) (where.push('c.blocked = ?'), params.push(f.blocked ? 1 : 0));
    if (f.needs_owner !== undefined) (where.push('c.needs_owner = ?'), params.push(f.needs_owner ? 1 : 0));
    if (f.updated_since) (where.push('c.updated_at > ?'), params.push(f.updated_since));
    if (f.include_dormant === false) {
      const ids = [...dormantMap().keys()];
      if (ids.length) (where.push(`c.project_id NOT IN (${ids.map(() => '?').join(',')})`), params.push(...ids));
    }
    if (f.tag) (where.push('EXISTS (SELECT 1 FROM json_each(c.tags) WHERE json_each.value = ?)'), params.push(f.tag));
    if (f.q) {
      const like = `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      where.push(
        `(c.title LIKE ? ESCAPE '\\' OR c.description LIKE ? ESCAPE '\\' OR COALESCE(c.branch,'') LIKE ? ESCAPE '\\' OR c.tags LIKE ? ESCAPE '\\' OR ('#' || c.id) = ?)`,
      );
      params.push(like, like, like, like, f.q.trim());
    }
    const sql = `${CARD_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.position, c.id`;
    return (db.prepare(sql).all(...params) as Row[]).map(rowToCard);
  }

  interface CardInput {
    title: string;
    description?: string;
    status?: Status;
    agent?: string;
    priority?: string;
    blocked?: boolean;
    blocked_reason?: string;
    needs_owner?: boolean;
    branch?: string | null;
    session_ref?: string | null;
    tags?: string[];
    due_date?: string | null;
  }

  function createCard(project_id: string, input: CardInput, actor: Actor): Card {
    const result = tx(db, () => {
      requireProject(project_id);
      const status = input.status ?? 'todo';
      const ts = nowIso();
      const res = db
        .prepare(
          `INSERT INTO cards (project_id,title,description,status,agent,priority,blocked,blocked_reason,needs_owner,branch,session_ref,tags,due_date,position,archived,created_at,updated_at,status_changed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`,
        )
        .run(
          project_id,
          input.title,
          input.description ?? '',
          status,
          input.agent ?? 'none',
          input.priority ?? 'p2',
          input.blocked ? 1 : 0,
          input.blocked_reason ?? '',
          input.needs_owner ? 1 : 0,
          input.branch ?? null,
          input.session_ref ?? null,
          JSON.stringify(input.tags ?? []),
          input.due_date ?? null,
          endPosition(status),
          ts,
          ts,
          ts,
        );
      const card = requireCard(Number(res.lastInsertRowid));
      const event = recordEvent(card.id, project_id, actor, 'card.created', {
        title: card.title,
        status: card.status,
        agent: card.agent,
        priority: card.priority,
      });
      return { card, event };
    });
    publishCards({ event: result.event, cards: [result.card] });
    return result.card;
  }

  function autoCloseOnDone(card: Card, actor: Actor, ts: string): KanbanEvent[] {
    db.prepare('UPDATE cards SET needs_owner = 0 WHERE id = ?').run(card.id);
    const roots = db
      .prepare("SELECT * FROM comments WHERE card_id = ? AND parent_id IS NULL AND status IN ('open','answered') ORDER BY id")
      .all(card.id) as Row[];
    return roots.map((r) => {
      db.prepare("UPDATE comments SET status = 'resolved', updated_at = ?, resolved_at = ? WHERE id = ?").run(ts, ts, r.id);
      const root = rowToComment(getCommentRow(r.id)!);
      return recordEvent(card.id, card.project_id, actor, 'comment.resolved', commentPayload(card, root, root, { status: 'resolved', auto: true }));
    });
  }

  function updateCard(id: number, patch: Partial<Record<CardField, any>>, actor: Actor): Card {
    const result = tx(db, () => {
      const before = requireCard(id);
      const autoClose = actor === 'owner' && patch.status === 'done' && before.status !== 'done';
      if (autoClose) patch = { ...patch, needs_owner: false };
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const k of CARD_FIELDS) {
        if (patch[k] === undefined) continue;
        const from = (before as any)[k];
        const to = patch[k];
        if (JSON.stringify(from) !== JSON.stringify(to)) changes[k] = { from, to };
      }
      if (!Object.keys(changes).length) return { card: before, events: [] as KanbanEvent[] };
      const ts = nowIso();
      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      for (const [k, c] of Object.entries(changes)) {
        sets.push(`${k} = ?`);
        const v = c.to as any;
        params.push(k === 'tags' ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? 1 : 0) : v);
      }
      const statusChanged = 'status' in changes;
      if (statusChanged) {
        sets.push('status_changed_at = ?', 'position = ?');
        params.push(ts, endPosition(changes.status.to as Status, id));
      }
      sets.push('updated_at = ?');
      params.push(ts, id);
      db.prepare(`UPDATE cards SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      let card = requireCard(id);
      const events: KanbanEvent[] = [];
      const { status: sc, ...rest } = changes;
      if (Object.keys(rest).length) events.push(recordEvent(id, card.project_id, actor, 'card.updated', { title: card.title, changes: rest }));
      if (sc) events.push(recordEvent(id, card.project_id, actor, 'card.moved', { title: card.title, from: sc.from, to: sc.to }));
      if (autoClose) {
        events.push(...autoCloseOnDone(card, actor, ts));
        card = requireCard(id);
      }
      return { card, events };
    });
    result.events.forEach((e, i) => publishCards({ event: e, cards: i === result.events.length - 1 ? [result.card] : [] }));
    return result.card;
  }

  function moveCard(id: number, status: Status, opts: { before_id?: number; after_id?: number }, actor: Actor): Card {
    const result = tx(db, () => {
      const before = requireCard(id);
      for (const [label, nid] of [['before_id', opts.before_id], ['after_id', opts.after_id]] as const) {
        if (nid === undefined) continue;
        const n = getCardRow(nid);
        if (!n || n.archived || n.status !== status || nid === id) {
          throw new ApiError(400, 'invalid_neighbor', `${label} #${nid} is not in target column "${status}"`);
        }
      }
      let col = columnCards(status, id);
      let { position, renumber } = computePosition(col, opts);
      const extra: Card[] = [];
      if (renumber) {
        extra.push(...renumberColumn(status, id));
        col = columnCards(status, id);
        position = computePosition(col, opts).position;
      }
      const ts = nowIso();
      const statusChanged = before.status !== status;
      if (statusChanged) {
        db.prepare('UPDATE cards SET status = ?, position = ?, status_changed_at = ?, updated_at = ? WHERE id = ?').run(status, position, ts, ts, id);
      } else {
        db.prepare('UPDATE cards SET position = ? WHERE id = ?').run(position, id);
      }
      let card = requireCard(id);
      const events: KanbanEvent[] = [];
      if (statusChanged) events.push(recordEvent(id, card.project_id, actor, 'card.moved', { title: card.title, from: before.status, to: status }));
      if (statusChanged && status === 'done' && actor === 'owner') {
        events.push(...autoCloseOnDone(card, actor, ts));
        card = requireCard(id);
      }
      return { card, events, extra };
    });
    if (!result.events.length) publishCards({ event: null, cards: [result.card, ...result.extra] });
    result.events.forEach((e, i) => publishCards({ event: e, cards: i === result.events.length - 1 ? [result.card, ...result.extra] : [] }));
    return result.card;
  }

  function addNote(card_id: number, body: string, actor: Actor): { note: Note; card: Card } {
    const result = tx(db, () => {
      const card0 = requireCard(card_id);
      const ts = nowIso();
      const res = db.prepare('INSERT INTO notes (card_id, actor, body, created_at) VALUES (?,?,?,?)').run(card_id, actor, body, ts);
      db.prepare('UPDATE cards SET updated_at = ? WHERE id = ?').run(ts, card_id);
      const note: Note = { id: Number(res.lastInsertRowid), card_id, actor, body, created_at: ts };
      const event = recordEvent(card_id, card0.project_id, actor, 'note.added', { title: card0.title, note_id: note.id, body: body.slice(0, 200) });
      return { note, card: requireCard(card_id), event };
    });
    publishCards({ event: result.event, cards: [result.card] });
    return { note: result.note, card: result.card };
  }

  function listNotes(card_id: number): Note[] {
    return (db.prepare('SELECT * FROM notes WHERE card_id = ? ORDER BY id').all(card_id) as Row[]).map((r) => ({ ...r }) as Note);
  }

  function archiveCard(id: number, archived: boolean, actor: Actor): Card {
    const result = tx(db, () => {
      const before = requireCard(id);
      if (before.archived === archived) return { card: before, event: null };
      const ts = nowIso();
      if (archived) {
        db.prepare('UPDATE cards SET archived = 1, updated_at = ? WHERE id = ?').run(ts, id);
      } else {
        db.prepare('UPDATE cards SET archived = 0, updated_at = ?, position = ? WHERE id = ?').run(ts, endPosition(before.status, id), id);
      }
      const card = requireCard(id);
      return { card, event: recordEvent(id, card.project_id, actor, 'card.archived', { title: card.title, archived }) };
    });
    if (result.event) publishCards({ event: result.event, cards: [result.card] });
    return result.card;
  }

  // ---------- comments (SPEC §13) ----------
  const rowToComment = (r: Row): Comment => ({
    id: r.id,
    card_id: r.card_id,
    parent_id: r.parent_id,
    author: r.author,
    body: r.body,
    target: r.target,
    target_requested: r.target_requested,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
    resolved_at: r.resolved_at,
  });
  const getCommentRow = (id: number): Row | undefined => db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as Row | undefined;
  
  function requireRoot(id: number): Row {
    const r = getCommentRow(id);
    if (!r) throw new ApiError(404, 'comment_not_found', `Comment not found: #${id}`);
    if (r.parent_id === null) return r;
    return getCommentRow(r.parent_id)!;
  }
  function repliesOf(rootId: number): Comment[] {
    return (db.prepare('SELECT * FROM comments WHERE parent_id = ? ORDER BY id').all(rootId) as Row[]).map(rowToComment);
  }
  function threadOf(rootRow: Row): CommentThread {
    return { root: rowToComment(rootRow), replies: repliesOf(rootRow.id) };
  }
  function listComments(card_id: number): CommentThread[] {
    requireCard(card_id);
    return (db.prepare('SELECT * FROM comments WHERE card_id = ? AND parent_id IS NULL ORDER BY id').all(card_id) as Row[]).map(threadOf);
  }
  function commentPayload(card: Card, root: Comment, c: Comment, extra: Record<string, unknown> = {}) {
    return { title: card.title, comment_id: c.id, root_id: root.id, target: root.target, author: c.author, body: c.body.slice(0, 200), ...extra };
  }

  function createComment(card_id: number, body: string, requested: CommentTargetRequested, actor: Actor) {
    if (!HUMAN_ACTORS.includes(actor)) throw new ApiError(403, 'forbidden', 'Only the owner or WebMCP may start comment threads; agents may only reply');
    const result = tx(db, () => {
      const card0 = requireCard(card_id);
      const ts = nowIso();
      const target = requested === 'any' ? 'codex' : requested;
      const res = db
        .prepare(
          `INSERT INTO comments (card_id,parent_id,author,body,target,target_requested,status,created_at,updated_at)
           VALUES (?,NULL,?,?,?,?, 'open', ?,?)`,
        )
        .run(card_id, actor, body, target, requested, ts, ts);
      const root = rowToComment(getCommentRow(Number(res.lastInsertRowid))!);
      db.prepare('UPDATE cards SET updated_at = ? WHERE id = ?').run(ts, card_id);
      const event = recordEvent(card_id, card0.project_id, actor, 'comment.created', commentPayload(card0, root, root, { target_requested: requested }));
      return { comment: root, card: requireCard(card_id), event };
    });
    publishCards({ event: result.event, cards: [result.card] });
    return { comment: result.comment, card: result.card };
  }

  function replyComment(id: number, body: string, actor: Actor) {
    const result = tx(db, () => {
      const rootRow = requireRoot(id);
      const card0 = requireCard(rootRow.card_id);
      const ts = nowIso();
      const res = db
        .prepare('INSERT INTO comments (card_id,parent_id,author,body,created_at,updated_at) VALUES (?,?,?,?,?,?)')
        .run(rootRow.card_id, rootRow.id, actor, body, ts, ts);
      const reply = rowToComment(getCommentRow(Number(res.lastInsertRowid))!);
      const prev = rootRow.status as string;
      const next = HUMAN_ACTORS.includes(actor) ? 'open' : 'answered';
      db.prepare('UPDATE comments SET status = ?, updated_at = ?, resolved_at = NULL WHERE id = ?').run(next, ts, rootRow.id);
      db.prepare('UPDATE cards SET updated_at = ? WHERE id = ?').run(ts, rootRow.card_id);
      const root = rowToComment(getCommentRow(rootRow.id)!);
      const events = [recordEvent(card0.id, card0.project_id, actor, 'comment.replied', commentPayload(card0, root, reply, { status: next }))];
      if (prev === 'resolved') events.push(recordEvent(card0.id, card0.project_id, actor, 'comment.reopened', commentPayload(card0, root, reply, { status: next })));
      return { comment: reply, root, card: requireCard(card0.id), events };
    });
    result.events.forEach((e, i) => publishCards({ event: e, cards: i === result.events.length - 1 ? [result.card] : [] }));
    return { comment: result.comment, root: result.root, card: result.card };
  }

  function resolveComment(id: number, resolved: boolean, actor: Actor) {
    
    if (actor !== 'owner') throw new ApiError(403, 'forbidden', 'Only the owner may resolve or reopen comment threads');
    const result = tx(db, () => {
      const rootRow = requireRoot(id);
      const card0 = requireCard(rootRow.card_id);
      const before = rootRow.status as string;
      let next: string;
      if (resolved) next = 'resolved';
      else if (before !== 'resolved') return { root: rowToComment(rootRow), card: card0, event: null };
      else {
        
        const last = db.prepare('SELECT author FROM comments WHERE id = ? OR parent_id = ? ORDER BY id DESC LIMIT 1').get(rootRow.id, rootRow.id) as Row;
        next = HUMAN_ACTORS.includes(last.author) ? 'open' : 'answered';
      }
      if (next === before) return { root: rowToComment(rootRow), card: card0, event: null };
      const ts = nowIso();
      db.prepare('UPDATE comments SET status = ?, updated_at = ?, resolved_at = ? WHERE id = ?').run(next, ts, resolved ? ts : null, rootRow.id);
      db.prepare('UPDATE cards SET updated_at = ? WHERE id = ?').run(ts, card0.id);
      const root = rowToComment(getCommentRow(rootRow.id)!);
      const event = recordEvent(card0.id, card0.project_id, actor, resolved ? 'comment.resolved' : 'comment.reopened', commentPayload(card0, root, root, { status: next }));
      return { root, card: requireCard(card0.id), event };
    });
    if (result.event) publishCards({ event: result.event, cards: [result.card] });
    return { root: result.root, card: result.card };
  }

  interface InboxFilter {
    status?: 'open' | 'answered' | 'resolved' | 'all';
    target?: 'claude' | 'codex';
    project?: string;
    card_id?: number;
    limit?: number;
  }
  function listInbox(f: InboxFilter = {}): InboxItem[] {
    const where = ['m.parent_id IS NULL', 'c.archived = 0'];
    const params: (string | number)[] = [];
    const status = f.status ?? 'open';
    if (status !== 'all') (where.push('m.status = ?'), params.push(status));
    if (f.target) (where.push('m.target = ?'), params.push(f.target));
    if (f.project) (where.push('c.project_id = ?'), params.push(f.project));
    if (f.card_id) (where.push('m.card_id = ?'), params.push(f.card_id));
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
    const rows = db
      .prepare(
        `SELECT m.*, c.title AS c_title, c.status AS c_status, c.project_id AS c_project, p.name AS p_name, p.repo_path AS p_repo
         FROM comments m JOIN cards c ON c.id = m.card_id JOIN projects p ON p.id = c.project_id
         WHERE ${where.join(' AND ')} ORDER BY m.id ASC LIMIT ?`,
      )
      .all(...params, limit) as Row[];
    return rows.map((r) => ({
      ...threadOf(r),
      card: { id: r.card_id, title: r.c_title, status: r.c_status, project_id: r.c_project },
      project: { id: r.c_project, name: r.p_name, repo_path: r.p_repo },
    }));
  }

  function getCardDetail(id: number) {
    const card = requireCard(id);
    const notes = (db.prepare('SELECT * FROM notes WHERE card_id = ? ORDER BY id').all(id) as Row[]).map((r) => ({ ...r }) as Note);
    const events = (db.prepare('SELECT * FROM events WHERE card_id = ? ORDER BY id DESC').all(id) as Row[]).map(rowToEvent);
    return { card, notes, comments: listComments(id), events };
  }

  function listEvents(f: { limit?: number; before?: number; project?: string; actor?: string }) {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.before) (where.push('id < ?'), params.push(f.before));
    if (f.project) (where.push('project_id = ?'), params.push(f.project));
    if (f.actor) (where.push('actor = ?'), params.push(f.actor));
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
    const rows = db
      .prepare(`SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit + 1) as Row[];
    const events = rows.slice(0, limit).map(rowToEvent);
    return { events, next_before: rows.length > limit ? events[events.length - 1].id : null };
  }

  // ---------- search (SPEC §14.4)----------
  const SEARCH_LIMIT = 50;
  function search(qRaw: string, includeArchived = false): SearchResult {
    const q = qRaw.trim();
    if (!q) return { q, projects: [], cards: [], truncated: false };
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const idMatch = /^#?(\d+)$/.exec(q);
    const idNum = idMatch ? Number(idMatch[1]) : -1;
    const arch = includeArchived ? '' : 'AND c.archived = 0 AND p.status != \'archived\'';
    const rows = db
      .prepare(
        `${CARD_SELECT} JOIN projects p ON p.id = c.project_id
         WHERE (c.id = ?
           OR c.title LIKE ? ESCAPE '\\' OR c.description LIKE ? ESCAPE '\\' OR COALESCE(c.branch,'') LIKE ? ESCAPE '\\' OR c.tags LIKE ? ESCAPE '\\'
           OR EXISTS (SELECT 1 FROM comments m WHERE m.card_id = c.id AND m.body LIKE ? ESCAPE '\\'))
         ${arch}
         ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`,
      )
      .all(idNum, like, like, like, like, like, SEARCH_LIMIT + 1) as Row[];
    const lc = q.toLowerCase();
    const cards = rows.slice(0, SEARCH_LIMIT).map((r) => {
      const card = rowToCard(r);
      let match: SearchMatch = 'comment';
      if (card.id === idNum) match = 'id';
      else if (card.title.toLowerCase().includes(lc)) match = 'title';
      else if (card.description.toLowerCase().includes(lc)) match = 'description';
      else if ((card.branch ?? '').toLowerCase().includes(lc)) match = 'branch';
      else if (card.tags.some((t) => t.toLowerCase().includes(lc))) match = 'tag';
      return { ...card, match };
    });
    const projects = listProjects().filter(
      (p) => (includeArchived || p.status !== 'archived') && [p.id, p.name, p.description].some((x) => x.toLowerCase().includes(lc)),
    );
    return { q, projects, cards, truncated: rows.length > SEARCH_LIMIT };
  }

  // ---------- overview ----------
  function overview() {
    const projects = listProjects().filter((p) => p.status !== 'archived');
    const active = new Set(projects.map((p) => p.id));
    const cards = listCards().filter((c) => active.has(c.project_id));
    const lastRows = db.prepare('SELECT project_id, MAX(created_at) last FROM events GROUP BY project_id').all() as Row[];
    const lastBy = new Map(lastRows.map((r) => [r.project_id as string, r.last as string]));
    const t = now().getTime();
    const out = projects.map((p) => {
      const mine = cards.filter((c) => c.project_id === p.id);
      const counts = Object.fromEntries(STATUSES.map((s) => [s, mine.filter((c) => c.status === s).length])) as Record<Status, number>;
      const agents = { claude: 0, codex: 0, owner: 0, none: 0 };
      mine.filter((c) => c.status === 'in_progress').forEach((c) => agents[c.agent]++);
      const open = mine.filter((c) => c.status !== 'done');
      const last_activity = [lastBy.get(p.id), p.updated_at, ...mine.map((c) => c.updated_at)].filter(Boolean).sort().at(-1)!;
      const idleH = (t - Date.parse(last_activity)) / 3600e3;
      const staleCards = mine.filter((c) => c.stale).length;
      const stale = staleCards > 0 || (open.length > 0 && idleH > 72);
      return {
        ...p,
        counts,
        blocked: mine.filter((c) => c.blocked && c.status !== 'done').length,
        needs_owner: mine.filter((c) => c.needs_owner && c.status !== 'done').length,
        review_overdue: mine.filter((c) => c.status === 'review' && c.age_days * 24 > REVIEW_WAIT_WARN_HOURS).length,
        stale_cards: staleCards,
        stale,
        stale_for_hours: stale ? Math.floor(idleH) : null,
        agents,
        last_activity,
      };
    });
    const openComments = listInbox({ status: 'open', limit: 200 }).filter((i) => active.has(i.project.id));
    const prio = { p0: 0, p1: 1, p2: 2, p3: 3 };
    const focus = cards
      .filter((c) => c.status !== 'done' && (c.blocked || c.needs_owner))
      .sort((a, b) => prio[a.priority] - prio[b.priority] || a.updated_at.localeCompare(b.updated_at));
    return {
      projects: out,
      focus,
      totals: {
        needs_owner: focus.filter((c) => c.needs_owner).length,
        blocked: focus.filter((c) => c.blocked).length,
        stale: cards.filter((c) => c.stale).length,
        open_comments: openComments.length,
      },
      open_comments: openComments.slice(0, 20),
      generated_at: nowIso(),
    };
  }

  return {
    timezone,
    listProjects,
    requireProject,
    createProject,
    updateProject,
    listCards,
    search,
    getCard,
    getCardDetail,
    createCard,
    updateCard,
    moveCard,
    addNote,
    createComment,
    replyComment,
    resolveComment,
    listComments,
    listInbox,
    archiveCard,
    listNotes,
    listEvents,
    overview,
    recordEvent,
  };
}
export type Store = ReturnType<typeof createStore>;
