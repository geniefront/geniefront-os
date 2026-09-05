/**
 * Regression seed (Lotus Nails + Golden Foot Spa). API integration tests
 * (`apps/api/src/test/resetDatabase.ts`) rebuild this pair before each suite.
 *
 * QA browser scenarios live in `packages/db/src/qa` (Seed V2). Do not grow
 * this file into a universal store. See docs/qa/TEST_DATA_AUDIT.md.
 *
 * 包含过去 14 天完整财务流水与订单、今日活跃看板与排期、以及未来 14 天真实预约表。
 */

import { createHash } from 'node:crypto';
import { adminSql, adminDatabaseSource } from './admin';
import { ROLE_PRESETS } from '@gf/contracts';

const SB_URL = process.env.SUPABASE_URL ?? process.env.TEST_SUPABASE_URL ?? '';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ?? '';
export const DEV_PASSWORD = 'GenieDev!2026';

const publicKeyFor = (locationId: string): string =>
  `pk_${locationId.replace(/-/g, '').slice(0, 24)}`;

const sha256 = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex');

const toolTokenFor = (locationId: string): string => {
  const override = locationId === SPA_LOC
    ? process.env.SEED_SPA_TOOL_TOKEN
    : process.env.SEED_TOOL_TOKEN;
  return override ?? `st_dev_${locationId.replace(/-/g, '')}`;
};

function deterministicUuid(seed: string): string {
  const hash = createHash('md5').update(seed).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function upsertAuthUser(email: string, fullName: string): Promise<string> {
  if (process.env.SEED_SKIP_AUTH === '1') {
    const fixed: Record<string, string> = {
      'owner@maildrop.cc': '196f0ab4-cd94-45cc-8109-2c414e966828',
      'mia@maildrop.cc': 'd84f499d-4100-4791-a0ae-dca645aa2661',
      'ops@maildrop.cc': '33333333-3333-4333-8333-333333333333',
      'exops@maildrop.cc': '44444444-4444-4444-8444-444444444444',
    };
    return fixed[email] ?? deterministicUuid(email);
  }
  const h = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json',
  };
  const found = await fetch(
    `${SB_URL}/auth/v1/admin/users?filter=${encodeURIComponent(email)}`, { headers: h },
  ).then((r) => r.json() as Promise<{ users?: Array<{ id: string; email: string }> }>);
  const hit = found.users?.find((u) => u.email === email);
  if (hit) {
    await fetch(`${SB_URL}/auth/v1/admin/users/${hit.id}`, {
      method: 'PUT', headers: h,
      body: JSON.stringify({ password: DEV_PASSWORD, email_confirm: true }),
    });
    return hit.id;
  }

  const created = await fetch(`${SB_URL}/auth/v1/admin/users`, {
    method: 'POST', headers: h,
    body: JSON.stringify({
      email, password: DEV_PASSWORD, email_confirm: true,
      user_metadata: { full_name: fullName },
    }),
  }).then((r) => r.json() as Promise<{ id?: string; msg?: string; message?: string }>);
  if (!created.id) throw new Error(`建 Auth 用户失败 ${email}: ${created.msg ?? created.message}`);
  return created.id;
}

const NAIL_ORG = '11111111-1111-4111-8111-111111111111';
const SPA_ORG  = '22222222-2222-4222-8222-222222222222';
const NAIL_LOC = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SPA_LOC  = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const SEED_USER_EMAILS = [
  'amy@maildrop.cc',
  'linh@maildrop.cc',
  'kim@maildrop.cc',
  'tran@maildrop.cc',
  'mai@maildrop.cc',
  'mia@maildrop.cc',
  'yan@maildrop.cc',
  'hua@maildrop.cc',
  'bo@maildrop.cc',
  'owner@maildrop.cc',
  'ops@maildrop.cc',
  'exops@maildrop.cc',
] as const;

const OPS_USER = '33333333-3333-4333-8333-333333333333';
const EXOPS_USER = '44444444-4444-4444-8444-444444444444';
const OPS_OPERATOR_ID = '55555555-5555-4555-8555-555555555555';
const EXOPS_OPERATOR_ID = '66666666-6666-4666-8666-666666666666';

const MASSAGE_OPTIONS = [
  {
    key: 'pressure', input: 'scale', sticky: true, to_staff: true, required: true, sort: 1,
    label: { en: 'Pressure', 'zh-Hans': '力度', vi: 'Lực', ko: '강도', es: 'Presión' },
    options: [
      { value: 1, label: { en: 'Very light', 'zh-Hans': '轻柔', vi: 'Rất nhẹ' } },
      { value: 2, label: { en: 'Light', 'zh-Hans': '偏轻', vi: 'Nhẹ' } },
      { value: 3, label: { en: 'Medium', 'zh-Hans': '适中', vi: 'Vừa' } },
      { value: 4, label: { en: 'Firm', 'zh-Hans': '偏重', vi: 'Mạnh' } },
      { value: 5, label: { en: 'Deep', 'zh-Hans': '大力', vi: 'Rất mạnh' } },
    ],
  },
  {
    key: 'focus_areas', input: 'bodymap', sticky: true, to_staff: true, required: false, sort: 2,
    label: { en: 'Focus areas', 'zh-Hans': '重点部位' },
    options: [
      { value: 'neck_shoulder', label: { en: 'Neck & Shoulders', 'zh-Hans': '肩颈' } },
      { value: 'lower_back', label: { en: 'Lower back', 'zh-Hans': '腰部' } },
      { value: 'legs', label: { en: 'Legs', 'zh-Hans': '腿部' } },
      { value: 'feet', label: { en: 'Feet', 'zh-Hans': '脚底' } },
    ],
  },
  {
    key: 'oil_preference', input: 'single', sticky: true, to_staff: true, required: false, sort: 3,
    label: { en: 'Essential Oil', 'zh-Hans': '精油偏好' },
    options: [
      { value: 'lavender', label: { en: 'Lavender (Relaxing)', 'zh-Hans': '薰衣草（舒缓安神）' } },
      { value: 'eucalyptus', label: { en: 'Eucalyptus (Clearing)', 'zh-Hans': '尤加利（通畅清神）' } },
      { value: 'sweet_orange', label: { en: 'Sweet Orange (Uplifting)', 'zh-Hans': '甜橙（焕活愉悦）' } },
      { value: 'unscented', label: { en: 'Unscented', 'zh-Hans': '无香温和油' } },
    ],
  },
];

const NAIL_OPTIONS = [
  {
    key: 'system', input: 'single', sticky: true, to_staff: true, required: true, sort: 1,
    label: { en: 'System', 'zh-Hans': '做法', vi: 'Loại' },
    options: [
      { value: 'polish', label: { en: 'Regular polish', 'zh-Hans': '普通甲油' } },
      { value: 'gel', label: { en: 'Gel', 'zh-Hans': '甲油胶' } },
      { value: 'dip', label: { en: 'Dip / SNS', 'zh-Hans': '浸粉' } },
      { value: 'acrylic', label: { en: 'Acrylic', 'zh-Hans': '水晶' } },
      { value: 'gelx', label: { en: 'Gel-X', 'zh-Hans': 'Gel-X' } },
    ],
  },
  {
    key: 'removal', input: 'single', sticky: false, to_staff: true, required: true, sort: 2,
    label: { en: 'Removal needed?', 'zh-Hans': '是否需要卸甲', vi: 'Cần tháo?' },
    options: [
      { value: 'none', label: { en: 'No removal', 'zh-Hans': '不需要' } },
      { value: 'own', label: { en: 'Remove ours', 'zh-Hans': '卸同款' } },
      { value: 'foreign', label: { en: "Remove other salon's", 'zh-Hans': '卸他店的' } },
    ],
  },
  {
    key: 'shape', input: 'single', sticky: true, to_staff: true, required: false, sort: 3,
    label: { en: 'Shape', 'zh-Hans': '甲型', vi: 'Dáng' },
    options: [
      { value: 'square', label: { en: 'Square', 'zh-Hans': '方' } },
      { value: 'squoval', label: { en: 'Squoval', 'zh-Hans': '方圆' } },
      { value: 'round', label: { en: 'Round', 'zh-Hans': '圆' } },
      { value: 'oval', label: { en: 'Oval', 'zh-Hans': '椭圆' } },
      { value: 'almond', label: { en: 'Almond', 'zh-Hans': '杏仁' } },
    ],
  },
];

async function guardRealNumbers(about: readonly string[]): Promise<void> {
  return;
}

async function main() {
  if (adminDatabaseSource !== 'process') {
    throw new Error(
      'seed 拒绝隐式读取 .env 的 MIGRATION_DATABASE_URL；请在命令中显式传入隔离数据库连接串。',
    );
  }
  console.log('\n═══ 填充真实测试数据（覆盖过去 14 天与未来 14 天） ═══\n');

  console.log('1. 开始数据库事务与清理旧数据...');
  await adminSql.begin(async (tx) => {
    const J = (v: unknown) => tx.json(v as never);

    // 0061 only honors this flag for a non-app_user session.  It lets this
    // explicit seed transaction rebuild the two fixed demo tenants while the
    // runtime role remains unable to alter closed or append-only history.
    await tx`select set_config('app.seed_reset', 'on', true)`;

    const orgs = [NAIL_ORG, SPA_ORG];
    const locs = [NAIL_LOC, SPA_LOC];
    const LOCATION_SCOPED = new Set([
      'stripe_events', 'user_last_location', 'pairing_sessions',
      'location_webhooks', 'location_10dlc_registrations', 'location_intake_templates',
      'location_scheduling_rules', 'location_checkout_settings',
    ]);

    await tx`
      create or replace function gf_ccl_append_only() returns trigger
      language plpgsql as $$
      begin
        if current_user = 'app_user' then
          raise exception '客人资产账本只能追加：要冲销就插一条 reversal_of_id 指过去的反向记录'
            using errcode = 'restrict_violation';
        end if;
        return old;
      end $$;`;

    // 1. 幂等倒序清理
    for (const t of [
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
      'email_sender_settings', 'email_domain_requests', 'email_accounts', 'email_validation_cache',
      'form_access_log', 'form_submissions', 'form_share_links', 'form_templates',
      'walkin_queue',
      'call_drafts', 'phone_calls', 'phone_lines', 'sms_inbound', 'sms_consent', 'sms_outbox', 'email_outbox',
      'credit_ledger', 'usage_events', 'stripe_events', 'billing_invoices', 'billing_accounts', 'location_subscriptions',
      'pairing_sessions', 'discount_reasons', 'notification_rules', 'notification_templates',
      'storefront_revisions', 'storefront_drafts', 'storefront_briefs', 'blueprint_items', 'blueprint_sources', 'shop_blueprints',
      'location_reviews', 'location_review_stats', 'review_summaries',
      'shifts', 'shift_templates', 'compensation_plans',
      'appointment_item_blocks', 'appointment_items', 'appointments',
      'rotation_events', 'rotation_participants', 'rotation_policies',
      'customer_preferences', 'customers',
      'service_option_defs', 'services', 'service_categories',
      'resources', 'resource_types',
      'staff_profiles', 'staff_skills', 'skills', 'staff_levels',
      'device_tokens', 'membership_roles', 'permission_overrides',
      'memberships', 'role_permissions', 'roles',
      'user_last_location',
      'platform_operators',
      '__users__',
      'location_allowed_origins', 'location_features', 'signup_intents',
      'locations',
    ]) {
      console.log('Cleaning table:', t);
      if (t === 'platform_operators') {
        await tx`delete from platform_operators`;
      } else if (t === '__users__') {
        // Only remove identities owned by this seed. Other isolated utilities
        // (for example setup:test:reset) also use @maildrop.cc and may still
        // have valid memberships outside the two fixed demo organizations.
        //
        // ⚠️ LEGACY_SEED_USER_EMAILS 是 2026-09-01 之前的 @example.test 版本。
        //    不一并删的话，那次域名切换之后第一遍重跑种子只会删掉新地址，旧的
        //    users / auth.users 行原样留下 —— 它们仍带着 membership 与角色，
        //    表现是「某条命令莫名其妙 PERMISSION_DENIED」，而现象与种子无关，
        //    排查方向会整个跑偏。这一段可在所有环境重跑过一遍之后删除。
        const legacy = SEED_USER_EMAILS.map((e) => e.replace(/@maildrop\.cc$/, '@example.test'));
        await tx`delete from users where lower(email) = any(${[...SEED_USER_EMAILS, ...legacy]})`;
        if (process.env.SEED_SKIP_AUTH === '1') {
          await tx`delete from auth.users
                   where lower(email) = any(${[...SEED_USER_EMAILS, ...legacy]})`;
        }
      } else if (t === 'sms_consent' || t === 'sms_inbound' || t === 'sms_outbox' || t === 'email_outbox') {
        await tx.unsafe(`delete from ${t}`);
      } else if (t === 'staff_skills' || t === 'membership_roles' || t === 'permission_overrides') {
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
        await tx.unsafe(`delete from ${t} where location_id = any($1)`, [locs as never]);
      } else {
        await tx.unsafe(`delete from ${t} where org_id = any($1)`, [orgs as never]);
      }
    }
    await tx`delete from organizations where id in (${NAIL_ORG}, ${SPA_ORG})`;

    /*
     * ⚠️ 自助开户自测租户（`signup.test.ts`）用固定的 checkout session id，
     * 因此它建的 org **不在上面这两个种子 org 里，永远不会被清掉** ——
     * 那正是设计意图：第二次跑走的是幂等那条路，顺带把幂等也验一遍。
     *
     * 代价是 2026-09-01 那次邮箱域名切换（@example.test → @maildrop.cc）
     * 留下了一批对不上的行：`signup_intents.owner_email` 还是旧域名，而
     * `auth.users` 已经按新域名重建。`gf_claimable_intent` 比的正是这两者，
     * 于是「谁都认领不了这家自测店」，而报错停在一个与邮箱毫无关系的
     * `expected undefined`。
     *
     * ⚠️ 只改邮箱域名，不删行：付款留档不能删（`signup.test.ts` 的 `unclaim()`
     * 注释写着同一条）。谓词收得很紧 —— 旧域名只可能出现在测试数据里。
     * 这一段可在所有环境重跑过一遍之后删除。
     */
    await tx`
      update signup_intents
      set owner_email = replace(lower(owner_email), '@example.test', '@maildrop.cc')
      where lower(owner_email) like '%@example.test'`;

    console.log('✓ 旧数据清理完毕');

    // 2. 机构与门店
    console.log('2. 创建机构与门店...');
    await tx`insert into organizations (id, name, owner_user_id, default_locale) values
      (${NAIL_ORG}, 'Lotus Nails Group', gen_random_uuid(), 'zh-Hans'),
      (${SPA_ORG},  'Golden Foot Spa',   gen_random_uuid(), 'zh-Hans')`;

    await tx`insert into locations
      (id, org_id, name, slug, timezone, business_type, public_key, business_day_cutoff,
       business_hours, settings) values
      (${NAIL_LOC}, ${NAIL_ORG},
        ${J({ en: 'Lotus Nails & Spa', 'zh-Hans': '莲花美甲' })}, 'lotus-nails',
        'America/New_York', 'nail', ${publicKeyFor(NAIL_LOC)}, '04:00',
        ${J({ mon:{open:'09:30',close:'19:30'}, tue:{open:'09:30',close:'19:30'},
              wed:{open:'09:30',close:'19:30'}, thu:{open:'09:30',close:'19:30'},
              fri:{open:'09:30',close:'20:00'}, sat:{open:'09:00',close:'20:00'},
              sun:{open:'10:00',close:'18:00'} })},
        ${J({
          capacity: { slot_minutes: 15, max_concurrent_per_slot: null, overbook: 'warn' },
          online_booking: {
            enabled: true, max_days_ahead: 60, min_minutes_ahead: 120,
            require_phone_verification: false, cancel_cutoff_hours: 4,
          },
          phone_assistant: {
            greetingPrompt: '您好，感谢致电 Lotus Nails & Spa 莲花美甲，请问有什么可以帮您？',
            forwardPhoneNumber: '+12125550100',
            autoBookEnabled: true,
            tone: 'warm',
          },
          gift_card: { commission_basis: 'face' },
        })}),
      (${SPA_LOC}, ${SPA_ORG},
        ${J({ en: 'Golden Foot Spa', 'zh-Hans': '金足足疗' })}, 'golden-foot',
        'America/Los_Angeles', 'foot_spa', ${publicKeyFor(SPA_LOC)}, '03:00',
        ${J({ mon:{open:'10:00',close:'23:00'}, tue:{open:'10:00',close:'23:00'},
              wed:{open:'10:00',close:'23:00'}, thu:{open:'10:00',close:'23:00'},
              fri:{open:'10:00',close:'01:00'}, sat:{open:'10:00',close:'01:00'},
              sun:{open:'10:00',close:'23:00'} })},
        ${J({
          capacity: { slot_minutes: 15, max_concurrent_per_slot: null, overbook: 'warn' },
          online_booking: {
            enabled: true, max_days_ahead: 60, min_minutes_ahead: 120,
            require_phone_verification: false, cancel_cutoff_hours: 4,
          },
          phone_assistant: {
            greetingPrompt: '您好，感谢致电金足养生会馆，请问需要预约理疗还是咨询项目？',
            forwardPhoneNumber: '+13235550100',
            autoBookEnabled: true,
            tone: 'warm',
          },
          gift_card: { commission_basis: 'face' },
        })})`;

    /*
     * 两家种子店都是**在订阅中的付费门店**。
     *
     * ⭐ 这一段是 0085 之后必须有的。`billing_accounts.subscription_status`
     * 的默认值从 `trialing` 改成了 `none`（「从未接过计费」），而 `none`
     * 的套餐内 AI 额度是 0 —— 不显式建这两行的话，账户行会在第一次记账时
     * 被自动建成 `none`，然后整个种子环境里的副驾、拍照开店、AI 电话
     * 全部报 `AI_QUOTA_EXHAUSTED`。
     *
     * 而现实里这两家是营业中的店，营业中的店就是付了钱的店。种子照着现实建。
     */
    await tx`insert into billing_accounts
      (org_id, location_id, plan, subscription_status, current_period_end)
      values
      (${NAIL_ORG}, ${NAIL_LOC}, 'essential', 'active', now() + interval '20 days'),
      (${SPA_ORG},  ${SPA_LOC},  'essential', 'active', now() + interval '20 days')
      on conflict (location_id) do update
      set plan = excluded.plan,
          subscription_status = excluded.subscription_status,
          current_period_end = excluded.current_period_end`;

    // 3. 资源（工位与房间）
    const [roomType] = await tx<{ id: string }[]>`
      insert into resource_types (org_id, location_id, key, name)
      values (${SPA_ORG}, ${SPA_LOC}, 'room', ${J({ en: 'Room', 'zh-Hans': '包厢' })})
      returning id`;
    const spaRoomIds: Record<string, string> = {};
    for (const [name, cap, maxStaff] of [
      ['VIP 包厢 1', 1, 1], ['VIP 包厢 2', 1, 1], ['养生大厅 Hall', 4, null],
    ] as const) {
      const [r] = await tx<{ id: string }[]>`
        insert into resources
          (org_id, location_id, resource_type_id, name, capacity, max_staff)
          values (${SPA_ORG}, ${SPA_LOC}, ${roomType!.id}, ${name}, ${cap}, ${maxStaff})
        returning id`;
      spaRoomIds[name] = r!.id;
    }

    const [chairType] = await tx<{ id: string }[]>`
      insert into resource_types (org_id, location_id, key, name)
      values (${NAIL_ORG}, ${NAIL_LOC}, 'pedi_chair', ${J({ en: 'Pedicure chair', 'zh-Hans': '足疗美甲位' })})
      returning id`;
    const nailChairIds: Record<string, string> = {};
    for (const n of ['1号美甲位', '2号美甲位', '3号美甲位', '4号美甲位', 'VIP 独立包厢']) {
      const [r] = await tx<{ id: string }[]>`
        insert into resources (org_id, location_id, resource_type_id, name)
        values (${NAIL_ORG}, ${NAIL_LOC}, ${chairType!.id}, ${n})
        returning id`;
      nailChairIds[n] = r!.id;
    }

    // 4. 服务分类与服务项目
    const cats: Record<string, string> = {};
    for (const [key, org, loc, name, sort] of [
      ['nail_mani',   NAIL_ORG, NAIL_LOC, { en: 'Manicure', 'zh-Hans': '经典美甲' }, 1],
      ['nail_pedi',   NAIL_ORG, NAIL_LOC, { en: 'Pedicure', 'zh-Hans': '足部护理' }, 2],
      ['nail_addon',  NAIL_ORG, NAIL_LOC, { en: 'Add-ons', 'zh-Hans': '特色加项' }, 3],
      ['spa_massage', SPA_ORG,  SPA_LOC,  { en: 'Massage', 'zh-Hans': '精油按摩' }, 1],
      ['spa_foot',    SPA_ORG,  SPA_LOC,  { en: 'Foot', 'zh-Hans': '足道养生' }, 2],
      ['spa_addon',   SPA_ORG,  SPA_LOC,  { en: 'Add-ons', 'zh-Hans': '调理加项' }, 3],
    ] as const) {
      const [c] = await tx<{ id: string }[]>`
        insert into service_categories (org_id, location_id, name, sort)
        values (${org}, ${loc}, ${J(name)}, ${sort}) returning id`;
      cats[key] = c!.id;
    }

    const serviceIds: Record<string, string> = {};
    const serviceDurations: Record<string, number> = {};
    const servicePrices: Record<string, number> = {};

    for (const [key, org, loc, cat, name, min, cents, addon] of [
      ['gel_mani',   NAIL_ORG, NAIL_LOC, 'nail_mani', { en: 'Gel Manicure', 'zh-Hans': '甲油胶美甲' }, 45, 4500, false],
      ['basic_mani', NAIL_ORG, NAIL_LOC, 'nail_mani', { en: 'Classic Manicure', 'zh-Hans': '基础修手护理' }, 30, 2500, false],
      ['full_set',   NAIL_ORG, NAIL_LOC, 'nail_mani', { en: 'Full Set Acrylic', 'zh-Hans': '水晶甲延长全套' }, 75, 6500, false],
      ['dlx_pedi',   NAIL_ORG, NAIL_LOC, 'nail_pedi', { en: 'Deluxe Pedicure', 'zh-Hans': '尊享手足 SPA' }, 60, 5500, false],
      ['spa_pedi',   NAIL_ORG, NAIL_LOC, 'nail_pedi', { en: 'Spa Pedicure', 'zh-Hans': '基础足部护理' }, 45, 4000, false],
      ['gel_off',    NAIL_ORG, NAIL_LOC, 'nail_addon', { en: 'Gel Removal', 'zh-Hans': '温和卸甲' }, 15, 1000, true],
      ['nail_art',   NAIL_ORG, NAIL_LOC, 'nail_addon', { en: 'Nail Art', 'zh-Hans': '法式/手绘彩绘' }, 15, 1500, true],
      ['paraffin',   NAIL_ORG, NAIL_LOC, 'nail_addon', { en: 'Paraffin Treatment', 'zh-Hans': '热石蜡深层滋养' }, 15, 1200, true],

      ['reflex60',  SPA_ORG, SPA_LOC, 'spa_foot',    { en: 'Foot Reflexology 60min', 'zh-Hans': '经络足道 60 分钟' }, 60, 4500, false],
      ['reflex90',  SPA_ORG, SPA_LOC, 'spa_foot',    { en: 'Foot Reflexology 90min', 'zh-Hans': '尊享足道 90 分钟' }, 90, 6000, false],
      ['deep60',    SPA_ORG, SPA_LOC, 'spa_massage', { en: 'Deep Tissue 60min', 'zh-Hans': '深层肌肉理疗 60 分钟' }, 60, 8000, false],
      ['deep90',    SPA_ORG, SPA_LOC, 'spa_massage', { en: 'Deep Tissue 90min', 'zh-Hans': '全身深度减压 90 分钟' }, 90, 11000, false],
      ['swedish60', SPA_ORG, SPA_LOC, 'spa_massage', { en: 'Swedish Massage 60min', 'zh-Hans': '瑞典芳香精油 60 分钟' }, 60, 7000, false],
      ['hot_stone', SPA_ORG, SPA_LOC, 'spa_addon',   { en: 'Hot Stone Therapy', 'zh-Hans': '火山热石温通' }, 15, 1800, true],
      ['cupping',   SPA_ORG, SPA_LOC, 'spa_addon',   { en: 'Cupping Therapy', 'zh-Hans': '本草拔罐理疗' }, 15, 2000, true],
    ] as const) {
      const [row] = await tx<{ id: string }[]>`
        insert into services
          (org_id, location_id, category_id, name, duration_min, base_price_cents,
           online_bookable, is_addon, sort)
        values (${org}, ${loc}, ${cats[cat]!}, ${J(name)}, ${min}, ${cents},
                true, ${addon}, ${Object.keys(serviceIds).length})
        returning id`;
      serviceIds[key] = row!.id;
      serviceDurations[key] = min;
      servicePrices[key] = cents;
    }

    // 5. 提成方案与落单选项
    for (const [org, loc] of [[NAIL_ORG, NAIL_LOC], [SPA_ORG, SPA_LOC]] as const) {
      await tx`insert into compensation_plans (org_id, location_id, membership_id, version, config)
        values (${org}, ${loc}, null, 1, ${J({
          kind: 'commission', rateBp: 4500, categoryRateBp: {},
          retailRateBp: 1000, hourlyRateCents: 0, base: 'net',
          roleWeightBp: { primary: 10000, assistant: 3000 },
        })})`;
    }

    for (const [org, loc, opts] of [
      [NAIL_ORG, NAIL_LOC, NAIL_OPTIONS],
      [SPA_ORG, SPA_LOC, MASSAGE_OPTIONS],
    ] as const) {
      for (const opt of opts) {
        await tx`insert into service_option_defs
          (org_id, location_id, key, input, label, hint, options, sticky, to_staff, required, sort)
          values (${org}, ${loc}, ${opt.key}, ${opt.input}, ${J(opt.label)},
                  ${(opt as Record<string, unknown>).hint ? J((opt as Record<string, unknown>).hint) : null}, ${J(opt.options)},
                  ${opt.sticky}, ${opt.to_staff}, ${opt.required}, ${opt.sort})`;
      }
    }

    // 6. 权限与角色
    const roleIds: Record<string, Record<string, string>> = {};
    const permRows: Array<{ role_id: string; permission: string }> = [];
    for (const [org, loc] of [[NAIL_ORG, NAIL_LOC], [SPA_ORG, SPA_LOC]] as const) {
      roleIds[loc] = {};
      for (const [key, perms] of Object.entries(ROLE_PRESETS)) {
        const [r] = await tx<{ id: string }[]>`
          insert into roles (org_id, location_id, key, name, is_preset)
          values (${org}, ${loc}, ${key}, ${J({ en: key })}, true) returning id`;
        roleIds[loc]![key] = r!.id;
        for (const p of perms) {
          permRows.push({ role_id: r!.id, permission: p });
        }
      }
    }
    if (permRows.length > 0) {
      await tx`insert into role_permissions ${tx(permRows, 'role_id', 'permission')}`;
    }

    // 7. 技师等级与技能
    const [nailMaster] = await tx<{ id: string }[]>`
      insert into staff_levels (org_id, location_id, key, name, sort)
      values (${NAIL_ORG}, ${NAIL_LOC}, 'master', ${J({ en: 'Master Technician', 'zh-Hans': '总监技师' })}, 1) returning id`;
    const [nailSenior] = await tx<{ id: string }[]>`
      insert into staff_levels (org_id, location_id, key, name, sort)
      values (${NAIL_ORG}, ${NAIL_LOC}, 'senior', ${J({ en: 'Senior Technician', 'zh-Hans': '资深技师' })}, 2) returning id`;
    const [spaMaster] = await tx<{ id: string }[]>`
      insert into staff_levels (org_id, location_id, key, name, sort)
      values (${SPA_ORG}, ${SPA_LOC}, 'master', ${J({ en: 'Master Therapist', 'zh-Hans': '主任理疗师' })}, 1) returning id`;
    const [spaSenior] = await tx<{ id: string }[]>`
      insert into staff_levels (org_id, location_id, key, name, sort)
      values (${SPA_ORG}, ${SPA_LOC}, 'senior', ${J({ en: 'Senior Therapist', 'zh-Hans': '资深理疗师' })}, 2) returning id`;

    const skillIds: Record<string, string> = {};
    for (const [key, org, loc, name] of [
      ['gel',          NAIL_ORG, NAIL_LOC, { en: 'Gel Art', 'zh-Hans': '甲油胶彩绘' }],
      ['acrylic',      NAIL_ORG, NAIL_LOC, { en: 'Acrylic Nails', 'zh-Hans': '水晶延长甲' }],
      ['pedicure',     NAIL_ORG, NAIL_LOC, { en: 'Spa Pedicure', 'zh-Hans': '手足 SPA' }],
      ['deep_tissue',  SPA_ORG,  SPA_LOC,  { en: 'Deep Tissue', 'zh-Hans': '深层经络' }],
      ['reflexology',  SPA_ORG,  SPA_LOC,  { en: 'Reflexology', 'zh-Hans': '足底养生' }],
      ['prenatal',     SPA_ORG,  SPA_LOC,  { en: 'Aromatherapy', 'zh-Hans': '芳香精油' }],
    ] as const) {
      const [row] = await tx<{ id: string }[]>`
        insert into skills (org_id, location_id, key, name)
        values (${org}, ${loc}, ${key}, ${J(name)}) returning id`;
      skillIds[key] = row!.id;
    }

    // 8. 员工人员架构
    const staff = [
      { org: NAIL_ORG, loc: NAIL_LOC, name: 'Amy',  title: { en: 'Amy', 'zh-Hans': '艾米' }, levelId: nailMaster!.id, roles: ['manager', 'tech'], bookable: true, maxConc: 2, inRotation: false, gender: 'female', skills: ['gel', 'acrylic'] },
      { org: NAIL_ORG, loc: NAIL_LOC, name: 'Linh', title: { en: 'Linh', 'zh-Hans': '林玲' }, levelId: nailSenior!.id, roles: ['tech'], bookable: true, maxConc: 2, inRotation: true, gender: 'female', skills: ['gel', 'pedicure'] },
      { org: NAIL_ORG, loc: NAIL_LOC, name: 'Kim',  title: { en: 'Kim', 'zh-Hans': '金金' }, levelId: nailSenior!.id, roles: ['tech'], bookable: true, maxConc: 1, inRotation: true, gender: 'female', skills: ['pedicure'] },
      { org: NAIL_ORG, loc: NAIL_LOC, name: 'Tran', title: { en: 'Tran', 'zh-Hans': '阿全' }, levelId: nailSenior!.id, roles: ['tech'], bookable: true, maxConc: 2, inRotation: true, gender: 'male', skills: ['acrylic'] },
      { org: NAIL_ORG, loc: NAIL_LOC, name: 'Mai',  title: { en: 'Mai', 'zh-Hans': '美美' }, levelId: nailMaster!.id, roles: ['senior_tech'], bookable: true, maxConc: 1, inRotation: true, gender: 'female', skills: ['gel', 'acrylic', 'pedicure'] },
      { org: NAIL_ORG, loc: NAIL_LOC, name: 'Mia',  title: { en: 'Mia', 'zh-Hans': '米娅' }, levelId: null, roles: ['front_desk'], bookable: false, maxConc: 1, inRotation: false, gender: 'female', skills: [] },

      { org: SPA_ORG,  loc: SPA_LOC,  name: 'Yan',   title: { en: 'Yan', 'zh-Hans': '燕姐' }, levelId: spaMaster!.id, roles: ['tech'], bookable: true, maxConc: 1, inRotation: true, gender: 'female', skills: ['reflexology', 'prenatal'] },
      { org: SPA_ORG,  loc: SPA_LOC,  name: 'Hua',   title: { en: 'Hua', 'zh-Hans': '华师傅' }, levelId: spaMaster!.id, roles: ['tech'], bookable: true, maxConc: 1, inRotation: true, gender: 'female', skills: ['deep_tissue', 'reflexology'] },
      { org: SPA_ORG,  loc: SPA_LOC,  name: 'Bo',    title: { en: 'Bo', 'zh-Hans': '阿博' }, levelId: spaSenior!.id, roles: ['tech'], bookable: true, maxConc: 1, inRotation: true, gender: 'male', skills: ['deep_tissue'] },
      { org: SPA_ORG,  loc: SPA_LOC,  name: 'Owner', title: { en: 'Owner', 'zh-Hans': '李总' }, levelId: null, roles: ['owner'], bookable: false, maxConc: 1, inRotation: false, gender: null, skills: [] },
    ];

    console.log('3. 员工与技能创建...');
    const memberIds: Record<string, string> = {};
    for (const p of staff) {
      const email = `${p.name.toLowerCase()}@maildrop.cc`;
      const authId = await upsertAuthUser(email, p.name);
      if (process.env.SEED_SKIP_AUTH === '1') {
        // Local isolated Supabase still needs a complete password identity;
        // a row containing only id/email cannot sign in through GoTrue.
        await tx`insert into auth.users
          (instance_id, id, aud, role, email, encrypted_password,
           email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
           created_at, updated_at, confirmation_token, recovery_token,
           email_change_token_new, email_change, email_change_token_current,
           phone_change, phone_change_token, reauthentication_token,
           email_change_confirm_status)
          values
          ('00000000-0000-0000-0000-000000000000', ${authId},
           'authenticated', 'authenticated', ${email},
           crypt(${DEV_PASSWORD}, gen_salt('bf')), now(),
           ${J({ provider: 'email', providers: ['email'] })},
           ${J({ full_name: p.name })}, now(), now(), '', '', '', '', '',
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
          (${authId}, ${authId},
           ${J({ sub: authId, email, email_verified: true, phone_verified: false })},
           'email', now(), now(), now())
          on conflict (provider_id, provider) do update set
            user_id = excluded.user_id,
            identity_data = excluded.identity_data,
            updated_at = excluded.updated_at`;
      }
      const [u] = await tx<{ id: string }[]>`
        insert into users (id, email, full_name, locale)
        values (${authId}, ${email}, ${p.name}, 'zh-Hans')
        on conflict (id) do update set email = excluded.email, full_name = excluded.full_name
        returning id`;
      const [m] = await tx<{ id: string }[]>`
        insert into memberships (org_id, location_id, user_id, status)
        values (${p.org}, ${p.loc}, ${u!.id}, 'active') returning id`;
      for (const r of p.roles) {
        await tx`insert into membership_roles (membership_id, role_id)
                 values (${m!.id}, ${roleIds[p.loc]![r]!})`;
      }
      memberIds[p.name] = m!.id;
      await tx`insert into staff_profiles
        (membership_id, org_id, location_id, display_name, gender, level_id,
         is_bookable, max_concurrent_appointments)
        values (${m!.id}, ${p.org}, ${p.loc}, ${J(p.title)}, ${p.gender}, ${p.levelId},
                ${p.bookable}, ${p.maxConc})`;
      for (const k of p.skills) {
        await tx`insert into staff_skills (membership_id, skill_id)
                 values (${m!.id}, ${skillIds[k]!})`;
      }
    }
    // GenieFront operators. No customer membership — guessing the platform
    // URL as a store owner must not grant access.
    for (const op of [
      { id: OPS_USER, email: 'ops@maildrop.cc', name: 'GenieFront Ops', operatorId: OPS_OPERATOR_ID, role: 'super_admin', status: 'active', revokedAt: null as string | null },
      { id: EXOPS_USER, email: 'exops@maildrop.cc', name: 'Former Ops', operatorId: EXOPS_OPERATOR_ID, role: 'support', status: 'revoked', revokedAt: '2026-01-01T00:00:00.000Z' },
    ] as const) {
      const authId = await upsertAuthUser(op.email, op.name);
      if (process.env.SEED_SKIP_AUTH === '1') {
        await tx`insert into auth.users
          (instance_id, id, aud, role, email, encrypted_password,
           email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
           created_at, updated_at, confirmation_token, recovery_token,
           email_change_token_new, email_change, email_change_token_current,
           phone_change, phone_change_token, reauthentication_token,
           email_change_confirm_status)
          values
          ('00000000-0000-0000-0000-000000000000', ${authId},
           'authenticated', 'authenticated', ${op.email},
           crypt(${DEV_PASSWORD}, gen_salt('bf')), now(),
           ${J({ provider: 'email', providers: ['email'] })},
           ${J({ full_name: op.name })}, now(), now(), '', '', '', '', '',
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
          (${authId}, ${authId},
           ${J({ sub: authId, email: op.email, email_verified: true, phone_verified: false })},
           'email', now(), now(), now())
          on conflict (provider_id, provider) do update set
            user_id = excluded.user_id,
            identity_data = excluded.identity_data,
            updated_at = excluded.updated_at`;
      }
      await tx`insert into users (id, email, full_name, locale)
        values (${authId}, ${op.email}, ${op.name}, 'en')
        on conflict (id) do update set email = excluded.email, full_name = excluded.full_name`;
      await tx`insert into platform_operators (id, user_id, role, status, notes, revoked_at)
        values (
          ${op.operatorId}, ${authId}, ${op.role}, ${op.status},
          'seed operator', ${op.revokedAt}
        )`;
    }

    console.log('4. 客户与偏好创建...');
    const customersData = [
      { org: NAIL_ORG, loc: NAIL_LOC, name: 'Lisa Chen', phone: '+19175550142', email: 'lisa.chen@maildrop.cc', vip: 3, src: 'desk', allergies: ['penicillin'], pref: { oil: 'lavender', quiet: true } },
      { org: NAIL_ORG, loc: NAIL_LOC, name: '张女士', phone: '+19175550188', email: 'meilan.zhang@maildrop.cc', vip: 2, src: 'walkin', allergies: ['latex'], pref: { pressure: 2, avoid: 'lower_back' } },
      { org: NAIL_ORG, loc: NAIL_LOC, name: '张建国', phone: '+19175550188', email: 'jianguo.zhang@maildrop.cc', vip: 1, src: 'walkin', allergies: [], pref: { quiet: true } },
      { org: NAIL_ORG, loc: NAIL_LOC, name: 'Emily Johnson', phone: '+16175550211', email: 'emily.j@maildrop.cc', vip: 2, src: 'web', allergies: [], pref: { shape: 'almond', oil: 'sweet_orange' } },
      { org: NAIL_ORG, loc: NAIL_LOC, name: 'Jessica Taylor', phone: '+16175550233', email: 'jessica.t@maildrop.cc', vip: 1, src: 'phone_ai', allergies: [], pref: { hotStone: true } },
      { org: NAIL_ORG, loc: NAIL_LOC, name: 'David Miller', phone: '+16175550255', email: 'david.m@maildrop.cc', vip: 0, src: 'walkin', allergies: [], pref: {} },
      { org: NAIL_ORG, loc: NAIL_LOC, name: 'Sophia Williams', phone: '+12125550301', email: 'sophia.w@maildrop.cc', vip: 1, src: 'web', allergies: [], pref: { nailArt: true } },
      { org: NAIL_ORG, loc: NAIL_LOC, name: 'Michael Brown', phone: '+12125550302', email: 'mbrown@maildrop.cc', vip: 0, src: 'walkin', allergies: [], pref: {} },
      { org: NAIL_ORG, loc: NAIL_LOC, name: 'Amanda White', phone: '+12125550303', email: 'amanda.white@maildrop.cc', vip: 2, src: 'desk', allergies: [], pref: { paraffin: true } },
      { org: NAIL_ORG, loc: NAIL_LOC, name: 'Chloe Martinez', phone: '+12125550305', email: 'chloe.m@maildrop.cc', vip: 1, src: 'web', allergies: [], pref: {} },

      { org: SPA_ORG, loc: SPA_LOC, name: '陈伟 (David Chen)', phone: '+16265550102', email: 'david.chen@maildrop.cc', vip: 3, src: 'desk', allergies: [], pref: { pressure: 5, focus: 'neck_shoulder' } },
      { org: SPA_ORG, loc: SPA_LOC, name: '王明 (Wang Ming)', phone: '+16265550101', email: 'wang.ming@maildrop.cc', vip: 2, src: 'phone_ai', allergies: [], pref: { pressure: 4, oil: 'eucalyptus' } },
      { org: SPA_ORG, loc: SPA_LOC, name: 'Robert Lee', phone: '+16265550104', email: 'robert.lee@maildrop.cc', vip: 1, src: 'walkin', allergies: [], pref: { quiet: true } },
      { org: SPA_ORG, loc: SPA_LOC, name: 'Hannah Davis', phone: '+13235550401', email: 'hannah.d@maildrop.cc', vip: 1, src: 'web', allergies: ['peanut_oil'], pref: { pressure: 2 } },
      { org: SPA_ORG, loc: SPA_LOC, name: 'James Wilson', phone: '+13235550402', email: 'jwilson@maildrop.cc', vip: 0, src: 'walkin', allergies: [], pref: { cupping: true } },
      { org: SPA_ORG, loc: SPA_LOC, name: 'Grace Liu', phone: '+13235550403', email: 'grace.liu@maildrop.cc', vip: 2, src: 'desk', allergies: [], pref: { prenatal: true, oil: 'lavender' } },
      { org: SPA_ORG, loc: SPA_LOC, name: 'Kevin Zhang', phone: '+13235550404', email: 'kevin.z@maildrop.cc', vip: 1, src: 'phone_ai', allergies: [], pref: { pressure: 5 } },
      { org: SPA_ORG, loc: SPA_LOC, name: 'Olivia Moore', phone: '+13235550405', email: 'olivia.m@maildrop.cc', vip: 0, src: 'web', allergies: [], pref: {} },
    ];

    const customerIds: Record<string, string> = {};
    for (const c of customersData) {
      const [row] = await tx<{ id: string }[]>`
        insert into customers (org_id, primary_location_id, display_name, phone_e164, email, vip_level, source)
        values (${c.org}, ${c.loc}, ${c.name}, ${c.phone}, ${c.email}, ${c.vip}, ${c.src})
        returning id`;
      customerIds[c.name] = row!.id;

      await tx`insert into customer_preferences
        (org_id, customer_id, allergies, preferred_staff_ids, free_notes, profile)
        values (${c.org}, ${row!.id}, ${J({ skinAllergies: c.allergies })}, '{}',
                ${c.name + ' 偏好'}, ${J(c.pref)})`;
    }

    // 10. 电话线
    const nailAiLine = process.env.SEED_AI_LINE ?? '+12125550123';
    const spaAiLine = process.env.SEED_SPA_AI_LINE ?? '+13235550123';
    for (const [org, loc, e164, purpose] of [
      [NAIL_ORG, NAIL_LOC, nailAiLine,     'ai_voice'],
      [NAIL_ORG, NAIL_LOC, '+12125550100', 'main'],
      [SPA_ORG,  SPA_LOC,  spaAiLine,      'ai_voice'],
      [SPA_ORG,  SPA_LOC,  '+13235550100', 'main'],
    ] as const) {
      const isAi = purpose === 'ai_voice';
      const token = isAi ? toolTokenFor(loc) : null;
      await tx`insert into phone_lines (org_id, location_id, e164, purpose, tool_token_digest)
               values (${org}, ${loc}, ${e164}, ${purpose}, ${token ? sha256(token) : null})`;
    }

    // 11. 日期区间：覆盖过去 14 天、今天、未来 14 天（共 29 天）
    /**
     * ⚠️ 锚点必须是**营业日**，不是日历日。
     *
     * 门店的营业日在 `business_day_cutoff`（这里是凌晨 3–4 点）才翻页：
     * 纽约时间 01:11 属于**前一天**的营业日。而这个函数原来直接取日历日期，
     * 于是 `dates[14]`（「今天」）比应用认定的营业日晚一天，
     * 而 `dates[13]` —— 也就是应用眼里的「今天」—— 被种子写成了
     * `day_closes.status = 'closed'`。
     *
     * 后果是：**每天凌晨 0 点到 4 点之间跑测试，任何写"今天"的用例都会
     * 撞上 `business day … is closed`**（kiosk / core_loop / notify / phone
     * 共 35 条）。白天跑全绿，半夜跑全红，而失败信息指向业务规则，
     * 看不出是种子数据的时间锚点错了。
     *
     * 这里按最保守的 cutoff（4 小时）回退。种子里两家店是 03:00 / 04:00，
     * 取大的那个：早退一小时最多让「今天」少一天数据，
     * 而晚退一小时就会重新踩回上面那个坑。
     */
    const CUTOFF_HOURS = 4;
    const getDatesRange = (tz: string, pastDays: number, futureDays: number): string[] => {
      const anchor = new Date(Date.now() - CUTOFF_HOURS * 3600_000);
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(anchor);
      const dates: string[] = [];
      for (let i = -pastDays; i <= futureDays; i++) {
        const d = new Date(`${today}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() + i);
        dates.push(d.toISOString().slice(0, 10));
      }
      return dates;
    };

    const nailDateRange = getDatesRange('America/New_York', 14, 14);
    const spaDateRange = getDatesRange('America/Los_Angeles', 14, 14);

    // 12. 班表生成（全覆盖 29 天）
    console.log('5. 班表生成 (29天全覆盖)...');
    const shiftRows: Array<{
      org_id: string; location_id: string; membership_id: string;
      business_date: string; start_min: number; end_min: number;
      status: string; published_at: Date; off_reason: string | null;
    }> = [];
    const rotRows: Array<{
      org_id: string; location_id: string; business_date: string;
      membership_id: string; in_rotation: boolean;
    }> = [];
    const now = new Date();

    for (const p of staff) {
      if (!p.bookable) continue;
      const days = p.loc === NAIL_LOC ? nailDateRange : spaDateRange;
      const [startMin, endMin] = p.loc === NAIL_LOC ? [570, 1170] : [600, 1380];
      for (const [idx, d] of days.entries()) {
        const isOff = (p.name === 'Kim' && idx % 7 === 1) || (p.name === 'Tran' && idx % 7 === 3) || (p.name === 'Hua' && idx % 7 === 2);
        shiftRows.push({
          org_id: p.org, location_id: p.loc, membership_id: memberIds[p.name]!,
          business_date: d, start_min: startMin, end_min: endMin,
          status: isOff ? 'off' : 'published', published_at: now,
          off_reason: isOff ? 'weekly_rest' : null,
        });

        if (idx >= 13 && idx <= 15) {
          rotRows.push({
            org_id: p.org, location_id: p.loc, business_date: d,
            membership_id: memberIds[p.name]!, in_rotation: Boolean(p.inRotation && !isOff),
          });
        }
      }
    }
    if (shiftRows.length > 0) {
      await tx`insert into shifts ${tx(shiftRows, 'org_id', 'location_id', 'membership_id', 'business_date', 'start_min', 'end_min', 'status', 'published_at', 'off_reason')}`;
    }
    if (rotRows.length > 0) {
      await tx`insert into rotation_participants ${tx(rotRows, 'org_id', 'location_id', 'business_date', 'membership_id', 'in_rotation')}`;
    }

    // 13. 过去 14 天已完成预约与真实工单财务流水生成
    console.log('6. 过去 14 天已完成预约与真实工单财务流水生成...');
    const nailTechs = ['Linh', 'Kim', 'Tran', 'Mai', 'Amy'];
    const spaTechs = ['Yan', 'Hua', 'Bo'];
    const nailServices = ['gel_mani', 'basic_mani', 'full_set', 'dlx_pedi', 'spa_pedi'];
    const spaServices = ['reflex60', 'reflex90', 'deep60', 'deep90', 'swedish60'];
    const nailCustNames = Object.keys(customerIds).filter((_, i) => i < 10);
    const spaCustNames = Object.keys(customerIds).filter((_, i) => i >= 10);

    const timeSlots = ['10:00', '11:30', '13:30', '15:00', '16:30', '18:00'];

    for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
      const nailDate = nailDateRange[dayOffset]!;
      const spaDate = spaDateRange[dayOffset]!;

      // 美甲店每日 4-5 单已结账单据
      for (let s = 0; s < 4; s++) {
        const custName = nailCustNames[(dayOffset * 3 + s) % nailCustNames.length]!;
        const techName = nailTechs[(dayOffset + s) % nailTechs.length]!;
        const svcKey = nailServices[(dayOffset + s) % nailServices.length]!;
        const time = timeSlots[s % timeSlots.length]!;
        const duration = serviceDurations[svcKey] ?? 45;
        const basePrice = servicePrices[svcKey] ?? 4500;
        const tipCents = Math.round(basePrice * 0.18 / 100) * 100;
        const taxCents = Math.round(basePrice * 0.08875);
        const surchargeCents = s % 2 === 0 ? Math.round(basePrice * 0.035) : 0;
        const totalCents = basePrice + taxCents + surchargeCents + tipCents;

        // 预约记录
        const [apt] = await tx<{ id: string }[]>`
          insert into appointments (
            org_id, location_id, customer_id, business_date, starts_at, ends_at,
            status, source, notes
          ) values (
            ${NAIL_ORG}, ${NAIL_LOC}, ${customerIds[custName]!}, ${nailDate},
            (${nailDate}::date + ${time}::time) at time zone 'America/New_York',
            (${nailDate}::date + ${time}::time) at time zone 'America/New_York' + make_interval(mins => ${duration}),
            'completed', 'desk', '老顾客定期护理'
          ) returning id`;

        await tx`insert into appointment_items (
          org_id, location_id, appointment_id, service_id, membership_id,
          starts_at, ends_at, price_cents_snapshot, duration_min
        ) values (
          ${NAIL_ORG}, ${NAIL_LOC}, ${apt!.id}, ${serviceIds[svcKey]!}, ${memberIds[techName]!},
          (${nailDate}::date + ${time}::time) at time zone 'America/New_York',
          (${nailDate}::date + ${time}::time) at time zone 'America/New_York' + make_interval(mins => ${duration}),
          ${basePrice}, ${duration}
        )`;

        // 工单记录
        const [ticket] = await tx<{ id: string }[]>`
          insert into tickets (
            org_id, location_id, customer_id, appointment_id, business_date, status,
            opened_at, closed_at, opened_by, closed_by,
            subtotal_cents, discount_cents, tax_cents, surcharge_cents, tip_cents, total_cents
          ) values (
            ${NAIL_ORG}, ${NAIL_LOC}, ${customerIds[custName]!}, ${apt!.id}, ${nailDate}, 'closed',
            (${nailDate}::date + ${time}::time) at time zone 'America/New_York',
            (${nailDate}::date + ${time}::time) at time zone 'America/New_York' + make_interval(mins => ${duration}),
            ${memberIds['Mia']!}, ${memberIds['Mia']!},
            ${basePrice}, 0, ${taxCents}, ${surchargeCents}, ${tipCents}, ${totalCents}
          ) returning id`;

        const [tItem] = await tx<{ id: string }[]>`
          insert into ticket_items (
            org_id, location_id, ticket_id, service_id, kind, name_snapshot, unit_price_cents, total_cents
          ) values (
            ${NAIL_ORG}, ${NAIL_LOC}, ${ticket!.id}, ${serviceIds[svcKey]!}, 'service',
            ${svcKey}, ${basePrice}, ${basePrice}
          ) returning id`;

        await tx`insert into ticket_item_staff (org_id, ticket_item_id, membership_id, role, minutes)
          values (${NAIL_ORG}, ${tItem!.id}, ${memberIds[techName]!}, 'primary', ${duration})`;

        // 支付明细
        await tx`insert into payments (
          org_id, location_id, ticket_id, method, amount_cents, tip_cents, change_cents, taken_by
        ) values (
          ${NAIL_ORG}, ${NAIL_LOC}, ${ticket!.id}, ${surchargeCents > 0 ? 'card' : 'cash'},
          ${totalCents}, ${tipCents}, 0, ${memberIds['Mia']!}
        )`;

        // 小费分账与提成
        await tx`insert into tip_allocations (
          org_id, location_id, ticket_id, membership_id, amount_cents, basis, source, policy_version
        ) values (
          ${NAIL_ORG}, ${NAIL_LOC}, ${ticket!.id}, ${memberIds[techName]!}, ${tipCents},
          '{"method": "direct"}'::jsonb, ${surchargeCents > 0 ? 'card' : 'cash'}, 1
        )`;

        await tx`insert into earnings (
          org_id, location_id, membership_id, ticket_id, business_date, kind,
          amount_cents, base_cents
        ) values (
          ${NAIL_ORG}, ${NAIL_LOC}, ${memberIds[techName]!}, ${ticket!.id}, ${nailDate}, 'commission',
          ${Math.round(basePrice * 0.45)}, ${basePrice}
        )`;
      }

      // 足疗店每日已结账单据
      for (let s = 0; s < 3; s++) {
        const custName = spaCustNames[(dayOffset * 2 + s) % spaCustNames.length]!;
        const techName = spaTechs[(dayOffset + s) % spaTechs.length]!;
        const svcKey = spaServices[(dayOffset + s) % spaServices.length]!;
        const time = timeSlots[s % timeSlots.length]!;
        const duration = serviceDurations[svcKey] ?? 60;
        const basePrice = servicePrices[svcKey] ?? 6000;
        const tipCents = 1500;
        const totalCents = basePrice + tipCents;

        const [apt] = await tx<{ id: string }[]>`
          insert into appointments (
            org_id, location_id, customer_id, business_date, starts_at, ends_at,
            status, source, notes
          ) values (
            ${SPA_ORG}, ${SPA_LOC}, ${customerIds[custName]!}, ${spaDate},
            (${spaDate}::date + ${time}::time) at time zone 'America/Los_Angeles',
            (${spaDate}::date + ${time}::time) at time zone 'America/Los_Angeles' + make_interval(mins => ${duration}),
            'completed', 'web', '全身经络深度调理'
          ) returning id`;

        await tx`insert into appointment_items (
          org_id, location_id, appointment_id, service_id, membership_id,
          starts_at, ends_at, price_cents_snapshot, duration_min
        ) values (
          ${SPA_ORG}, ${SPA_LOC}, ${apt!.id}, ${serviceIds[svcKey]!}, ${memberIds[techName]!},
          (${spaDate}::date + ${time}::time) at time zone 'America/Los_Angeles',
          (${spaDate}::date + ${time}::time) at time zone 'America/Los_Angeles' + make_interval(mins => ${duration}),
          ${basePrice}, ${duration}
        )`;

        const [ticket] = await tx<{ id: string }[]>`
          insert into tickets (
            org_id, location_id, customer_id, appointment_id, business_date, status,
            opened_at, closed_at, opened_by, closed_by,
            subtotal_cents, discount_cents, tax_cents, tip_cents, total_cents
          ) values (
            ${SPA_ORG}, ${SPA_LOC}, ${customerIds[custName]!}, ${apt!.id}, ${spaDate}, 'closed',
            (${spaDate}::date + ${time}::time) at time zone 'America/Los_Angeles',
            (${spaDate}::date + ${time}::time) at time zone 'America/Los_Angeles' + make_interval(mins => ${duration}),
            ${memberIds['Owner']!}, ${memberIds['Owner']!},
            ${basePrice}, 0, 0, ${tipCents}, ${totalCents}
          ) returning id`;

        const [tItem] = await tx<{ id: string }[]>`
          insert into ticket_items (
            org_id, location_id, ticket_id, service_id, kind, name_snapshot, unit_price_cents, total_cents
          ) values (
            ${SPA_ORG}, ${SPA_LOC}, ${ticket!.id}, ${serviceIds[svcKey]!}, 'service',
            ${svcKey}, ${basePrice}, ${basePrice}
          ) returning id`;

        await tx`insert into ticket_item_staff (org_id, ticket_item_id, membership_id, role, minutes)
          values (${SPA_ORG}, ${tItem!.id}, ${memberIds[techName]!}, 'primary', ${duration})`;

        await tx`insert into payments (
          org_id, location_id, ticket_id, method, amount_cents, tip_cents, change_cents, taken_by
        ) values (
          ${SPA_ORG}, ${SPA_LOC}, ${ticket!.id}, 'card', ${totalCents}, ${tipCents}, 0, ${memberIds['Owner']!}
        )`;

        await tx`insert into earnings (
          org_id, location_id, membership_id, ticket_id, business_date, kind,
          amount_cents, base_cents
        ) values (
          ${SPA_ORG}, ${SPA_LOC}, ${memberIds[techName]!}, ${ticket!.id}, ${spaDate}, 'commission',
          ${Math.round(basePrice * 0.45)}, ${basePrice}
        )`;
      }

      // 日结记录
      await tx`insert into day_closes (
        org_id, location_id, business_date, closed_at, closed_by, status,
        gross_cents, discount_cents, net_cents, tax_cents, tip_cash_cents, tip_card_cents,
        counted_cash_cents, card_terminal_cents, cash_variance_cents
      ) values (
        ${NAIL_ORG}, ${NAIL_LOC}, ${nailDate}, (${nailDate}::date + time '20:30') at time zone 'America/New_York',
        ${memberIds['Amy']!}, 'closed', 22000, 0, 22000, 1950, 1000, 3200, 5000, 23150, 0
      )`;
    }

    // 14. 今日活跃工单与走单看板数据 (Day 14)
    const todayNail = nailDateRange[14]!;
    const todaySpa = spaDateRange[14]!;

    // 今日美甲店排期
    const todayApts = [
      { cust: 'Lisa Chen', tech: 'Linh', svc: 'gel_mani', time: '10:00', status: 'completed' },
      { cust: '张女士', tech: 'Mai', svc: 'dlx_pedi', time: '11:30', status: 'completed' },
      { cust: 'Emily Johnson', tech: 'Kim', svc: 'basic_mani', time: '13:30', status: 'in_service' },
      { cust: 'Jessica Taylor', tech: 'Tran', svc: 'full_set', time: '14:30', status: 'in_service' },
      { cust: 'Sophia Williams', tech: 'Amy', svc: 'spa_pedi', time: '16:00', status: 'ready_to_pay' },
      { cust: 'Amanda White', tech: 'Linh', svc: 'gel_mani', time: '17:30', status: 'checked_in' },
      { cust: 'Chloe Martinez', tech: 'Mai', svc: 'dlx_pedi', time: '18:30', status: 'booked' },
    ];

    for (const a of todayApts) {
      const duration = serviceDurations[a.svc] ?? 45;
      const basePrice = servicePrices[a.svc] ?? 4500;
      const [apt] = await tx<{ id: string }[]>`
        insert into appointments (
          org_id, location_id, customer_id, business_date, starts_at, ends_at,
          status, source, notes
        ) values (
          ${NAIL_ORG}, ${NAIL_LOC}, ${customerIds[a.cust]!}, ${todayNail},
          (${todayNail}::date + ${a.time}::time) at time zone 'America/New_York',
          (${todayNail}::date + ${a.time}::time) at time zone 'America/New_York' + make_interval(mins => ${duration}),
          ${a.status}, 'desk', '今日预约'
        ) returning id`;

      await tx`insert into appointment_items (
        org_id, location_id, appointment_id, service_id, membership_id,
        starts_at, ends_at, price_cents_snapshot, duration_min
      ) values (
        ${NAIL_ORG}, ${NAIL_LOC}, ${apt!.id}, ${serviceIds[a.svc]!}, ${memberIds[a.tech]!},
        (${todayNail}::date + ${a.time}::time) at time zone 'America/New_York',
        (${todayNail}::date + ${a.time}::time) at time zone 'America/New_York' + make_interval(mins => ${duration}),
        ${basePrice}, ${duration}
      )`;

      if (a.status === 'in_service' || a.status === 'ready_to_pay' || a.status === 'completed') {
        const tStatus = a.status === 'completed' ? 'closed' : 'open';
        const [ticket] = await tx<{ id: string }[]>`
          insert into tickets (
            org_id, location_id, customer_id, appointment_id, business_date, status,
            subtotal_cents, discount_cents, tax_cents, tip_cents, total_cents,
            opened_at, closed_at, opened_by
          ) values (
            ${NAIL_ORG}, ${NAIL_LOC}, ${customerIds[a.cust]!}, ${apt!.id}, ${todayNail}, ${tStatus},
            ${basePrice}, 0, ${Math.round(basePrice * 0.08875)}, 0, ${basePrice},
            (${todayNail}::date + ${a.time}::time) at time zone 'America/New_York',
            ${a.status === 'completed' ? tx`now()` : null},
            ${memberIds['Mia']!}
          ) returning id`;

        const [tItem] = await tx<{ id: string }[]>`
          insert into ticket_items (
            org_id, location_id, ticket_id, service_id, kind, name_snapshot, unit_price_cents, total_cents
          ) values (
            ${NAIL_ORG}, ${NAIL_LOC}, ${ticket!.id}, ${serviceIds[a.svc]!}, 'service',
            ${a.svc}, ${basePrice}, ${basePrice}
          ) returning id`;

        await tx`insert into ticket_item_staff (org_id, ticket_item_id, membership_id, role, minutes)
          values (${NAIL_ORG}, ${tItem!.id}, ${memberIds[a.tech]!}, 'primary', ${duration})`;
      }
    }

    // 今日排队看板 (Walk-in Queue)
    await tx`insert into walkin_queue (
      org_id, location_id, customer_id, business_date, ticket_number, status, source, quoted_wait_min, joined_at
    ) values
      (${NAIL_ORG}, ${NAIL_LOC}, ${customerIds['David Miller']!}, ${todayNail}, 101, 'waiting', 'kiosk', 10, now() - interval '15 minutes'),
      (${NAIL_ORG}, ${NAIL_LOC}, ${customerIds['Michael Brown']!}, ${todayNail}, 102, 'called', 'kiosk', 0, now() - interval '5 minutes')`;

    // 15. 未来 14 天排期预约 (Day 15 to Day 28)
    for (let dayOffset = 15; dayOffset < 29; dayOffset++) {
      const nailDate = nailDateRange[dayOffset]!;
      const spaDate = spaDateRange[dayOffset]!;

      // 美甲店每日 3-5 笔未来预约
      for (let s = 0; s < 3; s++) {
        const custName = nailCustNames[(dayOffset * 2 + s) % nailCustNames.length]!;
        const techName = nailTechs[(dayOffset + s) % nailTechs.length]!;
        const svcKey = nailServices[(dayOffset + s) % nailServices.length]!;
        const time = timeSlots[(s * 2) % timeSlots.length]!;
        const duration = serviceDurations[svcKey] ?? 45;
        const basePrice = servicePrices[svcKey] ?? 4500;

        const [apt] = await tx<{ id: string }[]>`
          insert into appointments (
            org_id, location_id, customer_id, business_date, starts_at, ends_at,
            status, source, notes
          ) values (
            ${NAIL_ORG}, ${NAIL_LOC}, ${customerIds[custName]!}, ${nailDate},
            (${nailDate}::date + ${time}::time) at time zone 'America/New_York',
            (${nailDate}::date + ${time}::time) at time zone 'America/New_York' + make_interval(mins => ${duration}),
            'booked', 'web', '提前线上预约锁定技师'
          ) returning id`;

        await tx`insert into appointment_items (
          org_id, location_id, appointment_id, service_id, membership_id,
          starts_at, ends_at, price_cents_snapshot, duration_min
        ) values (
          ${NAIL_ORG}, ${NAIL_LOC}, ${apt!.id}, ${serviceIds[svcKey]!}, ${memberIds[techName]!},
          (${nailDate}::date + ${time}::time) at time zone 'America/New_York',
          (${nailDate}::date + ${time}::time) at time zone 'America/New_York' + make_interval(mins => ${duration}),
          ${basePrice}, ${duration}
        )`;
      }

      // 足疗店每日 2-3 笔未来预约
      for (let s = 0; s < 2; s++) {
        const custName = spaCustNames[(dayOffset * 2 + s) % spaCustNames.length]!;
        const techName = spaTechs[(dayOffset + s) % spaTechs.length]!;
        const svcKey = spaServices[(dayOffset + s) % spaServices.length]!;
        const time = timeSlots[(s * 2 + 1) % timeSlots.length]!;
        const duration = serviceDurations[svcKey] ?? 60;
        const basePrice = servicePrices[svcKey] ?? 6000;

        const [apt] = await tx<{ id: string }[]>`
          insert into appointments (
            org_id, location_id, customer_id, business_date, starts_at, ends_at,
            status, source, notes
          ) values (
            ${SPA_ORG}, ${SPA_LOC}, ${customerIds[custName]!}, ${spaDate},
            (${spaDate}::date + ${time}::time) at time zone 'America/Los_Angeles',
            (${spaDate}::date + ${time}::time) at time zone 'America/Los_Angeles' + make_interval(mins => ${duration}),
            'booked', 'phone_ai', '电话 AI 预约并选定包厢'
          ) returning id`;

        await tx`insert into appointment_items (
          org_id, location_id, appointment_id, service_id, membership_id,
          starts_at, ends_at, price_cents_snapshot, duration_min
        ) values (
          ${SPA_ORG}, ${SPA_LOC}, ${apt!.id}, ${serviceIds[svcKey]!}, ${memberIds[techName]!},
          (${spaDate}::date + ${time}::time) at time zone 'America/Los_Angeles',
          (${spaDate}::date + ${time}::time) at time zone 'America/Los_Angeles' + make_interval(mins => ${duration}),
          ${basePrice}, ${duration}
        )`;
      }
    }

    // 16. 营销体系数据（礼品卡 / 优惠券 / 次卡套餐）
    await tx`insert into gift_cards (
      org_id, location_id, code, face_value_cents, sale_price_cents, balance_cents,
      scope, status, source, recipient_name
    ) values
      (${NAIL_ORG}, ${NAIL_LOC}, 'GC-VIP-8888', 20000, 20000, 20000, 'location', 'active', 'front_desk', 'Lisa Chen'),
      (${NAIL_ORG}, ${NAIL_LOC}, 'GC-SUMMER-50', 5000, 5000, 5000, 'location', 'active', 'online', 'Emily Johnson'),
      (${NAIL_ORG}, ${NAIL_LOC}, 'GC-LOTUS-100', 10000, 10000, 4500, 'location', 'active', 'front_desk', '张女士'),
      (${SPA_ORG},  ${SPA_LOC},  'GC-RELAX-75',  7500, 7500, 7500, 'location', 'active', 'online', '陈伟'),
      (${NAIL_ORG}, ${NAIL_LOC}, 'GC-DEPLETED-20', 2000, 2000, 0, 'location', 'depleted', 'front_desk', 'David Miller')`;

    await tx`insert into coupon_templates (
      org_id, location_id, code, name, kind, discount_cents, percent_bp, min_spend_cents, active
    ) values
      (${NAIL_ORG}, ${NAIL_LOC}, 'WELCOME10', ${J({ en: 'New Guest $10 Off', 'zh-Hans': '新客立减 $10' })}, 'amount', 1000, 0, 3000, true),
      (${NAIL_ORG}, ${NAIL_LOC}, 'SUMMER15', ${J({ en: 'Summer 15% Off', 'zh-Hans': '夏日美甲 85 折' })}, 'percent', 0, 1500, 5000, true),
      (${NAIL_ORG}, ${NAIL_LOC}, 'VIP20', ${J({ en: 'VIP $20 Off $100', 'zh-Hans': '满 $100 减 $20' })}, 'amount', 2000, 0, 10000, true),
      (${SPA_ORG},  ${SPA_LOC},  'SPA20', ${J({ en: 'Relaxation $20 Off', 'zh-Hans': '养生理疗立减 $20' })}, 'amount', 2000, 0, 8000, true)`;

    const [pkgNail] = await tx<{ id: string }[]>`
      insert into package_templates (
        org_id, location_id, name, sessions, price_cents, service_ids, active
      ) values
        (${NAIL_ORG}, ${NAIL_LOC}, ${J({ en: 'Gel Manicure 10x Card', 'zh-Hans': '甲油胶美甲 10 次卡' })}, 10, 36000, array[${serviceIds['gel_mani']!}::uuid], true)
      returning id`;

    await tx`insert into package_templates (
      org_id, location_id, name, sessions, price_cents, service_ids, active
    ) values
      (${NAIL_ORG}, ${NAIL_LOC}, ${J({ en: 'Spa Pedicure 5x Card', 'zh-Hans': '尊享手足护理 5 次卡' })}, 5, 22000, array[${serviceIds['dlx_pedi']!}::uuid], true),
      (${SPA_ORG},  ${SPA_LOC},  ${J({ en: 'Deep Tissue 10x Card', 'zh-Hans': '深层精油理疗 10 次季卡' })}, 10, 68000, array[${serviceIds['deep60']!}::uuid], true),
      (${SPA_ORG},  ${SPA_LOC},  ${J({ en: 'Foot Reflexology 6x Card', 'zh-Hans': '经络足道 6 次卡' })}, 6, 21000, array[${serviceIds['reflex60']!}::uuid], true)`;

    // 顾客次卡绑定
    await tx`insert into customer_packages (
      org_id, location_id, customer_id, template_id, remaining_sessions, total_sessions, status, expires_at
    ) values
      (${NAIL_ORG}, ${NAIL_LOC}, ${customerIds['Lisa Chen']!}, ${pkgNail!.id}, 8, 10, 'active', now() + interval '180 days')`;

    // 17. 健康免责声明问卷模板与提交记录 (Form Submissions)
    const [ft] = await tx<{ id: string }[]>`
      insert into form_templates (
        org_id, location_id, key, version, title, schema, requires_signature, published_at, active
      ) values (
        ${NAIL_ORG}, ${NAIL_LOC}, 'nail_pedicure_intake', 1,
        ${J({ en: 'Health Intake & Safety Waiver', 'zh-Hans': '美甲健康问卷与安全免责声明' })},
        ${J([
          { id: 'pregnant', type: 'bool', required: true, label: { 'zh-Hans': '是否怀孕？', en: 'Are you pregnant?' } },
          { id: 'allergies', type: 'multi', required: false, label: { 'zh-Hans': '过敏史', en: 'Allergies' }, options: [{ value: '无', label: { 'zh-Hans': '无', en: 'None' } }] },
        ])}, true, now(), true
      ) returning id`;

    for (const [custName, allergy] of [
      ['Lisa Chen', '青霉素敏感，易甲床敏感'],
      ['张女士', '乳胶过敏，腰椎偏轻按压'],
      ['Emily Johnson', '皮肤轻微干燥，无过敏史'],
    ] as const) {
      await tx`insert into form_submissions (
        org_id, location_id, customer_id, template_id, template_version, version, is_latest,
        signed_at, signer_name, signer_relation, source
      ) values (
        ${NAIL_ORG}, ${NAIL_LOC}, ${customerIds[custName]!}, ${ft!.id}, 1, 1, true,
        now() - interval '2 days', ${custName}, 'self', 'kiosk'
      )`;
    }

    // 18. 多平台口碑与真实评价 (Location Reviews)
    const reviews = [
      {
        platform: 'google', rating: 5, author: 'Lisa Chen',
        content: '艾米老师手法非常沉浸专业，调理后肩颈舒服多了，全程安静无推销，强烈推荐！',
        sentiment: '😊 极度推荐', highlights: ['手法沉浸专业', '无推销', '环境静谧'],
        tech: '艾米', svc: '甲油胶美甲', daysAgo: 1,
      },
      {
        platform: 'google', rating: 5, author: 'Emily Johnson',
        content: 'Great atmosphere! Very clean and quiet. Linh did an amazing job with my gel manicure.',
        sentiment: '😊 极度推荐', highlights: ['Clean & Quiet', 'Amazing Nails'],
        tech: '林玲', svc: '尊享手足 SPA', daysAgo: 3,
      },
      {
        platform: 'yelp', rating: 5, author: 'Jessica Taylor',
        content: 'Loved the hot stone treatment! Super relaxing, definitely coming back every month.',
        sentiment: '😊 极度推荐', highlights: ['Hot Stone Therapy', 'Relaxing'],
        tech: '金金', svc: '基础修手护理', daysAgo: 5,
      },
      {
        platform: 'google', rating: 4, author: 'David Chen',
        content: '华师傅力度非常到位，深层肌肉完全被释放开，就是周末稍微等了 10 分钟，整体很棒。',
        sentiment: '👍 满意', highlights: ['手法深透到位', '高峰等候超10m'],
        tech: '华师傅', svc: '全身深度减压 90 分钟', daysAgo: 7,
      },
      {
        platform: 'google', rating: 5, author: '张女士',
        content: '美美老师很贴心，特意帮我注意了避开腰部旧伤，服务非常周到细致。',
        sentiment: '😊 极度推荐', highlights: ['细致贴心', '手法专业'],
        tech: '美美', svc: '尊享手足 SPA', daysAgo: 9,
      },
    ];

    for (const r of reviews) {
      await tx`insert into location_reviews (
        org_id, location_id, platform, source, external_id, rating, author_name, content,
        ai_sentiment, ai_highlights, technician_name, service_name, posted_at
      ) values (
        ${NAIL_ORG}, ${NAIL_LOC}, ${r.platform}, 'bright_data', ${`rev_${Math.random().toString(36).slice(2, 10)}`},
        ${r.rating}, ${r.author}, ${r.content}, ${r.sentiment}, ${J(r.highlights)},
        ${r.tech}, ${r.svc}, now() - (${r.daysAgo} * interval '1 day')
      )`;
    }

    // 19. AI 电话专线、通话记录 (带录音 URL) 与来电待复核意向草案
    console.log('7. AI 电话专线、通话记录与意向草案生成...');
    await tx`insert into phone_lines (org_id, location_id, e164, purpose, active) values
      (${NAIL_ORG}, ${NAIL_LOC}, '+12125808888', 'ai_voice', true),
      (${NAIL_ORG}, ${NAIL_LOC}, '+12125551234', 'main', true),
      (${NAIL_ORG}, ${NAIL_LOC}, '+19175558888', 'transfer_target', true)
      on conflict do nothing`;

    await tx`insert into phone_calls (
      org_id, location_id, provider_call_id, from_e164, to_e164, started_at, duration_seconds, outcome, tools_used, recording_url, transcript
    ) values
      (${NAIL_ORG}, ${NAIL_LOC}, 'call_session_01', '+1 (917) 555-0199', '+12125808888', now() - interval '2 hours', 98, 'completed', array['book_appointment'], 'https://actions.google.com/sounds/v1/ambiences/coffee_shop.ogg', ${J([
        { role: 'assistant', text: '您好，感谢致电 Lotus Nails & Spa，请问有什么可以帮您？', at: '14:10:02' },
        { role: 'user', text: '你好，我想预约今天下午 4 点做个凝胶美甲，指定 Lisa 师傅。', at: '14:10:08' },
        { role: 'assistant', text: '好的，已为您核对下午 4:00 Lisa 师傅的工位，请问您的名字和电话是？', at: '14:10:15' },
        { role: 'user', text: '我叫 Emily，电话 917-555-0199。', at: '14:10:22' },
        { role: 'assistant', text: '已为您登记待确认草案，前台马上为您锁定工位，感谢致电！', at: '14:10:30' },
      ])}),
      (${NAIL_ORG}, ${NAIL_LOC}, 'call_session_02', '+1 (646) 332-9811', '+12125808888', now() - interval '5 hours', 145, 'completed', array['check_price', 'check_hours'], 'https://actions.google.com/sounds/v1/ambiences/coffee_shop.ogg', ${J([
        { role: 'assistant', text: '您好，Lotus Nails & Spa 很高兴为您服务！', at: '11:20:00' },
        { role: 'user', text: '请问你们今天营业到几点？尊享足疗多少钱？', at: '11:20:06' },
        { role: 'assistant', text: '我们今天营业到晚上 8 点，尊享手足 SPA 价格为 $65，包含海盐足浴与精油去角质。', at: '11:20:15' },
      ])}),
      (${NAIL_ORG}, ${NAIL_LOC}, 'call_session_03', '+1 (212) 889-4412', '+12125808888', now() - interval '1 day', 82, 'completed', array['book_appointment'], 'https://actions.google.com/sounds/v1/ambiences/coffee_shop.ogg', ${J([
        { role: 'assistant', text: '您好，Lotus Nails & Spa，请问今天想做什么项目？', at: '16:00:01' },
        { role: 'user', text: '明天下午 2 点有空做基础修手吗？', at: '16:00:07' },
        { role: 'assistant', text: '明天 14:00 有充足工位，已为您预先留位！', at: '16:00:15' },
      ])})
      on conflict (provider_call_id) do nothing`;

    await tx`insert into call_drafts (
      id, org_id, location_id, from_e164, caller_name_heard, status, confidence_bp,
      service_name_heard, time_heard, slot_starts_at, notes
    ) values
      ('b1111111-1111-4000-8000-111111111111', ${NAIL_ORG}, ${NAIL_LOC}, '+1 (917) 555-0199', 'Emily Johnson', 'pending', 9200, '凝胶美甲', '今日 16:00', now() + interval '1 hour', '客人指定希望由 Lisa 师傅服务'),
      ('b2222222-2222-4000-8000-222222222222', ${NAIL_ORG}, ${NAIL_LOC}, '+1 (646) 332-9811', 'Sarah Jenkins', 'pending', 8800, '尊享手足护理', '明天 14:00', now() + interval '1 day', '询问了是否有双人包厢')
      on conflict (id) do nothing`;
  });

  console.log('✓ 种子数据填充完毕！');
  const counts = await adminSql<{ t: string; n: number }[]>`
    select 'organizations' as t, count(*)::int as n from organizations
    union all select 'locations', count(*)::int from locations
    union all select 'services', count(*)::int from services
    union all select 'resources', count(*)::int from resources
    union all select 'customers', count(*)::int from customers
    union all select 'memberships', count(*)::int from memberships
    union all select 'shifts (29天)', count(*)::int from shifts
    union all select 'appointments (过去/今日/未来)', count(*)::int from appointments
    union all select 'tickets (已结/进行中工单)', count(*)::int from tickets
    union all select 'payments (收款流水)', count(*)::int from payments
    union all select 'gift_cards (礼品卡)', count(*)::int from gift_cards
    union all select 'coupon_templates (优惠券)', count(*)::int from coupon_templates
    union all select 'package_templates (次卡套餐)', count(*)::int from package_templates
    union all select 'location_reviews (口碑评价)', count(*)::int from location_reviews`;
  for (const c of counts) console.log(`  ${c.t.padEnd(30)} ${c.n}`);

  await adminSql.end({ timeout: 5 });
}

main().catch(async (e) => {
  console.error('\n种子失败：', e instanceof Error ? e.message : e);
  await adminSql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
