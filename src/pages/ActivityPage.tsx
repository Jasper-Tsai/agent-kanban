import { t as tr, useLanguage } from '../i18n/index.ts';
import { useCallback, useEffect, useState } from 'react';
import { ACTORS } from '../../shared/constants.ts';
import type { KanbanEvent } from '../../shared/constants.ts';
import { EventList } from '../components/EventList.tsx';
import { actorLabel } from '../lib/describe.ts';
import { qs } from '../lib/api.ts';
import { navigate, useRoute } from '../lib/router.ts';
import { buildUrl } from '../lib/url-state.ts';
import { store, useStore } from '../store/store.ts';

export function ActivityPage() {
  useLanguage();
  const route = useRoute();
  const { projects } = useStore();
  const [events, setEvents] = useState<KanbanEvent[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const { activityActor: actor, activityProject: project } = route;

  const load = useCallback(
    async (before?: number) => {
      setLoading(true);
      try {
        const r = await store.rest.get<{ events: KanbanEvent[]; next_before: number | null }>(`/events${qs({ limit: 50, actor, project, before })}`);
        setEvents((prev) => (before ? [...prev, ...r.events] : r.events));
        setNext(r.next_before);
      } catch (e) {
        store.error(e);
      } finally {
        setLoading(false);
      }
    },
    [actor, project],
  );
  useEffect(() => { void load(); }, [load]);
  useEffect(
    () =>
      store.onEvent((e) => {
        if ((actor && e.actor !== actor) || (project && e.project_id !== project)) return;
        setEvents((prev) => (prev.some((x) => x.id === e.id) ? prev : [e, ...prev]));
      }),
    [actor, project],
  );
  const pmap = new Map(projects.map((p) => [p.id, p]));
  const setFilter = (p: { actor?: string; project?: string }) =>
    navigate(buildUrl({ view: 'activity', activityActor: p.actor ?? actor, activityProject: p.project ?? project, card: route.card }), { replace: true });

  return (
    <>
      <header className="page-head">
        <h1 className="page-title">{tr('ui003')}</h1>
        <div className="pills">
          <select className="pill" aria-label={tr('ui215')} value={actor} onChange={(e) => setFilter({ actor: e.target.value })}>
            <option value="">{tr('ui216')}</option>
            {ACTORS.map((a) => <option key={a} value={a}>{actorLabel(a)}</option>)}
          </select>
          <select className="pill" aria-label={tr('ui217')} value={project} onChange={(e) => setFilter({ project: e.target.value })}>
            <option value="">{tr('ui006')}</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </header>
      <div className="activity">
        <EventList events={events} projectMap={pmap} />
        {loading && <div className="muted small">{tr('ui004')}</div>}
        {next != null && !loading && <button type="button" className="more-btn" style={{ margin: 0 }} onClick={() => void load(next)}>{tr('ui218')}</button>}
      </div>
    </>
  );
}
