import { Button, Input, Chip } from "@heroui/react";
import { DateChooser, BookingDialog, Choice } from "../components/BookingUI";
import { calendarHref } from "../lib/calendar";
import { formatPhoneDisplay } from "@gf/contracts/phone";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import {
  ApiError,
  cancelManagedBooking,
  cancelManagedGuests,
  getHostedShop,
  getManagedAvailability,
  loadManagedBooking,
  rescheduleManagedBooking,
  setPublicKey,
  type Availability,
  type ManagedBooking,
  type Shop,
} from "../lib/api";
import {
  bookableDateCount,
  bookingToday,
  dateOf,
  datePage,
  DAY_PAGE,
  duration,
  money,
  pageOffsetForDate,
  timeOf,
} from "../lib/format";
import {
  Btn,
  Card,
  Loading,
  Note,
  PhoneLink,
  Shell,
  Topbar,
} from "../components/Chrome";
import { manageTokenFromHash } from "../lib/manageToken";
import { useLanguage } from "../lib/i18n";
import {AppointmentDeposit} from '../components/AppointmentDeposit';
import {AppointmentCancelGuests,depositText,depositAdjustmentText,type DepositAdjustmentQuote} from '@gf/contracts';

type View = "detail" | "reschedule" | "cancel" | "cancel-guests";

export function ManageBookingPage() {
  const { slug, token: pathToken } = useParams();
  const location = useLocation();
  const { t, locale } = useLanguage();
  const token = pathToken || manageTokenFromHash(location.hash);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  useEffect(() => {
    let robots = document.querySelector('meta[name="robots"]');
    if (!robots) {
      robots = document.createElement("meta");
      robots.setAttribute("name", "robots");
      document.head.appendChild(robots);
    }
    robots.setAttribute("content", "noindex,nofollow");
    let referrer = document.querySelector('meta[name="referrer"]');
    if (!referrer) {
      referrer = document.createElement("meta");
      referrer.setAttribute("name", "referrer");
      document.head.appendChild(referrer);
    }
    referrer.setAttribute("content", "no-referrer");
  }, []);

  const shopQuery = useQuery({
    queryKey: ["hosted-shop", slug, locale],
    enabled: Boolean(slug),
    queryFn: async () => {
      const s = await getHostedShop(slug!, locale);
      if (s.publicKey) setPublicKey(s.publicKey);
      document.title = `${s.name} · Appointment`;
      return s;
    },
  });

  const detailQuery = useQuery({
    queryKey: ["managed-booking", slug, token, locale],
    enabled: Boolean(slug && token),
    retry: false,
    refetchInterval: (query) =>['pending','refund_pending'].includes(query.state.data?.booking.deposit?.status??'')?5000:
      query.state.data?.booking.status === "booked" ? 30000 : false,
    queryFn: async () => {
      const out = await loadManagedBooking(slug!, tokenRef.current, locale);
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
    return (
      <Shell>
        <Loading />
      </Shell>
    );
  }
  if(detailQuery.isError&&(!(detailQuery.error instanceof ApiError)||detailQuery.error.status===0
    ||detailQuery.error.status>=500||detailQuery.error.status===429)){
    return <Shell>{shop?<Topbar shop={shop} step={null}/>:null}<Card>
      <h1 className="text-xl font-bold">{t('Your appointment could not be loaded')}</h1>
      <Note warn>{t('Check your connection and try again.')}</Note>
      <Btn disabled={detailQuery.isFetching} onClick={()=>{void detailQuery.refetch();void shopQuery.refetch();}}>{t('Try again')}</Btn>
    </Card></Shell>;
  }
  if (detailQuery.isError || !booking || !shop) {
    return <GenericMissing shop={shop} />;
  }

  return (
    <Shell>
      <Topbar shop={shop} step={null} />
      <div className="manage-layout">
        <ManageBody
          key={booking.bookingId}
          shop={shop}
          booking={booking}
          token={token}
          slug={slug}
        />
      </div>
    </Shell>
  );
}

function GenericMissing({ shop }: { shop: Shop | null }) {
  const { t } = useLanguage();
  return (
    <Shell>
      <Card>
        <h1 className="text-xl font-bold">
          {" "}
          {t("This appointment link is not available")}{" "}
        </h1>
        <p className="mt-3 text-[var(--muted)]">
          {shop?.phone ? (
            <>
              {" "}
              {t("Call")} <PhoneLink shop={shop} />{" "}
              {t("if you need help.")}{" "}
            </>
          ) : (
            t("Please contact the shop if you need help.")
          )}
        </p>
      </Card>
    </Shell>
  );
}

export function ManageBody({
  shop,
  booking,
  token,
  slug,
}: {
  shop: Shop;
  booking: ManagedBooking;
  token: string;
  slug: string;
}) {
  const queryClient = useQueryClient();
  const { t, locale } = useLanguage();
  const [view, setView] = useState<View>("detail");
  const [last4, setLast4] = useState("");
  const [verified, setVerified] = useState(false);
  const [gateErr, setGateErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mutable = booking.actions.canCancel || booking.actions.canReschedule;

  async function refresh() {
    await queryClient.invalidateQueries({
      queryKey: ["managed-booking", slug],
    });
  }

  return (
    <>
      <header className="appointment-hero manage-hero">
        <p className="appointment-eyebrow">{shop.name}</p>
        <h1>{t("Your appointment")}</h1>
        <p>{t("View your booking or make a change below.")}</p>
      </header>
      <div className="manage-columns">

      {view !== "reschedule" && (
        <Card className="managed-summary">
          <div className="managed-card-top">
            {!booking.deposit||!['pending','expired','cancelled','review'].includes(booking.deposit.status)?<StatusBadge status={booking.status}/>:null}
          </div>
          <h2 className="managed-when" data-testid="when">
            {dateOf(booking.startsAt, booking.timezone, locale)}
            <br />
            {timeOf(booking.startsAt, booking.timezone, locale)}
          </h2>
          <p className="text-xs text-[var(--muted)]">
            {booking.timezone.replace(/_/g, " ")}
          </p>
          <ul className="managed-services">
            {booking.items.map((item, i) => (
              <li key={i} className={item.status==='cancelled'?'opacity-65':''}>
                <div>
                  <strong>
                    {booking.items.some((it) => (it.guestIndex ?? 0) > 0 || (it.guestIndices?.length ?? 1) > 1)
                      ? (item.guestIndices ?? [item.guestIndex ?? 0]).map(g => `${t("Guest")} ${g + 1}`).join(" + ") + " · "
                      : ""}
                    {item.name}{item.status==='cancelled'&&<span className="ml-2 text-xs font-normal">{depositText(locale,'guestCancelled')}</span>}
                  </strong>
                  <p>
                    {timeOf(item.startsAt, booking.timezone, locale)}–
                    {timeOf(item.endsAt, booking.timezone, locale)}
                    {item.specialistName && ` · ${item.specialistName}`}
                  </p>
                  {item.addonNames.length > 0 && (
                    <p>{item.addonNames.join(" · ")}</p>
                  )}
                </div>
                <span className={item.status==='cancelled'?'line-through':''}>{money(item.priceCents, shop.currency)}</span>
              </li>
            ))}
          </ul>
          <div className="bag-total">
            <span>{duration(booking.durationMin)}</span>
            <strong>{money(booking.priceCents, shop.currency)}</strong>
          </div>
          {booking.deposit&&<AppointmentDeposit deposit={booking.deposit} serviceCents={booking.priceCents} timezone={booking.timezone}/>}
          {booking.status === "booked" && (!booking.deposit||['paid','refunded'].includes(booking.deposit.status)) && (
            <a
              className="subtle-link"
              href={calendarHref(booking, shop)}
              download="appointment.ics"
            >
              {t("Add to calendar")} ↗
            </a>
          )}
          <details className="mt-4 text-xs text-[var(--muted)]">
            <summary className="cursor-pointer">{t("Booking policy")}</summary>
            <p className="mt-3">
              {t(
                "Online rescheduling and cancellation apply to the entire booking, including every guest. To change services, specialists, guest count or contact information, contact the shop.",
              )}
            </p>
            <p className="mt-3">{t("Within 15 minutes of booking, before your appointment starts, advance-notice limits do not apply to cancellation or rescheduling.")}</p>
            <p className="mt-3">
              {t("After that:")} {t("Cancel at least")} {booking.policy.cancelCutoffHours}{" "}
              {t("hours ahead.")}{" "}
              {booking.policy.rescheduleEnabled
                ? `${t("Reschedule at least")} ${booking.policy.rescheduleCutoffHours} ${t("hours ahead.")}`
                : t("Online rescheduling is off.")}
            </p>
          </details>
          {booking.actions.reason && !booking.actions.canReschedule && (
            <Note>{reasonCopy(booking.actions.reason, shop, t)}</Note>
          )}
        </Card>
      )}

      {view === "detail" && (
        <div className="manage-controls">
          {mutable && !verified && (
            <Last4Form
              last4={last4}
              setLast4={setLast4}
              err={gateErr}
              onSubmit={() => {
                setVerified(true);
                setGateErr(null);
              }}
            />
          )}
          {mutable && verified && (
            <Card className="manage-action-card">
              <h2>{t("Edit appointment")}</h2>
              <p className="appointment-help">{t("Choose what you would like to change.")}</p>
            <div className="booking-actions">
              {booking.actions.canReschedule && (
                <Btn primary onClick={() => setView("reschedule")}>
                  {t("btn.reschedule", "Reschedule")}
                </Btn>
              )}
              {booking.actions.canCancel && (
                <Btn onClick={() => setView("cancel")}>
                  {t("btn.cancel", "Cancel")}
                </Btn>
              )}
              {booking.guestCancellation?.enabled&&booking.guests&&(
                <Btn onClick={()=>setView('cancel-guests')}>{depositText(locale,'cancelGuests')}</Btn>
              )}
            </div>
            </Card>
          )}
          <p className="manage-contact-help">{t("To change services or contact details, call the shop.")} {shop.phone && <PhoneLink shop={shop} />}</p>
          {booking.actions.canRebook && (
            <Link
              className="booking-rebook"
              to={`/${slug}`}
            >
              {t("btn.bookAgain", "Book again")}
            </Link>
          )}
        </div>
      )}

      {view === "reschedule" && (
        <ReschedulePanel
          shop={shop}
          booking={booking}
          token={token}
          slug={slug}
          last4={last4}
          busy={busy}
          setBusy={setBusy}
          setGateErr={setGateErr}
          onBack={() => setView("detail")}
          onAuthFail={() => {
            setVerified(false);
            setView("detail");
          }}
          onDone={async () => {
            setView("detail");
            await refresh();
          }}
        />
      )}

      </div>
      {view === "cancel" && (
        <BookingDialog
          open
          onClose={() => {
            if (!busy) setView("detail");
          }}
          title={t("Cancel appointment")}
        >
          <CancelPanel
            shop={shop}
            booking={booking}
            token={token}
            last4={last4}
            busy={busy}
            setBusy={setBusy}
            setGateErr={setGateErr}
            onBack={() => setView("detail")}
            onAuthFail={() => {
              setVerified(false);
              setView("detail");
            }}
            onDone={async () => {
              setView("detail");
              await refresh();
            }}
          />
        </BookingDialog>
      )}
      {view==='cancel-guests'&&<BookingDialog open onClose={()=>{if(!busy)setView('detail');}} title={depositText(locale,'cancelGuests')}>
        <CancelGuestsPanel shop={shop} booking={booking} token={token} last4={last4} busy={busy} setBusy={setBusy}
          setGateErr={setGateErr} onBack={()=>setView('detail')} onAuthFail={()=>{setVerified(false);setView('detail');}}
          onDone={async()=>{setView('detail');await refresh();}} onRefresh={refresh}/>
      </BookingDialog>}
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useLanguage();
  const label = t((status==='done'?'completed':status).replace("_", " "));
  return (
    <span
      className="inline-block rounded-full bg-[var(--mint)] px-3 py-1 text-xs font-semibold uppercase tracking-wide text-[var(--brand-dark)]"
      data-testid="status"
    >
      {label}
    </span>
  );
}

function Last4Form({
  last4,
  setLast4,
  err,
  onSubmit,
}: {
  last4: string;
  setLast4: (v: string) => void;
  err: string | null;
  onSubmit: () => void;
}) {
  const { t, locale } = useLanguage();
  return (
    <form
      className="phone-verification booking-card"
      onSubmit={(e) => {
        e.preventDefault();
        if (/^\d{4}$/.test(last4)) onSubmit();
      }}
    >
      <div className="verification-icon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></svg></div>
      <h2>{t("Want to change your appointment?")}</h2>
      <p id="phone-check-help">{t("Enter the last 4 digits of the phone number you used to book. We will check them when you save a change or cancel.")}</p>
      <label className="phone-check-label">
        {t("Last 4 digits of your booking phone number")}
        <Input
          data-testid="last4"
          className="phone-check-input"
          aria-describedby="phone-check-help phone-check-example"
          placeholder="••••"
          inputMode="numeric"
          maxLength={4}
          autoComplete="off"
          value={last4}
          onChange={(e) =>
            setLast4(e.target.value.replace(/\D/g, "").slice(0, 4))
          }
        />
      </label>
      <p id="phone-check-example" className="phone-check-example">{t("Example: if you booked with (212) 555-1234, enter 1234. This is not a text message code.")}</p>
      {err && <div role="alert"><Note warn>{err}</Note></div>}
      <Btn primary type="submit" disabled={!/^\d{4}$/.test(last4)}>
        {" "}
        {t("Continue to edit")}{" "}
      </Btn>
    </form>
  );
}

function CancelPanel({
  shop,
  booking,
  token,
  last4,
  busy,
  setBusy,
  setGateErr,
  onBack,
  onAuthFail,
  onDone,
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
  const { t, locale } = useLanguage();
  const [err, setErr] = useState<string | null>(null);
  async function go() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await cancelManagedBooking(
        booking.bookingId,
        token,
        last4,
        shop.publicKey,
      );
      await onDone();
    } catch (e) {
      applyGate(e, setGateErr, setErr, shop, onAuthFail, t);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="mt-5">
      <h2 className="text-xl font-bold"> {t("Cancel this appointment?")} </h2>
      <p className="mt-2 text-sm text-[var(--muted)]">
        {" "}
        {t("Within 15 minutes of booking, before your appointment starts, advance-notice limits do not apply to cancellation or rescheduling.")} {t("After that:")} {t("Cancellations must be at least")} {booking.policy.cancelCutoffHours}{" "}
        {t(
          "hours before the start time. This cancels every service for every guest in this booking. This cannot be undone online.",
        )}{" "}
      </p>
      {err && <Note warn>{err}</Note>}
      <div className="booking-actions mt-4">
        <Btn onClick={onBack} disabled={busy}>
          {" "}
          {t("Keep appointment")}{" "}
        </Btn>
        <Btn primary onClick={() => void go()} disabled={busy}>
          {" "}
          {t("Confirm cancellation")}{" "}
        </Btn>
      </div>
    </Card>
  );
}

function CancelGuestsPanel({shop,booking,token,last4,busy,setBusy,setGateErr,onBack,onAuthFail,onDone,onRefresh}:{
  shop:Shop;booking:ManagedBooking;token:string;last4:string;busy:boolean;setBusy:(v:boolean)=>void;setGateErr:(v:string|null)=>void;
  onBack:()=>void;onAuthFail:()=>void;onDone:()=>Promise<void>;onRefresh:()=>Promise<void>;
}){
  const {t,locale}=useLanguage();
  const text=(key:Parameters<typeof depositText>[1])=>depositText(locale,key);
  type Financial=Omit<typeof AppointmentCancelGuests.input._type,'appointmentId'>;
  type Saved={financial:Financial;requestId:string;quote?:DepositAdjustmentQuote};
  const storage=`gf-managed-deposit-cancel:${booking.bookingId}`;
  const load=():Saved|null=>{try{const raw=JSON.parse(sessionStorage.getItem(storage)??'null'),parsed=AppointmentCancelGuests.input.safeParse({appointmentId:booking.bookingId,...raw?.financial});
    if(!parsed.success||typeof raw.requestId!=='string'||!/^[0-9a-f-]{36}$/i.test(raw.requestId))return null;
    const {appointmentId,...financial}=parsed.data;return {financial,requestId:raw.requestId,...(raw.quote?{quote:raw.quote}:{})};}catch{return null;}};
  const [pending,setPending]=useState(load),[selected,setSelected]=useState<number[]>(()=>load()?.financial.guestIndices??[]),[reason,setReason]=useState(()=>load()?.financial.reason??''),[err,setErr]=useState<string|null>(null);
  const [quote,setQuote]=useState<DepositAdjustmentQuote|null>(()=>load()?.quote??null),[accepted,setAccepted]=useState(()=>!!load()?.financial.depositAdjustment);
  const running=useRef(false),guests=booking.guests??[];
  const [online,setOnline]=useState(()=>navigator.onLine);
  useEffect(()=>{const update=()=>setOnline(navigator.onLine);window.addEventListener('online',update);window.addEventListener('offline',update);return()=>{window.removeEventListener('online',update);window.removeEventListener('offline',update);};},[]);
  const adjustment=(key:Parameters<typeof depositAdjustmentText>[1])=>depositAdjustmentText(locale,key);
  const guestMoney=(value:number)=>new Intl.NumberFormat(locale,{style:'currency',currency:booking.guestCancellation?.currency??shop.currency}).format(value/100);
  const refund=pending?.financial.expectedRefundCents??guests.filter(g=>selected.includes(g.guestIndex)).reduce((n,g)=>n+(g.refundableDepositCents??0),0);
  const shared=booking.items.some(item=>item.status!=='cancelled'&&(item.guestIndices??[item.guestIndex??0]).some(g=>selected.includes(g))
    &&(item.guestIndices??[item.guestIndex??0]).some(g=>!selected.includes(g)));
  const enabled=online&&!busy&&(!!pending||booking.guestCancellation?.enabled&&selected.length>0&&!shared&&reason.trim().length>=2&&(!quote||accepted));
  async function go(){
    if(!enabled||running.current)return;
    const financial:Financial=pending?.financial??{guestIndices:[...selected].sort((a,b)=>a-b),reason:reason.trim(),expectedRefundCents:refund,
      ...(quote&&accepted?{depositAdjustment:{accepted:true,quoteHash:quote.quoteHash}}:{})};
    const request:Saved=pending??{financial,requestId:crypto.randomUUID(),...(quote?{quote}:{})};
    running.current=true;setBusy(true);setErr(null);
    try{
      sessionStorage.setItem(storage,JSON.stringify(request));setPending(request);
      await cancelManagedGuests(booking.bookingId,{...request.financial,manageToken:token,last4,requestId:request.requestId},shop.publicKey);
      sessionStorage.removeItem(storage);setPending(null);await onDone();
    }catch(e){
      const notApplied=e instanceof ApiError&&e.details.notApplied===true&&e.details.reason==='deposit_quote_reconfirmation_required';
      if(notApplied||!pending&&e instanceof ApiError&&e.status>=400&&e.status<500){sessionStorage.removeItem(storage);setPending(null);}
      if((!pending||notApplied)&&e instanceof ApiError&&e.details.reason==='deposit_quote_reconfirmation_required'&&e.details.depositQuote){
        setQuote(e.details.depositQuote as DepositAdjustmentQuote);setAccepted(false);
      }else if(e instanceof ApiError&&e.details.reason==='deposit_guest_refund_quote_changed'){
        if(!pending){setQuote(null);setAccepted(false);}setErr(text('guestQuoteChanged'));await onRefresh();
      }else applyGate(e,setGateErr,setErr,shop,onAuthFail,t);
    }finally{running.current=false;setBusy(false);}
  }
  return <Card className="mt-5">
    {pending&&<p role="status" className="mb-3 text-sm">{adjustment('unknown')}</p>}
    <p className="mb-4 text-sm text-[var(--muted)]">{text('guestCancellationNotice')}</p>
    <fieldset disabled={!online||busy||!!pending} className="space-y-3"><legend className="mb-3 font-semibold">{text('selectGuests')}</legend>
      {guests.map(g=><label key={g.guestIndex} className="flex items-center gap-3 text-sm">
        <input type="checkbox" checked={selected.includes(g.guestIndex)} disabled={g.status==='cancelled'}
          onChange={e=>{setSelected(current=>e.target.checked?[...current,g.guestIndex]:current.filter(i=>i!==g.guestIndex));setQuote(null);setAccepted(false);}}/>
        <span className="flex-1">{text('guestLabel').replace('{n}',String(g.guestIndex+1))}{g.status==='cancelled'?` · ${text('guestCancelled')}`:''}</span>
        {g.status!=='cancelled'&&<span>{guestMoney(g.serviceTotalCents)}</span>}
      </label>)}
      <label className="block space-y-2"><span className="block">{text('guestCancellationReason')}</span><Input className="w-full" aria-label={text('guestCancellationReason')} value={reason}
        minLength={2} maxLength={500} required onChange={e=>setReason(e.target.value)}/></label>
    </fieldset>
    <p className="mt-4 font-medium">{text('guestRefund')}: {guestMoney(refund)}</p>
    {quote&&<section className="mt-4 space-y-3 rounded-xl border border-[var(--line)] p-3" aria-label={adjustment('title')}>
      <h3 className="font-semibold">{adjustment('title')}</h3>
      <dl className="space-y-2 text-sm">{(['serviceTotal','required','available','request','excess'] as const).map((key,i)=><div key={key} className="flex justify-between gap-3">
        <dt>{adjustment(key)}</dt><dd className="shrink-0">{guestMoney([quote.serviceTotalCents,quote.requiredCents,quote.availableCents,quote.requestCents,quote.excessCents][i]!)}</dd></div>)}</dl>
      {quote.requestCents>0&&<p className="text-sm">{adjustment(quote.hasConfirmedBooking?'supplementNotice':'replaceNotice')}</p>}
      {quote.expiresAt&&<p className="text-sm">{text('expires')}: {new Date(quote.expiresAt).toLocaleString(locale,{timeZone:booking.timezone,dateStyle:'medium',timeStyle:'short'})}</p>}
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={accepted} disabled={!online||busy||!!pending} onChange={e=>setAccepted(e.target.checked)}/><span>{adjustment('accept')}</span></label>
    </section>}
    {shared&&<Note warn>{text('sharedGuests')}</Note>}{err&&<div role="alert"><Note warn>{err}</Note></div>}
    <div className="booking-actions mt-4"><Btn onClick={onBack} disabled={busy||!!pending}>{t('Keep appointment')}</Btn>
      <Btn primary onClick={()=>void go()} disabled={!enabled}>{pending?adjustment('retry'):text('cancelGuests')}</Btn></div>
  </Card>;
}

function ReschedulePanel({
  shop,
  booking,
  token,
  slug,
  last4,
  busy,
  setBusy,
  setGateErr,
  onBack,
  onAuthFail,
  onDone,
}: {
  shop: Shop;
  booking: ManagedBooking;
  token: string;
  slug: string;
  last4: string;
  busy: boolean;
  setBusy: (v: boolean) => void;
  setGateErr: (v: string | null) => void;
  onBack: () => void;
  onAuthFail: () => void;
  onDone: () => Promise<void>;
}) {
  const { t, locale } = useLanguage();
  const [date, setDate] = useState(() =>
    bookingToday(booking.timezone, shop.businessDayCutoff),
  );
  const [avail, setAvail] = useState<
    (Availability & { canReschedule?: boolean; reason?: string | null }) | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());
  useEffect(() => {
    requestId.current = crypto.randomUUID();
  }, [picked]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setErr(null);
      setPicked(null);
      try {
        const a = await getManagedAvailability({
          slug,
          manageToken: token,
          date,
        });
        if (!alive) return;
        setAvail(a);
        if (a.canReschedule === false) {
          setErr(reasonCopy(a.reason ?? "shape_unsupported", shop, t));
        }
      } catch {
        if (alive) setErr(t("Could not load times. Please call the shop."));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [slug, token, date, shop]);

  async function go() {
    if (!picked || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await rescheduleManagedBooking(
        booking.bookingId,
        {
          manageToken: token,
          last4,
          startsAt: picked,
          requestId: requestId.current,
        },
        shop.publicKey,
      );
      await onDone();
    } catch (e) {
      if (e instanceof ApiError && e.isTaken) {
        setErr(t("That time was just booked. Please pick another slot."));
        setPicked(null);
        return;
      }
      applyGate(e, setGateErr, setErr, shop, onAuthFail, t);
    } finally {
      setBusy(false);
    }
  }

  const start = bookingToday(booking.timezone, shop.businessDayCutoff);
  const horizon = Math.max(1, shop.onlineBooking.maxDaysAhead);
  const [offset, setOffset] = useState(() =>
    pageOffsetForDate(start, horizon, date),
  );
  const days = datePage(start, horizon, offset);

  return (
    <Card className="reschedule-card">
      <div className="reschedule-current"><span>{t("Your appointment")}</span><strong>{dateOf(booking.startsAt, booking.timezone, locale)} · {timeOf(booking.startsAt, booking.timezone, locale)}</strong></div>
      <h2 className="text-xl font-bold"> {t("Pick a new time")} </h2>
      <p className="mt-2 text-xs text-[var(--muted)]">
        {booking.timezone.replace(/_/g, " ")}
      </p>
      <div className="mt-6">
        <DateChooser
          date={date}
          onDate={setDate}
          start={start}
          horizon={horizon}
        />
      </div>
      {loading ? (
        <Loading />
      ) : (
        <ul className="mt-4 grid grid-cols-3 gap-2">
          {(avail?.slots ?? []).map((s) => (
            <li key={s.startsAt}>
              <button
                type="button"
                data-testid={`reslot-${s.startsAt}`}
                onClick={() => setPicked(s.startsAt)}
                className={`min-h-12 w-full rounded-2xl border font-semibold ${
                  picked === s.startsAt
                    ? "border-[var(--brand)] bg-[var(--mint)]"
                    : "border-[var(--line)]"
                }`}
              >
                {timeOf(s.startsAt, booking.timezone, locale)}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!loading && !err && avail && avail.slots.length === 0 && <Note>{t("No times available for this date")}</Note>}
      {picked && (
        <Note>
          {" "}
          {t("Change the entire booking from")}{" "}
          {dateOf(booking.startsAt, booking.timezone, locale)}{" "}
          {timeOf(booking.startsAt, booking.timezone, locale)} {t("to")}{" "}
          {dateOf(picked, booking.timezone, locale)}{" "}
          {timeOf(picked, booking.timezone, locale)} {t(". Price stays")}{" "}
          {money(booking.priceCents, shop.currency)}.
        </Note>
      )}
      {err && <Note warn>{err}</Note>}
      <div className="booking-actions mt-4">
        <Btn onClick={onBack} disabled={busy}>
          {" "}
          {t("Back")}{" "}
        </Btn>
        <Btn primary disabled={!picked || busy} onClick={() => void go()}>
          {" "}
          {t("Confirm new time")}{" "}
        </Btn>
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
  t: (key: string) => string,
): void {
  if (!(e instanceof ApiError)) {
    setErr(t("Something went wrong. Please try again or contact the shop."));
    return;
  }
  const reason = String(e.details["reason"] ?? "");
  if (reason === "last4_mismatch") {
    setGateErr(
      `${t("That number did not match.")} ${e.details["attemptsLeft"] ?? 0} ${t("attempts left.")}`,
    );
    onBack();
    return;
  }
  if (reason === "last4_locked") {
    setGateErr(
      t("Too many attempts. Please wait 15 minutes or call the shop."),
    );
    onBack();
    return;
  }
  if (reason === "not_mutable" || reason === "already_cancelled") {
    setErr(t("This appointment can no longer be changed online."));
    return;
  }
  if (
    reason === "cancel_cutoff_passed" ||
    reason === "reschedule_cutoff_passed" ||
    reason === "cutoff_passed"
  ) {
    setErr(
      t("It is too close to the appointment time. Please contact the shop."),
    );
    return;
  }
  if (reason === "reschedule_disabled") {
    setErr(t("Online rescheduling is off."));
    return;
  }
  if (reason === "reschedule_limit_reached") {
    setErr(
      t(
        "This booking has already been rescheduled the maximum number of times. Please contact the shop.",
      ),
    );
    return;
  }
  setErr(t("Something went wrong. Please try again or contact the shop."));
}

function reasonCopy(
  reason: string,
  _shop: Shop,
  t: (key: string) => string,
): string {
  if (
    [
      "cutoff_passed",
      "cancel_cutoff_passed",
      "reschedule_cutoff_passed",
    ].includes(reason)
  )
    return t(
      "It is too close to the appointment time. Please contact the shop.",
    );
  if (reason === "reschedule_limit_reached")
    return t(
      "This booking has already been rescheduled the maximum number of times. Please contact the shop.",
    );
  if (reason === "reschedule_disabled") return t("Online rescheduling is off.");
  if (reason === "not_mutable")
    return t("This appointment can no longer be changed online.");
  if (reason === "shape_unsupported")
    return t(
      "This appointment cannot be rescheduled online. Please contact the shop.",
    );
  return t("Please call the shop if you need to make a change.");
}
