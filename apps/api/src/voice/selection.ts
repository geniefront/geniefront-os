import { z } from "zod";
import { VoiceBookingItems } from "@gf/contracts";
export const voiceItems = VoiceBookingItems;
export type VoiceItems = z.infer<typeof voiceItems>;
/** Consecutive returned times only; never fill a gap in availability. */
export function compactTimes(times: string[], step: number): string[] {
  const mins = times.map(
    (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)),
  );
  const out: string[] = [];
  for (let i = 0; i < times.length; i++) {
    let j = i;
    while (j + 1 < times.length && mins[j + 1]! - mins[j]! === step) j++;
    out.push(
      j - i >= 2
        ? `${times[i]}-${times[j]}/${step}`
        : times.slice(i, j + 1).join(","),
    );
    i = j;
  }
  return out;
}
