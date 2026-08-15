import { useState } from 'react';
import { supabase } from '../lib/supabase';
import type { makeT } from '../i18n';

export function Login({ t }: { t: ReturnType<typeof makeT> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr('');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) { setErr(t('auth.failed')); setBusy(false); }
    // 成功时 onAuthStateChange 会接管，不用手动跳转
  }

  return (
    <div className="center-page">
      <form className="card stack" onSubmit={submit}
            style={{ width: 'min(460px, 100%)', padding: 32, gap: 18 }}>
        <div className="stack" style={{ gap: 4 }}>
          <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800 }}>{t('app.name')}</div>
          <div className="muted">{t('auth.title')}</div>
        </div>

        <label className="stack" style={{ gap: 6 }}>
          <span className="tiny">{t('auth.email')}</span>
          <input className="field" type="email" autoComplete="username" required
                 value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>

        <label className="stack" style={{ gap: 6 }}>
          <span className="tiny">{t('auth.password')}</span>
          <input className="field" type="password" autoComplete="current-password" required
                 value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>

        {err && (
          <div className="badge badge-danger" style={{ padding: '10px 14px' }} role="alert">
            ✕ {err}
          </div>
        )}

        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? <span className="spin" /> : t('auth.signIn')}
        </button>
      </form>
    </div>
  );
}
