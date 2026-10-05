import type {ReactNode} from 'react';
import {Input,TextArea,Button,Checkbox} from '@heroui/react';
import {DateChooser} from '../components/BookingUI';
import { formatPhoneDisplay } from '@gf/contracts/phone';
import { PhoneInput } from '@gf/phone-input';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  ApiError, book, getAvailability, getBundles, getHostedShop, getPublicKey, getServices, setPublicKey,
  type Availability, type Bundle, type BookInput, type Catalog, type Service, type Shop, type ManagedBooking,
} from '../lib/api';
import { isEmbedded, reportBooked, reportHeight } from '../lib/embed';
import {
  addDays, bookableDateCount, bookingToday, dateOf, datePage, DAY_PAGE, duration, money,
  pageOffsetForDate, prettyPhone, timeOf, toE164,
} from '../lib/format';
import { saveLastBooking } from '../lib/session';
import { hostedManagePath } from '../lib/manageToken';
import { loadTurnstile, type TurnstileApi } from '../lib/turnstile';
import {
  Btn, CallShop, Card, Dock, Loading, Note, PhoneLink, Progress, Shell, Topbar, type BookStep,
} from '../components/Chrome';
import { useLanguage } from '../lib/i18n';
import {AppointmentDeposit} from '../components/AppointmentDeposit';
import {depositText} from '@gf/contracts';
import {quoteAppointmentDeposit,allocateAppointmentDepositByGuest} from '@gf/payroll';
import {loadManagedBooking} from '../lib/api';

export type Draft = {
  serviceId: string | null;
  /** 组合套餐（U10）。与 serviceId 二选一。 */
  bundleId: string | null;
  addonIds: string[];
  staffId: string | null;
  date: string | null;
  startsAt: string | null;
};

const emptyDraft = (): Draft => ({
  serviceId: null, bundleId: null, addonIds: [], staffId: null, date: null, startsAt: null,
});

export function BookPage() {
  const { slug } = useParams();
  const [params] = useSearchParams();
  const embed = isEmbedded() || params.get('embed') === '1';

  const { t, locale } = useLanguage();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<BookStep>('services');
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [avail, setAvail] = useState<Availability | null>(null);
  const [availBusy, setAvailBusy] = useState(false);
  const [staffChoices, setStaffChoices] = useState<Availability['staff']>([]);
  const [banner, setBanner] = useState<string | null>(null);
  const [contact,setContact]=useState<BookingContact>();
  const [done, setDone] = useState<{
    bookingId: string; manageToken: string | null; summary?:ManagedBooking; status?:string;
  } | null>(null);
  const [idem, setIdem] = useState(() => crypto.randomUUID());
  const openedAt = useRef(Date.now());
  const selectionVersion = useRef(0);
  const requestVersion = useRef(0);
  const invalidateSlots = () => {
    selectionVersion.current++;
    requestVersion.current++;
    setAvail(null);
    setAvailBusy(false);
  };
  useEffect(() => () => { selectionVersion.current++; requestVersion.current++; }, [slug, locale]);

  useEffect(() => {
    if (embed) document.documentElement.classList.add('embed');
    return reportHeight();
  }, [embed]);

  const shopQuery = useQuery({
    queryKey: ['hosted-shop', slug, locale],
    enabled: Boolean(slug),
    queryFn: async () => {
      const s = await getHostedShop(slug!, locale);
      if (s.publicKey) setPublicKey(s.publicKey);
      document.title = `${s.name} · Book`;
      return s;
    },
  });
  const catalogQuery = useQuery({
    queryKey: ['hosted-services', slug, shopQuery.data?.publicKey, locale],
    enabled: Boolean(shopQuery.data?.onlineBooking.enabled && getPublicKey()),
    queryFn: () => getServices(locale,shopQuery.data?.publicKey),
  });
  const bundlesQuery = useQuery({
    queryKey: ['hosted-bundles', slug, shopQuery.data?.publicKey, locale],
    enabled: Boolean(shopQuery.data?.onlineBooking.enabled && getPublicKey()),
    queryFn: () => getBundles(locale,shopQuery.data?.publicKey),
  });

  const shop = shopQuery.data ?? null;
  const catalog = catalogQuery.data ?? null;
  const bundles = (bundlesQuery.data?.bundles ?? []).filter((b) => b.bookable);
  const fatal = !slug
    ? 'NOT_FOUND'
    : shopQuery.isError
      ? (shopQuery.error instanceof ApiError ? shopQuery.error.code : 'INTERNAL')
      : null;

  const loadSlots = useCallback(async (
    date: string, serviceId: string, addonIds: string[], staffId: string | null,
    bundleId?: string | null,
  ) => {
    const request = ++requestVersion.current;
    setAvail(null);
    setAvailBusy(true);
    try {
      const a = await queryClient.fetchQuery({
        queryKey: ['availability', slug, locale, getPublicKey(), date, serviceId, bundleId, addonIds, staffId],
        queryFn: () => getAvailability(
          bundleId ? { date, bundleId } : { date, serviceId, addonIds, staffId },
        ),
      });
      if (request !== requestVersion.current) return null;
      setAvail(a);
      setStaffChoices(a.staff);
      return a;
    } catch {
      if (request === requestVersion.current) setAvail(null);
      return null;
    } finally {
      if (request === requestVersion.current) setAvailBusy(false);
    }
  }, [queryClient, slug, locale]);

  async function findFirstDay(
    serviceId: string, addonIds: string[], staffId: string | null, start: string, horizon: number,
    bundleId?: string | null,
  ) {
    const selection = selectionVersion.current;
    const days = bookableDateCount(horizon);
    for (let i = 0; i < days; i++) {
      const date = addDays(start, i);
      const a = await loadSlots(date, serviceId, addonIds, staffId, bundleId);
      if (selection !== selectionVersion.current) return null;
      if (a && a.slots.length > 0) return date;
    }
    await loadSlots(start, serviceId, addonIds, staffId, bundleId);
    return selection === selectionVersion.current ? start : null;
  }

  async function pickService(serviceId: string, addonIds: string[]) {
    if (!shop) return;
    invalidateSlots();
    setDraft({ serviceId, bundleId: null, addonIds, staffId: null, date: null, startsAt: null });
    const start = bookingToday(shop.timezone, shop.businessDayCutoff);
    const date = await findFirstDay(
      serviceId, addonIds, null, start, shop.onlineBooking.maxDaysAhead,
    );
    if (date === null) return;
    setDraft((d) => ({ ...d, date }));
    setStep('specialist');
  }

  async function pickBundle(b: Bundle) {
    if (!shop) return;
    invalidateSlots();
    // 组合套餐不在官网选技师：子项由门店派单。直接进选时间。
    setDraft({ serviceId: null, bundleId: b.id, addonIds: [], staffId: null, date: null, startsAt: null });
    const start = bookingToday(shop.timezone, shop.businessDayCutoff);
    const date = await findFirstDay(
      '', [], null, start, shop.onlineBooking.maxDaysAhead, b.id,
    );
    if (date === null) return;
    setDraft((d) => ({ ...d, date }));
    setStep('time');
  }

  async function pickStaff(staffId: string | null) {
    if (!shop || !draft.serviceId) return;
    invalidateSlots();
    const start = bookingToday(shop.timezone, shop.businessDayCutoff);
    const date = await findFirstDay(
      draft.serviceId, draft.addonIds, staffId, start, shop.onlineBooking.maxDaysAhead,
    );
    if (date === null) return;
    setDraft((d) => ({ ...d, staffId, date, startsAt: null }));
    setStep('time');
  }

  async function submit(input: BookInput) {
    try {
      const out = await book(input, idem,shopQuery.data?.publicKey);
      const payload = {
        bookingId: out.bookingId,
        manageToken: out.manageToken,
        ...(out.summary?{summary:out.summary}:{}),
        status:out.status,
      };
      setDone(payload);
      if (slug) saveLastBooking({ ...payload, shopSlug: slug });
      if(!out.summary?.deposit||['paid','refunded'].includes(out.summary.deposit.status))reportBooked();
      setIdem(crypto.randomUUID());
      setStep('success');
      try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch { /* jsdom */ }
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (e.isTaken) {
        setBanner('That time was just booked. Please pick another slot.');
        setStep('time');
        if (draft.date && (draft.serviceId || draft.bundleId)) {
          await loadSlots(draft.date, draft.serviceId ?? '', draft.addonIds, draft.staffId, draft.bundleId);
        }
        return;
      }
      throw e;
    }
  }

  if (fatal === 'NOT_FOUND' || fatal === 'NO_PUBLIC_KEY') {
    return (
      <Shell>
        <Card>
          <h1 className="text-xl font-bold"> {t("Shop not found")} </h1>
          <p className="mt-3 text-[var(--muted)]"> {t("This booking link is missing or no longer valid.")} </p>
        </Card>
      </Shell>
    );
  }
  if (fatal) {
    return (
      <Shell>
        <Card>
          <h1 className="text-xl font-bold"> {t("Booking is temporarily unavailable")} </h1>
          <p className="mt-3 text-[var(--muted)]"> {t("Please try again in a moment, or call the shop if you have the number.")} </p>
        </Card>
      </Shell>
    );
  }
  if (shopQuery.isLoading || !shop) return <Shell><Loading /></Shell>;

  if (!shop.onlineBooking.enabled) {
    return (
      <Shell>
        <Topbar shop={shop} step={null} />
        <CallShop shop={shop}> {t("Online booking is turned off")} </CallShop>
      </Shell>
    );
  }
  if (catalog && catalog.services.filter(s=>s.onlineBookable!==false).length === 0 && bundles.length===0) {
    return (
      <Shell>
        <Topbar shop={shop} step={null} />
        <CallShop shop={shop}> {t("No services are available to book online")} </CallShop>
      </Shell>
    );
  }

  const service = catalog?.services.find((s) => s.id === draft.serviceId) ?? null;
  const addons = catalog?.addons.filter((a) => draft.addonIds.includes(a.id)) ?? [];
  const bundle = bundles.find((b) => b.id === draft.bundleId) ?? null;
  const bundleForConfirm = bundle
    ? {
        id: bundle.id,
        version: bundle.version,
        name: bundle.name,
        priceCents: bundle.priceCents,
        originalTotalCents: bundle.originalTotalCents,
        durationMin: bundle.components.reduce((n, c) => n + c.durationMin * c.qty, 0),
      }
    : undefined;

  return (
    <div className="min-h-screen bg-[var(--paper)]">
      <div className="bg-[var(--surface)]">
        <Shell><Topbar shop={shop} step={step} /></Shell>
      </div>
      <Shell>
        <div className="pt-4 md:hidden"><Progress step={step} /></div>
        <div className="booking-main">
          <main className="min-w-0">
          {banner && <Note warn>{banner}</Note>}

        {step === 'services' && (
          catalog
            ? (
              <ServiceStep
                catalog={catalog}
                bundles={bundles}
                shop={shop}
                onPick={(id, ids) => void pickService(id, ids)}
                onPickBundle={(b) => void pickBundle(b)}
              />
            )
            : <Card><Loading /></Card>
        )}

        {step === 'specialist' && service && (
          <SpecialistStep
            shop={shop}
            staff={staffChoices}
            busy={availBusy}
            onPick={(id) => void pickStaff(id)}
            onBack={() => { invalidateSlots(); setBanner(null); setStep('services'); }}
          />
        )}

        {step === 'time' && (service || bundle) && (
          <TimeStep
            shop={shop} draft={draft} avail={avail} busy={availBusy}
            onDate={(date) => {
              invalidateSlots();
              setDraft((d) => ({ ...d, date, startsAt: null }));
              if (draft.serviceId || draft.bundleId) {
                void loadSlots(date, draft.serviceId ?? '', draft.addonIds, draft.staffId, draft.bundleId);
              }
            }}
            onSlot={(startsAt) => {
              setBanner(null);
              if (availBusy || !avail?.slots.some(slot => slot.startsAt === startsAt)) return;
              setDraft((d) => ({ ...d, startsAt }));
              setStep('confirm');
            }}
            onBack={() => { invalidateSlots(); setBanner(null); setStep(bundle ? 'services' : 'specialist'); }}
          />
        )}

        {step === 'confirm' && (service || bundleForConfirm) && draft.startsAt && (
          <ConfirmStep
            shop={shop} service={service} addons={addons} bundle={bundleForConfirm}
            startsAt={draft.startsAt} staffId={draft.staffId}
            openedAt={openedAt.current}
            onSubmit={submit}
            onBack={() => setStep('time')}
            initialContact={contact} onContactChange={setContact}
            onRefreshQuote={async()=>{
              await Promise.all([shopQuery.refetch({throwOnError:true}),catalogQuery.refetch({throwOnError:true}),bundlesQuery.refetch({throwOnError:true})]);
              setIdem(crypto.randomUUID());setDraft(d=>({...d,startsAt:null}));setStep('time');
              if(draft.date)await loadSlots(draft.date,draft.serviceId??'',draft.addonIds,draft.staffId,draft.bundleId);
            }}
          />
        )}

        {step === 'success' && done && slug && (
          <SuccessStep
            shop={shop} slug={slug} done={done} showSummary
            onAgain={() => {
              setDraft(emptyDraft());
              setDone(null); setBanner(null); setStep('services');
              openedAt.current = Date.now();
            }}
          />
        )}

          {shop.phone && step !== 'success' && (
            <p className="mt-6 text-center text-sm text-[var(--muted)]"> {t("Need help? Call")} <PhoneLink shop={shop} />
            </p>
          )}
          </main>

          {(service || bundleForConfirm) && step !== 'success' && (
            <aside className="hidden md:block">
              <Summary shop={shop} service={service} addons={addons} bundle={bundleForConfirm} draft={draft} staffName={
                bundleForConfirm ? null
                  : draft.staffId ? avail?.staff.find((s) => s.id === draft.staffId)?.displayName ?? null : 'Any specialist'
              } />
            </aside>
          )}
        </div>
      </Shell>
    </div>
  );
}

function Summary({
  shop, service, addons, bundle, draft, staffName,
}: {
  shop: Shop; service: Service | null; addons: Service[];
  bundle?: { name: string; priceCents: number; durationMin: number };
  draft: Draft; staffName: string | null;
}) {
  const {t}=useLanguage();
  const mins = bundle ? bundle.durationMin : (service?.durationMin ?? 0) + addons.reduce((n, a) => n + a.durationMin, 0);
  const cents = bundle ? bundle.priceCents : (service?.priceCents ?? 0) + addons.reduce((n, a) => n + a.priceCents, 0);
  const displayName = bundle ? bundle.name : (service?.name ?? '');
  const address = typeof shop.address === 'string'
    ? shop.address
    : shop.address ? Object.values(shop.address).filter(Boolean).join(', ') : '';
  return (
    <Card className="summary-card !p-0">
      <div className="border-b border-[var(--line)] bg-[linear-gradient(145deg,#f3fbfa,#fff)] p-6">
        <div className="flex items-start gap-3">
          <div className="brand-mark">{shop.name.slice(0, 1).toUpperCase()}</div>
          <div>
            <h2 className="font-bold tracking-[-0.01em]">{shop.name}</h2>
            {address && <p className="mt-1 text-sm leading-5 text-[var(--muted)]">{address}</p>}
            {shop.phone && <p className="mt-1 text-sm text-[var(--muted)]">{formatPhoneDisplay(shop.phone)}</p>}
          </div>
        </div>
      </div>
      <div className="p-6">
        <p className="step-kicker"> {t("Your appointment")} </p>
        <div className="mt-4 flex items-start justify-between gap-4">
          <div>
            <p className="font-bold">{displayName}</p>
            <p className="mt-1 text-sm text-[var(--muted)]">{duration(mins)}</p>
          </div>
          <p className="font-bold">{money(cents, shop.currency)}</p>
        </div>
        {addons.map((a) => (
          <div key={a.id} className="mt-3 flex justify-between gap-3 text-sm text-[var(--muted)]">
            <span>+ {a.name}</span><span>{money(a.priceCents, shop.currency)}</span>
          </div>
        ))}
        <div className="mt-5 grid gap-3 border-t border-[var(--line)] pt-5 text-sm">
          {staffName && <SummaryRow icon="person" label="Specialist" value={staffName} />}
          {draft.startsAt && (
            <SummaryRow icon="calendar" label="Date & time" value={`${dateOf(draft.startsAt, shop.timezone)} · ${timeOf(draft.startsAt, shop.timezone)}`} />
          )}
          {!draft.startsAt && <SummaryRow icon="calendar" label="Date & time" value="Not selected yet" muted />}
        </div>
      </div>
      <div className="flex items-center justify-between border-t border-[var(--line)] bg-[#fbfcfc] px-6 py-5">
        <div><p className="text-sm text-[var(--muted)]"> {t("Total ·")} {duration(mins)}</p><p className="text-xs text-[var(--muted-light)]"> {t("Taxes calculated at checkout")} </p></div>
        <p className="text-xl font-extrabold">{money(cents, shop.currency)}</p>
      </div>
    </Card>
  );
}

function SummaryRow({ icon, label, value, muted = false }: { icon: 'person' | 'calendar'; label: string; value: string; muted?: boolean }) {
  const {t}=useLanguage();
  return (
    <div className="flex gap-3">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--brand-soft)] text-[var(--brand)]" aria-hidden="true">
        {icon === 'person' ? '◉' : '□'}
      </span>
      <div><p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-light)]">{t(label)}</p><p className={muted ? 'text-[var(--muted)]' : 'font-medium'}>{t(value)}</p></div>
    </div>
  );
}

function ServiceStep({
  catalog, bundles, shop, onPick, onPickBundle,
}: {
  catalog: Catalog; bundles: Bundle[]; shop: Shop;
  onPick: (id: string, addonIds: string[]) => void;
  onPickBundle: (bundle: Bundle) => void;
}) {
  const { t } = useLanguage();
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [categoryId, setCategoryId] = useState<string>('all');
  const service = catalog.services.find((s) => s.id === serviceId) ?? null;
  const visibleServices = categoryId === 'all'
    ? catalog.services.filter(s=>s.onlineBookable!==false)
    : catalog.services.filter((item) => item.onlineBookable!==false && item.categoryId === categoryId);
  const selectedAddons = catalog.addons.filter((a) => addonIds.includes(a.id));
  const mins = (service?.durationMin ?? 0) + selectedAddons.reduce((n, a) => n + a.durationMin, 0);
  const cents = (service?.priceCents ?? 0) + selectedAddons.reduce((n, a) => n + a.priceCents, 0);

  return (
    <>
      <div className="mb-6">
        <p className="step-kicker"> {t("Step 1 of 4")} </p>
        <h2 className="text-3xl font-extrabold tracking-[-0.035em]">{t('step.selectService', 'Choose a service')}</h2>
        <p className="mt-2 text-[var(--muted)]"> {t("Select the service you would like to book.")} </p>
      </div>
      {bundles.length > 0 && (
        <Card className="mb-4">
          <h3 className="text-base font-bold">{t('bundle.sectionTitle', 'Bundles')}</h3>
          <p className="mt-1 text-sm text-[var(--muted)]">{t('bundle.orService', 'or pick a single service below')}</p>
          <ul className="mt-3 grid gap-3">
            {bundles.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  data-testid={`bundle-${b.id}`}
                  onClick={() => onPickBundle(b)}
                  className="choice-card w-full rounded-2xl border border-[var(--brand)] bg-[var(--brand-soft)]/40 px-5 py-4 text-left"
                >
                  <span className="flex items-start justify-between gap-4">
                    <span className="min-w-0">
                      <span className="block font-bold">{b.name}</span>
                      <span className="mt-1 block text-sm text-[var(--muted)]">
                        {t('bundle.includes', 'Includes')}: {b.components.map((c) => `${c.name}${c.qty > 1 ? `×${c.qty}` : ''}`).join(' + ')}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-sm text-[var(--muted)] line-through">{money(b.originalTotalCents, shop.currency)}</span>
                      <span className="block font-bold text-[var(--brand)]">{money(b.priceCents, shop.currency)}</span>
                      {b.bundleDiscountCents > 0 && (
                        <span className="text-xs font-semibold text-emerald-600">{t('bundle.youSave', 'You save')} {money(b.bundleDiscountCents, shop.currency)}</span>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card>
        {catalog.categories.length > 0 && (
          <div className="mb-4 flex gap-2 overflow-x-auto pb-1" aria-label={t('step.serviceCategories', 'Service categories')}>
            <button type="button" onClick={() => setCategoryId('all')} aria-pressed={categoryId === 'all'} className={`min-h-10 shrink-0 rounded-full border px-4 text-sm font-bold ${categoryId === 'all' ? 'border-[var(--brand)] bg-[var(--brand)] text-white' : 'border-[var(--line)] bg-white text-[var(--muted)]'}`}>{t('step.allServices', 'All services')}</button>
            {catalog.categories.map((category) => (
              <button key={category.id} type="button" onClick={() => setCategoryId(category.id)} aria-pressed={categoryId === category.id} className={`min-h-10 shrink-0 rounded-full border px-4 text-sm font-bold ${categoryId === category.id ? 'border-[var(--brand)] bg-[var(--brand)] text-white' : 'border-[var(--line)] bg-white text-[var(--muted)]'}`}>{category.name}</button>
            ))}
          </div>
        )}
        <ul className="grid gap-3">
          {visibleServices.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                data-testid={`service-${s.id}`}
                onClick={() => { setServiceId(s.id); setAddonIds([]); }}
                aria-pressed={serviceId === s.id}
                className="choice-card flex min-h-[82px] w-full items-center justify-between gap-4 rounded-2xl border border-[var(--line)] px-5 py-4 text-left"
              >
                <span className="flex min-w-0 items-center gap-4">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--brand-soft)] text-lg font-bold text-[var(--brand)]" aria-hidden="true">✦</span>
                  <span className="min-w-0">
                    <span className="block font-bold">{s.name}</span>
                    <span className="mt-1 block text-sm text-[var(--muted)]">{s.description || `${duration(s.durationMin)} appointment`}</span>
                  </span>
                </span>
                <span className="shrink-0 text-right"><span className="block font-bold">{money(s.priceCents, shop.currency)}</span><span className="text-sm text-[var(--muted)]">{duration(s.durationMin)}</span></span>
              </button>
            </li>
          ))}
        </ul>
        {service && catalog.addons.length > 0 && (
          <div className="mt-5">
            <h3 className="text-base font-bold"> {t("Enhance your service")} </h3>
            <p className="mt-1 text-sm text-[var(--muted)]"> {t("Personalize your visit with add-ons.")} </p>
            <ul className="mt-2 grid gap-2">
              {catalog.addons.map((a) => {
                const on = addonIds.includes(a.id);
                return (
                  <li key={a.id}>
                    <button
                      type="button"
                      data-testid={`addon-${a.id}`}
                      onClick={() => setAddonIds((ids) => on ? ids.filter((id) => id !== a.id) : [...ids, a.id])}
                      aria-pressed={on}
                      className="choice-card flex min-h-14 w-full items-center justify-between rounded-xl border border-[var(--line)] px-4 text-left"
                    >
                      <span className="flex items-center gap-3"><span className={`grid h-5 w-5 place-items-center rounded-md border text-xs ${on ? 'border-[var(--brand)] bg-[var(--brand)] text-white' : 'border-[var(--line-strong)]'}`}>{on ? '✓' : ''}</span>{a.name}</span>
                      <span className="text-sm text-[var(--muted)]">+{duration(a.durationMin)} · {money(a.priceCents, shop.currency)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="mt-4 rounded-xl bg-[#f7f9fa] px-4 py-3 text-sm font-semibold text-[var(--muted)]" data-testid="totals">
              {t('step.total', 'Total')} {duration(mins)} · {money(cents, shop.currency)}
            </p>
          </div>
        )}
      </Card>
      <Dock>
        <Btn primary disabled={!serviceId} onClick={() => serviceId && onPick(serviceId, addonIds)}>
          {t('btn.next', 'Continue')}
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
  const { t } = useLanguage();
  if (busy && staff.length === 0) return <Card><Loading /></Card>;
  if (staff.length === 0) {
    return (
      <>
        <CallShop shop={shop}> {t("No specialists are available online")} </CallShop>
        <Dock><Btn onClick={onBack}>{t('btn.back', 'Back')}</Btn></Dock>
      </>
    );
  }
  return (
    <>
      <div className="mb-6">
        <p className="step-kicker"> {t("Step 2 of 4")} </p>
        <h2 className="text-3xl font-extrabold tracking-[-0.035em]">{t('step.selectSpecialist', 'Choose a specialist')}</h2>
        <p className="mt-2 text-[var(--muted)]"> {t("Choose who you would like to see, or let us match you with the first available specialist.")} </p>
      </div>
      <Card>
        <ul className="grid gap-3 sm:grid-cols-2">
          <li>
            <button type="button" data-testid="staff-any" onClick={() => onPick(null)}
              className="choice-card flex min-h-[88px] w-full items-center gap-4 rounded-2xl border border-[var(--line)] px-4 text-left">
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-[var(--brand-soft)] text-lg font-bold text-[var(--brand)]">◎</span>
              <span><span className="block font-bold">{t('step.anySpecialist', 'Any available specialist')}</span><span className="mt-1 block text-sm text-[var(--muted)]"> {t("Best for the earliest time")} </span></span>
            </button>
          </li>
          {staff.map((s) => (
            <li key={s.id}>
              <button type="button" data-testid={`staff-${s.id}`} onClick={() => onPick(s.id)}
                className="choice-card flex min-h-[88px] w-full items-center gap-4 rounded-2xl border border-[var(--line)] px-4 text-left">
                {s.avatarUrl
                  ? <img className="h-12 w-12 shrink-0 rounded-full object-cover" src={s.avatarUrl} alt="" />
                  : <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-[#edf0f6] font-bold text-[#56647a]">{s.displayName.slice(0, 1).toUpperCase()}</span>}
                <span><span className="block font-bold">{s.displayName}</span><span className="mt-1 block text-sm text-[var(--muted)]"> {t("Specialist")} </span></span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <Dock><Btn onClick={onBack}>{t('btn.back', 'Back')}</Btn></Dock>
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
  const { t, locale } = useLanguage();
  const start = bookingToday(shop.timezone, shop.businessDayCutoff);
  const horizon = Math.max(1, shop.onlineBooking.maxDaysAhead);
  const [offset, setOffset] = useState(
    () => pageOffsetForDate(start, horizon, draft.date ?? start),
  );
  const days = datePage(start, horizon, offset);
  const selectedDate = draft.date ?? days[0] ?? start;
  const monthLabel = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${selectedDate}T12:00:00Z`));
  const slotGroups = [
    { key: 'morning', label: 'Morning', slots: (avail?.slots ?? []).filter((s) => slotPeriod(s.startsAt, shop.timezone) === 'morning') },
    { key: 'afternoon', label: 'Afternoon', slots: (avail?.slots ?? []).filter((s) => slotPeriod(s.startsAt, shop.timezone) === 'afternoon') },
    { key: 'evening', label: 'Evening', slots: (avail?.slots ?? []).filter((s) => slotPeriod(s.startsAt, shop.timezone) === 'evening') },
  ];
  return (
    <>
      <div className="mb-6">
        <p className="step-kicker"> {t("Step 3 of 4")} </p>
        <h2 className="text-3xl font-extrabold tracking-[-0.035em]">{t('step.selectTime', 'Pick a time')}</h2>
        <p className="mt-2 text-[var(--muted)]"> {t("Choose a date and available appointment time.")} </p>
      </div>
      <Card>
        <p className="mb-4 text-xs text-[var(--muted)]">{shop.timezone.replace(/_/g,' ')}</p><DateChooser date={draft.date??start} onDate={onDate} start={start} horizon={horizon}/>
        {busy ? <Loading /> : (
          <div className="mt-6 grid gap-6" data-testid="slots">
            {slotGroups.filter((group) => group.slots.length > 0).map((group) => (
              <section key={group.key}>
                <div className="mb-3 flex items-center gap-3"><h4 className="text-sm font-bold">{t(group.label)}</h4><span className="h-px flex-1 bg-[var(--line)]" /></div>
                <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  {group.slots.map((s) => (
                    <li key={s.startsAt}>
                      <button type="button" data-testid={`slot-${s.startsAt}`} onClick={() => onSlot(s.startsAt)}
                        className="min-h-11 w-full rounded-xl border border-[var(--line-strong)] bg-white font-semibold transition hover:border-[var(--brand)] hover:bg-[var(--brand-soft)] hover:text-[var(--brand-dark)]">
                        {timeOf(s.startsAt, shop.timezone)}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
        {!busy && avail && avail.slots.length === 0 && (
          <Note> {t("No times on this day. Try the next available day, or call")} <PhoneLink shop={shop} />.</Note>
        )}
      </Card>
      <Dock><Btn onClick={onBack}>{t('btn.back', 'Back')}</Btn></Dock>
    </>
  );
}

function slotPeriod(startsAt: string, timezone: string): 'morning' | 'afternoon' | 'evening' {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    hour: '2-digit', hourCycle: 'h23', timeZone: timezone,
  }).format(new Date(startsAt)));
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

export interface BookingContact {name:string;phone:string;email:string;notes:string;smsOptIn:boolean;bookingSmsConsent?:boolean}

export function ConfirmStep({
  shop, service, addons, bundle, startsAt, staffId, openedAt, onSubmit, onBack, onRefreshQuote,party, initialContact, onContactChange, onReviewChange, appointmentSummary, notesMaxLength = 500,
}: {
  shop: Shop;
  service: Service | null;
  addons: Service[];
  appointmentSummary?:ReactNode;
  notesMaxLength?: number;
  initialContact?: BookingContact;
  onContactChange?: (value:BookingContact)=>void;
  onReviewChange?: (value:boolean)=>void;
  onRefreshQuote?:()=>Promise<void>;
  party?: { items: BookInput["items"]; partySize: number; priceCents: number; durationMin: number };
  /** 组合套餐（U10）。传了就走 bundleSelections，不传走单项 items。 */
  bundle?: { id: string; version?: number; name: string; priceCents: number; originalTotalCents: number; durationMin: number };
  startsAt: string;
  staffId: string | null;
  openedAt: number;
  onSubmit: (input: BookInput) => Promise<void>;
  onBack: () => void;
}) {
  const { t, locale } = useLanguage();
  const [reviewing, setReviewing] = useState(false);
  const [name, setName] = useState(initialContact?.name ?? '');
  const [phone, setPhone] = useState(initialContact?.phone ?? '');
  const [email, setEmail] = useState(initialContact?.email ?? '');
  const [notes, setNotes] = useState(initialContact?.notes ?? '');
  const [smsOptIn] = useState(false);
  const [bookingSmsConsent,setBookingSmsConsent]=useState(initialContact?.bookingSmsConsent ?? false);
  const [depositAccepted,setDepositAccepted]=useState(false);
  const [quoteRefreshNeeded,setQuoteRefreshNeeded]=useState(false);
  const [website, setWebsite] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [botErr, setBotErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);
  const tsApi = useRef<TurnstileApi | null>(null);
  const inflight = useRef(false);
  useEffect(()=>{onContactChange?.({name,phone,email,notes,smsOptIn,bookingSmsConsent});},[name,phone,email,notes,smsOptIn,bookingSmsConsent,onContactChange]);
  useEffect(()=>{onReviewChange?.(reviewing);},[reviewing,onReviewChange]);

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

  const mins = party ? party.durationMin : bundle
    ? bundle.durationMin
    : (service?.durationMin ?? 0) + addons.reduce((n, a) => n + a.durationMin, 0);
  const cents = party ? party.priceCents : bundle
    ? bundle.priceCents
    : (service?.priceCents ?? 0) + addons.reduce((n, a) => n + a.priceCents, 0);
  const needsDeposit=shop.onlineBooking.depositRequired===true;
  let depositAmountCents:number|null=null;
  try{if(needsDeposit)depositAmountCents=quoteAppointmentDeposit(cents,shop.onlineBooking.depositMethod==='percentage'
    ?{percentBps:shop.onlineBooking.depositPercentBps}:{fixedAmountCents:shop.onlineBooking.depositAmountCents??2000});}catch{}
  let guestDeposits:ReturnType<typeof allocateAppointmentDepositByGuest>|null=null;
  try{if(party&&party.partySize>1&&depositAmountCents&&party.items.every(i=>i.quotedPriceCents!==undefined))
    guestDeposits=allocateAppointmentDepositByGuest(party.partySize,party.items.map((i,index)=>({groupKey:String(index),priceCents:i.quotedPriceCents!,
      guestIndices:i.guestIndices??[i.guestIndex??0]})),depositAmountCents);}catch{}
  useEffect(()=>setDepositAccepted(false),[shop.onlineBooking.depositPolicyVersion,depositAmountCents,cents]);
  const depositReady=!quoteRefreshNeeded&&(!needsDeposit||Boolean(depositAmountCents&&shop.onlineBooking.depositPolicyVersion&&depositAccepted));
  const e164 = toE164(phone);
  const ready = notes.length <= notesMaxLength && name.trim().length > 0 && (!email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) && e164 !== null && (token !== null || !shop.turnstileSiteKey)&&depositReady;

  async function go() {
    if (!ready || inflight.current) return;
    if (party && !reviewing) { setReviewing(true); return; }
    inflight.current = true;
    setBusy(true); setErr(null);
    try {
      await onSubmit({
        turnstileToken: token ?? 'dev',
        locale,
        customer: {
          name: name.trim(),
          phone: e164!,
          ...(email.trim() ? { email: email.trim() } : {}),
          smsOptIn: false,
          bookingSmsConsent,
        },
        ...(party ? { items: party.items } : bundle
          ? { items: [], bundleSelections: [{ bundleId: bundle.id, startsAt, ...(bundle.version ? {expectedVersion:bundle.version} : {}) }] }
          : { items: [{ serviceId: service!.id, addonIds: addons.map((a) => a.id), staffId, startsAt }] }),
        partySize: party?.partySize ?? 1,
        ...(needsDeposit&&depositAmountCents&&shop.onlineBooking.depositPolicyVersion?{depositConsent:{accepted:true as const,
          policyVersion:shop.onlineBooking.depositPolicyVersion,serviceTotalCents:cents,amountCents:depositAmountCents}}:{}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        website,
        formElapsedMs: Date.now() - openedAt,
      });
    } catch (e) {
      setReviewing(false);
      setErr(confirmError(e, shop, t,locale));
      if(e instanceof ApiError&&['deposit_quote_changed','deposit_policy_consent_required'].includes(String(e.details.reason))){setDepositAccepted(false);setQuoteRefreshNeeded(true);}
      if (widgetId.current) { tsApi.current?.reset(widgetId.current); setToken(null); }
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }

  const displayName = party ? `${t('Guests')}: ${party.partySize} · ${t('Services')}: ${party.items.length}` : bundle ? bundle.name : (service?.name ?? '');

  return (
    <>
      <div className="mb-6">

        <h1 className="text-3xl font-semibold tracking-tight">{t(reviewing?'Review appointment':'Contact')}</h1>

      </div>
      <Card>
        {appointmentSummary}
        <div className={`${appointmentSummary?'hidden ':''}mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl bg-[var(--brand-soft)] px-4 py-3 text-sm text-[var(--brand-dark)]`}>
          <span className="font-bold">{dateOf(startsAt, shop.timezone,locale)} {t("at")} {timeOf(startsAt, shop.timezone,locale)}</span>
          <span aria-hidden="true">·</span><span>{displayName}</span><span aria-hidden="true">·</span><span>{duration(mins)}</span><span aria-hidden="true">·</span><span className="font-bold">{money(cents, shop.currency)}</span>
        </div>
        {reviewing && err && <Note warn>{err}</Note>}
        {reviewing && <div className="review-contact"><div className="summary-heading"><h2>{t('Contact')}</h2><Button variant="ghost" onPress={()=>setReviewing(false)}>{t('Edit contact')}</Button></div><p>{name}</p><p>{formatPhoneDisplay(phone)}</p>{email&&<p>{email}</p>}{notes&&<p className="whitespace-pre-wrap">{notes}</p>}</div>}
        {needsDeposit&&<section className="my-4 rounded-xl border border-[var(--line)] p-4 space-y-3" aria-label={depositText(locale,'required')}>
          {depositAmountCents&&shop.onlineBooking.depositPolicyVersion?<>
            <h2 className="font-semibold">{depositText(locale,'required')}: {money(depositAmountCents,shop.currency)}</h2>
            <p className="text-sm">{depositText(locale,'remaining')}: {money(cents-depositAmountCents,shop.currency)}</p>
            {guestDeposits&&<div className="text-sm"><h3 className="font-medium">{depositText(locale,'guestAllocation')}</h3><ol>{guestDeposits.guests.map(g=><li key={g.guestIndex} className="flex justify-between gap-3"><span>{t('Guest')} {g.guestIndex+1}</span><span>{money(g.amountCents,shop.currency)}</span></li>)}</ol></div>}
            <p className="text-sm">{depositText(locale,'holdNotice')}</p>
            <p className="text-sm">{depositText(locale,'refundBefore').replace('{hours}',String(shop.onlineBooking.cancelCutoffHours))}</p>
            <p className="text-sm">{depositText(locale,shop.onlineBooking.retainDepositAfterCutoff?'lateRetain':'lateReview')}</p>
            {shop.onlineBooking.cancellationPolicyNotice&&<p className="text-sm whitespace-pre-wrap">{shop.onlineBooking.cancellationPolicyNotice}</p>}
            <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={depositAccepted} onChange={e=>setDepositAccepted(e.target.checked)}/>{depositText(locale,'acknowledge')}</label>
          </>:<Note warn>{depositText(locale,'unavailable')}</Note>}
        </section>}
        {quoteRefreshNeeded&&onRefreshQuote&&<Btn disabled={busy} onClick={()=>{
          setBusy(true);void onRefreshQuote().catch(()=>setErr(t('Something went wrong. Please try again or contact the shop.'))).finally(()=>setBusy(false));
        }}>{t('Try again')}</Btn>}
        <div className={`mt-4 grid gap-3 ${reviewing ? 'hidden' : ''}`}>
          <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-semibold"> {t("Name")} <Input className="field-control mt-2" value={name}
              autoComplete="name" maxLength={120} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="text-sm font-semibold"> {t("Mobile phone")} <PhoneInput className="field-control mt-2" value={phone}
              inputMode="tel" autoComplete="tel" placeholder="(617) 555-0199"
              onChange={(e) => setPhone(e.target.value)} />
          </label>
          </div>
          <label className="text-sm font-semibold"> {t("Email")} <Input className="field-control mt-2" value={email}
              type="email" autoComplete="email" maxLength={200} onChange={(e) => setEmail(e.target.value)} />
            <span className="field-hint">{t('Get your confirmation and appointment details by email.')}</span>
          </label>
          <label className="text-sm font-semibold"> {t("Notes")} <TextArea className="field-control mt-2 min-h-24 resize-y py-3" value={notes}
              maxLength={notesMaxLength} placeholder={t("Share any preferences or requests for your visit.")}
              onChange={(e) => setNotes(e.target.value)} />
          </label>
          {notes.length > notesMaxLength && <Note warn>{t("Please shorten your notes to continue.")}</Note>}
          <div className="booking-sms-consent">
            <Checkbox aria-label={t("Receive appointment texts")} isSelected={bookingSmsConsent} onChange={setBookingSmsConsent}>
              <Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control><span>{t("Send me booking confirmations, updates and reminders from")} {shop.name} {t("via GenieFront SMS.")}</span></Checkbox.Content>
            </Checkbox>
            <p>{t("Message frequency varies. Msg & data rates may apply. Reply STOP to opt out or HELP for help.")}</p>
          </div>
          <p className="booking-legal">{t("By booking, you agree to")} <a href="https://geniefront.com/terms/" target="_blank" rel="noreferrer">{t("Terms")}</a> {t("and")} <a href="https://geniefront.com/privacy/" target="_blank" rel="noreferrer">{t("Privacy")}</a>. <a href="https://geniefront.com/sms/" target="_blank" rel="noreferrer">GenieFront SMS</a>.</p>
          <input className="hp" tabIndex={-1} autoComplete="off" aria-hidden="true"
            name="website" value={website} onChange={(e) => setWebsite(e.target.value)} />
          {shop.turnstileSiteKey && <div ref={boxRef} data-testid="turnstile" className="min-h-[66px]" />}
          {botErr && <Note warn> {t("Security check failed. Refresh and try again.")} </Note>}
          {err && <Note warn>{err}</Note>}
        </div>
      </Card>
      <Dock>
        <Btn onClick={() => reviewing ? setReviewing(false) : onBack()} disabled={busy}>{t('btn.back', 'Back')}</Btn>
        <Btn primary disabled={!ready || busy} onClick={() => void go()}>
          {busy ? <span className="spin" /> : party && !reviewing ? t('Review appointment') : t('btn.book', 'Book appointment')}
        </Btn>
      </Dock>
    </>
  );
}

function confirmError(e: unknown, _shop: Shop, t:(key:string)=>string,locale:string): string {
  if (!(e instanceof ApiError)) return t('Something went wrong. Please try again or contact the shop.');
  const reason = String(e.details['reason'] ?? '');
  if(reason==='deposit_quote_changed'||reason==='deposit_policy_consent_required')return depositText(locale,'quoteChanged');
  if (reason === 'bot_check_failed') return t('Security check failed. Please try again.');
  if (e.isRateLimited) return t('Too many attempts. Please wait and try again or contact the shop.');
  if (reason === 'too_soon') return t('That time is too soon. Please contact the shop.');
  if (reason === 'too_many_upcoming') return t('You already have several upcoming appointments. Please contact the shop.');
  if (e.status === 0) return t('Network problem. Check your connection and try again.');
  return t('We could not complete this booking. Please try again or contact the shop.');
}

export function SuccessStep({
  shop, slug, done, onAgain, showSummary=false, children, calendarUrl,
}: {
  shop: Shop;
  slug: string;
  done: { bookingId: string; manageToken: string | null; summary?:ManagedBooking;status?:string };
  onAgain: () => void;
  showSummary?:boolean;
  children?:ReactNode;
  calendarUrl?:string;
}) {
  const { t,locale } = useLanguage();
  const paymentQuery=useQuery({queryKey:['booked-deposit',slug,done.bookingId,done.manageToken,locale],
    enabled:Boolean(done.summary?.deposit&&done.manageToken),retry:false,
    queryFn:()=>loadManagedBooking(slug,done.manageToken!,locale),
    refetchInterval:q=>['pending','refund_pending'].includes(q.state.data?.booking.deposit?.status??done.summary?.deposit?.status??'')?5000:false});
  const summary=paymentQuery.data?.booking??done.summary,deposit=summary?.deposit;
  const appointmentStatus=summary?.status??done.status;
  const reportedDeposit=useRef<string|null>(null);
  useEffect(()=>{
    if(done.summary?.deposit?.status==='pending'&&deposit?.status==='paid'&&appointmentStatus==='booked'&&reportedDeposit.current!==done.bookingId){
      reportedDeposit.current=done.bookingId;reportBooked();
    }
  },[done.bookingId,done.summary?.deposit?.status,deposit?.status,appointmentStatus]);
  const awaiting=deposit&&['pending','expired','cancelled','review'].includes(deposit.status);
  const notConfirmed=Boolean(awaiting||appointmentStatus==='cancelled'||appointmentStatus==='no_show');
  const headline=deposit&&notConfirmed?depositText(locale,(appointmentStatus==='cancelled'&&deposit.status==='paid'?'cancelled':deposit.status) as 'pending'|'expired'|'cancelled'|'review'|'refund_pending'|'refunded'):
    appointmentStatus&&appointmentStatus!=='booked'?t(appointmentStatus==='done'?'completed':appointmentStatus):t('step.booked','You are booked');
  return (
    <section className="confirmation-page">
      <header className="appointment-hero">
        <span className="confirmation-check" aria-hidden="true">{notConfirmed?'…':'✓'}</span>
        <p className="appointment-eyebrow">{notConfirmed?headline:t("Appointment confirmed")}</p>
        <h1>{headline}</h1>
        {!notConfirmed&&<p>{t("We look forward to seeing you.")}</p>}
      </header>
      <div className="confirmation-details">
        {children}
        {deposit&&summary&&<AppointmentDeposit deposit={deposit} serviceCents={summary.priceCents} timezone={shop.timezone}/>}
        {showSummary && done.summary && <Card><h2 className="summary-date">{dateOf(done.summary.startsAt,shop.timezone)}</h2><p>{timeOf(done.summary.startsAt,shop.timezone)}</p>{done.summary.items.map((item,index)=><p className="mt-3" key={index}>{item.name} · {money(item.priceCents,shop.currency)}</p>)}<div className="bag-total"><span>{t('Total')}</span><strong>{money(done.summary.priceCents,shop.currency)}</strong></div></Card>}
      </div>
      <div className="confirmation-actions">
        {done.manageToken && <Link className="appointment-primary-link" to={hostedManagePath(slug, done.manageToken)} target={isEmbedded()?'_blank':undefined} rel="noreferrer">{t("Edit appointment")} <span aria-hidden="true">→</span></Link>}
        {calendarUrl && !notConfirmed && <a className="appointment-secondary-link" href={calendarUrl} download="appointment.ics">{t("Add to calendar")} <span aria-hidden="true">↗</span></a>}
      </div>
      <p className="appointment-help">{t("Keep this page to manage your appointment.")}</p>
      <div className="appointment-footer-actions"><button type="button" onClick={onAgain}>{t("Book another")}</button>{shop.phone && <span>{t("Questions? Call")} <PhoneLink shop={shop} /></span>}</div>
    </section>
  );
}
