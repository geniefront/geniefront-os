import { describe, it, expect } from "vitest";
import { compactWhen, customerBookingSms, shopBookingSms, shopCompactWhen, shopCallSms } from "./booking";
import { measure } from "./segments";
import { renderConfirmSms, withComplianceFooter } from "./render";
import { OWNER_LOCALES } from '../email/locale';

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
  for (const locale of OWNER_LOCALES) for (const event of ['created','changed','cancelled','assigned','pending'] as const) {
    it(`${locale} ${event}: owner identity, all services and phone, no links or opt-out suffix`,()=>{
      const body=shopBookingSms({locale,event,customer:'Amy',phone:'+16175550123',when:shopCompactWhen('2026-09-22T18:30:00Z','America/New_York',locale),guests:2,services:'1:深层60分+热石; 2:足疗30分'});
      expect(body).toMatch(/^GF: /);expect(body).toContain('Amy 6175550123');
      expect(body).toContain('1:深层60分+热石; 2:足疗30分');
      expect(body).not.toMatch(/STOP|https?:|geniefront\.com/);
    });
  }
  it('keeps a short Chinese notice in one segment and preserves long notices intact',()=>{
    const base={locale:'zh-Hans' as const,event:'created' as const,customer:'Amy',phone:'+16175550123',when:'9/22 14:30',guests:1,services:'深层60分+热石',preferredStaff:'Lisa'};
    expect(measure(shopBookingSms(base)).segments).toBe(1);
    const services=Array.from({length:10},(_,i)=>`${i+1}:深层60分+热石`).join('; ');
    const body=shopBookingSms({...base,services,phone:'+442079460123'});
    expect(body).toContain(services);expect(body).toContain('+442079460123');expect(measure(body).segments).toBeGreaterThan(1);
  });
  it('renders original and new service lists without an invented old appointment time',()=>{
    const body=shopBookingSms({event:'services_changed',locale:'zh-Hans',customer:'Amy',when:'9/22 14:30',oldServices:'足疗30分',services:'深层60分+热石'});
    expect(body).toContain('项目变更');expect(body).toContain('原: 足疗30分');expect(body).toContain('现: 深层60分+热石');
    expect(body).not.toContain('undefined');
  });
  it('localizes call notices and retains the caller number',()=>{
    expect(shopCallSms('zh-Hant','+16175550123')).toContain('來電');
    expect(shopCallSms('en','+16175550123')).toContain('6175550123');
    expect(shopCallSms('en','+16175550123')).not.toMatch(/STOP|https?:/);
  });
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

it('keeps the reported couples notice within one segment after abbreviating and grouping services',()=>{
 const body=shopBookingSms({event:'created',locale:'zh-Hans',customer:'Naiyou',phone:'+15409980030',guests:2,when:'9/21 16:00',services:'1、2:双人60分+热石'});
 expect(body).toBe('GF: 新预约｜Naiyou 5409980030｜2人\n9/21 16:00\n1、2:双人60分+热石');
 expect(measure(body)).toMatchObject({encoding:'UCS-2',segments:1});
});

for (const event of ['confirmed', 'changed', 'cancelled', 'reminder'] as const) {
  for (const hasEmail of [true, false]) {
    it(`${event}: includes the business phone in one segment, email=${hasEmail}`, () => {
      const body = customerBookingSms({event, hasEmail, shop:'Zhi Zi Massage', shopPhone:'+17574388097', when:'Sep 22 5:30pm', service:'Deep Tissue Massage 60 min', preferredStaff:'Sophie'});
      expect(body).toContain('757-438-8097');
      expect(body).toContain('Reply STOP to opt out.');
      expect(measure(body)).toMatchObject({encoding:'GSM-7', segments:1});
    });
  }
}
it('passes the phone through the confirmation renderer', () => {
  expect(renderConfirmSms({shopName:'Zhi Zi Massage', shopPhone:'+17574388097', serviceName:'Deep Tissue Massage 60 min', whenText:'Sep 22 5:30pm'})).toBe('GenieFront: Zhi Zi Massage. Confirmed Sep 22 5:30pm. Deep Tissue Massage 60 min. Call 757-438-8097. Reply STOP to opt out.');
});
it('preserves full international numbers and counts GSM extension characters', () => {
  const body = customerBookingSms({event:'changed', shop:'[]'.repeat(40), shopPhone:'+442079460123', when:'Sep 22 5:30pm', service:'[]'.repeat(40), preferredStaff:'[]'.repeat(20), hasEmail:true});
  expect(body).toContain('+442079460123');
  expect(measure(body).segments).toBe(1);
});
