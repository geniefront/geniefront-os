/**
 * AI 拍照开店的命令（Phase 2，05-AI-INTEGRATION §4）
 *
 * 整条链子只有一个目的：**让 AI 的产出必须经过人才能变成业务数据**。
 *
 *   createDraft   老板选了几张照片 → 建一份空草案
 *   （提取）      服务端调 Claude Vision，结果通过 saveExtraction 落进草案
 *   reviewItem    逐项看、改、勾
 *   reviewAll     一键全勾 / 一键只勾看得清的那些
 *   apply         勾中的变成真项目（走 catalog 那条一模一样的路）
 *   discard       整份丢掉
 *
 * 提取本身**不是命令**：它是一次不写库的计算。写库的是 saveExtraction，
 * 它才是命令。这样那次几十秒的模型调用不会占着一个数据库事务不放
 * （总线里的每个命令都跑在事务内），而落库仍然有审计、有幂等、有 RLS。
 */

import { z } from 'zod';
import { defineCommand, uuid, cents, i18nText } from '../command.js';

/** 提取出来的一行。与 @gf/ai 的 DraftItem 同构 —— 那边是纯函数，这边是线上契约。 */
const draftItem = z.object({
  kind: z.enum(['service', 'addon', 'package', 'note', 'price_modifier']),
  name: i18nText,
  category: z.string().max(120).nullable(),
  durationMin: z.number().int().min(1).max(600).nullable(),
  priceCents: cents.min(0).max(500_000).nullable(),
  priceIsFrom: z.boolean(),
  variants: z.array(z.object({
    label: z.string().min(1).max(60),
    priceCents: cents.min(0).max(500_000),
    durationMin: z.number().int().min(1).max(600).nullable(),
  })).max(12),
  packageSessions: z.number().int().min(0).max(10_000).default(0),
  packageServiceNames: z.array(z.string().min(1).max(200)).max(30).default([]),
  packageValidDays: z.number().int().min(1).max(3650).nullable().default(null),
  /** 置信度也是百分比，所以也走 basis point（宪法第 4 条） */
  confidenceBp: z.number().int().min(0).max(10000),
  sourceSeq: z.number().int().min(0).nullable(),
  /** [x1,y1,x2,y2] 像素坐标，与原图 1:1 */
  bbox: z.tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int()])
    .nullable(),
});

export const CreateBlueprintDraft = defineCommand({
  name: 'blueprint.createDraft',
  input: z.object({
    label: z.string().max(80).optional(),
    /**
     * 每张照片一条。`storagePath` 可以为空 —— 上传失败不该挡住提取，
     * 只是确认页少了左边那张可点的原图（宪法第 14 条的同一条精神）。
     */
    sources: z.array(z.object({
      seq: z.number().int().min(0).max(19),
      kind: z.enum(['price_list_image', 'website', 'google', 'yelp']).default('price_list_image'),
      storagePath: z.string().max(500).nullable(),
      sourceUrl: z.string().url().max(2000).nullable().optional(),
      rawSnapshot: z.record(z.unknown()).nullable().optional(),
      widthPx: z.number().int().positive().max(20000).nullable(),
      heightPx: z.number().int().positive().max(20000).nullable(),
    })).min(1).max(20),
  }),
  output: z.object({ blueprintId: uuid }),
  permission: 'catalog.manage',
  ai: {
    description: '新建一份拍照开店草案。老板选好价目表照片之后调用。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

/**
 * 把提取结果落进草案。
 *
 * `exposed: false` —— 这条不给 AI 用。它是**提取管线内部的最后一步**，
 * 由服务端在模型返回之后自己调。暴露给副驾等于给了它一条
 * 「我说提取出了什么就是什么」的路，那正好绕过了整条流水线的意义。
 */
export const SaveBlueprintExtraction = defineCommand({
  name: 'blueprint.saveExtraction',
  /** 系统自有：只能由服务端编排在核验外部凭据之后调用（AUD-01）。 */
  system: true,
  input: z.object({
    blueprintId: uuid,
    items: z.array(draftItem).max(300),
    unresolved: z.array(z.object({
      field: z.string().max(80),
      question: z.string().max(300),
    })).max(20),
    locationProposal: z.record(z.unknown()).optional(),
    /** 计量用（05 §7.3）。分开记 token 与毫分，出账单时用后者 */
    usage: z.object({
      tokens: z.number().int().min(0),
      costMillicents: z.number().int().min(0),
      imagesOk: z.number().int().min(0),
      imagesFailed: z.number().int().min(0),
      feature: z.string().max(80).optional(),
      model: z.string().max(120).optional(),
    }),
  }),
  output: z.object({
    blueprintId: uuid,
    itemCount: z.number().int(),
    /** 这次提取扣了几个积分（1 积分 = $0.01 真实成本，向上取整） */
    credits: z.number().int().min(0),
    /** 其中走套餐内额度的部分 */
    fromIncluded: z.number().int().min(0),
    /** 其中走充值余额的部分 —— 只有这部分是真花钱 */
    fromBalance: z.number().int().min(0),
  }),
  permission: 'catalog.manage',
  ai: {
    description: '（内部）把价目表提取结果写进草案。',
    confirm: 'never',
    exposed: false,
  },
  reversible: true,
  idempotency: 'optional',
});

/**
 * 标记后台提取任务的状态（sql/0094）。
 *
 * `exposed: false` + `system: true` —— 和 `saveExtraction` 同一类：提取改成
 * 异步之后，路由把校验跑完就返回 202，真正的模型调用在游离的后台任务里进行。
 * 这条命令负责把 `running` / `failed` 两个转移写进库；`done` 不走这里，它
 * 由 `saveExtraction` 在写入候选行的**同一个事务**里一起置上，避免出现
 * 「状态 done 但一行都没有」的中间态。
 *
 * 老板不该、也无法调它 —— 给 AI 一条「我说提取好了就是好了」的路，
 * 正好绕过整条流水线。
 */
export const SetBlueprintExtractionState = defineCommand({
  name: 'blueprint.setExtractionState',
  /** 系统自有：只能由服务端编排调用（AUD-01）。 */
  system: true,
  input: z.object({
    blueprintId: uuid,
    state: z.enum(['running', 'failed']),
    /** state=failed 时的原因串，进 `extraction_error`。running 时忽略。 */
    error: z.string().max(300).optional(),
  }),
  output: z.object({ blueprintId: uuid, state: z.string() }),
  permission: 'catalog.manage',
  ai: {
    description: '（内部）标记拍照开店的后台提取任务状态。',
    confirm: 'never',
    exposed: false,
  },
  reversible: true,
  idempotency: 'optional',
});

/**
 * 把补齐的多语言写进草案（05 §4.4）。
 *
 * `exposed: false` —— 和 `saveExtraction` 同一个理由：它是补齐管线的最后一步，
 * 由服务端在模型返回之后自己调。给 AI 一条「我说这些名字叫什么就叫什么」的路，
 * 正好绕过了整条流水线。
 *
 * ⭐ **合并逻辑在 handler 里跑，不在路由里。** 路由拿到翻译到写库之间，
 * 老板可能正好在确认页改了某一行的名字 —— 合并必须对着**事务内的当前行**做，
 * 否则会把他刚写的名字覆盖掉（`mergeTranslations` 的「已有的不覆盖」
 * 只有在读到最新数据时才成立）。
 */
export const SaveBlueprintTranslations = defineCommand({
  name: 'blueprint.saveTranslations',
  /** 系统自有：只能由服务端编排在核验外部凭据之后调用（AUD-01）。 */
  system: true,
  input: z.object({
    blueprintId: uuid,
    translations: z.array(z.object({
      seq: z.number().int(),
      names: z.record(z.string().max(20), z.string().max(200)),
    })).max(300),
    usage: z.object({
      tokens: z.number().int().min(0),
      costMillicents: z.number().int().min(0),
    }),
  }),
  output: z.object({
    blueprintId: uuid,
    filledItems: z.number().int().min(0),
    filledCells: z.number().int().min(0),
    /** 整批被拒的原因。非空时一个字都没写（seq 对不上 = 对齐不可信） */
    rejected: z.string().nullable(),
    credits: z.number().int().min(0),
  }),
  permission: 'catalog.manage',
  ai: {
    description: '（内部）把补齐的多语言项目名写进草案。',
    confirm: 'never',
    exposed: false,
  },
  reversible: true,
  idempotency: 'optional',
});

/**
 * 改一行 / 勾一行。
 *
 * 老板改过的行会打上 `editedAt` —— 落地时它的 `source` 标记与纯 AI 产物不同
 * （宪法第 6 条：AI 产生的数据要有 source 标记，人改过的就不再算 AI 的）。
 */
export const ReviewBlueprintItem = defineCommand({
  name: 'blueprint.reviewItem',
  input: z.object({
    itemId: uuid,
    decision: z.enum(['pending', 'accepted', 'rejected']).optional(),
    /**
     * 改名字。⭐ 被改到的那几个语言会**从 `name_auto` 里去掉** ——
     * 不清的话老板亲手写的名字会一直显示成淡色，他会以为没保存成功。
     */
    name: i18nText.optional(),
    durationMin: z.number().int().min(1).max(600).nullable().optional(),
    priceCents: cents.min(0).max(500_000).nullable().optional(),
    category: z.string().max(120).nullable().optional(),
    packageSessions: z.number().int().min(0).max(10_000).optional(),
    packageServiceNames: z.array(z.string().min(1).max(200)).max(30).optional(),
    packageValidDays: z.number().int().min(1).max(3650).nullable().optional(),
  }),
  output: z.object({ itemId: uuid }),
  permission: 'catalog.manage',
  ai: {
    description: '修改或勾选开店草案里的一个项目。价格用整数分。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

/**
 * 一键勾选。
 *
 * 38 个项目逐个点是行不通的 —— 面向的是「英文不好、四十岁以上」的老板（宪法第 11 条）。
 * 所以给两个动作：全勾，或者「只勾看得清的」（`minConfidenceBp`）。
 * 后者才是默认按钮：把标黄的那几行留给他单独看。
 */
export const ReviewAllBlueprintItems = defineCommand({
  name: 'blueprint.reviewAll',
  input: z.object({
    blueprintId: uuid,
    decision: z.enum(['pending', 'accepted', 'rejected']),
    /** 只对置信度 ≥ 这个值的行生效。不传 = 全部 */
    minConfidenceBp: z.number().int().min(0).max(10000).optional(),
    /** 只对这几类生效。默认只动 service —— 说明文字不该被一键建成项目 */
    kinds: z.array(z.enum(['service', 'addon', 'package', 'note', 'price_modifier']))
      .min(1).max(5).optional(),
  }),
  output: z.object({ blueprintId: uuid, affected: z.number().int() }),
  permission: 'catalog.manage',
  ai: {
    description: '批量勾选开店草案里的项目，可按置信度或类型筛。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const ReviewBlueprintItems = defineCommand({
  name: 'blueprint.reviewItems',
  input: z.object({
    blueprintId: uuid,
    items: z.array(z.object({
      itemId: uuid,
      decision: z.enum(['accepted', 'rejected']),
      name: i18nText.optional(),
      durationMin: z.number().int().min(1).max(600).nullable().optional(),
      priceCents: cents.min(0).max(500_000).nullable().optional(),
      category: z.string().max(120).nullable().optional(),
      packageSessions: z.number().int().min(0).max(10_000).optional(),
      packageServiceNames: z.array(z.string().min(1).max(200)).max(30).optional(),
      packageValidDays: z.number().int().min(1).max(3650).nullable().optional(),
    })).min(1).max(300),
  }),
  output: z.object({ blueprintId: uuid, affected: z.number().int() }),
  permission: 'catalog.manage',
  ai: { description: '批量确认并编辑开店草案项目。', confirm: 'always', exposed: false },
  reversible: true,
  idempotency: 'optional',
});

/**
 * 一键回填落地。
 *
 * 勾中的行逐条变成 `services`，走的是和手工建项目**完全同一段代码**。
 * 落地之后草案封板（sql/0014 的触发器），只留作「当时提取成了什么」的凭证。
 *
 * 幂等 required：老板在网差的店里点两下「落地」，第二下必须什么都不做 ——
 * 否则项目库里会出现两套一模一样的 38 个项目，而他分不清该删哪一套。
 */
export const ApplyBlueprint = defineCommand({
  name: 'blueprint.apply',
  input: z.object({
    blueprintId: uuid,
    /**
     * 价目表没印时长时按这个建。默认 45 分钟。
     * 一个能一键改的默认值，好过逼老板给 38 个项目逐个填。
     */
    fallbackDurationMin: z.number().int().min(5).max(600).default(45),
    /** 官网草案可在同一事务内落地门店资料与老板勾选的员工。 */
    applyLocationProposal: z.boolean().default(false),
    staffProposalIndexes: z.array(z.number().int().min(0).max(79)).max(80).default([]),
    /** 官网可能只有门店资料、没有价目表；显式允许这种草案完成。 */
    allowNoServices: z.boolean().default(false),
  }),
  output: z.object({
    blueprintId: uuid,
    createdServiceIds: z.array(uuid),
    createdPackageIds: z.array(uuid),
    createdStaffIds: z.array(uuid),
    locationApplied: z.boolean(),
    skipped: z.number().int(),
  }),
  permission: 'catalog.manage',
  ai: {
    description:
      '把开店草案里勾中的项目正式建进项目库。这一步不可撤销地改变项目库，' +
      '务必先确认老板已经逐项核对过。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'required',
});

export const DiscardBlueprint = defineCommand({
  name: 'blueprint.discard',
  input: z.object({ blueprintId: uuid }),
  output: z.object({ blueprintId: uuid }),
  permission: 'catalog.manage',
  ai: {
    description: '放弃一份开店草案。已经落地过的草案不能放弃。',
    confirm: 'destructive',
  },
  reversible: false,
  idempotency: 'optional',
});

export const BLUEPRINT_COMMANDS = [
  CreateBlueprintDraft, SaveBlueprintExtraction, SetBlueprintExtractionState,
  SaveBlueprintTranslations, ReviewBlueprintItem,
  ReviewAllBlueprintItems, ReviewBlueprintItems, ApplyBlueprint, DiscardBlueprint,
] as const;
