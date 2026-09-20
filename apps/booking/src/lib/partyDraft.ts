import type { PartySelection } from "./api";
/** Non-sensitive choices only. Never restore a time, contact details or quote. */
export function loadPartyDraft(
  slug: string,
): { partySize: number; items: PartySelection[] } | null {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(`gf:party:${slug}`) ?? "null",
    );
    if (
      !value ||
      !Number.isInteger(value.partySize) ||
      value.partySize < 1 ||
      value.partySize > 10 ||
      !Array.isArray(value.items) ||
      value.items.length > 20
    )
      return null;
    if (
      !value.items.every(
        (i: PartySelection) =>
          Number.isInteger(i.guestIndex) &&
          i.guestIndex >= 0 &&
          i.guestIndex < value.partySize &&
          typeof i.serviceId === "string" &&
          Array.isArray(i.addonIds) &&
          i.addonIds.length <= 6 &&
          i.addonIds.every((a) => typeof a === "string") &&
          (i.staffId === null || typeof i.staffId === "string"),
      )
    )
      return null;
    return {
      partySize: value.partySize,
      items: value.items.map((i: PartySelection) => ({
        guestIndex: i.guestIndex,
        serviceId: i.serviceId,
        addonIds: i.addonIds,
        staffId: i.staffId,
      })),
    };
  } catch {
    return null;
  }
}
export function savePartyDraft(
  slug: string,
  partySize: number,
  items: PartySelection[],
) {
  try {
    sessionStorage.setItem(
      `gf:party:${slug}`,
      JSON.stringify({
        partySize,
        items: items.map((i) => ({
          guestIndex: i.guestIndex,
          serviceId: i.serviceId,
          addonIds: i.addonIds,
          staffId: i.staffId,
        })),
      }),
    );
  } catch {
    /* private browser */
  }
}
export function clearPartyDraft(slug: string) {
  try {
    sessionStorage.removeItem(`gf:party:${slug}`);
  } catch {
    /* private browser */
  }
}
