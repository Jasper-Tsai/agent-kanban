// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LanguageToggle } from '../src/components/LanguageToggle.tsx';
import { FilterBar } from '../src/components/FilterBar.tsx';
import { ConfirmHost, Toasts } from '../src/components/Dialogs.tsx';
import { EMPTY_FILTERS } from '../src/lib/filters.ts';
import { navigate } from '../src/lib/router.ts';
import { LANGUAGE_STORAGE_KEY, setLanguage, t, withLanguage } from '../src/i18n/index.ts';
import { en } from '../src/i18n/en.ts';
import { zhTW } from '../src/i18n/zh-TW.ts';
import { store } from '../src/store/store.ts';

let host: HTMLDivElement;
let root: Root;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  window.history.replaceState(null, '', '/board');
  window.localStorage.clear();
  setLanguage('en');
  store.state = { ...store.state, toasts: [], confirm: null };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  store.state = { ...store.state, toasts: [], confirm: null };
  setLanguage('en');
});

describe('Reactive language selection', () => {
  it('updates header controls and accessibility labels in place', async () => {
    await act(async () => root.render(<><LanguageToggle /><FilterBar filters={EMPTY_FILTERS} onChange={() => {}} scopeCards={[]} /></>));
    expect(host.querySelector('input')?.getAttribute('placeholder')).toBe(en.ui113);
    expect(host.querySelectorAll('option')[1].textContent).toContain('Codex');
    await act(async () => (host.querySelector('.language-toggle') as HTMLButtonElement).click());
    expect(host.querySelector('input')?.getAttribute('placeholder')).toBe(zhTW.ui113);
    expect(host.querySelector('.language-toggle')?.getAttribute('aria-label')).toBe(zhTW.languageLabel);
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('zh-TW');
    expect(document.documentElement.lang).toBe('zh-TW');
    expect(new URLSearchParams(window.location.search).get('lang')).toBe('zh-TW');
    expect(withLanguage('/p/example?card=7')).toBe('/p/example?card=7&lang=zh-TW');
    await act(async () => navigate('/p/example?card=7'));
    expect(new URLSearchParams(window.location.search).get('lang')).toBe('zh-TW');
    await act(async () => navigate('/board?lang=en'));
    expect(host.querySelector('input')?.getAttribute('placeholder')).toBe(en.ui113);
  });
  it('updates already-visible events and confirmation text', async () => {
    const event = { id: 1, card_id: 8, project_id: 'example', actor: 'codex' as const, type: 'card.moved', payload: { to: 'review' }, created_at: '' };
    store.state = { ...store.state,
      toasts: [{ id: 1, actor: 'codex', kind: 'event', text: 'moved #8 to Review', event }],
      confirm: { title: t('ui081'), message: t('ui082', 8, 'User title'), confirmLabel: t('ui083'), resolve: () => {} },
    };
    await act(async () => root.render(<><ConfirmHost /><Toasts /></>));
    expect(host.querySelector('.toast')?.textContent).toContain('Review');
    await act(async () => setLanguage('zh-TW'));
    expect(host.querySelector('.toast')?.textContent).toContain(zhTW.statusReview);
    expect(host.querySelector('h2')?.textContent).toBe(zhTW.ui081);
    expect(host.querySelector('#cf-m')?.textContent).toBe(t('ui082', 8, 'User title'));
    expect(host.querySelector('#cf-m')?.textContent).toContain('User title');
  });
  it('uses URL language again after a history change', async () => {
    await act(async () => root.render(<LanguageToggle />));
    await act(async () => {
      window.history.replaceState(null, '', '/board?lang=zh-TW');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(host.querySelector('button')?.getAttribute('aria-label')).toBe(zhTW.languageLabel);
  });
});
