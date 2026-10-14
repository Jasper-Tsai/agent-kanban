import { t as tr, statusLabel, useLanguage } from '../i18n/index.ts';
import { useState } from 'react';
import { STATUSES, type Card, type Project, type Status } from '../../shared/constants.ts';
import { groupByStatus, isExtractedBlocked, splitBlocked, visibleDone } from '../lib/filters.ts';
import { store } from '../store/store.ts';
import { approveCard, rejectCard } from '../lib/review-actions.ts';
import { PlainCard } from './CardView.tsx';
import { IconCheck, IconReturn } from './common.tsx';

type Tab = Status | 'blocked';

const TABS: Tab[] = ['backlog', 'blocked', 'todo', 'in_progress', 'review', 'done'];

export function MobileBoard({ cards, projectMap, openCardId, onOpen, fixedProject }: { cards: Card[]; projectMap: Map<string, Project>; openCardId: number | null; onOpen: (id: number) => void; fixedProject?: string }) {
  useLanguage();
  const [tab, setTab] = useState<Tab>('in_progress');
  const [moving, setMoving] = useState<Card | null>(null);
  const [showAllDone, setShowAllDone] = useState(false);
  const { blocked, rest } = splitBlocked(cards);
  const all = groupByStatus(rest);
  const list = tab === 'blocked' ? blocked : tab === 'done' ? visibleDone(all.done, new Date(), showAllDone) : all[tab];
  const count = (t: Tab) => (t === 'blocked' ? blocked.length : all[t].length);
  const fromBlocked = moving ? isExtractedBlocked(moving) : false;
  const setBlocked = (card: Card, value: boolean) => {
    setMoving(null);
    void store.patchCard(card.id, { blocked: value }).catch((e) => store.error(e));
  };
  return (
    <>
      <div className="m-tabs" role="tablist" aria-label={tr('ui128')}>
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" data-status={t} aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === 'blocked' ? tr('ui016') : statusLabel(t)} {count(t)}
          </button>
        ))}
      </div>
      <div className="m-list" role="tabpanel">
        {list.length === 0 && <div className="empty-drop">{tr('ui129')}</div>}
        {list.map((c) => (
          <PlainCard key={c.id} card={c} project={projectMap.get(c.project_id)} showProject open={openCardId === c.id} onOpen={onOpen} onMove={setMoving} originLabel={tab === 'blocked' ? statusLabel(c.status) : undefined} dormant={!fixedProject && !!projectMap.get(c.project_id)?.dormant} />
        ))}
        {tab === 'done' && all.done.length > list.length && !showAllDone && (
          <button type="button" className="more-btn" style={{ margin: 0 }} onClick={() => setShowAllDone(true)}>{tr('ui130')}</button>
        )}
      </div>
      {moving && (
        <div className="modal-wrap" onClick={() => setMoving(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label={tr('ui131')} onClick={(e) => e.stopPropagation()}>
            <h2>{tr('ui132')}{moving.id}{tr('ui133')}</h2>
            <div className="nav">
              {moving.status === 'review' && (
                <div className="m-review-actions" data-testid="m-review-actions">
                  <button type="button" className="ra-approve" onClick={() => { void approveCard(moving); setMoving(null); }}><IconCheck />{tr('ui085')}</button>
                  <button type="button" className="ra-return" onClick={() => { void rejectCard(moving); setMoving(null); }}><IconReturn />{tr('ui086')}</button>
                </div>
              )}
              {moving.blocked ? (
                <button type="button" className="nav-item" data-testid="m-unblock" style={{ background: 'transparent', border: 0, minHeight: 48, textAlign: 'left' }} onClick={() => setBlocked(moving, false)}>
                  <span className="dot" data-status="blocked" />{tr('ui134')}</button>
              ) : (
                moving.status !== 'done' && (
                  <button type="button" className="nav-item" data-testid="m-block" style={{ background: 'transparent', border: 0, minHeight: 48, textAlign: 'left' }} onClick={() => setBlocked(moving, true)}>
                    <span className="dot" data-status="blocked" />{tr('ui135')}</button>
                )
              )}
              {STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="nav-item"
                  style={{ background: 'transparent', border: 0, minHeight: 48, textAlign: 'left' }}
                  disabled={s === moving.status && !fromBlocked}
                  onClick={() => {
                    const target = all[s].filter((c) => c.id !== moving.id);
                    const card = moving;
                    setMoving(null);
                    void (async () => {
                      const ok = await store.moveCard(card.id, s, target.map((c) => ({ id: c.id, position: c.position })), {});
                      
                      if (ok && isExtractedBlocked(card)) {
                        try {
                          await store.patchCard(card.id, { blocked: false });
                        } catch (e) {
                          store.error(e);
                        }
                      }
                    })();
                  }}
                >
                  <span className="dot" data-status={s} /> {statusLabel(s)}
                  {s === moving.status && <span className="muted small">{fromBlocked ? tr('ui136') : tr('ui137')}</span>}
                </button>
              ))}
            </div>
            <div className="modal-actions"><button type="button" className="btn-ghost" onClick={() => setMoving(null)}>{tr('ui075')}</button></div>
          </div>
        </div>
      )}
    </>
  );
}
