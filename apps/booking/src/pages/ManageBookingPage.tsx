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

type View = "detail" | "reschedule" | "cancel";

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
    refetchInterval: (query) =>
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
            <StatusBadge status={booking.status} />
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
              <li key={i}>
                <div>
                  <strong>
                    {booking.items.some((it) => (it.guestIndex ?? 0) > 0 || (it.guestIndices?.length ?? 1) > 1)
                      ? (item.guestIndices ?? [item.guestIndex ?? 0]).map(g => `${t("Guest")} ${g + 1}`).join(" + ") + " · "
                      : ""}
                    {item.name}
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
                <span>{money(item.priceCents, shop.currency)}</span>
              </li>
            ))}
          </ul>
          <div className="bag-total">
            <span>{duration(booking.durationMin)}</span>
            <strong>{money(booking.priceCents, shop.currency)}</strong>
          </div>
          {booking.status === "booked" && (
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
            <p className="mt-3">
              {t("Cancel at least")} {booking.policy.cancelCutoffHours}{" "}
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
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useLanguage();
  const label = t(status.replace("_", " "));
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
        {t("Cancellations must be at least")} {booking.policy.cancelCutoffHours}{" "}
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
