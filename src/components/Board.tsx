import { t as tr, statusLabel, useLanguage } from '../i18n/index.ts';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { STATUSES, type Card, type Project, type Status } from '../../shared/constants.ts';
import { groupByStatus, isExtractedBlocked, isOverWip, sortByPosition, splitBlocked, visibleDone } from '../lib/filters.ts';
import { longestReviewWait } from '../lib/time.ts';
import { store } from '../store/store.ts';
import { IconChevron, IconPlus } from './common.tsx';
import { DormantTag, PlainCard, SortableCard } from './CardView.tsx';

const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  if (hits.length) return [hits.find((h) => typeof h.id === 'number') ?? hits[0]];
  return closestCorners(args);
};

interface BoardProps {
  cards: Card[]; 
  projects: Project[];
  projectMap: Map<string, Project>;
  
  fixedProject?: string;
  openCardId: number | null;
  onOpen: (id: number) => void;
  mode: 'flat' | 'swimlane';
  
  forceBlockedOpen?: boolean;
}


export const BLOCKED_DROP_ID = 'blocked';
export const BLOCKED_OPEN_KEY = 'kanban.blockedColumn.open';

function readBlockedOpen(): boolean {
  try {
    return localStorage.getItem(BLOCKED_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function parseContainer(id: string): { status: Status; project?: string } | null {
  const m = /^col:(.+)$/.exec(id) ?? null;
  if (m) return { status: m[1] as Status };
  const c = /^cell:([^:]+):(.+)$/.exec(id);
  if (c) return { project: c[1], status: c[2] as Status };
  return null;
}

export function Board(props: BoardProps) {
  useLanguage();
  const { cards, projectMap, mode, fixedProject } = props;
  const [activeId, setActiveId] = useState<number | null>(null);
  const [showAllDone, setShowAllDone] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] },
    }),
  );
  const now = new Date();
  const doneVisible = useMemo(() => visibleDone(cards.filter((c) => c.status === 'done'), now, showAllDone), [cards, showAllDone]);
  const hiddenDone = cards.filter((c) => c.status === 'done').length - doneVisible.length;
  const shown = useMemo(() => [...cards.filter((c) => c.status !== 'done'), ...doneVisible], [cards, doneVisible]);
  
  const extract = !(mode === 'swimlane' && !fixedProject);
  const split = useMemo(() => (extract ? splitBlocked(shown) : { blocked: [] as Card[], rest: shown }), [shown, extract]);
  const blockedCards = split.blocked;
  const byStatus = useMemo(() => groupByStatus(split.rest), [split.rest]);
  const blockedIds = useMemo(() => new Set(blockedCards.map((c) => c.id)), [blockedCards]);
  const [blockedOpenPref, setBlockedOpenPref] = useState(readBlockedOpen);
  const blockedOpen = !!props.forceBlockedOpen || blockedOpenPref;
  const toggleBlocked = () => {
    const next = !blockedOpenPref;
    setBlockedOpenPref(next);
    try {
      localStorage.setItem(BLOCKED_OPEN_KEY, next ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
  const active = activeId != null ? cards.find((c) => c.id === activeId) : undefined;

  function onDragStart(e: DragStartEvent) {
    setActiveId(Number(e.active.id));
  }

  function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const { active: a, over } = e;
    if (!over) return;
    const id = Number(a.id);
    const card = cards.find((c) => c.id === id);
    if (!card) return;
    const wasBlockedCol = extract && blockedIds.has(id);
    
    if (extract && (over.id === BLOCKED_DROP_ID || (typeof over.id === 'number' && blockedIds.has(over.id)))) {
      if (wasBlockedCol || card.status === 'done' || card.blocked) return; 
      void store.patchCard(id, { blocked: true }).catch((err) => store.error(err));
      return;
    }
    let status: Status;
    let project: string | undefined;
    let overCardId: number | null = null;
    if (typeof over.id === 'string') {
      const c = parseContainer(over.id);
      if (!c) return;
      status = c.status;
      project = c.project;
    } else {
      const oc = cards.find((x) => x.id === over.id);
      if (!oc) return;
      status = oc.status;
      project = oc.project_id;
      overCardId = oc.id;
    }
    if (mode === 'swimlane' && project !== card.project_id) return; 
    if (overCardId === id) return;
    
    const visible = extract ? shown.filter((c) => !isExtractedBlocked(c)) : shown;
    const inScope = (c: Card) => c.status === status && (mode === 'swimlane' ? c.project_id === card.project_id : true);
    const column = sortByPosition(visible.filter((c) => inScope(c) && c.id !== id));
    const nb: { before_id?: number; after_id?: number } = {};
    let index = column.length;
    if (overCardId != null) {
      const oi = column.findIndex((c) => c.id === overCardId);
      const r = a.rect.current.translated;
      const below = !!r && r.top + r.height / 2 > over.rect.top + over.rect.height / 2;
      if (below) {
        nb.after_id = overCardId;
        index = oi + 1;
      } else {
        nb.before_id = overCardId;
        index = oi;
      }
    }
    if (card.status === status && !wasBlockedCol) {
      const current = sortByPosition(visible.filter(inScope)).map((c) => c.id);
      const next = [...column.map((c) => c.id)];
      next.splice(index, 0, id);
      if (current.join() === next.join()) return;
    }
    const target = column.map((c) => ({ id: c.id, position: c.position }));
    if (!wasBlockedCol) {
      void store.moveCard(id, status, target, nb);
      return;
    }
    
    void (async () => {
      if (!(await store.moveCard(id, status, target, nb))) return; 
      try {
        await store.patchCard(id, { blocked: false });
      } catch (err) {
        store.error(err);
      }
    })();
  }

  const dnd = { sensors, collisionDetection: collision, onDragStart, onDragEnd, onDragCancel: () => setActiveId(null) };
  const overlay = (
    <DragOverlay dropAnimation={null}>
      {active ? (
        <PlainCard card={active} project={projectMap.get(active.project_id)} showProject={!fixedProject} lane={mode === 'swimlane'} onOpen={() => {}} overlay dormant={!fixedProject && !!projectMap.get(active.project_id)?.dormant} />
      ) : null}
    </DragOverlay>
  );

  if (mode === 'swimlane' && !fixedProject) {
    return (
      <DndContext {...dnd}>
        <Lanes {...props} byStatus={byStatus} shown={shown} />
        {overlay}
      </DndContext>
    );
  }
  return (
    <DndContext {...dnd}>
      <div className={`board${fixedProject ? ' compact' : ''}${blockedOpen ? ' blocked-open' : ''}`}>
        {STATUSES.map((s) => (
          <Fragment key={s}>
            <Column {...props} status={s} cards={byStatus[s]} total={cards.filter((c) => c.status === s && !(extract && isExtractedBlocked(c))).length}>
              {s === 'done' && (hiddenDone > 0 || showAllDone) && (
                <button type="button" className="more-btn" onClick={() => setShowAllDone((v) => !v)}>
                  {showAllDone ? tr('ui014') : tr('ui015', hiddenDone)}
                </button>
              )}
            </Column>
            {s === 'backlog' && (
              <BlockedColumn cards={blockedCards} open={blockedOpen} locked={!!props.forceBlockedOpen} onToggle={toggleBlocked} projectMap={projectMap} fixedProject={fixedProject} openCardId={props.openCardId} onOpen={props.onOpen} />
            )}
          </Fragment>
        ))}
      </div>
      {overlay}
    </DndContext>
  );
}


function BlockedColumn({ cards, open, locked, onToggle, projectMap, fixedProject, openCardId, onOpen }: {
  cards: Card[];
  open: boolean;
  locked: boolean;
  onToggle: () => void;
  projectMap: Map<string, Project>;
  fixedProject?: string;
  openCardId: number | null;
  onOpen: (id: number) => void;
}) {
  useLanguage();
  const { setNodeRef, isOver } = useDroppable({ id: BLOCKED_DROP_ID });
  if (!open) {
    return (
      <section ref={setNodeRef} className={`column blocked-col collapsed${isOver ? ' over' : ''}`} aria-label={tr('ui016')} data-testid="blocked-column">
        <button type="button" className="blocked-strip" aria-expanded={false} aria-label={tr('ui017', cards.length)} onClick={onToggle}>
          <span className="col-count blocked-count">{cards.length}</span>
          <span className="blocked-strip-label">{tr('ui016')}</span>
        </button>
      </section>
    );
  }
  return (
    <section ref={setNodeRef} className={`column blocked-col${isOver ? ' over' : ''}`} aria-label={tr('ui016')} data-testid="blocked-column">
      <div className="col-head">
        <span className="dot" data-status="blocked" />
        <h2 className="col-title">{tr('ui016')}</h2>
        <span className="col-count">{cards.length}</span>
        <button
          type="button"
          className="icon-btn ml-auto"
          aria-expanded={true}
          aria-label={tr('ui018')}
          title={locked ? tr('ui019') : undefined}
          disabled={locked}
          onClick={onToggle}
        >
          <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}><IconChevron open={false} /></span>
        </button>
      </div>
      <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <div className="col-cards">
          {cards.map((c) => (
            <SortableCard key={c.id} card={c} project={projectMap.get(c.project_id)} showProject={!fixedProject} open={openCardId === c.id} onOpen={onOpen} originLabel={statusLabel(c.status)} dormant={!fixedProject && !!projectMap.get(c.project_id)?.dormant} />
          ))}
          {cards.length === 0 && <div className="empty-drop">{tr('ui020')}</div>}
        </div>
      </SortableContext>
    </section>
  );
}

function Column({ status, cards, total, projects, projectMap, fixedProject, openCardId, onOpen, children }: BoardProps & { status: Status; cards: Card[]; total: number; children?: ReactNode }) {
  useLanguage();
  const { setNodeRef, isOver } = useDroppable({ id: `col:${status}` });
  const [adding, setAdding] = useState(false);
  const longest = status === 'review' ? longestReviewWait(cards) : null;
  return (
    <section ref={setNodeRef} className={`column${isOver ? ' over' : ''}`} aria-label={statusLabel(status)}>
      <div className="col-head">
        <span className="dot" data-status={status} />
        <h2 className="col-title">{statusLabel(status)}</h2>
        <span className={`col-count${isOverWip(status, total) ? ' warn' : ''}`} title={isOverWip(status, total) ? tr('ui021') : undefined}>{total}</span>
        {longest && <span className={`col-longest ml-auto${longest.overdue ? ' late' : ''}`} data-testid="review-longest">{tr('ui022')}{longest.label}</span>}
        <button type="button" className={`icon-btn${longest ? '' : ' ml-auto'}`} aria-label={tr('ui023', statusLabel(status))} onClick={() => setAdding(true)}>
          <IconPlus />
        </button>
      </div>
      <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <div className="col-cards">
          {cards.map((c) => (
            <SortableCard key={c.id} card={c} project={projectMap.get(c.project_id)} showProject={!fixedProject} open={openCardId === c.id} onOpen={onOpen} dormant={!fixedProject && !!projectMap.get(c.project_id)?.dormant} />
          ))}
          {cards.length === 0 && !adding && <div className="empty-drop">{tr('ui024')}</div>}
        </div>
      </SortableContext>
      {adding ? (
        <Composer status={status} projects={projects} fixedProject={fixedProject} onDone={() => setAdding(false)} />
      ) : (
        <button type="button" className="add-row" onClick={() => setAdding(true)}>
          <IconPlus size={14} />{tr('ui025')}</button>
      )}
      {children}
    </section>
  );
}

export function Composer({ status, projects, fixedProject, onDone }: { status: Status; projects: Project[]; fixedProject?: string; onDone: () => void }) {
  useLanguage();
  const active = projects.filter((p) => p.status !== 'archived');
  const [project, setProject] = useState(fixedProject ?? active[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit() {
    const t = title.trim();
    if (!t || !project || busy) return;
    setBusy(true);
    try {
      await store.createCard({ project_id: project, title: t, status });
      setTitle('');
      onDone();
    } catch (e) {
      store.error(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="composer" onKeyDown={(e) => e.key === 'Escape' && onDone()}>
      {!fixedProject && (
        <select aria-label={tr('ui002')} value={project} onChange={(e) => setProject(e.target.value)}>
          {active.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      )}
      <input
        autoFocus
        aria-label={tr('ui026')}
        placeholder={tr('ui027')}
        value={title}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
        onBlur={() => !title.trim() && !busy && setTimeout(onDone, 120)}
      />
    </div>
  );
}

function Lanes({ projects, projectMap, byStatus, shown, openCardId, onOpen, cards }: BoardProps & { byStatus: Record<Status, Card[]>; shown: Card[] }) {
  useLanguage();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const lanes = projects
    .filter((p) => p.status !== 'archived')
    .map((p) => ({ p, cards: shown.filter((c) => c.project_id === p.id) }))
    .filter((l) => l.cards.length > 0); 
  void byStatus;
  void cards;
  return (
    <div className="lanes">
      <div className="lane-grid lane-headrow">
        <span>{tr('ui002')}</span>
        {STATUSES.map((s) => (
          <span key={s}>{statusLabel(s)}</span>
        ))}
      </div>
      {lanes.length === 0 && <div className="empty-page">{tr('ui028')}</div>}
      {lanes.map(({ p, cards: lc }) => {
        const open = lc.filter((c) => c.status !== 'done').length;
        const isCollapsed = collapsed.has(p.id);
        return (
          <section key={p.id} className={`lane lane-grid${isCollapsed ? ' collapsed' : ''}`} aria-label={p.name}>
            <div className="lane-info">
              <button
                type="button"
                className="lane-name"
                aria-expanded={!isCollapsed}
                onClick={() => setCollapsed((s) => { const n = new Set(s); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; })}
              >
                <IconChevron open={!isCollapsed} />
                <span className="proj-swatch" style={{ background: p.color }} />
                <span>{p.name}</span>
                {p.dormant && <DormantTag />}
              </button>
              <div className="lane-meta">{open}{tr('ui029')}</div>
            </div>
            {STATUSES.map((s) => (
              <Cell key={s} project={p} status={s} cards={sortByPosition(lc.filter((c) => c.status === s))} projectMap={projectMap} openCardId={openCardId} onOpen={onOpen} />
            ))}
          </section>
        );
      })}
    </div>
  );
}

function Cell({ project, status, cards, projectMap, openCardId, onOpen }: { project: Project; status: Status; cards: Card[]; projectMap: Map<string, Project>; openCardId: number | null; onOpen: (id: number) => void }) {
  useLanguage();
  const { setNodeRef, isOver } = useDroppable({ id: `cell:${project.id}:${status}` });
  return (
    <div ref={setNodeRef} className={`cell${isOver ? ' over' : ''}`} aria-label={`${project.name} ${statusLabel(status)}`}>
      <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        {cards.map((c) => (
          <SortableCard key={c.id} card={c} project={projectMap.get(c.project_id)} showProject={false} lane open={openCardId === c.id} onOpen={onOpen} dormant={!!project.dormant} />
        ))}
      </SortableContext>
    </div>
  );
}
