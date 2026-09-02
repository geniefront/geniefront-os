import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  ApiError, book, getAvailability, getHostedShop, getPublicKey, getServices, setPublicKey,
  type Availability, type BookInput, type Catalog, type Service, type Shop,
} from '../lib/api';
import { isEmbedded, reportBooked, reportHeight } from '../lib/embed';
import { addDays, dateOf, duration, money, prettyPhone, timeOf, toE164, todayIn } from '../lib/format';
import { saveLastBooking } from '../lib/session';
import { hostedManagePath } from '../lib/manageToken';
import { loadTurnstile, type TurnstileApi } from '../lib/turnstile';
import {
  Btn, CallShop, Card, Dock, Loading, Note, PhoneLink, Shell, Topbar, type BookStep,
} from '../components/Chrome';

export type Draft = {
  serviceId: string | null;
  addonIds: string[];
  staffId: string | null;
  date: string | null;
  startsAt: string | null;
};

const emptyDraft = (): Draft => ({
  serviceId: null, addonIds: [], staffId: null, date: null, startsAt: null,
});

export function BookPage() {
  const { slug } = useParams();
  const [params] = useSearchParams();
  const embed = isEmbedded() || params.get('embed') === '1';

  const queryClient = useQueryClient();
  const [step, setStep] = useState<BookStep>('services');
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [avail, setAvail] = useState<Availability | null>(null);
  const [availBusy, setAvailBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [done, setDone] = useState<{
    bookingId: string; confirmationCode: string | null; manageToken: string | null;
  } | null>(null);
  const [idem, setIdem] = useState(() => crypto.randomUUID());
  const openedAt = useRef(Date.now());

  useEffect(() => {
    if (embed) document.documentElement.classList.add('embed');
    return reportHeight();
  }, [embed]);

  const shopQuery = useQuery({
    queryKey: ['hosted-shop', slug],
    enabled: Boolean(slug),
    queryFn: async () => {
      const s = await getHostedShop(slug!, 'en');
      if (s.publicKey) setPublicKey(s.publicKey);
      document.title = `${s.name} · Book`;
      return s;
    },
  });
  const catalogQuery = useQuery({
    queryKey: ['hosted-services', slug, shopQuery.data?.publicKey],
    enabled: Boolean(shopQuery.data?.onlineBooking.enabled && getPublicKey()),
    queryFn: () => getServices('en'),
  });

  const shop = shopQuery.data ?? null;
  const catalog = catalogQuery.data ?? null;
  const fatal = !slug
    ? 'NOT_FOUND'
    : shopQuery.isError
      ? (shopQuery.error instanceof ApiError ? shopQuery.error.code : 'INTERNAL')
      : null;

  const loadSlots = useCallback(async (
    date: string, serviceId: string, addonIds: string[], staffId: string | null,
  ) => {
    setAvailBusy(true);
    try {
      const a = await queryClient.fetchQuery({
        queryKey: ['availability', date, serviceId, addonIds, staffId],
        queryFn: () => getAvailability({ date, serviceId, addonIds, staffId }),
      });
      setAvail(a);
      return a;
    } catch {
      setAvail(null);
      return null;
    } finally {
      setAvailBusy(false);
    }
  }, [queryClient]);

  async function findFirstDay(serviceId: string, addonIds: string[], staffId: string | null, tz: string) {
    const start = todayIn(tz);
    for (let i = 0; i < 14; i++) {
      const date = addDays(start, i);
      const a = await loadSlots(date, serviceId, addonIds, staffId);
      if (a && a.slots.length > 0) return date;
    }
    return start;
  }

  async function pickService(serviceId: string, addonIds: string[]) {
    if (!shop) return;
    setDraft({ serviceId, addonIds, staffId: null, date: null, startsAt: null });
    const date = await findFirstDay(serviceId, addonIds, null, shop.timezone);
    setDraft((d) => ({ ...d, date }));
    setStep('specialist');
  }

  async function pickStaff(staffId: string | null) {
    if (!shop || !draft.serviceId) return;
    const date = await findFirstDay(draft.serviceId, draft.addonIds, staffId, shop.timezone);
    setDraft((d) => ({ ...d, staffId, date, startsAt: null }));
    setStep('time');
  }

  async function submit(input: BookInput) {
    try {
      const out = await book(input, idem);
      const payload = {
        bookingId: out.bookingId,
        confirmationCode: out.confirmationCode,
        manageToken: out.manageToken,
      };
      setDone(payload);
      if (slug) saveLastBooking({ ...payload, shopSlug: slug });
      reportBooked(out.confirmationCode);
      setIdem(crypto.randomUUID());
      setStep('success');
      try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch { /* jsdom */ }
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (e.isTaken) {
        setBanner('That time was just booked. Please pick another slot.');
        setStep('time');
        if (draft.date && draft.serviceId) {
          await loadSlots(draft.date, draft.serviceId, draft.addonIds, draft.staffId);
        }
        return;
      }
      if (e.isRateLimited) {
        setBanner(`Too many attempts. Please wait and try again${shop?.phone ? ', or call the shop' : ''}.`);
        return;
      }
      throw e;
    }
  }

  if (fatal === 'NOT_FOUND' || fatal === 'NO_PUBLIC_KEY') {
    return (
      <Shell>
        <Card>
          <h1 className="text-xl font-bold">Shop not found</h1>
          <p className="mt-3 text-[var(--muted)]">This booking link is missing or no longer valid.</p>
        </Card>
      </Shell>
    );
  }
  if (fatal) {
    return (
      <Shell>
        <Card>
          <h1 className="text-xl font-bold">Booking is temporarily unavailable</h1>
          <p className="mt-3 text-[var(--muted)]">Please try again in a moment, or call the shop if you have the number.</p>
        </Card>
      </Shell>
    );
  }
  if (shopQuery.isLoading || !shop) return <Shell><Loading /></Shell>;

  if (!shop.onlineBooking.enabled) {
    return (
      <Shell>
        <Topbar shop={shop} step={null} />
        <CallShop shop={shop}>Online booking is turned off</CallShop>
      </Shell>
    );
  }
  if (catalog && catalog.services.length === 0) {
    return (
      <Shell>
        <Topbar shop={shop} step={null} />
        <CallShop shop={shop}>No services are available to book online</CallShop>
      </Shell>
    );
  }

  const service = catalog?.services.find((s) => s.id === draft.serviceId) ?? null;
  const addons = catalog?.addons.filter((a) => draft.addonIds.includes(a.id)) ?? [];

  return (
    <div className="md:grid md:grid-cols-[minmax(0,1fr)_280px] md:gap-6">
      <Shell>
        <Topbar shop={shop} step={step} />
        {banner && <Note warn>{banner}</Note>}

        {step === 'services' && (
          catalog
            ? <ServiceStep catalog={catalog} shop={shop} onPick={(id, ids) => void pickService(id, ids)} />
            : <Card><Loading /></Card>
        )}

        {step === 'specialist' && service && (
          <SpecialistStep
            shop={shop}
            staff={avail?.staff ?? []}
            busy={availBusy}
            onPick={(id) => void pickStaff(id)}
            onBack={() => { setBanner(null); setStep('services'); }}
          />
        )}

        {step === 'time' && service && (
          <TimeStep
            shop={shop} draft={draft} avail={avail} busy={availBusy}
            onDate={(date) => {
              setDraft((d) => ({ ...d, date, startsAt: null }));
              if (draft.serviceId) void loadSlots(date, draft.serviceId, draft.addonIds, draft.staffId);
            }}
            onSlot={(startsAt) => {
              setBanner(null);
              setDraft((d) => ({ ...d, startsAt }));
              setStep('confirm');
            }}
            onBack={() => { setBanner(null); setStep('specialist'); }}
          />
        )}

        {step === 'confirm' && service && draft.startsAt && (
          <ConfirmStep
            shop={shop} service={service} addons={addons}
            startsAt={draft.startsAt} staffId={draft.staffId}
            openedAt={openedAt.current}
            onSubmit={submit}
            onBack={() => setStep('time')}
          />
        )}

        {step === 'success' && done && slug && (
          <SuccessStep
            shop={shop} slug={slug} done={done}
            onAgain={() => {
              setDraft(emptyDraft());
              setDone(null); setBanner(null); setStep('services');
              openedAt.current = Date.now();
            }}
          />
        )}

        {shop.phone && step !== 'success' && (
          <p className="mt-6 text-center text-sm text-[var(--muted)]">
            Questions? Call <PhoneLink shop={shop} />
          </p>
        )}
      </Shell>

      {service && step !== 'success' && (
        <aside className="hidden md:sticky md:top-6 md:mt-6 md:block md:self-start">
          <Summary shop={shop} service={service} addons={addons} draft={draft} staffName={
            draft.staffId ? avail?.staff.find((s) => s.id === draft.staffId)?.displayName ?? null : 'Any specialist'
          } />
        </aside>
      )}
    </div>
  );
}

function Summary({
  shop, service, addons, draft, staffName,
}: {
  shop: Shop; service: Service; addons: Service[]; draft: Draft; staffName: string | null;
}) {
  const mins = service.durationMin + addons.reduce((n, a) => n + a.durationMin, 0);
  const cents = service.priceCents + addons.reduce((n, a) => n + a.priceCents, 0);
  return (
    <Card>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--muted)]">Your appointment</h2>
      <p className="mt-2 font-semibold">{service.name}</p>
      {addons.map((a) => <p key={a.id} className="text-sm text-[var(--muted)]">+ {a.name}</p>)}
      <p className="mt-2 text-sm">{duration(mins)} · {money(cents, shop.currency)}</p>
      {staffName && <p className="mt-2 text-sm">{staffName}</p>}
      {draft.startsAt && (
        <p className="mt-2 text-sm">
          {dateOf(draft.startsAt, shop.timezone)} · {timeOf(draft.startsAt, shop.timezone)}
        </p>
      )}
    </Card>
  );
}

function ServiceStep({
  catalog, shop, onPick,
}: {
  catalog: Catalog; shop: Shop; onPick: (id: string, addonIds: string[]) => void;
}) {
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const service = catalog.services.find((s) => s.id === serviceId) ?? null;
  const selectedAddons = catalog.addons.filter((a) => addonIds.includes(a.id));
  const mins = (service?.durationMin ?? 0) + selectedAddons.reduce((n, a) => n + a.durationMin, 0);
  const cents = (service?.priceCents ?? 0) + selectedAddons.reduce((n, a) => n + a.priceCents, 0);

  return (
    <>
      <Card>
        <h2 className="text-xl font-bold">Choose a service</h2>
        <ul className="mt-4 grid gap-2">
          {catalog.services.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                data-testid={`service-${s.id}`}
                onClick={() => { setServiceId(s.id); setAddonIds([]); }}
                className={`flex min-h-14 w-full items-center justify-between rounded-2xl border px-4 text-left ${
                  serviceId === s.id ? 'border-[var(--brand)] bg-[var(--mint)]' : 'border-[var(--line)]'
                }`}
              >
                <span>
                  <span className="block font-semibold">{s.name}</span>
                  <span className="text-sm text-[var(--muted)]">{duration(s.durationMin)}</span>
                </span>
                <span className="font-semibold">{money(s.priceCents, shop.currency)}</span>
              </button>
            </li>
          ))}
        </ul>
        {service && catalog.addons.length > 0 && (
          <div className="mt-5">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--muted)]">Add-ons</h3>
            <ul className="mt-2 grid gap-2">
              {catalog.addons.map((a) => {
                const on = addonIds.includes(a.id);
                return (
                  <li key={a.id}>
                    <button
                      type="button"
                      data-testid={`addon-${a.id}`}
                      onClick={() => setAddonIds((ids) => on ? ids.filter((id) => id !== a.id) : [...ids, a.id])}
                      className={`flex min-h-12 w-full items-center justify-between rounded-2xl border px-4 text-left ${
                        on ? 'border-[var(--brand)] bg-[var(--mint)]' : 'border-[var(--line)]'
                      }`}
                    >
                      <span>{a.name}</span>
                      <span>+{duration(a.durationMin)} · {money(a.priceCents, shop.currency)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 text-sm text-[var(--muted)]" data-testid="totals">
              Total {duration(mins)} · {money(cents, shop.currency)}
            </p>
          </div>
        )}
      </Card>
      <Dock>
        <Btn primary disabled={!serviceId} onClick={() => serviceId && onPick(serviceId, addonIds)}>
          Continue
        </Btn>
      </Dock>
    </>
  );
}

function SpecialistStep({
  shop, staff, busy, onPick, onBack,
}: {
  shop: Shop;
  staff: Availability['staff'];
  busy: boolean;
  onPick: (id: string | null) => void;
  onBack: () => void;
}) {
  if (busy && staff.length === 0) return <Card><Loading /></Card>;
  if (staff.length === 0) {
    return (
      <>
        <CallShop shop={shop}>No specialists are available online</CallShop>
        <Dock><Btn onClick={onBack}>Back</Btn></Dock>
      </>
    );
  }
  return (
    <>
      <Card>
        <h2 className="text-xl font-bold">Choose a specialist</h2>
        <ul className="mt-4 grid gap-2">
          <li>
            <button type="button" data-testid="staff-any" onClick={() => onPick(null)}
              className="flex min-h-14 w-full items-center rounded-2xl border border-[var(--line)] px-4 text-left font-semibold">
              Any available specialist
            </button>
          </li>
          {staff.map((s) => (
            <li key={s.id}>
              <button type="button" data-testid={`staff-${s.id}`} onClick={() => onPick(s.id)}
                className="flex min-h-14 w-full items-center rounded-2xl border border-[var(--line)] px-4 text-left font-semibold">
                {s.displayName}
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <Dock><Btn onClick={onBack}>Back</Btn></Dock>
    </>
  );
}

function TimeStep({
  shop, draft, avail, busy, onDate, onSlot, onBack,
}: {
  shop: Shop;
  draft: Draft;
  avail: Availability | null;
  busy: boolean;
  onDate: (date: string) => void;
  onSlot: (startsAt: string) => void;
  onBack: () => void;
}) {
  const start = todayIn(shop.timezone);
  const days = Array.from({ length: Math.min(14, shop.onlineBooking.maxDaysAhead) }, (_, i) => addDays(start, i));
  return (
    <>
      <Card>
        <h2 className="text-xl font-bold">Pick a time</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">Times are shown in {shop.timezone.replace(/_/g, ' ')}.</p>
        <div className="mt-4 flex gap-2 overflow-x-auto pb-2" data-testid="day-strip">
          {days.map((d) => (
            <button key={d} type="button" data-testid={`day-${d}`} onClick={() => onDate(d)}
              className={`min-h-14 min-w-16 rounded-2xl border px-3 text-sm ${
                draft.date === d ? 'border-[var(--brand)] bg-[var(--mint)]' : 'border-[var(--line)]'
              }`}>
              {d.slice(8)}
            </button>
          ))}
        </div>
        {busy ? <Loading /> : (
          <ul className="mt-4 grid grid-cols-3 gap-2" data-testid="slots">
            {(avail?.slots ?? []).map((s) => (
              <li key={s.startsAt}>
                <button type="button" data-testid={`slot-${s.startsAt}`} onClick={() => onSlot(s.startsAt)}
                  className="min-h-12 w-full rounded-2xl border border-[var(--line)] font-semibold">
                  {timeOf(s.startsAt, shop.timezone)}
                </button>
              </li>
            ))}
          </ul>
        )}
        {!busy && avail && avail.slots.length === 0 && (
          <Note>No times on this day. Try the next available day, or call <PhoneLink shop={shop} />.</Note>
        )}
      </Card>
      <Dock><Btn onClick={onBack}>Back</Btn></Dock>
    </>
  );
}

function ConfirmStep({
  shop, service, addons, startsAt, staffId, openedAt, onSubmit, onBack,
}: {
  shop: Shop;
  service: Service;
  addons: Service[];
  startsAt: string;
  staffId: string | null;
  openedAt: number;
  onSubmit: (input: BookInput) => Promise<void>;
  onBack: () => void;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [smsOptIn, setSmsOptIn] = useState(false);
  const [website, setWebsite] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [botErr, setBotErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);
  const tsApi = useRef<TurnstileApi | null>(null);
  const inflight = useRef(false);

  useEffect(() => {
    const key = shop.turnstileSiteKey;
    if (!key || !boxRef.current) return;
    let dead = false;
    void loadTurnstile().then((ts) => {
      if (dead || !boxRef.current || widgetId.current) return;
      tsApi.current = ts;
      widgetId.current = ts.render(boxRef.current, {
        sitekey: key,
        callback: (t: string) => { setToken(t); setBotErr(false); },
        'expired-callback': () => setToken(null),
        'error-callback': () => { setToken(null); setBotErr(true); },
        theme: 'light',
      });
    }).catch(() => setBotErr(true));
    return () => {
      dead = true;
      if (widgetId.current) { tsApi.current?.remove(widgetId.current); widgetId.current = null; }
    };
  }, [shop.turnstileSiteKey]);

  const e164 = toE164(phone);
  const ready = name.trim().length > 0 && e164 !== null && (token !== null || !shop.turnstileSiteKey);

  async function go() {
    if (!ready || inflight.current) return;
    inflight.current = true;
    setBusy(true); setErr(null);
    try {
      await onSubmit({
        turnstileToken: token ?? 'dev',
        locale: 'en',
        customer: {
          name: name.trim(),
          phone: e164!,
          ...(email.trim() ? { email: email.trim() } : {}),
          smsOptIn,
        },
        items: [{ serviceId: service.id, addonIds: addons.map((a) => a.id), staffId, startsAt }],
        partySize: 1,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        website,
        formElapsedMs: Date.now() - openedAt,
      });
    } catch (e) {
      setErr(confirmError(e, shop));
      if (widgetId.current) { tsApi.current?.reset(widgetId.current); setToken(null); }
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }

  const mins = service.durationMin + addons.reduce((n, a) => n + a.durationMin, 0);
  const cents = service.priceCents + addons.reduce((n, a) => n + a.priceCents, 0);

  return (
    <>
      <Card>
        <h2 className="text-xl font-bold">Confirm your details</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          {dateOf(startsAt, shop.timezone)} {timeOf(startsAt, shop.timezone)} · {service.name}
          {addons.length ? ` + ${addons.map((a) => a.name).join(', ')}` : ''} · {duration(mins)} · {money(cents, shop.currency)}
        </p>
        <div className="mt-4 grid gap-3">
          <label className="text-sm font-semibold">Name
            <input className="mt-1 min-h-12 w-full rounded-2xl border border-[var(--line)] px-3" value={name}
              autoComplete="name" maxLength={120} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="text-sm font-semibold">Mobile phone
            <input className="mt-1 min-h-12 w-full rounded-2xl border border-[var(--line)] px-3" value={phone}
              inputMode="tel" autoComplete="tel" placeholder="(617) 555-0199"
              onChange={(e) => setPhone(prettyPhone(e.target.value))} />
          </label>
          <label className="text-sm font-semibold">Email (optional)
            <input className="mt-1 min-h-12 w-full rounded-2xl border border-[var(--line)] px-3" value={email}
              type="email" autoComplete="email" maxLength={200} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="text-sm font-semibold">Notes (optional)
            <input className="mt-1 min-h-12 w-full rounded-2xl border border-[var(--line)] px-3" value={notes}
              maxLength={500} onChange={(e) => setNotes(e.target.value)} />
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 h-5 w-5" checked={smsOptIn}
              onChange={(e) => setSmsOptIn(e.target.checked)} />
            <span>I agree to receive marketing texts from {shop.name}. Reply STOP to unsubscribe. Booking confirmation texts are still sent if you leave this unchecked.</span>
          </label>
          <input className="hp" tabIndex={-1} autoComplete="off" aria-hidden="true"
            name="website" value={website} onChange={(e) => setWebsite(e.target.value)} />
          {shop.turnstileSiteKey && <div ref={boxRef} data-testid="turnstile" className="min-h-[66px]" />}
          {botErr && <Note warn>Security check failed. Refresh and try again.</Note>}
          {err && <Note warn>{err}</Note>}
        </div>
      </Card>
      <Dock>
        <Btn onClick={onBack} disabled={busy}>Back</Btn>
        <Btn primary disabled={!ready || busy} onClick={() => void go()}>
          {busy ? <span className="spin" /> : 'Book appointment'}
        </Btn>
      </Dock>
    </>
  );
}

function confirmError(e: unknown, shop: Shop): string {
  const tail = shop.phone ? `, or call ${shop.phone}` : '';
  if (!(e instanceof ApiError)) return `Something went wrong. Please try again${tail}.`;
  const reason = String(e.details['reason'] ?? '');
  if (reason === 'bot_check_failed') return 'Security check failed. Please try again.';
  if (reason === 'too_soon') return `That time is too soon. Please call the shop${shop.phone ? ` at ${shop.phone}` : ''}.`;
  if (reason === 'too_many_upcoming') return `You already have several upcoming appointments. Please call the shop${shop.phone ? ` at ${shop.phone}` : ''}.`;
  if (e.status === 0) return `Network problem. Check your connection and try again${tail}.`;
  return `We could not complete this booking. Please try again${tail}.`;
}

function SuccessStep({
  shop, slug, done, onAgain,
}: {
  shop: Shop;
  slug: string;
  done: { bookingId: string; confirmationCode: string | null; manageToken: string | null };
  onAgain: () => void;
}) {
  return (
    <Card>
      <h2 className="text-xl font-bold">You are booked</h2>
      {done.confirmationCode && (
        <p className="mt-3 text-lg" data-testid="confirmation-code">
          Confirmation code <strong>{done.confirmationCode}</strong>
        </p>
      )}
      {done.manageToken && (
        <p className="mt-3">
          <Link className="font-semibold text-[var(--brand)] underline" to={hostedManagePath(slug, done.manageToken)}>
            View, reschedule, or cancel
          </Link>
        </p>
      )}
      <p className="mt-3 text-sm text-[var(--muted)]">
        Keep this page or your confirmation text. Questions? Call <PhoneLink shop={shop} />.
      </p>
      <div className="mt-5"><Btn onClick={onAgain}>Book another</Btn></div>
    </Card>
  );
}
