/**
 * 种子数据：两家假店（一家 nail、一家 foot spa），分属两个不同的 org。
 *
 * 两个 org 是故意的 —— Phase 0 验收要证明 RLS 真的拦得住跨租户读取，
 * 同一个 org 下的两家店测不出这件事。
 */

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

async function main() {
  console.log('\n═══ 种子数据 ═══\n');

  await adminSql.begin(async (tx) => {
    // postgres.js 的模板参数不接受裸对象：jsonb 值必须显式声明
    const J = (v: unknown) => tx.json(v as never);

    // 幂等：按依赖倒序清掉旧种子。
    // 外键没设 ON DELETE CASCADE 是故意的 —— 生产环境不该有人能一条 delete
    // 就带走一家店的全部历史。所以这里显式列出顺序。
    // audit_log 不在列内：它 append-only，而且没有 FK 指向 organizations。
    const orgs = [NAIL_ORG, SPA_ORG];
    for (const t of [
      'appointment_item_blocks', 'appointment_items', 'appointments',
      'rotation_events', 'rotation_participants', 'rotation_policies',
      'customer_preferences', 'customers',
      'service_option_defs', 'services', 'service_categories',
      'resources', 'resource_types',
      'staff_profiles', 'staff_skills', 'skills', 'staff_levels',
      'device_tokens', 'membership_roles', 'permission_overrides',
      'memberships', 'role_permissions', 'roles',
      '__users__',
      'location_features', 'location_subscriptions', 'usage_events',
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
        'America/New_York', 'nail', ${'pk_' + NAIL_LOC.slice(0, 8)}, '04:00',
        ${J({ mon:{open:'09:30',close:'19:30'}, tue:{open:'09:30',close:'19:30'},
              wed:{open:'09:30',close:'19:30'}, thu:{open:'09:30',close:'19:30'},
              fri:{open:'09:30',close:'20:00'}, sat:{open:'09:00',close:'20:00'},
              sun:{open:'10:00',close:'18:00'} })},
        ${J({ capacity: { slot_minutes: 15, max_concurrent_per_slot: null, overbook: 'warn' } })}),
      (${SPA_LOC}, ${SPA_ORG},
        ${J({ en: 'Golden Foot Spa', 'zh-Hans': '金足足疗' })}, 'golden-foot',
        'America/Los_Angeles', 'foot_spa', ${'pk_' + SPA_LOC.slice(0, 8)}, '03:00',
        ${J({ mon:{open:'10:00',close:'23:00'}, tue:{open:'10:00',close:'23:00'},
              wed:{open:'10:00',close:'23:00'}, thu:{open:'10:00',close:'23:00'},
              fri:{open:'10:00',close:'01:00'}, sat:{open:'10:00',close:'01:00'},
              sun:{open:'10:00',close:'23:00'} })},
        ${J({ capacity: { slot_minutes: 15, max_concurrent_per_slot: null, overbook: 'warn' } })})`;

    // 足疗店：3 个房间 —— 资源硬约束天然把并发卡在 3
    const [roomType] = await tx<{ id: string }[]>`
      insert into resource_types (org_id, location_id, key, name)
      values (${SPA_ORG}, ${SPA_LOC}, 'room', ${J({ en: 'Room', 'zh-Hans': '房间' })})
      returning id`;
    for (const n of ['1', '2', '3']) {
      await tx`insert into resources (org_id, location_id, resource_type_id, name)
        values (${SPA_ORG}, ${SPA_LOC}, ${roomType!.id}, ${'Room ' + n})`;
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

    await tx`insert into services
      (org_id, location_id, name, duration_min, base_price_cents, online_bookable) values
      (${NAIL_ORG}, ${NAIL_LOC}, ${J({ en: 'Gel Manicure', 'zh-Hans': '甲油胶美甲' })}, 45, 4500, true),
      (${NAIL_ORG}, ${NAIL_LOC}, ${J({ en: 'Deluxe Pedicure', 'zh-Hans': '豪华修脚' })}, 60, 5500, true),
      (${SPA_ORG},  ${SPA_LOC},  ${J({ en: 'Foot Reflexology 60min', 'zh-Hans': '足底按摩 60 分钟' })}, 60, 4000, true),
      (${SPA_ORG},  ${SPA_LOC},  ${J({ en: 'Deep Tissue 60min', 'zh-Hans': '深层按摩 60 分钟' })}, 60, 7500, true)`;

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
    const staff = [
      { org: NAIL_ORG, loc: NAIL_LOC, name: 'Amy',  roles: ['manager', 'tech'], bookable: true,  maxConc: 2, inRotation: false },
      { org: NAIL_ORG, loc: NAIL_LOC, name: 'Linh', roles: ['tech'],            bookable: true,  maxConc: 2, inRotation: true  },
      { org: NAIL_ORG, loc: NAIL_LOC, name: 'Kim',  roles: ['tech'],            bookable: true,  maxConc: 1, inRotation: true  },
      { org: NAIL_ORG, loc: NAIL_LOC, name: 'Tran', roles: ['tech'],            bookable: true,  maxConc: 2, inRotation: true  },
      { org: NAIL_ORG, loc: NAIL_LOC, name: 'Mai',  roles: ['senior_tech'],     bookable: true,  maxConc: 1, inRotation: true  },
      { org: NAIL_ORG, loc: NAIL_LOC, name: 'Mia',  roles: ['front_desk'],      bookable: false, maxConc: 1, inRotation: false },
      { org: SPA_ORG,  loc: SPA_LOC,  name: 'Yan',  roles: ['tech'],            bookable: true,  maxConc: 1, inRotation: true  },
      { org: SPA_ORG,  loc: SPA_LOC,  name: 'Owner',roles: ['owner'],           bookable: false, maxConc: 1, inRotation: false },
    ];

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
      await tx`insert into staff_profiles
        (membership_id, org_id, location_id, display_name, is_bookable, max_concurrent_appointments)
        values (${m!.id}, ${p.org}, ${p.loc}, ${J({ en: p.name })}, ${p.bookable}, ${p.maxConc})`;
      // 今天和明天都种：演示时不会因为跨营业日而落空
      for (const d of ['current_date', "current_date + 1"]) {
        await tx.unsafe(
          `insert into rotation_participants (org_id, location_id, business_date, membership_id, in_rotation)
           values ($1, $2, ${d}, $3, $4)`,
          [p.org, p.loc, m!.id, p.inRotation] as never,
        );
      }
    }

    await tx`insert into customers (org_id, primary_location_id, display_name, phone_e164, source) values
      (${NAIL_ORG}, ${NAIL_LOC}, ${'Lisa Chen'},  '+19175550142', 'walkin'),
      (${NAIL_ORG}, ${NAIL_LOC}, ${'张女士'},      '+19175550188', 'walkin'),
      (${NAIL_ORG}, ${NAIL_LOC}, ${'张先生'},      '+19175550188', 'walkin'),
      (${SPA_ORG},  ${SPA_LOC},  ${'Wang Ming'},  '+16265550101', 'phone')`;
  });

  const counts = await adminSql<{ t: string; n: number }[]>`
    select 'organizations' as t, count(*)::int as n from organizations
    union all select 'locations', count(*)::int from locations
    union all select 'services', count(*)::int from services
    union all select 'resources', count(*)::int from resources
    union all select 'service_option_defs', count(*)::int from service_option_defs
    union all select 'customers', count(*)::int from customers
    union all select 'memberships', count(*)::int from memberships
    union all select 'roles', count(*)::int from roles`;
  for (const c of counts) console.log(`  ${c.t.padEnd(22)} ${c.n}`);

  // 同号多客户：张女士和张先生共用 +19175550188，是被允许的（宪法第 16 条）
  const shared = await adminSql<{ n: number }[]>`
    select count(*)::int as n from customers where phone_e164 = '+19175550188'`;
  console.log(`\n  同一手机号下 ${shared[0]!.n} 位客人（共号是允许的，前台走选择器）`);

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
