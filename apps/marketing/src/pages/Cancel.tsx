import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, XCircle } from 'lucide-react';
import { deskLoginUrl } from '../lib/desk';

export function Cancel() {
  useEffect(() => {
    document.title = 'Checkout canceled · GenieFront';
  }, []);

  return (
    <main className="hero-grid min-h-screen grid place-items-center bg-[#f7f8f3] px-6 py-16">
      <div className="w-full max-w-xl rounded-[28px] border border-[#dfe5df] bg-white p-7 text-center shadow-[0_28px_70px_rgba(12,41,45,0.12)] sm:p-10">
        <img src="/brand/geniefront-logo.svg" alt="GenieFront" className="mx-auto h-10 w-auto" />
        <XCircle className="mx-auto mt-8 h-11 w-11 text-[#e86f37]" />
        <h1 className="font-serif-brand mt-5 text-4xl font-medium tracking-[-0.04em] text-[#102a2e]">Checkout canceled</h1>
        <p className="mt-4 text-base font-medium leading-7 text-[#53676a]">
          No shop was created. You can return to pricing and try again.
        </p>
        <Link
          to="/#pricing"
          data-testid="retry-pricing"
          className="primary-button mt-7"
        >
          <ArrowLeft className="h-4 w-4" />Back to pricing
        </Link>
        <a href={deskLoginUrl()} className="mt-4 text-sm font-bold text-[#096b61]">Sign in</a>
      </div>
    </main>
  );
}
