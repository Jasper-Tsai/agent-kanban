import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeTestApp, TOKENS, type TestCtx } from './helpers/server.ts';

let t: TestCtx;
let server: ReturnType<typeof serve>;
let base: string;
const clients: Client[] = [];

beforeEach(async () => {
  t = makeTestApp();
  await new Promise<void>((resolve) => {
    server = serve({ fetch: t.app.fetch, port: 0, hostname: 'localhost' }, (info: AddressInfo) => {
      base = `http://localhost:${info.port}`;
      resolve();
    });
  });
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  (server as unknown as HttpServer).closeAllConnections?.();
  await new Promise((r) => server.close(r));
  t.cleanup();
});

async function connect(token: 'codex' | 'claude' = 'codex'): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKENS[token]}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function callTool(c: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: any };
  return res;
}

const RPC_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const initBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
});

async function mkProject(id = 'proj-a') {
  const r = await t.call('POST', '/api/v1/projects', { token: 'claude', body: { id, name: `Project ${id}` } });
  expect(r.status).toBe(201);
}

describe('MCP authentication and HTTP behavior', () => {
  it('returns 401 with WWW-Authenticate and a JSON-RPC error for missing or invalid credentials', async () => {
    const cookie = await t.login();
    const attempts: Record<string, string>[] = [{},{ authorization: 'Bearer wrong-token' }, { authorization: 'Basic abc' }, { cookie, 'x-requested-with': 'kanban' }];
    for (const headers of attempts) {
      const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...RPC_HEADERS, ...headers }, body: initBody });
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer realm="agent-kanban"');
      const body = await res.json();
      expect(body).toMatchObject({ jsonrpc: '2.0', id: null });
      expect(body.error.message).toBeTruthy();
    }
  });

  it('returns 405 with Allow: POST for GET and DELETE without falling through to the SPA', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${base}/mcp`, { method, headers: { authorization: `Bearer ${TOKENS.claude}`, accept: 'text/event-stream' } });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
    }
  });

  it('is stateless and returns JSON without a session ID or SSE', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...RPC_HEADERS, authorization: `Bearer ${TOKENS.claude}` }, body: initBody });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    const body = await res.json();
    expect(body.result.serverInfo).toMatchObject({ name: 'agent-kanban', version: t.config.version });
  });

  it('returns 413 when the request body exceeds 1 MB', async () => {
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'kanban_add_note', arguments: { card_id: 1, body: 'x'.repeat(1024 * 1024 + 10) } } });
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...RPC_HEADERS, authorization: `Bearer ${TOKENS.claude}` }, body: big });
    expect(res.status).toBe(413);
  });
});

describe('MCP tools', () => {
  it('provides server information and English instructions, and lists the 15 MCP tools only', async () => {
    const c = await connect();
    expect(c.getServerVersion()).toMatchObject({ name: 'agent-kanban', version: t.config.version });
    expect(c.getInstructions()).toMatch(/kanban_update_project_handoff/);
    expect(c.getInstructions()).toMatch(/needs_owner/);
    const { tools } = await c.listTools();
    const names = tools.map((x) => x.name).sort();
    const toolSchema = (name: string) => tools.find((tool) => tool.name === name)?.inputSchema as any;
    expect(tools).toHaveLength(15);
    expect(names).toEqual(
      [
        'kanban_add_note',
        'kanban_archive_card',
        'kanban_create_card',
        'kanban_create_project',
        'kanban_get_brief',
        'kanban_get_card',
        'kanban_get_overview',
        'kanban_list_cards',
        'kanban_list_comments',
        'kanban_list_events',
        'kanban_list_projects',
        'kanban_move_card',
        'kanban_reply_comment',
        'kanban_update_card',
        'kanban_update_project_handoff',
      ].sort(),
    );
    expect(names).not.toContain('kanban_get_view');
    expect(names).not.toContain('kanban_navigate');
    expect(names).not.toContain('kanban_add_comment');
    expect(toolSchema('kanban_list_cards')?.properties?.agent?.enum).toEqual(['codex', 'claude', 'owner', 'none']);
    expect(toolSchema('kanban_list_events')?.properties?.actor?.enum).toEqual(['codex', 'claude', 'owner', 'webmcp', 'system']);
    expect(toolSchema('kanban_list_comments')?.properties?.target?.enum).toEqual(['codex', 'claude']);
    expect(c.getInstructions()).toMatch(/kanban_reply_comment/);
    expect(c.getInstructions()).toMatch(/kanban_get_brief/);
    expect(c.getInstructions()).toMatch(/\[handoff\]/);
  });

  it('kanban_get_brief returns the REST task package, supports full output, validates inputs, and documents the handoff template', async () => {
    await mkProject();
    const c = await connect('codex');
    const { card } = (await callTool(c, 'kanban_create_card', { project_id: 'proj-a', title: 'Handoff card', description: '## Goal\n' + 'x'.repeat(4500) })).structuredContent;
    await callTool(c, 'kanban_add_note', { card_id: card.id, body: '[handoff] Completed A; next: B' });
    const brief = await callTool(c, 'kanban_get_brief', { card_id: card.id });
    expect(brief.isError).toBeFalsy();
    expect(brief.structuredContent.description.truncated).toBe(true);
    expect(brief.structuredContent.handoff_note.body).toContain('next: B');
    expect(brief.structuredContent.text).toContain('Completed A; next: B');
    const rest = await t.call('GET', `/api/v1/cards/${card.id}/brief`, { token: 'codex' });
    expect(rest.json).toEqual(brief.structuredContent);
    const full = await callTool(c, 'kanban_get_brief', { card_id: card.id, full: true });
    expect(full.structuredContent.description.truncated).toBe(false);
    expect(full.structuredContent.description.text.length).toBe(full.structuredContent.description.total_chars);
    expect((await callTool(c, 'kanban_get_brief', { card_id: 99999 })).isError).toBe(true);
    expect((await callTool(c, 'kanban_get_brief', { card_id: card.id, extra: 1 })).isError).toBe(true);
    const { tools } = await c.listTools();
    const by = Object.fromEntries(tools.map((x) => [x.name, x.description ?? '']));
    expect(by.kanban_add_note).toContain('[handoff]');
    expect(by.kanban_create_card).toContain('Goal');
    expect(by.kanban_update_card).toContain('Key decisions');
  });

  it('marks read-only tools, the destructive archive action, and other writes correctly', async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    const by = Object.fromEntries(tools.map((x) => [x.name, x]));
    for (const n of ['kanban_get_overview', 'kanban_list_cards', 'kanban_get_card', 'kanban_get_brief', 'kanban_list_projects', 'kanban_list_events', 'kanban_list_comments']) {
      expect(by[n].annotations, n).toMatchObject({ readOnlyHint: true });
    }
    expect(by.kanban_archive_card.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    for (const n of ['kanban_create_card', 'kanban_update_card', 'kanban_move_card', 'kanban_add_note', 'kanban_update_project_handoff', 'kanban_create_project', 'kanban_reply_comment']) {
      expect(by[n].annotations, n).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    }
    for (const x of tools) {
      expect(x.inputSchema.type).toBe('object');
      expect(x.description!.length).toBeGreaterThan(10);
    }
  });

  it('lists and filters cards, projects, overview data, and card details', async () => {
    await mkProject();
    const c = await connect();
    const a = await callTool(c, 'kanban_create_card', { project_id: 'proj-a', title: 'Card A', status: 'in_progress' });
    await callTool(c, 'kanban_create_card', { project_id: 'proj-a', title: 'Card B' });
    const all = await callTool(c, 'kanban_list_cards', {});
    expect(all.isError).toBeFalsy();
    expect(all.structuredContent.cards).toHaveLength(2);
    expect(JSON.parse(all.content[0].text)).toEqual(all.structuredContent);
    const ip = await callTool(c, 'kanban_list_cards', { project: 'proj-a', status: 'in_progress' });
    expect(ip.structuredContent.cards.map((x: any) => x.title)).toEqual(['Card A']);
    const projects = await callTool(c, 'kanban_list_projects');
    expect(projects.structuredContent.projects[0]).toMatchObject({ id: 'proj-a', counts: { in_progress: 1, todo: 1 } });
    expect(projects.structuredContent.projects[0]).toHaveProperty('handoff');
    const ov = await callTool(c, 'kanban_get_overview');
    expect(ov.structuredContent.projects).toHaveLength(1);
    const detail = await callTool(c, 'kanban_get_card', { card_id: a.structuredContent.card.id });
    expect(detail.structuredContent.card.title).toBe('Card A');
    expect(Array.isArray(detail.structuredContent.events)).toBe(true);
  });

  it('records the matching Codex and Claude token identities in events and REST results', async () => {
    await mkProject();
    const cx = await connect('codex');
    const cc = await connect('claude');
    const r1 = await callTool(cx, 'kanban_create_card', { project_id: 'proj-a', title: 'by codex' });
    const r2 = await callTool(cc, 'kanban_create_card', { project_id: 'proj-a', title: 'by claude' });
    const events = await callTool(cx, 'kanban_list_events', { project: 'proj-a' });
    const created = events.structuredContent.events.filter((e: any) => e.type === 'card.created');
    expect(created.find((e: any) => e.card_id === r1.structuredContent.card.id).actor).toBe('codex');
    expect(created.find((e: any) => e.card_id === r2.structuredContent.card.id).actor).toBe('claude');
    // The REST endpoint returns the same events.
    const rest = await t.call('GET', '/api/v1/events?project=proj-a', { token: 'claude' });
    expect(rest.json.events.filter((e: any) => e.type === 'card.created').map((e: any) => e.actor).sort()).toEqual(['claude', 'codex']);
  });

  it('updates owner-waiting and blocked fields, records move and note events, and broadcasts writes through SSE', async () => {
    await mkProject();
    const broadcasts: string[] = [];
    t.hub.add((chunk) => void broadcasts.push(String(chunk)));
    const c = await connect('codex');
    const { card } = (await callTool(c, 'kanban_create_card', { project_id: 'proj-a', title: 'Needs a decision' })).structuredContent;
    const up = await callTool(c, 'kanban_update_card', { card_id: card.id, needs_owner: true, blocked: true, blocked_reason: 'Waiting for a response', tags: ['x'], branch: 'feat/x' });
    expect(up.isError).toBeFalsy();
    expect(up.structuredContent.card).toMatchObject({ needs_owner: true, blocked: true, blocked_reason: 'Waiting for a response', tags: ['x'], branch: 'feat/x' });
    const mv = await callTool(c, 'kanban_move_card', { card_id: card.id, status: 'review' });
    expect(mv.structuredContent.card.status).toBe('review');
    const note = await callTool(c, 'kanban_add_note', { card_id: card.id, body: 'Completed; ready for review.' });
    expect(note.isError).toBeFalsy();
    const detail = await callTool(c, 'kanban_get_card', { card_id: card.id });
    const types = detail.structuredContent.events.map((e: any) => `${e.type}:${e.actor}`);
    expect(types).toEqual(expect.arrayContaining(['card.created:codex', 'card.updated:codex', 'card.moved:codex', 'note.added:codex']));
    const joined = broadcasts.join('');
    expect(joined).toContain('card.moved');
    expect(joined).toContain('codex');
  });

  it('filters the comment inbox, replies to threads, includes comments in card details, and prevents agents from starting or resolving threads', async () => {
    await mkProject();
    const cx = await connect('codex');
    const cc = await connect('claude');
    const { card } = (await callTool(cx, 'kanban_create_card', { project_id: 'proj-a', title: 'Question card' })).structuredContent;
    const cookie = await t.login();
    const mk = async (target: string, body: string) =>
      (await t.call('POST', `/api/v1/cards/${card.id}/comments`, { cookie, body: { body, target } })).json.comment;
    const forCodex = await mk('codex', 'A question for Codex');
    const forClaude = await mk('claude', 'A question for Claude');
    const inbox = await callTool(cx, 'kanban_list_comments', { target: 'codex' });
    expect(inbox.isError).toBeFalsy();
    expect(inbox.structuredContent.comments.map((x: any) => x.root.id)).toEqual([forCodex.id]);
    expect(inbox.structuredContent.comments[0]).toMatchObject({ card: { id: card.id }, project: { id: 'proj-a' } });
    const all = await callTool(cx, 'kanban_list_comments', {});
    expect(all.structuredContent.comments).toHaveLength(2);
    const rep = await callTool(cx, 'kanban_reply_comment', { comment_id: forCodex.id, body: 'Conclusion: yes.' });
    expect(rep.isError).toBeFalsy();
    expect(rep.structuredContent.root.status).toBe('answered');
    expect(rep.structuredContent.comment).toMatchObject({ author: 'codex', parent_id: forCodex.id });
    const detail = await callTool(cc, 'kanban_get_card', { card_id: card.id });
    expect(detail.structuredContent.comments).toHaveLength(2);
    expect(detail.structuredContent.comments[0].replies[0].body).toBe('Conclusion: yes.');
    expect((await callTool(cx, 'kanban_list_comments', { target: 'codex' })).structuredContent.comments).toHaveLength(0);
    const ev = await callTool(cc, 'kanban_list_events', { project: 'proj-a' });
    expect(ev.structuredContent.events.find((e: any) => e.type === 'comment.replied')).toMatchObject({ actor: 'codex' });
    // Invalid input and a missing comment.
    expect((await callTool(cx, 'kanban_reply_comment', { comment_id: 99999, body: 'x' })).isError).toBe(true);
    expect((await callTool(cx, 'kanban_reply_comment', { comment_id: forClaude.id, body: '' })).isError).toBe(true);
    // MCP does not expose add_comment or resolve tools.
    expect((await callTool(cx, 'kanban_add_comment', { card_id: card.id, body: 'x', target: 'codex' })).isError).toBe(true);
  });

  it('archives cards from the default list and updates project handoffs', async () => {
    const c = await connect();
    const p = await callTool(c, 'kanban_create_project', { id: 'via-mcp', name: 'MCP Project', repo_path: '/workspace/project' });
    expect(p.isError).toBeFalsy();
    expect(p.structuredContent.project).toMatchObject({ id: 'via-mcp', name: 'MCP Project', repo_path: '/workspace/project' });
    const h = await callTool(c, 'kanban_update_project_handoff', { project_id: 'via-mcp', handoff: 'Next: connect MCP.' });
    expect(h.structuredContent.project.handoff).toBe('Next: connect MCP.');
    const { card } = (await callTool(c, 'kanban_create_card', { project_id: 'via-mcp', title: 'Archive this card' })).structuredContent;
    const ar = await callTool(c, 'kanban_archive_card', { card_id: card.id });
    expect(ar.isError).toBeFalsy();
    expect(ar.structuredContent.card.archived).toBe(true);
    const list = await callTool(c, 'kanban_list_cards', { project: 'via-mcp' });
    expect(list.structuredContent.cards).toHaveLength(0);
    const rest = await t.call('GET', `/api/v1/cards/${card.id}`, { token: 'claude' });
    expect(rest.json.events.map((e: any) => e.type)).toContain('card.archived');
  });

  it('returns tool errors instead of JSON-RPC exceptions for invalid input, unknown fields, missing records, and unknown tools', async () => {
    await mkProject();
    const c = await connect();
    const cases: [string, Record<string, unknown>][] = [
      ['kanban_create_card', { project_id: 'proj-a' }], // Missing title.
      ['kanban_create_card', { project_id: 'proj-a', title: 'x', status: 'nope' }],
      ['kanban_create_card', { project_id: 'proj-a', title: 'x', needs_owner: true }], // Not part of the input schema.
      ['kanban_create_card', { project_id: 'no-such', title: 'x' }],
      ['kanban_update_card', { card_id: 999 }],
      ['kanban_update_card', { card_id: 1, status: 'done' }], // Use move_card to change status.
      ['kanban_update_card', { card_id: 'abc' }],
      ['kanban_move_card', { card_id: 999, status: 'done' }],
      ['kanban_add_note', { card_id: 999, body: 'x' }],
      ['kanban_get_card', { card_id: 999 }],
      ['kanban_archive_card', {}],
      ['kanban_update_project_handoff', { project_id: 'no-such', handoff: 'x' }],
      ['kanban_create_project', { id: 'Bad Slug', name: 'x' }],
      ['kanban_list_cards', { status: 'bogus' }],
      ['kanban_list_events', { limit: -1 }],
      ['kanban_get_view', {}],
      ['kanban_navigate', { view: 'overview' }],
      ['kanban_does_not_exist', {}],
    ];
    for (const [name, args] of cases) {
      const res = await callTool(c, name, args);
      expect(res.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(res.content[0].type).toBe('text');
      expect(res.content[0].text.length).toBeGreaterThan(0);
    }
  });
});
