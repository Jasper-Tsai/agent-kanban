import { t as tr, useLanguage } from '../i18n/index.ts';
import { useEffect, useMemo, useState } from 'react';
import type { KanbanEvent } from '../../shared/constants.ts';
import { Board } from '../components/Board.tsx';
import { AppLink, projectsById, useIsMobile, useOpenCard } from '../components/common.tsx';
import { EventList } from '../components/EventList.tsx';
import { FilterBar } from '../components/FilterBar.tsx';
import { MobileBoard } from '../components/MobileBoard.tsx';
import { applyFilters, boardScope, type Filters } from '../lib/filters.ts';
import { formatLocalMD } from '../lib/time.ts';
import { navigate, useRoute } from '../lib/router.ts';
import { buildUrl } from '../lib/url-state.ts';
import { store, useStore } from '../store/store.ts';
import { ui } from '../store/ui.ts';

export function BoardPage() {
  useLanguage();
  const route = useRoute();
  const { cards, projects, loaded } = useStore();
  const { open } = useOpenCard();
  const isMobile = useIsMobile();
  const pid = route.view === 'project' ? route.projectId : null;
  const project = pid ? projects.find((p) => p.id === pid) : undefined;
  const pmap = useMemo(() => projectsById(projects), [projects]);
  
  const dormantCount = projects.filter((p) => p.status !== 'archived' && p.dormant).length;
  const scope = useMemo(() => (pid ? cards.filter((c) => c.project_id === pid) : boardScope(cards, projects, route.filters.dormant)), [cards, pid, projects, route.filters.dormant]);
  const filtered = useMemo(() => applyFilters(scope, route.filters), [scope, route.filters]);
  const onFilters = (f: Filters) => navigate(buildUrl({ ...route, filters: f }), { replace: true });

  if (pid && loaded && !project) {
    return <div className="empty-page">{tr('ui219')}{pid}”.<br /><AppLink to="/">{tr('ui220')}</AppLink></div>;
  }
  const board = isMobile ? (
    <MobileBoard cards={filtered} projectMap={pmap} openCardId={route.card} onOpen={open} fixedProject={pid ?? undefined} />
  ) : (
    <Board cards={filtered} projects={projects} projectMap={pmap} fixedProject={pid ?? undefined} openCardId={route.card} onOpen={open} mode={pid ? 'flat' : route.layout} forceBlockedOpen={route.filters.blocked} />
  );

  if (!pid) {
    return (
      <>
        <FilterBar
          title={tr('ui001')}
          filters={route.filters}
          onChange={onFilters}
          scopeCards={scope}
          dormantCount={dormantCount}
          right={
            <div className="segmented desktop-only" role="group" aria-label={tr('ui221')}>
              <button type="button" aria-pressed={route.layout === 'flat'} onClick={() => navigate(buildUrl({ ...route, layout: 'flat' }), { replace: true })}>{tr('ui222')}</button>
              <button type="button" aria-pressed={route.layout === 'swimlane'} onClick={() => navigate(buildUrl({ ...route, layout: 'swimlane' }), { replace: true })}>{tr('ui223')}</button>
            </div>
          }
        />
        <div className="board-scroll">{board}</div>
      </>
    );
  }
  return (
    <>
      <ProjectHeader project={project} />
      <FilterBar filters={route.filters} onChange={onFilters} scopeCards={scope} projectId={pid} />
      <div className="board-scroll">{board}</div>
      <ProjectActivity projectId={pid} />
    </>
  );
}

function ProjectHeader({ project }: { project?: ReturnType<typeof useStore>['projects'][number] }) {
  useLanguage();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (!editing) setText(project?.handoff ?? ''); }, [project?.handoff, editing]);
  if (!project) return <div className="proj-header muted">{tr('ui004')}</div>;
  async function save() {
    setSaving(true);
    try {
      await store.patchProject(project!.id, { handoff: text });
      setEditing(false);
    } catch (e) {
      store.error(e);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="proj-header">
      <div className="crumbs"><AppLink to="/" style={{ color: 'var(--muted)' }}>{tr('ui000')}</AppLink><span>/</span><span>{tr('ui002')}</span></div>
      <div className="proj-title-row">
        <span className="proj-swatch" style={{ background: project.color, width: 14, height: 14, borderRadius: 4 }} />
        <h1>{project.name}</h1>
        <span className="muted">{project.description}</span>
        {project.status === 'paused' && <span className="chip" data-agent="none">{tr('ui139')}</span>}
        {project.dormant && <span className="dormant-badge" data-testid="dormant-badge">{tr('ui224')}{project.dormant_since ? tr('ui225', formatLocalMD(project.dormant_since)) : ''}</span>}
        <button type="button" className="link-btn" onClick={() => ui.openEditProject(project.id)}>{tr('ui226')}</button>
        <span className="ml-auto mono small muted">
          {project.repo_path}
          {project.url && <> · <a href={project.url} target="_blank" rel="noreferrer">{project.url.replace(/^https?:\/\//, '')}</a></>}
        </span>
      </div>
      {project.status === 'archived' && <div className="banner-archived">{tr('ui227')}<button type="button" className="link-btn" style={{ marginLeft: 8 }} onClick={() => ui.openEditProject(project.id)}>{tr('ui228')}</button></div>}
      <div className="handoff-box">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="lbl">{tr('ui187')}</span>
          <button type="button" className="link-btn ml-auto" onClick={() => (editing ? setEditing(false) : setEditing(true))}>{editing ? tr('ui075') : tr('ui102')}</button>
        </div>
        {editing ? (
          <>
            <textarea aria-label={tr('ui187')} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
            <div className="modal-actions" style={{ marginTop: 8 }}>
              <button type="button" className="btn-primary" disabled={saving} onClick={() => void save()}>{tr('ui155')}</button>
            </div>
          </>
        ) : (
          <div className="handoff-text">{project.handoff || <span className="muted">{tr('ui229')}</span>}</div>
        )}
      </div>
    </div>
  );
}

function ProjectActivity({ projectId }: { projectId: string }) {
  useLanguage();
  const { projects } = useStore();
  const [events, setEvents] = useState<KanbanEvent[]>([]);
  useEffect(() => {
    let live = true;
    store.rest.get<{ events: KanbanEvent[] }>(`/events?project=${encodeURIComponent(projectId)}&limit=20`).then((r) => live && setEvents(r.events)).catch(() => {});
    const off = store.onEvent((e) => {
      if (e.project_id === projectId) setEvents((prev) => (prev.some((x) => x.id === e.id) ? prev : [e, ...prev].slice(0, 20)));
    });
    return () => { live = false; off(); };
  }, [projectId]);
  return (
    <section className="proj-activity" aria-label={tr('ui230')}>
      <h2>{tr('ui230')}</h2>
      <EventList events={events} projectMap={new Map(projects.map((p) => [p.id, p]))} showProject={false} />
    </section>
  );
}
