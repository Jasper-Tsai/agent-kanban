import { LanguageToggle } from './components/LanguageToggle.tsx';
import { t as tr, useLanguage } from './i18n/index.ts';
import { useEffect } from 'react';
import { Drawer } from './components/Drawer.tsx';
import { ConfirmHost, NewCardDialog, Toasts } from './components/Dialogs.tsx';
import { SearchOverlay } from './components/SearchOverlay.tsx';
import { ProjectDialogs } from './components/ProjectDialogs.tsx';
import { AppLink, IconMenu, IconPlus, isTypingTarget, useOpenCard } from './components/common.tsx';
import { NavLinks, ProjectLinks, SearchButton, Sidebar, StatusBox } from './components/Sidebar.tsx';
import { ActivityPage } from './pages/ActivityPage.tsx';
import { BoardPage } from './pages/BoardPage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { OverviewPage } from './pages/OverviewPage.tsx';
import { useRoute } from './lib/router.ts';
import { store, useStore } from './store/store.ts';
import { ui, useUi } from './store/ui.ts';
import { useWebMCP } from './webmcp/react.ts';

const viewLabels = () => ({ overview: tr('ui000'), board: tr('ui001'), project: tr('ui002'), activity: tr('ui003') } as const);

export function App() {
  const language = useLanguage();
  const s = useStore();
  const route = useRoute();
  const { menuOpen, newCard, search } = useUi();
  const { close } = useOpenCard();
  const webmcp = useWebMCP(s.auth === 'in', route, s.projects);

  useEffect(() => { void store.init(); }, []);

  useEffect(() => {
    const p = route.view === 'project' ? s.projects.find((x) => x.id === route.projectId)?.name : null;
    document.title = `${p ?? viewLabels()[route.view]} · Agent Kanban`;
  }, [route.view, route.projectId, s.projects, language]);

  useEffect(() => {
    if (s.auth !== 'in') return;
    const onKey = (e: KeyboardEvent) => {
      
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (ui.get().search) ui.closeSearch();
        else ui.openSearch();
        return;
      }
      if (ui.get().search) return; 
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') {
        
        if (e.isComposing) return;
        if (isTypingTarget(e.target)) { e.preventDefault(); return; }
        if (store.getState().confirm || ui.get().newCard || ui.get().newProject || ui.get().editProject) return;
        if (route.card) close();
        else if (ui.get().menuOpen) ui.toggleMenu(false);
        return;
      }
      if (isTypingTarget(e.target) || e.isComposing) return;
      if (e.key === '/') {
        const el = document.getElementById('search-input');
        if (el) { e.preventDefault(); (el as HTMLInputElement).focus(); }
      } else if (e.key === 'n') {
        e.preventDefault();
        ui.openNewCard({ project: route.view === 'project' ? route.projectId ?? undefined : undefined });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [s.auth, route.card, route.view, route.projectId]);

  if (s.auth === 'loading') return <div className="empty-page">{tr('ui004')}</div>;
  if (s.auth === 'out') return <LoginPage offline={s.error} />;

  const project = route.view === 'project' ? s.projects.find((p) => p.id === route.projectId) : null;
  const sub = route.view === 'project' ? tr('ui002') : viewLabels()[route.view];
  const mainTitle = route.view === 'project' ? project?.name ?? route.projectId ?? '' : route.view === 'board' ? tr('ui005') : route.view === 'overview' ? tr('ui006') : tr('ui007');

  return (
    <div className="app">
      <Sidebar projects={s.projects} cards={s.cards} webmcp={webmcp} connected={s.connected} lastSyncAt={s.lastSyncAt} />
      <main className="main">
        <div className="m-header">
          <LanguageToggle />
          <button type="button" className="square" aria-label={tr('ui008')} aria-expanded={menuOpen} onClick={() => ui.toggleMenu()}><IconMenu /></button>
          <div className="ttl"><div className="sub">{sub}</div><div className="main-t ellipsis">{mainTitle}</div></div>
          <button type="button" className="square primary" aria-label={tr('ui009')} onClick={() => ui.openNewCard({ project: route.projectId ?? undefined })}><IconPlus size={18} w={2.4} /></button>
          {menuOpen && (
            <div className="m-drop">
              <SearchButton onNavigate={() => ui.toggleMenu(false)} />
              <NavLinks onNavigate={() => ui.toggleMenu(false)} />
              <ProjectLinks projects={s.projects} cards={s.cards} onNavigate={() => ui.toggleMenu(false)} />
              <StatusBox webmcp={webmcp} connected={s.connected} lastSyncAt={s.lastSyncAt} />
            </div>
          )}
        </div>
        {!s.loaded ? (
          <div className="empty-page">
            {s.error ? (
              <>
                <p className="err" role="alert">{tr('ui010')}{s.error}</p>
                <button type="button" className="btn-primary" onClick={() => { void store.retryInitialLoad(); }}>{tr('ui011')}</button>
              </>
            ) : tr('ui004')}
          </div>
        ) : route.view === 'overview' ? (
          <OverviewPage />
        ) : route.view === 'activity' ? (
          <ActivityPage />
        ) : (
          <BoardPage />
        )}
      </main>
      <nav className="m-nav" aria-label={tr('ui012')}>
        <AppLink to="/" aria-current={route.view === 'overview' ? 'page' : undefined}>{tr('ui000')}</AppLink>
        <AppLink to="/board" aria-current={route.view === 'board' || route.view === 'project' ? 'page' : undefined}>{tr('ui013')}</AppLink>
        <AppLink to="/activity" aria-current={route.view === 'activity' ? 'page' : undefined}>{tr('ui003')}</AppLink>
      </nav>
      {route.card && s.loaded && <Drawer key={route.card} id={route.card} onClose={close} />}
      {newCard && <NewCardDialog />}
      {search && <SearchOverlay />}
      <ProjectDialogs />
      <ConfirmHost />
      <Toasts />
    </div>
  );
}
