/** Resolve and validate the deployment's IANA timezone. */
export function getTimezone(raw = process.env.KANBAN_TIMEZONE): string {
  const timezone = raw?.trim() || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new Error(`Invalid KANBAN_TIMEZONE: ${timezone}`);
  }
  return timezone;
}

function formatter(timezone: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
}

function parts(format: Intl.DateTimeFormat, date: Date) {
  const p = Object.fromEntries(format.formatToParts(date).map(({ type, value }) => [type, value]));
  return { date: `${p.year}${p.month}${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}

export function dateStamp(date: Date, timezone = getTimezone()): string {
  return parts(formatter(timezone), date).date;
}

export function formatBriefTime(iso: string, timezone = getTimezone()): string {
  const p = parts(formatter(timezone), new Date(iso));
  return `${p.date.slice(0, 4)}-${p.date.slice(4, 6)}-${p.date.slice(6)} ${String(Math.floor(p.minute / 60)).padStart(2, '0')}:${String(p.minute % 60).padStart(2, '0')} ${timezone}`;
}

/**
 * Next local hh:mm strictly after now. Search UTC minutes so IANA offset changes
 * are respected. A spring gap runs at the first valid local minute after the
 * requested time; a repeated fall time uses its next occurrence after now.
 */
export function nextLocalTime(now: Date, hh: number, mm: number, timezone = getTimezone()): number {
  if (!Number.isFinite(now.getTime()) || !Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    throw new Error('Invalid date or local schedule time');
  }
  const fmt = formatter(timezone);
  const target = hh * 60 + mm;
  let epoch = Math.floor(now.getTime() / 60000) * 60000;
  let previous = parts(fmt, new Date(epoch));
  for (let i = 0; i < 4 * 24 * 60; i++) {
    epoch += 60000;
    const current = parts(fmt, new Date(epoch));
    const gapCrossesTarget = current.date === previous.date && previous.minute < target && current.minute > target;
    const midnightGap = current.date !== previous.date && current.minute > target && current.minute > 0;
    if (current.minute === target || gapCrossesTarget || midnightGap) return epoch;
    previous = current;
  }
  throw new Error(`Unable to find next local schedule time in ${timezone}`);
}
