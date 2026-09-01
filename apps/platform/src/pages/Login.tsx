import { useState } from 'react';
import { supabase } from '@/lib/supabase';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setSubmitting(false);
    if (err) setError(err.message);
  }

  return (
    <div className="min-h-screen grid place-items-center bg-slate-950 text-white">
      <form onSubmit={(e) => void submit(e)} className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
        <div>
          <img src="/brand/geniefront-logo-on-dark.svg" alt="GenieFront" className="mb-3 h-8 w-auto" />
          <h1 className="text-xl font-semibold">Operator sign in</h1>
          <p className="text-sm text-slate-400 mt-1">Internal console. Store owner accounts are denied.</p>
        </div>
        <label className="block text-sm">
          Email
          <input
            className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
          />
        </label>
        <label className="block text-sm">
          Password
          <input
            className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error ? <p className="text-sm text-red-400">{error}</p> : null}
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-lg bg-teal-600 py-2 font-medium hover:bg-teal-500"
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
