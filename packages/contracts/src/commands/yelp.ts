/**
 * Yelp 一键填店信息（05-AI-INTEGRATION §4.1）
 *
 * 老板输**店名 + 邮编**两个字段，把店建起来 —— 这是开店向导里最省事的一条路，
 * 而且**完全不过模型**：Yelp 返回的本来就是结构化 JSON。
 *
 * 搜索是只读的，走查询接口不走命令。这一条命令只管**落地**：
 * 老板从列表里点了一家、逐项看过之后，把选中的字段写进 `locations`。
 */

import { z } from 'zod';
import { defineCommand, uuid, phoneE164 } from '../command.js';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '要 HH:MM 格式');

export const ApplyYelpBusiness = defineCommand({
  name: 'location.applyYelp',
  input: z.object({
    /** 之后抓评价、刷营业时间都靠它，不用再消耗搜索配额（05 §4.1） */
    yelpBusinessId: z.string().min(1).max(120),

    /**
     * 老板逐项勾选之后传上来的。**每一项都可以不传** ——
     * 「一键填充」不等于「一键覆盖」：他可能只想要营业时间，
     * 店名早就自己起好了。不传的字段一个字节都不动。
     */
    name: z.string().min(1).max(200).optional(),
    phone: phoneE164.optional(),
    address: z.object({
      line1: z.string().max(200).nullable(),
      line2: z.string().max(200).nullable(),
      city: z.string().max(120).nullable(),
      state: z.string().max(40).nullable(),
      zip: z.string().max(20).nullable(),
      country: z.string().max(8).nullable(),
    }).optional(),
    /**
     * ⚠️ 时区错了整家店的日结、提成、报表全部错一天
     * （`business_day_cutoff` 靠它算营业日）。所以跨时区的州
     * 前端必须先让老板确认过再传上来。
     */
    timezone: z.string().min(3).max(64).optional(),
    businessHours: z.record(
      z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
      z.object({ open: hhmm, close: hhmm }).nullable(),
    ).optional(),

    /** 权威评分。存下来老板端的口碑趋势就不依赖抓取成不成功（05 §8.1） */
    ratingBp: z.number().int().min(0).max(50000).nullable().optional(),
    reviewCount: z.number().int().min(0).nullable().optional(),
  }),
  output: z.object({
    locationId: uuid,
    applied: z.array(z.string()),
  }),
  permission: 'settings.manage',
  ai: {
    description:
      '把 Yelp 上查到的门店信息填进本店。只填老板勾选的字段，没勾的不动。' +
      '时区必须让老板确认过 —— 填错会让日结和提成整体错一天。',
    confirm: 'always',
  },
  reversible: true,
  idempotency: 'optional',
});

export const YELP_COMMANDS = [ApplyYelpBusiness] as const;
