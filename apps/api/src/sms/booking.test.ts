import { describe, it, expect } from "vitest";
import { compactWhen, customerBookingSms, shopBookingSms } from "./booking";
import { measure } from "./segments";
import { withComplianceFooter } from "./render";
import { staffBookingShortUrl } from "../links";

describe("compact booking notifications", () => {
  it("formats in the shop timezone", () =>
    expect(compactWhen("2026-09-24T15:00:00Z", "America/New_York")).toBe(
      "Sep 24 11am",
    ));
  for (const event of [
    "confirmed",
    "changed",
    "cancelled",
    "reminder",
  ] as const) {
    for (const hasEmail of [true, false])
      it(`${event}, email=${hasEmail}: one segment without a link or auto-assigned staff`, () => {
        const body = customerBookingSms({
          event,
          hasEmail,
          shop: "Zhi Zi Massage",
          when: "Sep 24 11am",
          service: "Swedish Massage 60 min",
        });
        expect(measure(body)).toMatchObject({ encoding: "GSM-7", segments: 1 });
        expect(body.toLowerCase()).toContain("call store");
        expect(body).not.toMatch(/https?:|geniefront\.com|With |AI/);
        expect(body.includes("email")).toBe(hasEmail);
        expect(withComplianceFooter(body)).toBe(body);
      });
  }
  for (const event of ["created", "changed", "cancelled"] as const) {
    for (const domain of ["desk.geniefront.com", "staging-desk.geniefront.com"])
      it(`${event} owner on ${domain}: intact link, no price, one part`, () => {
        const link = staffBookingShortUrl("0123456789abcdef", {
          APP_BASE_URL: `https://${domain}`,
        });
        const body = shopBookingSms({
          event,
          customer: "Élodie ^[] ".repeat(10),
          when: "Sep 24 11:30am",
          oldWhen: "Sep 23 12:30pm",
          guests: 12,
          preferredStaff: "Sophie".repeat(10),
          link,
        });
        expect(measure(body)).toMatchObject({ encoding: "GSM-7", segments: 1 });
        expect(body).toContain(`${domain}/b/0123456789abcdef`);
        expect(body).not.toContain("$");
        expect(withComplianceFooter(body)).toBe(body);
      });
  }
  it("keeps requested staff when it fits; normal and voice bookings use the same text", () => {
    expect(
      customerBookingSms({
        event: "confirmed",
        shop: "Spa",
        when: "Sep 24 11am",
        preferredStaff: "Lucy",
      }),
    ).toContain("With Lucy.");
    const body = customerBookingSms({
      event: "changed",
      shop: "^[]".repeat(100),
      service: "é精油".repeat(100),
      preferredStaff: "[]".repeat(100),
      when: "Sep 24 11:30am",
      hasEmail: true,
    });
    expect(measure(body)).toMatchObject({ encoding: "GSM-7", segments: 1 });
  });
});
