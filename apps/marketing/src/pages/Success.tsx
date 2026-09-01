import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { CheckCircle2, Clock3, ShieldAlert } from 'lucide-react';
import { TRIAL_DAYS } from '../lib/plans';
import { lookupSignupSession, readCheckoutSessionId, type PublicSignupStatus } from '../lib/signupStatus';

const COPY: Record<PublicSignupStatus, { title: string; message: string; hint?: string }> = {
  confirmed: {
    title: 'Check your email',
    message:
      'Checkout completed. Check your email to activate your GenieFront account. Your shop is not active yet — activation is complete only after you click the link in that email.',
    hint: `A ${TRIAL_DAYS}-day trial starts after card checkout. You are not charged until the trial ends. If the email does not arrive in a few minutes, check spam or write to support@geniefront.com.`,
  },
  pending: {
    title: "We're confirming your signup",
    message:
      "We're confirming your signup. Check your email shortly — do not assume payment is complete until the activation email arrives.",
    hint: 'If nothing arrives in a few minutes, check spam or write to support@geniefront.com.',
  },
  invalid: {
    title: 'Signup not confirmed',
    message:
      'We could not confirm a GenieFront checkout for this page. No payment has been verified. If you just paid, wait a moment and return from the Stripe receipt, or write to support@geniefront.com.',
  },
};

export function Success() {
  const location = useLocation();
  const sessionId = readCheckoutSessionId(location.search);
  const [status, setStatus] = useState<PublicSignupStatus | 'loading'>(
    sessionId ? 'loading' : 'invalid',
  );

  useEffect(() => {
    if (!sessionId) {
      setStatus('invalid');
      return;
    }
    let cancelled = false;
    setStatus('loading');
    void lookupSignupSession(sessionId).then((result) => {
      if (!cancelled) setStatus(result.status);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const copy = status === 'loading' ? COPY.pending : COPY[status];
  const state = status === 'loading' ? 'pending' : status;
  const StateIcon = state === 'confirmed' ? CheckCircle2 : state === 'pending' ? Clock3 : ShieldAlert;

  useEffect(() => {
    document.title = `${copy.title} · GenieFront`;
  }, [copy.title]);

  return (
    <main className="hero-grid min-h-screen grid place-items-center bg-[#f7f8f3] px-6 py-16">
      <div className="w-full max-w-xl rounded-[28px] border border-[#dfe5df] bg-white p-7 text-center shadow-[0_28px_70px_rgba(12,41,45,0.12)] sm:p-10">
        <img src="/brand/geniefront-logo.svg" alt="GenieFront" className="mx-auto h-10 w-auto" />
        <StateIcon className={`mx-auto mt-8 h-11 w-11 ${state === 'confirmed' ? 'text-[#096b61]' : state === 'pending' ? 'text-amber-600' : 'text-rose-600'}`} />
        <h1 className="font-serif-brand mt-5 text-4xl font-medium tracking-[-0.04em] text-[#102a2e]">{copy.title}</h1>
        <p data-testid="success-state" className="sr-only">{state}</p>
        <p data-testid="success-message" className="mt-4 text-base font-medium leading-7 text-[#53676a]">
          {status === 'loading'
            ? "We're confirming your signup. Check your email shortly."
            : copy.message}
        </p>
        {copy.hint && status !== 'loading' && (
          <p className="mt-3 text-sm leading-6 text-[#708184]">{copy.hint}</p>
        )}
        <Link to="/" className="primary-button mt-7">Back to GenieFront</Link>
      </div>
    </main>
  );
}
