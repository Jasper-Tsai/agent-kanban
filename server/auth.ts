import crypto from 'node:crypto';
import type { AgentTokenActor } from '../shared/constants.ts';

/** Namespaced per deployment; cookies on one host share storage across ports. */
export const SESSION_COOKIE = 'kanban_session_dev';

export const LEGACY_SESSION_COOKIE = 'kanban_session';

/** Persistent sessions use a sliding browser cookie lifetime. */
export const SESSION_COOKIE_MAX_AGE_S = 400 * 24 * 3600;

export const SESSION_REFRESH_MS = 24 * 3600 * 1000;

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return false;
  try {
    const salt = Buffer.from(parts[4], 'hex');
    const expected = Buffer.from(parts[5], 'hex');
    if (!expected.length) return false;
    const got = crypto.scryptSync(password, salt, expected.length, { N, r, p, maxmem: 256 * N * r });
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

export function hashPassword(password: string, N = 16384, r = 8, p = 1): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N, r, p, maxmem: 256 * N * r });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

function sign(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export interface Session {
  iat: number;
  
  legacy: boolean;
}

export function createSessionToken(secret: string, nowMs: number): string {
  const payload = b64u(JSON.stringify({ v: 2, iat: nowMs, n: crypto.randomBytes(8).toString('hex') }));
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySession(token: string | undefined, secret: string, nowMs: number): Session | null {
  if (!token || !secret) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.iat !== 'number') return null;
    if (data.v === 2) return { iat: data.iat, legacy: false };
    if (data.v === 1 && typeof data.exp === 'number' && data.exp > nowMs) return { iat: data.iat, legacy: true };
    return null;
  } catch {
    return null;
  }
}

export function verifySessionToken(token: string | undefined, secret: string, nowMs: number): boolean {
  return verifySession(token, secret, nowMs) !== null;
}

export function needsRefresh(s: Session, nowMs: number): boolean {
  return s.legacy || nowMs - s.iat > SESSION_REFRESH_MS;
}

export function tokenHash(plain: string): string {
  return crypto.createHash('sha256').update(plain).digest('hex');
}

export function lookupToken(plain: string, tokens: Map<string, AgentTokenActor>): AgentTokenActor | null {
  const h = Buffer.from(tokenHash(plain), 'hex');
  let found: AgentTokenActor | null = null;
  for (const [hash, actor] of tokens) {
    const hb = Buffer.from(hash, 'hex');
    if (hb.length === h.length && crypto.timingSafeEqual(hb, h)) found = actor;
  }
  return found;
}

export class LoginLimiter {
  private fails = new Map<string, number[]>();
  constructor(
    private max = 5,
    private windowMs = 15 * 60 * 1000,
  ) {}
  private prune(key: string, nowMs: number): number[] {
    const arr = (this.fails.get(key) ?? []).filter((t) => nowMs - t < this.windowMs);
    if (arr.length) this.fails.set(key, arr);
    else this.fails.delete(key);
    return arr;
  }
  
  blockedFor(key: string, nowMs: number): number {
    const arr = this.prune(key, nowMs);
    if (arr.length < this.max) return 0;
    return Math.max(1, Math.ceil((arr[0] + this.windowMs - nowMs) / 1000));
  }
  recordFailure(key: string, nowMs: number) {
    const arr = this.prune(key, nowMs);
    arr.push(nowMs);
    this.fails.set(key, arr);
  }
  reset(key: string) {
    this.fails.delete(key);
  }
}
