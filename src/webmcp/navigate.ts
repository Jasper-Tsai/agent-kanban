import { te as tr } from '../i18n/index.ts';
import { EMPTY_FILTERS, type Filters } from '../lib/filters.ts';
import { buildUrl, type Layout, type View } from '../lib/url-state.ts';

export interface NavigateInput {
  view: View;
  layout?: 'flat' | 'swimlane';
  project?: string;
  card?: number;
  filters?: Partial<Filters>;
}


export function buildNavigateUrl(input: NavigateInput): string {
  const views: View[] = ['overview', 'board', 'project', 'activity'];
  if (!views.includes(input.view)) throw new Error(tr('ui271', views.join('|')));
  if (input.view === 'project' && !input.project) throw new Error(tr('ui272'));
  const layout: Layout = input.layout === 'swimlane' ? 'swimlane' : 'flat';
  return buildUrl({
    view: input.view,
    layout,
    projectId: input.project ?? null,
    activityProject: input.view === 'activity' ? (input.project ?? '') : '',
    card: input.card && Number.isInteger(input.card) ? input.card : null,
    filters: { ...EMPTY_FILTERS, ...(input.filters ?? {}) },
  });
}
