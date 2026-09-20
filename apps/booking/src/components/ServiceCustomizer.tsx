import { ServiceImage } from "./ServiceImage";
import { useState } from "react";
import { Checkbox } from "@heroui/react";
import { BookingDialog, Choice } from "./BookingUI";
import { Btn } from "./Chrome";
import { useLanguage } from "../lib/i18n";
import { money, duration } from "../lib/format";
import type { Service, PartySelection } from "../lib/api";
import type { ServiceGroup } from "../lib/serviceGroups";
export function ServiceCustomizer({
  group,
  addons,
  currency,
  initial,
  onClose,
  onSave,
}: {
  group: ServiceGroup;
  addons: Service[];
  currency: string;
  initial?: PartySelection;
  onClose: () => void;
  onSave: (serviceId: string, addonIds: string[]) => void;
}) {
  const { t } = useLanguage();
  const [id, setId] = useState(initial?.serviceId ?? group.services[0]!.id);
  const [extra, setExtra] = useState(initial?.addonIds ?? []);
  const service = group.services.find((s) => s.id === id)!;
  const price =
    service.priceCents +
    addons
      .filter((a) => extra.includes(a.id))
      .reduce((sum, a) => sum + a.priceCents, 0);
  return (
    <BookingDialog
      open
      onClose={onClose}
      title={group.name}
      footer={
        <Btn primary onClick={() => onSave(id, extra)}>
          {t(initial ? "Save changes" : "Add to booking")} ·{" "}
          {money(price, currency)}
        </Btn>
      }
    >
      <ServiceImage
        className="customizer-media"
        src={
          service.imageUrl || group.services.find((s) => s.imageUrl)?.imageUrl
        }
      />
      <p className="section-label">{t("Duration")}</p>
      <div className="duration-options">
        {group.services.map((s) => (
          <Choice
            key={s.id}
            selected={id === s.id}
            onPress={() => setId(s.id)}
            label={`${duration(s.durationMin)} ${money(s.priceCents, currency)}`}
          >
            <span>
              {duration(s.durationMin)}
              <strong>{money(s.priceCents, currency)}</strong>
            </span>
          </Choice>
        ))}
      </div>
      {addons.length > 0 && (
        <div className="addon-section">
          <h3 className="section-label">{t("Add-ons")}</h3>
          {addons.map((a) => (
            <Checkbox
              key={a.id}
              className="addon-field"
              aria-label={a.name}
              isSelected={extra.includes(a.id)}
              isDisabled={!extra.includes(a.id) && extra.length >= 6}
              onChange={(selected) =>
                setExtra((old) =>
                  selected ? [...old, a.id] : old.filter((x) => x !== a.id),
                )
              }
            >
              <Checkbox.Content className="addon-row">
                <ServiceImage className="addon-media" src={a.imageUrl} />
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                <span className="addon-name">
                  {a.name}
                  <small>+{duration(a.durationMin)}</small>
                  {a.description && <small className="addon-description">{a.description}</small>}
                </span>
                <strong>
                  {a.priceCents ? money(a.priceCents, currency) : t("Free")}
                </strong>
              </Checkbox.Content>
            </Checkbox>
          ))}
        </div>
      )}
      {service.description && (
        <details className="service-description">
          <summary>{t("Service details")}</summary>
          <p>{service.description}</p>
        </details>
      )}
    </BookingDialog>
  );
}
