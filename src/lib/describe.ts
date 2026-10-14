import { t as tr, statusLabel, localizedActorLabel } from '../i18n/index.ts';
import { type Actor, type KanbanEvent, type Status } from '../../shared/constants.ts';

export const fieldLabels = (): Record<string, string> => ({
  title: tr('ui068'),
  description: tr('ui070'),
  agent: tr('ui073'),
  priority: tr('ui074'),
  blocked: tr('ui016'),
  blocked_reason: tr('ui100'),
  needs_owner: tr('ui185'),
  branch: tr('ui092'),
  session_ref: 'Session',
  tags: tr('ui096'),
  due_date: tr('ui094'),
  name: tr('ui145'),
  color: tr('ui148'),
  repo_path: 'repo',
  url: tr('ui186'),
  status: tr('ui072'),
  handoff: tr('ui187'),
  sort_order: tr('ui188'),
});

export const actorLabel = (a: string): string => localizedActorLabel(a as Actor) ?? a;


export function describeEvent(e: Pick<KanbanEvent, 'type' | 'card_id' | 'payload'>): string {
  const p = e.payload as Record<string, any>;
  const ref = e.card_id ? `#${e.card_id}` : '';
  switch (e.type) {
    case 'card.created':
      return tr('ui189', ref, p.title ? ` “${p.title}”` : '');
    case 'card.moved':
      return tr('ui190', ref, statusLabel(p.to as Status) ?? p.to);
    case 'card.updated': {
      const fields = Object.keys(p.changes ?? {}).map((k) => fieldLabels()[k] ?? k);
      return tr('ui191', ref, fields.length ? ` (${fields.join(', ')})` : '');
    }
    case 'card.archived':
      return p.archived === false ? tr('ui192', ref) : tr('ui193', ref);
    case 'note.added':
      return tr('ui194', ref, String(p.body ?? '').slice(0, 80));
    case 'comment.created':
      return tr('ui195', ref, localizedActorLabel((p.target as Actor)) ?? p.target ?? '');
    case 'comment.replied':
      return tr('ui196', ref);
    case 'comment.resolved':
      return p.auto ? tr('ui197', ref) : tr('ui198', ref);
    case 'comment.reopened':
      return tr('ui199', ref);
    case 'project.created':
      return tr('ui200', p.name ?? '');
    case 'project.updated': {
      const fields = Object.keys(p.changes ?? {}).map((k) => fieldLabels()[k] ?? k);
      return tr('ui201', p.name ?? '', fields.length ? ` (${fields.join(', ')})` : '');
    }
    default:
      return e.type;
  }
}


export function commentExcerpt(e: Pick<KanbanEvent, 'type' | 'payload'>): string {
  if (e.type !== 'comment.created' && e.type !== 'comment.replied') return '';
  return String((e.payload as any).body ?? '');
}


export function toastText(e: KanbanEvent): string {
  return `${actorLabel(e.actor)} ${describeEvent(e)}`;
}
