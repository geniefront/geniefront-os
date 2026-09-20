import { beforeEach, afterAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { withTenant, closeDb } from "@gf/db";
import { flushSms } from "./sms/flush";
const send = vi.hoisted(() => vi.fn());
vi.mock("./sms/send", async () => ({
  ...(await vi.importActual("./sms/send")),
  sendSms: send,
  smsConfigured: () => true,
}));
const tenant = {
  orgId: "11111111-1111-4111-8111-111111111111",
  locationId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  membershipId: null,
};
beforeEach(async () => {
  send.mockReset();
  await withTenant(
    tenant,
    (tx) =>
      tx`update sms_outbox set status='suppressed' where location_id=${tenant.locationId} and status='pending'`,
  );
});
afterAll(closeDb);
async function enqueue() {
  const id = randomUUID();
  await withTenant(
    tenant,
    (
      tx,
    ) => tx`insert into sms_outbox(id,org_id,location_id,kind,to_e164,from_e164,body,segments,entity_type,entity_id)
 values(${id},${tenant.orgId},${tenant.locationId},'appointment_confirm','+16175550199','+18005550199','Test confirmation',1,'test',${id})`,
  );
  return id;
}
it("concurrent flushes claim a message exactly once", async () => {
  const id = await enqueue();
  send.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 20));
    return { ok: true, captured: true };
  });
  await Promise.all([flushSms(tenant), flushSms(tenant)]);
  expect(send).toHaveBeenCalledTimes(1);
  const [row] = await withTenant(
    tenant,
    (tx) => tx`select status,attempts from sms_outbox where id=${id}`,
  );
  expect(row).toMatchObject({ status: "captured", attempts: 1 });
});
it("ambiguous network outcome is not automatically resent", async () => {
  const id = await enqueue();
  send.mockResolvedValue({
    ok: false,
    ambiguous: true,
    error: "network_timeout",
  });
  await flushSms(tenant);
  await flushSms(tenant);
  expect(send).toHaveBeenCalledTimes(1);
  const [row] = await withTenant(
    tenant,
    (tx) => tx`select status from sms_outbox where id=${id}`,
  );
  expect(row!.status).toBe("uncertain");
});
it("abandoned claims are discovered and quarantined without resending", async () => {
  const id = await enqueue();
  await withTenant(
    tenant,
    (tx) =>
      tx`update sms_outbox set status='sending',claim_id=${randomUUID()},claimed_at=now()-interval '6 minutes' where id=${id}`,
  );
  await flushSms(tenant);
  expect(send).not.toHaveBeenCalled();
  const [row] = await withTenant(
    tenant,
    (tx) => tx`select status from sms_outbox where id=${id}`,
  );
  expect(row!.status).toBe("uncertain");
});
