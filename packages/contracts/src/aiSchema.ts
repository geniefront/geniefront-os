/**
 * 把命令的 Zod schema 压成一行给模型看的字段说明。
 *
 * ## 为什么不直接把 40 个命令做成 40 个 tool
 *
 * 05 §6.3 说「工具定义从 packages/contracts 自动生成 —— 加一个命令，
 * AI 自动会用」。做法有两种：
 *
 *   A. 每个命令一个 tool，input_schema 由 Zod 转 JSON Schema
 *   B. 一个 `propose_command` tool（`command` 是命令名的枚举），
 *      命令目录作为**文本**放进缓存段
 *
 * 选 B，三个理由：
 *
 * 1. **省一半 token。** JSON Schema 极其啰嗦：一个 `appointment.create`
 *    展开就是四百多 token，四十个命令一万多。压成文本大约 1.5k，
 *    而它整段都在缓存断点之前，读一次 0.1 倍价（05 §7.2 第 2 条）。
 * 2. **命令名仍然被强约束。** `command` 字段是 strict tool use 的枚举，
 *    模型编不出一个不存在的命令名 —— 而这正是最危险的那种幻觉。
 * 3. **真正的把关本来就在 Zod 那一侧。** 命令总线在执行前会再跑一遍
 *    `def.input.safeParse`（bus.ts 第 1 步）。JSON Schema 就算过了，
 *    Zod 这一关照样要过。让模型多看一份形状定义，挡不住任何东西。
 *
 * 代价是模型看到的字段说明比 JSON Schema 粗 —— 它可能填错一个可选字段。
 * 而填错的结果是 `VALIDATION_FAILED`，前台看到「这条我没听懂」，
 * 不是一条错误的写入。这个代价是可以接受的。
 */

import { z } from 'zod';

/** 递归深度上限。支持解开 items: {...}[] 等高频子数组对象 */
const MAX_DEPTH = 2;

/**
 * 高频核心命令的显式格式提示 (29 §6.1)
 * 对结构深但必须准确填写的命令提供明确展开
 */
export const COMMAND_INPUT_HINTS: Record<string, string> = {
  'appointment.create': 'customerId:uuid|null, walkInName:string?, items:{serviceId:uuid, membershipId:uuid|null, startsAt:iso8601, durationMin:int?, resourceId:uuid|null, addonIds:uuid[]}[], partySize:int=1, notes:string?, source:\'desk\'|\'walkin\'|\'web\'|\'phone_ai\'|\'ai_copilot\'="ai_copilot", override:{reason:\'guest_requested\'|\'staff_on_break\'|\'desk_coordination\'|\'walk_in_stacking\'|\'other\', note:string?}?',
  'appointment.createBatch': 'batchId:uuid, items:{subKey:string, customerId:uuid|null, walkInName:string?, serviceItems:{serviceId:uuid, membershipId:uuid|null, startsAt:iso8601, durationMin:int?, resourceId:uuid|null, addonIds:uuid[]}[], notes:string?, override:{reason:\'guest_requested\'|\'staff_on_break\'|\'desk_coordination\'|\'walk_in_stacking\'|\'other\', note:string?}?}[], source:string="ai_copilot"',
  'resource.setStatus': 'resourceId:uuid, status:\'available\'|\'cleaning\'|\'in_service\'|\'maintenance\', note:string?',
};

/**
 * 一个 Zod 类型压成一句话。
 *
 * 目标不是精确复原 schema，是让模型知道**字段叫什么、大概填什么**。
 * 枚举一定要展开 —— 那是模型最容易瞎编的地方（「取消原因」写成 "客人不来了"
 * 而不是 `guest_changed_mind`）。
 */
export function describeType(schema: z.ZodTypeAny, depth = 0, inArray = false): string {
  const def = (schema as { _def?: { typeName?: string } })._def;
  const name = def?.typeName;

  switch (name) {
    case 'ZodOptional':
      return `${describeType((schema as z.ZodOptional<z.ZodTypeAny>).unwrap(), depth, inArray)}?`;
    case 'ZodNullable':
      return `${describeType((schema as z.ZodNullable<z.ZodTypeAny>).unwrap(), depth, inArray)}|null`;
    case 'ZodDefault': {
      const inner = (schema as z.ZodDefault<z.ZodTypeAny>)._def;
      let dflt: unknown;
      try { dflt = inner.defaultValue(); } catch { dflt = undefined; }
      return `${describeType(inner.innerType, depth, inArray)}=${JSON.stringify(dflt)}`;
    }
    case 'ZodEffects':
      return describeType((schema as z.ZodEffects<z.ZodTypeAny>)._def.schema, depth, inArray);

    case 'ZodString': {
      // uuid / datetime 这两个要标出来：模型不知道的话会填一个名字或者「明天下午」
      const checks = (schema as z.ZodString)._def.checks ?? [];
      const kinds = checks.map((c) => c.kind);
      if (kinds.includes('uuid')) return 'uuid';
      if (kinds.includes('datetime')) return 'iso8601';
      if (kinds.includes('regex')) return 'string(pattern)';
      return 'string';
    }
    case 'ZodNumber':
      return (schema as z.ZodNumber)._def.checks?.some((c) => c.kind === 'int')
        ? 'int' : 'number';
    case 'ZodBoolean': return 'bool';
    case 'ZodDate': return 'date';
    case 'ZodLiteral':
      return JSON.stringify((schema as z.ZodLiteral<unknown>)._def.value);
    case 'ZodEnum':
      // ⭐ 一定展开。枚举值是模型最容易瞎编的地方
      return (schema as z.ZodEnum<[string, ...string[]]>)._def.values
        .map((v) => `'${v}'`).join('|');
    case 'ZodNativeEnum':
      return Object.values(
        (schema._def as { values: Record<string, string | number> }).values)
        .map((v) => `'${String(v)}'`).join('|');
    case 'ZodUnion':
      return ((schema._def as { options: readonly z.ZodTypeAny[] }).options)
        .map((o) => describeType(o, depth, inArray)).join('|');

    case 'ZodArray': {
      const el = (schema as z.ZodArray<z.ZodTypeAny>)._def.type;
      // 当数组元素是对象或带 effects 的对象时，放宽一层深度让模型看清子字段 (29 §6.1)
      return `${describeType(el, depth, true)}[]`;
    }
    case 'ZodRecord': return 'object';
    case 'ZodUnknown':
    case 'ZodAny': return 'any';

    case 'ZodObject': {
      const max = inArray ? 3 : MAX_DEPTH;
      if (depth >= max) return 'object';
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const parts = Object.entries(shape)
        .map(([k, v]) => `${k}:${describeType(v as z.ZodTypeAny, depth + 1, false)}`);
      return `{${parts.join(', ')}}`;
    }

    default:
      return 'any';
  }
}

/**
 * 一个命令的入参压成一行。
 *
 * 顶层不加大括号 —— 模型看到的是 `customerId:uuid|null, items:[...], …`，
 * 比 `{customerId:…}` 更像「这个工具要这几个参数」。
 */
export function describeInput(schema: z.ZodTypeAny, commandName?: string): string {
  if (commandName && COMMAND_INPUT_HINTS[commandName]) {
    return COMMAND_INPUT_HINTS[commandName];
  }

  // 顶层带 .refine()/.superRefine() 的命令，schema 是 ZodEffects 包着 ZodObject；
  // 先剥到里面的对象，才能保持「不加大括号」的顶层渲染。
  let inner = schema;
  while ((inner as { _def?: { typeName?: string } })._def?.typeName === 'ZodEffects') {
    inner = (inner as z.ZodEffects<z.ZodTypeAny>)._def.schema;
  }
  const def = (inner as { _def?: { typeName?: string } })._def;
  if (def?.typeName !== 'ZodObject') return describeType(inner);
  const shape = (inner as z.ZodObject<z.ZodRawShape>).shape;
  return Object.entries(shape)
    .map(([k, v]) => `${k}:${describeType(v as z.ZodTypeAny, 1, false)}`)
    .join(', ');
}
