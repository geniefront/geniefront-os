import { expect, it } from "vitest";
import { weeklyHoursSchema } from "./businessHours";
it("normalizes legacy days and preserves split periods", () => {
  expect(
    weeklyHoursSchema.parse({ mon: { open: "09:00", close: "17:00" } }).mon
      ?.periods,
  ).toEqual([{ open: "09:00", close: "17:00" }]);
  const periods = [
    { open: "09:00", close: "12:00" },
    { open: "13:00", close: "18:00" },
  ];
  expect(
    weeklyHoursSchema.parse({ mon: { open: "00:00", close: "00:00", periods } })
      .mon,
  ).toEqual({ open: "09:00", close: "18:00", periods });
});
it("rejects overlapping or empty periods while accepting overnight hours", () => {
  expect(
    weeklyHoursSchema.safeParse({
      mon: {
        open: "09:00",
        close: "18:00",
        periods: [
          { open: "09:00", close: "14:00" },
          { open: "13:00", close: "18:00" },
        ],
      },
    }).success,
  ).toBe(false);
  expect(
    weeklyHoursSchema.safeParse({
      mon: { open: "09:00", close: "18:00", periods: [] },
    }).success,
  ).toBe(false);
  expect(
    weeklyHoursSchema.safeParse({ mon: { open: "20:00", close: "02:00" } })
      .success,
  ).toBe(true);
});
