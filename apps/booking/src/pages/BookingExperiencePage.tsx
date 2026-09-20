import { formatPhoneDisplay } from "@gf/contracts/phone";
import { hourPeriods } from "@gf/scheduling";
import { ServiceImage } from "../components/ServiceImage";
import { Button, Input, Avatar, Popover } from "@heroui/react";
import { Stepper } from "@heroui-pro/react/stepper";
import { NumberStepper } from "@heroui-pro/react/number-stepper";
import { Sheet } from "@heroui-pro/react/sheet";
import { BookingDialog, DateChooser, Choice } from "../components/BookingUI";
import { ServiceCustomizer } from "../components/ServiceCustomizer";
import { groupServices, type ServiceGroup } from "../lib/serviceGroups";
import { reportBooked, reportHeight } from "../lib/embed";
import { isShopOpen } from "../lib/openingHours";
import { useLanguage } from "../lib/i18n";
import {
  clearPartyDraft,
  loadPartyDraft,
  savePartyDraft,
} from "../lib/partyDraft";
import { calendarHref } from "../lib/calendar";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ApiError,
  book,
  getHostedShop,
  getServices,
  getBundles,
  getPartyAvailability,
  setPublicKey,
  type PartySelection,
  type PartyAvailability,
  type BookInput,
  type Booked,
  type Catalog,
  type Shop,
} from "../lib/api";
import {
  bookingToday,
  addDays,
  dateOf,
  timeOf,
  money,
  duration,
} from "../lib/format";
import {
  Card,
  Shell,
  Topbar,
  Btn,
  Dock,
  Loading,
  Note,
  PhoneLink,
} from "../components/Chrome";
import { ConfirmStep, SuccessStep, type BookingContact } from "./BookPage";
import { saveLastBooking } from "../lib/session";

export function BookingExperiencePage() {
  useEffect(() => reportHeight(), []);
  const { t, locale } = useLanguage();
  const { slug = "" } = useParams();
  const restored = useRef(loadPartyDraft(slug)).current;
  const [step, setStep] = useState(1);
  const [partySize, setPartySize] = useState(restored?.partySize ?? 1);
  const [items, setItems] = useState<PartySelection[]>(restored?.items ?? []);
  const [contact, setContact] = useState<BookingContact>();

  useEffect(() => {
    if (step === 6) clearPartyDraft(slug);
    else savePartyDraft(slug, partySize, items);
  }, [slug, partySize, items, step]);
  const [guest, setGuest] = useState(0);
  const [guestNames, setGuestNames] = useState<string[]>([]);
  const [editingGuest, setEditingGuest] = useState<number | null>(null);
  const [draftGuestName, setDraftGuestName] = useState("");
  const guestLabel = (index: number) => guestNames[index]?.trim() || `${t("Guest")} ${index + 1}`;
  const guestNotes = guestNames.slice(0, partySize).map((name, index) =>
    name?.trim() ? `Guest ${index + 1}: ${name.trim()}` : "").filter(Boolean).join("\n");
  const [customizing, setCustomizing] = useState<{
    group: ServiceGroup;
    index: number | null;
  } | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [bagOpen, setBagOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [date, setDate] = useState("");
  const [avail, setAvail] = useState<PartyAvailability | null>(null);
  const [picked, setPicked] = useState<
    PartyAvailability["plans"][number] | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [done, setDone] = useState<Booked | null>(null);
  const [idem, setIdem] = useState(() => crypto.randomUUID());
  const started = useRef(Date.now());
  const generation = useRef(0);
  const shopQuery = useQuery({
    queryKey: ["experience-shop", slug, locale],
    queryFn: async () => {
      const s = await getHostedShop(slug, locale);
      setPublicKey(s.publicKey ?? "");
      return s;
    },
  });
  const shop = shopQuery.data;
  const catalogQuery = useQuery({
    queryKey: ["experience-catalog", slug, shop?.publicKey, locale],
    enabled: !!shop,
    queryFn: () => getServices(locale, shop?.publicKey),
  });
  const catalog = catalogQuery.data;
  const bundles = useQuery({
    queryKey: ["experience-bundles", slug, shop?.publicKey, locale],
    enabled: !!shop,
    queryFn: () => getBundles(locale, shop?.publicKey),
  });
  useEffect(() => {
    if (shop) {
      document.title = `${shop.name} · Online booking`;
      setDate(
        (current) =>
          current || bookingToday(shop.timezone, shop.businessDayCutoff),
      );
    }
  }, [shop]);
  useEffect(() => {
    generation.current++;
    setPicked(null);
    setAvail(null);
  }, [items, date]);
  useEffect(() => {
    if (step !== 3) return;
    if (!date || !items.length) return;
    const version = ++generation.current;
    setBusy(true);
    setError("");
    getPartyAvailability(date, items, shop?.publicKey)
      .then((a) => {
        if (version === generation.current) {
          setAvail(a);
          setPicked((previous) =>
            previous
              ? (a.plans.find((p) => p.startsAt === previous.startsAt) ?? null)
              : null,
          );
        }
      })
      .catch(() => {
        if (version === generation.current)
          setError(
            "Could not load availability. Try again or contact the shop.",
          );
      })
      .finally(() => {
        if (version === generation.current) setBusy(false);
      });
    return () => {
      generation.current++;
    };
  }, [step, date, items, retry, shop?.publicKey]);
  const changeItems = (next: PartySelection[]) => {
    setItems(next);
    setPicked(null);
    setIdem(crypto.randomUUID());
  };
  const goStep = (value: number) => {
    setError("");
    setStep(value);
    setBagOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  async function submit(input: BookInput) {
    try {
      const notes = [guestNotes, input.notes].filter(Boolean).join("\n\n");
      const result = await book({ ...input, ...(notes ? { notes } : {}) }, idem, shop?.publicKey);
      setDone(result);
      reportBooked(result.confirmationCode);
      if (result.summary) {
        const summary = result.summary;
        setPicked({
          startsAt: summary.startsAt,
          items: summary.items.map((i) => ({
            guestIndex: i.guestIndex ?? 0,
            serviceId: i.serviceId,
            addonIds: i.addonIds,
            staffId: i.specialistName,
            startsAt: i.startsAt,
            endsAt: i.endsAt,
            durationMin: i.durationMin,
            priceCents: i.priceCents,
          })),
        });
        setAvail((a) => ({
          ...a!,
          staff: summary.items
            .filter((i) => i.specialistName)
            .map((i) => ({
              id: i.specialistName!,
              displayName: i.specialistName!,
              avatarUrl: null,
            })),
        }));
      }
      saveLastBooking({ ...result, shopSlug: slug });
      setStep(6);
    } catch (e) {
      if (
        e instanceof ApiError &&
        (e.isTaken ||
          ["party_schedule_changed", "party_price_changed"].includes(
            String(e.details.reason),
          ))
      ) {
        setPicked(null);
        setStep(3);
        setError("Availability changed. Please choose a new time.");
      } else throw e;
    }
  }
  if (shopQuery.isPending)
    return (
      <Shell>
        <Loading />
      </Shell>
    );
  if (!shop)
    return (
      <Shell>
        <Card>
          <h1> {t("Shop unavailable")} </h1>
          <Note warn> {t("Please check this link or try again.")} </Note>
          <Btn onClick={() => void shopQuery.refetch()}> {t("Try again")} </Btn>
        </Card>
      </Shell>
    );
  const selectedServices = items.map((i) =>
    catalog?.services.find((s) => s.id === i.serviceId),
  );
  const price =
    picked?.items.reduce((n, i) => n + i.priceCents, 0) ??
    items.reduce(
      (n, i, index) =>
        n +
        (selectedServices[index]?.priceCents ?? 0) +
        (catalog?.addons
          .filter((a) => i.addonIds.includes(a.id))
          .reduce((x, a) => x + a.priceCents, 0) ?? 0),
      0,
    );
  const mins = picked
    ? Math.round(
        (Math.max(...picked.items.map((i) => Date.parse(i.endsAt))) -
          Date.parse(picked.startsAt)) /
          60000,
      )
    : 0;
  const complete =
    selectedServices.every((s) => s && s.onlineBookable !== false) &&
    Array.from({ length: partySize }, (_, i) =>
      items.some((x) => x.guestIndex === i),
    ).every(Boolean);
  const groups = groupServices(catalog?.services ?? []);
  const current = step === 1 ? 0 : step === 3 ? 1 : 2;
  const editItem = (index: number) => {
    const group = groups.find((g) =>
      g.services.some((s) => s.id === items[index]!.serviceId),
    );
    if (group) {
      setBagOpen(false);
      setCustomizing({ group, index });
    }
  };
  const changeGuestCount = (n: number) => {
    setPartySize(n);
    setGuest(Math.min(guest, n - 1));
    setEditingGuest(null);
    setGuestNames((names) => names.slice(0, n));
    changeItems(items.filter((i) => i.guestIndex < n));
    if (step !== 1) goStep(1);
  };
  const removeGuest = (removed: number) => {
    if (partySize <= 1) return;
    setPartySize(partySize - 1);
    setGuestNames(Array.from({ length: partySize }, (_, index) => guestNames[index] ?? "").filter((_, index) => index !== removed));
    setGuest(guest > removed ? guest - 1 : guest === removed ? Math.min(removed, partySize - 2) : guest);
    setEditingGuest(null);
    changeItems(items.filter((item) => item.guestIndex !== removed).map((item) => ({
      ...item, guestIndex: item.guestIndex > removed ? item.guestIndex - 1 : item.guestIndex,
    })));
    if (step !== 1) goStep(1);
  };
  const canContinue =
    shop.onlineBooking.enabled && (step === 1 ? complete : !!picked);
  const continueLabel = t(step === 1 ? "Choose time" : "Continue");
  const bag = (
    <>
      <div className="bag-heading">
        <h2>{t("Your booking")}</h2>
        <span>
          {partySize} {t(partySize === 1 ? "Guest" : "Guests")}
        </span>
      </div>
      {!items.length ? (
        <p className="empty-bag">{t("Select a service")}</p>
      ) : (
        <ul className="bag-items">
          {items.map((item, index) => ({ item, index }))
            .sort((a, b) => a.item.guestIndex - b.item.guestIndex)
            .map(({ item, index }, position, sorted) => {
            const svc = selectedServices[index];
            const addons = catalog?.addons.filter((a) => item.addonIds.includes(a.id)) ?? [];
            const startsGuest = position === 0 || sorted[position - 1]!.item.guestIndex !== item.guestIndex;
            return (
              <li key={`${index}:${item.serviceId}`}>
                {startsGuest && partySize > 1 && <h3 className="bag-guest-heading">{guestLabel(item.guestIndex)}</h3>}
                <div className="bag-item-title">
                  <strong>{svc?.name}</strong>
                  <span>
                    {money(svc?.priceCents ?? 0, shop.currency)}
                  </span>
                </div>
                <p>{duration(svc?.durationMin ?? 0)}</p>
                {addons.map((addon) => (
                  <div className="bag-addon" key={addon.id}>
                    <span>+ {addon.name}<small>+ {duration(addon.durationMin)}</small></span>
                    <span>{money(addon.priceCents, shop.currency)}</span>
                  </div>
                ))}
                {addons.length > 0 && <p className="bag-item-duration">{t("Total service time:")} {duration((svc?.durationMin ?? 0) + addons.reduce((n, a) => n + a.durationMin, 0))}</p>}
                <div className="bag-item-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`${t("Edit")} ${svc?.name}`}
                    onPress={() => editItem(index)}
                  >
                    {t("Edit")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`${t("Remove")} ${svc?.name}`}
                    onPress={() => {
                      changeItems(items.filter((_, i) => i !== index));
                      if (step !== 1) goStep(1);
                    }}
                  >
                    {t("Remove")}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {picked && (
        <div className="bag-time">
          <div>
            <strong>{dateOf(picked.startsAt, shop.timezone, locale)}</strong>
            <p>
              {timeOf(picked.startsAt, shop.timezone, locale)} ·{" "}
              {duration(mins)}
            </p>
          </div>
          <Button size="sm" variant="ghost" onPress={() => goStep(3)}>
            {t("Edit")}
          </Button>
        </div>
      )}
      <div className="bag-total">
        <span>{t("Total")}</span>
        <strong>{money(price, shop.currency)}</strong>
      </div>
      {step !== 4 && (
        <Btn
          primary
          disabled={!canContinue}
          onClick={() => goStep(step === 1 ? 3 : 4)}
        >
          {continueLabel} <span aria-hidden="true">→</span>
        </Btn>
      )}
    </>
  );
  return (
    <Shell>
      <Topbar shop={shop} step={null} />
      {step === 6 && done ? (
        <div className="success-layout">
          {picked && (
            <PlanSummary
              plan={picked}
              catalog={catalog}
              shop={shop}
              staff={avail?.staff ?? []}
              guestNames={guestNames}
              preferences={items}
            />
          )}
          {contact && (
            <Card>
              <h2 className="section-label">{t("Contact")}</h2>
              <p>{contact.name}</p>
              <p>{formatPhoneDisplay(contact.phone)}</p>
              {contact.email && <p>{contact.email}</p>}
              {contact.notes && (
                <p className="whitespace-pre-wrap">{contact.notes}</p>
              )}
            </Card>
          )}
          <SuccessStep
            shop={shop}
            slug={slug}
            done={done}
            onAgain={() => {
              setDone(null);
              setPicked(null);
              setContact(undefined);
              changeItems([]);
              setStep(1);
              started.current = Date.now();
            }}
          />
          {picked && (
            <a
              className="calendar-download"
              download="appointment.ics"
              href={calendarHref(
                {
                  bookingId: done.bookingId,
                  startsAt: picked.startsAt,
                  endsAt: new Date(
                    Math.max(...picked.items.map((i) => Date.parse(i.endsAt))),
                  ).toISOString(),
                },
                shop,
              )}
            >
              {t("Add to calendar")} ↗
            </a>
          )}
        </div>
      ) : (
        <>
          <div className="booking-flow-header">
            <Stepper
              currentStep={current}
              onStepChange={(n) => {
                if (n === 0) goStep(1);
                if (n === 1 && complete) goStep(3);
                if (n === 2 && picked) goStep(4);
              }}
            >
              {["Services", "Time", "Confirm"].map((label, i) => (
                <Stepper.Step
                  key={label}
                  aria-disabled={
                    i === 1 ? !complete : i === 2 ? !picked : false
                  }
                >
                  <Stepper.Indicator />
                  <Stepper.Content>
                    <Stepper.Title>{t(label)}</Stepper.Title>
                  </Stepper.Content>
                  <Stepper.Separator />
                </Stepper.Step>
              ))}
            </Stepper>
          </div>
          <div className="booking-layout">
            <div className="booking-main">
              {error && (
                <div role="alert">
                  <Note warn>{t(error)}</Note>
                  <Button
                    variant="ghost"
                    onPress={() => setRetry((n) => n + 1)}
                  >
                    {t("Try again")}
                  </Button>
                </div>
              )}
              {step === 1 && (
                <>
                  {!!(shop.publicProfile?.coverUrl || shop.publicProfile?.photoUrls?.length) && <button type="button" className="shop-photo-banner" onClick={() => setInfoOpen(true)} aria-label={t("View shop photos")}>
                    {[...new Set([shop.publicProfile?.coverUrl, ...(shop.publicProfile?.photoUrls ?? [])].filter((url): url is string => !!url))].slice(0, 3).map((url) => <img key={url} src={url} alt={shop.name} />)}
                    <span>{t("View shop photos")} ↗</span>
                  </button>}
                  <div className="store-intro">
                    <div>
                      <h1>{t("Services")}</h1>
                      <Button
                        variant="ghost"
                        size="sm"
                        onPress={() => setInfoOpen(true)}
                      >
                        {t("Shop details")} <span aria-hidden="true">↗</span>
                      </Button>
                    </div>
                  </div>
                  {!shop.onlineBooking.enabled && (
                    <Note>
                      {t("Online booking is unavailable. Contact")}{" "}
                      <PhoneLink shop={shop} />
                    </Note>
                  )}
                  <div className="guest-toolbar">
                    <div className="guest-toolbar-heading">
                      <h2>{t("Guests")}</h2>
                    <div className="guest-counter">
                      <NumberStepper
                        aria-label={t("Number of guests")}
                        value={partySize}
                        onChange={changeGuestCount}
                        minValue={1}
                        maxValue={shop.publicProfile?.maxPartySize ?? 10}
                        size="sm"
                      >
                        <NumberStepper.Group>
                          <NumberStepper.DecrementButton />
                          <NumberStepper.Value>
                            {({ value }) => (
                              <span className="guest-number">{value}</span>
                            )}
                          </NumberStepper.Value>
                          <NumberStepper.IncrementButton />
                        </NumberStepper.Group>
                      </NumberStepper>
                    </div>
                    </div>
                    <div className="guest-tabs">
                      {Array.from({ length: partySize }, (_, i) => (
                        <div key={i} className={`guest-chip ${guest === i ? "is-selected" : ""}`}>
                          <Choice selected={guest === i} onPress={() => setGuest(i)}>
                            <span className="guest-chip-name">{guestLabel(i)}</span>{" "}
                            <span className="guest-count">{items.filter((x) => x.guestIndex === i).length} {t("selected")}</span>
                          </Choice>
                          <Popover isOpen={editingGuest === i} onOpenChange={(open) => {
                            setEditingGuest(open ? i : null);
                            if (open) setDraftGuestName(guestNames[i] ?? "");
                          }}>
                            <Button isIconOnly variant="ghost" className="guest-rename" aria-label={`${t("Edit")} ${guestLabel(i)}`}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15v5Z" /></svg>
                            </Button>
                            <Popover.Content placement="bottom start" className="guest-popover">
                              <Popover.Dialog>
                                <Popover.Heading>{t("Guest")} {i + 1}</Popover.Heading>
                                <form className="guest-name-form" onSubmit={(event) => {
                                  event.preventDefault();
                                  setGuestNames((names) => Array.from({ length: partySize }, (_, n) => n === i ? draftGuestName.trim() : names[n] ?? ""));
                                  setIdem(crypto.randomUUID());
                                  setEditingGuest(null);
                                }}>
                                  <label>{t("Name")}<Input autoFocus aria-label={`${t("Guest")} ${i + 1}`} value={draftGuestName}
                                    placeholder={`${t("Guest")} ${i + 1}`} maxLength={30}
                                    onChange={(event) => setDraftGuestName(event.target.value)} /></label>
                                  <div className="guest-name-actions">
                                    <Button variant="secondary" onPress={() => setEditingGuest(null)}>{t("btn.cancel")}</Button>
                                    <Button type="submit" variant="primary">{t("Save name")}</Button>
                                  </div>
                                </form>
                                {partySize > 1 && <div className="guest-remove-action">
                                  <p>{t("Removing this guest also removes their services.")}</p>
                                  <Button variant="ghost" onPress={() => removeGuest(i)}>{t("Remove guest")}</Button>
                                </div>}
                              </Popover.Dialog>
                            </Popover.Content>
                          </Popover>
                        </div>
                      ))}
                    </div>

                  </div>
                  <div className="catalog-toolbar">
                    <div
                      className="category-tabs"
                      role="group"
                      aria-label={t("Service category")}
                    >
                      <Button
                        variant="ghost"
                        aria-pressed={category === ""}
                        onPress={() => setCategory("")}
                      >
                        {t("All services")}
                      </Button>
                      {catalog?.categories.map((c) => (
                        <Button
                          key={c.id}
                          variant="ghost"
                          aria-pressed={category === c.id}
                          onPress={() => setCategory(c.id)}
                        >
                          {c.name}
                        </Button>
                      ))}
                    </div>
                    {(catalog?.services.length ?? 0) > 12 && (
                      <Input
                        aria-label={t("Search services")}
                        placeholder={t("Search services")}
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    )}
                  </div>
                  {catalogQuery.isError ? (
                    <Note warn>
                      {t("Services could not be loaded.")}{" "}
                      <Button
                        variant="ghost"
                        onPress={() => void catalogQuery.refetch()}
                      >
                        {t("Try again")}
                      </Button>
                    </Note>
                  ) : !catalog ? (
                    <Loading />
                  ) : (
                    <div className="service-list">
                      {groups
                        .filter(
                          (g) =>
                            (!category ||
                              g.services[0]?.categoryId === category) &&
                            g.name.toLowerCase().includes(search.toLowerCase()),
                        )
                        .map((group) => {
                          const first = group.services[0]!;
                          return (
                            <article className="service-row" key={group.key}>
                              <ServiceImage
                                src={
                                  group.services.find((s) => s.imageUrl)
                                    ?.imageUrl
                                }
                              />
                              <div className="service-row-copy">
                                <h2>{group.name}</h2>
                                <p>
                                  {group.services
                                    .map((s) => duration(s.durationMin))
                                    .join(" / ")}
                                </p>
                              </div>
                              <div className="service-price">
                                {group.services.length > 1 && (
                                  <small>{t("From")}</small>
                                )}
                                <strong>
                                  {money(
                                    Math.min(
                                      ...group.services.map(
                                        (s) => s.priceCents,
                                      ),
                                    ),
                                    shop.currency,
                                  )}
                                </strong>
                              </div>
                              <Button
                                isIconOnly
                                variant="secondary"
                                className="service-add"
                                aria-label={`${t("Add")} ${group.name}`}
                                isDisabled={
                                  !shop.onlineBooking.enabled ||
                                  items.length >= 20 ||
                                  group.services.every(
                                    (s) => s.onlineBookable === false,
                                  )
                                }
                                onPress={() =>
                                  setCustomizing({ group, index: null })
                                }
                              >
                                +
                              </Button>
                            </article>
                          );
                        })}
                      {!groups.length && (
                        <Note>
                          {t(
                            "No online services are available. Please contact the shop.",
                          )}
                        </Note>
                      )}
                    </div>
                  )}
                  {!!bundles.data?.bundles.length && (
                    <Link className="subtle-link" to={`/${slug}/bundles`}>
                      {t("View packages and bundles")} ↗
                    </Link>
                  )}
                </>
              )}
              {step === 3 && (
                <>
                  <div className="page-heading">
                    <h1>{t("Choose a time")}</h1>
                    <p>{t("Times shown in")} {shop.timezone.replace(/_/g, " ")}</p>
                  </div>
                  {shop.onlineBooking.allowClientPickStaff !== false && (
                    <div className="staff-preferences" aria-busy={busy}>
                      {busy && (
                        <div className="staff-loading" role="status">
                          <span className="spin" />
                          {t("Loading…")}
                        </div>
                      )}
                      {items.map((item, index) => ({ item, index })).sort((a, b) => a.item.guestIndex - b.item.guestIndex).map(({ item, index }) => (
                        <div className="staff-preference" key={index}>
                          {items.length > 1 && (
                            <p className="section-label">
                              {guestLabel(item.guestIndex)} ·{" "}
                              {selectedServices[index]?.name}
                            </p>
                          )}
                          <div className="staff-options">
                            <Choice
                              disabled={busy}
                              selected={!item.staffId}
                              onPress={() =>
                                changeItems(
                                  items.map((i, n) =>
                                    n === index ? { ...i, staffId: null } : i,
                                  ),
                                )
                              }
                            >
                              {t("Any available specialist")}
                            </Choice>
                            {avail?.staff
                              .filter(
                                (s) =>
                                  !avail.items?.[index] ||
                                  avail.items[index]!.eligibleStaffIds.includes(
                                    s.id,
                                  ),
                              )
                              .map((s) => (
                                <Choice
                                  key={s.id}
                                  disabled={busy}
                                  selected={item.staffId === s.id}
                                  onPress={() =>
                                    changeItems(
                                      items.map((i, n) =>
                                        n === index
                                          ? { ...i, staffId: s.id }
                                          : i,
                                      ),
                                    )
                                  }
                                >
                                  {s.avatarUrl && (
                                    <Avatar size="sm">
                                      <Avatar.Image src={s.avatarUrl} />
                                      <Avatar.Fallback>
                                        {s.displayName.slice(0, 1)}
                                      </Avatar.Fallback>
                                    </Avatar>
                                  )}
                                  {s.displayName}
                                </Choice>
                              ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="time-layout">
                    <DateChooser
                      date={date}
                      onDate={setDate}
                      start={bookingToday(
                        shop.timezone,
                        shop.businessDayCutoff,
                      )}
                      horizon={shop.onlineBooking.maxDaysAhead}
                    />
                    <div className="time-results">
                      {busy ? (
                        <Loading />
                      ) : !avail?.plans.length ? (
                        <div className="empty-times" role="status">
                          <h2>{t("No times available for this date")}</h2>
                          <p>{t("Choose another date or change your specialist preferences.")}</p>
                          <Button
                            variant="secondary"
                            onPress={() => setDate(addDays(date, 1))}
                            isDisabled={
                              date >=
                              addDays(
                                bookingToday(
                                  shop.timezone,
                                  shop.businessDayCutoff,
                                ),
                                shop.onlineBooking.maxDaysAhead,
                              )
                            }
                          >
                            {t("Check next day")} →
                          </Button>
                          {shop.phone && <p className="empty-times-contact">{t("Need help booking?")} <PhoneLink shop={shop} /></p>}
                        </div>
                      ) : (
                        <div className="time-grid">
                          {avail.plans.map((plan) => (
                            <Choice
                              key={plan.startsAt}
                              selected={picked?.startsAt === plan.startsAt}
                              onPress={() => {
                                setPicked(plan);
                                setIdem(crypto.randomUUID());
                              }}
                            >
                              {timeOf(plan.startsAt, shop.timezone, locale)}
                            </Choice>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  {picked?.items.some((i) => i.staffId === null) && (
                    <Note>{t("Specialist to be assigned")}</Note>
                  )}
                </>
              )}
              {step === 4 && picked && (
                <>
                  <Button
                    className="mobile-review-bag"
                    variant="secondary"
                    onPress={() => setBagOpen(true)}
                  >
                    {t("Your booking")} · {money(price, shop.currency)}{" "}
                    <span>{t("Edit")}</span>
                  </Button>
                  <ConfirmStep
                    appointmentSummary={
                      <PlanSummary
                        plan={picked}
                        catalog={catalog}
                        shop={shop}
                        staff={avail?.staff ?? []}
                        guestNames={guestNames}
              preferences={items}
                        onEdit={() => goStep(1)}
                        onTime={() => goStep(3)}
                      />
                    }
                    notesMaxLength={Math.max(0, 500 - guestNotes.length - (guestNotes ? 2 : 0))}
                    initialContact={contact}
                    onContactChange={setContact}
                    shop={shop}
                    service={null}
                    addons={[]}
                    startsAt={picked.startsAt}
                    staffId={null}
                    openedAt={started.current}
                    onSubmit={submit}
                    onBack={() => goStep(3)}
                    party={{
                      partySize,
                      priceCents: price,
                      durationMin: mins,
                      items: picked.items.map((i, index) => ({
                        guestIndex: i.guestIndex,
                        quotedPriceCents: i.priceCents,
                        serviceId: i.serviceId,
                        addonIds: i.addonIds,
                        staffId: items[index]!.staffId,
                        startsAt: i.startsAt,
                      })),
                    }}
                  />
                </>
              )}
            </div>
            <aside className="booking-bag">{bag}</aside>
          </div>
          {step !== 4 && (
            <div className="mobile-booking-dock">
              <Button variant="ghost" onPress={() => setBagOpen(true)}>
                <span>
                  <strong>{money(price, shop.currency)}</strong>
                  <small>
                    {items.length} {t("Services")} · {t("Edit")}
                  </small>
                </span>
                <span aria-hidden="true">⌃</span>
              </Button>
              <Btn
                primary
                disabled={!canContinue}
                onClick={() => goStep(step === 1 ? 3 : 4)}
              >
                {continueLabel} →
              </Btn>
            </div>
          )}
          <Sheet isOpen={bagOpen} onOpenChange={setBagOpen}>
            <Sheet.Backdrop>
              <Sheet.Content className="booking-sheet">
                <Sheet.Dialog>
                  <Sheet.Handle />
                  <Sheet.CloseTrigger />
                  <Sheet.Header>
                    <Sheet.Heading>{t("Your booking")}</Sheet.Heading>
                  </Sheet.Header>
                  <Sheet.Body>{bag}</Sheet.Body>
                </Sheet.Dialog>
              </Sheet.Content>
            </Sheet.Backdrop>
          </Sheet>
        </>
      )}
      {customizing && (
        <ServiceCustomizer
          key={`${customizing.group.key}:${customizing.index}`}
          group={{
            ...customizing.group,
            services: customizing.group.services.filter(
              (s) => s.onlineBookable !== false,
            ),
          }}
          addons={catalog?.addons ?? []}
          currency={shop.currency}
          {...(customizing.index !== null
            ? { initial: items[customizing.index] }
            : {})}
          onClose={() => setCustomizing(null)}
          onSave={(serviceId, addonIds) => {
            const index = customizing.index;
            const value = {
              guestIndex: index === null ? guest : items[index]!.guestIndex,
              serviceId,
              addonIds,
              staffId: index === null ? null : items[index]!.staffId,
            };
            changeItems(
              index === null
                ? [...items, value]
                : items.map((i, n) => (n === index ? value : i)),
            );
            setCustomizing(null);
            if (step !== 1) goStep(1);
          }}
        />
      )}
      <BookingDialog
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
        title={shop.name}
      >
        <ShopOverview shop={shop} staff={shop.team ?? avail?.staff ?? []} />
      </BookingDialog>
    </Shell>
  );
}
function PlanSummary({
  plan,
  catalog,
  shop,
  staff,
  preferences,
  guestNames = [],
  onEdit,
  onTime,
}: {
  plan: PartyAvailability["plans"][number];
  catalog: Catalog | undefined;
  shop: Shop;
  staff: PartyAvailability["staff"];
  preferences?: PartySelection[];
  guestNames?: string[];
  onEdit?: () => void;
  onTime?: () => void;
}) {
  const { t, locale } = useLanguage();
  const total = plan.items.reduce((n, i) => n + i.priceCents, 0);
  const address =
    typeof shop.address === "string"
      ? shop.address
      : [
          shop.address?.line1,
          shop.address?.line2,
          shop.address?.city,
          [shop.address?.state, shop.address?.zip].filter(Boolean).join(" "),
        ]
          .filter(Boolean)
          .join(", ");
  return (
    <Card className="appointment-summary">
      <div className="summary-heading">
        <h2>{t("Your appointment")}</h2>
        {onEdit && (
          <Button variant="ghost" onPress={onEdit}>
            {t("Edit services")}
          </Button>
        )}
      </div>
      <div className="summary-heading">
        <div>
          <p className="summary-date">
            {dateOf(plan.startsAt, shop.timezone, locale)}
          </p>
          <p>
            {timeOf(plan.startsAt, shop.timezone, locale)} ·{" "}
            {shop.timezone.replace(/_/g, " ")}
          </p>
        </div>
        {onTime && (
          <Button variant="ghost" onPress={onTime}>
            {t("Edit time")}
          </Button>
        )}
      </div>
      <ul className="bag-items">
        {plan.items.map((i, n) => {
          const preferred = preferences?.find(
            (p) => p.guestIndex === i.guestIndex && p.serviceId === i.serviceId,
          )?.staffId;
          return (
            <li key={n}>
              <div className="bag-item-title">
                <strong>
                  {guestNames[i.guestIndex]?.trim() || `${t("Guest")} ${i.guestIndex + 1}`} ·{" "}
                  {catalog?.services.find((s) => s.id === i.serviceId)?.name}
                </strong>
                <span>{money(i.priceCents, shop.currency)}</span>
              </div>
              <p>
                {duration(i.durationMin)}
                {preferred &&
                  ` · ${staff.find((s) => s.id === preferred)?.displayName ?? ""}`}
              </p>
              {i.addonIds.length > 0 && (
                <p>
                  {i.addonIds
                    .map((id) => catalog?.addons.find((a) => a.id === id)?.name)
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <div className="bag-total">
        <span>{t("Total")}</span>
        <strong>{money(total, shop.currency)}</strong>
      </div>
      {address && <p className="summary-address">{address}</p>}
    </Card>
  );
}

function ShopOverview({
  shop,
  staff,
}: {
  shop: Shop;
  staff: PartyAvailability["staff"];
}) {
  const { t } = useLanguage();
  const address =
    typeof shop.address === "string"
      ? shop.address
      : [
          shop.address?.line1,
          shop.address?.line2,
          shop.address?.city,
          [shop.address?.state, shop.address?.zip].filter(Boolean).join(" "),
          shop.address?.country,
        ]
          .filter(Boolean)
          .join(", ");
  return (
    <div className="shop-details">
      <ServiceImage
        className="shop-hero-media"
        src={shop.publicProfile?.coverUrl || shop.publicProfile?.photoUrls?.[0]}
      />
      {address && (
        <a
          href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`}
          target="_blank"
          rel="noreferrer"
        >
          {address} ↗
        </a>
      )}
      <PhoneLink shop={shop} />
      {shop.publicProfile?.description && (
        <p className="shop-description">{shop.publicProfile.description}</p>
      )}
      {staff.length > 0 && (
        <section>
          <h3 className="section-label">{t("Specialist")}</h3>
          <div className="shop-team">
            {staff.map((person) => (
              <div className="shop-person" key={person.id}>
                <Avatar>
                  <Avatar.Image src={person.avatarUrl ?? undefined} />
                  <Avatar.Fallback>
                    {person.displayName.slice(0, 1)}
                  </Avatar.Fallback>
                </Avatar>
                <div>
                  <strong>{person.displayName}</strong>
                  {person.bio && <p>{person.bio}</p>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
      {shop.publicProfile?.arrivalInstructions && (
        <p>{shop.publicProfile.arrivalInstructions}</p>
      )}
      <section>
        <h3 className="section-label">{t("Opening hours")}</h3>
        <dl>
          {["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => {
            const h = shop.businessHours?.[day];
            return (
              <div key={day}>
                <dt>{t(day)}</dt>
                <dd>
                  {h
                    ? hourPeriods(h)
                        .map((p) => `${p.open}–${p.close}`)
                        .join(" · ")
                    : t("Closed")}
                </dd>
              </div>
            );
          })}
        </dl>
      </section>
      <p>
        {t("Cancel at least")} {shop.onlineBooking.cancelCutoffHours}{" "}
        {t("hours before your appointment.")}
      </p>
      {!!shop.publicProfile?.photoUrls?.length && (
        <div className="shop-gallery">
          {shop.publicProfile.photoUrls.map((src, i) => (
            <img
              key={src}
              src={src}
              alt={`${shop.name} ${i + 1}`}
              loading="lazy"
            />
          ))}
        </div>
      )}
    </div>
  );
}
