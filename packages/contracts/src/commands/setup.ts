/**
 * 开店配置：项目 / 员工 / 营业时间。
 *
 * 这三样是门店能不能真正用起来的前提 —— 在此之前数据都是我们灌进去的。
 * 面向的是「英文不好、四十岁以上」的老板，所以字段能少就少，
 * 能给默认值就别让他填（`04` §2）。
 */

import { z } from 'zod';
import { defineCommand, uuid, cents, i18nText, phoneE164 } from '../command.js';

export const SaveService = defineCommand({
  name: 'catalog.saveService',
  input: z.object({
    /** 不传就是新建 */
    serviceId: uuid.optional(),
    /** 可选服务分类。null 表示未分类；必须属于当前门店。 */
    categoryId: uuid.nullable().optional(),
    name: i18nText,
    durationMin: z.number().int().min(5).max(600),
    basePriceCents: cents.nonnegative(),
    /**
     * 以下布尔 / 人数 / 技能字段一律「不传即不改」（PATCH 语义）。
     * 新建时缺省：`taxable=false`、`isAddon=false`、`active=true`、
     * `onlineBookable` = 普通项目 true / 加项 false、`staffCount=1`。
     * 编辑时省略任一字段保留原值，绝不被缺省值覆写（U04 / §7.2）。
     */
    taxable: z.boolean().optional(),
    onlineBookable: z.boolean().optional(),
    /**
     * ⭐ 加项：只能加在主项目上，不能单独预约（sql/0035）。
     * 「热石 +$15」「French +$10」这种勾上，电话 AI 才不会把它当成
     * 一个完整项目报给客人。加项不进独立网约目录：`isAddon && onlineBookable` 会被拒。
     */
    isAddon: z.boolean().optional(),
    /** 同时参与同一项目的技师人数；2 表示双技师项目。 */
    staffCount: z.number().int().min(1).max(5).optional(),
    /** 履约硬门槛；为空数组表示该项目不限制技能。 */
    requiredSkillIds: z.array(uuid).max(30).optional(),
    active: z.boolean().optional(),
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

/** 店主自定义服务分类显示名称与顺序（Massage / Facial / Spa 等）。 */
export const SaveServiceCategory = defineCommand({
  name: 'catalog.saveServiceCategory',
  input: z.object({
    categoryId: uuid.optional(),
    name: i18nText,
    sort: z.number().int().min(0).max(10_000).default(0),
  }),
  output: z.object({ categoryId: uuid, created: z.boolean() }),
  permission: 'catalog.manage',
  ai: {
    description: '新增或修改服务分类及显示顺序，例如 Massage、Facial、Spa。',
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

/**
 * 批量修改一组项目的**部分字段**（U04 / §7.2）。
 *
 * - 只动 `set` 里明确给出的字段；不碰价格 / 时长 / 名称 —— 因此对并发编辑那两项天然安全。
 * - 单事务全成全败；任一项跨店 / 类型不符 / 技能无效即整批回滚，不做「部分成功」。
 * - 技能三选一：`skillsReplace`（整组覆盖）与 `skillsAdd` / `skillsRemove` 互斥。
 * - 加项不进网约目录：受影响项目若 `is_addon` 为真且要设 `onlineBookable=true`，整批拒绝。
 */
export const BulkUpdateServices = defineCommand({
  name: 'catalog.bulkUpdateServices',
  input: z.object({
    serviceIds: z.array(uuid).min(1).max(200),
    /**
     * 乐观锁：确认页取到的每个项目的 `updatedAt`（ISO 字符串）。传了就逐项比对，
     * 期间被人改过的项目会让整批以 `stale_services` 拒绝（附漂移的 id 列表）。
     * 不传 = 不做版本校验（向后兼容旧客户端）。
     */
    expectedVersions: z.record(uuid, z.string()).optional(),
    set: z.object({
      onlineBookable: z.boolean().optional(),
      staffCount: z.number().int().min(1).max(5).optional(),
      categoryId: uuid.nullable().optional(),
      skillsAdd: z.array(uuid).max(30).optional(),
      skillsRemove: z.array(uuid).max(30).optional(),
      skillsReplace: z.array(uuid).max(30).optional(),
    }).refine(
      (s) => Object.values(s).some((v) => v !== undefined),
      { message: '至少要指定一个要修改的字段' },
    ).refine(
      (s) => !(s.skillsReplace !== undefined && (s.skillsAdd !== undefined || s.skillsRemove !== undefined)),
      { message: 'skillsReplace 不能与 skillsAdd / skillsRemove 同时使用' },
    ),
  }),
  output: z.object({ updated: z.number().int() }),
  permission: 'catalog.manage',
  ai: {
    description: '批量修改一组项目的网上预约开关、同时技师人数、分类或所需技能。不改价格与时长。',
    confirm: 'always',
  },
  reversible: false,
  idempotency: 'optional',
});

export const SaveStaffProfile = defineCommand({
  name: 'staff.saveProfile',
  input: z.object({
    membershipId: uuid.optional(),
    displayName: i18nText.optional(),
    name: z.string().trim().max(100).optional(),
    employeeNo: z.string().trim().max(30).optional(),
    phone: phoneE164.optional().or(z.literal('')).nullable(),
    email: z.string().email('邮箱格式不正确').optional().or(z.literal('')).nullable(),
    /**
     * 岗位 / 职级 / 技能一律从本店已启用目录中选。
     * ID 字段（`jobTitleId` / `levelId` / `skillIds`）是权威入口。
     * 兼容用的自由文本字段（`jobTitle` / `level` / `skills`）只在能规范化
     * 匹配到现存目录项时被接受；匹配不到即拒绝，服务端不再据此新建目录项。
     */
    jobTitle: z.string().trim().max(50).optional(),
    jobTitleId: uuid.nullable().optional(),
    level: z.string().trim().max(50).optional(),
    levelId: uuid.nullable().optional(),
    skills: z.array(z.string().trim()).optional(),
    skillIds: z.array(uuid).optional(),
    status: z.enum(['active', 'on_leave', 'resigned', 'suspended', 'left']).optional(),
    hireDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '入职日期格式必须为 YYYY-MM-DD').optional(),
    note: z.string().max(2000).optional(),
    /** 能否被排单。店长/前台也接客时打开（决策 20） */
    isBookable: z.boolean().optional(),
    /** 并发上限。美甲店常设 2（做手时脚在泡水） */
    maxConcurrentAppointments: z.number().int().min(1).max(5).optional(),
    inRotation: z.boolean().default(true),
    payroll: z.object({
      kind: z.enum(['commission', 'hourly', 'commission_vs_hourly', 'booth_rent']),
      ratePercent: z.number().nonnegative(),
      hourlyRateDollars: z.number().nonnegative().default(0),
      base: z.enum(['net', 'gross']).default('net'),
    }).optional(),
  }),
  output: z.object({
    membershipId: uuid,
    created: z.boolean().optional(),
  }),
  permission: 'staff.manage',
  ai: {
    description: '改技师基础档案、工号、职位、可排单状态、并发上限、技能或等级与薪酬。',
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
  /** 系统自有：只能由服务端编排在核验外部凭据之后调用（AUD-01）。 */
  system: true,
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
    name: i18nText.or(z.string()).optional(),
    /**
     * 托管预约页短码。存库前会规范化（小写、字母数字和单个连字符）。
     * 平台级唯一；保留路径与非法形状由 handler 以 slug_reserved / slug_invalid 拒绝，
     * 被占用则以 slug_unavailable 拒绝。
     */
    slug: z.string().min(1).max(80).optional(),
    /** IANA 时区名，如 America/New_York */
    timezone: z.string().min(3).max(64).optional(),
    businessType: z.enum(['nail', 'massage', 'foot_spa', 'lash', 'scalp', 'hair', 'mixed']).optional(),
    phone: phoneE164.optional().nullable(),
    email: z.string().email('邮箱格式不正确').optional().or(z.literal('')).nullable(),
    addressStreet: z.string().max(255).optional().nullable(),
    addressCity: z.string().max(64).optional().nullable(),
    addressState: z.string().max(32).optional().nullable(),
    addressZip: z.string().max(16).optional().nullable(),
    address: z.any().optional(),
    /** 营业日边界。足疗店开到凌晨要设 03:00，美甲店 04:00 都行（00 §1.5.1） */
    businessDayCutoff: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    /**
     * 预约确认 / 改期 / 取消 / 提醒的邮件是否抄送门店自己一份（默认开）。
     *
     * ⚠️ 抄送地址取门店的 `email`；该字段为空时不抄送，也不报错。
     */
    appointmentEmailCopyToShop: z.boolean().optional(),
  }),
  output: z.object({ locationId: uuid }),
  permission: 'settings.manage',
  ai: {
    description: '修改门店的店名、短码 slug、时区、业态、电话、邮箱、街道地址、营业日边界，以及预约邮件是否抄送门店。',
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

/** Persist the setup feature choices without conflating "off" with unfinished. */
export const SaveSetupFeatures = defineCommand({
  name: 'settings.saveSetupFeatures',
  input: z.object({
    healthFormsEnabled: z.boolean().optional(),
    aiVoiceRequested: z.boolean().optional(),
    /** The setup screen sends both choices before marking this domain complete. */
    confirmSetup: z.boolean().default(false),
  }).superRefine((value, ctx) => {
    if (value.healthFormsEnabled === undefined
      && value.aiVoiceRequested === undefined
      && !value.confirmSetup) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '至少要保存一个功能设置' });
    }
    if (value.confirmSetup
      && (value.healthFormsEnabled === undefined || value.aiVoiceRequested === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirmSetup'],
        message: '确认功能步骤时必须同时提交健康表和 AI 电话选择',
      });
    }
  }),
  output: z.object({
    locationId: uuid,
    healthFormsEnabled: z.boolean().nullable(),
    effectiveHealthFormsEnabled: z.boolean(),
    aiVoiceRequested: z.boolean().nullable(),
    confirmedAt: z.string().nullable(),
    healthFormTemplateId: uuid.nullable(),
    healthFormTemplateVersion: z.number().int().nullable(),
  }),
  permission: 'settings.manage',
  ai: {
    description: '保存开店功能选择；启用健康表时确保当前行业模板已经发布。',
    confirm: 'always',
  },
  reversible: true,
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

    /** 网格粒度: 15 | 30 | 60 分钟 */
    slotIntervalMinutes: z.number().int().min(5).max(120).default(30),
    /** 是否强制收取预约定金 */
    depositRequired: z.boolean().default(false),
    /** 预约定金金额 (分) */
    depositAmountCents: z.number().int().nonnegative().default(2000),
    /** 是否允许客户选技师 */
    allowClientPickStaff: z.boolean().default(true),
    requireCardOnFile: z.boolean().default(false),
    cancellationPolicyNotice: z.string().max(1000).optional(),
  }),
  output: z.object({ locationId: uuid, enabled: z.boolean() }),
  permission: 'settings.manage',
  ai: {
    description: '打开或关闭官网在线预约，并设置提前量、网格粒度、定金要求与取消截止等规则。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

/**
 * ⭐ 非营业时间能不能约（0046）。
 *
 * ## 老板真正在问的那个问题
 *
 * 「我九点半开门，熟客说她八点半要过来做个甲，能不能给她排上？」
 *
 * 能。但**只在前台能** —— 官网和电话 AI 永远不会把这一格报出去。
 * 报出去客人就会自己订，而那个点店里一个人都没有。
 * 老板要的是「客人问了我可以答应」，不是「挂到网上卖」。
 *
 * ## 三个数字，不是三十个
 *
 * 刻意**不做**「每天各设一个宽限」：七天七组数字，老板填到第三天就烦了，
 * 而填错的那一天要等到客人白跑一趟才被发现。一组数字管七天。
 */
export const SaveOffHours = defineCommand({
  name: 'location.saveOffHours',
  input: z.object({
    /**
     * 总开关。**默认关**，而且 0046 把所有存量门店都写成关。
     *
     * 这个闸门在此之前从来没生效过（`OUTSIDE_BUSINESS_HOURS` 有码没人抛）。
     * 一上来就打开，会让所有已经排在营业时间外的单、所有还没配全营业时间的店
     * 在同一个早上集体报错 —— 而没有任何人事先被告知。
     */
    enforce: z.boolean(),
    /** 开门前多久仍然算约得进去。最多 4 小时 —— 再多就不是「通融」是「改营业时间」了 */
    beforeOpenMinutes: z.number().int().min(0).max(240).default(0),
    /** 关门后多久。同上 */
    afterCloseMinutes: z.number().int().min(0).max(240).default(0),
    /**
     * 超出上面那个窗口时：
     *   `warn`  —— 前台带 reason 可以放行（和超卖完全同一个交互）
     *   `block` —— 一律不许，连 reason 都不给
     *
     * 默认 `warn`。前台手上握着一个 `block` 挡不住的东西：电话。
     * 挡死之后他会改成「先约进营业时间、客人到了再改」，
     * 那条路上一个字都不会留在系统里 —— 比放行还糟。
     */
    beyond: z.enum(['warn', 'block']).default('warn'),
  }),
  output: z.object({
    locationId: uuid,
    enforce: z.boolean(),
  }),
  permission: 'settings.manage',
  ai: {
    description:
      '设置非营业时间能不能约：总开关、开门前/关门后各放宽多少分钟、' +
      '超出之后是让前台带原因放行还是一律不许。',
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
    phone: phoneE164.optional(),
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

export const SaveCheckoutSettings = defineCommand({
  name: 'settings.saveCheckout',
  input: z.object({
    salesTaxRatePercent: z.number().nonnegative().optional(),
    taxCalculationMode: z.enum(['exclusive', 'inclusive']).default('exclusive'),
    suggestedTipPercentages: z.array(z.number().int().nonnegative()).default([15, 18, 20, 25]),
    allowCustomTip: z.boolean().default(true),
    defaultCashFloatCents: z.number().int().nonnegative().default(20000),
    receiptFooterMessage: z.string().max(1000).optional().nullable(),
    autoPrintReceipt: z.boolean().default(true),
    autoSendSmsReceipt: z.boolean().default(true),
    checkoutTiming: z.enum(['service_then_tip', 'upfront_combined', 'after_service_combined'])
      .default('after_service_combined'),
    /** 套餐每次核销覆盖整组项目，或覆盖任意一个绑定项目。 */
    packageCoverageMode: z.enum(['bundle', 'any_included']).default('bundle'),
    /** 套餐核销项目进入技师提成时采用的收入基数。 */
    packageCommissionBasis: z.enum(['catalog_price', 'allocated_sale_price', 'zero'])
      .default('allocated_sale_price'),
    /** 收银员是否可以覆盖门店的小费自动分配规则。 */
    allowTipSplitOverride: z.boolean().default(true),
    tipDistributionBasis: z.enum(['active_minutes', 'price_share', 'equal', 'level_weighted'])
      .default('active_minutes'),
    assistantTipWeightPercent: z.number().int().min(0).max(100).default(30),
    tipRemainderTo: z.enum(['longest_service', 'highest_level', 'pool_next_day'])
      .default('longest_service'),
  }),
  output: z.object({ locationId: uuid }),
  permission: 'settings.manage',
  ai: {
    description: '设置收银、小费分配、套餐核销与套餐提成口径。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const Apply10Dlc = defineCommand({
  name: 'settings.apply10dlc',
  input: z.object({
    legalBusinessName: z.string().min(1).max(255),
    ein: z.string().min(1).max(32),
    businessStructure: z.enum(['llc', 'corp', 'sole_prop', 'partnership']).default('llc'),
    registeredAddress: z.string().min(1).max(500),
    repName: z.string().min(1).max(128),
    repTitle: z.string().min(1).max(128),
    repEmail: z.string().email(),
    repPhone: z.string().min(1).max(32),
    optInMethod: z.string().max(1000).optional(),
    sampleMessages: z.array(z.string()).default([]),
    sampleMessage1: z.string().optional(),
    sampleMessage2: z.string().optional(),
  }),
  output: z.object({
    locationId: uuid,
    /** Internal GenieFront review state. pending_review is not a carrier/TCR filing. */
    status: z.enum(['pending_review']),
    submittedAt: z.string(),
  }),
  permission: 'settings.manage',
  ai: {
    description: '把 10DLC 申请资料交给 GenieFront 内部审核。不会向 TCR 或运营商提交。',
    confirm: 'always',
  },
  reversible: false,
  idempotency: 'optional',
});

export const SaveIntakeWaiver = defineCommand({
  name: 'settings.saveIntakeWaiver',
  input: z.object({
    waiverTitle: z.string().min(1).max(128).default('顾客服务知情同意书与健康声明'),
    waiverContent: z.string().max(10000).optional().nullable(),
    requireSignature: z.boolean().default(true),
    requireHealthAllergies: z.boolean().default(true),
    requirePressurePreference: z.boolean().default(true),
    requireBodySorenessMap: z.boolean().default(true),
    autoCreateCrmProfile: z.boolean().default(true),
    autoPromptTipPercentages: z.boolean().default(true),
    autoSyncToProfile: z.boolean().default(true),
  }),
  output: z.object({ locationId: uuid }),
  permission: 'settings.manage',
  ai: {
    description: '保存大堂 iPad 客户健康告知书、免责声明内容与必填项配置。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const SaveWebhooks = defineCommand({
  name: 'settings.saveWebhooks',
  input: z.object({
    url: z.string().url(),
    events: z.array(z.string()).default(['booking.created', 'ticket.paid']),
    secret: z.string().max(64).optional(),
    active: z.boolean().default(true),
  }),
  output: z.object({ locationId: uuid, webhookId: uuid }),
  permission: 'settings.manage',
  ai: {
    description: '配置外部系统接收事件通知的 Webhook 回调地址与订阅事件。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

/**
 * 店主邮件语言。
 *
 * ## 与 `staff.setLocale` 的区别
 *
 * `staff.setLocale` 改的是 `users.locale` / `staff_profiles.locale`，即
 * **界面语言，按人存**（同一家店的前台与技师各自不同）。本命令改的是
 * `organizations.default_locale`，即**发给店主的计费类邮件**用哪种语言。
 *
 * 两者必须分开：界面语言会随操作者变化，而账单邮件的收件人恒为店主本人。
 * 若共用一列，一位技师在共享 iPad 上切换界面语言就会改掉账单邮件的语言。
 *
 * ## ⚠️ 不影响顾客侧
 *
 * 面向顾客的邮件与短信**恒为英语**，不受本设置影响
 * （`apps/api/src/email/render.ts` 文件头的语言策略）。
 *
 * 默认值在开户时由 Stripe 结账页的语言决定（`signup/checkout.ts`）。
 * 权限取 `billing.manage`（仅 owner 持有）—— 这封信里是他的卡与账单。
 */
export const SetEmailLocale = defineCommand({
  name: 'org.setEmailLocale',
  input: z.object({
    locale: z.enum(['en', 'zh-Hans', 'zh-Hant', 'ko', 'vi', 'es']),
  }),
  output: z.object({ locale: z.string() }),
  permission: 'billing.manage',
  ai: {
    description: '设置发给店主的账单与订阅类邮件使用哪种语言。不影响发给顾客的邮件与短信（那些恒为英语）。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const SaveStaffDirectoryOption = defineCommand({
  name: 'staff.saveDirectoryOption',
  input: z.object({
    kind: z.enum(['job', 'level', 'skill']),
    id: uuid.optional(),
    name: z.string().trim().min(1).max(50),
    sort: z.number().int().min(0).max(9999).default(0),
    active: z.boolean().default(true),
  }),
  output: z.object({ id: uuid }),
  permission: 'staff.manage',
  ai: { description: '管理门店岗位、职级和技能目录。停用保留历史关联。', confirm: 'always' },
  reversible: true,
  idempotency: 'optional',
});

/**
 * 一次性稳定重排某一类目录项的显示顺序。
 *
 * 取代前端「上移 / 下移」的两条串行写：整份有序 ID 在服务端一个事务里
 * 按下标重写 `sort`，并发重排不再互相覆盖。`orderedIds` 必须正好是该类
 * 目前全部项（启用 + 停用），少一个或混入他类 / 他店 ID 即拒绝。
 */
export const ReorderStaffDirectoryOptions = defineCommand({
  name: 'staff.reorderDirectoryOptions',
  input: z.object({
    kind: z.enum(['job', 'level', 'skill']),
    orderedIds: z.array(uuid).min(1).max(500),
  }),
  output: z.object({ kind: z.enum(['job', 'level', 'skill']), count: z.number().int() }),
  permission: 'staff.manage',
  ai: { description: '按给定顺序重排门店岗位 / 职级 / 技能目录的显示位置。', confirm: 'always' },
  reversible: true,
  idempotency: 'optional',
});

export const SETUP_COMMANDS = [
  SaveStaffDirectoryOption, ReorderStaffDirectoryOptions, SaveService, BulkUpdateServices, SaveServiceCategory, ArchiveService, SaveStaffProfile, SetRotationParticipation, SaveBusinessHours,
  ClaimLocation, SaveLocationProfile, FinishSetup, SaveSetupFeatures,
  SaveOnlineBooking, SaveOffHours, AddWebOrigin, RemoveWebOrigin, CreateLocation,
  SaveCheckoutSettings, Apply10Dlc, SaveIntakeWaiver, SaveWebhooks, SetEmailLocale,
] as const;
