/**
 * 前台副驾模型侧工具声明与元工具定义 (29 §4.2, §5.2, §5.3, §6.2)
 *
 * ⚠️ 严格遵守 Prompt 缓存确定性：
 * 所有 Tool 定义的 JSON Schema 必须保持严格固定的字段顺序（键排序）。
 */

import type { Permission } from '@gf/contracts';
import type { LunaTool } from '../runtime/luna.js';

export interface CopilotToolDef extends LunaTool {
  requiredPermissions?: readonly Permission[];
}

/**
 * 元工具 1: propose_task_plan (29 §5.2)
 * 模型收集齐全部要素后，必须调用该工具提交结构化复合方案。
 */
export const PROPOSE_TASK_PLAN_TOOL: CopilotToolDef = {
  name: 'propose_task_plan',
  description:
    '提交一个包含多步骤的结构化任务计划方案草案。方案将经过系统业务规则和排期预检，生成界面卡片供前台人工确认后批量/顺序执行。',
  strict: false,
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: '方案总体标题，如“安排3位客人明日下午美甲”或“王太太改期与3号房清洁”',
      },
      summary: {
        type: 'string',
        description: '一目了然的总体说明，交代各子任务的核心安排',
      },
      executionMode: {
        type: 'string',
        enum: ['atomic', 'independent_sequential'],
        description: '执行模式：atomic 为全成全败（如家庭同行），independent_sequential 为独立批次（某单冲突不影响其余）',
      },
      steps: {
        type: 'array',
        description: '按依赖或执行顺序排列的各子命令列表',
        items: {
          type: 'object',
          properties: {
            stepKey: {
              type: 'string',
              description: '本计划内唯一的临时标识，如 step_1, step_2',
            },
            command: {
              type: 'string',
              description: '目标业务命令名，必须来自已授权命令目录 (如 appointment.create, resource.setStatus)',
            },
            input: {
              type: 'object',
              description: '命令所需的入参对象，必须符合对应命令的字段说明',
            },
            summary: {
              type: 'string',
              description: '这一步骤的一句话说明（前台可直读的人话摘要）',
            },
            dependsOn: {
              type: 'array',
              items: { type: 'string' },
              description: '依赖的前置步骤 stepKey 列表（可选）',
            },
          },
          required: ['stepKey', 'command', 'input', 'summary'],
          additionalProperties: false,
        },
      },
    },
    required: ['title', 'summary', 'executionMode', 'steps'],
    additionalProperties: false,
  },
};

/**
 * 元工具 2: ask_user_clarification (29 §5.2)
 * 遇到同名客人或缺少关键必要要素且查不到时，调用此工具主动澄清。
 */
export const ASK_USER_CLARIFICATION_TOOL: CopilotToolDef = {
  name: 'ask_user_clarification',
  description:
    '当前台意图存在不可消除的歧义（如检索出多位同名同姓的客户），或缺失必要要素且无法查知时调用此工具向用户追问并提供候选项。',
  strict: false,
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: '向前台提出的明确问题，如“店里有两位 Lisa，请问是哪一位？”',
      },
      missingFields: {
        type: 'array',
        items: { type: 'string' },
        description: '缺失的必要字段名称列表',
      },
      candidateOptions: {
        type: 'array',
        description: '供前台一键点选的候选卡片列表（如两名 Lisa 的到店历史或电话尾号）',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: '卡片显示的标题，如“Lisa (尾号 1234, 上次到店 3天前)”' },
            value: { type: 'string', description: '选定后的真实值（如 customerId）' },
            description: { type: 'string', description: '补充辅助信息' },
          },
          required: ['label', 'value'],
          additionalProperties: false,
        },
      },
    },
    required: ['question', 'missingFields'],
    additionalProperties: false,
  },
};

/**
 * 只读业务工具定义集合。
 *
 * ⚠️ **加工具前先问一句：这份数据能不能一次性装进上下文？**
 *
 * 服务目录、员工花名册、房间、营业时间、套餐、排班、预约日历这七类
 * 已经全部随每轮请求直接下发（见 `storeContext.ts`），对应的工具**已删除**。
 * 留在这里的只有三类真正装不下或算不出来的：
 *
 * 1. **量太大**：顾客表、订单流水、评价 —— 一家店几千上万条，塞不进去；
 * 2. **要服务端算**：空档推荐必须按班表、已占时段、并发上限实算，
 *    让模型自己推必然出错；
 * 3. **有副作用/要签名**：健康表链接要签发一次性令牌。
 */
export const READ_ONLY_TOOL_DEFINITIONS: CopilotToolDef[] = [
  {
    name: 'resolve_customers',
    description:
      '按姓名、电话后几位模糊检索顾客。命中 1 位返回明确 customerId；命中多位返回候选列表，必须交给前台点选，严禁自行挑一个。',
    strict: false,
    requiredPermissions: ['customer.read'],
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '客户姓名、手机号尾号或关键词' },
        limit: { type: 'integer', description: '最多返回条数，默认 5' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_customer_detail',
    description:
      '查询指定客户的详细档案：终身消费、到店总次数、爽约次数、最近工单、会员标签及过敏/喜好备注。',
    strict: false,
    requiredPermissions: ['customer.read'],
    parameters: {
      type: 'object',
      properties: {
        customerId: { type: 'string', description: '客户 UUID' },
      },
      required: ['customerId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_inactive_customers',
    description:
      '查询近 N 天内未到店的沉睡老客，返回姓名、电话后四位与上次到店日期。',
    strict: false,
    requiredPermissions: ['customer.read'],
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: '未到店天数阈值，如 60 或 90，默认 60' },
        limit: { type: 'integer', description: '最多返回条数，默认 10' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'plan_appointment_slots',
    description:
      '按班表与已占时段实算空档。支持多人同行容量预检 (partySize)、改期时排除原单占用 (excludeAppointmentId)、以及回合内内存级临时占位 (previousHolds) 避免为多人依次排单时互撞。**只在前台要你推荐时间时调用**；前台已经给了具体时间就直接用，不要调。',
    strict: false,
    requiredPermissions: ['appointment.read'],
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '查询日期 YYYY-MM-DD' },
        durationMin: { type: 'integer', description: '单项所需时长（分钟）' },
        partySize: { type: 'integer', description: '同行人数，默认为 1' },
        preferredMembershipId: { type: 'string', description: '指定技师 membershipId（可选）' },
        excludeAppointmentId: { type: 'string', description: '改期时排除的原预约 ID（可选）' },
        previousHolds: {
          type: 'array',
          description: '本轮已考虑安排的前序占位，避免多人互撞',
          items: {
            type: 'object',
            properties: {
              staffId: { type: 'string' },
              startsAt: { type: 'string' },
              durationMin: { type: 'integer' },
            },
            required: ['staffId', 'startsAt', 'durationMin'],
            additionalProperties: false,
          },
        },
      },
      required: ['date', 'durationMin'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_revenue_analytics',
    description:
      '查指定营业日区间的营收、客单价、支付方式占比及工单量。当日无需额外报表权限，跨日校验 report.view 权限。',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '起始营业日 YYYY-MM-DD' },
        to: { type: 'string', description: '截止营业日 YYYY-MM-DD' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'search_orders',
    description:
      '查询指定营业日的工单流水、收银小票明细、实付金额、小费与支付方式。',
    strict: false,
    requiredPermissions: ['ticket.read'],
    parameters: {
      type: 'object',
      properties: {
        businessDate: { type: 'string', description: '营业日 YYYY-MM-DD，默认为今天' },
        limit: { type: 'integer', description: '最多返回条数，默认 20' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'get_store_reviews',
    description: '查询门店综合评分、顾客好评点与最新评价反馈。',
    strict: false,
    requiredPermissions: ['appointment.read'],
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'get_health_form_status',
    description:
      '查询客户健康免责声明签署状态与既往病史/过敏禁忌项（已签署 / 待签署 / 是否过期 / 已发链接）。',
    strict: false,
    requiredPermissions: ['customer.read'],
    parameters: {
      type: 'object',
      properties: {
        customerId: { type: 'string', description: '客户 UUID（可选）' },
        appointmentId: { type: 'string', description: '预约 UUID（可选）' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'get_health_form_link',
    description:
      '签发免责声明填表链接与二维码信息，供前台当面出示或复制给顾客填写。',
    strict: false,
    requiredPermissions: ['form.submit'],
    parameters: {
      type: 'object',
      properties: {
        customerId: { type: 'string', description: '客户 UUID（可选）' },
        appointmentId: { type: 'string', description: '预约 UUID（可选）' },
        locale: { type: 'string', description: '表单语言（如 zh-Hans, en, ko, vi, es），默认 zh-Hans' },
      },
      required: [],
      additionalProperties: false,
    },
  },
];

/**
 * 已下线的工具名。
 *
 * 这些数据现在随每轮请求直接下发，工具已删除。但模型可能凭旧习惯（或
 * 会话历史里的旧调用）继续报这些名字 —— 与其回一句无信息的
 * 「Tool X is not available」让它再猜一轮，不如明确告诉它去哪一段读。
 */
export const RETIRED_TOOL_HINTS: Record<string, string> = {
  find_customer: '本工具已更名，请改用 resolve_customers。',
  find_open_slots: '本工具已更名，请改用 plan_appointment_slots。',
  get_appointments: '预约数据（含 appointmentId）已在 <预约日历> 中直接给出，请直接读取。',
  get_day_overview: '预约数据已在 <预约日历> 中直接给出，请直接读取。',
  get_promotions_and_cards: '次卡与套餐已在 <门店档案> 的 PACKAGES 段中直接给出，请直接读取。',
  get_queue_status: '候客队列已在 <现场快照> 的 WAIT 行中直接给出，请直接读取。',
  get_service_catalog: '服务目录（含 serviceId、时长、价格）已在 <门店档案> 的 SERVICES 段中直接给出，请直接读取。',
  get_staff_directory: '员工花名册（含 membershipId、技能、是否可排单）已在 <门店档案> 的 STAFF 段中直接给出，请直接读取。',
  get_staff_schedules: '排班与休假已在 <预约日历> 每日行尾的「在班 / 休」中直接给出，请直接读取。',
  get_store_info: '门店名称、地址、电话、营业时间、税率已在 <门店档案> 的 LOCATION/HOURS/TAX 段中直接给出，请直接读取。',
  list_rooms: '房间与工位（含 resourceId、容量）已在 <门店档案> 的 ROOMS 段中直接给出，请直接读取。',
  list_staff_skills: '技师技能已在 <门店档案> STAFF 段的技能列中直接给出，请直接读取。',
  search_appointments: '预约数据（含 appointmentId）已在 <预约日历> 中直接给出，请直接读取。',
  validate_task_draft: '本工具已下线 —— 直接调 propose_task_plan 提交方案，服务端会自动完成全部预检并把问题回报给你。',
};

/**
 * 构建完整的副驾工具定义列表，按权限过滤并排序（以保持缓存逐字节稳定）
 */
export function buildCopilotTools(permissions: ReadonlySet<string>): LunaTool[] {
  const tools: CopilotToolDef[] = [
    PROPOSE_TASK_PLAN_TOOL,
    ASK_USER_CLARIFICATION_TOOL,
    ...READ_ONLY_TOOL_DEFINITIONS.filter(
      (t) => !t.requiredPermissions || t.requiredPermissions.every((p) => permissions.has(p)),
    ),
  ];

  // 严格确定性名称排序
  return tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
