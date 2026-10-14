import { t as tr, useLanguage } from '../i18n/index.ts';
import { actorLabel, commentExcerpt, describeEvent } from '../lib/describe.ts';
import { formatLocal, formatLocalDate, formatLocalDay, formatLocalTime } from '../lib/time.ts';
import type { KanbanEvent, Project } from '../../shared/constants.ts';
import { AppLink } from './common.tsx';

export function EventList({ events, projectMap, showProject = true }: { events: KanbanEvent[]; projectMap: Map<string, Project>; showProject?: boolean }) {
  useLanguage();
  const now = new Date();
  const out: React.ReactNode[] = [];
  let lastDay = '';
  for (const e of events) {
    const day = formatLocalDate(e.created_at);
    if (day !== lastDay) {
      lastDay = day;
      out.push(<div className="day-label" key={`d-${day}`}>{formatLocalDay(e.created_at, now)} · {day}</div>);
    }
    const p = projectMap.get(e.project_id);
    const title = e.type === 'card.created' ? '' : (e.payload as any).title;
    out.push(
      <div className="ev-row" key={e.id}>
        <span className="ev-time" title={tr('ui111', formatLocal(e.created_at))}>{formatLocalTime(e.created_at)}</span>
        <div className="ev-body">
          <span className="actor-name" data-actor={e.actor}>{actorLabel(e.actor)}</span>
          <span style={{ color: 'var(--text-2)' }}>{' '}{describeEvent(e)}</span>
          {title && e.card_id && (
            <>
              {' '}
              <AppLink className="card-link" to={`/p/${e.project_id}?card=${e.card_id}`}>{String(title)}</AppLink>
            </>
          )}
          {!title && e.card_id && e.type === 'card.created' && (
            <>{' '}<AppLink className="card-link" to={`/p/${e.project_id}?card=${e.card_id}`}>{tr('ui093')}</AppLink></>
          )}
          {commentExcerpt(e) && <div className="ev-excerpt">{commentExcerpt(e)}</div>}
          {showProject && p && <span className="proj-tag"><span className="proj-swatch" style={{ background: p.color, display: 'inline-block', marginRight: 5 }} />{p.name}</span>}
        </div>
      </div>,
    );
  }
  if (!out.length) return <div className="muted small">{tr('ui112')}</div>;
  return <>{out}</>;
}
