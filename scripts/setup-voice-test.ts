/** Explicit, repeatable staging-only provisioning. No real customer data is reset. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { adminSql } from '../packages/db/src/admin';
import { closeDb, withTenant } from '../packages/db/src/index';
import { PERMISSIONS, type CommandContext } from '../packages/contracts/src/index';
import { createStoreByOperator } from '../apps/api/src/platform/storeCommands';
import { dispatch } from '../apps/api/src/bus';
import { buildServer } from '../apps/api/src/server';

if (process.env.GF_ENV !== 'staging') throw new Error('This setup only targets staging');
const email = process.env.VOICE_TEST_EMAIL;
const contact = process.env.VOICE_TEST_CONTACT;
const phone = process.env.VOICE_TEST_PHONE;
if (!email || !contact || !phone) throw new Error('VOICE_TEST_EMAIL, VOICE_TEST_CONTACT and VOICE_TEST_PHONE are required');
const app = buildServer();
try {
  const [op] = await adminSql<{ user_id: string; id: string }[]>`
    select user_id,id from platform_operators where role='super_admin' and status='active' and revoked_at is null limit 1`;
  if (!op) throw new Error('No active staging operator');
  const store = await createStoreByOperator({ userId: op.user_id, operatorId: op.id, role: 'super_admin', email: null }, {
    shopName: 'Zhi Zi Voice Test', ownerEmail: email, plan: 'voice_booking', durationDays: 30,
    businessType: 'massage', timezone: 'America/New_York', locale: 'zh-Hans', phone: contact,
    paymentNote: 'User-authorized xAI integration test; no payment collected', sendActivation: false,
  }, app.log);
  const context = (orgId: string, locationId: string): CommandContext => ({ orgId, locationId,
    userId: op.user_id, membershipId: null, actorKind: 'api', locale: 'en', timezone: 'America/New_York', permissions: new Set(PERMISSIONS) });
  const ctx = context(store.orgId, store.locationId);
  const [old] = await adminSql<{ org_id: string; location_id: string }[]>`
    select org_id,location_id from phone_lines where e164=${phone} and active and purpose='ai_voice'`;
  if (old && old.location_id !== store.locationId) {
    // Only move the known disposable regression fixture; never repoint an arbitrary store.
    if (old.location_id !== 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb') throw new Error('Phone belongs to another non-fixture store');
    await dispatch('location.savePhoneLine', { e164: phone, purpose: 'ai_voice', active: false },
      context(old.org_id, old.location_id), { systemOrigin: 'voice_test_setup' });
  }
  const binding = await dispatch<{ toolToken: string | null }>('location.savePhoneLine', {
    e164: phone, purpose: 'ai_voice', active: true, assistantId: 'agent_IgbIjsohua8ketED', aiAnswer: true,
  }, ctx, { systemOrigin: 'voice_test_setup' });
  await dispatch('location.savePhoneLine', { e164: contact, purpose: 'transfer_target', active: true }, ctx,
    { systemOrigin: 'voice_test_setup' });
  await dispatch('location.saveProfile', { name: { en: 'Zhi Zi Voice Test', 'zh-Hans': '栀子语音测试店' },
    email, phone: contact, appointmentEmailCopyToShop: true }, ctx);
  await dispatch('location.saveHours', { hours: Object.fromEntries(['mon','tue','wed','thu','fri','sat','sun']
    .map(d => [d, { open: '09:00', close: '21:00' }])) }, ctx);
  await dispatch('location.saveBookingPolicy', { mode: 'location', baseCapacity: 2,
    bufferEnabled: false, bufferExtra: 1, requestBufferEnabled: false, requestBufferExtra: 1 }, ctx);
  for (const [name, price] of [['Relaxation Massage', 6500], ['Deep Tissue Massage', 7000]] as const) {
    const exists = await withTenant(ctx, tx => tx<{ id: string }[]>`
      select id from services where location_id=${store.locationId} and name->>'en'=${name}`);
    if (!exists.length) await dispatch('catalog.saveService', { name: { en: name }, durationMin: 60,
      basePriceCents: price, active: true, onlineBookable: true, staffCount: 1 }, ctx);
  }
  await dispatch('settings.saveSetupFeatures', { healthFormsEnabled: false, aiVoiceRequested: true, confirmSetup: true }, ctx);
  const rolesReady = await withTenant(ctx, tx => tx`select id from roles where location_id=${store.locationId} and key='tech'`);
  for (const displayName of rolesReady.length ? ['Alex (Test)', 'Jamie (Test)'] : []) {
    const exists = await withTenant(ctx, tx => tx`select membership_id from staff_profiles where location_id=${store.locationId} and display_name->>'en'=${displayName}`);
    if (!exists.length) await dispatch('staff.add', { displayName, roleKeys: ['tech'], isBookable: true,
      maxConcurrentAppointments: 1, inRotation: false }, ctx);
  }
  await dispatch('location.finishSetup', {}, ctx);
  await mkdir('.assistant-backups', { recursive: true });
  const file = '.assistant-backups/voice-test.json';
  const previous = await readFile(file, 'utf8').then(JSON.parse).catch(() => ({}));
  await writeFile(file, JSON.stringify({ ...store, phone, email, contact,
    toolToken: binding.result.toolToken ?? previous.toolToken }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ locationId: store.locationId, orgId: store.orgId, phone,
    plan: 'voice_booking', baseCapacity: 2, bufferEnabled: false, toolCredentialSaved: true }));
} finally { await app.close(); await closeDb(); await adminSql.end(); }
