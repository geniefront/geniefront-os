import { describe, expect, it } from "vitest";
import { planPartyAt, type PartyItem } from "./partyPlan";
const at = (h: number) =>
  new Date(`2026-10-01T${String(h).padStart(2, "0")}:00:00Z`);
const item = (
  guestIndex: number,
  eligibleStaffIds = ["a", "b"],
): PartyItem => ({
  guestIndex,
  serviceId: "service",
  addonIds: [],
  durationMin: 60,
  priceCents: 5000,
  staffId: null,
  eligibleStaffIds,
});
const base = {
  startsAt: at(10),
  closesAt: at(18),
  staff: ["a", "b"].map((id) => ({ id, startsAt: at(9), endsAt: at(18) })),
  existing: [],
  locationLimit: 2,
};
describe("public party plan", () => {
  it("sequences each guest independently and backtracks for qualifications", () => {
    const plan = planPartyAt({
      ...base,
      items: [item(0), item(0), item(1, ["a"]), item(1, ["a"])],
    });
    expect(plan?.map((p) => [p.guestIndex, p.staffId, p.startsAt])).toEqual([
      [0, "b", at(10).toISOString()],
      [0, "b", at(11).toISOString()],
      [1, "a", at(10).toISOString()],
      [1, "a", at(11).toISOString()],
    ]);
  });
  it("does not promise the same specialist to simultaneous guests", () => {
    expect(
      planPartyAt({ ...base, items: [item(0, ["a"]), item(1, ["a"])] }),
    ).toBeNull();
  });
  it("checks later items, capacity, existing bookings and shifts", () => {
    expect(
      planPartyAt({ ...base, items: [item(0), item(1)], locationLimit: 1 }),
    ).toBeNull();
    expect(
      planPartyAt({ ...base, items: [item(0), item(0)], closesAt: at(11) }),
    ).toBeNull();
    expect(
      planPartyAt({
        ...base,
        items: [item(0, ["a"]), item(0, ["a"])],
        existing: [{ membershipId: "a", startsAt: at(11), endsAt: at(12) }],
      }),
    ).toBeNull();
    expect(
      planPartyAt({
        ...base,
        items: [item(0)],
        staff: [{ id: "a", startsAt: at(11), endsAt: at(18) }],
      }),
    ).toBeNull();
  });
  it("permits sequential services without double-counting the guest", () => {
    expect(
      planPartyAt({ ...base, items: [item(0), item(0)], locationLimit: 1 }),
    ).toHaveLength(2);
  });
});

it("reserves physical resources per guest and obeys distinct-staff limits", () => {
  const items = [
    { ...item(0), resourceTypeId: "room" },
    { ...item(1), resourceTypeId: "room" },
  ];
  const room = {
    id: "r",
    typeId: "room",
    capacity: 1,
    maxStaff: null,
    busy: [],
  };
  expect(planPartyAt({ ...base, items, resources: [room] })).toBeNull();
  expect(
    planPartyAt({ ...base, items, resources: [{ ...room, capacity: 2 }] }),
  ).toHaveLength(2);
  expect(
    planPartyAt({
      ...base,
      items,
      resources: [{ ...room, capacity: 2, maxStaff: 1 }],
    }),
  ).toBeNull();
  expect(
    planPartyAt({
      ...base,
      items: [items[0]!],
      resources: [
        {
          ...room,
          busy: [{ startsAt: at(9), endsAt: at(11), membershipId: null }],
        },
      ],
    }),
  ).toBeNull();
});

it('uses elapsed duration across daylight saving changes',()=>{
 const startsAt=new Date('2026-03-08T06:30:00Z');
 const plan=planPartyAt({...base,startsAt,closesAt:new Date('2026-03-08T12:00:00Z'),items:[{...item(0),durationMin:90}],
   staff:[{id:'a',startsAt:new Date('2026-03-08T05:00:00Z'),endsAt:new Date('2026-03-08T12:00:00Z')}]});
 expect(plan?.[0]?.endsAt).toBe('2026-03-08T08:00:00.000Z');
});

it('uses the other free specialist, then only one unassigned extra slot',()=>{
 const busy=[{startsAt:at(10),endsAt:at(11),membershipId:'a',groupKey:'a'}];
 const input={...base,locationLimit:3,allowUnassigned:true,items:[item(0)],existing:busy};
 expect(planPartyAt(input)?.[0]?.staffId).toBe('b');
 busy.push({startsAt:at(10),endsAt:at(11),membershipId:'b',groupKey:'b'});
 expect(planPartyAt(input)?.[0]?.staffId).toBeNull();
 expect(planPartyAt({...input,items:[{...item(0),staffId:'a'}]})).toBeNull();
 expect(planPartyAt({...input,existing:[...busy,{startsAt:at(10),endsAt:at(11),membershipId:null,groupKey:'extra'}]})).toBeNull();
});
