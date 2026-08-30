import { Link } from 'react-router-dom';

export function Cancel() {
  return (
    <main className="min-h-screen grid place-items-center px-6">
      <div className="max-w-lg space-y-4 text-center">
        <h1 className="text-3xl font-semibold">Checkout canceled</h1>
        <p className="text-slate-600">
          No shop was created. You can return to pricing and try again.
        </p>
        <Link
          to="/#pricing"
          data-testid="retry-pricing"
          className="inline-flex min-h-11 items-center rounded-xl bg-teal-700 px-4 text-white"
        >
          Back to pricing
        </Link>
      </div>
    </main>
  );
}
