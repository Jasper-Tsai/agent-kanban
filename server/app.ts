import fs from 'node:fs';
import path from 'node:path';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { Config } from './config.ts';
import { openDb, runMigrations, type DB } from './db.ts';
import { LEGACY_SESSION_COOKIE, LoginLimiter, SESSION_COOKIE, SESSION_COOKIE_MAX_AGE_S, createSessionToken, lookupToken, needsRefresh, verifyPassword, verifySession, type Session } from './auth.ts';
import { ApiError, createStore } from './store.ts';
import { buildCardBrief, buildSessionBrief } from './brief.ts';
import { SseHub } from './sse.ts';
import { handleMcpRequest, jsonRpcError } from './mcp.ts';
import { importSeedIfEmpty } from './seed.ts';
import tools from '../shared/webmcp-tools.json' with { type: 'json' };
import { AGENTS, COMMENT_STATUSES, COMMENT_TARGETS, PRIORITIES, STATUSES, type Actor } from '../shared/constants.ts';
import { archiveSchema, createCardSchema, createCommentSchema, replyCommentSchema, resolveCommentSchema,  createProjectSchema, formatZodIssues, moveSchema, noteSchema, patchCardSchema, patchProjectSchema } from './schemas.ts';

type Vars = { actor: Actor; via: 'cookie' | 'token' };

export interface AppHandle {
  app: Hono<{ Variables: Vars }>;
  db: DB;
  hub: SseHub;
  store: ReturnType<typeof createStore>;
  close: () => void;
}

export interface CreateAppOptions {
  config: Config;
  db?: DB;
  now?: () => Date;
  pingMs?: number;
  log?: (m: string) => void;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

function parseBool(v: string | undefined): boolean | undefined {
  if (v === undefined || v === '') return undefined;
  if (['1', 'true', 'yes'].includes(v)) return true;
  if (['0', 'false', 'no'].includes(v)) return false;
  throw new ApiError(400, 'validation', `Invalid boolean parameter: ${v}`);
}
function enumQuery<T extends readonly string[]>(name: string, v: string | undefined, values: T): T[number] | undefined {
  if (v === undefined || v === '') return undefined;
  if (!values.includes(v)) throw new ApiError(400, 'validation', `${name} must be ${values.join('|')}`);
  return v as T[number];
}
function intParam(v: string | undefined, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError(400, 'validation', `${name} must be a positive integer`);
  return n;
}

async function readBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'bad_json', 'Request body must be valid JSON');
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new ApiError(400, 'validation', formatZodIssues(r.error));
  }
  return r.data;
}

export function createApp(opts: CreateAppOptions): AppHandle {
  const { config } = opts;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const ownDb = !opts.db;
  const db = opts.db ?? openDb(config.dbPath);
  runMigrations(db, config.migrationsDir, now);
  const seeded = importSeedIfEmpty(db, config.seedFile, now());
  if (seeded) log(`[seed] Imported ${seeded.projects} projects and ${seeded.cards} cards`);

  const hub = new SseHub();
  const store = createStore(db, now, (b) => hub.publish(b), config.timezone);
  const limiter = new LoginLimiter(5, 15 * 60 * 1000);

  const app = new Hono<{ Variables: Vars }>();

  app.use('*', async (c, next) => {
    await next();
    c.header('Content-Security-Policy', CSP);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
  });

  function clientIp(c: Context): string {
    if (config.trustProxy) {
      const xff = c.req.header('x-forwarded-for');
      if (xff) {
        
        const last = xff.split(',').map((s) => s.trim()).filter(Boolean).at(-1);
        if (last) return last;
      }
      const real = c.req.header('x-real-ip');
      if (real) return real.trim();
    }
    const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
    return env?.incoming?.socket?.remoteAddress ?? 'unknown';
  }

  function csrfOk(c: Context): boolean {
    if (c.req.header('x-requested-with') === 'kanban') return true;
    const origin = c.req.header('origin');
    const host = c.req.header('host');
    if (origin && host) {
      try {
        return new URL(origin).host === host;
      } catch {
        return false;
      }
    }
    return false;
  }

  function readSession(c: Context, nowMs: number): { session: Session; fromLegacy: boolean } | null {
    const cur = verifySession(getCookie(c, SESSION_COOKIE), config.sessionSecret, nowMs);
    if (cur) return { session: cur, fromLegacy: false };
    const old = verifySession(getCookie(c, LEGACY_SESSION_COOKIE), config.sessionSecret, nowMs);
    return old ? { session: old, fromLegacy: true } : null;
  }

  function issueSession(c: Context, nowMs: number) {
    setCookie(c, SESSION_COOKIE, createSessionToken(config.sessionSecret, nowMs), {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_COOKIE_MAX_AGE_S,
    });
  }

  const isWrite = (m: string) => !['GET', 'HEAD', 'OPTIONS'].includes(m);

  const api = new Hono<{ Variables: Vars }>();
  api.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  api.get('/health', (c) => {
    let dbOk = 'ok';
    try {
      db.prepare('SELECT 1').get();
    } catch {
      dbOk = 'error';
    }
    return c.json({ ok: dbOk === 'ok', version: config.version, db: dbOk }, dbOk === 'ok' ? 200 : 503);
  });

  api.post('/auth/login', async (c) => {
    if (!csrfOk(c)) throw new ApiError(403, 'csrf', 'Missing X-Requested-With: kanban header');
    const ip = clientIp(c);
    const nowMs = now().getTime();
    const wait = limiter.blockedFor(ip, nowMs);
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      throw new ApiError(429, 'rate_limited', `Too many failed login attempts. Retry in ${Math.ceil(wait / 60)} minutes`);
    }
    const body = await readBody(c, z.object({ password: z.string().min(1).max(500) }));
    if (!config.passwordHash || !verifyPassword(body.password, config.passwordHash)) {
      limiter.recordFailure(ip, nowMs);
      throw new ApiError(401, 'invalid_credentials', 'Invalid password');
    }
    limiter.reset(ip);
    issueSession(c, nowMs);
    return c.json({ ok: true });
  });

  const auth: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
    const authz = c.req.header('authorization');
    if (authz) {
      const m = /^Bearer\s+(.+)$/i.exec(authz);
      const actor = m ? lookupToken(m[1].trim(), config.tokens) : null;
      if (!actor) throw new ApiError(401, 'unauthorized', 'Invalid API token');
      c.set('actor', actor);
      c.set('via', 'token');
      return next();
    }
    const nowMs = now().getTime();
    const found = readSession(c, nowMs);
    if (!found) throw new ApiError(401, 'unauthorized', 'Authentication required');
    const { session, fromLegacy } = found;
    
    if ((fromLegacy || needsRefresh(session, nowMs)) && !c.req.path.endsWith('/auth/logout')) issueSession(c, nowMs);
    if (isWrite(c.req.method) && !csrfOk(c)) throw new ApiError(403, 'csrf', 'Missing X-Requested-With: kanban header or invalid Origin');
    let actor: Actor = 'owner';
    const hdr = c.req.header('x-kanban-actor');
    if (hdr !== undefined) {
      if (hdr !== 'webmcp') throw new ApiError(400, 'invalid_actor', 'X-Kanban-Actor only accepts webmcp');
      actor = 'webmcp';
    }
    c.set('actor', actor);
    c.set('via', 'cookie');
    return next();
  };
  api.use('*', auth);

  api.post('/auth/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: config.cookieSecure });
    
    if (verifySession(getCookie(c, LEGACY_SESSION_COOKIE), config.sessionSecret, now().getTime())) {
      deleteCookie(c, LEGACY_SESSION_COOKIE, { path: '/', secure: config.cookieSecure });
    }
    return c.json({ ok: true });
  });
  api.get('/auth/me', (c) => c.json({ ok: true, actor: c.get('actor') }));

  api.get('/overview', (c) => c.json(store.overview()));

  api.get('/projects', (c) => c.json({ projects: store.listProjects() }));
  api.post('/projects', async (c) => {
    const body = await readBody(c, createProjectSchema);
    return c.json({ project: store.createProject(body, c.get('actor')) }, 201);
  });
  api.patch('/projects/:id', async (c) => {
    const body = await readBody(c, patchProjectSchema);
    return c.json({ project: store.updateProject(c.req.param('id'), body, c.get('actor')) });
  });

  api.get('/cards', (c) => {
    const q = c.req.query();
    const cards = store.listCards({
      project: q.project || undefined,
      status: enumQuery('status', q.status, STATUSES),
      agent: enumQuery('agent', q.agent, AGENTS),
      priority: enumQuery('priority', q.priority, PRIORITIES),
      blocked: parseBool(q.blocked),
      needs_owner: parseBool(q.needs_owner),
      q: q.q || undefined,
      tag: q.tag || undefined,
      include_archived: parseBool(q.include_archived),
      updated_since: q.updated_since || undefined,
      include_dormant: parseBool(q.include_dormant),
    });
    return c.json({ cards });
  });
  api.get('/search', (c) => {
    const q = c.req.query();
    return c.json(store.search((q.q ?? '').slice(0, 200), parseBool(q.include_archived) ?? false));
  });
  api.post('/cards', async (c) => {
    const { project_id, ...rest } = await readBody(c, createCardSchema);
    const input = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as any;
    return c.json({ card: store.createCard(project_id, input, c.get('actor')) }, 201);
  });
  api.get('/cards/:id', (c) => c.json(store.getCardDetail(intParam(c.req.param('id'), 'id'))));
  
  api.get('/cards/:id/brief', (c) => c.json(buildCardBrief(store, intParam(c.req.param('id'), 'id'), { full: parseBool(c.req.query('full')) ?? false })));
  
  api.get('/session-brief', (c) => {
    const agent = enumQuery('agent', c.req.query('agent'), ['claude', 'codex'] as const);
    if (!agent) throw new ApiError(400, 'validation', 'agent is required (codex|claude)');
    const cwds = c.req.queries('cwd') ?? [];
    if (!cwds.length || cwds.length > 4 || cwds.some((x) => !x || x.length > 1024)) throw new ApiError(400, 'validation', 'cwd is required (up to 4 values, each at most 1024 characters)');
    return c.json(buildSessionBrief(store, { cwds, agent }));
  });
  api.patch('/cards/:id', async (c) => {
    const body = await readBody(c, patchCardSchema);
    return c.json({ card: store.updateCard(intParam(c.req.param('id'), 'id'), body, c.get('actor')) });
  });
  api.post('/cards/:id/move', async (c) => {
    const body = await readBody(c, moveSchema);
    return c.json({ card: store.moveCard(intParam(c.req.param('id'), 'id'), body.status, { before_id: body.before_id, after_id: body.after_id }, c.get('actor')) });
  });
  api.post('/cards/:id/notes', async (c) => {
    const body = await readBody(c, noteSchema);
    return c.json(store.addNote(intParam(c.req.param('id'), 'id'), body.body, c.get('actor')), 201);
  });
  api.get('/cards/:id/comments', (c) => c.json({ threads: store.listComments(intParam(c.req.param('id'), 'id')) }));
  api.post('/cards/:id/comments', async (c) => {
    const body = await readBody(c, createCommentSchema);
    return c.json(store.createComment(intParam(c.req.param('id'), 'id'), body.body, body.target, c.get('actor')), 201);
  });
  api.post('/comments/:id/replies', async (c) => {
    const body = await readBody(c, replyCommentSchema);
    return c.json(store.replyComment(intParam(c.req.param('id'), 'id'), body.body, c.get('actor')), 201);
  });
  api.post('/comments/:id/resolve', async (c) => {
    const body = await readBody(c, resolveCommentSchema);
    return c.json(store.resolveComment(intParam(c.req.param('id'), 'id'), body.resolved, c.get('actor')));
  });
  api.get('/comments', (c) => {
    const q = c.req.query();
    return c.json({
      comments: store.listInbox({
        status: enumQuery('status', q.status, [...COMMENT_STATUSES, 'all'] as const),
        target: enumQuery('target', q.target, COMMENT_TARGETS),
        project: q.project || undefined,
        card_id: q.card_id ? intParam(q.card_id, 'card_id') : undefined,
        limit: q.limit ? intParam(q.limit, 'limit') : undefined,
      }),
    });
  });
  api.post('/cards/:id/archive', async (c) => {
    const text = await c.req.text();
    let archived = true;
    if (text.trim()) {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new ApiError(400, 'bad_json', 'Request body must be valid JSON');
      }
      const r = archiveSchema.safeParse(raw);
      if (!r.success) throw new ApiError(400, 'validation', 'archived must be a boolean');
      archived = r.data.archived ?? true;
    }
    return c.json({ card: store.archiveCard(intParam(c.req.param('id'), 'id'), archived, c.get('actor')) });
  });

  api.get('/events', (c) => {
    const q = c.req.query();
    return c.json(
      store.listEvents({
        limit: q.limit ? intParam(q.limit, 'limit') : undefined,
        before: q.before ? intParam(q.before, 'before') : undefined,
        project: q.project || undefined,
        actor: q.actor || undefined,
      }),
    );
  });

  api.get('/stream', (c) => {
    c.header('X-Accel-Buffering', 'no');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');
    return streamSSE(c, async (stream) => {
      const remove = hub.add((chunk) => void stream.write(chunk));
      stream.onAbort(() => {
        remove();
      });
      await stream.write('retry: 3000\nevent: ready\ndata: {}\n\n');
      while (!stream.aborted && !stream.closed) {
        await stream.sleep(opts.pingMs ?? 25000);
        if (stream.aborted || stream.closed) break;
        await stream.write(': ping\n\n');
      }
      remove();
    });
  });

  api.notFound((c) => c.json({ error: { code: 'not_found', message: 'API route not found' } }, 404));
  app.route('/api/v1', api);
  app.all('/api/*', (c) => c.json({ error: { code: 'not_found', message: 'API route not found' } }, 404));

  app.get('/.well-known/webmcp', (c) => {
    c.header('Cache-Control', 'no-cache');
    return c.json({ name: 'agent-kanban', version: 1, tools });
  });

  const mcpDeps = { store, version: config.version, log };
  for (const p of ['/mcp', '/mcp/']) {
    app.post(p, async (c) => {
      const m = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '');
      const actor = m ? lookupToken(m[1].trim(), config.tokens) : null;
      if (!actor) {
        return c.json(jsonRpcError(-32001, 'Unauthorized: a valid Bearer API token is required'), 401, {
          'WWW-Authenticate': 'Bearer realm="agent-kanban"',
          'Cache-Control': 'no-store',
        });
      }
      return handleMcpRequest(c.req.raw, mcpDeps, actor);
    });
    app.all(p, (c) =>
      c.json(jsonRpcError(-32000, 'Method not allowed: this endpoint only accepts POST (stateless, without SSE or sessions)'), 405, { Allow: 'POST', 'Cache-Control': 'no-store' }),
    );
  }

  const staticRoot = config.staticDir;
  let indexHtml: Buffer | null = null;
  app.get('*', (c) => {
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.text('Bad request: invalid percent encoding in path', 400);
    }
    if (urlPath.includes('\0')) return c.text('Bad request', 400);
    if (!fs.existsSync(staticRoot)) return c.text('Frontend has not been built (npm run build)', 404);
    const target = path.normalize(path.join(staticRoot, urlPath));
    if (target.startsWith(staticRoot + path.sep) && fs.existsSync(target) && fs.statSync(target).isFile()) {
      const ext = path.extname(target).toLowerCase();
      c.header('Content-Type', MIME[ext] ?? 'application/octet-stream');
      c.header('Cache-Control', urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      return c.body(new Uint8Array(fs.readFileSync(target)));
    }
    if (path.extname(urlPath)) return c.text('Not found', 404);
    indexHtml ??= fs.readFileSync(path.join(staticRoot, 'index.html'));
    c.header('Content-Type', MIME['.html']);
    c.header('Cache-Control', 'no-cache');
    return c.body(new Uint8Array(indexHtml));
  });

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status as any);
    }
    log(`[error] ${c.req.method} ${new URL(c.req.url).pathname}: ${err.message}`);
    return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
  });

  return {
    app,
    db,
    hub,
    store,
    close: () => {
      if (ownDb) db.close();
    },
  };
}
