import { describe, expect, it, vi } from 'vitest';
import { createKanbanWebMCP, detectModelContext, TOOL_DEFS, type ModelContextLike } from '../src/webmcp/index.ts';
import { createRestClient } from '../src/lib/api.ts';

/** Fake modelContext implementation with signal support. */
function fakeModern() {
  const tools = new Map<string, any>();
  const calls: { tool: any; options: any }[] = [];
  const mc: ModelContextLike = {
    registerTool(tool, options) {
      if (tools.has(tool.name)) throw new Error(`duplicate ${tool.name}`);
      calls.push({ tool, options });
      tools.set(tool.name, tool);
      options?.signal?.addEventListener('abort', () => tools.delete(tool.name));
    },
  };
  return { mc, tools, calls };
}
/** Legacy implementation with registerTool (ignores signal) and unregisterTool. */
function fakeLegacy() {
  const tools = new Map<string, any>();
  const unregistered: string[] = [];
  const mc: ModelContextLike = {
    registerTool(tool) { tools.set(tool.name, tool); },
    unregisterTool(name) { unregistered.push(name); tools.delete(name); },
  };
  return { mc, tools, unregistered };
}

function fakeFetch(responder: (method: string, path: string, body: any, headers: Record<string, string>) => unknown = () => ({})) {
  const log: { method: string; path: string; body: any; headers: Record<string, string> }[] = [];
  const impl = async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace('/api/v1', '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const headers = init.headers as Record<string, string>;
    log.push({ method, path, body, headers });
    return new Response(JSON.stringify(responder(method, path, body, headers)), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { impl, log };
}

function make(mc: ModelContextLike | null, f = fakeFetch(), extra: Partial<Parameters<typeof createKanbanWebMCP>[0]> = {}) {
  const debugTarget: any = {};
  const navigate = vi.fn();
  const confirmArchive = vi.fn(async () => true);
  const ctl = createKanbanWebMCP({
    modelContext: mc,
    rest: createRestClient({ fetchImpl: f.impl, actor: 'webmcp' }),
    getView: () => ({ view: 'board', layout: 'flat' }),
    navigate,
    confirmArchive,
    debugTarget,
    info: () => {},
    ...extra,
  });
  return { ctl, debugTarget, navigate, confirmArchive, f };
}

describe('WebMCP module', () => {
  it('prefers document.modelContext, falls back to navigator.modelContext, and returns null when unavailable', async () => {
    const a = { registerTool() {} };
    const b = { registerTool() {} };
    expect(detectModelContext({ modelContext: a }, { modelContext: b })).toBe(a);
    expect(detectModelContext({}, { modelContext: b })).toBe(b);
    expect(detectModelContext({}, {})).toBeNull();
    expect(detectModelContext({ modelContext: {} }, {})).toBeNull();
  });

  it('registers all 14 tools with names, annotations, current-view context, and abort signals', async () => {
    const { mc, tools, calls } = fakeModern();
    const { ctl, debugTarget } = make(mc);
    const names = await ctl.register('Project board; current project ID: sample-project');
    expect(names).toHaveLength(14);
    expect(tools.size).toBe(14);
    expect([...tools.keys()]).toEqual(TOOL_DEFS.map((d) => d.name));
    const ro = [...tools.values()].filter((t) => t.annotations.readOnlyHint).map((t) => t.name);
    expect(ro).toEqual(['kanban_get_overview', 'kanban_list_cards', 'kanban_get_card', 'kanban_get_view', 'kanban_list_comments']);
    expect(tools.get('kanban_archive_card').annotations.consequentialHint).toBe(true);
    expect(tools.get('kanban_list_cards').description).toContain('sample-project');
    const addCommentSchema = tools.get('kanban_add_comment').inputSchema as any;
    expect(addCommentSchema.properties.target.default).toBe('codex');
    expect(addCommentSchema.required).not.toContain('target');
    for (const c of calls) {
      expect(c.options.signal).toBeInstanceOf(AbortSignal);
      expect(c.tool.inputSchema.type).toBe('object');
      expect(typeof c.tool.execute).toBe('function');
    }
    expect(debugTarget.__kanbanWebMCP).toEqual({ tools: names, supported: true });
  });

  it('unregisters tools on dispose and refreshes descriptions when the view changes', async () => {
    const { mc, tools } = fakeModern();
    const { ctl, debugTarget } = make(mc);
    await ctl.register('Overview');
    expect(tools.get('kanban_get_overview').description).toContain('Overview');
    await ctl.register('All boards (flat)');
    expect(tools.size).toBe(14);
    expect(tools.get('kanban_get_overview').description).toContain('All boards (flat)');
    expect(tools.get('kanban_get_overview').description).not.toContain('Overview');
    ctl.dispose();
    expect(tools.size).toBe(0);
    expect(debugTarget.__kanbanWebMCP).toEqual({ tools: [], supported: true });
  });

  it('uses unregisterTool to clean up each tool when abort is unavailable in the legacy API', async () => {
    const { mc, tools, unregistered } = fakeLegacy();
    const { ctl } = make(mc);
    await ctl.register('x');
    expect(tools.size).toBe(14);
    ctl.dispose();
    expect(unregistered).toHaveLength(14);
    expect(new Set(unregistered)).toEqual(new Set(TOOL_DEFS.map((d) => d.name)));
    expect(tools.size).toBe(0);
  });

  it('does not count a rejected registration, logs it at info level, and avoids an unhandled rejection', async () => {
    const tools = new Map<string, any>();
    const mc: ModelContextLike = {
      registerTool(tool) {
        if (tool.name === 'kanban_navigate') return Promise.reject(new DOMException('exists', 'InvalidStateError'));
        tools.set(tool.name, tool);
        return Promise.resolve(undefined);
      },
    };
    const info = vi.fn();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const { ctl, debugTarget } = make(mc, fakeFetch(), { info });
    const names = await ctl.register('x');
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', unhandled);
    expect(names).toHaveLength(13);
    expect(names).not.toContain('kanban_navigate');
    expect(debugTarget.__kanbanWebMCP.tools).toHaveLength(13);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('kanban_navigate'));
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('retries a rejected registration on the next macrotask and counts the retry as successful', async () => {
    const tools = new Map<string, any>();
    const attempts: Record<string, number> = {};
    const mc: ModelContextLike = {
      registerTool(tool) {
        attempts[tool.name] = (attempts[tool.name] ?? 0) + 1;
        if (tool.name === 'kanban_get_card' && attempts[tool.name] === 1) return Promise.reject(new Error('InvalidStateError'));
        tools.set(tool.name, tool);
        return Promise.resolve(undefined);
      },
    };
    const { ctl } = make(mc);
    const names = await ctl.register('x');
    expect(names).toHaveLength(14);
    expect(attempts.kanban_get_card).toBe(2);
    expect(attempts.kanban_list_cards).toBe(1);
  });

  it('retries registration after an aborted tool is removed asynchronously', async () => {
    const live = new Set<string>();
    const mc: ModelContextLike = {
      registerTool(tool, options) {
        if (live.has(tool.name)) return Promise.reject(new DOMException('exists', 'InvalidStateError'));
        live.add(tool.name);
        options?.signal?.addEventListener('abort', () => setTimeout(() => live.delete(tool.name), 0)); // Removal is asynchronous.
        return Promise.resolve(undefined);
      },
    };
    const { ctl, debugTarget } = make(mc);
    await ctl.register('Overview');
    expect(live.size).toBe(14);
    const names = await ctl.register('All boards');
    expect(names).toHaveLength(14);
    expect(debugTarget.__kanbanWebMCP.tools).toHaveLength(14);
  });

  it('cleans up late registrations after abort without overwriting the next registration cycle', async () => {
    const pending: { name: string; resolve: () => void }[] = [];
    const unregistered: string[] = [];
    const mc: ModelContextLike = {
      registerTool: (tool) => new Promise<void>((resolve) => pending.push({ name: tool.name, resolve })),
      unregisterTool: (name) => { unregistered.push(name); },
    };
    const { ctl, debugTarget } = make(mc);
    const first = ctl.register('Previous');
    ctl.dispose(); // Abort the previous cycle while all 14 registrations are pending.
    expect(debugTarget.__kanbanWebMCP.tools).toEqual([]);
    pending.splice(0).forEach((p) => p.resolve()); // The old registrations resolve after abort.
    expect(await first).toEqual([]);
    expect(debugTarget.__kanbanWebMCP.tools).toEqual([]);
    expect(unregistered).toHaveLength(14); // Registrations that resolve after dispose must be removed.
    // The next cycle is independent of the previous result.
    const second = ctl.register('Next');
    pending.splice(0).forEach((p) => p.resolve());
    expect(await second).toHaveLength(14);
    expect(debugTarget.__kanbanWebMCP.tools).toHaveLength(14);
  });

  it('keeps results from a replaced registration cycle out of the new cycle', async () => {
    const pending: { name: string; gen: number; resolve: () => void }[] = [];
    let gen = 0;
    const mc: ModelContextLike = {
      registerTool: (tool) => new Promise<void>((resolve) => pending.push({ name: tool.name, gen, resolve })),
    };
    const { ctl, debugTarget } = make(mc);
    gen = 1;
    const p1 = ctl.register('First');
    gen = 2;
    const p2 = ctl.register('Second');
    // Resolve the 14 registrations from cycle 2 first, then resolve cycle 1.
    pending.filter((p) => p.gen === 2).forEach((p) => p.resolve());
    expect(await p2).toHaveLength(14);
    pending.filter((p) => p.gen === 1).forEach((p) => p.resolve());
    expect(await p1).toEqual([]);
    expect(debugTarget.__kanbanWebMCP.tools).toHaveLength(14);
  });

  it('handles unsupported WebMCP without errors and logs the missing support once', async () => {
    const info = vi.fn();
    const { ctl, debugTarget } = make(null, fakeFetch(), { info });
    expect(ctl.supported).toBe(false);
    expect(await ctl.register('a')).toEqual([]);
    await ctl.register('b');
    expect(info).toHaveBeenCalledTimes(1);
    expect(debugTarget.__kanbanWebMCP).toEqual({ tools: [], supported: false });
  });

  it('returns JSON text and structured content, and marks execution errors', async () => {
    const f = fakeFetch((m, p) => (p.startsWith('/cards/9') ? { card: { id: 9 } } : { ok: true }));
    const { mc, tools } = fakeModern();
    const { ctl } = make(mc, f);
    await ctl.register('');
    const res = await tools.get('kanban_get_card').execute({ card_id: 9 }, undefined);
    expect(res.isError).toBeUndefined();
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe('text');
    expect(JSON.parse(res.content[0].text)).toEqual({ card: { id: 9 } });
    expect(res.structuredContent).toEqual({ card: { id: 9 } });
    const bad = await tools.get('kanban_get_card').execute({ card_id: 'x' }, undefined);
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('card_id');
    // A REST failure is returned as isError.
    const f2 = { impl: async () => new Response(JSON.stringify({ error: { code: 'card_not_found', message: 'Card #5 was not found' } }), { status: 404 }), log: [] };
    const m2 = fakeModern();
    await make(m2.mc, f2 as any).ctl.register('');
    const nf = await m2.tools.get('kanban_get_card').execute({ card_id: 5 }, undefined);
    expect(nf.isError).toBe(true);
    expect(nf.content[0].text).toContain('Card #5 was not found');
  });

  it('uses GET for read-only tools and makes no API request for get_view', async () => {
    const f = fakeFetch((m, p) => (p.startsWith('/cards?') ? { cards: [] } : p.startsWith('/cards/') ? { card: {}, notes: [], events: [] } : { projects: [] }));
    const { mc, tools } = fakeModern();
    const { ctl } = make(mc, f);
    await ctl.register('');
    const inputs: Record<string, any> = { kanban_get_overview: {}, kanban_list_cards: { project: 'p', blocked: true, q: 'x' }, kanban_get_card: { card_id: 1 }, kanban_get_view: {} };
    for (const [name, input] of Object.entries(inputs)) {
      expect(tools.get(name).annotations.readOnlyHint).toBe(true);
      const r = await tools.get(name).execute(input, undefined);
      expect(r.isError, name).toBeUndefined();
    }
    expect(f.log.length).toBe(3);
    expect(f.log.every((c) => c.method === 'GET')).toBe(true);
    expect(f.log.map((c) => c.path)).toEqual(['/overview', '/cards?project=p&blocked=true&q=x', '/cards/1']);
  });

  it('routes comment listing, creation, and replies through REST', async () => {
    const f = fakeFetch(() => ({ ok: true }));
    const { mc, tools } = fakeModern();
    const { ctl } = make(mc, f);
    await ctl.register('');
    expect(tools.get('kanban_list_comments').annotations.readOnlyHint).toBe(true);
    expect(tools.get('kanban_add_comment').annotations.readOnlyHint).toBeUndefined();
    await tools.get('kanban_list_comments').execute({ status: 'all', target: 'codex', card_id: 4, junk: 1 }, undefined);
    await tools.get('kanban_add_comment').execute({ card_id: 4, body: 'Question', target: 'any', junk: 1 }, undefined);
    await tools.get('kanban_reply_comment').execute({ comment_id: 7, body: 'Reply' }, undefined);
    expect(f.log.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /comments?status=all&target=codex&card_id=4', 'POST /cards/4/comments', 'POST /comments/7/replies',
    ]);
    expect(f.log[1].body).toEqual({ body: 'Question', target: 'any' });
    expect(f.log[2].body).toEqual({ body: 'Reply' });
    for (const c of f.log) expect(c.headers['X-Kanban-Actor']).toBe('webmcp');
    const bad = await tools.get('kanban_add_comment').execute({ body: 'x', target: 'any' }, undefined);
    expect(bad.isError).toBe(true);
  });

  it('routes write tools through REST with the WebMCP actor and CSRF headers', async () => {
    const f = fakeFetch((m, p) => ({ ok: true, p }));
    const { mc, tools } = fakeModern();
    const { ctl } = make(mc, f);
    await ctl.register('');
    await tools.get('kanban_create_card').execute({ project_id: 'p', title: 't', priority: 'p1' }, undefined);
    await tools.get('kanban_update_card').execute({ card_id: 3, blocked: true, blocked_reason: 'r', junk: 1 }, undefined);
    await tools.get('kanban_move_card').execute({ card_id: 3, status: 'review', after_id: 2 }, undefined);
    await tools.get('kanban_add_note').execute({ card_id: 3, body: 'hi' }, undefined);
    await tools.get('kanban_update_project_handoff').execute({ project_id: 'p', handoff: 'next' }, undefined);
    expect(f.log.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /cards', 'PATCH /cards/3', 'POST /cards/3/move', 'POST /cards/3/notes', 'PATCH /projects/p',
    ]);
    expect(f.log[1].body).toEqual({ blocked: true, blocked_reason: 'r' }); // Unknown fields are not sent.
    for (const c of f.log) {
      expect(c.headers['X-Kanban-Actor']).toBe('webmcp');
      expect(c.headers['X-Requested-With']).toBe('kanban');
    }
  });

  it('confirms archive actions through requestUserInteraction and does not write when the user declines', async () => {
    const f = fakeFetch((m, p) => (m === 'GET' ? { card: { id: 4, title: 'T4' } } : { card: { id: 4, archived: true } }));
    const { mc, tools } = fakeModern();
    const { ctl, confirmArchive } = make(mc, f);
    await ctl.register('');
    const rui = vi.fn(async (cb: () => Promise<boolean>) => cb());
    const r1 = await tools.get('kanban_archive_card').execute({ card_id: 4 }, { requestUserInteraction: rui });
    expect(rui).toHaveBeenCalledTimes(1);
    expect(confirmArchive).toHaveBeenCalledWith({ id: 4, title: 'T4' });
    expect(r1.isError).toBeUndefined();
    expect(f.log.at(-1)).toMatchObject({ method: 'POST', path: '/cards/4/archive' });
    const r2 = await tools.get('kanban_archive_card').execute({ card_id: 4 }, undefined);
    expect(confirmArchive).toHaveBeenCalledTimes(2);
    expect(r2.isError).toBeUndefined();
    // The user declines.
    confirmArchive.mockResolvedValueOnce(false);
    const before = f.log.length;
    const r3 = await tools.get('kanban_archive_card').execute({ card_id: 4 }, undefined);
    expect(r3.isError).toBe(true);
    expect(f.log.slice(before).every((c) => c.method === 'GET')).toBe(true);
  });

  it('navigates to a project card and reads the current view', async () => {
    const { mc, tools } = fakeModern();
    const { ctl, navigate } = make(mc);
    await ctl.register('');
    const r = await tools.get('kanban_navigate').execute({ view: 'project', project: 'agent-kanban', card: 3 }, undefined);
    expect(navigate).toHaveBeenCalledWith('/p/agent-kanban?card=3');
    expect(r.structuredContent).toEqual({ ok: true, url: '/p/agent-kanban?card=3' });
    expect((await tools.get('kanban_navigate').execute({ view: 'project' }, undefined)).isError).toBe(true);
    expect((await tools.get('kanban_get_view').execute({}, undefined)).structuredContent).toEqual({ view: 'board', layout: 'flat' });
  });
});
