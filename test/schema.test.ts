import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../server/db.ts';
import { makeTestApp, type TestCtx } from './helpers/server.ts';

let t: TestCtx | undefined;
afterEach(() => { t?.cleanup(); t = undefined; });

describe('Fresh public schema', () => {
  it('contains one clean migration with only the board tables', () => {
    expect(fs.readdirSync('server/migrations')).toEqual(['0001_init.sql']);
    const sql = fs.readFileSync(path.join('server/migrations', '0001_init.sql'), 'utf8');
    expect(sql).not.toMatch(/ALTER TABLE|DROP TABLE|INSERT INTO|foreign_keys=off/i);
    t = makeTestApp();
    expect(t.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(t.db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    const names = t.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    for (const name of ['projects', 'cards', 'events', 'notes', 'comments']) expect(names).toContain(name);
    expect(names.filter((n: string) => /relay|binding/.test(n))).toEqual([]);
    const fields = t.db.prepare('PRAGMA table_info(comments)').all().map((r: any) => r.name);
    expect(fields).not.toContain('relay_job_id');
    expect(fields).not.toContain('source_message_id');
    expect(t.db.prepare('SELECT name FROM schema_migrations').all()).toEqual([{ name: '0001_init.sql' }]);
  });

  it('reopens a fresh database and exposes no internal fields in the public API', async () => {
    t = makeTestApp();
    const dir = t.dir;
    t.close();
    t = makeTestApp({ dir });
    await t.call('POST', '/api/v1/projects', { token: 'claude', body: { id: 'proj-a', name: 'A', repo_path: '/tmp/proj-a' } });
    const card = (await t.call('POST', '/api/v1/cards', { token: 'claude', body: { project_id: 'proj-a', title: 'c' } })).json.card;
    const cookie = await t.login();
    const c = await t.call('POST', `/api/v1/cards/${card.id}/comments`, { cookie, body: { body: 'q', target: 'codex' } });
    expect(c.status).toBe(201);
    const list = await t.call('GET', `/api/v1/cards/${card.id}/comments`, { token: 'codex' });
  });
});

it('rolls back an invalid fresh migration without recording it', () => {
  t = makeTestApp();
  const dir = path.join(t.dir, 'invalid-migrations');
  fs.mkdirSync(dir);
  fs.copyFileSync('server/migrations/0001_init.sql', path.join(dir, '0001_init.sql'));
  fs.writeFileSync(path.join(dir, '0002_invalid.sql'), 'CREATE TABLE partial_result(id INTEGER); THIS IS INVALID SQL;');
  const { db } = t;
  expect(() => runMigrations(db, dir)).toThrow(/Migration 0002_invalid.sql failed/);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='partial_result'").get()).toBeUndefined();
  expect(db.prepare('SELECT name FROM schema_migrations').all()).toEqual([{ name: '0001_init.sql' }]);
  expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
});
