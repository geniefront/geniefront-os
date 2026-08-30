import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
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

  return (
    <main className="min-h-screen grid place-items-center px-6">
      <div className="max-w-lg space-y-4 text-center">
        <h1 className="text-3xl font-semibold">{copy.title}</h1>
        <p data-testid="success-state" className="sr-only">{state}</p>
        <p data-testid="success-message" className="text-lg text-slate-700">
          {status === 'loading'
            ? "We're confirming your signup. Check your email shortly."
            : copy.message}
        </p>
        {copy.hint && status !== 'loading' && (
          <p className="text-sm text-slate-500">{copy.hint}</p>
        )}
        <Link to="/" className="inline-block text-teal-700 hover:underline">Back to GenieFront</Link>
      </div>
    </main>
  );
}
