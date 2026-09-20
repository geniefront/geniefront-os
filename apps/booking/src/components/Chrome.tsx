import { Button, Card as HeroCard, Spinner } from "@heroui/react";
import { Stepper } from "@heroui-pro/react/stepper";
import { useLanguage } from "../lib/i18n";
import { formatPhoneDisplay } from "@gf/contracts/phone";
import type { ReactNode } from "react";
import type { Shop } from "../lib/api";

export const STEPS = ["services", "specialist", "time", "confirm"] as const;
export type BookStep = (typeof STEPS)[number] | "success";

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div
      data-shell
      className="mx-auto min-h-full w-full max-w-[1240px] px-4 pb-[calc(var(--dock)+24px)] md:px-8 md:pb-12"
    >
      {children}
      <footer className="booking-footer">
        <a href="https://geniefront.com" target="_blank" rel="noreferrer">
          <span>Powered by</span>
          <img src="/brand/geniefront-icon.svg" alt="" />
          <strong>GenieFront</strong>
        </a>
      </footer>
    </div>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <HeroCard className={`booking-card ${className}`}>{children}</HeroCard>
  );
}

export function Note({
  children,
  warn = false,
}: {
  children: ReactNode;
  warn?: boolean;
}) {
  return (
    <p
      className={`mt-3 rounded-xl px-3 py-2 text-sm ${warn ? "bg-[var(--warn-bg)] text-[var(--warn)]" : "bg-[var(--mint)] text-[var(--brand-dark)]"}`}
    >
      {children}
    </p>
  );
}

export function PhoneLink({ shop }: { shop: Pick<Shop, "phone" | "name"> }) {
  if (!shop.phone) return null;
  return (
    <a
      className="font-semibold text-[var(--brand)] underline-offset-2 hover:underline"
      href={`tel:${shop.phone}`}
    >
      {formatPhoneDisplay(shop.phone)}
    </a>
  );
}

export function Progress({ step }: { step: BookStep }) {
  const { t } = useLanguage();
  const idx = STEPS.indexOf(step as (typeof STEPS)[number]);
  const labels: Record<(typeof STEPS)[number], string> = {
    services: "Services",
    specialist: "Specialist",
    time: "Date & time",
    confirm: "Confirm",
  };
  return (
    <Stepper currentStep={Math.max(0, idx)} className="legacy-progress">
      {STEPS.map((s) => (
        <Stepper.Step key={s}>
          <Stepper.Indicator />
          <Stepper.Content>
            <Stepper.Title>{t(labels[s])}</Stepper.Title>
          </Stepper.Content>
          <Stepper.Separator />
        </Stepper.Step>
      ))}
    </Stepper>
  );
}

export function Topbar({ shop, step }: { shop: Shop; step: BookStep | null }) {
  const { locale, setLocale, t } = useLanguage();
  const languages = [
    ["en", "English"],
    ["zh-Hans", "中文"],
    ["es", "Español"],
    ["vi", "Tiếng Việt"],
    ["ko", "한국어"],
  ];
  return (
    <header className="booking-topbar">
      <a className="shop-wordmark" href={`/${shop.slug}`}>
        {shop.publicProfile?.logoUrl && (
          <img src={shop.publicProfile.logoUrl} alt="" />
        )}
        <span>{shop.name}</span>
      </a>
      {step && step !== "success" && (
        <div className="hidden md:block">
          <Progress step={step} />
        </div>
      )}
      <select className="language-select" aria-label={t("Language")} value={locale}
        onChange={(event) => setLocale(event.target.value as typeof locale)}>
        {languages.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select>
    </header>
  );
}

export function Dock({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t border-[var(--line)] bg-[var(--surface)]/95 p-3 shadow-[0_-10px_30px_rgba(17,24,39,.06)] backdrop-blur md:static md:mt-5 md:border-0 md:bg-transparent md:p-0 md:shadow-none md:backdrop-blur-none">
      <div className="mx-auto flex max-w-[760px] gap-3">{children}</div>
    </div>
  );
}

export function Btn({
  children,
  onClick,
  disabled,
  primary = false,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  primary?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <Button
      type={type}
      onPress={onClick}
      isDisabled={disabled}
      variant={primary ? "primary" : "secondary"}
      className={`booking-btn ${primary ? "booking-btn-primary" : ""}`}
    >
      {children}
    </Button>
  );
}

export function Loading() {
  const { t } = useLanguage();
  return (
    <div
      role="status"
      className="flex min-h-40 items-center justify-center text-[var(--muted)]"
    >
      <Spinner size="sm" />
      <span className="sr-only">{t("Loading…")}</span>
    </div>
  );
}

export function CallShop({
  shop,
  children,
}: {
  shop: Pick<Shop, "phone" | "name">;
  children: ReactNode;
}) {
  return (
    <Card>
      <h1 className="text-xl font-bold">{children}</h1>
      {shop.phone ? (
        <p className="mt-3 text-[var(--muted)]">
          Call <PhoneLink shop={shop} /> to book or ask a question.
        </p>
      ) : (
        <p className="mt-3 text-[var(--muted)]">
          Please contact the shop directly.
        </p>
      )}
    </Card>
  );
}
