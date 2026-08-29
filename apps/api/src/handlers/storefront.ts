/**
 * 建站工单（批 8，sql/0045、docs/17）。
 *
 * ## 状态机
 *
 *   draft → submitted → drafted → chosen → live
 *              ↘ withdrawn ↗（回到 draft）
 *
 * ⭐ **draft 阶段一个字都不进我们的队列。** 这条要在界面上明说
 * （竞品那句 "nothing goes to the team until you submit" 值得照抄）——
 * 老板才敢把半成品先存着。
 */

import {
  SaveStorefrontBrief, SubmitStorefrontBrief, WithdrawStorefrontBrief, ChooseStorefrontDraft,
  AddStorefrontRevision, RequestStorefrontLaunch,
  AppError, ERROR_CODES,
} from '@gf/contracts';
import { jsonb, parseTs } from '@gf/db';
import { registerHandler, type HandlerArgs } from '../bus';

type Tx = HandlerArgs<unknown>['tx'];
type Ctx = HandlerArgs<unknown>['ctx'];

/** 一店一张。没有就建一张空的 —— 让「打开建站页」这个动作不需要先点「新建」 */
async function ensureBrief(tx: Tx, ctx: Ctx): Promise<{ id: string; status: string }> {
  await tx`
    insert into storefront_briefs (org_id, location_id)
    values (${ctx.orgId}, ${ctx.locationId})
    on conflict (location_id) do nothing`;
  const [row] = await tx<{ id: string; status: string }[]>`
    select id, status from storefront_briefs where location_id = ${ctx.locationId}`;
  if (!row) throw new AppError(ERROR_CODES.INTERNAL, { details: { reason: 'brief_unreachable' } });
  return row;
}

registerHandler(SaveStorefrontBrief, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveStorefrontBrief.input._type>) => {
  const brief = await ensureBrief(tx, ctx);

  /*
   * ⚠️ 已提交的不让改。
   *
   * 团队可能已经在照着它做了 —— 改掉的话我们做出来的东西和他现在
   * 看到的需求单对不上，而双方都以为自己没错。要改先撤回。
   */
  if (brief.status !== 'draft' && brief.status !== 'withdrawn') {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'brief_not_editable', status: brief.status },
    });
  }

  /*
   * 局部更新：没传的字段不动。
   *
   * 这张表格很长（五节二十来个字段），前端一定会分节保存 ——
   * 全量覆盖的话，保存第二节会把第一节清空。
   */
  const has = <K extends keyof typeof input>(k: K) => input[k] !== undefined;

  await tx`
    update storefront_briefs set
      current_site_url = ${has('currentSiteUrl') ? (input.currentSiteUrl ?? null) : tx`current_site_url`},
      has_no_site      = ${has('hasNoSite') ? input.hasNoSite! : tx`has_no_site`},
      pain_points      = ${has('painPoints') ? tx`${jsonb(input.painPoints)}::jsonb` : tx`pain_points`},
      pain_free_text   = ${has('painFreeText') ? (input.painFreeText ?? null) : tx`pain_free_text`},
      audience         = ${has('audience') ? tx`${jsonb(input.audience)}::jsonb` : tx`audience`},
      top_questions    = ${has('topQuestions') ? tx`${jsonb(input.topQuestions)}::jsonb` : tx`top_questions`},
      brand_primary    = ${has('brandPrimary') ? (input.brandPrimary ?? null) : tx`brand_primary`},
      brand_accent     = ${has('brandAccent') ? (input.brandAccent ?? null) : tx`brand_accent`},
      voice            = ${has('voice') ? (input.voice ?? null) : tx`voice`},
      reference_sites  = ${has('referenceSites') ? tx`${jsonb(input.referenceSites)}::jsonb` : tx`reference_sites`},
      sections         = ${has('sections') ? tx`${jsonb(input.sections)}::jsonb` : tx`sections`},
      usp              = ${has('usp') ? (input.usp ?? null) : tx`usp`},
      tone             = ${has('tone') ? (input.tone ?? null) : tx`tone`},
      logo_key         = ${has('logoKey') ? (input.logoKey ?? null) : tx`logo_key`},
      hero_key         = ${has('heroKey') ? (input.heroKey ?? null) : tx`hero_key`},
      gallery_keys     = ${has('galleryKeys') ? tx`${jsonb(input.galleryKeys)}::jsonb` : tx`gallery_keys`},
      store_name       = ${has('storeName') ? (input.storeName ?? null) : tx`store_name`},
      slogan           = ${has('slogan') ? (input.slogan ?? null) : tx`slogan`},
      photo_source_url = ${has('photoSourceUrl') ? (input.photoSourceUrl ?? null) : tx`photo_source_url`},
      status           = 'draft',
      updated_at       = now()
    where id = ${brief.id}`;

  audit({
    entityType: 'storefront_brief', entityId: brief.id,
    after: { status: 'draft', fields: Object.keys(input) },
  });
  return { briefId: brief.id, status: 'draft' };
});

registerHandler(SubmitStorefrontBrief, async ({ ctx, tx, audit }: HandlerArgs<
  typeof SubmitStorefrontBrief.input._type>) => {
  const brief = await ensureBrief(tx, ctx);
  if (brief.status !== 'draft' && brief.status !== 'withdrawn') {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'brief_already_submitted', status: brief.status },
    });
  }

  /*
   * ⭐ 必填校验放在**提交**这一步，不是保存那一步。
   *
   * 保存时校验的话，老板填到一半想存一下就会被三个红字拦住 ——
   * 然后他会把窗口关掉，那张表就永远填不完了。
   */
  const [row] = await tx<{
    usp: string | null; sections: string[]; logo_key: string | null;
  }[]>`
    select usp, (select coalesce(array_agg(x), '{}') from jsonb_array_elements_text(sections) x)
             as sections,
           logo_key
    from storefront_briefs where id = ${brief.id}`;

  const missing: string[] = [];
  if (!row?.usp?.trim()) missing.push('usp');
  if ((row?.sections ?? []).length === 0) missing.push('sections');
  if (missing.length > 0) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'brief_incomplete', missing },
    });
  }

  await tx`
    update storefront_briefs set status = 'submitted', submitted_at = now(), updated_at = now()
    where id = ${brief.id}`;

  // ⚠️ timestamptz 读回来是**字符串**不是 Date（驱动行为，全仓一致）——
  // 直接 .toISOString() 会炸。走 parseTs
  const [after] = await tx<{ at: string | Date }[]>`
    select submitted_at as at from storefront_briefs where id = ${brief.id}`;

  audit({
    entityType: 'storefront_brief', entityId: brief.id,
    before: { status: brief.status },
    after: { status: 'submitted' },
  });
  return {
    briefId: brief.id, status: 'submitted',
    submittedAt: parseTs(after!.at).toISOString(),
  };
});

registerHandler(WithdrawStorefrontBrief, async ({ ctx, tx, audit }: HandlerArgs<
  typeof WithdrawStorefrontBrief.input._type>) => {
  const brief = await ensureBrief(tx, ctx);
  /*
   * 已经上线的撤不回来 —— 那时候要改是「重做一版」，不是「撤回」。
   * 允许的话，一个 live 的站会突然变回 draft，而它的 public_url 还在外面。
   */
  if (brief.status === 'live') {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'brief_already_live' },
    });
  }
  await tx`
    update storefront_briefs set status = 'withdrawn', updated_at = now()
    where id = ${brief.id}`;
  audit({
    entityType: 'storefront_brief', entityId: brief.id,
    before: { status: brief.status }, after: { status: 'withdrawn' },
  });
  return { briefId: brief.id, status: 'withdrawn' };
});

registerHandler(ChooseStorefrontDraft, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof ChooseStorefrontDraft.input._type>) => {
  const [draft] = await tx<{ id: string; brief_id: string; variant: number }[]>`
    select id, brief_id, variant from storefront_drafts
    where id = ${input.draftId} and location_id = ${ctx.locationId}`;
  if (!draft) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'storefront_draft' } });
  }

  // 选了新的就把旧的选择清掉 —— 两版同时 chosen 的话，做的人不知道该做哪个
  await tx`
    update storefront_drafts set chosen_at = null
    where brief_id = ${draft.brief_id} and id <> ${draft.id}`;
  await tx`update storefront_drafts set chosen_at = now() where id = ${draft.id}`;
  await tx`
    update storefront_briefs set status = 'chosen', updated_at = now()
    where id = ${draft.brief_id}`;

  audit({
    entityType: 'storefront_brief', entityId: draft.brief_id,
    after: { status: 'chosen', draftId: draft.id, variant: draft.variant },
  });
  return { briefId: draft.brief_id, draftId: draft.id, status: 'chosen' };
});

registerHandler(AddStorefrontRevision, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof AddStorefrontRevision.input._type>) => {
  const brief = await ensureBrief(tx, ctx);
  if (!['submitted', 'drafted', 'chosen', 'live'].includes(brief.status)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'brief_not_submitted', status: brief.status },
    });
  }
  const [revision] = await tx<{ id: string; created_at: string | Date }[]>`
    insert into storefront_revisions (
      org_id, location_id, brief_id, text, created_by_membership_id
    ) values (
      ${ctx.orgId}, ${ctx.locationId}, ${brief.id}, ${input.text}, ${ctx.membershipId}
    ) returning id, created_at`;
  audit({
    entityType: 'storefront_revision', entityId: revision!.id,
    after: { briefId: brief.id, status: 'submitted' },
  });
  return {
    revisionId: revision!.id,
    status: 'submitted' as const,
    createdAt: parseTs(revision!.created_at).toISOString(),
  };
});

registerHandler(RequestStorefrontLaunch, async ({ ctx, tx, audit }: HandlerArgs<
  typeof RequestStorefrontLaunch.input._type>) => {
  const brief = await ensureBrief(tx, ctx);
  if (brief.status !== 'chosen') {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'draft_not_chosen', status: brief.status },
    });
  }
  const [row] = await tx<{ launch_requested_at: string | Date }[]>`
    update storefront_briefs
    set launch_requested_at = coalesce(launch_requested_at, now()), updated_at = now()
    where id = ${brief.id}
    returning launch_requested_at`;
  const at = parseTs(row!.launch_requested_at).toISOString();
  audit({
    entityType: 'storefront_brief', entityId: brief.id,
    after: { status: brief.status, launchRequestedAt: at },
  });
  return { briefId: brief.id, status: brief.status, launchRequestedAt: at };
});
