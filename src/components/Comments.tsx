import { t as tr, localizedActorLabel, commentStatusLabel, useLanguage } from '../i18n/index.ts';
import { useEffect, useRef, useState } from 'react';
import { type Comment, type CommentTargetRequested, type CommentThread } from '../../shared/constants.ts';
import { actorLabel } from '../lib/describe.ts';
import { formatLocal, formatLocalDate, formatLocalTime } from '../lib/time.ts';
import { store } from '../store/store.ts';
import { ui, useUi } from '../store/ui.ts';
import { Markdown } from './Markdown.tsx';

const targetOptions = (): { value: CommentTargetRequested; label: string }[] => [
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude' },
  { value: 'any', label: tr('ui044') },
];

const stamp = (iso: string) => (formatLocalDate(iso) === formatLocalDate(new Date()) ? formatLocalTime(iso) : formatLocal(iso).slice(5));


export const isSubmitShortcut = (e: { key: string; metaKey: boolean; ctrlKey: boolean; nativeEvent?: { isComposing?: boolean } }) =>
  e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent?.isComposing;

function ThreadView({ thread, onChanged }: { thread: CommentThread; onChanged: () => void }) {
  useLanguage();
  const { root, replies } = thread;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const status = root.status ?? 'open';
  const to = root.target ?? 'codex';

  async function run(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try { await fn(); onChanged(); } catch (e) { store.error(e); } finally { setBusy(false); }
  }
  const send = () => {
    const body = text.trim();
    if (!body) return;
    void run(async () => { await store.replyComment(root.id, body); setText(''); });
  };
  return (
    <section className="cm-thread" data-status={status} data-thread-id={root.id} aria-label={tr('ui045', root.id, commentStatusLabel(status))}>
      <div className="cm-meta">
        <span className="actor-name" data-actor={root.author}>{actorLabel(root.author)}</span>
        <span className="muted">→</span>
        <span className="cm-to" data-agent={to}>{localizedActorLabel(to)}</span>
        <span className="time" title={tr('ui046', formatLocal(root.created_at))}>{stamp(root.created_at)}</span>
        <span className="st cm-st" data-status={status}>{commentStatusLabel(status)}</span>
      </div>
      <Markdown className="cm-body" text={root.body} />
      {replies.map((r: Comment) => (
        <div className="cm-reply" key={r.id}>
          <div className="cm-meta">
            <span className="actor-name" data-actor={r.author}>{actorLabel(r.author)}</span>
            <span className="time" title={tr('ui047', formatLocal(r.created_at))}>{stamp(r.created_at)}</span>
          </div>
          <Markdown className="cm-body" text={r.body} />
        </div>
      ))}
      <div className="cm-reply-form">
        <label className="sr-only" htmlFor={`cm-reply-${root.id}`}>{tr('ui048')}{root.id}</label>
        <input
          id={`cm-reply-${root.id}`}
          type="text"
          placeholder={tr('ui049')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
        />
        {text.trim() ? (
          <button type="button" className="cm-btn" disabled={busy} onClick={send}>{tr('ui050')}</button>
        ) : status === 'resolved' ? (
          <button type="button" className="cm-btn" disabled={busy} onClick={() => void run(() => store.resolveComment(root.id, false))}>{tr('ui051')}</button>
        ) : (
          <button type="button" className="cm-btn" disabled={busy} onClick={() => void run(() => store.resolveComment(root.id, true))}>{tr('ui052')}</button>
        )}
      </div>
    </section>
  );
}

export function CommentsSection({ cardId, threads, onChanged }: { cardId: number; threads: CommentThread[]; onChanged: () => void }) {
  useLanguage();
  const [body, setBody] = useState('');
  const [target, setTarget] = useState<CommentTargetRequested>('codex');
  const [busy, setBusy] = useState(false);
  const open = threads.filter((t) => t.root.status === 'open').length;
  const { commentFocus } = useUi();
  const sectionRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  
  const [returning, setReturning] = useState(false);
  useEffect(() => {
    if (!commentFocus || commentFocus.cardId !== cardId) return;
    setTarget(commentFocus.target);
    setReturning(true);
    const t = setTimeout(() => {
      sectionRef.current?.scrollIntoView?.({ block: 'start' });
      taRef.current?.focus();
      ui.clearCommentFocus();
    }, 0);
    return () => clearTimeout(t);
  }, [commentFocus, cardId]);

  async function submit() {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    try { await store.createComment(cardId, text, target); setBody(''); setReturning(false); onChanged(); } catch (e) { store.error(e); } finally { setBusy(false); }
  }
  const agentName = target === 'claude' ? 'Claude' : 'Codex';
  return (
    <div className="sec" aria-label={tr('ui053')} data-section="comments" ref={sectionRef}>
      <div className="cm-head">
        <h3>{tr('ui053')}</h3>
        {open > 0 && <span className="cm-st chip" data-status="open">{tr('ui054')}{open}</span>}
      </div>
      {threads.map((t) => <ThreadView key={t.root.id} thread={t} onChanged={onChanged} />)}
      <form className="cm-new" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="cm-help">{tr('ui055')}</span>
          <textarea
            ref={taRef}
            data-field="new-comment"
            rows={3}
            placeholder={returning ? tr('ui056') : tr('ui057')}
            value={body}
            maxLength={20000}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => { if (isSubmitShortcut(e)) { e.preventDefault(); void submit(); } }}
          />
        </label>
        <div className="cm-new-row">
          <span className="cm-help">{tr('ui058')}</span>
          <div className="cm-seg" role="group" aria-label={tr('ui059')}>
            {targetOptions().map((o) => (
              <button key={o.value} type="button" data-target={o.value} aria-pressed={target === o.value} onClick={() => setTarget(o.value)}>{o.label}</button>
            ))}
          </div>
          <button type="submit" className="cm-send" disabled={busy || !body.trim()}>{tr('ui060')}</button>
        </div>
        {returning && <span className="cm-help cm-return-hint" data-testid="return-hint">{tr('ui061')}</span>}
        <span className="cm-help">
          {target === 'any' && tr('ui062')}{tr('ui063')}{agentName}{tr('ui064')}</span>
      </form>
    </div>
  );
}
