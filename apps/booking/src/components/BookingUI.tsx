import { Calendar, Modal, Button } from "@heroui/react";
import { I18nProvider } from "react-aria-components";
import { parseDate } from "@internationalized/date";
import type { ReactNode } from "react";
import { useLanguage } from "../lib/i18n";
import { addDays } from "../lib/format";

export function BookingCalendar({
  value,
  onChange,
  min,
  max,
}: {
  value: string;
  onChange: (date: string) => void;
  min: string;
  max: string;
}) {
  const { locale, t } = useLanguage();
  if (!value) return null;
  return (
    <I18nProvider locale={locale}>
      <Calendar
        aria-label={t("Date")}
        value={parseDate(value)}
        minValue={parseDate(min)}
        maxValue={parseDate(max)}
        onChange={(v) => onChange(v.toString())}
        className="booking-calendar"
      >
        <Calendar.Header>
          <Calendar.NavButton slot="previous" data-testid="earlier-days" />
          <Calendar.Heading />
          <Calendar.NavButton slot="next" data-testid="later-days" />
        </Calendar.Header>
        <Calendar.Grid>
          <Calendar.GridHeader>
            {(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}
          </Calendar.GridHeader>
          <Calendar.GridBody>
            {(date) => (
              <Calendar.Cell
                date={date}
                data-testid={`day-${date.toString()}`}
              />
            )}
          </Calendar.GridBody>
        </Calendar.Grid>
      </Calendar>
    </I18nProvider>
  );
}
export function BookingDialog({
  open,
  onClose,
  title,
  children,
  footer,
  compact = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  compact?: boolean;
}) {
  return (
    <Modal
      isOpen={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <Modal.Backdrop className="booking-backdrop">
        <Modal.Container className={`booking-modal-container ${compact ? "booking-modal-container-compact" : ""}`}>
          <Modal.Dialog className={`booking-modal ${compact ? "booking-modal-compact" : ""}`}>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>{title}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>{children}</Modal.Body>
            {footer && <Modal.Footer>{footer}</Modal.Footer>}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
export function DateChooser({
  date,
  onDate,
  start,
  horizon,
}: {
  date: string;
  onDate: (v: string) => void;
  start: string;
  horizon: number;
}) {
  return (
    <BookingCalendar
      value={date}
      onChange={onDate}
      min={start}
      max={addDays(start, horizon)}
    />
  );
}
export function Choice({
  selected,
  children,
  onPress,
  disabled = false,
  label,
}: {
  selected: boolean;
  children: ReactNode;
  onPress: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <Button
      variant="secondary"
      aria-pressed={selected}
      aria-label={label}
      isDisabled={disabled}
      className={`booking-choice ${selected ? "is-selected" : ""}`}
      onPress={onPress}
    >
      {children}
    </Button>
  );
}
