import type postgres from 'postgres';
import { QA_PASSWORD } from './types';
import { qaUuid } from './ids';

const SB_URL = process.env.SUPABASE_URL ?? process.env.TEST_SUPABASE_URL ?? '';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ?? '';

export async function upsertQaAuthUser(email: string, fullName: string, password = QA_PASSWORD): Promise<string> {
  if (process.env.SEED_SKIP_AUTH === '1') {
    return qaUuid(`auth:${email.toLowerCase()}`);
  }
  if (!SB_URL || !SB_KEY) {
    throw new Error('QA seed needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or SEED_SKIP_AUTH=1');
  }
  const h = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json',
  };
  const found = await fetch(
    `${SB_URL}/auth/v1/admin/users?filter=${encodeURIComponent(email)}`,
    { headers: h },
  ).then((r) => r.json() as Promise<{ users?: Array<{ id: string; email: string }> }>);
  const hit = found.users?.find((u) => u.email === email);
  if (hit) {
    await fetch(`${SB_URL}/auth/v1/admin/users/${hit.id}`, {
      method: 'PUT', headers: h,
      body: JSON.stringify({ password, email_confirm: true }),
    });
    return hit.id;
  }
  const created = await fetch(`${SB_URL}/auth/v1/admin/users`, {
    method: 'POST', headers: h,
    body: JSON.stringify({
      email, password, email_confirm: true,
      user_metadata: { full_name: fullName },
    }),
  }).then((r) => r.json() as Promise<{ id?: string; msg?: string; message?: string }>);
  if (!created.id) throw new Error(`QA auth user failed ${email}: ${created.msg ?? created.message}`);
  return created.id;
}

export async function insertLocalAuthIdentity(
  tx: postgres.TransactionSql,
  args: { userId: string; email: string; fullName: string; password?: string | undefined },
): Promise<void> {
  if (process.env.SEED_SKIP_AUTH !== '1') return;
  const J = (v: unknown) => tx.json(v as never);
  await tx`insert into auth.users
    (instance_id, id, aud, role, email, encrypted_password,
     email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
     created_at, updated_at, confirmation_token, recovery_token,
     email_change_token_new, email_change, email_change_token_current,
     phone_change, phone_change_token, reauthentication_token,
     email_change_confirm_status)
    values
    ('00000000-0000-0000-0000-000000000000', ${args.userId},
     'authenticated', 'authenticated', ${args.email},
     crypt(${args.password ?? QA_PASSWORD}, gen_salt('bf')), now(),
     ${J({ provider: 'email', providers: ['email'] })},
     ${J({ full_name: args.fullName })}, now(), now(), '', '', '', '', '',
     '', '', '', 0)
    on conflict (id) do update set
      aud = excluded.aud,
      role = excluded.role,
      email = excluded.email,
      encrypted_password = excluded.encrypted_password,
      email_confirmed_at = excluded.email_confirmed_at,
      raw_app_meta_data = excluded.raw_app_meta_data,
      raw_user_meta_data = excluded.raw_user_meta_data,
      updated_at = excluded.updated_at`;
  await tx`insert into auth.identities
    (provider_id, user_id, identity_data, provider,
     last_sign_in_at, created_at, updated_at)
    values
    (${args.userId}, ${args.userId},
     ${J({ sub: args.userId, email: args.email, email_verified: true, phone_verified: false })},
     'email', now(), now(), now())
    on conflict (provider_id, provider) do update set
      user_id = excluded.user_id,
      identity_data = excluded.identity_data,
      updated_at = excluded.updated_at`;
}
