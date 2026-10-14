import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type DB = DatabaseSync;

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

export function sha256(buf: string | Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function runMigrations(db: DB, migrationsDir: string, now: () => Date = () => new Date()): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const files = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort()
    : [];
  const applied = new Map<string, string>(
    (db.prepare('SELECT name, checksum FROM schema_migrations').all() as { name: string; checksum: string }[]).map((r) => [r.name, r.checksum]),
  );
  for (const name of applied.keys()) {
    if (!files.includes(name)) throw new Error(`Migration file missing: ${name}; refusing startup`);
  }
  const newly: string[] = [];
  for (const name of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, name));
    const checksum = sha256(sql);
    const prev = applied.get(name);
    if (prev !== undefined) {
      if (prev !== checksum) throw new Error(`Migration checksum mismatch: ${name}; applied migrations must not change`);
      continue;
    }
    try {
      tx(db, () => {
        db.exec(sql.toString('utf8'));
        const violations = db.prepare('PRAGMA foreign_key_check').all();
        if (violations.length) throw new Error(`foreign_key_check found ${violations.length} violations`);
        db.prepare('INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)').run(name, checksum, now().toISOString());
      });
    } catch (e) {
      throw new Error(`Migration ${name} failed: ${(e as Error).message}`);
    }
    newly.push(name);
  }
  return newly;
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }
}
