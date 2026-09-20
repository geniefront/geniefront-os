/** Local-only booking acceptance preview. Does not start production background jobs. */
import { loadEnv } from "../vitest.shared";
const env = loadEnv({ database: true });
if (!["127.0.0.1", "localhost"].includes(new URL(env.DATABASE_URL!).hostname))
  throw new Error("Local isolated database required");
Object.assign(process.env, env, {
  NODE_ENV: "test",
  GF_ENV: "local",
  BOOKING_PAGE_ORIGIN: "http://127.0.0.1:5186",
  LOG_LEVEL: "warn",
  COMMUNICATION_DELIVERY_MODE: "capture",
  TURNSTILE_SITE_KEY: "",
  BOOKING_MANAGE_PAGE_ENABLED: "1",
});
const { withTenant } = await import("../packages/db/src/index");
const { buildServer } = await import("../apps/api/src/server");
const { __setTurnstileVerifierForTests } = await import(
  "../apps/api/src/public/turnstile"
);
__setTurnstileVerifierForTests(async () => true);
const tenant = {
  orgId: "11111111-1111-4111-8111-111111111111",
  locationId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  membershipId: null,
};
const rows = await withTenant(tenant, async (tx) => {
  await tx`update locations set email='booking-shop@example.invalid',
    settings=jsonb_set(settings,'{public_booking_profile}',coalesce(settings->'public_booking_profile','{}')||'{"description":"Local acceptance test salon","arrivalInstructions":"Use the main entrance. Test data only.","shopNotifications":{"email":true,"sms":false}}'::jsonb,true)
    where id=${tenant.locationId}`;
  for (const event of [
    "appointment_changed",
    "appointment_cancelled",
    "appointment_reminder",
  ]) {
    await tx`insert into notification_rules(org_id,location_id,event_key,enabled,channels,offset_min)
      values(${tenant.orgId},${tenant.locationId},${event},true,array['email','sms'],0)
      on conflict(location_id,event_key) do update set enabled=true,channels=excluded.channels`;
  }

  await tx`update locations set settings=jsonb_set(settings,'{online_booking}',coalesce(settings->'online_booking','{}')||'{"enabled":true,"min_minutes_ahead":0}'::jsonb,true) where id=${tenant.locationId}`;
  return tx<
    { slug: string }[]
  >`select slug from locations where id=${tenant.locationId}`;
});
const app = buildServer();
await app.listen({ host: "127.0.0.1", port: 3106 });
console.log(`Local test booking: http://127.0.0.1:5186/${rows[0]!.slug}`);
