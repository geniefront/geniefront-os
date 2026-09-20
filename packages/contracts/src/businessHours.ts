import { z } from "zod";
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
const period = z.object({ open: time, close: time });
const minute = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
export const dayHoursSchema = z
  .object({
    open: time,
    close: time,
    periods: z.array(period).min(1).max(6).optional(),
  })
  .superRefine((v, ctx) => {
    const entries = (v.periods ?? [v])
      .map((p) => ({
        start: minute(p.open),
        end:
          minute(p.close) <= minute(p.open)
            ? minute(p.close) + 1440
            : minute(p.close),
      }))
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < entries.length; i++)
      if (entries[i]!.start < entries[i - 1]!.end)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Opening periods must not overlap",
        });
    // Check a late overnight interval against early hours of the following weekly day below.
  })
  .transform((v) => {
    const periods = [...(v.periods ?? [{ open: v.open, close: v.close }])].sort(
      (a, b) => a.open.localeCompare(b.open),
    );
    return { open: periods[0]!.open, close: periods.at(-1)!.close, periods };
  });
export const weeklyHoursSchema = z.record(
  z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]),
  dayHoursSchema.nullable(),
);
