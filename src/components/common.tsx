import { t as tr, agentLabel, useLanguage, withLanguage } from '../i18n/index.ts';
import { useEffect, useState, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { PRIORITY_LABEL, type Agent, type Priority, type Project } from '../../shared/constants.ts';
import { navigate, useRoute } from '../lib/router.ts';
import { buildUrl, type RouteState } from '../lib/url-state.ts';

const svg = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true } as const;
export const IconGrid = () => (
  <svg {...svg}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
);
export const IconBoard = ({ size = 18, color }: { size?: number; color?: string }) => (
  <svg {...svg} width={size} height={size} stroke={color ?? 'currentColor'}><rect x="3" y="4" width="5" height="16" rx="1.5" /><rect x="9.5" y="4" width="5" height="10" rx="1.5" /><rect x="16" y="4" width="5" height="13" rx="1.5" /></svg>
);
export const IconActivity = () => (
  <svg {...svg}><path d="M4 12h4l3-7 4 14 3-7h2" /></svg>
);
export const IconPlus = ({ size = 16, w = 2 }: { size?: number; w?: number }) => (
  <svg {...svg} width={size} height={size} strokeWidth={w}><path d="M12 5v14M5 12h14" /></svg>
);
export const IconSearch = () => (
  <svg {...svg} width={16} height={16} strokeWidth={2} stroke="var(--muted)"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
);
export const IconClose = () => (
  <svg {...svg} width={16} height={16} strokeWidth={2}><path d="M6 6l12 12M18 6L6 18" /></svg>
);
export const IconMenu = () => (
  <svg {...svg} strokeWidth={2}><path d="M4 7h16M4 12h16M4 17h16" /></svg>
);
export const IconChevron = ({ open }: { open: boolean }) => (
  <svg {...svg} width={14} height={14} strokeWidth={2} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}><path d="M9 6l6 6-6 6" /></svg>
);
export const IconSidebar = () => (
  <svg {...svg} width={16} height={16}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>
);

export const IconCheck = () => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>
);
export const IconReturn = () => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></svg>
);
export const IconFilter = () => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path d="M3 7h18M6 12h12M10 17h4" /></svg>
);
export const IconChevronDown = ({ open }: { open: boolean }) => (
  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} aria-hidden="true" style={{ transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform .12s' }}><path d="M6 9l6 6 6-6" /></svg>
);

export function Logo({ size = 22 }: { size?: number }) {
  useLanguage();
  return <IconBoard size={size} color="var(--accent)" />;
}


export function AppLink({ to, children, ...rest }: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  useLanguage();
  return (
    <a
      {...rest}
      href={withLanguage(to)}
      onClick={(e) => {
        rest.onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

export const IconComment = ({ size = 13 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" /></svg>
);

export function CommentPill({ count }: { count: number }) {
  useLanguage();
  return count > 0 ? <span className="cm-pill" title={tr('ui183', count)} aria-label={tr('ui183', count)}><IconComment />{count}</span> : null;
}
export function AgentChip({ agent, label }: { agent: Agent; label?: string }) {
  useLanguage();
  return <span className="chip agent" data-agent={agent}>{label ?? agentLabel(agent)}</span>;
}
export const PrioTag = ({ p }: { p: Priority }) => <span className="prio" data-p={p}>{PRIORITY_LABEL[p]}</span>;

export function useIsMobile(): boolean {
  const q = '(max-width: 767px)';
  const [m, setM] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(q).matches : false));
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return m;
}

export function useOpenCard() {
  const route = useRoute();
  return {
    open: (id: number) => navigate(buildUrl({ ...route, card: id })),
    close: () => navigate(buildUrl({ ...route, card: null }), { replace: true }),
    urlFor: (id: number, r: RouteState = route) => buildUrl({ ...r, card: id }),
  };
}

export const projectsById = (projects: Project[]) => new Map(projects.map((p) => [p.id, p]));


export function isTypingTarget(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  if (!t || !t.tagName) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable;
}
