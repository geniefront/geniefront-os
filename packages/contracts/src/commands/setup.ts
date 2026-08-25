/**
 * 开店配置：项目 / 员工 / 营业时间。
 *
 * 这三样是门店能不能真正用起来的前提 —— 在此之前数据都是我们灌进去的。
 * 面向的是「英文不好、四十岁以上」的老板，所以字段能少就少，
 * 能给默认值就别让他填（`04` §2）。
 */

import { z } from 'zod';
import { defineCommand, uuid, cents, i18nText } from '../command.js';

export const SaveService = defineCommand({
  name: 'catalog.saveService',
  input: z.object({
    /** 不传就是新建 */
    serviceId: uuid.optional(),
    name: i18nText,
    durationMin: z.number().int().min(5).max(600),
    basePriceCents: cents.nonnegative(),
    /** 服务在多数州不收销售税，零售才收（00 §1.6） */
    taxable: z.boolean().default(false),
    onlineBookable: z.boolean().default(false),
    /**
     * ⭐ 加项：只能加在主项目上，不能单独预约（sql/0035）。
     * 「热石 +$15」「French +$10」这种勾上，电话 AI 才不会把它当成
     * 一个完整项目报给客人。
     */
    isAddon: z.boolean().default(false),
    active: z.boolean().default(true),
  }),
  output: z.object({ serviceId: uuid, created: z.boolean() }),
  permission: 'catalog.manage',
  ai: {
    description: '新增或修改一个服务项目。价格用整数分，时长用分钟。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const ArchiveService = defineCommand({
  name: 'catalog.archiveService',
  input: z.object({ serviceId: uuid }),
  output: z.object({ serviceId: uuid }),
  permission: 'catalog.manage',
  ai: {
    description: '下架一个项目。历史单据不受影响 —— 项目名在开单时已快照。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const SaveStaffProfile = defineCommand({
  name: 'staff.saveProfile',
  input: z.object({
    membershipId: uuid,
    displayName: i18nText.optional(),
    /** 能否被排单。店长/前台也接客时打开（决策 20） */
    isBookable: z.boolean().optional(),
    /** 并发上限。美甲店常设 2（做手时脚在泡水） */
    maxConcurrentAppointments: z.number().int().min(1).max(5).optional(),
    levelId: uuid.nullable().optional(),
  }),
  output: z.object({ membershipId: uuid }),
  permission: 'staff.manage',
  ai: {
    description: '改技师的可排单状态、并发上限或等级。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

/** 参与轮牌按【营业日】决定 —— 老板临时下场是天天变的（决策 20） */
export const SetRotationParticipation = defineCommand({
  name: 'staff.setRotation',
  input: z.object({
    membershipId: uuid,
    inRotation: z.boolean(),
    /** 不传就是今天 */
    businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
  output: z.object({ membershipId: uuid, inRotation: z.boolean(), businessDate: z.string() }),
  permission: 'staff.manage',
  ai: {
    description: '设置某位技师今天参不参与 walk-in 轮牌。店长常见「可接点钟但不吃轮」。',
    confirm: 'destructive',
  },
  reversible: true,
  idempotency: 'optional',
});

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '要 HH:MM 格式');

export const SaveBusinessHours = defineCommand({
  name: 'location.saveHours',
  input: z.object({
    /** 七天，缺哪天就是那天不营业 */
    hours: z.record(
      z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
      z.object({ open: hhmm, close: hhmm }).nullable(),
    ),
  }),
  output: z.object({ locationId: uuid }),
  permission: 'settings.manage',
  ai: {
    description: '设置门店每周营业时间。某天不营业就传 null。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

// ─────────────────────────────────────────────────────────────────────────────
// 自助开户的最后一步：认领门店（docs/12 §3 B）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把当前登录用户绑成这家店的老板。
 *
 * ## 这条命令和别的命令有一处根本不同
 *
 * 执行它的人**还没有 membership** —— 他刚点开激活邮件里的链接，
 * 在这个系统里除了一个 Supabase 账号什么都没有。所以调用方给的上下文是
 * 路由现组的（`membershipId: null`），而不是从 membership 推出来的。
 *
 * ⭐ 那条身份边界**不在这里**：`intentId` 是路由从
 * `gf_signup_intent_for_user()` 拿到的，那个函数比对的是 auth.users 里
 * 那一行的邮箱。也就是说「谁能认领」由数据库判定，应用插不上话。
 * 这一侧再校验一次「这条 intent 属于这家店且没被认领过」，是第二道。
 *
 * ## 一次性
 *
 * 认领过的 intent 不能再认领，第二次要**明确报错**而不是静默成功 ——
 * 静默成功的话，第二个点进来的人会以为自己也是老板。
 */
export const ClaimLocation = defineCommand({
  name: 'setup.claimLocation',
  input: z.object({ intentId: uuid }),
  output: z.object({
    membershipId: uuid, locationId: uuid, orgId: uuid,
  }),
  permission: 'settings.manage',
  ai: {
    description: '认领一家刚付费开通的门店（自助开户链路内部使用）。',
    confirm: 'always',
    // ⛔ 不给 AI：这条命令决定「谁是老板」，它只该由激活链接那一条路触发
    exposed: false,
  },
  // 不可撤销：撤销一次认领 = 把一家店的老板拿掉，那是人工客服的事
  reversible: false,
  idempotency: 'optional',
});

/**
 * 店名 / 时区 / 业态。开店向导第一步让老板确认一次（docs/12 §3 C1）。
 *
 * ⚠️ **时区必须让他看见并且能改。** 官网那边是用浏览器猜的，
 * 用 VPN 的人拿到的是错的 —— 而时区错了整家店的日程、日结、提成
 * 全部错开一天（docs/11 §3）。
 */
export const SaveLocationProfile = defineCommand({
  name: 'location.saveProfile',
  input: z.object({
    name: i18nText.optional(),
    /** IANA 时区名，如 America/New_York */
    timezone: z.string().min(3).max(64).optional(),
    businessType: z.enum(['nail', 'massage', 'foot_spa', 'lash', 'scalp', 'hair', 'mixed']).optional(),
    /** 营业日边界。足疗店开到凌晨要设 03:00，美甲店 04:00 都行（00 §1.5.1） */
    businessDayCutoff: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  }),
  output: z.object({ locationId: uuid }),
  permission: 'settings.manage',
  ai: {
    description: '修改门店的店名、时区、业态。时区改动会影响所有日期计算，务必确认。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

/**
 * 开店向导走完 —— `locations.status` 从 `setup` 变 `active`。
 *
 * ⭐ 进度就存在这一列和真实数据上，**不存「向导走到第几步」**：
 * 存步数的话，老板换一台设备登录会被拉回一个假的进度（docs/12 §3 C 规矩 2）。
 *
 * 而且完成之后向导里的每一步在「⚙ 开店配置」里都还在 —— 这条命令
 * 关掉的只是那个引导壳子，不是任何功能。
 */
export const FinishSetup = defineCommand({
  name: 'location.finishSetup',
  input: z.object({}),
  output: z.object({ locationId: uuid, status: z.string() }),
  permission: 'settings.manage',
  ai: {
    description: '标记开店向导已完成，门店转为正式营业状态。',
    confirm: 'always',
  },
  reversible: false,
  idempotency: 'optional',
});

/**
 * 官网在线预约的开关与护栏（docs/13）。
 *
 * ⭐ **默认是关的**，要老板明确打开。项目、价格、排班没配全的时候
 * 官网上就能订到这家店，结果是一条订在空排班上的单 —— 前台看不到人，
 * 而客人以为约上了。
 */
export const SaveOnlineBooking = defineCommand({
  name: 'location.saveOnlineBooking',
  input: z.object({
    enabled: z.boolean(),
    /** 最远能订多少天以后。太长了排班还没排到，太短了客人订不上 */
    maxDaysAhead: z.number().int().min(1).max(365).default(60),
    /**
     * ⭐ 多久之内的不让在线订。
     *
     * 网上订「20 分钟后」的单，前台十有八九还没看到人就到了。
     * 这不是技术问题是运营问题 —— 太急的单让客人打电话，
     * 电话那头能当场说「你现在过来要等 15 分钟」。
     */
    minMinutesAhead: z.number().int().min(0).max(24 * 60).default(120),
    /**
     * 订单前先验一次手机验证码。**默认关**：每条码要花钱、多一步会流失真客人、
     * 而且短信通道故障时整个预约页不能用（宪法第 13 条）。
     * 只给被恶意占位骚扰过的店开 —— 它是唯一挡得住「真人手工占位」的手段。
     */
    requirePhoneVerification: z.boolean().default(false),
    /** 开始前几小时内不能自助取消（那时候该打电话，店家有机会挽留） */
    cancelCutoffHours: z.number().int().min(0).max(72).default(4),

    /**
     * ⭐ 让不让客人自己在网上改期（批 2，docs/13 §4.6）。
     *
     * **默认开**，和上面那几个「默认关」的护栏相反。不让改期的话，
     * 客人的选择只剩「取消」或者「不来」—— 而 no-show 比改期糟得多：
     * 那一格既没人用、也收不到钱、技师还白等。
     * 挡风险的是后四位校验和次数上限，不是把功能关掉。
     */
    rescheduleEnabled: z.boolean().default(true),
    /** 开始前几小时内不能自助改期。不传就跟着 cancelCutoffHours */
    rescheduleCutoffHours: z.number().int().min(0).max(72).optional(),
    /**
     * 每张单最多自助改几次。到顶之后让他打电话。
     *
     * 0 = 不限次。⚠️ 不建议：无限次自助改期等于把日程表交给客人随便拖，
     * 而每一次拖动都可能把别人挤掉一格。
     */
    selfRescheduleMax: z.number().int().min(0).max(10).default(2),
  }),
  output: z.object({ locationId: uuid, enabled: z.boolean() }),
  permission: 'settings.manage',
  ai: {
    description: '打开或关闭官网在线预约，并设置提前量、取消截止等护栏。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

/**
 * 官网域名白名单。
 *
 * ⚠️ 这**不是**鉴权 —— 它挡的是「别人的网站嵌一个我们的预约表单」，挡不住 curl。
 * 真正挡机器人的是 Turnstile + 限频 + 蜜罐（docs/13 §6）。
 */
export const AddWebOrigin = defineCommand({
  name: 'location.addWebOrigin',
  input: z.object({
    /** 老板可以直接粘 `lotusnails.com` 或整条 URL，服务端负责规范化 */
    origin: z.string().min(4).max(200),
    label: z.string().max(60).optional(),
  }),
  output: z.object({ id: uuid, origin: z.string() }),
  permission: 'settings.manage',
  ai: {
    description: '把一个网站域名加进本店官网预约的白名单。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const RemoveWebOrigin = defineCommand({
  name: 'location.removeWebOrigin',
  input: z.object({ id: uuid }),
  output: z.object({ id: uuid }),
  permission: 'settings.manage',
  ai: {
    description: '把一个网站域名从本店官网预约的白名单里去掉。去掉之后那个站点会立刻 403。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});



/**
 * ⭐ 已登录的老板在**同一个 org 内**再开一家店（批 4）。
 *
 * ## 为什么需要这条命令
 *
 * 在此之前，门店只有一条出生路径：`gf_provision_tenant()` ——
 * 付款 → webhook → 建 org + 建店。一个 org 一家店。
 * 而「一人多店」在这行是常态（一个老板开三家足疗店），
 * 他不该为第二家店重新走一遍付款、重新收一封激活邮件、
 * 重新记一套登录账号。
 *
 * ## 权限：用 `billing.manage` 当「org 级老板」的代理
 *
 * ⚠️ 现有的权限**全是门店级的**，没有 org 级这个维度。
 * 硬造一套 org 权限体系是件大事（角色表、继承、UI），
 * 而这里真正要回答的问题只有一个：「这个人是不是这个 org 的老板」。
 *
 * `billing.manage` 恰好只有 owner 有（店长都没有，决策 19 的极致隐私）。
 * 所以「在本 org 某家店持有 `billing.manage`」≈「是这个 org 的老板」，
 * 够用而且不引入新概念。新店建在**调用方当前门店的同一个 org 下** ——
 * org id 不接受入参，避免「知道别人 org id 就能往里塞店」。
 */
export const CreateLocation = defineCommand({
  name: 'location.create',
  input: z.object({
    name: z.string().min(1).max(80),
    timezone: z.string().min(3).max(60),
    businessType: z.enum(['nail', 'massage', 'foot_spa', 'lash', 'scalp']).default('nail'),
    /** 不填就跟着当前门店 */
    locale: z.enum(['en', 'zh-Hans', 'zh-Hant', 'ko', 'vi', 'es']).optional(),
    phone: z.string().max(32).optional(),
  }),
  output: z.object({
    locationId: uuid,
    orgId: uuid,
    membershipId: uuid,
    slug: z.string(),
  }),
  permission: 'billing.manage',
  ai: {
    description: '在同一个组织下再开一家门店。',
    confirm: 'always',
  },
  reversible: false,
  idempotency: 'required',
});

export const SETUP_COMMANDS = [
  SaveService, ArchiveService, SaveStaffProfile, SetRotationParticipation, SaveBusinessHours,
  ClaimLocation, SaveLocationProfile, FinishSetup,
  SaveOnlineBooking, AddWebOrigin, RemoveWebOrigin, CreateLocation,
] as const;
