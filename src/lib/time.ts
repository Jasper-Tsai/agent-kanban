import { t as tr } from '../i18n/index.ts';
import { REVIEW_WAIT_WARN_HOURS } from '../../shared/constants.ts';

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function parts(d: Date) {
  const o: Record<string, string> = {};
  for (const p of partsFmt.formatToParts(d)) o[p.type] = p.value;
  return o as { year: string; month: string; day: string; hour: string; minute: string };
}


export function formatLocalTime(iso: string | Date): string {
  const p = parts(new Date(iso));
  return `${p.hour}:${p.minute}`;
}

export function formatLocalDate(iso: string | Date): string {
  const p = parts(new Date(iso));
  return `${p.year}-${p.month}-${p.day}`;
}

export function formatLocal(iso: string | Date): string {
  const p = parts(new Date(iso));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function formatLocalDay(iso: string | Date, now: Date = new Date()): string {
  const d = formatLocalDate(iso);
  const today = formatLocalDate(now);
  if (d === today) return tr('ui202');
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const y = formatLocalDate(yesterday);
  if (d === y) return tr('ui203');
  const p = parts(new Date(iso));
  return `${Number(p.month)}/${Number(p.day)}`;
}

function diffs(iso: string, now: Date) {
  const sec = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 1000);
  return { min: Math.floor(sec / 60), hr: Math.floor(sec / 3600), day: Math.floor(sec / 86400) };
}


export function ageShort(iso: string, now: Date = new Date()): string {
  const { min, hr, day } = diffs(iso, now);
  if (min < 1) return tr('ui204');
  if (hr < 1) return tr('ui205', min);
  if (day < 1) return tr('ui206', hr);
  return tr('ui207', day);
}

export function agoLong(iso: string, now: Date = new Date()): string {
  const { min, hr, day } = diffs(iso, now);
  if (min < 1) return tr('ui204');
  if (hr < 1) return tr('ui208', min);
  if (day < 1) return tr('ui209', hr);
  return tr('ui210', day);
}

export function staleFor(hours: number): string {
  return hours < 48 ? tr('ui211', Math.max(1, Math.floor(hours))) : tr('ui212', Math.floor(hours / 24));
}


export function formatLocalMD(iso: string | Date): string {
  const p = parts(new Date(iso));
  return `${p.month}/${p.day}`;
}


export interface ReviewWait {
  hours: number;
  
  label: string;
  
  overdue: boolean;
}
export function reviewWait(statusChangedAt: string, now: Date = new Date(), warnHours = REVIEW_WAIT_WARN_HOURS): ReviewWait {
  const ms = Math.max(0, now.getTime() - new Date(statusChangedAt).getTime());
  const hours = Math.floor(ms / 3600e3);
  const label = hours < 1 ? tr('ui213') : hours < 24 ? tr('ui214', hours) : tr('ui212', Math.floor(hours / 24));
  return { hours, label, overdue: ms > warnHours * 3600e3 };
}


export function longestReviewWait(cards: { status: string; status_changed_at: string }[], now: Date = new Date()): ReviewWait | null {
  let oldest: string | null = null;
  for (const c of cards) if (c.status === 'review' && (oldest === null || c.status_changed_at < oldest)) oldest = c.status_changed_at;
  return oldest === null ? null : reviewWait(oldest, now);
}
