import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ACTORS, AGENTS, STATUSES, type Actor } from '../shared/constants.ts';
import webmcpTools from '../shared/webmcp-tools.json' with { type: 'json' };
import extraTools from '../shared/mcp-extra-tools.json' with { type: 'json' };
import { ApiError, type Store } from './store.ts';
import { buildCardBrief } from './brief.ts';
import {
  createCardSchema,
  createProjectSchema,
  formatZodIssues,
  handoffSchema,
  moveSchema,
  inboxFilterSchema,
  noteSchema,
  patchCardSchema,
  replyCommentSchema,
} from './schemas.ts';

/** Maximum request body size (SPEC §12). */
export const MCP_MAX_BODY_BYTES = 1024 * 1024;

/** UI-only tools and owner-only actions are not exposed through MCP (SPEC §§12, 13.4). */
const UI_ONLY = new Set(['kanban_get_view', 'kanban_navigate', 'kanban_add_comment']);

export const MCP_INSTRUCTIONS = `Agent Kanban is a multi-project development board. Use these tools to read and update the board. Activity is attributed to the authenticated caller (Codex or Claude), and board changes appear in the user's view in real time.

Choosing a tool
- Before starting: use kanban_get_overview for overall progress and focus cards, kanban_list_projects for project IDs and handoffs, and kanban_list_cards to find relevant work. Create a card with kanban_create_card only when no matching card exists; create a project with kanban_create_project only when the project does not exist.
- To understand existing work: start with kanban_get_brief when taking or handing off a card. It includes the task description, latest [handoff] note, recent notes, open comment threads, and project handoff. Set full=true to disable truncation. Use kanban_get_card for all notes and events, and kanban_list_events for recent activity.
- During work: use kanban_add_note to record progress and decisions, put important decisions under the description's Key decisions section, use kanban_update_card to change fields, and use kanban_move_card to change status.
- Before finishing or handing off: add a note beginning with [handoff] that states what is done, the next step, key files, and open questions. Then move the card to review or done as appropriate and update the project handoff with kanban_update_project_handoff.

Field meanings
- status: backlog, todo, in_progress, review, or done.
- agent: current assignee (codex, claude, owner, or none).
- blocked (with blocked_reason): work is blocked while its status remains unchanged. Non-completed blocked cards appear in a separate Blocked column between Backlog and To Do.
- needs_owner: waiting for an owner decision or acceptance. Set it to true and describe the question in a kanban_add_note entry; it is cleared after the owner responds.

Suggested flow: assign the card to yourself with kanban_update_card, move it to in_progress, record progress with kanban_add_note, move completed work to review, and update the project handoff.

Comment threads
- Use kanban_list_comments to view the inbox, which defaults to open threads. Filter by target to find threads assigned to you. kanban_get_card also includes that card's comments.
- Use kanban_reply_comment with any comment_id in a thread to reply. An agent reply marks the thread answered; an owner reply reopens it. Lead with the conclusion, then give evidence, and label inferences and open questions. Reply in English unless the user requests another language.
- The owner starts and resolves threads. Agents cannot start or resolve threads. When assigned a thread, default to reading and replying without changing code or deploying. If code changes are needed, explain the proposed change and its impact for the owner to decide.

kanban_archive_card removes a card from the board but allows it to be restored. Use it only when the card is no longer needed.`;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

function mcpAnnotations(t: ToolDef): Record<string, boolean> {
  if (t.annotations?.readOnlyHint) return { readOnlyHint: true };
  if (t.name === 'kanban_archive_card') return { readOnlyHint: false, destructiveHint: true };
  return { readOnlyHint: false, destructiveHint: false };
}

export const MCP_TOOLS = [...(webmcpTools as ToolDef[]).filter((t) => !UI_ONLY.has(t.name)), ...(extraTools as ToolDef[])].map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema as { type: 'object'; [k: string]: unknown },
  annotations: mcpAnnotations(t),
}));

// ---------- Input schemas reuse schemas.ts, add card_id where needed, and match the strict tool definitions. ----------
const cardId = z.number().int().positive();
const withCard = <T extends z.ZodRawShape>(shape: T) => z.strictObject({ card_id: cardId, ...shape });

const listCardsInput = z.strictObject({
  project: z.string().optional(),
  status: z.enum(STATUSES).optional(),
  agent: z.enum(AGENTS).optional(),
  blocked: z.boolean().optional(),
  needs_owner: z.boolean().optional(),
  q: z.string().optional(),
});
const createCardInput = createCardSchema.omit({ blocked: true, blocked_reason: true, needs_owner: true, session_ref: true }).strict();
const updateCardInput = patchCardSchema.omit({ status: true }).extend({ card_id: cardId }).strict();
const moveCardInput = moveSchema.extend({ card_id: cardId }).strict();
const addNoteInput = noteSchema.extend({ card_id: cardId }).strict();
const handoffInput = z.strictObject({ project_id: z.string(), handoff: handoffSchema });
const createProjectInput = createProjectSchema.pick({ id: true, name: true, color: true, description: true, repo_path: true, url: true }).strict();
const listEventsInput = z.strictObject({
  limit: z.number().int().positive().optional(),
  project: z.string().optional(),
  actor: z.enum(ACTORS).optional(),
  before: z.number().int().positive().optional(),
});
const listCommentsInput = inboxFilterSchema.strict();
const replyCommentInput = replyCommentSchema.extend({ comment_id: z.number().int().positive() }).strict();
const getBriefInput = withCard({ full: z.boolean().optional() });
const noInput = z.strictObject({});

type Handler = (args: unknown, store: Store, actor: Actor) => Record<string, unknown>;

function parse<T extends z.ZodType>(schema: T, args: unknown): z.infer<T> {
  const r = schema.safeParse(args ?? {});
  if (!r.success) throw new ApiError(400, 'validation', formatZodIssues(r.error).replaceAll('(body)', '(arguments)'));
  return r.data;
}

const HANDLERS: Record<string, Handler> = {
  kanban_get_overview: (a, s) => (parse(noInput, a), { ...s.overview() }),
  kanban_list_cards: (a, s) => {
    const i = parse(listCardsInput, a);
    return { cards: s.listCards({ ...i, project: i.project || undefined, q: i.q || undefined }) };
  },
  kanban_get_card: (a, s) => ({ ...s.getCardDetail(parse(withCard({}), a).card_id) }),
  kanban_get_brief: (a, s) => {
    const i = parse(getBriefInput, a);
    return { ...buildCardBrief(s, i.card_id, { full: i.full }) };
  },
  kanban_create_card: (a, s, actor) => {
    const { project_id, ...rest } = parse(createCardInput, a);
    const input = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as any;
    return { card: s.createCard(project_id, input, actor) };
  },
  kanban_update_card: (a, s, actor) => {
    const { card_id, ...patch } = parse(updateCardInput, a);
    return { card: s.updateCard(card_id, patch, actor) };
  },
  kanban_move_card: (a, s, actor) => {
    const i = parse(moveCardInput, a);
    return { card: s.moveCard(i.card_id, i.status, { before_id: i.before_id, after_id: i.after_id }, actor) };
  },
  kanban_add_note: (a, s, actor) => {
    const i = parse(addNoteInput, a);
    return { ...s.addNote(i.card_id, i.body, actor) };
  },
  kanban_archive_card: (a, s, actor) => {
    const i = parse(withCard({}), a);
    return { card: s.archiveCard(i.card_id, true, actor) };
  },
  kanban_update_project_handoff: (a, s, actor) => {
    const i = parse(handoffInput, a);
    return { project: s.updateProject(i.project_id, { handoff: i.handoff }, actor) };
  },
  kanban_list_projects: (a, s) => {
    parse(noInput, a);
    const ov = s.overview().projects;
    const byId = new Map(ov.map((p) => [p.id, p]));
    const projects = s.listProjects().map((p) => {
      const hit = byId.get(p.id);
      if (hit) return hit;
      // Archived projects are absent from overview; add counts so the list remains complete.
      const cards = s.listCards({ project: p.id });
      const counts = Object.fromEntries(STATUSES.map((st) => [st, cards.filter((c) => c.status === st).length]));
      return {
        ...p,
        counts,
        blocked: cards.filter((c) => c.blocked && c.status !== 'done').length,
        needs_owner: cards.filter((c) => c.needs_owner && c.status !== 'done').length,
      };
    });
    return { projects };
  },
  kanban_list_comments: (a, s) => ({ comments: s.listInbox(parse(listCommentsInput, a)) }),
  kanban_reply_comment: (a, s, actor) => {
    const i = parse(replyCommentInput, a);
    return { ...s.replyComment(i.comment_id, i.body, actor) };
  },
  kanban_create_project: (a, s, actor) => ({ project: s.createProject(parse(createProjectInput, a) as any, actor) }),
  kanban_list_events: (a, s) => ({ ...s.listEvents(parse(listEventsInput, a)) }),
};

function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export interface McpDeps {
  store: Store;
  version: string;
  log?: (m: string) => void;
}

function buildServer(deps: McpDeps, actor: Actor): Server {
  const server = new Server({ name: 'agent-kanban', version: deps.version }, { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: MCP_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const handler = HANDLERS[req.params.name];
    if (!handler) return toolError(`Unknown tool: ${req.params.name}`);
    try {
      const data = handler(req.params.arguments, deps.store, actor);
      return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
    } catch (e) {
      if (e instanceof ApiError) return toolError(`${e.message} (${e.code})`);
      // Log only the tool name and error message; never log argument contents.
      deps.log?.(`[mcp-error] ${req.params.name}: ${(e as Error).message}`);
      return toolError('Internal server error');
    }
  });
  return server;
}

/** Stateless: create a Server and transport for each POST, then close them after handling it. */
export async function handleMcpRequest(req: Request, deps: McpDeps, actor: Actor): Promise<Response> {
  const server = buildServer(deps, actor);
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, maxRequestBodySize: MCP_MAX_BODY_BYTES });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await server.close().catch(() => {});
  }
}

export const jsonRpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });
