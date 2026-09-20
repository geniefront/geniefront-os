import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const output = "artifacts/public-booking";
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
for (const [mode, width, height, offset] of [
  ["mobile", 390, 844, 2],
  ["desktop", 1440, 1000, 3],
] as const) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:5186/lotus-nails");
  await expect(
    page.getByRole("button", { name: "Start booking" }),
  ).toBeVisible();
  await page.screenshot({
    path: `${output}/${mode}-storefront.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Start booking" }).click();
  await page.getByLabel("Number of guests").selectOption("2");
  await page.getByRole("button", { name: "Choose services" }).click();
  await page.getByRole("button", { name: "Add for guest 1" }).first().click();
  await page.getByRole("button", { name: "Add for guest 1" }).nth(1).click();
  await page.getByRole("button", { name: "Guest 2 · 0" }).click();
  await page.getByRole("button", { name: "Add for guest 2" }).first().click();
  await page.getByRole("button", { name: "Choose specialists" }).click();
  await page.getByRole("button", { name: "Choose time" }).click();
  const date = new Date();
  date.setDate(date.getDate() + offset);
  await page.locator("input[type=date]").fill(date.toISOString().slice(0, 10));
  const slot = page
    .getByRole("button", { name: /^\d{1,2}:\d{2} [AP]M$/ })
    .first();
  await expect(slot).toBeVisible({ timeout: 10000 });
  await slot.click();
  await page.screenshot({
    path: `${output}/${mode}-time-summary.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Enter contact details" }).click();
  await page.getByLabel("Name", { exact: true }).fill(`Booking QA ${mode}`);
  await page
    .getByLabel("Mobile phone")
    .fill(mode === "mobile" ? "6175550191" : "6175550192");
  await page
    .getByLabel("Email (optional)")
    .fill(`booking-${mode}@example.invalid`);
  await page.getByRole("button", { name: "Review appointment" }).click();
  await page.screenshot({
    path: `${output}/${mode}-review.png`,
    fullPage: true,
  });
  await page.waitForTimeout(3100); // Match the public minimum human form duration.
  await page
    .getByRole("button", { name: "Book appointment", exact: true })
    .click();
  await expect(page.getByTestId("confirmation-code")).toBeVisible({
    timeout: 15000,
  });
  await page.screenshot({
    path: `${output}/${mode}-success.png`,
    fullPage: true,
  });
  await page.getByRole("link", { name: "View, reschedule, or cancel" }).click();
  await expect(page.getByTestId("status")).toHaveText("booked");
  await page.screenshot({
    path: `${output}/${mode}-manage.png`,
    fullPage: true,
  });
  await page
    .locator("input[inputmode=numeric]")
    .fill(mode === "mobile" ? "0191" : "0192");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const originalWhen=await page.getByTestId("when").innerText();
  await page.getByRole("button", { name: "Reschedule", exact: true }).click();
  const dayButtons = page.getByTestId("manage-day-strip").getByRole("button");
  await dayButtons.nth(offset + 2).click();
  const newSlot = page
    .getByRole("button", { name: /^\d{1,2}:\d{2} [AP]M$/ })
    .first();
  await expect(newSlot).toBeVisible({ timeout: 10000 });
  await newSlot.click();
  await page.screenshot({
    path: `${output}/${mode}-reschedule-review.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Confirm new time" }).click();
  await expect(
    page.getByRole("heading", { name: "Pick a new time" }),
  ).not.toBeVisible();
  await expect(page.getByTestId("when")).not.toHaveText(originalWhen);
  await page.screenshot({
    path: `${output}/${mode}-rescheduled.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Confirm cancellation" }).click();
  await expect(page.getByTestId("status")).toHaveText("cancelled");
  await page.screenshot({
    path: `${output}/${mode}-cancelled.png`,
    fullPage: true,
  });
  expect(errors).toEqual([]);
  console.log(
    `${mode}: storefront → 2 guests / 3 services → review → booking → management → group reschedule → group cancellation passed`,
  );
  await page.close();
}
await browser.close();
