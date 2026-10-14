import { setLanguage, t, useLanguage } from '../i18n/index.ts';

export function LanguageToggle() {
  const language = useLanguage();
  return (
    <button type="button" className="language-toggle" aria-label={t('languageLabel')} title={t('languageLabel')} onClick={() => setLanguage(language === 'en' ? 'zh-TW' : 'en')}>
      {language === 'en' ? 'EN / ZH-TW' : 'ZH-TW / EN'}
    </button>
  );
}
