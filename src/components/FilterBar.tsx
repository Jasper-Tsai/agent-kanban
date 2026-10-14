import { t as tr, agentLabel, useLanguage } from '../i18n/index.ts';
import { AGENTS, PRIORITIES, PRIORITY_LABEL, type Agent, type Card, type Priority } from '../../shared/constants.ts';
import { allTags, hasActiveFilters, EMPTY_FILTERS, type Filters } from '../lib/filters.ts';
import { IconFilter, IconPlus, IconSearch } from './common.tsx';
import { ui } from '../store/ui.ts';

export function FilterBar({ filters, onChange, scopeCards, title, right, projectId, dormantCount }: { filters: Filters; onChange: (f: Filters) => void; scopeCards: Card[]; title?: string; right?: React.ReactNode; projectId?: string; dormantCount?: number }) {
  useLanguage();
  const open = scopeCards.filter((c) => c.status !== 'done');
  const blockedN = open.filter((c) => c.blocked).length;
  const askN = open.filter((c) => c.needs_owner).length;
  const tags = allTags(scopeCards);
  const set = (p: Partial<Filters>) => onChange({ ...filters, ...p });
  return (
    <header className="page-head">
      {title && <h1 className="page-title">{title}</h1>}
      {right}
      <label className="search">
        <IconSearch />
        <input
          id="search-input"
          type="search"
          placeholder={tr('ui113')}
          aria-label={tr('ui114')}
          value={filters.q}
          onChange={(e) => set({ q: e.target.value })}
        />
        <kbd>/</kbd>
      </label>
      <div className="pills">
        <select className="pill" aria-label="Agent" value={filters.agent} onChange={(e) => set({ agent: e.target.value as Agent | '' })}>
          <option value="">{tr('ui115')}</option>
          {AGENTS.map((a) => (
            <option key={a} value={a}>Agent: {agentLabel(a)}</option>
          ))}
        </select>
        <select className="pill" aria-label={tr('ui074')} value={filters.priority} onChange={(e) => set({ priority: e.target.value as Priority | '' })}>
          <option value="">{tr('ui116')}</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>{tr('ui117')}{PRIORITY_LABEL[p]}</option>
          ))}
        </select>
        {tags.length > 0 && (
          <select className="pill" aria-label={tr('ui096')} value={filters.tag} onChange={(e) => set({ tag: e.target.value })}>
            <option value="">{tr('ui118')}</option>
            {tags.map((t) => (
              <option key={t} value={t}>{tr('ui119')}{t}</option>
            ))}
          </select>
        )}
        <button type="button" className="pill blocked" aria-pressed={filters.blocked} onClick={() => set({ blocked: !filters.blocked })}>{tr('ui120')}{blockedN}
        </button>
        <button type="button" className="pill ask" aria-pressed={filters.needs_owner} onClick={() => set({ needs_owner: !filters.needs_owner })}>{tr('ui121')}{askN}
        </button>
        {dormantCount !== undefined && (dormantCount > 0 || filters.dormant) && (
          <button type="button" className="pill dormant-toggle" aria-pressed={filters.dormant} aria-label={tr('ui122', dormantCount)} onClick={() => set({ dormant: !filters.dormant })}>
            <IconFilter />
            <span className="dt-long" aria-hidden="true">{tr('ui123')}{dormantCount})</span>
            <span className="dt-short" aria-hidden="true">{tr('ui124')}{dormantCount}</span>
          </button>
        )}
        {hasActiveFilters(filters) && (
          <button type="button" className="pill clear" onClick={() => onChange({ ...EMPTY_FILTERS })} aria-label={tr('ui125')}>
            <span className="dt-long" aria-hidden="true">{tr('ui125')}</span>
            <span className="dt-short" aria-hidden="true">{tr('ui126')}</span>
          </button>
        )}
      </div>
      <button type="button" className="btn-primary ml-auto desktop-only" onClick={() => ui.openNewCard({ project: projectId })}>
        <IconPlus />{tr('ui127')}</button>
    </header>
  );
}
