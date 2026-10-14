import { t as tr, agentLabel, useLanguage } from '../i18n/index.ts';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Card, Project } from '../../shared/constants.ts';
import { approveCard, rejectCard } from '../lib/review-actions.ts';
import { ageShort, formatLocal, reviewWait } from '../lib/time.ts';
import { AgentChip, CommentPill, IconCheck, IconReturn, PrioTag } from './common.tsx';

interface Props {
  card: Card;
  project?: Project;
  showProject: boolean;
  lane?: boolean;
  open?: boolean;
  onOpen: (id: number) => void;
  
  onMove?: (card: Card) => void;
  overlay?: boolean;
  
  dormant?: boolean;
  
  originLabel?: string;
}

export function DormantTag() {
  useLanguage();
  return <span className="dormant-tag">{tr('ui030')}</span>;
}


export function ReviewActionRow({ card }: { card: Card }) {
  useLanguage();
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <div className="card-review-actions" onPointerDown={stop} onKeyDown={stop} onClick={stop}>
      <button type="button" className="ra-approve" aria-label={tr('ui031', card.id)} onClick={() => void approveCard(card)}>
        <IconCheck />{tr('ui032')}</button>
      <button type="button" className="ra-return" aria-label={tr('ui033', card.id)} onClick={() => void rejectCard(card)}>
        <IconReturn />{tr('ui034')}</button>
    </div>
  );
}

export function CardBody({ card, project, showProject, lane, onMove, now, dormant, overlay, originLabel }: Omit<Props, 'onOpen' | 'open'> & { now: Date }) {
  useLanguage();
  const reviewing = card.status === 'review';
  const wait = reviewing ? reviewWait(card.status_changed_at, now) : null;
  const stale = card.stale;
  if (lane) {
    return (
      <>
        <div className="card-title">{card.title}</div>
        <div className="card-meta">
          {originLabel && <span className="chip origin">{tr('ui035')}{originLabel}</span>}
          <AgentChip agent={card.agent} />
          {card.needs_owner && <span className="chip ask">{tr('ui036')}</span>}
          <CommentPill count={card.open_comments} />
          <span className="card-id muted small" style={{ marginLeft: 'auto' }}>#{card.id}</span>
        </div>
        {reviewing && !onMove && !overlay && <ReviewActionRow card={card} />}
      </>
    );
  }
  return (
    <>
      {(showProject || onMove) && (
        <div className="card-top">
          <span className="swatch" style={{ background: project?.color ?? 'var(--muted)' }} />
          <span className="pname ellipsis">{project?.name ?? card.project_id}</span>
          {dormant && <DormantTag />}
          <span className="card-id">#{card.id}</span>
        </div>
      )}
      {!showProject && !onMove && (
        <div className="card-top" style={{ justifyContent: 'flex-end' }}>
          <span className="card-id">#{card.id}</span>
        </div>
      )}
      <div className="card-title">{card.title}</div>
      {card.blocked && <div className="card-reason">{tr('ui037')}{card.blocked_reason || tr('ui038')}</div>}
      <div className="card-meta">
        {originLabel && <span className="chip origin">{tr('ui035')}{originLabel}</span>}
        <AgentChip agent={card.agent} />
        <PrioTag p={card.priority} />
        {card.needs_owner && <span className="chip ask">{tr('ui036')}</span>}
        <CommentPill count={card.open_comments} />
        {wait ? (
          <span className={`wait-chip${wait.overdue ? ' late' : ''}`} data-testid="review-wait" title={tr('ui039', formatLocal(card.status_changed_at))}>{tr('ui040')}{wait.label}
          </span>
        ) : (
          <span className={`card-age${stale ? ' stale' : ''}`} title={tr('ui041', formatLocal(card.status_changed_at))}>
            {ageShort(card.status_changed_at, now)}
          </span>
        )}
        {onMove && (
          <button
            type="button"
            className="move-btn"
            onClick={(e) => {
              e.stopPropagation();
              onMove(card);
            }}
          >{tr('ui042')}</button>
        )}
      </div>
      {reviewing && !onMove && !overlay && <ReviewActionRow card={card} />}
    </>
  );
}

export function SortableCard({ card, project, showProject, lane, open, onOpen, dormant, originLabel }: Props) {
  useLanguage();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id, data: { type: 'card' } });
  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`card${lane ? ' lane' : ''}${isDragging ? ' dragging' : ''}${dormant ? ' dormant' : ''}`}
      data-blocked={card.blocked}
      data-ask={card.needs_owner && !card.blocked}
      data-open={!!open}
      data-card-id={card.id}
      aria-label={tr('ui043', card.id, card.title, agentLabel(card.agent))}
      {...attributes}
      {...listeners}
      onClick={() => onOpen(card.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) {
          e.preventDefault();
          onOpen(card.id);
          return;
        }
        listeners?.onKeyDown?.(e as any);
      }}
    >
      <CardBody card={card} project={project} showProject={showProject} lane={lane} now={new Date()} dormant={dormant} originLabel={originLabel} />
    </article>
  );
}

export function PlainCard(props: Props) {
  useLanguage();
  const { card, project, showProject, lane, open, onOpen, onMove, overlay, dormant, originLabel } = props;
  return (
    <article
      className={`card${lane ? ' lane' : ''}${overlay ? ' overlay' : ''}${dormant ? ' dormant' : ''}`}
      data-blocked={card.blocked}
      data-ask={card.needs_owner && !card.blocked}
      data-open={!!open}
      data-card-id={card.id}
      role={overlay ? undefined : 'button'}
      tabIndex={overlay ? undefined : 0}
      onClick={() => onOpen(card.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(card.id);
      }}
    >
      <CardBody card={card} project={project} showProject={showProject} lane={lane} onMove={onMove} now={new Date()} dormant={dormant} overlay={overlay} originLabel={originLabel} />
    </article>
  );
}
