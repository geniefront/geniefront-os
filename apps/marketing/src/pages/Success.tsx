import { Link } from 'react-router-dom';
import { TRIAL_DAYS } from '../lib/plans';

export function Success() {
  return (
    <main className="min-h-screen grid place-items-center px-6">
      <div className="max-w-lg space-y-4 text-center">
        <h1 className="text-3xl font-semibold">Check your email</h1>
        <p data-testid="success-message" className="text-lg text-slate-700">
          Checkout received. Check your email to activate your GenieFront account.
          Your shop is not active yet — activation is complete only after you click
          the link in that email.
        </p>
        <p className="text-sm text-slate-500">
          A {TRIAL_DAYS}-day trial starts after card checkout. You are not charged until
          the trial ends. If the email does not arrive in a few minutes, check spam
          or write to support@geniefront.com.
        </p>
        <Link to="/" className="inline-block text-teal-700 hover:underline">Back to GenieFront</Link>
      </div>
    </main>
  );
}
