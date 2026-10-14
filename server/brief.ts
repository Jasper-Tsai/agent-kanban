// Shared task brief rendering for the REST API, CLI, MCP and session hook.
import { formatBriefTime } from './time.ts';

import { ACTOR_LABEL, AGENT_LABEL, HANDOFF_NOTE_PREFIX, STATUS_LABEL, type Actor, type Agent, type Card, type Note, type Project } from '../shared/constants.ts';
import type { Store } from './store.ts';

export const BRIEF_LIMITS = {
  description: 4000,
  handoffNote: 1200,
  otherNote: 300,
  otherNotes: 3,
  commentThreads: 5,
  commentRoot: 150,
  commentReply: 100,
  projectHandoff: 1000,
  
  total: 8000,
  descriptionFloor: 1500,
} as const;

/** session-brief (SPEC §17.4). */
export const SESSION_LIMITS = {
  projectHandoff: 300,
  cards: 5,
  cardTitle: 60,
  cardNote: 120,
  comments: 5,
  commentExcerpt: 80,
  total: 1500,
} as const;

const chars = (s: string) => Array.from(s);

function cut(text: string, n: number | null): { text: string; truncated: boolean } {
  if (n === null) return { text, truncated: false };
  const a = chars(text);
  return a.length > n ? { text: a.slice(0, n).join(''), truncated: true } : { text, truncated: false };
}
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const clipLine = (s: string, n: number) => {
  const a = chars(oneLine(s));
  return a.length > n ? a.slice(0, n).join('') + '…' : a.join('');
};

export const isHandoffNote = (body: string) => body.trimStart().toLowerCase().startsWith(HANDOFF_NOTE_PREFIX);
const stripHandoffPrefix = (body: string) => body.trimStart().slice(HANDOFF_NOTE_PREFIX.length).trimStart();

export function lastHandoffNote(notes: Note[]): Note | null {
  for (let i = notes.length - 1; i >= 0; i--) if (isHandoffNote(notes[i].body)) return notes[i];
  return null;
}

interface BriefNote { id: number; actor: string; created_at: string; body: string; truncated: boolean }
interface BriefThread {
  id: number;
  author: string;
  target: string | null;
  created_at: string;
  body: string;
  truncated: boolean;
  last_reply: { author: string; body: string; truncated: boolean } | null;
}

export interface CardBrief {
  card: {
    id: number; title: string; status: Card['status']; agent: Agent; priority: Card['priority'];
    branch: string | null; blocked: boolean; blocked_reason: string; needs_owner: boolean;
    project_id: string; project_name: string;
  };
  full: boolean;
  description: { text: string; truncated: boolean; total_chars: number };
  handoff_note: BriefNote | null;
  recent_notes: BriefNote[];
  open_comments: { total: number; threads: BriefThread[] };
  project_handoff: { text: string; truncated: boolean; total_chars: number };
  truncated: boolean;
  text: string;
}

function toBriefNote(n: Note, cap: number | null): BriefNote {
  const c = cut(n.body, cap);
  return { id: n.id, actor: n.actor, created_at: n.created_at, body: c.text, truncated: c.truncated };
}

function composeCard(card: Card, project: Project, notes: Note[], threadsAll: ReturnType<Store['listComments']>, full: boolean, descCap: number, timezone: string): CardBrief {
  const L = BRIEF_LIMITS;
  const desc = cut(card.description, full ? null : descCap);
  const handoff = lastHandoffNote(notes);
  const others = notes.filter((n) => n !== handoff);
  const recent = full ? others : others.slice(-L.otherNotes);
  const open = threadsAll.filter((t) => t.root.status === 'open');
  const shown = full ? open : open.slice(0, L.commentThreads);
  const threads: BriefThread[] = shown.map((t) => {
    const root = cut(t.root.body, full ? null : L.commentRoot);
    const lastReply = t.replies.length ? t.replies[t.replies.length - 1] : null;
    const reply = lastReply ? cut(lastReply.body, full ? null : L.commentReply) : null;
    return {
      id: t.root.id, author: t.root.author, target: t.root.target, created_at: t.root.created_at, body: root.text, truncated: root.truncated || !!reply?.truncated,
      last_reply: lastReply && reply ? { author: lastReply.author, body: reply.text, truncated: reply.truncated } : null,
    };
  });
  const ph = cut(project.handoff ?? '', full ? null : L.projectHandoff);
  const handoffNote = handoff ? toBriefNote(handoff, full ? null : L.handoffNote) : null;
  const recentNotes = recent.map((n) => toBriefNote(n, full ? null : L.otherNote));
  const brief: CardBrief = {
    card: {
      id: card.id, title: card.title, status: card.status, agent: card.agent, priority: card.priority, branch: card.branch,
      blocked: card.blocked, blocked_reason: card.blocked_reason, needs_owner: card.needs_owner, project_id: card.project_id, project_name: project.name,
    },
    full,
    description: { text: desc.text, truncated: desc.truncated, total_chars: chars(card.description).length },
    handoff_note: handoffNote,
    recent_notes: recentNotes,
    open_comments: { total: open.length, threads },
    project_handoff: { text: ph.text, truncated: ph.truncated, total_chars: chars(project.handoff ?? '').length },
    truncated: false,
    text: '',
  };
  brief.truncated = desc.truncated || !!handoffNote?.truncated || recentNotes.some((n) => n.truncated) || threads.some((t) => t.truncated)
    || open.length > threads.length || ph.truncated || (!full && others.length > recent.length);
  brief.text = renderCard(brief, timezone);
  return brief;
}

function noteLine(n: BriefNote, timezone: string): string {
  return `- ${formatBriefTime(n.created_at, timezone)} ${ACTOR_LABEL[n.actor as Actor] ?? n.actor}: ${n.body.trim()}${n.truncated ? '…' : ''}`;
}

function renderCard(b: CardBrief, timezone: string): string {
  const c = b.card;
  const out: string[] = [];
  out.push(`# #${c.id} ${c.title}`);
  out.push(`Project: ${c.project_name} (${c.project_id}) | Status: ${STATUS_LABEL[c.status]} | Agent: ${AGENT_LABEL[c.agent]} | Priority: ${c.priority.toUpperCase()}${c.branch ? ` | Branch: ${c.branch}` : ''}`);
  const flags = [c.blocked ? `Blocked: ${c.blocked_reason || '(no reason provided)'}` : '', c.needs_owner ? 'Awaiting owner decision' : ''].filter(Boolean);
  if (flags.length) out.push(`Flags: ${flags.join(' | ')}`);
  out.push('', '## Task brief (description)');
  out.push(b.description.text.trim() ? b.description.text.trim() : '(Empty; use kb set <id> desc=… to add a task brief.)');
  if (b.description.truncated) out.push(`… (truncated: showing ${chars(b.description.text).length} of ${b.description.total_chars} characters; use --full for the full text)`);
  if (b.handoff_note) {
    out.push('', `## Latest handoff note (${formatBriefTime(b.handoff_note.created_at, timezone)} ${ACTOR_LABEL[b.handoff_note.actor as Actor] ?? b.handoff_note.actor})`);
    out.push(stripHandoffPrefix(b.handoff_note.body).trim() + (b.handoff_note.truncated ? '…' : ''));
  }
  if (b.recent_notes.length) {
    out.push('', b.full ? '## Other notes (all)' : `## Latest ${b.recent_notes.length} other notes`);
    for (const n of b.recent_notes) out.push(noteLine(n, timezone));
  }
  if (b.open_comments.total) {
    out.push('', `## Open comments (${b.open_comments.total} threads${b.open_comments.total > b.open_comments.threads.length ? `; showing first ${b.open_comments.threads.length} threads` : ''})`);
    for (const t of b.open_comments.threads) {
      const last = t.last_reply ? ` ; latest reply (${ACTOR_LABEL[t.last_reply.author as Actor] ?? t.last_reply.author}): ${oneLine(t.last_reply.body)}${t.last_reply.truncated ? '…' : ''}` : '';
      out.push(`- Comment ${t.id} | ${ACTOR_LABEL[t.author as Actor] ?? t.author} → ${t.target ?? '?'}: ${oneLine(t.body)}${t.truncated && !t.last_reply?.truncated ? '…' : ''}${last}`);
    }
  }
  if (b.project_handoff.text.trim()) {
    out.push('', `## Project handoff (${b.card.project_id})`);
    out.push(b.project_handoff.text.trim() + (b.project_handoff.truncated ? '…' : ''));
  }
  if (b.truncated) out.push('', '(Some content was truncated; use --full / full=1 for the full text.)');
  return out.join('\n') + '\n';
}

export function buildCardBrief(store: Store, cardId: number, opts: { full?: boolean } = {}): CardBrief {
  const full = !!opts.full;
  const card = store.getCard(cardId);
  const project = store.requireProject(card.project_id);
  const notes = store.listNotes(cardId);
  const threads = store.listComments(cardId);
  let cap: number = BRIEF_LIMITS.description;
  let brief = composeCard(card, project, notes, threads, full, cap, store.timezone);
  
  for (let i = 0; i < 3 && !full && chars(brief.text).length > BRIEF_LIMITS.total && cap > BRIEF_LIMITS.descriptionFloor; i++) {
    const over = chars(brief.text).length - BRIEF_LIMITS.total;
    cap = Math.max(BRIEF_LIMITS.descriptionFloor, cap - over - 60);
    brief = composeCard(card, project, notes, threads, full, cap, store.timezone);
  }
  return brief;
}

// ---------- session-brief ----------

export interface SessionBrief {
  text: string;
  project?: { id: string; name: string };
  agent?: 'claude' | 'codex';
  project_handoff?: string;
  cards?: { id: number; title: string; status: Card['status']; agent: Agent; note: string | null }[];
  comments?: { id: number; card_id: number; card_title: string; excerpt: string }[];
  truncated?: boolean;
}

const normPath = (p: string): string | null => {
  if (!p || !p.startsWith('/')) return null;
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
};

export function projectForCwd<P extends { repo_path: string | null; status?: string }>(projects: P[], cwds: string[]): P | null {
  const heres = cwds.map(normPath).filter((x): x is string => !!x);
  let best: P | null = null;
  let bestLen = -1;
  for (const p of projects) {
    if (!p.repo_path || p.status === 'archived') continue;
    const repo = normPath(p.repo_path);
    if (!repo || repo === '/') continue;
    for (const here of heres) {
      if ((here === repo || here.startsWith(repo + '/')) && repo.length > bestLen) { best = p; bestLen = repo.length; }
    }
  }
  return best;
}

export function buildSessionBrief(store: Store, q: { cwds: string[]; agent: 'claude' | 'codex' }): SessionBrief {
  const L = SESSION_LIMITS;
  const project = projectForCwd(store.listProjects(), q.cwds);
  if (!project) return { text: '' };
  const agentLabel = AGENT_LABEL[q.agent];

  const handoff = cut(oneLine(project.handoff ?? ''), L.projectHandoff);
  const active = store.listCards({ project: project.id })
    .filter((c) => c.status === 'in_progress' || c.status === 'review')
    
    .sort((a, b) => Number(b.agent === q.agent) - Number(a.agent === q.agent)
      || Number(b.status === 'in_progress') - Number(a.status === 'in_progress')
      || (b.updated_at > a.updated_at ? 1 : b.updated_at < a.updated_at ? -1 : 0) || b.id - a.id);
  const cards = active.slice(0, L.cards).map((c) => {
    const notes = store.listNotes(c.id);
    const h = lastHandoffNote(notes);
    const latest = notes.length ? notes[notes.length - 1] : null;
    const note = h ? `Handoff: ${clipLine(stripHandoffPrefix(h.body), L.cardNote)}` : latest ? `Latest: ${clipLine(latest.body, L.cardNote)}` : null;
    return { id: c.id, title: clipLine(c.title, L.cardTitle), status: c.status, agent: c.agent, note };
  });
  const inbox = store.listInbox({ status: 'open', target: q.agent, project: project.id, limit: 200 });
  const comments = inbox.slice(0, L.comments).map((i) => {
    const last = i.replies.length ? i.replies[i.replies.length - 1] : i.root;
    return { id: i.root.id, card_id: i.card.id, card_title: i.card.title, excerpt: clipLine(last.body, L.commentExcerpt) };
  });

  const result: SessionBrief = {
    text: '', project: { id: project.id, name: project.name }, agent: q.agent,
    project_handoff: handoff.text, cards, comments,
  };
  if (!handoff.text && !cards.length && !comments.length) return result;

  const head = `Agent Kanban | Project ${project.name} (${project.id})`;
  const foot = cards.length || comments.length
    ? 'Start with kb brief <id> (or MCP kanban_get_brief); reply with kb reply/kanban_reply_comment; finish with kb note <id> --handoff "…"'
    : '';
  const body: string[] = [];
  if (handoff.text) body.push(`Project handoff: ${handoff.text}${handoff.truncated ? '…' : ''}`);
  if (comments.length) {
    body.push(`Open comments (targeted to ${agentLabel}; total ${inbox.length} comments): `);
    for (const c of comments) body.push(`- #${c.card_id} ${clipLine(c.card_title, L.cardTitle)} | Comment ${c.id} | ${c.excerpt}`);
  }
  if (cards.length) {
    body.push(`In progress / review (${active.length} cards${active.length > cards.length ? `; showing ${cards.length}` : ''}): `);
    for (const c of cards) body.push(`- #${c.id} [${STATUS_LABEL[c.status]}] ${c.title} | ${AGENT_LABEL[c.agent]}${c.note ? ` | ${c.note}` : ''}`);
  }
  
  const join = () => [head, ...body, ...(foot ? [foot] : [])].join('\n');
  let dropped = false;
  while (chars(join()).length > L.total && body.length > 1) { body.pop(); dropped = true; }
  let text = join();
  if (chars(text).length > L.total) { text = chars(text).slice(0, L.total - 1).join('') + '…'; dropped = true; }
  result.text = text;
  if (dropped) result.truncated = true;
  return result;
}
