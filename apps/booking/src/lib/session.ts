/** Same-tab success data. Never persist last-four or customer PII. */
export interface LastBooking {
  bookingId: string;
  confirmationCode: string | null;
  manageToken: string | null;
  shopSlug: string;
}

const KEY = 'gf:last-booking';

export function saveLastBooking(row: LastBooking): void {
  try { sessionStorage.setItem(KEY, JSON.stringify(row)); } catch { /* private mode */ }
}

export function loadLastBooking(): LastBooking | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LastBooking;
    if (!parsed.bookingId || !parsed.shopSlug) return null;
    return parsed;
  } catch {
    return null;
  }
}
