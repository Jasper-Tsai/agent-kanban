import { afterEach, describe, expect, it } from 'vitest';
import { AGENTS, CARD_BRIEF_TEMPLATE, STATUS_LABEL, type Actor, type Status } from '../shared/constants.ts';
import { en } from '../src/i18n/en.ts';
import { zhTW } from '../src/i18n/zh-TW.ts';
import { agentLabel, getLanguage, localizeGenerated, resolveLanguage, setLanguage, statusLabel, t, te } from '../src/i18n/index.ts';
import { actorLabel, describeEvent } from '../src/lib/describe.ts';
import { ageShort, reviewWait } from '../src/lib/time.ts';
import { describeContext } from '../src/webmcp/react.ts';
import { DEFAULT_ROUTE } from '../src/lib/url-state.ts';

afterEach(() => setLanguage('en'));

describe('English-first internationalization', () => {
  it('resolves query before storage and defaults to English', () => {
    expect(resolveLanguage('?lang=zh-TW', 'en')).toBe('zh-TW');
    expect(resolveLanguage('?lang=en', 'zh-TW')).toBe('en');
    expect(resolveLanguage('?lang=invalid', 'zh-TW')).toBe('zh-TW');
    expect(resolveLanguage('', 'invalid')).toBe('en');
    expect(resolveLanguage('', null)).toBe('en');
  });
  it('keeps complete dictionaries with matching interpolation slots', () => {
    expect(Object.keys(zhTW).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(zhTW[key].match(/\{\d+\}/g) ?? []).toEqual(en[key].match(/\{\d+\}/g) ?? []);
    }
    expect(t('briefTemplate')).toBe(CARD_BRIEF_TEMPLATE);
    expect(AGENTS).toEqual(['codex', 'claude', 'owner', 'none']);
    expect(STATUS_LABEL.review).toBe('Review');
  });
  it('translates dynamic labels, durations, and events without changing user content', () => {
    const event = { type: 'card.moved', card_id: 8, payload: { to: 'review' } };
    expect(describeEvent(event)).toBe('moved #8 to Review');
    expect(agentLabel('owner')).toBe('Owner');
    setLanguage('zh-TW');
    expect(getLanguage()).toBe('zh-TW');
    expect(statusLabel('review')).toBe(zhTW.statusReview);
    expect(describeEvent(event)).toBe(t('ui190', '#8', zhTW.statusReview));
    expect(ageShort('2026-10-03T09:00:00Z', new Date('2026-10-03T12:00:00Z'))).toBe(t('ui206', 3));
    expect(reviewWait('2026-10-03T09:00:00Z', new Date('2026-10-03T12:00:00Z')).label).toBe(t('ui214', 3));
    expect(t('ui261', 'User project $&')).toContain('User project $&');
    setLanguage('en');
    expect(t('ui261', 'Fix 1 days report')).toBe('Fix 1 days report is now dormant');
    expect(ageShort('2026-10-02T12:00:00Z', new Date('2026-10-03T12:00:00Z'))).toBe('1 day');
  });
  it('relocalizes stored generated dialog and toast messages', () => {
    const message = t('ui082', 8, 'My card');
    const toast = t('ui261', 'My project');
    setLanguage('zh-TW');
    expect(localizeGenerated(message)).toBe(t('ui082', 8, 'My card'));
    expect(localizeGenerated(toast)).toBe(t('ui261', 'My project'));
    expect(localizeGenerated('Unrecognized user content')).toBe('Unrecognized user content');
  });
  it('keeps English tool metadata and raw unknown labels in either locale', () => {
    setLanguage('zh-TW');
    expect(te('ui067')).toBe(en.ui067);
    expect(describeContext(DEFAULT_ROUTE, [])).toBe(en.ui273);
    expect(actorLabel('external-agent')).toBe('external-agent');
    expect(statusLabel('external-status' as Status)).toBe('external-status');
    expect(actorLabel('owner' as Actor)).toBe(zhTW.owner);
  });
});
