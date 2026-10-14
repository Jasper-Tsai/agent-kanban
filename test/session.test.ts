import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { makeTestApp, PASSWORD, TOKENS, type TestCtx } from './helpers/server.ts';
import { SESSION_COOKIE_MAX_AGE_S, createSessionToken, verifySession } from '../server/auth.ts';


const DAY = 24 * 3600 * 1000;
const J = '/api/v1';
const CK = 'kanban_session_dev';
let t: TestCtx;
afterEach(() => { t?.cleanup(); t = undefined as any; });

const setCookieOf = (res: { headers: Headers }) => res.headers.getSetCookie().find((c) => c.startsWith(`${CK}=`)) ?? null;
const tokenOf = (sc: string) => sc.split(';')[0].split('=')[1];
const payloadOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
async function loginRaw(app: TestCtx['app']) {
  const res = await app.request(`${J}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'kanban' }, body: JSON.stringify({ password: PASSWORD }) });
  return setCookieOf(res)!;
}
const me = (cookie: string, app = t.app) => app.request(`${J}/auth/me`, { headers: { cookie: `${CK}=${cookie}` } });

function legacyToken(secret: string, iat: number, exp: number) {
  const payload = Buffer.from(JSON.stringify({ v: 1, iat, exp, n: 'abcdef' })).toString('base64url');
  return `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

describe('Persistent sessions', () => {
  it('new sessions omit expiration and set secure four-hundred-day cookies', async () => {
    t = makeTestApp();
    const sc = await loginRaw(t.app);
    expect(sc).toContain(`Max-Age=${SESSION_COOKIE_MAX_AGE_S}`);
    expect(SESSION_COOKIE_MAX_AGE_S).toBe(400 * 86400);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/Secure/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    const p = payloadOf(tokenOf(sc));
    expect(p.v).toBe(2);
    expect(p).not.toHaveProperty('exp');
  });

  it('sessions remain valid after three years', async () => {
    t = makeTestApp();
    const token = tokenOf(await loginRaw(t.app));
    t.clock.t += 3 * 365 * DAY;
    const r = await me(token);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, actor: 'owner' });
  });
});

describe('Sliding cookie refresh', () => {
  it('cookies refresh after one day and retain valid sessions', async () => {
    t = makeTestApp();
    const token = tokenOf(await loginRaw(t.app));
    const iat0 = payloadOf(token).iat;
    t.clock.t += 23 * 3600 * 1000;
    const early = await me(token);
    expect(early.status).toBe(200);
    expect(setCookieOf(early)).toBeNull();
    t.clock.t += 2 * 3600 * 1000; 
    const late = await me(token);
    expect(late.status).toBe(200);
    const sc = setCookieOf(late)!;
    expect(sc).toBeTruthy();
    expect(sc).toContain(`Max-Age=${SESSION_COOKIE_MAX_AGE_S}`);
    const fresh = tokenOf(sc);
    expect(fresh).not.toBe(token);
    expect(payloadOf(fresh).iat).toBe(t.clock.t);
    expect(payloadOf(fresh).iat).toBeGreaterThan(iat0);
    expect(setCookieOf(await me(fresh))).toBeNull();
    t.clock.t += 25 * 3600 * 1000;
    expect(setCookieOf(await me(fresh))).toBeTruthy();
  });

  it('only cookie authentication refreshes cookies, including writes and streams', async () => {
    t = makeTestApp();
    const token = tokenOf(await loginRaw(t.app));
    t.clock.t += 2 * DAY;
    const bearer = await t.app.request(`${J}/projects`, { headers: { authorization: `Bearer ${TOKENS.claude}` } });
    expect(setCookieOf(bearer)).toBeNull();
    const write = await t.app.request(`${J}/projects`, { method: 'POST', headers: { cookie: `${CK}=${token}`, 'x-requested-with': 'kanban', 'content-type': 'application/json' }, body: JSON.stringify({ id: 'sess-proj', name: 'Refresh test' }) });
    expect(write.status).toBe(201);
    expect(setCookieOf(write)).toBeTruthy();
    const sse = await t.app.request(`${J}/stream`, { headers: { cookie: `${CK}=${tokenOf(setCookieOf(write)!)}` } });
    expect(sse.status).toBe(200);
    await sse.body?.cancel();
    t.clock.t += 2 * DAY;
    const sse2 = await t.app.request(`${J}/stream`, { headers: { cookie: `${CK}=${token}` } });
    expect(setCookieOf(sse2)).toBeTruthy();
    await sse2.body?.cancel();
  });

  it('logout clears cookies without refreshing sessions', async () => {
    t = makeTestApp();
    const token = tokenOf(await loginRaw(t.app));
    t.clock.t += 2 * DAY;
    const out = await t.app.request(`${J}/auth/logout`, { method: 'POST', headers: { cookie: `${CK}=${token}`, 'x-requested-with': 'kanban' } });
    expect(out.status).toBe(200);
    const cookies = out.headers.getSetCookie().filter((c) => c.startsWith(`${CK}=`));
    expect(cookies.length).toBe(1);
    expect(cookies[0]).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  });
});

describe('Version-one session compatibility', () => {
  it('version-one sessions migrate before expiry and reject expired tokens', async () => {
    t = makeTestApp();
    const secret = t.config.sessionSecret;
    const now = t.clock.t;
    const old = legacyToken(secret, now - 10 * DAY, now + 20 * DAY);
    const r = await me(old);
    expect(r.status).toBe(200);
    const sc = setCookieOf(r)!;
    expect(sc).toBeTruthy();
    const fresh = tokenOf(sc);
    expect(payloadOf(fresh).v).toBe(2);
    expect(payloadOf(fresh)).not.toHaveProperty('exp');
    
    expect(setCookieOf(await me(legacyToken(secret, now - 1000, now + 30 * DAY)))).toBeTruthy();
    t.clock.t = now + 21 * DAY;
    expect((await me(old)).status).toBe(401);
    t.clock.t = now + 5 * 365 * DAY;
    expect((await me(fresh)).status).toBe(200);
  });

  it('signature tampering and malformed session fields are rejected', () => {
    const secret = 'x'.repeat(24);
    const good = createSessionToken(secret, 1000);
    expect(verifySession(good, secret, 9e15)).toEqual({ iat: 1000, legacy: false });
    const [payload, sig] = good.split('.');
    expect(verifySession(`${payload}.${sig.slice(0, -2)}AA`, secret, 1)).toBeNull();
    const signed = (obj: object) => { const p = Buffer.from(JSON.stringify(obj)).toString('base64url'); return `${p}.${crypto.createHmac('sha256', secret).update(p).digest('base64url')}`; };
    expect(verifySession(signed({ v: 1, iat: 1 }), secret, 1)).toBeNull();
    expect(verifySession(signed({ v: 9, iat: 1 }), secret, 1)).toBeNull();
    expect(verifySession(signed({ v: 2 }), secret, 1)).toBeNull();
    expect(verifySession(undefined, secret, 1)).toBeNull();
    expect(verifySession(good, '', 1)).toBeNull();
  });
});

describe('Session secret rotation', () => {
  it('rotating the secret invalidates sessions while password login still works', async () => {
    t = makeTestApp();
    const a = tokenOf(await loginRaw(t.app));
    const legacy = legacyToken(t.config.sessionSecret, t.clock.t, t.clock.t + 10 * DAY);
    expect((await me(a)).status).toBe(200);
    const first = t;
    const { createApp } = await import('../server/app.ts');
    const h2 = createApp({ config: { ...first.config, sessionSecret: crypto.randomBytes(24).toString('hex') }, now: () => new Date(first.clock.t) });
    try {
      for (const tok of [a, legacy]) expect((await me(tok, h2.app as any)).status).toBe(401);
      const again = await h2.app.request(`${J}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'kanban' }, body: JSON.stringify({ password: PASSWORD }) });
      expect(again.status).toBe(200);
    } finally {
      h2.close();
    }
  });
});


describe('Cookie name compatibility', () => {
  const OLD = 'kanban_session';
  const OTHER = 'kanban_session_changlong'; 
  const scNamed = (res: { headers: Headers }, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? null;
  const isDeleted = (sc: string | null) => !!sc && /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(sc);
  const writeInit = (cookie: string) => ({ method: 'POST', headers: { cookie, 'x-requested-with': 'kanban' } });
  const loginToken = async (h: TestCtx = t) => tokenOf(scNamed(await h.app.request(`${J}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'kanban' }, body: JSON.stringify({ password: PASSWORD }) }), CK)!);

  it('login sets only the current cookie name', async () => {
    t = makeTestApp();
    const res = await t.app.request(`${J}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'kanban' }, body: JSON.stringify({ password: PASSWORD }) });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().map((c) => c.split('=')[0])).toEqual([CK]);
  });

  it('current cookies refresh under the current name', async () => {
    t = makeTestApp();
    const token = await loginToken();
    const send = () => t.app.request(`${J}/auth/me`, { headers: { cookie: `${CK}=${token}` } });
    expect(setCookieOf(await send())).toBeNull();
    t.clock.t += 2 * DAY;
    const late = await send();
    expect(late.status).toBe(200);
    expect(setCookieOf(late)).toContain(`Max-Age=${SESSION_COOKIE_MAX_AGE_S}`);
    expect(late.headers.getSetCookie().length).toBe(1);
  });

  it('valid legacy cookies migrate without deleting the old cookie', async () => {
    t = makeTestApp();
    const token = await loginToken(); 
    const res = await t.app.request(`${J}/auth/me`, { headers: { cookie: `${OLD}=${token}` } });
    expect(res.status).toBe(200);
    const sc = setCookieOf(res)!;
    expect(sc).toBeTruthy();
    expect(sc).toContain(`Max-Age=${SESSION_COOKIE_MAX_AGE_S}`);
    expect(payloadOf(tokenOf(sc)).v).toBe(2);
    expect(scNamed(res, OLD)).toBeNull(); 
    const again = await t.app.request(`${J}/auth/me`, { headers: { cookie: `${CK}=${tokenOf(sc)}` } });
    expect(again.status).toBe(200);
    expect(again.headers.getSetCookie().length).toBe(0);
  });

  it('version-one tokens under legacy cookie names migrate', async () => {
    t = makeTestApp();
    const old = legacyToken(t.config.sessionSecret, t.clock.t - 1000, t.clock.t + 30 * DAY);
    const res = await t.app.request(`${J}/auth/me`, { headers: { cookie: `${OLD}=${old}` } });
    expect(res.status).toBe(200);
    expect(payloadOf(tokenOf(setCookieOf(res)!)).v).toBe(2);
  });

  it('invalid current cookies fall back to valid legacy cookies', async () => {
    t = makeTestApp();
    const good = createSessionToken(t.config.sessionSecret, t.clock.t);
    const bad = createSessionToken('z'.repeat(24), t.clock.t);
    const res = await t.app.request(`${J}/auth/me`, { headers: { cookie: `${CK}=${bad}; ${OLD}=${good}` } });
    expect(res.status).toBe(200);
    expect(setCookieOf(res)).toBeTruthy();
  });

  it('foreign legacy cookies are rejected and left untouched', async () => {
    t = makeTestApp();
    const foreign = createSessionToken('z'.repeat(24), t.clock.t);
    const res = await t.app.request(`${J}/auth/me`, { headers: { cookie: `${OLD}=${foreign}` } });
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual([]);
    const w = await t.app.request(`${J}/projects`, { method: 'POST', headers: { cookie: `${OLD}=${foreign}`, 'x-requested-with': 'kanban', 'content-type': 'application/json' }, body: JSON.stringify({ id: 'p1', name: 'x' }) });
    expect(w.status).toBe(401);
    expect(w.headers.getSetCookie()).toEqual([]);
    const lo = await t.app.request(`${J}/auth/logout`, writeInit(`${OLD}=${foreign}`));
    expect(lo.status).toBe(401);
    expect(lo.headers.getSetCookie()).toEqual([]);
  });

  it('separate app secrets isolate shared cookie jars', async () => {
    const other = makeTestApp(); 
    t = makeTestApp();
    try {
      const mine = await loginToken();
      const theirs = tokenOf(scNamed(await other.app.request(`${J}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'kanban' }, body: JSON.stringify({ password: PASSWORD }) }), CK)!);
      const jar = `${CK}=${mine}; ${OTHER}=${theirs}`;
      const r = await t.app.request(`${J}/auth/me`, { headers: { cookie: jar } });
      expect(r.status).toBe(200);
      expect(r.headers.getSetCookie()).toEqual([]);
      
      for (const name of [OTHER, OLD, CK]) {
        const x = await t.app.request(`${J}/auth/me`, { headers: { cookie: `${name}=${theirs}` } });
        expect(x.status, name).toBe(401);
        expect(x.headers.getSetCookie(), name).toEqual([]);
      }
      
      const out = await t.app.request(`${J}/auth/logout`, writeInit(jar));
      expect(out.headers.getSetCookie().map((c) => c.split('=')[0])).toEqual([CK]);
    } finally {
      other.cleanup();
    }
  });

  it('logout deletes the current cookie', async () => {
    t = makeTestApp();
    const token = await loginToken();
    const out = await t.app.request(`${J}/auth/logout`, writeInit(`${CK}=${token}`));
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie().map((c) => c.split('=')[0])).toEqual([CK]);
    expect(isDeleted(scNamed(out, CK))).toBe(true);
  });

  it('logout deletes both names for a valid legacy session', async () => {
    t = makeTestApp();
    const old = createSessionToken(t.config.sessionSecret, t.clock.t - 3 * DAY);
    const out = await t.app.request(`${J}/auth/logout`, writeInit(`${OLD}=${old}`));
    expect(out.status).toBe(200);
    const cookies = out.headers.getSetCookie();
    expect(cookies.map((c) => c.split('=')[0]).sort()).toEqual([OLD, CK].sort());
    expect(cookies.every((c) => isDeleted(c))).toBe(true);
  });

  it('logout preserves foreign legacy cookies', async () => {
    t = makeTestApp();
    const token = await loginToken();
    const foreign = createSessionToken('z'.repeat(24), t.clock.t);
    const out = await t.app.request(`${J}/auth/logout`, writeInit(`${CK}=${token}; ${OLD}=${foreign}`));
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie().map((c) => c.split('=')[0])).toEqual([CK]);
  });

  it('SSE and WebMCP accept current cookies and migrate valid legacy cookies', async () => {
    t = makeTestApp();
    const token = await loginToken();
    const sse = await t.app.request(`${J}/stream`, { headers: { cookie: `${CK}=${token}` } });
    expect(sse.status).toBe(200);
    await sse.body?.cancel();
    const sseOld = await t.app.request(`${J}/stream`, { headers: { cookie: `${OLD}=${token}` } });
    expect(sseOld.status).toBe(200);
    expect(setCookieOf(sseOld)).toBeTruthy();
    await sseOld.body?.cancel();
    const web = await t.app.request(`${J}/auth/me`, { headers: { cookie: `${CK}=${token}`, 'x-kanban-actor': 'webmcp' } });
    expect(web.status).toBe(200);
    expect((await web.json()).actor).toBe('webmcp');
    const webOld = await t.app.request(`${J}/auth/me`, { headers: { cookie: `${OLD}=${token}`, 'x-kanban-actor': 'webmcp' } });
    expect(webOld.status).toBe(200);
    expect((await webOld.json()).actor).toBe('webmcp');
    expect(setCookieOf(webOld)).toBeTruthy();
  });
});
