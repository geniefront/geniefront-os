import { useState } from 'react';
import { Link } from 'react-router-dom';
import { goToCheckout, isTrustedCheckoutUrl, requestSignupCheckout, validateSignupForm } from '../lib/checkout';
import { formatUsdMonthly } from '../lib/money';
import { PLAN_COPY, PLAN_PRICES_CENTS, PLAN_QUOTAS, PLANS, TRIAL_DAYS, type Plan } from '../lib/plans';

export function Home() {
  const [shopName, setShopName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [busyPlan, setBusyPlan] = useState<Plan | null>(null);

  async function startCheckout(plan: Plan) {
    const nextErrors = validateSignupForm({ shopName, ownerEmail });
    setErrors(nextErrors);
    if (nextErrors.length > 0) return;

    setBusyPlan(plan);
    try {
      const res = await requestSignupCheckout({ shopName, ownerEmail, plan });
      if (!isTrustedCheckoutUrl(res.url)) {
        setErrors(['Checkout is unavailable right now. Please try again.']);
        return;
      }
      goToCheckout(res.url);
    } catch {
      setErrors(['Checkout is unavailable right now. Please try again.']);
    } finally {
      setBusyPlan(null);
    }
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <strong className="text-lg tracking-tight">GenieFront</strong>
          <a href="#pricing" className="text-sm text-teal-700 hover:underline">Pricing</a>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-16 space-y-16">
        <section className="max-w-2xl space-y-4">
          <p className="text-sm font-medium uppercase tracking-widest text-teal-700">Shop operating system</p>
          <h1 className="text-4xl font-semibold tracking-tight text-slate-950">GenieFront</h1>
          <p className="text-lg text-slate-600">
            Front desk, staff, kiosk, and AI voice for nail, spa, and massage shops.
            Pay at the shop — GenieFront records the visit, it does not take customer cards.
          </p>
        </section>

        <section id="pricing" className="space-y-8">
          <div className="space-y-2">
            <h2 className="text-2xl font-semibold">Plans</h2>
            <p className="text-slate-600">
              {TRIAL_DAYS}-day trial. A card is required at checkout; you are not charged until the trial ends.
            </p>
          </div>

          <form
            className="grid gap-4 rounded-2xl border border-slate-200 bg-white p-6 sm:grid-cols-2"
            onSubmit={(e) => e.preventDefault()}
          >
            <label className="block text-sm font-medium">
              Shop name
              <input
                data-testid="shop-name"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-3 text-base"
                value={shopName}
                onChange={(e) => setShopName(e.target.value)}
                maxLength={80}
                autoComplete="organization"
              />
            </label>
            <label className="block text-sm font-medium">
              Owner email
              <input
                data-testid="owner-email"
                type="email"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-3 text-base"
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
                autoComplete="email"
              />
            </label>
          </form>

          {errors.length > 0 && (
            <ul data-testid="signup-error" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 space-y-1">
              {errors.map((err) => <li key={err}>{err}</li>)}
            </ul>
          )}

          <div className="grid gap-6 md:grid-cols-2">
            {PLANS.map((plan) => {
              const copy = PLAN_COPY[plan];
              const quota = PLAN_QUOTAS[plan];
              return (
                <article
                  key={plan}
                  data-testid={`plan-${plan}`}
                  className="flex flex-col rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
                >
                  <h3 className="text-xl font-semibold">{copy.name}</h3>
                  <p className="mt-2 text-3xl font-semibold tabular-nums">
                    {formatUsdMonthly(PLAN_PRICES_CENTS[plan])}
                  </p>
                  <p className="mt-3 text-sm text-slate-600">{copy.summary}</p>
                  <ul className="mt-4 text-sm text-slate-700 space-y-1">
                    <li>{quota.credits} AI credits / month</li>
                    <li>{quota.voiceMinutes} AI voice minutes / month</li>
                  </ul>
                  <button
                    type="button"
                    data-testid={`cta-${plan}`}
                    className="mt-6 min-h-11 rounded-xl bg-teal-700 px-4 py-3 text-white hover:bg-teal-800 disabled:hover:bg-teal-700"
                    disabled={busyPlan !== null}
                    onClick={() => void startCheckout(plan)}
                  >
                    {busyPlan === plan ? 'Redirecting…' : `Start ${copy.name}`}
                  </button>
                </article>
              );
            })}
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200 py-8">
        <div className="mx-auto flex max-w-5xl gap-6 px-6 text-sm text-slate-500">
          <Link to="/terms" className="hover:underline">Terms</Link>
          <Link to="/privacy" className="hover:underline">Privacy</Link>
        </div>
      </footer>
    </div>
  );
}
