import { t as tr, statusLabel, agentLabel, useLanguage } from '../i18n/index.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type Card, type Project, type SearchMatch, type SearchResult } from '../../shared/constants.ts';
import { groupSearch, moveSelection } from '../lib/dormant.ts';
import { currentRoute, navigate } from '../lib/router.ts';
import { formatLocalMD } from '../lib/time.ts';
import { buildUrl } from '../lib/url-state.ts';
import { store, useStore } from '../store/store.ts';
import { ui } from '../store/ui.ts';
import { IconSearch } from './common.tsx';

type Item = { kind: 'project'; project: Project } | { kind: 'card'; card: Card & { match: SearchMatch } };

const matchLabels = (): Record<SearchMatch, string> => ({ id: tr('ui156'), title: '', description: tr('ui070'), branch: tr('ui092'), tag: tr('ui096'), comment: tr('ui053') });


export function SearchOverlay() {
  useLanguage();
  const { projects } = useStore();
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const opener = useRef<Element | null>(typeof document !== 'undefined' ? document.activeElement : null);

  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      const el = opener.current as HTMLElement | null;
      if (el && el.isConnected && typeof el.focus === 'function') el.focus();
    };
  }, []);

  
  useEffect(() => {
    const text = q.trim();
    const my = ++seq.current;
    if (!text) {
      setResult(null);
      setFailed(false);
      return;
    }
    const t = setTimeout(() => {
      store.rest
        .get<SearchResult>(`/search?q=${encodeURIComponent(text)}&include_archived=${archived ? '1' : '0'}`)
        .then((r) => { if (my === seq.current) { setResult(r); setFailed(false); setSel(0); } })
        .catch(() => { if (my === seq.current) setFailed(true); });
    }, 200);
    return () => clearTimeout(t);
  }, [q, archived]);

  const groups = useMemo(() => (result ? groupSearch(result, projects) : []), [result, projects]);
  const items: Item[] = useMemo(
    () => [...(result?.projects ?? []).map((p): Item => ({ kind: 'project', project: p })), ...groups.flatMap((g) => g.cards.map((card): Item => ({ kind: 'card', card })))],
    [result, groups],
  );

  function choose(it: Item | undefined) {
    if (!it) return;
    ui.closeSearch();
    if (it.kind === 'project') navigate(`/p/${encodeURIComponent(it.project.id)}`);
    else navigate(buildUrl({ ...currentRoute(), card: it.card.id }));
  }

  
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        ui.closeSearch();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSel((i) => moveSelection(i, e.key === 'ArrowDown' ? 1 : -1, items.length));
      } else if (e.key === 'Enter' && !e.isComposing && (e.target as HTMLElement | null)?.tagName !== 'BUTTON') {
        if (items.length) {
          e.preventDefault();
          choose(items[Math.min(sel, items.length - 1)]);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [sel, items]);

  const pmap = new Map(projects.map((p) => [p.id, p]));
  const activeId = items.length ? `sr-${Math.min(sel, items.length - 1)}` : undefined;
  let idx = -1;
  const row = (it: Item) => {
    idx += 1;
    const i = idx;
    const on = i === Math.min(sel, items.length - 1);
    if (it.kind === 'project') {
      const p = it.project;
      return (
        <a key={`p-${p.id}`} id={`sr-${i}`} role="option" aria-selected={on} className="sr-row" href={`/p/${p.id}`} onMouseMove={() => setSel(i)} onClick={(e) => { e.preventDefault(); choose(it); }}>
          <span className="sr-id" />
          <span className="sr-title ellipsis">{p.name}<span className="muted">{tr('ui157')}</span></span>
          {p.dormant && <span className="dormant-tag">{tr('ui030')}</span>}
        </a>
      );
    }
    const c = it.card;
    return (
      <a key={`c-${c.id}`} id={`sr-${i}`} role="option" aria-selected={on} className="sr-row" data-card-id={c.id} href={buildUrl({ ...currentRoute(), card: c.id })} onMouseMove={() => setSel(i)} onClick={(e) => { e.preventDefault(); choose(it); }}>
        <span className="sr-id">#{c.id}</span>
        <span className="sr-title ellipsis">
          {c.title}
          {c.match !== 'title' && c.match !== 'id' && <span className="sr-match">{tr('ui158')}{matchLabels()[c.match]}</span>}
        </span>
        {c.archived && <span className="sr-arch">{tr('ui159')}</span>}
        <span className="chip" data-agent={c.agent}>{agentLabel(c.agent)}</span>
        <span className="st-chip" data-status={c.status}>{statusLabel(c.status)}</span>
        <span className="sr-when" title={tr('ui160')}>{formatLocalMD(c.updated_at)}</span>
      </a>
    );
  };

  return (
    <div className="search-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) ui.closeSearch(); }}>
      <div className="search-dialog" role="dialog" aria-modal="true" aria-label={tr('ui161')}>
        <div className="sd-head">
          <IconSearch />
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls="sr-list"
            aria-activedescendant={activeId}
            aria-label={tr('ui114')}
            placeholder={tr('ui162')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoComplete="off"
          />
          <label className="sd-arch"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />{tr('ui163')}</label>
        </div>
        <div className="sd-body" id="sr-list" role="listbox" aria-label={tr('ui164')} ref={listRef}>
          {!q.trim() && <div className="sd-empty">{tr('ui165')}</div>}
          {q.trim() && failed && <div className="sd-empty">{tr('ui166')}</div>}
          {q.trim() && !failed && result && items.length === 0 && <div className="sd-empty" data-testid="search-empty">{tr('ui167')}{result.q}{tr('ui168')}</div>}
          {(result?.projects.length ?? 0) > 0 && (
            <>
              <div className="sd-group">{tr('ui002')}</div>
              {result!.projects.map((p) => row({ kind: 'project', project: p }))}
            </>
          )}
          {groups.map((g) => (
            <div key={g.project_id} role="group" aria-label={g.name}>
              <div className="sd-group">
                <span className="swatch" style={{ background: g.color }} />
                {g.name}
                {g.dormant && <span className="dormant-tag">{tr('ui030')}</span>}
                {!pmap.has(g.project_id) && <span className="muted">{tr('ui169')}</span>}
              </div>
              {g.cards.map((card) => row({ kind: 'card', card }))}
            </div>
          ))}
          {result?.truncated && <div className="sd-empty">{tr('ui170')}</div>}
        </div>
        <div className="sd-foot">
          <span>{tr('ui171')}</span><span>{tr('ui172')}</span><span>{tr('ui173')}</span><span className="ml-auto">{tr('ui174')}</span>
        </div>
      </div>
    </div>
  );
}
