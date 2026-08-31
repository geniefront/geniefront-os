import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, CreditCard, ShieldCheck, X } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import {
  goToCheckout,
  isTrustedCheckoutUrl,
  requestSignupCheckout,
  validateSignupForm,
} from '../lib/checkout';
import { PLAN_COPY, type Plan, TRIAL_DAYS } from '../lib/plans';

export function TrialModal() {
  const {
    isTrialModalOpen,
    closeTrialModal,
    selectedIndustryForTrial,
    selectedPlanForTrial,
    t,
  } = useLanguage();
  const [shopName, setShopName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [plan, setPlan] = useState<Plan>('essential');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isTrialModalOpen) return;
    setPlan(selectedPlanForTrial);
    setErrors([]);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => event.key === 'Escape' && closeTrialModal();
    window.addEventListener('keydown', handleKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKey);
    };
  }, [closeTrialModal, isTrialModalOpen, selectedPlanForTrial]);

  if (!isTrialModalOpen) return null;

  async function startCheckout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validateSignupForm({ shopName, ownerEmail });
    setErrors(nextErrors);
    if (nextErrors.length > 0) return;

    setBusy(true);
    try {
      const response = await requestSignupCheckout({ shopName, ownerEmail, plan });
      if (!isTrustedCheckoutUrl(response.url)) {
        setErrors(['Checkout is unavailable right now. Please try again.']);
        return;
      }
      goToCheckout(response.url);
    } catch {
      setErrors(['Checkout is unavailable right now. Please try again.']);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-[#0c292d]/65 p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && closeTrialModal()}
    >
      <div
        className="relative w-full max-w-lg overflow-hidden rounded-[26px] border border-white/20 bg-[#fbfcf9] p-6 shadow-2xl sm:p-8"
        role="dialog"
        aria-modal="true"
        aria-labelledby="trial-title"
      >
        <button
          ref={closeRef}
          type="button"
          onClick={closeTrialModal}
          className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-xl border border-[#dfe5df] bg-white text-[#708184] hover:text-[#102a2e]"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="eyebrow"><CreditCard className="h-3.5 w-3.5" />{t.modal.trialTitle}</div>
        <h2 id="trial-title" className="font-serif-brand mt-5 pr-10 text-4xl font-medium tracking-[-0.04em] text-[#102a2e]">
          {t.modal.step1Title}
        </h2>
        <p className="mt-2 text-sm leading-6 text-[#647679]">{t.modal.trialSubtitle}</p>

        <form noValidate className="mt-7 space-y-4" onSubmit={startCheckout}>
          <label className="block text-xs font-extrabold text-[#20383b]">
            {t.modal.shopNameLabel}
            <input
              data-testid="shop-name"
              required
              value={shopName}
              onChange={(event) => setShopName(event.target.value)}
              maxLength={80}
              autoComplete="organization"
              className="mt-2 h-11 w-full rounded-xl border border-[#dfe5df] bg-white px-3 text-sm font-semibold outline-none focus:border-[#80b9a8]"
              placeholder="Golden Lotus Spa"
            />
          </label>

          <label className="block text-xs font-extrabold text-[#20383b]">
            {t.modal.emailLabel}
            <input
              data-testid="owner-email"
              required
              type="email"
              value={ownerEmail}
              onChange={(event) => setOwnerEmail(event.target.value)}
              autoComplete="email"
              className="mt-2 h-11 w-full rounded-xl border border-[#dfe5df] bg-white px-3 text-sm font-semibold outline-none focus:border-[#80b9a8]"
              placeholder="you@yourshop.com"
            />
          </label>

          <fieldset>
            <legend className="text-xs font-extrabold text-[#20383b]">Plan</legend>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {(['essential', 'growth'] as Plan[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setPlan(option)}
                  className={`rounded-xl border px-3 py-3 text-left text-xs font-bold transition ${
                    plan === option
                      ? 'border-[#096b61] bg-[#edf8f3] text-[#096b61]'
                      : 'border-[#dfe5df] bg-white text-[#53676a] hover:border-[#9bb9af]'
                  }`}
                >
                  {PLAN_COPY[option].name}
                </button>
              ))}
            </div>
          </fieldset>

          <input type="hidden" name="industry" value={selectedIndustryForTrial} readOnly />

          {errors.length > 0 && (
            <ul data-testid="signup-error" className="space-y-1 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-semibold text-red-800">
              {errors.map((error) => <li key={error}>{error}</li>)}
            </ul>
          )}

          <div className="flex gap-2 rounded-xl bg-[#edf8f3] px-3 py-3 text-[10px] font-bold leading-4 text-[#53676a]">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#096b61]" />
            <span>{TRIAL_DAYS}-day trial. Card details are collected securely on Stripe Checkout; this site never receives them.</span>
          </div>

          <button data-testid="checkout-submit" disabled={busy} type="submit" className="primary-button w-full disabled:cursor-wait disabled:opacity-70">
            {busy ? 'Redirecting to Stripe…' : t.modal.submitTrial}<ArrowRight className="h-4 w-4" />
          </button>
        </form>
      </div>
    </div>
  );
}
