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

describe('shared multi-specialist services', () => {
  const couple = { ...item(0), guestIndices: [0,1], staffCount: 2, priceCents: 12000 };
  it('returns one priced service with two distinct simultaneous specialists', () => {
    const plan = planPartyAt({ ...base, items: [couple] });
    expect(plan).toHaveLength(1);
    expect(plan![0]).toMatchObject({ priceCents: 12000, guestIndices: [0,1], startsAt: at(10).toISOString(), endsAt: at(11).toISOString() });
    expect(new Set([plan![0]!.staffId, ...plan![0]!.additionalStaffIds!]).size).toBe(2);
  });
  it('never substitutes overbooking or an unassigned place for the second specialist', () => {
    expect(planPartyAt({ ...base, items: [couple], staff: base.staff.slice(0,1), allowUnassigned: true, unassignedLimit: 3, locationLimit: 4 })).toBeNull();
    expect(planPartyAt({ ...base, items: [couple], locationLimit: 1 })).toBeNull();
    expect(planPartyAt({ ...base, items: [{ ...couple, eligibleStaffIds: ['a'] }] })).toBeNull();
    expect(planPartyAt({ ...base, items: [couple], existing: [{ membershipId: 'b', startsAt: at(10), endsAt: at(11) }] })).toBeNull();
  });
  it('starts both guests subsequent services after their shared service', () => {
    const plan = planPartyAt({ ...base, items: [couple, item(0), item(1)] });
    expect(plan?.map(p=>p.startsAt)).toEqual([at(10),at(11),at(11)].map(d=>d.toISOString()));
  });
  it('holds one shared room with sufficient capacity and specialist space', () => {
    const resource = {id:'room',typeId:'couples',capacity:2,maxStaff:2,busy:[]};
    const args = {...base, items:[{...couple,resourceTypeId:'couples'}]};
    expect(planPartyAt({...args,resources:[resource]})?.[0]?.resourceId).toBe('room');
    expect(planPartyAt({...args,resources:[{...resource,capacity:1}]})).toBeNull();
    expect(planPartyAt({...args,resources:[{...resource,maxStaff:1}]})).toBeNull();
  });
});
