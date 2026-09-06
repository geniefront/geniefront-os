import type postgres from 'postgres';
import { QA_SEED_MARKER } from './types';

const LOCATION_SCOPED = new Set([
  'stripe_events', 'user_last_location',
  'location_webhooks', 'location_10dlc_registrations', 'location_intake_templates',
  'location_scheduling_rules', 'location_checkout_settings',
]);

/** Platform-wide tables with no org_id / location_id. Seed V2 does not write them. */
const SKIP_TENANT_DELETE = new Set(['sms_inbound', 'sms_consent']);

const TABLES_IN_ORDER = [
  'ai_business_summaries',
  'support_request_notes', 'support_requests',
  'day_close_events', 'ticket_refunds', 'ticket_service_notes', 'resource_occupancies',
  'in_app_notifications', 'user_notification_preferences', 'user_device_sessions',
  'location_webhooks', 'location_10dlc_registrations', 'location_intake_templates',
  'location_scheduling_rules', 'location_checkout_settings',
  'customer_credit_ledger', 'customer_packages', 'package_templates', 'coupon_templates',
  'gift_cards', 'gift_card_templates',
  'earnings', 'tip_payouts', 'cash_movements', 'day_closes',
  'tip_allocations', 'payments', 'ticket_discounts', 'ticket_item_staff', 'ticket_items',
  'tickets', 'ticket_groups', 'tip_policies',
  'time_punches', 'staff_sessions', 'booking_manage_attempts',
  'form_access_log', 'form_submissions', 'form_share_links', 'form_templates',
  'walkin_queue',
  'call_drafts', 'phone_calls', 'phone_lines', 'sms_inbound', 'sms_consent', 'sms_outbox', 'email_outbox',
  'credit_ledger', 'usage_events', 'stripe_events', 'billing_invoices', 'billing_accounts',
  'location_subscriptions',
  'pairing_sessions', 'discount_reasons', 'notification_rules', 'notification_templates',
  'storefront_revisions', 'storefront_drafts', 'storefront_briefs',
  'blueprint_items', 'blueprint_sources', 'shop_blueprints',
  'location_reviews', 'location_review_stats', 'review_summaries',
  'shifts', 'shift_templates', 'compensation_plans',
  'appointment_item_blocks', 'appointment_items', 'appointments',
  'rotation_events', 'rotation_participants', 'rotation_policies',
  'customer_preferences', 'customers',
  'service_option_defs', 'services', 'service_categories',
  'resources', 'resource_types',
  'staff_profiles', 'staff_skills', 'skills', 'staff_levels', 'staff_job_titles',
  'device_tokens', 'membership_roles', 'permission_overrides',
  'memberships', 'role_permissions', 'roles',
  'user_last_location',
  'signup_intents',
  'location_allowed_origins', 'location_features',
  'locations',
] as const;

const QA_EMAIL_LIKE = 'qa-%@maildrop.cc';
/**
 * 2026-09-01 之前 QA 账号用的是 `qa+…@example.test`。
 *
 * ⚠️ 不一并清的话，域名切换之后第一遍重置只匹配新样式，旧的 QA 用户原样留在
 * `users` / `auth.users` 里 —— 它们仍带着 membership 与角色，表现是「某条命令
 * 莫名其妙 PERMISSION_DENIED」，而现象与 QA 重置毫无关联。
 *
 * 这一条可在所有环境重置过一遍之后删除。
 */
const QA_EMAIL_LIKE_LEGACY = 'qa+%@example.test';

export async function enableSeedReset(tx: postgres.TransactionSql): Promise<void> {
  await tx`select set_config('app.seed_reset', 'on', true)`;
  await tx`
    create or replace function gf_ccl_append_only() returns trigger
    language plpgsql as $$
    begin
      if current_user = 'app_user' then
        raise exception '客人资产账本只能追加：要冲销就插一条 reversal_of_id 指过去的反向记录'
          using errcode = 'restrict_violation';
      end if;
      return old;
    end $$`;
}

export async function loadQaOrgIds(
  tx: postgres.TransactionSql,
): Promise<{ orgs: string[]; locs: string[] }> {
  const rows = await tx<{ org_id: string; location_id: string }[]>`
    select org_id, id as location_id
    from locations
    where settings->>'qa_seed' = ${QA_SEED_MARKER}`;
  return {
    orgs: [...new Set(rows.map((r) => r.org_id))],
    locs: rows.map((r) => r.location_id),
  };
}

export async function wipeQaTenants(tx: postgres.TransactionSql): Promise<void> {
  await enableSeedReset(tx);
  const { orgs, locs } = await loadQaOrgIds(tx);

  if (orgs.length > 0) {
    for (const t of TABLES_IN_ORDER) {
      if (SKIP_TENANT_DELETE.has(t)) continue;
      if (t === 'staff_skills' || t === 'membership_roles' || t === 'permission_overrides') {
        await tx.unsafe(
          `delete from ${t} where membership_id in (select id from memberships where org_id = any($1))`,
          [orgs as never],
        );
      } else if (t === 'role_permissions') {
        await tx.unsafe(
          `delete from ${t} where role_id in (select id from roles where org_id = any($1))`,
          [orgs as never],
        );
      } else if (t === 'user_notification_preferences' || t === 'user_device_sessions') {
        await tx.unsafe(
          `delete from ${t} where user_id in (select user_id from memberships where org_id = any($1))`,
          [orgs as never],
        );
      } else if (LOCATION_SCOPED.has(t)) {
        if (locs.length > 0) {
          await tx.unsafe(`delete from ${t} where location_id = any($1)`, [locs as never]);
        }
      } else if (t === 'locations') {
        await tx.unsafe(`delete from ${t} where org_id = any($1)`, [orgs as never]);
      } else {
        await tx.unsafe(`delete from ${t} where org_id = any($1)`, [orgs as never]);
      }
    }
    await tx`delete from organizations where id = any(${orgs})`;
  }

  await tx`delete from platform_operators where notes = 'qa-seed-v2'`;

  const qaUsers = await tx<{ id: string }[]>`
    select id from users
    where lower(email) like ${QA_EMAIL_LIKE} or lower(email) like ${QA_EMAIL_LIKE_LEGACY}`;
  const userIds = qaUsers.map((u) => u.id);
  if (userIds.length > 0) {
    await tx`delete from user_last_location where user_id = any(${userIds})`;
    await tx`delete from users where id = any(${userIds})`;
  }
  if (process.env.SEED_SKIP_AUTH === '1') {
    await tx`delete from auth.identities
      where user_id in (
        select id from auth.users
        where lower(email) like ${QA_EMAIL_LIKE} or lower(email) like ${QA_EMAIL_LIKE_LEGACY})`;
    await tx`delete from auth.users
             where lower(email) like ${QA_EMAIL_LIKE} or lower(email) like ${QA_EMAIL_LIKE_LEGACY}`;
  }
}
