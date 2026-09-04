import type { ReactNode } from 'react';
import type { Shop } from '../lib/api';

export const STEPS = ['services', 'specialist', 'time', 'confirm'] as const;
export type BookStep = typeof STEPS[number] | 'success';

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div data-shell className="mx-auto min-h-full w-full max-w-[1240px] px-4 pb-[calc(var(--dock)+24px)] md:px-8 md:pb-12">
      {children}
    </div>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-[var(--radius)] border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)] md:p-7 ${className}`}>
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
  const labels: Record<(typeof STEPS)[number], string> = {
    services: 'Services', specialist: 'Specialist', time: 'Date & time', confirm: 'Confirm',
  };
  return (
    <ol className="flex items-center gap-1 overflow-x-auto text-sm font-semibold text-[var(--muted)]" aria-label="Booking progress">
      {STEPS.map((s, i) => (
        <li key={s} className="flex shrink-0 items-center gap-1">
          {i > 0 && <span className="mx-1 text-[var(--muted-light)]" aria-hidden="true">›</span>}
          <span className={`rounded-full px-2 py-1 ${i === idx ? 'bg-[var(--brand-soft)] text-[var(--brand)]' : i < idx ? 'text-[var(--ink)]' : ''}`}>
            {labels[s]}
          </span>
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
    <header className="booking-topbar">
      <div className="flex min-w-0 items-center gap-3">
        <div className="brand-mark" aria-hidden="true">{shop.name.slice(0, 1).toUpperCase()}</div>
        <div className="min-w-0">
          <p className="truncate text-base font-bold tracking-[-0.01em] text-[var(--ink)]">{shop.name}</p>
          <p className="truncate text-xs text-[var(--muted)]">{address || 'Online booking'}</p>
        </div>
      </div>
      {step && step !== 'success' && <div className="hidden md:block"><Progress step={step} /></div>}
      {shop.phone && (
        <a className="hidden rounded-xl border border-[var(--line)] px-3 py-2 text-sm font-semibold text-[var(--ink)] transition hover:border-[var(--brand)] hover:text-[var(--brand)] lg:block" href={`tel:${shop.phone}`}>
          {shop.phone}
        </a>
      )}
    </header>
  );
}

export function Dock({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t border-[var(--line)] bg-[var(--surface)]/95 p-3 shadow-[0_-10px_30px_rgba(17,24,39,.06)] backdrop-blur md:static md:mt-5 md:border-0 md:bg-transparent md:p-0 md:shadow-none md:backdrop-blur-none">
      <div className="mx-auto flex max-w-[760px] gap-3">
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
      className={`min-h-12 flex-1 rounded-xl px-5 text-base font-semibold transition duration-200 ${
        primary
          ? 'bg-[var(--brand)] text-white shadow-[0_8px_22px_rgba(15,98,91,.22)] hover:-translate-y-0.5 hover:bg-[var(--brand-dark)]'
          : 'border border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] hover:border-[var(--brand)] hover:text-[var(--brand)]'
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
