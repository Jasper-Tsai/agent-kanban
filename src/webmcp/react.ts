import { t as tr, te, useLanguage } from '../i18n/index.ts';
import { useEffect, useRef, useState } from 'react';
import type { Project } from '../../shared/constants.ts';
import { createRestClient } from '../lib/api.ts';
import { currentRoute, navigate } from '../lib/router.ts';
import type { RouteState } from '../lib/url-state.ts';
import { hasActiveFilters } from '../lib/filters.ts';
import { store } from '../store/store.ts';
import { createKanbanWebMCP, detectModelContext, type KanbanWebMCP } from './index.ts';

export function describeContext(route: RouteState, projects: Project[]): string {
  switch (route.view) {
    case 'overview':
      return te('ui273');
    case 'board':
      return te('ui274', route.layout === 'swimlane' ? te('ui223') : te('ui222'));
    case 'activity':
      return te('ui275');
    case 'project': {
      const p = projects.find((x) => x.id === route.projectId);
      return te('ui276', route.projectId, p ? ` (${p.name})` : '');
    }
  }
}

function getView() {
  const r = currentRoute();
  const p = store.getState().projects.find((x) => x.id === r.projectId);
  return {
    url: `${window.location.pathname}${window.location.search}`,
    view: r.view,
    layout: r.view === 'board' ? r.layout : null,
    project_id: r.projectId,
    project_name: p?.name ?? null,
    open_card: r.card,
    filters: hasActiveFilters(r.filters) ? r.filters : null,
  };
}


export function useWebMCP(loggedIn: boolean, route: RouteState, projects: Project[]): { supported: boolean; tools: number } {
  const language = useLanguage();
  const ctl = useRef<KanbanWebMCP | null>(null);
  const [status, setStatus] = useState({ supported: false, tools: 0 });
  if (!ctl.current && typeof document !== 'undefined') {
    ctl.current = createKanbanWebMCP({
      modelContext: detectModelContext(document as any, navigator as any),
      rest: createRestClient({ actor: 'webmcp', onUnauthorized: () => store.logout() }),
      getView,
      navigate: (url) => navigate(url),
      confirmArchive: (card) =>
        store.confirm({ title: tr('ui277'), message: tr('ui278', card.id, card.title), confirmLabel: tr('ui279') }),
      debugTarget: window as any,
      onChange: (s) => setStatus({ supported: s.supported, tools: s.tools.length }),
    });
  }
  const projectName = route.view === 'project' ? projects.find((p) => p.id === route.projectId)?.name : '';
  const context = describeContext(route, projects.length ? projects : []);
  useEffect(() => {
    const c = ctl.current!;
    if (loggedIn) void c.register(context);
    else c.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn, route.view, route.projectId, route.view === 'board' ? route.layout : '', projectName, language]);
  useEffect(() => () => ctl.current?.dispose(), []);
  return status;
}
