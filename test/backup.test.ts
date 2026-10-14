import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.ts';
import { listBackups, runBackup } from '../server/backup.ts';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

it('preserves the prior same-day SQLite backup on failed VACUUM and replaces it only after success', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-backup-')); dirs.push(dir);
  const db = openDb(':memory:');
  try {
    db.exec('CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES (\'old\')');
    const now = new Date('2026-10-08T04:00:00Z');
    const first = runBackup(db, dir, now);
    const bytes = fs.readFileSync(first.file);
    db.exec("UPDATE fixture SET value='new'");
    fs.writeFileSync(first.file + '.tmp', 'stale partial');
    const fail = vi.spyOn(db, 'exec').mockImplementationOnce(() => {
      fs.writeFileSync(first.file + '.tmp', 'failed partial');
      throw new Error('injected VACUUM failure');
    });
    expect(() => runBackup(db, dir, now)).toThrow('injected VACUUM failure');
    expect(fs.readFileSync(first.file)).toEqual(bytes);
    expect(listBackups(dir)).toEqual(['kanban-20261008.db']);
    fail.mockRestore();
    const next = runBackup(db, dir, now);
    expect(next.file).toBe(first.file); expect(fs.existsSync(first.file + '.tmp')).toBe(false);
    const backup = openDb(next.file);
    try { expect(backup.prepare('SELECT value FROM fixture').get()).toEqual({ value: 'new' }); }
    finally { backup.close(); }
  } finally { db.close(); }
});

it('does not prune successful older backups when today VACUUM fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-backup-')); dirs.push(dir);
  const db = openDb(':memory:');
  try {
    db.exec('CREATE TABLE fixture(value TEXT)');
    runBackup(db, dir, new Date('2026-10-07T04:00:00Z'));
    vi.spyOn(db, 'exec').mockImplementationOnce(() => { throw new Error('injected failure'); });
    expect(() => runBackup(db, dir, new Date('2026-10-08T04:00:00Z'), 1)).toThrow('injected failure');
    expect(listBackups(dir)).toEqual(['kanban-20261007.db']);
  } finally { db.close(); }
});
