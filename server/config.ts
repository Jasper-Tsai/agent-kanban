import path from 'node:path';
import { getTimezone } from './time.ts';
import { AGENT_TOKEN_ACTORS, type AgentTokenActor } from '../shared/constants.ts';

export interface Config {
  port: number;
  timezone: string;
  dataDir: string;
  dbPath: string;
  backupsDir: string;
  migrationsDir: string;
  seedFile: string;
  staticDir: string;
  passwordHash: string;
  sessionSecret: string;
  /** sha256 hex -> actor */
  tokens: Map<string, AgentTokenActor>;
  cookieSecure: boolean;
  trustProxy: boolean;
  version: string;
}

function unquote(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && ((s[0] === "'" && s.at(-1) === "'") || (s[0] === '"' && s.at(-1) === '"'))) return s.slice(1, -1);
  return s;
}

export function parseTokens(raw: string | undefined): Map<string, AgentTokenActor> {
  const map = new Map<string, AgentTokenActor>();
  if (!raw) return map;
  for (const part of unquote(raw).split(',')) {
    const p = part.trim();
    if (!p) continue;
    const [actor, hash] = p.split(':');
    if (!(AGENT_TOKEN_ACTORS as readonly string[]).includes(actor) || !hash || !/^[0-9a-f]{64}$/i.test(hash)) {
      throw new Error(`Invalid KANBAN_API_TOKENS: each entry must be codex|claude:<sha256hex> (invalid actor: ${actor || '(empty)'})`);
    }
    map.set(hash.toLowerCase(), actor as AgentTokenActor);
  }
  return map;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const dataDir = path.resolve(cwd, env.KANBAN_DATA_DIR || 'data');
  return {
    port: Number(env.PORT || 3600),
    timezone: getTimezone(env.KANBAN_TIMEZONE || 'UTC'),
    dataDir,
    dbPath: path.join(dataDir, 'kanban.db'),
    backupsDir: path.join(dataDir, 'backups'),
    migrationsDir: path.resolve(cwd, env.KANBAN_MIGRATIONS_DIR || 'server/migrations'),
    seedFile: path.resolve(cwd, env.KANBAN_SEED_FILE || 'server/seed/seed.json'),
    staticDir: path.resolve(cwd, env.KANBAN_STATIC_DIR || 'dist/client'),
    passwordHash: unquote(env.KANBAN_PASSWORD_HASH || ''),
    sessionSecret: unquote(env.KANBAN_SESSION_SECRET || ''),
    tokens: parseTokens(env.KANBAN_API_TOKENS),
    cookieSecure: env.KANBAN_COOKIE_SECURE !== '0',
    trustProxy: env.KANBAN_TRUST_PROXY === '1',
    version: env.KANBAN_VERSION || '1.0.0',
  };
}

export function assertConfig(c: Config): void {
  const missing: string[] = [];
  if (!c.sessionSecret || c.sessionSecret.length < 16) missing.push('KANBAN_SESSION_SECRET (at least 16 characters)');
  if (!c.passwordHash.startsWith('scrypt$')) missing.push('KANBAN_PASSWORD_HASH (scrypt$N$r$p$salt$hash)');
  if (missing.length) throw new Error(`Missing or invalid configuration: ${missing.join(', ')}`);
}
