import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp, type AppHandle } from '../../server/app.ts';
import { loadConfig, type Config } from '../../server/config.ts';
import { hashPassword, tokenHash } from '../../server/auth.ts';

export const PASSWORD = crypto.randomBytes(9).toString('hex');
export const TOKENS = { claude: `kbt_${crypto.randomBytes(16).toString('hex')}`, codex: `kbt_${crypto.randomBytes(16).toString('hex')}` };
// Lower the scrypt cost for test fixtures.
const HASH = hashPassword(PASSWORD, 1024, 8, 1);

export interface TestCtx extends AppHandle {
  dir: string;
  config: Config;
  clock: { t: number };
  call: (method: string, url: string, init?: { body?: unknown; token?: keyof typeof TOKENS; cookie?: string; headers?: Record<string, string> }) => Promise<{ status: number; json: any; headers: Headers }>;
  login: () => Promise<string>;
  cleanup: () => void;
}

export function makeTestApp(opts: { seed?: boolean; migrationsDir?: string; dbFile?: string; dir?: string; timezone?: string } = {}): TestCtx {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));
  const env = {
    KANBAN_DATA_DIR: dir,
    KANBAN_TIMEZONE: opts.timezone || 'UTC',
    KANBAN_PASSWORD_HASH: HASH,
    KANBAN_SESSION_SECRET: crypto.randomBytes(24).toString('hex'),
    KANBAN_API_TOKENS: `claude:${tokenHash(TOKENS.claude)},codex:${tokenHash(TOKENS.codex)}`,
    KANBAN_STATIC_DIR: path.join(dir, 'no-static'),
  } as NodeJS.ProcessEnv;
  const config = loadConfig(env);
  if (!opts.seed) config.seedFile = path.join(dir, 'no-seed.json');
  if (opts.migrationsDir) config.migrationsDir = opts.migrationsDir;
  const clock = { t: Date.parse('2026-10-03T00:00:00Z') };
  const handle = createApp({ config, now: () => new Date(clock.t) });

  const call: TestCtx['call'] = async (method, url, init = {}) => {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.token) headers.authorization = `Bearer ${TOKENS[init.token]}`;
    if (init.cookie) {
      headers.cookie = init.cookie;
      if (method !== 'GET' && !headers['x-requested-with']) headers['x-requested-with'] = 'kanban';
    }
    let body: string | undefined;
    if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      headers['content-type'] = 'application/json';
    }
    const res = await handle.app.request(url, { method, headers, body });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  };

  const login = async () => {
    const res = await handle.app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'kanban' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const sc = res.headers.get('set-cookie') ?? '';
    return sc.split(';')[0];
  };

  return { ...handle, dir, config, clock, call, login, cleanup: () => { handle.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
