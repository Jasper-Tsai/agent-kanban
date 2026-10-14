import { withLanguage, syncLanguageFromLocation } from '../i18n/index.ts';
import { useSyncExternalStore } from 'react';
import { parseLocation, type RouteState } from './url-state.ts';

const listeners = new Set<() => void>();
let snapshot = '';
const key = () => `${window.location.pathname}${window.location.search}`;

function subscribe(fn: () => void) {
  listeners.add(fn);
  const onPop = () => {
    snapshot = key();
    fn();
  };
  window.addEventListener('popstate', onPop);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('popstate', onPop);
  };
}

export function navigate(url: string, opts: { replace?: boolean } = {}) {
  url = withLanguage(url);
  if (url === key()) return;
  if (opts.replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  syncLanguageFromLocation();
  snapshot = key();
  listeners.forEach((l) => l());
}

function getSnapshot() {
  if (!snapshot) snapshot = key();
  return snapshot;
}

export function useLocationKey(): string {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

let lastKey = '';
let lastRoute: RouteState | null = null;
export function useRoute(): RouteState {
  const k = useLocationKey();
  if (k !== lastKey || !lastRoute) {
    const [p, s = ''] = k.split('?');
    lastRoute = parseLocation(p, s ? `?${s}` : '');
    lastKey = k;
  }
  return lastRoute;
}

export function currentRoute(): RouteState {
  return parseLocation(window.location.pathname, window.location.search);
}
