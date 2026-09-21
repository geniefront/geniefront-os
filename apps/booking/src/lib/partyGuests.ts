import { selectionGuests } from '@gf/contracts';
import type { PartySelection } from './api';
export { selectionGuests };

export function chooseServiceGuests(guest: number, count: number, partySize: number, maxGuests: number, items: PartySelection[], editingIndex: number | null) {
  if (count > maxGuests) return null;
  const current = editingIndex === null ? null : items[editingIndex];
  if (current && selectionGuests(current).length === count) return { guests: [...selectionGuests(current)], partySize };
  const others = Array.from({ length: partySize }, (_, i) => i).filter(i => i !== guest);
  others.sort((a, b) => Number(items.some((item,index) => index !== editingIndex && selectionGuests(item).includes(a))) - Number(items.some((item,index) => index !== editingIndex && selectionGuests(item).includes(b))));
  const guests = [guest, ...others].slice(0, count);
  let size = partySize;
  while (guests.length < count && size < maxGuests) guests.push(size++);
  return guests.length === count ? { guests: guests.sort((a,b) => a-b), partySize: size } : null;
}
export function removePartyGuest(items: PartySelection[], removed: number): PartySelection[] {
  return items.filter(item => !selectionGuests(item).includes(removed)).map(item => ({ ...item,
    guestIndex: item.guestIndex > removed ? item.guestIndex - 1 : item.guestIndex,
    ...(item.guestIndices ? { guestIndices: item.guestIndices.map(g => g > removed ? g - 1 : g) } : {}),
  }));
}
