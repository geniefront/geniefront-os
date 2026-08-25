import { useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Card } from '../ui/Card';
import { Label } from '../ui/Page';
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
    <div className="grid min-h-full place-items-center p-6">
      <Card asChild>
        <form onSubmit={submit} className="flex w-[min(460px,100%)] flex-col gap-5 p-8">
          <div className="flex flex-col gap-1">
            <div className="text-2xl font-extrabold tracking-[-0.03em]">{t('app.name')}</div>
            <div className="text-xs text-ink-2">{t('auth.title')}</div>
          </div>

          <label className="flex flex-col gap-1.5">
            <Label>{t('auth.email')}</Label>
            <Field type="email" autoComplete="username" required
                   value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>

          <label className="flex flex-col gap-1.5">
            <Label>{t('auth.password')}</Label>
            <Field type="password" autoComplete="current-password" required
                   value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>

          {err && (
            <div role="alert"
                 className="flex items-center gap-2 rounded bg-danger-soft px-3.5 py-2.5 text-danger">
              <CircleAlert size={17} /><span className="text-xs font-semibold">{err}</span>
            </div>
          )}

          {/* ⚠️ 这个按钮在 <form> 里，type 必须是 submit —— Button 默认给的是 button */}
          <Button type="submit" variant="primary" size="lg" block disabled={busy}>
            {busy ? '…' : t('auth.signIn')}
          </Button>
        </form>
      </Card>
    </div>
  );
}
