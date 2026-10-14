import { t as tr, statusLabel, agentLabel, useLanguage } from '../i18n/index.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AGENTS, PRIORITIES, PRIORITY_LABEL, STATUSES, type Agent, type Card, type CommentThread, type KanbanEvent, type Note, type Priority, type Status } from '../../shared/constants.ts';
import { actorLabel, describeEvent } from '../lib/describe.ts';
import { approveCard, rejectCard } from '../lib/review-actions.ts';
import { formatLocal, formatLocalDate, formatLocalTime, reviewWait } from '../lib/time.ts';
import { store, useStore } from '../store/store.ts';
import { ui } from '../store/ui.ts';
import { CommentsSection } from './Comments.tsx';
import { Markdown } from './Markdown.tsx';
import { IconCheck, IconClose, IconReturn } from './common.tsx';

interface Detail { card: Card; notes: Note[]; comments: CommentThread[]; events: KanbanEvent[] }

export function Drawer({ id, onClose }: { id: number; onClose: () => void }) {
  useLanguage();
  const { cards, projects } = useStore();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await store.rest.get<Detail>(`/cards/${id}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : tr('ui077'));
    }
  }, [id]);
  useEffect(() => { setDetail(null); void load(); }, [load]);
  useEffect(() => store.onEvent((e) => { if (e.card_id === id) void load(); }), [id, load]);
  useEffect(() => { if (ui.get().commentFocus?.cardId !== id) closeRef.current?.focus(); }, [id]);

  const live = cards.find((c) => c.id === id);
  const card = live ?? detail?.card;
  if (error && !card) {
    return (
      <>
        <div className="scrim" onClick={onClose} />
        <aside className="drawer" aria-label={tr('ui078')}><div className="drawer-top"><span className="mono muted">#{id}</span><button type="button" className="icon-btn ml-auto" aria-label={tr('ui079')} onClick={onClose}><IconClose /></button></div><div className="err">{error}</div></aside>
      </>
    );
  }
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" aria-label={tr('ui078')} role="dialog" aria-modal="false">
        <div className="drawer-top">
          <span className="mono muted">#{id}</span>
          {card && (
            <select className="chip f-input" style={{ width: 'auto', height: 26, borderRadius: 13, padding: '0 8px', background: 'var(--surface)' }} aria-label={tr('ui072')} value={card.status} onChange={(e) => void patch(id, { status: e.target.value as Status })}>
              {STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
            </select>
          )}
          {card?.status === 'review' && (() => { const w = reviewWait(card.status_changed_at); return <span className={`wait-chip${w.overdue ? ' late' : ''}`} data-testid="review-wait">{tr('ui080')}{w.label}</span>; })()}
          <button ref={closeRef} type="button" className="icon-btn ml-auto" style={{ width: 36, height: 36, border: '1px solid var(--line)', borderRadius: 8 }} aria-label={tr('ui079')} onClick={onClose}><IconClose /></button>
        </div>
        {!card ? <div className="muted">{tr('ui004')}</div> : <DrawerBody key={`${card.id}`} card={card} detail={detail} reload={load} project={projects.find((p) => p.id === card.project_id)?.name ?? card.project_id} onClose={onClose} />}
      </aside>
    </>
  );
}

async function patch(id: number, body: Record<string, unknown>) {
  try {
    await store.patchCard(id, body);
  } catch (e) {
    store.error(e);
  }
}

function DrawerBody({ card, detail, project, onClose, reload }: { card: Card; detail: Detail | null; project: string; onClose: () => void; reload: () => void }) {
  useLanguage();
  const [title, setTitle] = useState(card.title);
  const [desc, setDesc] = useState(card.description);
  const [branch, setBranch] = useState(card.branch ?? '');
  const [session, setSession] = useState(card.session_ref ?? '');
  const [tags, setTags] = useState(card.tags.join(', '));
  const [reason, setReason] = useState(card.blocked_reason);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  
  useEffect(() => {
    const a = document.activeElement;
    const editing = (name: string) => a instanceof HTMLElement && a.dataset.field === name;
    if (!editing('title')) setTitle(card.title);
    if (!editing('desc')) setDesc(card.description);
    if (!editing('branch')) setBranch(card.branch ?? '');
    if (!editing('session')) setSession(card.session_ref ?? '');
    if (!editing('tags')) setTags(card.tags.join(', '));
    if (!editing('reason')) setReason(card.blocked_reason);
  }, [card.updated_at, card.title, card.description, card.branch, card.session_ref, card.tags, card.blocked_reason]);

  const timeline = [
    ...(detail?.notes ?? []).map((n) => ({ key: `n${n.id}`, at: n.created_at, actor: n.actor, text: n.body, md: true, ord: n.id })),
    ...(detail?.events ?? []).filter((e) => e.type !== 'note.added').map((e) => ({ key: `e${e.id}`, at: e.created_at, actor: e.actor, text: describeEvent(e), md: false, ord: e.id })),
  ].sort((a, b) => b.at.localeCompare(a.at) || b.ord - a.ord);

  const commitText = (field: 'title' | 'description' | 'branch' | 'session_ref', value: string, orig: string | null) => {
    const v = field === 'title' || field === 'description' ? value : value.trim() === '' ? null : value.trim();
    if (field === 'title' && !value.trim()) { setTitle(card.title); return; }
    if ((orig ?? null) === v || ((orig ?? '') === '' && v === null)) return;
    void patch(card.id, { [field]: v });
  };

  async function sendNote() {
    const body = note.trim();
    if (!body || busy) return;
    setBusy(true);
    try { await store.addNote(card.id, body); setNote(''); } catch (e) { store.error(e); } finally { setBusy(false); }
  }
  async function archive() {
    const ok = await store.confirm({ title: tr('ui081'), message: tr('ui082', card.id, card.title), confirmLabel: tr('ui083') });
    if (!ok) return;
    try { await store.archiveCard(card.id, true); onClose(); } catch (e) { store.error(e); }
  }

  return (
    <>
      <textarea
        className="drawer-title"
        data-field="title"
        aria-label={tr('ui068')}
        rows={Math.max(1, Math.ceil(title.length / 22))}
        value={title}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => commitText('title', title.trim(), card.title)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLElement).blur(); } }}
      />
      {card.status === 'review' && (
        <>
          <div className="review-bar" role="group" aria-label={tr('ui084')} data-testid="review-bar">
            <button type="button" className="rb-approve" onClick={() => void approveCard(card)}><IconCheck />{tr('ui085')}</button>
            <button type="button" className="rb-return" onClick={() => void rejectCard(card)}><IconReturn />{tr('ui086')}</button>
          </div>
          <span className="review-help">{tr('ui087')}{card.agent === 'claude' ? tr('ui088') : card.agent === 'codex' ? tr('ui089') : ' Claude'}.</span>
        </>
      )}
      {detail?.card.archived && (
        <div className="card-reason" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{tr('ui090')}<button type="button" className="link-btn" onClick={() => void store.archiveCard(card.id, false).then(() => store.loadAll()).catch(store.error.bind(store))}>{tr('ui091')}</button>
        </div>
      )}
      <div className="fields">
        <span className="k">{tr('ui002')}</span>
        <span>{project}</span>
        <span className="k">{tr('ui073')}</span>
        <div className="agent-pills">
          {AGENTS.map((a) => (
            <button key={a} type="button" className="agent-pill" data-agent={a} aria-pressed={card.agent === a} onClick={() => void patch(card.id, { agent: a as Agent })}>{agentLabel(a)}</button>
          ))}
        </div>
        <span className="k">{tr('ui074')}</span>
        <select className="f-input" style={{ width: 'auto', fontFamily: 'var(--mono)' }} aria-label={tr('ui074')} value={card.priority} onChange={(e) => void patch(card.id, { priority: e.target.value as Priority })}>
          {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
        </select>
        <span className="k">{tr('ui092')}</span>
        <input className="f-input" data-field="branch" aria-label={tr('ui092')} placeholder="feat/…" value={branch} onChange={(e) => setBranch(e.target.value)} onBlur={() => commitText('branch', branch, card.branch)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLElement).blur()} />
        <span className="k">Session</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
          <input className="f-input" data-field="session" aria-label="Session" placeholder="Claude session URL / Codex job id" value={session} onChange={(e) => setSession(e.target.value)} onBlur={() => commitText('session_ref', session, card.session_ref)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLElement).blur()} />
          {/^https?:\/\//.test(card.session_ref ?? '') && <a className="small" href={card.session_ref!} target="_blank" rel="noreferrer">{tr('ui093')}</a>}
        </div>
        <span className="k">{tr('ui094')}</span>
        <input className="f-input" type="date" aria-label={tr('ui095')} value={card.due_date ?? ''} onChange={(e) => void patch(card.id, { due_date: e.target.value || null })} style={{ width: 'auto' }} />
        <span className="k">{tr('ui096')}</span>
        <input className="f-input sans" data-field="tags" aria-label={tr('ui096')} placeholder={tr('ui097')} value={tags} onChange={(e) => setTags(e.target.value)} onBlur={() => {
          const next = tags.split(',').map((t) => t.trim()).filter(Boolean);
          if (next.join('\n') !== card.tags.join('\n')) void patch(card.id, { tags: next });
        }} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLElement).blur()} />
        <span className="k">{tr('ui098')}</span>
        <div className="checks">
          <label><input type="checkbox" checked={card.blocked} onChange={(e) => void patch(card.id, { blocked: e.target.checked })} />{tr('ui016')}</label>
          <label><input type="checkbox" checked={card.needs_owner} onChange={(e) => void patch(card.id, { needs_owner: e.target.checked })} />{tr('ui099')}</label>
        </div>
        {card.blocked && (
          <>
            <span className="k">{tr('ui100')}</span>
            <input className="f-input sans" data-field="reason" aria-label={tr('ui100')} value={reason} onChange={(e) => setReason(e.target.value)} onBlur={() => reason !== card.blocked_reason && void patch(card.id, { blocked_reason: reason })} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLElement).blur()} />
          </>
        )}
        <span className="k">{tr('ui076')}</span>
        <span className="mono small muted" title={tr('ui101')}>{formatLocal(card.created_at)}</span>
      </div>
      <div className="sec">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label className="lbl" htmlFor="desc">{tr('ui070')}</label>
          {!editingDesc && <button type="button" className="link-btn small" onClick={() => setEditingDesc(true)}>{tr('ui102')}</button>}
        </div>
        {editingDesc ? (
          <textarea id="desc" className="desc-box" data-field="desc" autoFocus placeholder={tr('ui103')} value={desc} onChange={(e) => setDesc(e.target.value)} onBlur={() => { commitText('description', desc, card.description); setEditingDesc(false); }} />
        ) : (
          <div
            className="desc-view"
            data-testid="desc-view"
            tabIndex={0}
            role="button"
            aria-label={tr('ui104')}
            onClick={(e) => { if (!(e.target as HTMLElement).closest('a')) setEditingDesc(true); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) setEditingDesc(true); }}
          >
            {desc.trim() ? <Markdown text={desc} /> : <span className="muted">{tr('ui105')}</span>}
          </div>
        )}
      </div>
      <CommentsSection cardId={card.id} threads={detail?.comments ?? []} onChanged={reload} />
      <div className="sec">
        <span className="lbl">{tr('ui106')}</span>
        <div className="timeline">
          {timeline.length === 0 && <div className="muted small">{tr('ui107')}</div>}
          {timeline.map((t) => (
            <div className="tl-row" key={t.key}>
              <span className="tl-time" title={tr('ui108', formatLocal(t.at))}>{formatLocalDate(t.at) === formatLocalDate(new Date()) ? formatLocalTime(t.at) : formatLocal(t.at).slice(5)}</span>
              <div><span className="actor-name" data-actor={t.actor}>{actorLabel(t.actor)}</span>{t.md ? <Markdown className="tl-text" text={t.text} /> : <span className="tl-text"> {t.text}</span>}</div>
            </div>
          ))}
        </div>
        <form className="note-form" onSubmit={(e) => { e.preventDefault(); void sendNote(); }}>
          <label className="sr-only" htmlFor="note-input">{tr('ui109')}</label>
          <input id="note-input" type="text" placeholder={tr('ui110')} value={note} onChange={(e) => setNote(e.target.value)} />
          <button type="submit" disabled={busy || !note.trim()}>{tr('ui050')}</button>
        </form>
      </div>
      {!card.archived && <button type="button" className="btn-danger" onClick={() => void archive()} style={{ alignSelf: 'flex-start' }}>{tr('ui081')}</button>}
    </>
  );
}
