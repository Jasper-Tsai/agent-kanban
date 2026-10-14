// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { ApiFailure } from '../src/lib/api.ts';
import { navigate } from '../src/lib/router.ts';
import { KanbanStore, store } from '../src/store/store.ts';
import { ui } from '../src/store/ui.ts';

vi.mock('../src/components/Drawer.tsx', () => ({
  Drawer: () => <aside className="drawer" aria-label="Card details"><textarea aria-label="Comment draft" defaultValue="Unsubmitted draft" /></aside>,
}));
vi.mock('../src/components/Dialogs.tsx', () => ({ ConfirmHost: () => null, NewCardDialog: () => null, Toasts: () => null }));
vi.mock('../src/components/SearchOverlay.tsx', () => ({ SearchOverlay: () => null }));
vi.mock('../src/components/ProjectDialogs.tsx', () => ({ ProjectDialogs: () => null }));
vi.mock('../src/components/Sidebar.tsx', () => ({
  NavLinks: () => null, ProjectLinks: () => null, SearchButton: () => null, Sidebar: () => <aside>sidebar</aside>, StatusBox: () => null,
}));
vi.mock('../src/pages/ActivityPage.tsx', () => ({ ActivityPage: () => <div>activity</div> }));
vi.mock('../src/pages/BoardPage.tsx', () => ({ BoardPage: () => <div>board</div> }));
vi.mock('../src/pages/LoginPage.tsx', () => ({ LoginPage: () => <div>login</div> }));
vi.mock('../src/pages/OverviewPage.tsx', () => ({ OverviewPage: () => <div>overview</div> }));
vi.mock('../src/webmcp/react.ts', () => ({ useWebMCP: () => ({}) }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) { this.url = url; FakeEventSource.instances.push(this); }
  addEventListener() {}
  close() { this.closed = true; }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe("Initial load failure recovery", () => {
  it("Preserve authentication and create SSE only after successful retry", async () => {
    let projectCalls = 0;
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.endsWith('/auth/login')) return response({ ok: true });
      if (input.endsWith('/projects')) {
        projectCalls += 1;
        return projectCalls === 1 ? response({ error: { message: "Projects temporarily unavailable" } }, 503) : response({ projects: [] });
      }
      if (input.endsWith('/cards')) return response({ cards: [] });
      throw new Error(`unexpected request: ${input}`);
    });
    vi.stubGlobal('EventSource', FakeEventSource);
    FakeEventSource.instances = [];
    const instance = new KanbanStore(fetchImpl as any);

    await expect(instance.login('correct password')).rejects.toMatchObject({ status: 503 });
    expect(instance.getState()).toMatchObject({ auth: 'in', loaded: false, error: "Projects temporarily unavailable", connected: false });
    expect(FakeEventSource.instances).toHaveLength(0);

    await instance.retryInitialLoad();
    expect(instance.getState()).toMatchObject({ auth: 'in', loaded: true, error: null });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe('/api/v1/stream');
  });

  it("Unauthorized initial load clears authentication and preserves error", async () => {
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.endsWith('/auth/me')) return response({ ok: true });
      if (input.endsWith('/projects')) return response({ error: { message: "Session expired" } }, 401);
      if (input.endsWith('/cards')) return response({ cards: [] });
      throw new Error(`unexpected request: ${input}`);
    });
    vi.stubGlobal('EventSource', FakeEventSource);
    FakeEventSource.instances = [];
    const instance = new KanbanStore(fetchImpl as any);

    await instance.init();
    expect(instance.getState()).toMatchObject({ auth: 'out', loaded: false, error: "Session expired", connected: false });
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("Unauthorized load after login clears authentication", async () => {
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.endsWith('/auth/login')) return response({ ok: true });
      if (input.endsWith('/projects')) return response({ error: { message: 'Session expired' } }, 401);
      if (input.endsWith('/cards')) return response({ cards: [] });
      throw new Error(`unexpected request: ${input}`);
    });
    vi.stubGlobal('EventSource', FakeEventSource);
    FakeEventSource.instances = [];
    const instance = new KanbanStore(fetchImpl as any);

    await expect(instance.login('password')).rejects.toMatchObject({ status: 401 });
    expect(instance.getState()).toMatchObject({ auth: 'out', loaded: false, error: 'Session expired', connected: false });
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("Unauthorized retry closes SSE and returns to login", async () => {
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.endsWith('/projects')) return response({ error: { message: 'Session expired' } }, 401);
      if (input.endsWith('/cards')) return response({ cards: [] });
      throw new Error(`unexpected request: ${input}`);
    });
    vi.stubGlobal('EventSource', FakeEventSource);
    FakeEventSource.instances = [];
    const instance = new KanbanStore(fetchImpl as any);
    instance.state = { ...instance.getState(), auth: 'in', loaded: false };
    instance.connect();
    const eventSource = FakeEventSource.instances[0];

    await instance.retryInitialLoad();
    expect(eventSource.closed).toBe(true);
    expect(instance.getState()).toMatchObject({ auth: 'out', loaded: false, error: 'Session expired', connected: false });
  });

  it("App provides an actionable retry screen", async () => {
    const get = vi.spyOn(store.rest, 'get').mockImplementation(async (path: string) => {
      if (path === '/projects') return { projects: [] } as any;
      if (path === '/cards') return { cards: [] } as any;
      throw new Error(`unexpected request: ${path}`);
    });
    vi.spyOn(store, 'init').mockResolvedValue();
    store.state = { ...store.state, auth: 'in', loaded: false, error: 'HTTP 503', projects: [], cards: [], connected: false, confirm: null };
    navigate('/board', { replace: true });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root: Root = createRoot(host);
    try {
      await act(async () => root.render(<App />));
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('HTTP 503');
      const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === "Retry")!;
      expect(retry).toBeTruthy();
      await act(async () => { retry.click(); await Promise.resolve(); });
      expect(store.getState()).toMatchObject({ loaded: true, error: null });
      expect(host.textContent).toContain('board');
      expect(get).toHaveBeenCalledWith('/projects');
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.restoreAllMocks();
    }
  });

  it("Unauthorized retry returns App to login", async () => {
    vi.spyOn(store.rest, 'get').mockRejectedValue(new ApiFailure(401, 'unauthorized', "Session expired"));
    vi.spyOn(store, 'init').mockResolvedValue();
    store.state = { ...store.state, auth: 'in', loaded: false, error: "Previous load failed", projects: [], cards: [], connected: false, confirm: null };
    navigate('/board', { replace: true });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root: Root = createRoot(host);
    try {
      await act(async () => root.render(<App />));
      const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === "Retry")!;
      await act(async () => { retry.click(); await Promise.resolve(); });
      expect(store.getState()).toMatchObject({ auth: 'out', error: "Session expired", connected: false });
      expect(host.textContent).toContain('login');
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.restoreAllMocks();
    }
  });
});

describe("Drawer Escape protections", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    store.state = { ...store.state, auth: 'in', loaded: true, error: null, projects: [], cards: [], connected: false, confirm: null };
    vi.spyOn(store, 'init').mockResolvedValue();
    ui.closeSearch();
    ui.closeNewCard();
    ui.closeNewProject();
    if (ui.get().editProject) ui.closeEditProject();
    ui.toggleMenu(false);
    navigate('/board?card=42', { replace: true });
    await act(async () => root.render(<App />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  const escape = async (target: EventTarget, isComposing = false) => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    Object.defineProperty(event, 'isComposing', { value: isComposing });
    await act(async () => { target.dispatchEvent(event); });
    return event;
  };

  it("Composition Escape keeps the drawer open and input focused", async () => {
    const input = host.querySelector('textarea')!;
    input.focus();
    const event = await escape(input, true);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Unsubmitted draft");
    expect(host.querySelector('.drawer')).not.toBeNull();
    expect(window.location.search).toContain('card=42');
  });

  it("Input Escape preserves focus and draft; Escape outside closes the drawer", async () => {
    const input = host.querySelector('textarea')!;
    input.focus();
    const event = await escape(input);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Unsubmitted draft");
    expect(host.querySelector('.drawer')).not.toBeNull();

    await escape(document.body);
    expect(host.querySelector('.drawer')).toBeNull();
    expect(window.location.search).not.toContain('card=42');
  });
});
