import { LanguageToggle } from '../components/LanguageToggle.tsx';
import { t as tr, useLanguage, localizeGenerated } from '../i18n/index.ts';
import { useState } from 'react';
import { ApiFailure } from '../lib/api.ts';
import { store } from '../store/store.ts';
import { Logo } from '../components/common.tsx';

export function LoginPage({ offline }: { offline?: string | null }) {
  useLanguage();
  const [pw, setPw] = useState('');
  const [err, setErr] = useState(offline ?? '');
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!pw || busy) return;
    setBusy(true);
    setErr('');
    try {
      await store.login(pw);
    } catch (e2) {
      setErr(e2 instanceof ApiFailure ? (e2.status === 401 ? tr('ui231') : e2.message) : tr('ui232'));
      setPw('');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-wrap">
      <form className="login" onSubmit={submit}>
        <div className="brand"><Logo size={26} /><span className="brand-name" style={{ fontSize: 18 }}>Agent Kanban</span></div>
        <LanguageToggle />
        <div className="muted small">{tr('ui233')}</div>
        <label className="sr-only" htmlFor="pw">{tr('ui234')}</label>
        <input id="pw" type="password" autoComplete="current-password" autoFocus placeholder={tr('ui234')} value={pw} onChange={(e) => setPw(e.target.value)} />
        {err && <div className="err" role="alert">{localizeGenerated(err)}</div>}
        <button type="submit" className="btn-primary" disabled={busy || !pw}>{busy ? tr('ui235') : tr('ui236')}</button>
      </form>
    </div>
  );
}
