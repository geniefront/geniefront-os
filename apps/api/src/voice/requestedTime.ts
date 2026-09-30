import { wallMinuteToInstant } from '@gf/scheduling';

/** Answer the caller's exact time separately from a successful availability lookup.
 * ok:true means the lookup succeeded, not that the requested slot is available. */
export function requestedTimeResult(input: {
  date: string; time: string; timezone: string; minMinutesAhead: number; times: string[];
}, now = Date.now()) {
  const minute = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const earliest = now + input.minMinutesAhead * 60_000;
  const instant = (time: string) => wallMinuteToInstant(input.date, input.timezone, minute(time)).getTime();
  const times = [...new Set(input.times)].filter(time => instant(time) >= earliest);
  const available = times.includes(input.time);
  const reason = available ? null : instant(input.time) < earliest ? 'too_soon' : 'not_offered';
  return {
    date: input.date, time: input.time, available, reason,
    minMinutesAhead: input.minMinutesAhead,
    alternatives: available ? [] : times
      .sort((a, b) => Math.abs(minute(a) - minute(input.time)) - Math.abs(minute(b) - minute(input.time)) || minute(a) - minute(b))
      .slice(0, 2),
  };
}
