import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ApiError, cancelManagedBooking, getAvailability, getHostedShop,
  loadManagedBooking, rescheduleManagedBooking, setPublicKey,
  type Availability, type ManagedBooking, type Shop,
} from '../lib/api';
import { addDays, dateOf, duration, money, timeOf, todayIn } from '../lib/format';
import { Btn, Card, Loading, Note, PhoneLink, Shell } from '../components/Chrome';

type View = 'detail' | 'reschedule' | 'cancel';

export function ManageBookingPage() {
  const { slug, token } = useParams();
  const tokenRef = useRef(token ?? '');
  tokenRef.current = token ?? '';

  useEffect(() => {
    let robots = document.querySelector('meta[name="robots"]');
    if (!robots) {
      robots = document.createElement('meta');
      robots.setAttribute('name', 'robots');
      document.head.appendChild(robots);
    }
    robots.setAttribute('content', 'noindex,nofollow');
    let referrer = document.querySelector('meta[name="referrer"]');
    if (!referrer) {
      referrer = document.createElement('meta');
      referrer.setAttribute('name', 'referrer');
      document.head.appendChild(referrer);
    }
    referrer.setAttribute('content', 'no-referrer');
  }, []);

  const shopQuery = useQuery({
    queryKey: ['hosted-shop', slug],
    enabled: Boolean(slug),
    queryFn: async () => {
      const s = await getHostedShop(slug!, 'en');
      if (s.publicKey) setPublicKey(s.publicKey);
      document.title = `${s.name} · Appointment`;
      return s;
    },
  });

  const detailQuery = useQuery({
    queryKey: ['managed-booking', slug],
    enabled: Boolean(slug && token),
    retry: false,
    queryFn: async () => {
      const out = await loadManagedBooking(slug!, tokenRef.current, 'en');
      if (out.publicKey) setPublicKey(out.publicKey);
      document.title = `${out.shop.name} · Appointment`;
      return out;
    },
  });

  const shop = detailQuery.data?.shop ?? shopQuery.data ?? null;
  const booking = detailQuery.data?.booking ?? null;

  if (!slug || !token) {
    return <GenericMissing shop={shop} />;
  }
  if (detailQuery.isLoading || shopQuery.isLoading) {
    return <Shell><Loading /></Shell>;
  }
  if (detailQuery.isError || !booking || !shop) {
    return <GenericMissing shop={shop} />;
  }

  return (
    <Shell>
      <ManageBody shop={shop} booking={booking} token={token} slug={slug} />
    </Shell>
  );
}

function GenericMissing({ shop }: { shop: Shop | null }) {
  return (
    <Shell>
      <Card>
        <h1 className="text-xl font-bold">This appointment link is not available</h1>
        <p className="mt-3 text-[var(--muted)]">
          {shop?.phone
            ? <>Call <PhoneLink shop={shop} /> if you need help.</>
            : 'Please contact the shop if you need help.'}
        </p>
      </Card>
    </Shell>
  );
}

function ManageBody({
  shop, booking, token, slug,
}: {
  shop: Shop;
  booking: ManagedBooking;
  token: string;
  slug: string;
}) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>('detail');
  const [last4, setLast4] = useState('');
  const [verified, setVerified] = useState(false);
  const [gateErr, setGateErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mutable = booking.actions.canCancel || booking.actions.canReschedule;

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['managed-booking', slug] });
  }

  return (
    <>
      <header className="mb-5">
        <p className="text-sm font-semibold text-[var(--brand)]">{shop.name}</p>
        <h1 className="mt-1 text-2xl font-bold">Your appointment</h1>
        {shop.phone && <p className="mt-1 text-sm text-[var(--muted)]">Call <PhoneLink shop={shop} /></p>}
      </header>

      <Card>
        <StatusBadge status={booking.status} />
        {booking.confirmationCode && (
          <p className="mt-2 text-sm text-[var(--muted)]">Code {booking.confirmationCode}</p>
        )}
        <p className="mt-3 text-lg font-semibold" data-testid="when">
          {dateOf(booking.startsAt, booking.timezone)} · {timeOf(booking.startsAt, booking.timezone)}
        </p>
        <p className="text-sm text-[var(--muted)]">{booking.timezone.replace(/_/g, ' ')}</p>
        <ul className="mt-4 grid gap-1">
          {booking.items.map((item, i) => (
            <li key={i}>
              <span className="font-semibold">{item.name}</span>
              {item.addonNames.length > 0 && (
                <span className="text-[var(--muted)]"> + {item.addonNames.join(', ')}</span>
              )}
            </li>
          ))}
        </ul>
        {booking.specialistName && <p className="mt-3 text-sm">{booking.specialistName}</p>}
        <p className="mt-3 text-sm">
          {duration(booking.durationMin)} · {money(booking.priceCents, shop.currency)}
        </p>
        <p className="mt-3 text-sm text-[var(--muted)]">
          Cancel at least {booking.policy.cancelCutoffHours} hours ahead.
          {booking.policy.rescheduleEnabled
            ? ` Reschedule at least ${booking.policy.rescheduleCutoffHours} hours ahead.`
            : ' Online rescheduling is off.'}
        </p>
        {booking.actions.reason && !mutable && (
          <Note>{reasonCopy(booking.actions.reason, shop)}</Note>
        )}
      </Card>

      {view === 'detail' && (
        <div className="mt-5 grid gap-3">
          {mutable && !verified && (
            <Last4Form
              last4={last4} setLast4={setLast4} err={gateErr}
              onSubmit={() => { setVerified(true); setGateErr(null); }}
            />
          )}
          {mutable && verified && (
            <div className="flex flex-col gap-3 sm:flex-row">
              {booking.actions.canReschedule && (
                <Btn primary onClick={() => setView('reschedule')}>Reschedule</Btn>
              )}
              {booking.actions.canCancel && (
                <Btn onClick={() => setView('cancel')}>Cancel</Btn>
              )}
            </div>
          )}
          {booking.actions.canRebook && (
            <Link className="min-h-12 rounded-2xl bg-[var(--mint)] px-4 py-3 text-center font-semibold text-[var(--brand-dark)]"
              to={`/${slug}`}>
              Book again
            </Link>
          )}
        </div>
      )}

      {view === 'reschedule' && (
        <ReschedulePanel
          shop={shop} booking={booking} token={token} last4={last4}
          busy={busy} setBusy={setBusy} setGateErr={setGateErr}
          onBack={() => setView('detail')}
          onAuthFail={() => { setVerified(false); setView('detail'); }}
          onDone={async () => { setView('detail'); await refresh(); }}
        />
      )}

      {view === 'cancel' && (
        <CancelPanel
          shop={shop} booking={booking} token={token} last4={last4}
          busy={busy} setBusy={setBusy} setGateErr={setGateErr}
          onBack={() => setView('detail')}
          onAuthFail={() => { setVerified(false); setView('detail'); }}
          onDone={async () => { setView('detail'); await refresh(); }}
        />
      )}
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  const label = status.replace('_', ' ');
  return (
    <span className="inline-block rounded-full bg-[var(--mint)] px-3 py-1 text-xs font-semibold uppercase tracking-wide text-[var(--brand-dark)]"
      data-testid="status">
      {label}
    </span>
  );
}

function Last4Form({
  last4, setLast4, err, onSubmit,
}: {
  last4: string;
  setLast4: (v: string) => void;
  err: string | null;
  onSubmit: () => void;
}) {
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => { e.preventDefault(); if (/^\d{4}$/.test(last4)) onSubmit(); }}
    >
      <label className="text-sm font-semibold">
        Last four digits of the phone number on this booking
        <input
          data-testid="last4"
          className="mt-1 min-h-12 w-full rounded-2xl border border-[var(--line)] px-3 tracking-[0.4em]"
          inputMode="numeric" maxLength={4} autoComplete="off"
          value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
        />
      </label>
      {err && <Note warn>{err}</Note>}
      <Btn primary type="submit" disabled={!/^\d{4}$/.test(last4)}>Continue</Btn>
    </form>
  );
}

function CancelPanel({
  shop, booking, token, last4, busy, setBusy, setGateErr, onBack, onAuthFail, onDone,
}: {
  shop: Shop;
  booking: ManagedBooking;
  token: string;
  last4: string;
  busy: boolean;
  setBusy: (v: boolean) => void;
  setGateErr: (v: string | null) => void;
  onBack: () => void;
  onAuthFail: () => void;
  onDone: () => Promise<void>;
}) {
  const [err, setErr] = useState<string | null>(null);
  async function go() {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      await cancelManagedBooking(booking.bookingId, token, last4);
      await onDone();
    } catch (e) {
      applyGate(e, setGateErr, setErr, shop, onAuthFail);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="mt-5">
      <h2 className="text-xl font-bold">Cancel this appointment?</h2>
      <p className="mt-2 text-sm text-[var(--muted)]">
        Cancellations must be at least {booking.policy.cancelCutoffHours} hours before the start time.
        This cannot be undone online.
      </p>
      {err && <Note warn>{err}</Note>}
      <div className="mt-4 flex gap-3">
        <Btn onClick={onBack} disabled={busy}>Keep appointment</Btn>
        <Btn primary onClick={() => void go()} disabled={busy}>Confirm cancellation</Btn>
      </div>
    </Card>
  );
}

function ReschedulePanel({
  shop, booking, token, last4, busy, setBusy, setGateErr, onBack, onAuthFail, onDone,
}: {
  shop: Shop;
  booking: ManagedBooking;
  token: string;
  last4: string;
  busy: boolean;
  setBusy: (v: boolean) => void;
  setGateErr: (v: string | null) => void;
  onBack: () => void;
  onAuthFail: () => void;
  onDone: () => Promise<void>;
}) {
  const first = booking.items[0];
  const [date, setDate] = useState(() => todayIn(booking.timezone));
  const [avail, setAvail] = useState<Availability | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const serviceId = first?.serviceId ?? null;
  const addonIds = first?.addonIds ?? [];

  useEffect(() => {
    if (!serviceId) return;
    let alive = true;
    (async () => {
      setLoading(true); setErr(null); setPicked(null);
      try {
        const a = await getAvailability({
          date, serviceId, addonIds, excludeBookingId: booking.bookingId,
        });
        if (alive) setAvail(a);
      } catch {
        if (alive) setErr('Could not load times. Please call the shop.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [serviceId, date, booking.bookingId, addonIds.join(',')]);

  async function go() {
    if (!picked || busy) return;
    setBusy(true); setErr(null);
    try {
      await rescheduleManagedBooking(booking.bookingId, {
        manageToken: token, last4, startsAt: picked,
      });
      await onDone();
    } catch (e) {
      if (e instanceof ApiError && e.isTaken) {
        setErr('That time was just booked. Please pick another slot.');
        setPicked(null);
        return;
      }
      applyGate(e, setGateErr, setErr, shop, onAuthFail);
    } finally {
      setBusy(false);
    }
  }

  const start = todayIn(booking.timezone);
  const days = Array.from({ length: 14 }, (_, i) => addDays(start, i));

  return (
    <Card className="mt-5">
      <h2 className="text-xl font-bold">Pick a new time</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Current time and price are not reused for a new booking. Times are {booking.timezone.replace(/_/g, ' ')}.
      </p>
      <div className="mt-4 flex gap-2 overflow-x-auto pb-2">
        {days.map((d) => (
          <button key={d} type="button" onClick={() => setDate(d)}
            className={`min-h-12 min-w-16 rounded-2xl border px-3 text-sm ${
              date === d ? 'border-[var(--brand)] bg-[var(--mint)]' : 'border-[var(--line)]'
            }`}>
            {d.slice(8)}
          </button>
        ))}
      </div>
      {loading ? <Loading /> : (
        <ul className="mt-4 grid grid-cols-3 gap-2">
          {(avail?.slots ?? []).map((s) => (
            <li key={s.startsAt}>
              <button type="button" data-testid={`reslot-${s.startsAt}`}
                onClick={() => setPicked(s.startsAt)}
                className={`min-h-12 w-full rounded-2xl border font-semibold ${
                  picked === s.startsAt ? 'border-[var(--brand)] bg-[var(--mint)]' : 'border-[var(--line)]'
                }`}>
                {timeOf(s.startsAt, booking.timezone)}
              </button>
            </li>
          ))}
        </ul>
      )}
      {err && <Note warn>{err}</Note>}
      <div className="mt-4 flex gap-3">
        <Btn onClick={onBack} disabled={busy}>Back</Btn>
        <Btn primary disabled={!picked || busy} onClick={() => void go()}>Confirm new time</Btn>
      </div>
    </Card>
  );
}

function applyGate(
  e: unknown,
  setGateErr: (v: string | null) => void,
  setErr: (v: string | null) => void,
  shop: Shop,
  onBack: () => void,
): void {
  if (!(e instanceof ApiError)) {
    setErr(`Something went wrong. Please try again${shop.phone ? `, or call ${shop.phone}` : ''}.`);
    return;
  }
  const reason = String(e.details['reason'] ?? '');
  if (reason === 'last4_mismatch') {
    setGateErr(`That number did not match. ${e.details['attemptsLeft'] ?? 0} attempts left.`);
    onBack();
    return;
  }
  if (reason === 'last4_locked') {
    setGateErr('Too many attempts. Please wait 15 minutes or call the shop.');
    onBack();
    return;
  }
  if (reason === 'not_mutable' || reason === 'already_cancelled') {
    setErr('This appointment can no longer be changed online.');
    return;
  }
  if (reason === 'cancel_cutoff_passed' || reason === 'reschedule_cutoff_passed' || reason === 'cutoff_passed') {
    setErr(`It is too close to the appointment time. Please call ${shop.phone ?? 'the shop'}.`);
    return;
  }
  if (reason === 'reschedule_disabled') {
    setErr(`Online rescheduling is off. Please call ${shop.phone ?? 'the shop'}.`);
    return;
  }
  if (reason === 'reschedule_limit_reached') {
    setErr(`This booking has already been rescheduled the maximum number of times. Please call ${shop.phone ?? 'the shop'}.`);
    return;
  }
  setErr(`We could not complete that change. Please try again${shop.phone ? `, or call ${shop.phone}` : ''}.`);
}

function reasonCopy(reason: string, shop: Shop): string {
  if (reason === 'cutoff_passed' || reason === 'cancel_cutoff_passed' || reason === 'reschedule_cutoff_passed') {
    return `It is too close to the appointment time to change it online. Please call ${shop.phone ?? 'the shop'}.`;
  }
  if (reason === 'reschedule_limit_reached') {
    return `This booking has already been rescheduled the maximum number of times. Please call ${shop.phone ?? 'the shop'}.`;
  }
  if (reason === 'reschedule_disabled') {
    return `Online rescheduling is off. You can still cancel if policy allows, or call ${shop.phone ?? 'the shop'}.`;
  }
  if (reason === 'not_mutable') {
    return 'This appointment can no longer be changed. You can book again below.';
  }
  return 'Please call the shop if you need to make a change.';
}
