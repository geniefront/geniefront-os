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
  strict: true,
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
  strict: true,
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
 * 领域只读业务工具定义集合 (29 §6.2)
 */
export const READ_ONLY_TOOL_DEFINITIONS: CopilotToolDef[] = [
  {
    name: 'resolve_customers',
    description:
      '批量模糊检索姓名、电话后几位。命中1位返回明确 customerId；命中多位返回多条候选供前台点选，严禁模型自行盲猜选择。',
    strict: true,
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
    name: 'get_service_catalog',
    description:
      '查询本店服务项目目录及其变体、标准时长、底价分值、适用资源类型。',
    strict: true,
    requiredPermissions: ['appointment.read'],
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string', description: '服务名称关键词（可选）' },
        category: { type: 'string', description: '项目大类（可选）' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'get_staff_directory',
    description:
      '列出全店技师的稳定 membershipId、姓名、技能标签（Skills）、是否可排单（isBookable）及当天出勤班次。针对具体技师的操作必须先通过本工具获取真实 membershipId。',
    strict: true,
    requiredPermissions: ['schedule.read'],
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '查询日期 YYYY-MM-DD，默认为今天' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'search_appointments',
    description:
      '支持跨日与当日预约查询，返回 appointmentId、客户、项目、指派技师、时段与状态。',
    strict: true,
    requiredPermissions: ['appointment.read'],
    parameters: {
      type: 'object',
      properties: {
        businessDate: { type: 'string', description: '营业日 YYYY-MM-DD' },
        customerId: { type: 'string', description: '客户 UUID（可选）' },
        staffMembershipId: { type: 'string', description: '技师 membershipId（可选）' },
        cursor: { type: 'string', description: '分页游标（可选）' },
      },
      required: ['businessDate'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan_appointment_slots',
    description:
      '综合空档预检。支持多人同行容量预检 (partySize)；改期时排除原单占用 (excludeAppointmentId)；支持回合内内存级临时占位 (previousHolds)，避免为多人依次排单时互撞。',
    strict: true,
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
    name: 'validate_task_draft',
    description:
      '纯逻辑预检工具。在不写库的情况下，检验步骤参数完整性、时段冲突及权限覆盖，返回 ready / conflict / invalid 状态及具体冲突说明。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              command: { type: 'string' },
              input: { type: 'object' },
            },
            required: ['command', 'input'],
            additionalProperties: true,
          },
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_rooms',
    description:
      '返回房态列表（包含 resourceId、名称、容量、当前状态：available/cleaning/in_service/maintenance）。修改房态前必须查此工具获取真实 ID。',
    strict: true,
    requiredPermissions: ['appointment.read'],
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'get_revenue_analytics',
    description:
      '查指定营业日的营收、客单价、支付方式占比及工单量。当日无需额外报表权限，跨日校验 report.view 权限。',
    strict: true,
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
];

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
