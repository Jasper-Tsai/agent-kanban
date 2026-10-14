import { t as tr, te, localizeGenerated, statusLabel, agentLabel, useLanguage } from '../i18n/index.ts';
import { useEffect, useRef, useState } from 'react';
import { AGENTS, PRIORITIES, PRIORITY_LABEL, STATUSES, type Agent, type Priority, type Status } from '../../shared/constants.ts';
import { AppLink } from './common.tsx';
import { actorLabel, describeEvent } from '../lib/describe.ts';
import { navigate, useRoute } from '../lib/router.ts';
import { buildUrl } from '../lib/url-state.ts';
import { store, useStore } from '../store/store.ts';
import { ui, useUi } from '../store/ui.ts';

export function NewCardDialog() {
  useLanguage();
  const { newCard } = useUi();
  const { projects } = useStore();
  const route = useRoute();
  if (!newCard) return null;
  return <NewCardForm key="new" projects={projects.filter((p) => p.status !== 'archived')} initialProject={newCard.project ?? (route.view === 'project' ? route.projectId ?? undefined : undefined)} initialStatus={newCard.status} onDone={(id) => { ui.closeNewCard(); if (id) navigate(buildUrl({ ...route, card: id }), { replace: true }); }} />;
}

function NewCardForm({ projects, initialProject, initialStatus, onDone }: { projects: { id: string; name: string }[]; initialProject?: string; initialStatus?: Status; onDone: (id?: number) => void }) {
  useLanguage();
  const [project, setProject] = useState(initialProject && projects.some((p) => p.id === initialProject) ? initialProject : projects[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [status, setStatus] = useState<Status>(initialStatus ?? 'todo');
  const [agent, setAgent] = useState<Agent>('none');
  const [priority, setPriority] = useState<Priority>('p2');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onDone();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDone]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !project) { setErr(tr('ui065')); return; }
    setBusy(true);
    try {
      const c = await store.createCard({ project_id: project, title: title.trim(), description: desc, status, agent, priority });
      onDone(c.id);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : tr('ui066'));
    } finally {
      setBusy(false);
    }
  }
  const declarative = { toolname: 'kanban_create_card_form', tooldescription: te('ui067') } as Record<string, string>;
  return (
    <div className="modal-wrap" onMouseDown={(e) => e.target === e.currentTarget && onDone()}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="nc-title" onSubmit={submit} {...declarative}>
        <h2 id="nc-title">{tr('ui009')}</h2>
        <div className="form-grid">
          <label htmlFor="nc-project">{tr('ui002')}</label>
          <select id="nc-project" name="project_id" className="f-input" value={project} onChange={(e) => setProject(e.target.value)}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <label htmlFor="nc-t">{tr('ui068')}</label>
          <input id="nc-t" name="title" className="f-input sans" autoFocus maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={tr('ui069')} />
          <label htmlFor="nc-d">{tr('ui070')}</label>
          <textarea id="nc-d" name="description" className="desc-box" style={{ minHeight: 150 }} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={tr('ui071', tr('briefTemplate'))} />
          <label htmlFor="nc-s">{tr('ui072')}</label>
          <select id="nc-s" name="status" className="f-input" value={status} onChange={(e) => setStatus(e.target.value as Status)}>
            {STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
          </select>
          <label htmlFor="nc-a">{tr('ui073')}</label>
          <select id="nc-a" name="agent" className="f-input" value={agent} onChange={(e) => setAgent(e.target.value as Agent)}>
            {AGENTS.map((a) => <option key={a} value={a}>{agentLabel(a)}</option>)}
          </select>
          <label htmlFor="nc-p">{tr('ui074')}</label>
          <select id="nc-p" name="priority" className="f-input" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
          </select>
        </div>
        {err && <div className="err" role="alert">{localizeGenerated(err)}</div>}
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={() => onDone()}>{tr('ui075')}</button>
          <button type="submit" className="btn-primary" disabled={busy}>{tr('ui076')}</button>
        </div>
      </form>
    </div>
  );
}

export function ConfirmHost() {
  useLanguage();
  const { confirm } = useStore();
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!confirm) return;
    btn.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && confirm.resolve(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirm]);
  if (!confirm) return null;
  return (
    <div className="modal-wrap" style={{ zIndex: 70 }} onMouseDown={(e) => e.target === e.currentTarget && confirm.resolve(false)}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="cf-t" aria-describedby="cf-m">
        <h2 id="cf-t">{localizeGenerated(confirm.title)}</h2>
        <div id="cf-m" style={{ color: 'var(--text-2)' }}>{localizeGenerated(confirm.message)}</div>
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={() => confirm.resolve(false)}>{tr('ui075')}</button>
          <button ref={btn} type="button" className="btn-danger" onClick={() => confirm.resolve(true)}>{localizeGenerated(confirm.confirmLabel)}</button>
        </div>
      </div>
    </div>
  );
}

export function Toasts() {
  useLanguage();
  const { toasts } = useStore();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast${t.kind === 'error' ? ' error' : ''}`}>
          {t.actor && <span className="actor-name" data-actor={t.actor}>{actorLabel(t.actor)}</span>}
          <span>{t.event ? describeEvent(t.event) : localizeGenerated(t.text)}</span>
          {t.link && <AppLink to={t.link.to} className="toast-link" onClick={() => store.dismissToast(t.id)}>{localizeGenerated(t.link.label)}</AppLink>}
        </div>
      ))}
    </div>
  );
}
