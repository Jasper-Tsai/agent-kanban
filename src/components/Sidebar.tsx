import { LanguageToggle } from './LanguageToggle.tsx';
import { t as tr, useLanguage } from '../i18n/index.ts';
import { useEffect, useState } from 'react';
import type { Card, Project } from '../../shared/constants.ts';
import { navigate, useRoute } from '../lib/router.ts';
import { splitProjects } from '../lib/dormant.ts';
import { formatLocalMD, formatLocalTime } from '../lib/time.ts';
import { store } from '../store/store.ts';
import { AppLink, IconActivity, IconBoard, IconChevronDown, IconGrid, IconPlus, IconSearch, IconSidebar, Logo } from './common.tsx';
import { ui } from '../store/ui.ts';

export interface WebMcpStatus {
  supported: boolean;
  tools: number;
}

const KEY = 'kanban.sidebar.collapsed';
function readCollapsed() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

const DORMANT_KEY = 'kanban.sidebar.dormant.open';
function readDormantOpen() {
  try {
    return localStorage.getItem(DORMANT_KEY) === '1';
  } catch {
    return false;
  }
}


export function SearchButton({ onNavigate }: { onNavigate?: () => void }) {
  useLanguage();
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  return (
    <button type="button" className="search-trigger" onClick={() => { ui.openSearch(); onNavigate?.(); }} title={tr('ui161')}>
      <IconSearch />
      <span className="st-label">{tr('ui161')}</span>
      <kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
    </button>
  );
}

export function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  useLanguage();
  const route = useRoute();
  const item = (to: string, view: string, icon: React.ReactNode, label: string) => (
    <AppLink to={to} className="nav-item" aria-current={route.view === view ? 'page' : undefined} onClick={onNavigate} title={label}>
      {icon}
      <span className="nav-label">{label}</span>
    </AppLink>
  );
  return (
    <div className="nav">
      {item('/', 'overview', <IconGrid />, tr('ui000'))}
      {item('/board', 'board', <IconBoard />, tr('ui001'))}
      {item('/activity', 'activity', <IconActivity />, tr('ui003'))}
    </div>
  );
}

export function ProjectLinks({ projects, cards, onNavigate }: { projects: Project[]; cards: Card[]; onNavigate?: () => void }) {
  useLanguage();
  const route = useRoute();
  const { active, dormant } = splitProjects(projects);
  const currentDormant = route.view === 'project' && dormant.some((p) => p.id === route.projectId);
  
  const [openPref, setOpenPref] = useState(readDormantOpen);
  const dormantOpen = openPref || currentDormant;
  const toggleDormant = () => {
    const next = !dormantOpen;
    setOpenPref(next);
    try {
      localStorage.setItem(DORMANT_KEY, next ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
  return (
    <>
      <div className="nav">
        <div className="nav-title-row">
          <div className="nav-title">{tr('ui002')}</div>
          <button type="button" className="icon-btn nav-add" aria-label={tr('ui144')} title={tr('ui144')} onClick={() => { ui.openNewProject(); onNavigate?.(); }}>
            <IconPlus size={14} />
          </button>
        </div>
        {active.map((p) => {
          const doing = cards.filter((c) => c.project_id === p.id && c.status === 'in_progress').length;
          return (
            <AppLink key={p.id} to={`/p/${p.id}`} className="proj-item" aria-current={route.view === 'project' && route.projectId === p.id ? 'page' : undefined} onClick={onNavigate} title={p.name}>
              <span className="proj-swatch" style={{ background: p.color }} />
              <span className="proj-name ellipsis" style={{ flex: 1 }}>{p.name}</span>
              <span className="proj-count">{doing}</span>
            </AppLink>
          );
        })}
      </div>
      {dormant.length > 0 && (
        <div className="nav dormant-group" data-testid="dormant-group">
          <button type="button" className="dormant-head" aria-expanded={dormantOpen} aria-controls="dormant-list" onClick={toggleDormant}>
            <IconChevronDown open={dormantOpen} />
            <span className="proj-name">{tr('ui175')}{dormant.length})</span>
          </button>
          {dormantOpen && (
            <div id="dormant-list" className="nav">
              {dormant.map((p) => (
                <AppLink key={p.id} to={`/p/${p.id}`} className="proj-item dormant" aria-current={route.view === 'project' && route.projectId === p.id ? 'page' : undefined} onClick={onNavigate} title={p.name}>
                  <span className="proj-swatch" style={{ background: p.color }} />
                  <span className="proj-name ellipsis" style={{ flex: 1 }}>{p.name}</span>
                  <span className="proj-count">{p.dormant_since ? formatLocalMD(p.dormant_since) : ''}</span>
                </AppLink>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

export function StatusBox({ webmcp, connected, lastSyncAt }: { webmcp: WebMcpStatus; connected: boolean; lastSyncAt: string | null }) {
  useLanguage();
  return (
    <div className="status-box" aria-live="polite">
      <div className="status-row" id="webmcp-status">
        <span className={`status-dot${webmcp.supported && webmcp.tools > 0 ? '' : ' off'}`} />
        {webmcp.supported ? tr('ui176', webmcp.tools) : tr('ui177')}
      </div>
      <div className="status-row muted" style={{ color: 'var(--muted)' }}>
        <span className={`status-dot${connected ? '' : ' bad'}`} />
        {connected ? tr('ui178', formatLocalTime(lastSyncAt ?? new Date())) : tr('ui179')}
      </div>
      <button type="button" className="link-btn" onClick={() => void store.logout().then(() => navigate('/'))}>{tr('ui180')}</button>
    </div>
  );
}

export function Sidebar({ projects, cards, webmcp, connected, lastSyncAt }: { projects: Project[]; cards: Card[]; webmcp: WebMcpStatus; connected: boolean; lastSyncAt: string | null }) {
  useLanguage();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, collapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [collapsed]);
  return (
    <nav className={`sidebar${collapsed ? ' collapsed' : ''}`} aria-label={tr('ui012')}>
      <div className="brand">
        <Logo />
        <span className="brand-name">Agent Kanban</span>
        <button type="button" className="icon-btn" aria-label={collapsed ? tr('ui181') : tr('ui182')} aria-pressed={collapsed} onClick={() => setCollapsed((v) => !v)}>
          <IconSidebar />
        </button>
      </div>
      <LanguageToggle />
      <SearchButton />
      <NavLinks />
      <ProjectLinks projects={projects} cards={cards} />
      <StatusBox webmcp={webmcp} connected={connected} lastSyncAt={lastSyncAt} />
    </nav>
  );
}
