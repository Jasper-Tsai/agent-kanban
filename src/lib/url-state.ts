import { AGENTS, PRIORITIES, PROJECT_ID_RE, type Agent, type Priority } from '../../shared/constants.ts';
import { EMPTY_FILTERS, type Filters } from './filters.ts';

export type View = 'overview' | 'board' | 'project' | 'activity';
export type Layout = 'flat' | 'swimlane';

export interface RouteState {
  view: View;
  projectId: string | null;
  layout: Layout;
  card: number | null;
  filters: Filters;
  
  activityActor: string;
  activityProject: string;
}

export const DEFAULT_ROUTE: RouteState = {
  view: 'overview',
  projectId: null,
  layout: 'flat',
  card: null,
  filters: EMPTY_FILTERS,
  activityActor: '',
  activityProject: '',
};

const truthy = (v: string | null) => v === '1' || v === 'true';

export function parseLocation(pathname: string, search: string): RouteState {
  const sp = new URLSearchParams(search);
  const state: RouteState = { ...DEFAULT_ROUTE, filters: { ...EMPTY_FILTERS } };
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/board') state.view = 'board';
  else if (path === '/activity') state.view = 'activity';
  else {
    const m = /^\/p\/([^/]+)$/.exec(path);
    if (m && PROJECT_ID_RE.test(decodeURIComponent(m[1]))) {
      state.view = 'project';
      state.projectId = decodeURIComponent(m[1]);
    }
  }
  if (sp.get('layout') === 'swimlane') state.layout = 'swimlane';
  const card = Number(sp.get('card'));
  if (Number.isInteger(card) && card > 0) state.card = card;

  const agent = sp.get('agent');
  const priority = sp.get('priority');
  state.filters = {
    q: sp.get('q') ?? '',
    agent: agent && (AGENTS as readonly string[]).includes(agent) ? (agent as Agent) : '',
    priority: priority && (PRIORITIES as readonly string[]).includes(priority) ? (priority as Priority) : '',
    blocked: truthy(sp.get('blocked')),
    needs_owner: truthy(sp.get('needs_owner')),
    tag: sp.get('tag') ?? '',
    dormant: truthy(sp.get('dormant')),
  };
  if (state.view === 'activity') {
    state.activityActor = sp.get('actor') ?? '';
    state.activityProject = sp.get('project') ?? '';
  }
  return state;
}

export function buildUrl(s: Partial<RouteState> & { view: View }): string {
  const sp = new URLSearchParams();
  let path = '/';
  if (s.view === 'board') path = '/board';
  else if (s.view === 'activity') path = '/activity';
  else if (s.view === 'project' && s.projectId) path = `/p/${encodeURIComponent(s.projectId)}`;
  if (s.view === 'board' && s.layout === 'swimlane') sp.set('layout', 'swimlane');
  if (s.view === 'board' || s.view === 'project') {
    const f = s.filters ?? EMPTY_FILTERS;
    if (f.q) sp.set('q', f.q);
    if (f.agent) sp.set('agent', f.agent);
    if (f.priority) sp.set('priority', f.priority);
    if (f.blocked) sp.set('blocked', '1');
    if (f.needs_owner) sp.set('needs_owner', '1');
    if (f.tag) sp.set('tag', f.tag);
    if (f.dormant && s.view === 'board') sp.set('dormant', '1');
  }
  if (s.view === 'activity') {
    if (s.activityActor) sp.set('actor', s.activityActor);
    if (s.activityProject) sp.set('project', s.activityProject);
  }
  if (s.card) sp.set('card', String(s.card));
  const qs = sp.toString();
  return qs ? `${path}?${qs}` : path;
}
