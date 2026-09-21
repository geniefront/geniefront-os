import { chromium, expect } from "@playwright/test";
import { PUBLIC_COPY } from "../apps/booking/src/lib/publicCopy";
const browser = await chromium.launch();
for (const [index, locale] of ["zh-Hans", "es", "vi", "ko"].entries()) {
  const copy = PUBLIC_COPY[locale]!;
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:5186/lotus-nails?locale=${locale}`);
  await expect(
    page.getByRole("button", { name: copy["Start booking"], exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `artifacts/public-booking/${locale}-storefront.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: copy["Start booking"], exact: true })
    .click();
  await page
    .getByRole("button", { name: copy["Choose services"], exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: copy["Services for each guest"],
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: new RegExp(`^${copy.Add} `) })
    .first()
    .click();
  await page.screenshot({
    path: `artifacts/public-booking/${locale}-services.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: copy["Choose specialists"], exact: true })
    .click();
  await page
    .getByRole("button", { name: copy["Choose time"], exact: true })
    .click();
  const date = new Date();
  date.setDate(date.getDate() + 6 + index);
  await page.locator("input[type=date]").fill(date.toISOString().slice(0, 10));
  await page
    .getByRole("button")
    .filter({ hasText: /\d{1,2}:\d{2}/ })
    .first()
    .click();
  await page
    .getByRole("button", { name: copy["Enter contact details"], exact: true })
    .click();
  await page
    .getByLabel(copy.Name!, { exact: true })
    .fill(`Booking QA ${locale}`);
  const phone = `617555018${index}`;
  await page.getByLabel(copy["Mobile phone"]!).fill(phone);
  await page
    .getByLabel(copy["Email (optional)"]!)
    .fill(`booking-${locale}@example.invalid`);
  await page
    .getByRole("button", { name: copy["Review appointment"], exact: true })
    .click();
  expect(await page.locator("body").innerText()).not.toMatch(
    /Confirm your details|Mobile phone|All guests start together/,
  );
  await page.screenshot({
    path: `artifacts/public-booking/${locale}-review.png`,
    fullPage: true,
  });
  await page.waitForTimeout(3100);
  await page.getByRole("button").last().click();
  await expect(page.locator('a[href*="#g/"]')).toBeVisible();
  await page.screenshot({
    path: `artifacts/public-booking/${locale}-success.png`,
    fullPage: true,
  });
  await page
    .getByRole("link", {
      name: copy["View, reschedule, or cancel"],
      exact: true,
    })
    .click();
  await expect(page.getByTestId("status")).toHaveText(copy.booked!);
  await page.screenshot({
    path: `artifacts/public-booking/${locale}-manage.png`,
    fullPage: true,
  });
  await page.locator("input[inputmode=numeric]").fill(phone.slice(-4));
  await page.getByRole("button", { name: copy.Continue, exact: true }).click();
  await page.getByRole("button").last().click();
  await page
    .getByRole("button", { name: copy["Confirm cancellation"], exact: true })
    .click();
  await expect(page.getByTestId("status")).toHaveText(copy.cancelled!);
  await page.screenshot({
    path: `artifacts/public-booking/${locale}-cancelled.png`,
    fullPage: true,
  });
  expect(errors).toEqual([]);
  console.log(
    `${locale}: storefront → services → contact → review → booking → management → cancellation passed`,
  );
  await page.close();
}
await browser.close();
