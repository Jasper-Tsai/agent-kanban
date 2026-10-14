import { t as tr, agentLabel, statusLabel, localizedActorLabel, useLanguage } from '../i18n/index.ts';
import { useEffect, useState } from 'react';
import { type Agent, type Card, type InboxItem, type Status } from '../../shared/constants.ts';
import { AppLink, AgentChip } from '../components/common.tsx';
import { splitProjects } from '../lib/dormant.ts';
import { agoLong, formatLocal, formatLocalTime, staleFor } from '../lib/time.ts';
import { IconChevronDown } from '../components/common.tsx';
import { store, useStore } from '../store/store.ts';

interface OverviewProject {
  id: string; name: string; color: string; description: string; handoff: string; status: string;
  counts: Record<Status, number>; blocked: number; needs_owner: number; stale: boolean; stale_for_hours: number | null;
  agents: Record<Agent, number>; last_activity: string;
  dormant: boolean; dormant_since: string | null; review_overdue: number;
}
interface OverviewData { projects: OverviewProject[]; focus: Card[]; open_comments: InboxItem[]; totals: { needs_owner: number; blocked: number; stale: number; open_comments: number }; generated_at: string }

const SEG: [Status, string][] = [['backlog', '#4A5260'], ['todo', '#8AB4FF'], ['in_progress', '#F2C14E'], ['review', '#C4A5FF'], ['done', '#5FCB8F']];

export function OverviewPage() {
  useLanguage();
  const { version, projects } = useStore();
  const [data, setData] = useState<OverviewData | null>(null);
  const [failed, setFailed] = useState(false);
  const [dormantOpen, setDormantOpen] = useState(false);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      store.rest.get<OverviewData>('/overview').then((d) => live && (setData(d), setFailed(false))).catch(() => live && setFailed(true));
    }, data ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [version]);
  const pmap = new Map(projects.map((p) => [p.id, p]));
  if (!data) return <div className="empty-page">{failed ? tr('ui237') : tr('ui004')}</div>;
  const now = new Date();
  const { active, dormant } = splitProjects(data.projects);
  return (
    <div className="overview">
      <header className="ov-head">
        <h1>{tr('ui000')}</h1>
        <span className="muted">{active.length}{tr('ui238')}{formatLocalTime(data.generated_at)}</span>
        <AppLink to="/board" className="ml-auto" style={{ fontWeight: 500 }}>{tr('ui239')}</AppLink>
      </header>

      <section className="focus" aria-label={tr('ui240')}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2>{tr('ui240')}</h2>
          <span className="small muted">{tr('ui241')}{data.totals.needs_owner}{tr('ui242')}{data.totals.blocked}{tr('ui243')}{data.totals.open_comments}</span>
        </div>
        {data.focus.length === 0 && data.open_comments.length === 0 ? (
          <div className="muted small">{tr('ui244')}</div>
        ) : (
          <>
          {data.focus.length > 0 && <div className="focus-grid">
            {data.focus.map((c) => {
              const p = pmap.get(c.project_id);
              return (
                <AppLink key={c.id} to={`/p/${c.project_id}?card=${c.id}`} className={`focus-item ${c.blocked ? 'blocked' : 'ask'}`}>
                  <div className="focus-top">
                    {c.needs_owner && <span className="chip ask">{tr('ui036')}</span>}
                    {c.blocked && <span className="chip blocked">{tr('ui016')}</span>}
                    <span className="swatch" style={{ width: 8, height: 8, borderRadius: 2, background: p?.color }} />
                    <span className="muted">{p?.name ?? c.project_id}</span>
                    <span className="mono muted ml-auto">#{c.id}</span>
                  </div>
                  <div>{c.title}</div>
                  {c.blocked && c.blocked_reason && <div className="card-reason">{tr('ui037')}{c.blocked_reason}</div>}
                </AppLink>
              );
            })}
          </div>}
          {data.open_comments.length > 0 && (
            <div className="cm-inbox" data-section="open-comments">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{tr('ui245')}</span>
                <span className="small muted">{data.totals.open_comments}</span>
              </div>
              <div className="focus-grid">
                {data.open_comments.map((i) => {
                  const to = i.root.target ?? 'codex';
                  return (
                    <AppLink key={i.root.id} to={`/p/${i.project.id}?card=${i.card.id}`} className="cm-inbox-item">
                      <div className="top">
                        <span className="cm-to" data-agent={to}>{tr('ui246')}{localizedActorLabel(to)}</span>
                        <span className="muted">{i.project.name}</span>
                        <span className="mono muted ml-auto">#{i.card.id}</span>
                      </div>
                      <div className="body">{i.replies.length ? i.replies[i.replies.length - 1].body : i.root.body}</div>
                    </AppLink>
                  );
                })}
              </div>
            </div>
          )}
          </>
        )}
      </section>

      <section className="proj-grid" aria-label={tr('ui002')}>
        {active.map((p) => {
          const agentChips = (['codex', 'claude', 'owner'] as Agent[]).filter((a) => p.agents[a] > 0);
          const handoff = p.handoff.split('\n').filter((l) => l.trim()).slice(0, 2).join('\n');
          return (
            <AppLink key={p.id} to={`/p/${p.id}`} className={`proj-card${p.stale ? ' stale' : ''}`}>
              <div className="proj-head">
                <span className="proj-swatch" style={{ background: p.color, width: 12, height: 12 }} />
                <h3>{p.name}</h3>
                {p.status === 'paused' && <span className="small muted">{tr('ui139')}</span>}
                {p.stale && p.stale_for_hours != null && <span className="small" style={{ color: 'var(--ask-fg)' }}>{tr('ui247')}{staleFor(p.stale_for_hours)}</span>}
              </div>
              <div className="bar" role="img" aria-label={SEG.map(([s]) => `${s}:${p.counts[s]}`).join(' ')}>
                {SEG.map(([s, color]) => (p.counts[s] > 0 ? <span key={s} style={{ flex: p.counts[s], background: color }} /> : null))}
              </div>
              <div className="stats">
                <div><div>{tr('ui248')}</div><div className="n">{p.counts.todo}</div></div>
                <div><div>{statusLabel('in_progress')}</div><div className="n">{p.counts.in_progress}</div></div>
                <div><div>{tr('ui249')}</div><div className="n">{p.counts.review}</div></div>
                <div><div>{tr('ui016')}</div><div className={`n${p.blocked ? ' bad' : ''}`}>{p.blocked}</div></div>
              </div>
              <div className="pills" style={{ gap: 6 }}>
                {agentChips.length === 0 && <AgentChip agent="none" label={tr('ui250')} />}
                {agentChips.map((a) => <AgentChip key={a} agent={a} label={tr('ui251', agentLabel(a), p.agents[a])} />)}
                {p.needs_owner > 0 && <span className="chip ask">{tr('ui252')}{p.needs_owner}</span>}
                {p.review_overdue > 0 && <span className="chip ask" data-testid="review-backlog" title={tr('ui253')}>{tr('ui254')}{p.review_overdue}</span>}
              </div>
              {handoff && (
                <div className="handoff-mini">
                  <span className="small muted">{tr('ui187')}</span>
                  <span className="t">{handoff}</span>
                </div>
              )}
              <div className="small muted" title={tr('ui255', formatLocal(p.last_activity))}>{tr('ui256')}{agoLong(p.last_activity, now)}</div>
            </AppLink>
          );
        })}
      </section>

      {dormant.length > 0 && (
        <section className="dormant-row" aria-label={tr('ui257')} data-testid="overview-dormant">
          <button type="button" className="dormant-row-head" aria-expanded={dormantOpen} onClick={() => setDormantOpen((v) => !v)}>
            <IconChevronDown open={dormantOpen} />{tr('ui258')}{dormant.length}{tr('ui259')}</button>
          {dormantOpen && (
            <div className="dormant-list">
              {dormant.map((p) => (
                <AppLink key={p.id} to={`/p/${p.id}`} className="dormant-item">
                  <span className="proj-swatch" style={{ background: p.color, opacity: 0.55 }} />
                  <span className="ellipsis" style={{ flex: 1 }}>{p.name}</span>
                  <span className="small muted" title={tr('ui255', formatLocal(p.last_activity))}>{tr('ui256')}{agoLong(p.last_activity, now)}</span>
                </AppLink>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
