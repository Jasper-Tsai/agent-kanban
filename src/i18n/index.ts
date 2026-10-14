import { useSyncExternalStore } from 'react';
import { en } from './en.ts';
import { zhTW } from './zh-TW.ts';
import type { Agent, Actor, CommentStatus, Status } from '../../shared/constants.ts';

export type Language = 'en' | 'zh-TW';
export type TranslationKey = keyof typeof en;
export const LANGUAGE_STORAGE_KEY = 'kanban.language';
const validLanguage = (value: string | null): value is Language => value === 'en' || value === 'zh-TW';

export function resolveLanguage(search: string, stored: string | null): Language {
  const query = new URLSearchParams(search).get('lang');
  return validLanguage(query) ? query : validLanguage(stored) ? stored : 'en';
}
function initialLanguage(): Language {
  if (typeof window === 'undefined') return 'en';
  let stored: string | null = null;
  try { stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY); } catch { /* Storage may be unavailable. */ }
  return resolveLanguage(window.location.search, stored);
}
let language = initialLanguage();
const listeners = new Set<() => void>();
export const getLanguage = (): Language => language;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };
export function useLanguage(): Language { return useSyncExternalStore(subscribe, getLanguage, getLanguage); }
function applyLanguage(next: Language) {
  language = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  try { window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next); } catch { /* Optional persistence. */ }
  listeners.forEach((listener) => listener());
}
export function setLanguage(next: Language) {
  if (typeof window !== 'undefined') {
    const url = new URL(window.location.href);
    url.searchParams.set('lang', next);
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
  applyLanguage(next);
}
if (typeof window !== 'undefined') {
  document.documentElement.lang = language;
  window.addEventListener('popstate', () => applyLanguage(initialLanguage()));
}
export function t(key: TranslationKey, ...values: unknown[]): string {
  let text: string = (language === 'zh-TW' ? zhTW : en)[key] ?? en[key];
  if (language === 'en' && ['ui207', 'ui208', 'ui209', 'ui210', 'ui212'].includes(key) && values[0] === 1) text = text.replace(/\b(days|hours|minutes)\b/g, (unit) => unit.slice(0, -1));
  const rendered = text.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < values.length ? String(values[Number(index)]) : match);
  return rendered;
}

const statusKeys: Record<Status, TranslationKey> = { backlog: 'statusBacklog', todo: 'statusTodo', in_progress: 'statusInProgress', review: 'statusReview', done: 'statusDone' };
export const statusLabel = (status: Status): string => statusKeys[status] ? t(statusKeys[status]) : String(status ?? '');
export const agentLabel = (agent: Agent): string => agent === 'owner' ? t('owner') : agent === 'none' ? t('unassigned') : agent === 'codex' ? 'Codex' : agent === 'claude' ? 'Claude' : String(agent ?? '');
export const localizedActorLabel = (actor: Actor): string => actor === 'system' ? t('system') : actor === 'webmcp' ? t('browserAgent') : agentLabel(actor);
const commentKeys: Record<CommentStatus, TranslationKey> = { open: 'commentOpen', answered: 'commentAnswered', resolved: 'commentResolved' };
export const commentStatusLabel = (status: CommentStatus): string => t(commentKeys[status]);

/** Translate application-generated strings stored before a language switch. User content is not translated. */
export function localizeGenerated(text: string): string {
  const from = language === 'en' ? zhTW : en;
  const to = language === 'en' ? en : zhTW;
  const matches = Object.entries(from).sort((a, b) => b[1].length - a[1].length);
  for (const [key, pattern] of matches) {
    const parts = pattern.split(/\{\d+\}/);
    if (!parts.join('').trim()) continue;
    if (parts.length === 1) { if (text === pattern) return to[key as TranslationKey]; continue; }
    const escaped = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const matched = new RegExp('^' + escaped.join('(.*?)') + '$', 's').exec(text);
    if (matched) return t(key as TranslationKey, ...matched.slice(1));
  }
  return text;
}

/** Preserve the chosen language in links and navigation URLs. */
export function withLanguage(url: string): string {
  const base = typeof window === 'undefined' ? 'http://localhost' : window.location.href;
  const target = new URL(url, base);
  if (!validLanguage(target.searchParams.get('lang'))) target.searchParams.set('lang', language);
  return target.pathname + target.search + target.hash;
}

/** English-only metadata for agent tools, independent of the visible language. */
export function te(key: TranslationKey, ...values: unknown[]): string {
  return en[key].replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < values.length ? String(values[Number(index)]) : match);
}
/** Apply URL language precedence after navigation without adding a history entry. */
export function syncLanguageFromLocation(): void { applyLanguage(initialLanguage()); }
