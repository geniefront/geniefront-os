import type { ReactNode } from 'react';
import type { Shop } from '../lib/api';

export const STEPS = ['services', 'specialist', 'time', 'confirm'] as const;
export type BookStep = typeof STEPS[number] | 'success';

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div data-shell className="mx-auto min-h-full max-w-5xl px-4 pb-[calc(var(--dock)+24px)] pt-6 md:pb-10">
      {children}
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-[var(--radius)] bg-[var(--surface)] p-5 shadow-[var(--shadow)] ${className}`}>
      {children}
    </section>
  );
}

export function Note({ children, warn = false }: { children: ReactNode; warn?: boolean }) {
  return (
    <p className={`mt-3 rounded-xl px-3 py-2 text-sm ${warn ? 'bg-[var(--warn-bg)] text-[var(--warn)]' : 'bg-[var(--mint)] text-[var(--brand-dark)]'}`}>
      {children}
    </p>
  );
}

export function PhoneLink({ shop }: { shop: Pick<Shop, 'phone' | 'name'> }) {
  if (!shop.phone) return null;
  return (
    <a className="font-semibold text-[var(--brand)] underline-offset-2 hover:underline" href={`tel:${shop.phone}`}>
      {shop.phone}
    </a>
  );
}

export function Progress({ step }: { step: BookStep }) {
  const idx = STEPS.indexOf(step as typeof STEPS[number]);
  return (
    <ol className="mb-5 flex gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
      {STEPS.map((s, i) => (
        <li key={s} className={i === idx ? 'text-[var(--brand)]' : i < idx ? 'text-[var(--ink)]' : ''}>
          {i + 1}. {s}
        </li>
      ))}
    </ol>
  );
}

export function Topbar({ shop, step }: { shop: Shop; step: BookStep | null }) {
  const address = typeof shop.address === 'string'
    ? shop.address
    : shop.address ? Object.values(shop.address).filter(Boolean).join(', ') : '';
  return (
    <header className="mb-5">
      <p className="text-sm font-semibold text-[var(--brand)]">Online booking</p>
      <h1 className="mt-1 text-2xl font-bold tracking-tight">{shop.name}</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">
        {[address, shop.phone].filter(Boolean).join(' · ')}
      </p>
      {step && step !== 'success' && <div className="mt-4"><Progress step={step} /></div>}
    </header>
  );
}

export function Dock({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t border-[var(--line)] bg-[var(--surface)]/95 p-3 backdrop-blur md:static md:mt-5 md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none">
      <div className="mx-auto flex max-w-5xl gap-3">
        {children}
      </div>
    </div>
  );
}

export function Btn({
  children, onClick, disabled, primary = false, type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  primary?: boolean;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`min-h-12 flex-1 rounded-2xl px-4 text-base font-semibold ${
        primary
          ? 'bg-[var(--brand)] text-white hover:bg-[var(--brand-dark)]'
          : 'bg-[var(--mint)] text-[var(--brand-dark)]'
      }`}
    >
      {children}
    </button>
  );
}

export function Loading() {
  return <div className="flex min-h-40 items-center justify-center text-[var(--muted)]"><span className="spin" /> <span className="ml-3">Loading…</span></div>;
}

export function CallShop({ shop, children }: { shop: Pick<Shop, 'phone' | 'name'>; children: ReactNode }) {
  return (
    <Card>
      <h1 className="text-xl font-bold">{children}</h1>
      {shop.phone
        ? <p className="mt-3 text-[var(--muted)]">Call <PhoneLink shop={shop} /> to book or ask a question.</p>
        : <p className="mt-3 text-[var(--muted)]">Please contact the shop directly.</p>}
    </Card>
  );
}
