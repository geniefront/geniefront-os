/**
 * 种子数据：两家假店（一家 nail、一家 foot spa），分属两个不同的 org。
 *
 * 两个 org 是故意的 —— Phase 0 验收要证明 RLS 真的拦得住跨租户读取，
 * 同一个 org 下的两家店测不出这件事。
 */

import { createHash } from 'node:crypto';
import { adminSql } from './admin';
import { ROLE_PRESETS } from '@gf/contracts';

/**
 * 种子员工要同时存在于 Supabase Auth，且 id 与我们 users 表一致 ——
 * 否则登录后 JWT 里的 sub 找不到对应 membership，选店器永远是空的。
 *
 * 让 Auth 做 id 的源头，我们跟着它走。开发期统一密码，生产走 Magic Link。
 */
const SB_URL = process.env.SUPABASE_URL!;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
export const DEV_PASSWORD = 'GenieDev!2026';


/**
 * 种子店的公开预约 key（docs/13 §3）。
 *
 * 从门店 uuid 推出来而不是随机：重新灌种子时它**不变** ——
 * 开发时在官网 demo 里粘过一次就不用再改。
 *
 * ⚠️ 真实门店的 key 由 sql/0033 的触发器生成（24 位随机 hex）。
 * 这里的形状必须同样过得了那个触发器的长度检查，否则一插进去就被换掉，
 * 而「换掉」是静默的 —— 你会拿着一个查不到店的 key 找半天。
 */
const publicKeyFor = (locationId: string): string =>
  `pk_${locationId.replace(/-/g, '').slice(0, 24)}`;

const sha256 = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex');

/**
 * 种子店的电话工具 token（sql/0036）。
 *
 * 和 `publicKeyFor` 一样从门店 uuid 推出来而不是随机：重灌种子时它**不变**，
 * 本地那个假电话脚本不用每次重配。
 * ⚠️ 只对种子成立 —— 真实门店的这串东西由 `location.savePhoneLine` 随机生成，
 * 而且只露一次面。**任何真号都不许用这里的算法。**
 */
const toolTokenFor = (locationId: string): string => {
  // 真号在哪家店测，就用哪家店的环境变量把 Telnyx 上配的那串带进来
  const override = locationId === SPA_LOC
    ? process.env.SEED_SPA_TOOL_TOKEN
    : process.env.SEED_TOOL_TOKEN;
  return override ?? `st_dev_${locationId.replace(/-/g, '')}`;
};

async function upsertAuthUser(email: string, fullName: string): Promise<string> {
  // CI 里不碰真实的 Supabase Auth —— 否则每跑一次流水线就往生产项目里
  // 塞一批测试账号，而且 CI 也不该持有能建用户的凭据。
  if (process.env.SEED_SKIP_AUTH === '1') return crypto.randomUUID();
  const h = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json',
  };
  // 已存在就直接取（种子要可重复跑）
  const found = await fetch(
    `${SB_URL}/auth/v1/admin/users?filter=${encodeURIComponent(email)}`, { headers: h },
  ).then((r) => r.json() as Promise<{ users?: Array<{ id: string; email: string }> }>);
  const hit = found.users?.find((u) => u.email === email);
  if (hit) return hit.id;

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

/** 落单要素预设（02 §3.2）。按业态出，店主可改。 */
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
    label: { en: 'Focus areas', 'zh-Hans': '重点部位', vi: 'Vùng tập trung', ko: '집중 부위' },
    options: [
      { value: 'head_neck', label: { en: 'Head & neck', 'zh-Hans': '头颈' } },
      { value: 'shoulders', label: { en: 'Shoulders', 'zh-Hans': '肩' } },
      { value: 'upper_back', label: { en: 'Upper back', 'zh-Hans': '上背' } },
      { value: 'lower_back', label: { en: 'Lower back', 'zh-Hans': '下背腰' } },
      { value: 'hips', label: { en: 'Hips & glutes', 'zh-Hans': '臀胯' } },
      { value: 'thighs', label: { en: 'Thighs', 'zh-Hans': '大腿' } },
      { value: 'calves', label: { en: 'Calves', 'zh-Hans': '小腿' } },
      { value: 'feet', label: { en: 'Feet', 'zh-Hans': '足' } },
      { value: 'arms', label: { en: 'Arms', 'zh-Hans': '手臂' } },
    ],
  },
  {
    // ⚠️ 与健康表双向关联：勾了「近期手术」要自动预填进这里
    key: 'avoid_areas', input: 'bodymap', sticky: true, to_staff: true, required: false, sort: 3,
    label: { en: 'AVOID areas', 'zh-Hans': '避开部位', vi: 'Vùng TRÁNH', ko: '피할 부위' },
    hint: { en: 'Recent surgery, injury, varicose veins, bruising', 'zh-Hans': '近期手术、扭伤、静脉曲张、淤青、皮肤破损' },
    options: [],
  },
  {
    key: 'oil_preference', input: 'single', sticky: true, to_staff: true, required: false, sort: 4,
    label: { en: 'Oil / medium', 'zh-Hans': '精油/介质' },
    hint: { en: '⚠️ Check nut oil allergy — almond oil is common', 'zh-Hans': '⚠️ 坚果油过敏必查，杏仁油很常见' },
    options: [
      { value: 'none', label: { en: 'No oil', 'zh-Hans': '无油' } },
      { value: 'basic', label: { en: 'Basic oil', 'zh-Hans': '基础油' } },
      { value: 'lavender', label: { en: 'Lavender', 'zh-Hans': '薰衣草' } },
      { value: 'ginger', label: { en: 'Ginger', 'zh-Hans': '姜' } },
    ],
  },
  {
    key: 'talk_preference', input: 'single', sticky: true, to_staff: true, required: false, sort: 5,
    label: { en: 'Conversation', 'zh-Hans': '是否聊天' },
    options: [
      { value: 'quiet', label: { en: 'Prefers quiet', 'zh-Hans': '想安静' } },
      { value: 'either', label: { en: 'Either', 'zh-Hans': '随意' } },
      { value: 'chatty', label: { en: 'Likes to chat', 'zh-Hans': '喜欢聊' } },
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
    // 最容易漏、最容易吵架的一项：漏了少收 15–30 分钟和 $10–20，还打乱后面排期
    key: 'removal', input: 'single', sticky: false, to_staff: true, required: true, sort: 2,
    label: { en: 'Removal needed?', 'zh-Hans': '是否需要卸甲', vi: 'Cần tháo?' },
    options: [
      { value: 'none', label: { en: 'No removal', 'zh-Hans': '不需要' } },
      { value: 'own', label: { en: 'Remove ours', 'zh-Hans': '卸同款' } },
      { value: 'foreign', label: { en: "Remove other salon's (+time +fee)", 'zh-Hans': '卸他店的（+时长+价）' } },
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
      { value: 'coffin', label: { en: 'Coffin', 'zh-Hans': '棺材' } },
      { value: 'stiletto', label: { en: 'Stiletto', 'zh-Hans': '尖' } },
    ],
  },
  {
    key: 'color_ref', input: 'color', sticky: true, to_staff: true, required: false, sort: 4,
    label: { en: 'Color', 'zh-Hans': '色号' },
    hint: { en: 'Brand + code; last visit photo shown alongside', 'zh-Hans': '品牌 + 色号，旁边显示上次照片' },
    options: [],
  },
  {
    key: 'nail_condition', input: 'multi', sticky: true, to_staff: true, required: false, sort: 5,
    label: { en: 'Nail condition', 'zh-Hans': '甲况' },
    options: [
      { value: 'brittle', label: { en: 'Brittle', 'zh-Hans': '易断' } },
      { value: 'biting', label: { en: 'Nail biting', 'zh-Hans': '咬甲' } },
      { value: 'short_bed', label: { en: 'Short nail bed', 'zh-Hans': '甲床短' } },
      { value: 'fungus', label: { en: 'Fungus', 'zh-Hans': '灰指甲' } },
      { value: 'acrylate_allergy', label: { en: '⚠️ Acrylate allergy', 'zh-Hans': '⚠️ 丙烯酸酯过敏' } },
    ],
  },
];

/**
 * ⭐ 灌之前先看一眼：库里有没有**不是这次要插的**真号绑在 AI 线上。
 *
 * 种子是按 org 删 `phone_lines` 再插的，所以运维手工绑的真号会被静默冲掉 ——
 * 表现是 Telnyx 那边配好的 `shop_token` 和库里对不上，那家店的电话全部 401，
 * 而做这件事的人当时只是想「重灌一下种子数据」。
 *
 * 这个函数把它变成一句拦下来的话。真要覆盖：`SEED_FORCE=1`。
 */
async function guardRealNumbers(about: readonly string[]): Promise<void> {
  const rows = await adminSql<{ e164: string; name: string }[]>`
    select p.e164, l.name->>'en' as name
    from phone_lines p join locations l on l.id = p.location_id
    where p.location_id in (${NAIL_LOC}, ${SPA_LOC})
      and p.purpose = 'ai_voice' and p.active
      and p.e164 <> all(${about as string[]})`;
  if (rows.length === 0 || process.env.SEED_FORCE === '1') return;

  console.error('\n⚠️  停一下 —— 种子会把下面这些号从种子店上解绑：\n');
  for (const r of rows) console.error(`      ${r.e164}  （现在绑在 ${r.name}）`);
  console.error('\n  它们不是种子里的 555 假号，看起来是真号。解绑之后 Telnyx 那边配好的');
  console.error('  shop_token 会和库里对不上 —— 那家店的电话会全部 401。\n');
  console.error('  要保住它（连同它的 token，token 在 Telnyx 的 assistant 配置里）：');
  console.error('      SEED_SPA_AI_LINE=<那个号> SEED_SPA_TOOL_TOKEN=st_… pnpm db:seed');
  console.error('  确实要清掉：SEED_FORCE=1 pnpm db:seed\n');
  process.exit(1);
}

async function main() {
  console.log('\n═══ 种子数据 ═══\n');

  await guardRealNumbers([
    process.env.SEED_AI_LINE ?? '+12125550123',
    process.env.SEED_SPA_AI_LINE ?? '+13235550123',
  ]);

  await adminSql.begin(async (tx) => {
    // postgres.js 的模板参数不接受裸对象：jsonb 值必须显式声明
    const J = (v: unknown) => tx.json(v as never);

    // 幂等：按依赖倒序清掉旧种子。
    // 外键没设 ON DELETE CASCADE 是故意的 —— 生产环境不该有人能一条 delete
    // 就带走一家店的全部历史。所以这里显式列出顺序。
    // audit_log 不在列内：它 append-only，而且没有 FK 指向 organizations。
    const orgs = [NAIL_ORG, SPA_ORG];
    const locs = [NAIL_LOC, SPA_LOC];
    /**
     * ⚠️ 这两张表没有 `org_id`，只能按门店删。
     * 漏掉它们的表现是「种子昨天还能重跑，今天报外键冲突」——
     * 因为直到有人真的在 iPad 上打了一次卡，这张表才第一次有行。
     */
    const LOCATION_SCOPED = new Set(['stripe_events', 'user_last_location']);

    for (const t of [
      // 财务流水排在最前：它们的外键钉着 memberships，不先清就删不掉员工。
      // 这几张表在生产上是删不掉的（0009 的触发器），种子脚本用的是
      // 迁移角色，所以能过 —— 这正是那条触发器只挡 app_user 的原因。
      'earnings', 'tip_payouts', 'cash_movements', 'day_closes',
      'tip_allocations', 'payments', 'ticket_item_staff', 'ticket_items',
      'tickets', 'ticket_groups', 'tip_policies',
      // 打卡与上机会话：技师在自己手机/iPad 上用过之后才会有行，
      // 而它们同样钉着 memberships
      'time_punches', 'staff_sessions',
      'walkin_queue',
      'form_access_log', 'form_submissions', 'form_templates',
      // 电话与短信：call_drafts 钉着 memberships / services / customers
      'call_drafts', 'phone_calls', 'phone_lines', 'sms_outbox', 'email_outbox',
      // 计费：credit_ledger 钉着 billing_accounts
      'credit_ledger', 'usage_events', 'stripe_events',
      'billing_accounts', 'location_subscriptions',
      'blueprint_items', 'blueprint_sources', 'shop_blueprints',
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
      '__users__',
      'location_allowed_origins', 'location_features', 'signup_intents',
      'locations',
    ]) {
      // 无 org_id 的连接表走父表推导
      if (t === '__users__') {
        // users 是全局表，没有 org_id：只删这两家店造出来的测试账号
        await tx`delete from users where email like '%@example.test'`;
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
      } else if (LOCATION_SCOPED.has(t)) {
        await tx.unsafe(`delete from ${t} where location_id = any($1)`, [locs as never]);
      } else {
        await tx.unsafe(`delete from ${t} where org_id = any($1)`, [orgs as never]);
      }
    }
    await tx`delete from organizations where id in (${NAIL_ORG}, ${SPA_ORG})`;

    await tx`insert into organizations (id, name, owner_user_id, default_locale) values
      (${NAIL_ORG}, 'Lotus Nails Group', gen_random_uuid(), 'zh-Hans'),
      (${SPA_ORG},  'Golden Foot Spa',   gen_random_uuid(), 'zh-Hans')`;

    await tx`insert into locations
      (id, org_id, name, slug, timezone, business_type, public_key, business_day_cutoff,
       business_hours, settings) values
      (${NAIL_LOC}, ${NAIL_ORG},
        ${J({ en: 'Lotus Nails & Spa', 'zh-Hans': '莲花美甲' })}, 'lotus-nails',
        -- ⚠️ cutoff 只对开到凌晨的店有意义：它表示「早于这个点算前一天」。
        -- 正常营业到晚上 8 点的美甲店设 04:00，凌晨收尾的单还算当天。
        -- 设成 21:00 会让白天所有的单都归到前一天，方向是反的。
        'America/New_York', 'nail', ${publicKeyFor(NAIL_LOC)}, '04:00',
        ${J({ mon:{open:'09:30',close:'19:30'}, tue:{open:'09:30',close:'19:30'},
              wed:{open:'09:30',close:'19:30'}, thu:{open:'09:30',close:'19:30'},
              fri:{open:'09:30',close:'20:00'}, sat:{open:'09:00',close:'20:00'},
              sun:{open:'10:00',close:'18:00'} })},
        ${J({
          capacity: { slot_minutes: 15, max_concurrent_per_slot: null, overbook: 'warn' },
          /*
           * ⭐ 种子店直接打开在线预约。
           *
           * 真实门店默认是关的（sql/0033 §5：项目和排班没配全之前，
           * 官网上不该能订到它）。但种子店项目、排班、加项都齐了，
           * 关着的话预约页只显示一句「这家店目前不接受网上预约」——
           * 想试一下的人会以为是自己配错了。
           */
          online_booking: {
            enabled: true, max_days_ahead: 60, min_minutes_ahead: 120,
            require_phone_verification: false, cancel_cutoff_hours: 4,
          },
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
        })})`;

    // 足疗店：两间单人房 + 一间大厅。
    // ⭐ 大厅 capacity = 4：一间房同时躺四位客人是足疗店的常态，
    // 「一房一客」反而是少数（Phase 1b 起资源容量可以大于 1）。
    const [roomType] = await tx<{ id: string }[]>`
      insert into resource_types (org_id, location_id, key, name)
      values (${SPA_ORG}, ${SPA_LOC}, 'room', ${J({ en: 'Room', 'zh-Hans': '房间' })})
      returning id`;
    for (const [name, cap, maxStaff] of [
      ['Room 1', 1, 1], ['Room 2', 1, 1], ['大厅 Hall', 4, null],
    ] as const) {
      await tx`insert into resources
        (org_id, location_id, resource_type_id, name, capacity, max_staff)
        values (${SPA_ORG}, ${SPA_LOC}, ${roomType!.id}, ${name}, ${cap}, ${maxStaff})`;
    }

    // 美甲店：pedicure 椅
    const [chairType] = await tx<{ id: string }[]>`
      insert into resource_types (org_id, location_id, key, name)
      values (${NAIL_ORG}, ${NAIL_LOC}, 'pedi_chair', ${J({ en: 'Pedicure chair', 'zh-Hans': '足疗椅' })})
      returning id`;
    for (const n of ['1', '2', '3', '4']) {
      await tx`insert into resources (org_id, location_id, resource_type_id, name)
        values (${NAIL_ORG}, ${NAIL_LOC}, ${chairType!.id}, ${'Chair ' + n})`;
    }

    /*
     * ── 项目表 ────────────────────────────────────────────────────────────
     *
     * 比「两家店各两个项目」长了不少，理由是电话 AI 那六个工具**只有在
     * 数据像真的时候才测得出问题**：
     *
     *   · 有分类   → `list_services` 的 category 过滤才有东西可过滤
     *   · 有加项   → 才验得到「热石是加项不是完整项目」（sql/0035）
     *   · 时长不一 → 才验得到 45/60/90 分钟找出来的空档不一样
     *   · 名字相近 → `bestMatch` 的「命中多个就留空」才有机会被触发
     *     （Gel Manicure / Gel Removal 就是真店里最常见的那一对）
     */
    const cats: Record<string, string> = {};
    for (const [key, org, loc, name, sort] of [
      ['nail_mani',  NAIL_ORG, NAIL_LOC, { en: 'Manicure', 'zh-Hans': '美甲' }, 1],
      ['nail_pedi',  NAIL_ORG, NAIL_LOC, { en: 'Pedicure', 'zh-Hans': '修脚' }, 2],
      ['nail_addon', NAIL_ORG, NAIL_LOC, { en: 'Add-ons', 'zh-Hans': '加项' }, 3],
      ['spa_massage', SPA_ORG, SPA_LOC,  { en: 'Massage', 'zh-Hans': '按摩' }, 1],
      ['spa_foot',    SPA_ORG, SPA_LOC,  { en: 'Foot', 'zh-Hans': '足疗' }, 2],
      ['spa_addon',   SPA_ORG, SPA_LOC,  { en: 'Add-ons', 'zh-Hans': '加项' }, 3],
    ] as const) {
      const [c] = await tx<{ id: string }[]>`
        insert into service_categories (org_id, location_id, name, sort)
        values (${org}, ${loc}, ${J(name)}, ${sort}) returning id`;
      cats[key] = c!.id;
    }

    const serviceIds: Record<string, string> = {};
    for (const [key, org, loc, cat, name, min, cents, addon] of [
      // 美甲店
      ['gel_mani',   NAIL_ORG, NAIL_LOC, 'nail_mani', { en: 'Gel Manicure', 'zh-Hans': '甲油胶美甲' }, 45, 4500, false],
      ['basic_mani', NAIL_ORG, NAIL_LOC, 'nail_mani', { en: 'Classic Manicure', 'zh-Hans': '基础美甲' }, 30, 2500, false],
      ['full_set',   NAIL_ORG, NAIL_LOC, 'nail_mani', { en: 'Full Set Acrylic', 'zh-Hans': '水晶甲全套' }, 75, 6500, false],
      ['dlx_pedi',   NAIL_ORG, NAIL_LOC, 'nail_pedi', { en: 'Deluxe Pedicure', 'zh-Hans': '豪华修脚' }, 60, 5500, false],
      ['spa_pedi',   NAIL_ORG, NAIL_LOC, 'nail_pedi', { en: 'Spa Pedicure', 'zh-Hans': 'SPA 修脚' }, 45, 4000, false],
      ['gel_off',    NAIL_ORG, NAIL_LOC, 'nail_addon', { en: 'Gel Removal', 'zh-Hans': '卸甲' }, 15, 1000, true],
      ['nail_art',   NAIL_ORG, NAIL_LOC, 'nail_addon', { en: 'Nail Art', 'zh-Hans': '彩绘' }, 15, 1500, true],
      ['paraffin',   NAIL_ORG, NAIL_LOC, 'nail_addon', { en: 'Paraffin', 'zh-Hans': '石蜡护理' }, 10, 1200, true],
      // 足疗店
      ['reflex60',  SPA_ORG, SPA_LOC, 'spa_foot',    { en: 'Foot Reflexology 60min', 'zh-Hans': '足底按摩 60 分钟' }, 60, 4000, false],
      ['reflex90',  SPA_ORG, SPA_LOC, 'spa_foot',    { en: 'Foot Reflexology 90min', 'zh-Hans': '足底按摩 90 分钟' }, 90, 5500, false],
      ['deep60',    SPA_ORG, SPA_LOC, 'spa_massage', { en: 'Deep Tissue 60min', 'zh-Hans': '深层按摩 60 分钟' }, 60, 7500, false],
      ['deep90',    SPA_ORG, SPA_LOC, 'spa_massage', { en: 'Deep Tissue 90min', 'zh-Hans': '深层按摩 90 分钟' }, 90, 9500, false],
      ['swedish60', SPA_ORG, SPA_LOC, 'spa_massage', { en: 'Swedish 60min', 'zh-Hans': '瑞典式按摩 60 分钟' }, 60, 6500, false],
      ['hot_stone', SPA_ORG, SPA_LOC, 'spa_addon',   { en: 'Hot Stone', 'zh-Hans': '热石' }, 15, 1500, true],
      ['cupping',   SPA_ORG, SPA_LOC, 'spa_addon',   { en: 'Cupping', 'zh-Hans': '拔罐' }, 15, 2000, true],
    ] as const) {
      const [row] = await tx<{ id: string }[]>`
        insert into services
          (org_id, location_id, category_id, name, duration_min, base_price_cents,
           online_bookable, is_addon, sort)
        values (${org}, ${loc}, ${cats[cat]!}, ${J(name)}, ${min}, ${cents},
                true, ${addon}, ${Object.keys(serviceIds).length})
        returning id`;
      serviceIds[key] = row!.id;
    }

    // ⭐ 默认薪酬方案：两家店都是 40% 提成、按折后金额算。
    // 不给默认方案的话，第一天结账就会用引擎的兜底值，
    // 老板看到一个他没设过的数字，第一反应是系统在乱算。
    for (const [org, loc] of [[NAIL_ORG, NAIL_LOC], [SPA_ORG, SPA_LOC]] as const) {
      await tx`insert into compensation_plans (org_id, location_id, membership_id, version, config)
        values (${org}, ${loc}, null, 1, ${J({
          kind: 'commission', rateBp: 4000, categoryRateBp: {},
          retailRateBp: 1000, hourlyRateCents: 0, base: 'net',
          roleWeightBp: { primary: 10000, assistant: 3000 },
        })})`;
    }

    // 落单要素预设
    for (const [org, loc, opts] of [
      [NAIL_ORG, NAIL_LOC, NAIL_OPTIONS],
      [SPA_ORG, SPA_LOC, MASSAGE_OPTIONS],
    ] as const) {
      for (const o of opts) {
        await tx`insert into service_option_defs
          (org_id, location_id, key, label, hint, input, options, sticky, to_staff, required, sort)
          values (${org}, ${loc}, ${o.key}, ${J(o.label)}, ${J('hint' in o ? o.hint : null)},
                  ${o.input}, ${J(o.options)}, ${o.sticky}, ${o.to_staff}, ${o.required}, ${o.sort})`;
      }
    }

    // ── 角色预设 ──────────────────────────────────────────────────────────
    // 权限来自 packages/contracts 的 ROLE_PRESETS，不在这里重新抄一遍
    const roleIds: Record<string, Record<string, string>> = {};
    for (const [org, loc] of [[NAIL_ORG, NAIL_LOC], [SPA_ORG, SPA_LOC]] as const) {
      roleIds[loc] = {};
      for (const [key, perms] of Object.entries(ROLE_PRESETS)) {
        const [r] = await tx<{ id: string }[]>`
          insert into roles (org_id, location_id, key, name, is_preset)
          values (${org}, ${loc}, ${key}, ${J({ en: key })}, true) returning id`;
        roleIds[loc]![key] = r!.id;
        for (const p of perms) {
          await tx`insert into role_permissions (role_id, permission) values (${r!.id}, ${p})`;
        }
      }
    }

    // ── 员工 ─────────────────────────────────────────────────────────────
    // 覆盖「一人多角色」：Amy 是店长兼技师 —— 可被排单，但不吃 walk-in 轮
    /*
     * ⭐ `gender` 是给电话 AI 用的（`list_staff` 的筛选、`find_slots` 的
     * gender_preference）。「要女技师」在这一行是真实且高频的诉求。
     * 两家店都**至少各有一位男技师**，否则「只要女技师」这条路
     * 在种子数据上永远返回全部，等于没测。
     */
    const staff = [
      { org: NAIL_ORG, loc: NAIL_LOC, name: 'Amy',  roles: ['manager', 'tech'], bookable: true,  maxConc: 2, inRotation: false, gender: 'female', skills: ['gel', 'acrylic'] },
      { org: NAIL_ORG, loc: NAIL_LOC, name: 'Linh', roles: ['tech'],            bookable: true,  maxConc: 2, inRotation: true,  gender: 'female', skills: ['gel', 'pedicure'] },
      { org: NAIL_ORG, loc: NAIL_LOC, name: 'Kim',  roles: ['tech'],            bookable: true,  maxConc: 1, inRotation: true,  gender: 'female', skills: ['pedicure'] },
      { org: NAIL_ORG, loc: NAIL_LOC, name: 'Tran', roles: ['tech'],            bookable: true,  maxConc: 2, inRotation: true,  gender: 'male',   skills: ['acrylic'] },
      { org: NAIL_ORG, loc: NAIL_LOC, name: 'Mai',  roles: ['senior_tech'],     bookable: true,  maxConc: 1, inRotation: true,  gender: 'female', skills: ['gel', 'acrylic', 'pedicure'] },
      { org: NAIL_ORG, loc: NAIL_LOC, name: 'Mia',  roles: ['front_desk'],      bookable: false, maxConc: 1, inRotation: false, gender: 'female', skills: [] },
      { org: SPA_ORG,  loc: SPA_LOC,  name: 'Yan',  roles: ['tech'],            bookable: true,  maxConc: 1, inRotation: true,  gender: 'female', skills: ['reflexology', 'prenatal'] },
      { org: SPA_ORG,  loc: SPA_LOC,  name: 'Hua',  roles: ['tech'],            bookable: true,  maxConc: 1, inRotation: true,  gender: 'female', skills: ['deep_tissue', 'reflexology'] },
      { org: SPA_ORG,  loc: SPA_LOC,  name: 'Bo',   roles: ['tech'],            bookable: true,  maxConc: 1, inRotation: true,  gender: 'male',   skills: ['deep_tissue'] },
      { org: SPA_ORG,  loc: SPA_LOC,  name: 'Owner',roles: ['owner'],           bookable: false, maxConc: 1, inRotation: false, gender: null,     skills: [] },
    ];

    // 技能表。`list_staff` 要报「谁擅长这个项目」，空数组测不出这件事
    const skillIds: Record<string, string> = {};
    for (const [key, org, loc, name] of [
      ['gel',          NAIL_ORG, NAIL_LOC, { en: 'Gel', 'zh-Hans': '甲油胶' }],
      ['acrylic',      NAIL_ORG, NAIL_LOC, { en: 'Acrylic', 'zh-Hans': '水晶甲' }],
      ['pedicure',     NAIL_ORG, NAIL_LOC, { en: 'Pedicure', 'zh-Hans': '修脚' }],
      ['deep_tissue',  SPA_ORG,  SPA_LOC,  { en: 'Deep tissue', 'zh-Hans': '深层' }],
      ['reflexology',  SPA_ORG,  SPA_LOC,  { en: 'Reflexology', 'zh-Hans': '足底' }],
      ['prenatal',     SPA_ORG,  SPA_LOC,  { en: 'Prenatal', 'zh-Hans': '孕妇' }],
    ] as const) {
      const [row] = await tx<{ id: string }[]>`
        insert into skills (org_id, location_id, key, name)
        values (${org}, ${loc}, ${key}, ${J(name)}) returning id`;
      skillIds[key] = row!.id;
    }

    /** 名字 → membership id，后面排班和造预约都要用 */
    const memberIds: Record<string, string> = {};

    for (const p of staff) {
      const email = `${p.name.toLowerCase()}@example.test`;
      const authId = await upsertAuthUser(email, p.name);
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
        (membership_id, org_id, location_id, display_name, gender,
         is_bookable, max_concurrent_appointments)
        values (${m!.id}, ${p.org}, ${p.loc}, ${J({ en: p.name })}, ${p.gender},
                ${p.bookable}, ${p.maxConc})`;
      for (const k of p.skills) {
        await tx`insert into staff_skills (membership_id, skill_id)
                 values (${m!.id}, ${skillIds[k]!})`;
      }
      // 今天和明天都种：演示时不会因为跨营业日而落空
      for (const d of ['current_date', "current_date + 1"]) {
        await tx.unsafe(
          `insert into rotation_participants (org_id, location_id, business_date, membership_id, in_rotation)
           values ($1, $2, ${d}, $3, $4)`,
          [p.org, p.loc, m!.id, p.inRotation] as never,
        );
      }
    }

    const customerIds: Record<string, string> = {};
    for (const [org, loc, name, phone, src] of [
      [NAIL_ORG, NAIL_LOC, 'Lisa Chen', '+19175550142', 'walkin'],
      // 同号多客户（夫妻共号）是被允许的，决策 21：电话 AI 必须开口问是哪一位
      [NAIL_ORG, NAIL_LOC, '张女士',     '+19175550188', 'walkin'],
      [NAIL_ORG, NAIL_LOC, '张先生',     '+19175550188', 'walkin'],
      [SPA_ORG,  SPA_LOC,  'Wang Ming', '+16265550101', 'phone'],
    ] as const) {
      const [row] = await tx<{ id: string }[]>`
        insert into customers (org_id, primary_location_id, display_name, phone_e164, source)
        values (${org}, ${loc}, ${name}, ${phone}, ${src}) returning id`;
      customerIds[name] = row!.id;
    }

    // ── 电话线 ────────────────────────────────────────────────────────────
    /*
     * ⭐ 没有这几行，六个电话工具**每一个都返回 404** ——
     * webhook 里唯一能确定租户的东西就是被叫号码（`phone_lines.e164 → location`）。
     *
     * `ai_voice` 的号是全局唯一的（sql/0025 的部分唯一索引），所以这里用的是
     * 555 段的假号。要拿真号打进种子店，设 `SEED_AI_LINE=+1…` 再灌一次。
     */
    /*
     * ⚠️ **重灌种子会顶掉真号的绑定。**
     *
     * 上面那段清理是按 org 删 `phone_lines` 的，所以运维手工绑过的真号
     * （`ops/bindAiLine.ts`）会跟着没。真号在测的时候，用这两个环境变量
     * 把它带进来，顺便**保住它的 token** —— 否则 Telnyx 那边配好的
     * `shop_token` 会和库里对不上，那家店的电话当场全 401。
     *
     *   SEED_AI_LINE=+1…          美甲店的 AI 号
     *   SEED_SPA_AI_LINE=+1…      足疗店的 AI 号
     *   SEED_TOOL_TOKEN=st_…      美甲店的工具 token
     *   SEED_SPA_TOOL_TOKEN=st_…  足疗店的工具 token
     *
     * 真号在足疗店上测的时候，重灌种子要这么跑：
     *
     *   SEED_SPA_AI_LINE=+17579999968 SEED_SPA_TOOL_TOKEN=st_… pnpm db:seed
     */
    const nailAiLine = process.env.SEED_AI_LINE ?? '+12125550123';
    const spaAiLine = process.env.SEED_SPA_AI_LINE ?? '+13235550123';
    for (const [org, loc, e164, purpose] of [
      [NAIL_ORG, NAIL_LOC, nailAiLine,     'ai_voice'],
      [NAIL_ORG, NAIL_LOC, '+12125550100', 'main'],
      [SPA_ORG,  SPA_LOC,  spaAiLine,      'ai_voice'],
      [SPA_ORG,  SPA_LOC,  '+13235550100', 'main'],
    ] as const) {
      /*
       * ⭐ AI 线还要一串工具 token（sql/0036）—— 验签之后的第二道门。
       *
       * 真实门店的这串东西**只在建线那次返回里出现一次**，
       * 库里只有摘要。种子这边明文留在内存里，最后打印出来给你贴进
       * Telnyx 的 assistant 配置（或喂给 scripts/voice-tool.mjs）。
       *
       * ⚠️ 种子用的是固定的开发 token（`SEED_TOOL_TOKEN` 可覆盖），
       * 因为重灌一次种子就换一串的话，本地测试脚本每次都要重配。
       * 生产上它必须是随机的 —— 那条路走的是命令，不走这里。
       */
      const isAi = purpose === 'ai_voice';
      const token = isAi ? toolTokenFor(loc) : null;
      await tx`insert into phone_lines (org_id, location_id, e164, purpose, tool_token_digest)
               values (${org}, ${loc}, ${e164}, ${purpose},
                       ${token ? sha256(token) : null})`;
    }

    // ── 班表 ──────────────────────────────────────────────────────────────
    /*
     * ⭐ 同样是「不种就整条路是死的」：`find_slots` 只认 **published** 的班，
     * 没有班次就永远返回空数组 —— 而那个表现和「今天真的约满了」一模一样，
     * 演示时会以为是排期引擎坏了。
     *
     * 从**昨天**起种 8 天：营业日按门店时区算，而数据库跑在 UTC，
     * 纽约时间晚上八点在库里已经是第二天了。多种一天，边界怎么算都不落空。
     */
    const dayList = (tz: string, n: number): string[] => {
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date());
      return Array.from({ length: n }, (_, i) => {
        const d = new Date(`${today}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() + i - 1);
        return d.toISOString().slice(0, 10);
      });
    };

    const nailDays = dayList('America/New_York', 8);
    const spaDays = dayList('America/Los_Angeles', 8);

    for (const p of staff) {
      if (!p.bookable) continue;   // 前台和老板不接客，排了班也不该出现在空档里
      const days = p.loc === NAIL_LOC ? nailDays : spaDays;
      // 班次按门店营业时间：美甲 09:30–19:30，足疗 10:00–23:00
      const [startMin, endMin] = p.loc === NAIL_LOC ? [570, 1170] : [600, 1380];
      for (const [i, date] of days.entries()) {
        /*
         * Kim 明天休息（i === 2 = 明天，因为第 0 天是昨天）。
         * 一个人都不休的班表测不出「客人点名的技师那天不在」这条路，
         * 而那是电话里最常见的一种为难。
         */
        const off = p.name === 'Kim' && i === 2;
        await tx`insert into shifts
          (org_id, location_id, membership_id, business_date, start_min, end_min,
           status, published_at, off_reason)
          values (${p.org}, ${p.loc}, ${memberIds[p.name]!}, ${date},
                  ${startMin}, ${endMin},
                  ${off ? 'off' : 'published'}, now(), ${off ? 'personal' : null})`;
      }
    }

    // ── 几条预约 ──────────────────────────────────────────────────────────
    /*
     * 一张全空的日程表也测不出东西：`find_slots` 得有单可避，
     * `lookup_customer` 得报得出「上次做的是什么」。
     *
     * ⚠️ 墙上时间 → 时刻的换算交给 Postgres（`at time zone`）。
     * 在 JS 里手算偏移，夏令时那两周会错一小时 —— 而错的方向是
     * 「报出去的时间前台说没有」。
     */
    const book = async (
      org: string, loc: string, tz: string, date: string, hhmm: string,
      minutes: number, customer: string, member: string, service: string, source: string,
    ) => {
      const [a] = await tx<{ id: string }[]>`
        insert into appointments
          (org_id, location_id, customer_id, business_date, starts_at, ends_at,
           status, source)
        values (${org}, ${loc}, ${customerIds[customer]!}, ${date},
                (${date}::date + ${hhmm}::time) at time zone ${tz},
                (${date}::date + ${hhmm}::time) at time zone ${tz}
                  + make_interval(mins => ${minutes}),
                'booked', ${source})
        returning id`;
      await tx`insert into appointment_items
        (org_id, location_id, appointment_id, service_id, membership_id,
         starts_at, ends_at, price_cents_snapshot, duration_min)
        select ${org}, ${loc}, ${a!.id}, ${serviceIds[service]!}, ${memberIds[member]!},
               starts_at, ends_at, base_price_cents, ${minutes}
        from appointments a, services s
        where a.id = ${a!.id} and s.id = ${serviceIds[service]!}`;
    };

    // 上次来店（`lookup_customer` 要报得出「上次做的是甲油胶」）
    await book(NAIL_ORG, NAIL_LOC, 'America/New_York', nailDays[0]!, '11:00', 45,
               'Lisa Chen', 'Linh', 'gel_mani', 'desk');
    // 今天已经有的两单：找空档时这两段必须被避开
    await book(NAIL_ORG, NAIL_LOC, 'America/New_York', nailDays[1]!, '13:00', 60,
               '张女士', 'Mai', 'dlx_pedi', 'phone_manual');
    await book(SPA_ORG, SPA_LOC, 'America/Los_Angeles', spaDays[1]!, '15:00', 60,
               'Wang Ming', 'Yan', 'reflex60', 'web');
  });

  const counts = await adminSql<{ t: string; n: number }[]>`
    select 'organizations' as t, count(*)::int as n from organizations
    union all select 'locations', count(*)::int from locations
    union all select 'services', count(*)::int from services where not is_addon
    union all select 'services(加项)', count(*)::int from services where is_addon
    union all select 'service_categories', count(*)::int from service_categories
    union all select 'resources', count(*)::int from resources
    union all select 'service_option_defs', count(*)::int from service_option_defs
    union all select 'customers', count(*)::int from customers
    union all select 'memberships', count(*)::int from memberships
    union all select 'shifts', count(*)::int from shifts
    union all select 'appointments', count(*)::int from appointments
    union all select 'phone_lines', count(*)::int from phone_lines
    union all select 'roles', count(*)::int from roles`;
  for (const c of counts) console.log(`  ${c.t.padEnd(22)} ${c.n}`);

  // 同号多客户：张女士和张先生共用 +19175550188，是被允许的（宪法第 16 条）
  const shared = await adminSql<{ n: number }[]>`
    select count(*)::int as n from customers where phone_e164 = '+19175550188'`;
  console.log(`\n  同一手机号下 ${shared[0]!.n} 位客人（共号是允许的，前台走选择器）`);

  // 电话工具全靠被叫号码定位门店，所以这两个号要显眼
  const lines = await adminSql<{
    e164: string; purpose: string; name: string; location_id: string;
  }[]>`
    select p.e164, p.purpose, l.name->>'en' as name, p.location_id
    from phone_lines p join locations l on l.id = p.location_id
    where p.purpose = 'ai_voice' order by l.name`;
  console.log('\n  AI 电话号（工具入参 to=）与工具 token（入参 shop_token=）：');
  for (const l of lines) {
    console.log(`    ${l.e164}  →  ${l.name}`);
    console.log(`      shop_token: ${toolTokenFor(l.location_id)}`);
  }
  console.log('    试一通：node scripts/voice-tool.mjs flow   （脚本自己会带上 token）');

  // 官网预约页也开着（真实门店默认是关的）—— 顺手把链接打出来
  const keys = await adminSql<{ pk: string; name: string }[]>`
    select public_key as pk, name->>'en' as name from locations
    where id in (${NAIL_LOC}, ${SPA_LOC}) order by name`;
  console.log('\n  官网预约页（pnpm --filter @gf/booking dev）：');
  for (const k of keys) console.log(`    localhost:5176/?k=${k.pk}   ${k.name}`);

  console.log(`\n  开发登录：<名字小写>@example.test / ${DEV_PASSWORD}`);
  console.log('    mia   前台（美甲店）      linh  技师');
  console.log('    amy   店长兼技师          owner 老板（足疗店）');
  console.log('\n完成\n');
  await adminSql.end({ timeout: 5 });
}

main().catch(async (e) => {
  console.error('\n种子失败：', e instanceof Error ? e.message : e);
  await adminSql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
