import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './db.ts';
import { nextLocalTime, dateStamp, getTimezone } from './time.ts';

export const BACKUP_KEEP = 14;
const BACKUP_RE = /^kanban-\d{8}\.db$/;

export function listBackups(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => BACKUP_RE.test(f)).sort();
}

/** Keep successful snapshots until their replacements are complete. */
export function runBackup(db: DB, dir: string, now: Date = new Date(), keep = BACKUP_KEEP, timezone = getTimezone()): { file: string; removed: string[] } {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `kanban-${dateStamp(now, timezone)}.db`);
  const tmp = `${file}.tmp`;
  // Preserve the previous successful same-day backup until VACUUM completes.
  if (fs.existsSync(tmp)) fs.rmSync(tmp);
  const quoted = tmp.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${quoted}'`);
  fs.renameSync(tmp, file);
  const all = listBackups(dir);
  const removed = all.slice(0, Math.max(0, all.length - keep));
  for (const f of removed) fs.rmSync(path.join(dir, f), { force: true });
  return { file, removed };
}

/** Run daily at 03:40 in the configured IANA timezone. */
export function startBackupScheduler(db: DB, dir: string, log: (m: string) => void = console.log, timezone = getTimezone()): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    const delay = Math.max(1000, nextLocalTime(new Date(), 3, 40, timezone) - Date.now());
    timer = setTimeout(() => {
      try {
        const r = runBackup(db, dir, new Date(), BACKUP_KEEP, timezone);
        log(`[backup] ${path.basename(r.file)} completed; removed ${r.removed.length} old backups`);
      } catch (e) {
        log(`[backup] failed: ${(e as Error).message}`);
      }
      schedule();
    }, Math.min(delay, 2 ** 31 - 1));
    timer.unref?.();
  };
  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
