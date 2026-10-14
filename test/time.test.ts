import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../server/config.ts';
import { dateStamp, formatBriefTime, getTimezone, nextLocalTime } from '../server/time.ts';
import { runBackup, startBackupScheduler } from '../server/backup.ts';
import { makeTestApp, type TestCtx } from './helpers/server.ts';

let t: TestCtx | undefined;
afterEach(() => { t?.cleanup(); t = undefined; vi.useRealTimers(); vi.unstubAllEnvs(); });
const next = (iso: string, hour: number, minute: number, timezone: string) =>
  new Date(nextLocalTime(new Date(iso), hour, minute, timezone)).toISOString();

describe('Configured timezone', () => {
  it('defaults to UTC and accepts a validated IANA override', () => {
    vi.stubEnv('KANBAN_TIMEZONE', undefined);
    expect(getTimezone()).toBe('UTC');
    expect(loadConfig({}).timezone).toBe('UTC');
    expect(loadConfig({ KANBAN_TIMEZONE: 'America/New_York' }).timezone).toBe('America/New_York');
    expect(() => loadConfig({ KANBAN_TIMEZONE: 'Not/A_Zone' })).toThrow('Invalid KANBAN_TIMEZONE');
    vi.stubEnv('KANBAN_TIMEZONE', 'America/New_York');
    expect(getTimezone()).toBe('America/New_York');
    expect(loadConfig({}).timezone).toBe('UTC');
  });

  it('uses local dates and handles fractional-hour offsets', () => {
    const date = new Date('2026-10-03T00:30:00Z');
    expect(dateStamp(date, 'UTC')).toBe('20261003');
    expect(dateStamp(date, 'America/New_York')).toBe('20261002');
    expect(formatBriefTime(date.toISOString(), 'Asia/Kathmandu')).toBe('2026-10-03 06:15 Asia/Kathmandu');
  });

  it('includes the configured timezone in rendered briefs', async () => {
    t = makeTestApp({ timezone: 'America/New_York' });
    t.store.createProject({ id: 'example', name: 'Example' }, 'system');
    const card = t.store.createCard('example', { title: 'Test' }, 'codex');
    t.store.addNote(card.id, '[handoff] Continue', 'codex');
    const r = await t.call('GET', `/api/v1/cards/${card.id}/brief`, { token: 'codex' });
    expect(r.status).toBe(200);
    expect(r.json.text).toContain('2026-10-02 20:00 America/New_York');
  });

  it('names backups using the configured local calendar date', () => {
    t = makeTestApp();
    const dir = path.join(t.dir, 'backups');
    const result = runBackup(t.db, dir, new Date('2026-10-03T00:30:00Z'), 14, 'America/New_York');
    expect(path.basename(result.file)).toBe('kanban-20261002.db');
  });
});

describe('Daily local schedule', () => {
  it('returns the next strictly future occurrence in UTC', () => {
    expect(next('2026-10-03T00:00:00Z', 3, 40, 'UTC')).toBe('2026-10-03T03:40:00.000Z');
    expect(next('2026-10-03T03:40:00Z', 3, 40, 'UTC')).toBe('2026-10-04T03:40:00.000Z');
    expect(next('2026-10-03T03:39:59Z', 3, 40, 'UTC')).toBe('2026-10-03T03:40:00.000Z');
  });

  it('follows spring and fall offset changes for normal daily times', () => {
    expect(next('2026-03-07T09:00:00Z', 3, 40, 'America/New_York')).toBe('2026-03-08T07:40:00.000Z');
    expect(next('2026-10-31T08:00:00Z', 3, 40, 'America/New_York')).toBe('2026-11-01T08:40:00.000Z');
  });

  it('runs skipped spring times at the first valid minute after the gap', () => {
    expect(next('2026-03-08T06:00:00Z', 2, 30, 'America/New_York')).toBe('2026-03-08T07:00:00.000Z');
    expect(next('2026-03-08T07:00:00Z', 2, 30, 'America/New_York')).toBe('2026-03-09T06:30:00.000Z');
  });

  it('chooses the next occurrence of repeated fall times after now', () => {
    expect(next('2026-11-01T05:00:00Z', 1, 30, 'America/New_York')).toBe('2026-11-01T05:30:00.000Z');
    expect(next('2026-11-01T05:45:00Z', 1, 30, 'America/New_York')).toBe('2026-11-01T06:30:00.000Z');
    expect(next('2026-11-01T06:30:00Z', 1, 30, 'America/New_York')).toBe('2026-11-02T06:30:00.000Z');
  });

  it('rejects invalid local times and invalid dates', () => {
    expect(() => nextLocalTime(new Date(), 24, 0, 'UTC')).toThrow('Invalid date or local schedule time');
    expect(() => nextLocalTime(new Date(), 3, -1, 'UTC')).toThrow();
    expect(() => nextLocalTime(new Date(), 3.5, 0, 'UTC')).toThrow();
    expect(() => nextLocalTime(new Date('invalid'), 3, 40, 'UTC')).toThrow();
  });

  it('the scheduler writes at 03:40 in its configured timezone and can stop', async () => {
    t = makeTestApp();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-08T07:39:00Z'));
    const dir = path.join(t.dir, 'scheduled-backups');
    const log = vi.fn();
    const stop = startBackupScheduler(t.db, dir, log, 'America/New_York');
    await vi.advanceTimersByTimeAsync(59000);
    expect(fs.existsSync(dir)).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fs.readdirSync(dir)).toEqual(['kanban-20260308.db']);
    expect(log).toHaveBeenCalledOnce();
    stop();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(log).toHaveBeenCalledOnce();
  });
});
