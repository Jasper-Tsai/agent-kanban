import { t as tr, useLanguage, localizeGenerated } from '../i18n/index.ts';
import { useEffect, useState } from 'react';
import { PROJECT_ID_RE, PROJECT_PALETTE, PROJECT_STATUSES, type Project, type ProjectStatus } from '../../shared/constants.ts';
import { navigate } from '../lib/router.ts';
import { store, useStore } from '../store/store.ts';
import { ui, useUi } from '../store/ui.ts';

const projectStatusNames = (): Record<ProjectStatus, string> => ({ active: tr('ui138'), paused: tr('ui139'), archived: tr('ui140') });

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  useLanguage();
  return (
    <div className="swatches" role="radiogroup" aria-label={tr('ui141')}>
      {PROJECT_PALETTE.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value.toLowerCase() === c.toLowerCase()} aria-label={c} className="swatch-btn" style={{ background: c }} onClick={() => onChange(c)} />
      ))}
    </div>
  );
}

export function ProjectDialogs() {
  useLanguage();
  const { newProject, editProject } = useUi();
  const { projects } = useStore();
  if (newProject) return <NewProjectForm count={projects.length} />;
  const p = editProject ? projects.find((x) => x.id === editProject) : null;
  if (p) return <EditProjectForm project={p} />;
  return null;
}

function NewProjectForm({ count }: { count: number }) {
  useLanguage();
  const close = ui.closeNewProject;
  useEscape(close);
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [idTouched, setIdTouched] = useState(false);
  const [color, setColor] = useState<string>(PROJECT_PALETTE[count % PROJECT_PALETTE.length]);
  const [description, setDescription] = useState('');
  const [repo, setRepo] = useState('');
  const [url, setUrl] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const effectiveId = idTouched ? id : slugify(name);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setErr(tr('ui142'));
    if (!PROJECT_ID_RE.test(effectiveId)) return setErr(tr('ui143'));
    setBusy(true);
    try {
      const body: Record<string, unknown> = { id: effectiveId, name: name.trim(), color, description };
      if (repo.trim()) body.repo_path = repo.trim();
      if (url.trim()) body.url = url.trim();
      const r = await store.rest.post<{ project: Project }>('/projects', body);
      store.upsertProject(r.project);
      close();
      navigate(`/p/${r.project.id}`);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : tr('ui066'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-wrap" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="np-title" onSubmit={submit}>
        <h2 id="np-title">{tr('ui144')}</h2>
        <div className="form-grid">
          <label htmlFor="np-name">{tr('ui145')}</label>
          <input id="np-name" className="f-input sans" autoFocus maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('ui146')} />
          <label htmlFor="np-id">id</label>
          <input id="np-id" className="f-input" maxLength={40} value={effectiveId} onChange={(e) => { setIdTouched(true); setId(e.target.value); }} placeholder={tr('ui147')} />
          <label>{tr('ui148')}</label>
          <ColorPicker value={color} onChange={setColor} />
          <label htmlFor="np-desc">{tr('ui070')}</label>
          <input id="np-desc" className="f-input sans" maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={tr('ui149')} />
          <label htmlFor="np-repo">{tr('ui150')}</label>
          <input id="np-repo" className="f-input" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="/path/to/your/repo" />
          <label htmlFor="np-url">{tr('ui151')}</label>
          <input id="np-url" className="f-input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </div>
        {err && <div className="err" role="alert">{localizeGenerated(err)}</div>}
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={close}>{tr('ui075')}</button>
          <button type="submit" className="btn-primary" disabled={busy}>{tr('ui076')}</button>
        </div>
      </form>
    </div>
  );
}

function EditProjectForm({ project }: { project: Project }) {
  useLanguage();
  const close = ui.closeEditProject;
  useEscape(close);
  const [name, setName] = useState(project.name);
  const [color, setColor] = useState(project.color);
  const [description, setDescription] = useState(project.description);
  const [repo, setRepo] = useState(project.repo_path ?? '');
  const [url, setUrl] = useState(project.url ?? '');
  const [status, setStatus] = useState<ProjectStatus>(project.status);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setErr(tr('ui152'));
    setBusy(true);
    try {
      await store.patchProject(project.id, { name: name.trim(), color, description, repo_path: repo.trim() || null, url: url.trim() || null, status });
      close();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : tr('ui153'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-wrap" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="ep-title" onSubmit={submit}>
        <h2 id="ep-title">{tr('ui154')}<span className="mono muted small">{project.id}</span></h2>
        <div className="form-grid">
          <label htmlFor="ep-name">{tr('ui145')}</label>
          <input id="ep-name" className="f-input sans" autoFocus maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          <label>{tr('ui148')}</label>
          <ColorPicker value={color} onChange={setColor} />
          <label htmlFor="ep-desc">{tr('ui070')}</label>
          <input id="ep-desc" className="f-input sans" maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
          <label htmlFor="ep-repo">{tr('ui150')}</label>
          <input id="ep-repo" className="f-input" value={repo} onChange={(e) => setRepo(e.target.value)} />
          <label htmlFor="ep-url">{tr('ui151')}</label>
          <input id="ep-url" className="f-input" value={url} onChange={(e) => setUrl(e.target.value)} />
          <label htmlFor="ep-status">{tr('ui072')}</label>
          <select id="ep-status" className="f-input" value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
            {PROJECT_STATUSES.map((s) => <option key={s} value={s}>{projectStatusNames()[s]}</option>)}
          </select>
        </div>
        {err && <div className="err" role="alert">{localizeGenerated(err)}</div>}
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={close}>{tr('ui075')}</button>
          <button type="submit" className="btn-primary" disabled={busy}>{tr('ui155')}</button>
        </div>
      </form>
    </div>
  );
}
