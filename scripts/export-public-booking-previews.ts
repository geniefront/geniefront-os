import { loadEnv } from "../vitest.shared";
import { mkdir, writeFile } from "node:fs/promises";
Object.assign(process.env, loadEnv({ database: true }),{GF_ENV:"local",COMMUNICATION_DELIVERY_MODE:"capture"});
if (
  !["127.0.0.1", "localhost"].includes(
    new URL(process.env.DATABASE_URL!).hostname,
  )
)
  throw new Error("Local test database required");
const { withTenant, closeDb } = await import("../packages/db/src/index");
const tenant = {
  orgId: "11111111-1111-4111-8111-111111111111",
  locationId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  membershipId: null,
};
const {flushEmails}=await import('../apps/api/src/email/flush');
const {flushSms}=await import('../apps/api/src/sms/flush');
for(let i=0;i<3;i++)await Promise.all([flushEmails(tenant),flushSms(tenant)]);
const latest=await withTenant(tenant,tx=>tx<{id:string}[]>`select distinct on (c.email) a.id from appointments a join customers c on c.id=a.customer_id
 where a.location_id=${tenant.locationId} and c.email like 'booking-%@example.invalid' order by c.email,a.created_at desc`);
const latestIds=latest.map(r=>r.id);
const target = "artifacts/public-booking/notifications";
await mkdir(target, { recursive: true });
const scrub = (value: string) =>
  value.replace(/mt_[A-Za-z0-9_-]+/g, "mt_TEST_PREVIEW");
const rows = await withTenant(
  tenant,
  (tx) => tx<
    {
      id: string;
      subject: string;
      body_html: string;
      body_text: string;
      to_email: string;
      entity_type: string;
      status: string;
    }[]
  >`
 select id,subject,body_html,body_text,to_email,entity_type,status from email_outbox
 where location_id=${tenant.locationId} and entity_id=any(${latestIds}) and to_email like 'booking-%@example.invalid' order by created_at,id`,
);
const manifest = [];
for (const [i, row] of rows.entries()) {
  const name = `email-${String(i + 1).padStart(2, "0")}`;
  await writeFile(`${target}/${name}.html`, scrub(row.body_html));
  await writeFile(`${target}/${name}.txt`, scrub(row.body_text));
  manifest.push({
    file: `${name}.html`,
    recipient: row.to_email,
    event: row.entity_type,
    subject: row.subject,
    status: row.status,
  });
}
const sms = await withTenant(
  tenant,
  (
    tx,
  ) => tx`select body,status,kind,entity_type from sms_outbox where location_id=${tenant.locationId} and entity_id=any(${latestIds})
 and to_e164 in ('+16175550191','+16175550192') order by created_at,id`,
);
await writeFile(`${target}/sms.json`, scrub(JSON.stringify(sms, null, 2)));
await writeFile(`${target}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log(
  `Exported ${rows.length} email previews and ${sms.length} SMS records (test recipients only; management tokens redacted).`,
);
await closeDb();
