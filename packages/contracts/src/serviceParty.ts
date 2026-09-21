/** Guest coverage is separate from therapist count (e.g. four-hands massage).
 * An explicit public-profile value wins; existing Couples services retain their meaning. */
export function serviceGuestCount(name: unknown, staffCount: number, configured?: number): number {
  if (Number.isInteger(configured) && configured! >= 1 && configured! <= 10) return configured!;
  const names = typeof name === 'string' ? [name] : name && typeof name === 'object' ? Object.values(name) : [];
  return staffCount >= 2 && names.some(n => typeof n === 'string' && /\bcouples?\b|双人|情侣|情侶|雙人/i.test(n)) ? 2 : 1;
}
export function selectionGuests(item: { guestIndex: number; guestIndices?: readonly number[] | undefined }): readonly number[] {
  return item.guestIndices ?? [item.guestIndex];
}
