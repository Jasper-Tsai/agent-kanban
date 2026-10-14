import { t as tr, te } from '../i18n/index.ts';
import toolDefs from '../../shared/webmcp-tools.json';
import type { RestClient } from '../lib/api.ts';
import { qs } from '../lib/api.ts';
import { buildNavigateUrl, type NavigateInput } from './navigate.ts';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}
export const TOOL_DEFS = toolDefs as ToolDef[];

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ModelContextLike {
  registerTool: (tool: any, options?: { signal?: AbortSignal }) => unknown;
  unregisterTool?: (name: string) => unknown;
}

export interface ViewInfo {
  [k: string]: unknown;
}

export interface WebMCPDeps {
  modelContext: ModelContextLike | null | undefined;
  
  rest: RestClient;
  getView: () => ViewInfo;
  
  navigate: (url: string) => void;
  confirmArchive: (card: { id: number; title: string }) => Promise<boolean>;
  debugTarget?: { __kanbanWebMCP?: { tools: string[]; supported: boolean } };
  onChange?: (s: { supported: boolean; tools: string[] }) => void;
  info?: (msg: string) => void;
}

export interface KanbanWebMCP {
  supported: boolean;
  
  register: (context: string) => Promise<string[]>;
  dispose: () => void;
}

/** `document.modelContext ?? navigator.modelContext` */
export function detectModelContext(doc?: { modelContext?: unknown }, nav?: { modelContext?: unknown }): ModelContextLike | null {
  const mc = (doc as any)?.modelContext ?? (nav as any)?.modelContext;
  return mc && typeof mc.registerTool === 'function' ? (mc as ModelContextLike) : null;
}

export const ok = (data: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
  structuredContent: data,
});
export const fail = (message: string): ToolResult => ({
  content: [{ type: 'text', text: message }],
  structuredContent: { error: message },
  isError: true,
});

function cardId(input: any): number {
  const n = Number(input?.card_id);
  if (!Number.isInteger(n) || n <= 0) throw new Error(tr('ui263'));
  return n;
}
function pick(input: any, keys: string[]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of keys) if (input?.[k] !== undefined) o[k] = input[k];
  return o;
}

type Executor = (input: any, client: any, d: WebMCPDeps) => Promise<Record<string, unknown>>;

const CARD_PATCH_KEYS = ['title', 'description', 'agent', 'priority', 'blocked', 'blocked_reason', 'needs_owner', 'branch', 'session_ref', 'tags', 'due_date'];

export const EXECUTORS: Record<string, Executor> = {
  kanban_get_overview: async (_i, _c, d) => d.rest.get('/overview'),
  kanban_list_cards: async (i, _c, d) => {
    const r = await d.rest.get<{ cards: unknown[] }>(
      `/cards${qs({ project: i?.project, status: i?.status, agent: i?.agent, blocked: i?.blocked, needs_owner: i?.needs_owner, q: i?.q })}`,
    );
    return { count: r.cards.length, cards: r.cards };
  },
  kanban_get_card: async (i, _c, d) => d.rest.get(`/cards/${cardId(i)}`),
  kanban_get_view: async (_i, _c, d) => d.getView(),
  kanban_create_card: async (i, _c, d) =>
    d.rest.post('/cards', pick(i, ['project_id', 'title', 'description', 'status', 'agent', 'priority', 'branch', 'tags', 'due_date'])),
  kanban_update_card: async (i, _c, d) => d.rest.patch(`/cards/${cardId(i)}`, pick(i, CARD_PATCH_KEYS)),
  kanban_move_card: async (i, _c, d) => d.rest.post(`/cards/${cardId(i)}/move`, pick(i, ['status', 'before_id', 'after_id'])),
  kanban_add_note: async (i, _c, d) => d.rest.post(`/cards/${cardId(i)}/notes`, pick(i, ['body'])),
  kanban_list_comments: async (i, _c, d) => {
    const r = await d.rest.get<{ comments: unknown[] }>(`/comments${qs({ status: i?.status, target: i?.target, project: i?.project, card_id: i?.card_id, limit: i?.limit })}`);
    return { count: r.comments.length, comments: r.comments };
  },
  kanban_add_comment: async (i, _c, d) => d.rest.post(`/cards/${cardId(i)}/comments`, pick(i, ['body', 'target'])),
  kanban_reply_comment: async (i, _c, d) => {
    const n = Number(i?.comment_id);
    if (!Number.isInteger(n) || n <= 0) throw new Error(tr('ui264'));
    return d.rest.post(`/comments/${n}/replies`, pick(i, ['body']));
  },
  kanban_archive_card: async (i, client, d) => {
    const id = cardId(i);
    const detail = await d.rest.get<{ card: { id: number; title: string } }>(`/cards/${id}`);
    const ask = () => d.confirmArchive({ id, title: detail.card.title });
    
    const approved = typeof client?.requestUserInteraction === 'function' ? await client.requestUserInteraction(ask) : await ask();
    if (!approved) throw new Error(tr('ui265'));
    return d.rest.post(`/cards/${id}/archive`, {});
  },
  kanban_update_project_handoff: async (i, _c, d) => {
    if (typeof i?.project_id !== 'string' || !i.project_id) throw new Error(tr('ui266'));
    if (typeof i?.handoff !== 'string') throw new Error(tr('ui267'));
    return d.rest.patch(`/projects/${encodeURIComponent(i.project_id)}`, { handoff: i.handoff });
  },
  kanban_navigate: async (i, _c, d) => {
    const url = buildNavigateUrl(i as NavigateInput);
    d.navigate(url);
    return { ok: true, url };
  },
};

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export function createKanbanWebMCP(deps: WebMCPDeps): KanbanWebMCP {
  const mc = deps.modelContext ?? null;
  const supported = !!mc;
  let ctrl: AbortController | null = null;
  let names: string[] = [];
  let generation = 0;
  let infoLogged = false;
  const info = (m: string) => (deps.info ?? console.info)(m);

  const publish = () => {
    if (deps.debugTarget) deps.debugTarget.__kanbanWebMCP = { tools: [...names], supported };
    deps.onChange?.({ supported, tools: [...names] });
  };

  function teardown() {
    generation++;
    ctrl?.abort();
    ctrl = null;
    names = [];
  }

  async function register(context: string): Promise<string[]> {
    teardown();
    if (!mc) {
      if (!infoLogged) {
        infoLogged = true;
        info(tr('ui268'));
      }
      publish();
      return [];
    }
    const gen = generation;
    const controller = new AbortController();
    ctrl = controller;
    const registered: string[] = [];
    const current = () => gen === generation && !controller.signal.aborted;

    
    if (typeof mc.unregisterTool === 'function') {
      controller.signal.addEventListener('abort', () => {
        for (const n of registered) {
          try {
            mc.unregisterTool!(n);
          } catch {
            
          }
        }
      });
    }

    
    const attempt = async (tool: unknown, name: string, retry: boolean): Promise<boolean> => {
      try {
        await Promise.resolve(mc.registerTool(tool, { signal: controller.signal }));
        return true;
      } catch (e) {
        if (!current()) return false;
        if (retry) {
          await tick(); 
          if (!current()) return false;
          return attempt(tool, name, false);
        }
        info(tr('ui269', name, e instanceof Error ? e.message : String(e)));
        return false;
      }
    };

    await Promise.all(
      TOOL_DEFS.map(async (def) => {
        const exec = EXECUTORS[def.name];
        const tool = {
          name: def.name,
          description: context ? te('ui270', def.description, context) : def.description,
          inputSchema: def.inputSchema,
          annotations: def.annotations,
          async execute(input: unknown, client: unknown): Promise<ToolResult> {
            try {
              return ok(await exec(input ?? {}, client, deps));
            } catch (e) {
              return fail(e instanceof Error ? e.message : String(e));
            }
          },
        };
        const success = await attempt(tool, def.name, true);
        if (!success) return;
        if (current()) registered.push(def.name);
        else if (ctrl === null && typeof mc.unregisterTool === 'function') {
          
          try {
            mc.unregisterTool(def.name);
          } catch {
            /* ignore */
          }
        }
      }),
    );
    if (!current()) return [];
    const order = TOOL_DEFS.map((d) => d.name);
    registered.sort((x, y) => order.indexOf(x) - order.indexOf(y));
    names = registered;
    publish();
    return [...registered];
  }

  return {
    supported,
    register,
    dispose() {
      teardown();
      publish();
    },
  };
}
