import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export function Terms() {
  return (
    <LegalLayout title="Terms of Service">
      <p>
        Placeholder — final legal copy pending. These Terms will govern use of
        GenieFront, including the shop operating system, billing, and acceptable use.
      </p>
      <p>
        Until counsel replaces this page, contacting us to start a subscription
        means you agree that GenieFront is an operational aid and not a substitute
        for legal, tax, or financial records.
      </p>
    </LegalLayout>
  );
}

export function Privacy() {
  return (
    <LegalLayout title="Privacy Policy">
      <p>
        Placeholder — final legal copy pending. This Privacy Policy will describe
        how GenieFront collects, uses, and retains shop and customer information,
        including CCPA/CPRA rights for California residents.
      </p>
      <p>
        Until counsel replaces this page, we collect the shop name and owner email
        you submit for signup, plus billing data processed by Stripe.
      </p>
    </LegalLayout>
  );
}

function LegalLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16 space-y-6">
      <Link to="/" className="text-sm text-teal-700 hover:underline">GenieFront</Link>
      <h1 className="text-3xl font-semibold">{title}</h1>
      <div className="space-y-4 text-slate-700">{children}</div>
    </main>
  );
}
