/**
 * AI 拍照开店、蓝图提取与建站草案路由
 *
 * 从 server.ts 拆出。包含：
 * - AI 建站草案生成 (/v1/storefront/:id/generate)
 * - 拍照提取价目表 (/v1/blueprint/:id/extract)
 * - 大牌子分块规划 (/v1/blueprint/plan-regions)
 * - 多语言菜单补齐 (/v1/blueprint/:id/translate)
 * - 开店草案详情与列表 (/v1/desk/blueprint/:id, /v1/desk/blueprints)
 * - 建站工单与历史版本 (/v1/desk/storefront/brief, /v1/desk/storefront/revisions)
 */

import type { FastifyInstance } from 'fastify';
import {
  AppError, ERROR_CODES, pickText,
} from '@gf/contracts';
import { withTenant, jsonb } from '@gf/db';
import {
  extractPriceList, costMillicents, billableTokens, MAX_IMAGE_EDGE_PX,
  itemsNeedingTranslation, translateNames, TRANSLATE_MODEL, TRANSLATE_RATES,
  planRegions, padRegion, shouldChunk, capRegions, REGION_MODEL, REGION_RATES,
  generateStorefrontDrafts, SONNET_5_RATES,
  generateHealthFormQuestions,
  extractWebsite,
  type PriceListImage, type ImageMediaType,
} from '@gf/ai';
import { dispatch } from '../bus';
import { maybeAutoTopup } from '../billing/autoTopup';
import { assertAiAdmission } from '../billing/aiAdmission';
import { loadBlueprint, listBlueprints } from '../queries/blueprint';
import type { CtxFromHeaders } from './utils';
import { fetchWebsitePages } from '../onboarding/websiteFetch';

const MAX_IMAGES_PER_EXTRACT = 6;
const MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function registerAiRoutes(app: FastifyInstance, ctxFromHeaders: CtxFromHeaders): void {

  app.post<{ Body: { url?: string; locale?: string } }>('/v1/onboarding/website/extract', { bodyLimit: 50_000 }, async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage') || !ctx.permissions.has('catalog.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage+catalog.manage' } });
    }
    if (!ctx.permissions.has('ai.use')) throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ai.use' } });
    const url = req.body?.url?.trim() ?? '';
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, { details: { service: 'anthropic' } });
    // ⛔ 准入闸门（AUD-03）：欠费 / 额度耗尽 / 刷得太快，都在这里挡下，
    // **一次 token 都不花**。放在紧挨模型调用的上一行，中间不留任何 IO。
    await assertAiAdmission(ctx);
    const pages = await fetchWebsitePages(url);
    const extracted = await extractWebsite(pages, { apiKey, locale: req.body?.locale ?? ctx.locale });
    const created = await dispatch<{ blueprintId: string }>('blueprint.createDraft', {
      label: `官网导入 · ${new URL(url).hostname}`,
      sources: [{ seq: 0, kind: 'website', storagePath: null, sourceUrl: url, rawSnapshot: { pages: pages.map((p) => p.url) }, widthPx: null, heightPx: null }],
    }, ctx);
    const cost = costMillicents(extracted.usage, SONNET_5_RATES);
    await dispatch('blueprint.saveExtraction', {
      blueprintId: created.result.blueprintId, items: extracted.items, unresolved: extracted.unresolved,
      locationProposal: extracted.locationProposal,
      usage: { tokens: billableTokens(extracted.usage), costMillicents: cost, imagesOk: 0, imagesFailed: 0, feature: 'website_onboarding', model: extracted.model },
    }, ctx);
    void maybeAutoTopup(ctx, 'credit', req.log);
    return withTenant({ orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId }, (tx) => loadBlueprint(tx, ctx, created.result.blueprintId));
  });

  // ── 健康表设计器：真实 AI 出题 / 五语翻译 ────────────────────────────────
  app.post<{
    Body?: {
      prompt?: string;
      actionType?: string;
      templateTitle?: unknown;
      existingQuestions?: unknown[];
    };
  }>('/v1/desk/forms/ai/questions', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
    }
    if (!ctx.permissions.has('ai.use')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ai.use' } });
    }
    const prompt = req.body?.prompt?.trim() ?? '';
    const existingQuestions = req.body?.existingQuestions ?? [];
    if (prompt.length < 3 || prompt.length > 2_000 || existingQuestions.length > 40) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'invalid_health_form_ai_request' },
      });
    }
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, { details: { service: 'anthropic' } });
    }

    // ⛔ 准入闸门（AUD-03）：欠费 / 额度耗尽 / 刷得太快，都在这里挡下，
    // **一次 token 都不花**。放在紧挨模型调用的上一行，中间不留任何 IO。
    await assertAiAdmission(ctx);
    const generated = await generateHealthFormQuestions({
      prompt,
      actionType: req.body?.actionType ?? 'generate_specialty',
      templateTitle: req.body?.templateTitle ?? {},
      existingQuestions,
    }, { apiKey });
    const cost = costMillicents(generated.usage, SONNET_5_RATES);
    await dispatch('ai.recordAssist', {
      feature: 'health_form_design',
      model: generated.model,
      tokens: billableTokens(generated.usage),
      costMillicents: cost,
      rounds: 1,
      hadProposal: true,
    }, ctx, { systemOrigin: 'anthropic_usage' });
    void maybeAutoTopup(ctx, 'credit', req.log);
    return { questions: generated.questions, model: generated.model };
  });

  // ── 建站工单：AI 出三版 ──────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/v1/storefront/:id/generate', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('settings.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'settings.manage' } });
    }
    if (!ctx.permissions.has('ai.use')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ai.use' } });
    }
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      req.log.error('ANTHROPIC_API_KEY 未配置，建站工单生成不可用');
      throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, { details: { service: 'anthropic' } });
    }

    const tenant = { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId };

    const brief = await withTenant(tenant, (tx) => tx<{
      id: string; status: string; shop_name: unknown; business_type: string;
      voice: string | null; brand_primary: string | null; brand_accent: string | null;
      pain_points: string[]; pain_free_text: string | null;
      audience: string[]; top_questions: string[]; sections: string[];
      usp: string | null; tone: string | null; reference_sites: string[];
    }[]>`
      select b.id, b.status, l.name as shop_name, l.business_type,
             b.voice, b.brand_primary, b.brand_accent,
             b.pain_points, b.pain_free_text, b.audience, b.top_questions,
             b.sections, b.usp, b.tone, b.reference_sites
      from storefront_briefs b
      join locations l on l.id = b.location_id
      where b.id = ${req.params.id} and b.location_id = ${ctx.locationId}`);

    const row = brief[0];
    if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'storefront_brief' } });
    if (row.status !== 'submitted') {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'brief_not_submitted', status: row.status },
      });
    }

    const services = await withTenant(tenant, (tx) => tx<{
      name: unknown; price: number; minutes: number;
    }[]>`
      select name, base_price_cents as price, duration_min as minutes
      from services
      where location_id = ${ctx.locationId} and active = true and is_addon = false
      order by sort, base_price_cents limit 40`);

    // ⛔ 准入闸门（AUD-03）：欠费 / 额度耗尽 / 刷得太快，都在这里挡下，
    // **一次 token 都不花**。放在紧挨模型调用的上一行，中间不留任何 IO。
    await assertAiAdmission(ctx);
    const result = await generateStorefrontDrafts({
      shopName: pickText(row.shop_name, ctx.locale, ''),
      businessType: row.business_type,
      voice: row.voice,
      brandPrimary: row.brand_primary,
      brandAccent: row.brand_accent,
      painPoints: row.pain_points ?? [],
      painFreeText: row.pain_free_text,
      audience: row.audience ?? [],
      topQuestions: row.top_questions ?? [],
      sections: row.sections ?? [],
      usp: row.usp,
      tone: row.tone,
      referenceSites: row.reference_sites ?? [],
      services: services.map((s) => ({
        name: pickText(s.name, ctx.locale, ''),
        priceCents: s.price, durationMin: s.minutes,
      })),
    }, { apiKey });

    if (result.drafts.length === 0) {
      throw new AppError(ERROR_CODES.EXTRACTION_FAILED, {
        details: { reason: 'no_drafts_generated', model: result.model },
      });
    }

    const cost = costMillicents(result.usage, SONNET_5_RATES);
    // ⚠️ 草案落库 + 工单状态推进走命令（AUD-04）。原来是三条裸 SQL，
    // 于是一次工单状态机推进在 audit_log 里什么都没留下。
    await dispatch('storefront.saveDrafts', {
      briefId: row.id,
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costMillicents: cost,
      drafts: result.drafts.map((d) => ({
        variant: d.variant,
        content: d.content as unknown as Record<string, unknown>,
      })),
    }, ctx, { systemOrigin: 'anthropic_usage' });

    await dispatch('ai.recordAssist', {
      feature: 'storefront_generation',
      model: result.model,
      tokens: billableTokens(result.usage),
      costMillicents: cost,
      rounds: 1,
      hadProposal: true,
    }, ctx, { systemOrigin: 'anthropic_usage' });
    void maybeAutoTopup(ctx, 'credit', req.log);

    return {
      briefId: row.id,
      status: 'drafted',
      drafts: result.drafts,
      model: result.model,
      costMillicents: cost,
    };
  });

  // ── 拍照开店：提取 ──────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/v1/blueprint/:id/extract',
    { bodyLimit: 32_000_000 },
    async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('catalog.manage')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'catalog.manage' } });
      }
      if (!ctx.permissions.has('ai.use')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ai.use' } });
      }

      const apiKey = process.env['ANTHROPIC_API_KEY'];
      if (!apiKey) {
        req.log.error('ANTHROPIC_API_KEY 未配置，拍照开店不可用');
        throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, { details: { service: 'anthropic' } });
      }

      const body = req.body as {
        images?: Array<{
          seq?: number; base64?: string; mediaType?: string;
          widthPx?: number; heightPx?: number;
        }>;
        locale?: string;
      } | undefined;

      const raw = body?.images ?? [];
      if (raw.length === 0 || raw.length > MAX_IMAGES_PER_EXTRACT) {
        throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
          details: { reason: `一次最多 ${MAX_IMAGES_PER_EXTRACT} 张照片`, got: raw.length },
        });
      }

      const images: PriceListImage[] = raw.map((im, i) => {
        if (typeof im.base64 !== 'string' || im.base64.length === 0
            || typeof im.mediaType !== 'string' || !MEDIA_TYPES.has(im.mediaType)) {
          throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
            details: { reason: '照片格式不对，只支持 JPEG / PNG / WebP', index: i },
          });
        }
        if ((im.widthPx ?? 0) > MAX_IMAGE_EDGE_PX || (im.heightPx ?? 0) > MAX_IMAGE_EDGE_PX) {
          throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
            details: { reason: `照片长边不能超过 ${MAX_IMAGE_EDGE_PX}px`, index: i },
          });
        }
        return {
          seq: typeof im.seq === 'number' ? im.seq : i,
          base64: im.base64,
          mediaType: im.mediaType as ImageMediaType,
          ...(im.widthPx ? { widthPx: im.widthPx } : {}),
          ...(im.heightPx ? { heightPx: im.heightPx } : {}),
        };
      });

      const view = await withTenant(
        { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
        (tx) => loadBlueprint(tx, ctx, req.params.id));
      if (!view) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'blueprint' } });
      if (view.status !== 'draft') {
        throw new AppError(ERROR_CODES.BLUEPRINT_FROZEN, { details: { status: view.status } });
      }

      // ⛔ 准入闸门（AUD-03）：欠费 / 额度耗尽 / 刷得太快，都在这里挡下，
      // **一次 token 都不花**。放在紧挨模型调用的上一行，中间不留任何 IO。
      await assertAiAdmission(ctx);
      const result = await extractPriceList(images, {
        apiKey,
        ...(body?.locale ? { locale: body.locale } : {}),
        log: req.log,
      });

      const ok = result.perImage.filter((p) => !p.error).length;
      if (ok === 0) {
        throw new AppError(ERROR_CODES.EXTRACTION_FAILED, {
          details: { reasons: result.perImage.map((p) => ({ seq: p.seq, error: p.error })) },
        });
      }

      const out = await dispatch<{ blueprintId: string; itemCount: number }>(
        'blueprint.saveExtraction',
        {
          blueprintId: req.params.id,
          items: result.items,
          unresolved: result.unresolved,
          usage: {
            tokens: billableTokens(result.usage),
            costMillicents: costMillicents(result.usage),
            imagesOk: ok,
            imagesFailed: result.perImage.length - ok,
          },
        },
        ctx, { systemOrigin: 'anthropic_usage' });

      void maybeAutoTopup(ctx, 'credit', req.log);

      return {
        ...out.result,
        merged: result.merge.merged,
        conflicts: result.merge.conflicts,
        dropped: result.dropped,
        failedImages: result.perImage
          .filter((p) => p.error)
          .map((p) => ({ seq: p.seq, error: p.error })),
      };
    });

  // ── 大牌子分块：第一遍只看结构 ─────────────────────────────────────────────
  app.post('/v1/blueprint/plan-regions', { bodyLimit: 8_000_000 }, async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('catalog.manage') || !ctx.permissions.has('ai.use')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'catalog.manage+ai.use' } });
    }
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, { details: { service: 'anthropic' } });
    }

    const im = (req.body ?? {}) as {
      base64?: string; mediaType?: string; widthPx?: number; heightPx?: number;
    };
    if (typeof im.base64 !== 'string' || !im.base64
        || typeof im.mediaType !== 'string' || !MEDIA_TYPES.has(im.mediaType)
        || !im.widthPx || !im.heightPx) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: '要一张带尺寸的照片' },
      });
    }

    // ⛔ 准入闸门（AUD-03）：欠费 / 额度耗尽 / 刷得太快，都在这里挡下，
    // **一次 token 都不花**。放在紧挨模型调用的上一行，中间不留任何 IO。
    await assertAiAdmission(ctx);
    const r = await planRegions({
      seq: 0, base64: im.base64, mediaType: im.mediaType as ImageMediaType,
      widthPx: im.widthPx, heightPx: im.heightPx,
    }, { apiKey });

    await dispatch('ai.recordAssist', {
      feature: 'price_list_regions',
      model: REGION_MODEL,
      tokens: billableTokens(r.usage),
      costMillicents: costMillicents(r.usage, REGION_RATES),
    }, ctx, { systemOrigin: 'anthropic_usage' });
    void maybeAutoTopup(ctx, 'credit', req.log);

    const usable = !r.error && shouldChunk(r.regions) && r.coverage.ok;
    const capped = usable ? capRegions(r.regions, MAX_IMAGES_PER_EXTRACT) : [];

    return {
      chunk: usable,
      reason: r.error ?? (!shouldChunk(r.regions) ? 'single_region'
        : !r.coverage.ok ? 'coverage_gap' : null),
      coveredRatio: Math.round(r.coverage.covered * 100),
      regions: capped.map((g) => ({
        label: g.label,
        crop: padRegion(g, im.widthPx!, im.heightPx!),
      })),
    };
  });

  // ── 多语言补齐 ────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/v1/blueprint/:id/translate',
    async (req) => {
      const ctx = await ctxFromHeaders(req);
      if (!ctx.permissions.has('catalog.manage')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'catalog.manage' } });
      }
      if (!ctx.permissions.has('ai.use')) {
        throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'ai.use' } });
      }
      const apiKey = process.env['ANTHROPIC_API_KEY'];
      if (!apiKey) {
        throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, { details: { service: 'anthropic' } });
      }

      const view = await withTenant(
        { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
        (tx) => loadBlueprint(tx, ctx, req.params.id));
      if (!view) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'blueprint' } });
      if (view.status !== 'draft') {
        throw new AppError(ERROR_CODES.BLUEPRINT_FROZEN, { details: { status: view.status } });
      }

      const candidates = itemsNeedingTranslation(view.items.map((it) => ({
        seq: it.seq,
        name: (it.name ?? {}) as Record<string, string>,
        nameAuto: it.nameAuto ?? [],
        kind: it.kind,
      })));

      if (candidates.length === 0) {
        return { blueprintId: req.params.id, filledItems: 0, filledCells: 0, rejected: null, credits: 0 };
      }

      // ⛔ 准入闸门（AUD-03）：欠费 / 额度耗尽 / 刷得太快，都在这里挡下，
      // **一次 token 都不花**。放在紧挨模型调用的上一行，中间不留任何 IO。
      await assertAiAdmission(ctx);
      const t = await translateNames(candidates, { apiKey });
      if (t.error) {
        throw new AppError(ERROR_CODES.EXTRACTION_FAILED, { details: { stage: 'translate', reason: t.error } });
      }

      const out = await dispatch<{ filledCells: number }>(
        'blueprint.saveTranslations',
        {
          blueprintId: req.params.id,
          translations: t.translations,
          usage: {
            tokens: billableTokens(t.usage),
            costMillicents: costMillicents(t.usage, TRANSLATE_RATES),
          },
        },
        ctx, { systemOrigin: 'anthropic_usage' });

      void maybeAutoTopup(ctx, 'credit', req.log);

      return {
        blueprintId: req.params.id,
        filledItems: candidates.length,
        filledCells: out.result.filledCells,
        rejected: null,
        credits: costMillicents(t.usage, TRANSLATE_RATES),
      };
    });

  // ── 查询：开店草案 ─────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/v1/desk/blueprint/:id', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('catalog.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'catalog.manage' } });
    }
    const view = await withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      (tx) => loadBlueprint(tx, ctx, req.params.id));
    if (!view) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'blueprint' } });
    return view;
  });

  app.get('/v1/desk/blueprints', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('catalog.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'catalog.manage' } });
    }
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => ({ blueprints: await listBlueprints(tx, ctx) }));
  });

  app.get('/v1/desk/storefront/brief', async (req) => {
    const ctx = await ctxFromHeaders(req);
    return withTenant(
      { orgId: ctx.orgId, locationId: ctx.locationId, membershipId: ctx.membershipId },
      async (tx) => {
        const [loc] = await tx<{ name: unknown; slogan: unknown }[]>`
          select name, settings->'storefront'->>'slogan' as slogan from locations where id = ${ctx.locationId}`;
        const [brief] = await tx<{
          id: string; status: string;
          voice: string | null; brand_primary: string | null; brand_accent: string | null;
          pain_points: string[]; pain_free_text: string | null;
          audience: string[]; top_questions: string[]; sections: string[];
          usp: string | null; tone: string | null; reference_sites: string[];
          current_site_url: string | null; has_no_site: boolean;
          submitted_at: Date | string | null; drafted_at: Date | string | null;
          live_at: Date | string | null; public_url: string | null;
          store_name: string | null; slogan: string | null; photo_source_url: string | null;
          launch_requested_at: Date | string | null;
          created_at: Date | string; updated_at: Date | string;
        }[]>`
          select id, status, voice, brand_primary, brand_accent,
                 pain_points, pain_free_text, audience, top_questions,
                 sections, usp, tone, reference_sites, current_site_url, has_no_site,
                 submitted_at, drafted_at, live_at, public_url,
                 store_name, slogan, photo_source_url, launch_requested_at,
                 created_at, updated_at
          from storefront_briefs where location_id = ${ctx.locationId} order by updated_at desc limit 1`;
        const drafts = brief ? await tx<{
          id: string; variant: number; content: unknown; chosen_at: Date | string | null;
          model: string | null; created_at: Date | string;
        }[]>`
          select id, variant, content, chosen_at, model, created_at
          from storefront_drafts where brief_id = ${brief.id} order by variant` : [];
        return {
          shopName: brief?.store_name || pickText(loc?.name, ctx.locale, ''),
          slogan: brief?.slogan || (loc as any)?.slogan || '',
          brief: brief ? {
            id: brief.id,
            status: brief.status,
            voice: brief.voice,
            brandPrimary: brief.brand_primary,
            brandAccent: brief.brand_accent,
            painPoints: brief.pain_points,
            sections: brief.sections,
            usp: brief.usp,
            tone: brief.tone,
            currentSiteUrl: brief.current_site_url,
            hasNoSite: brief.has_no_site,
            painFreeText: brief.pain_free_text,
            audience: brief.audience,
            topQuestions: brief.top_questions,
            referenceSites: brief.reference_sites,
            submittedAt: brief.submitted_at ? new Date(brief.submitted_at).toISOString() : null,
            draftedAt: brief.drafted_at ? new Date(brief.drafted_at).toISOString() : null,
            liveAt: brief.live_at ? new Date(brief.live_at).toISOString() : null,
            publicUrl: brief.public_url,
            storeName: brief.store_name,
            slogan: brief.slogan,
            photoSourceUrl: brief.photo_source_url,
            launchRequestedAt: brief.launch_requested_at ? new Date(brief.launch_requested_at).toISOString() : null,
            createdAt: new Date(brief.created_at).toISOString(),
            updatedAt: new Date(brief.updated_at).toISOString(),
          } : null,
          drafts: drafts.map((draft) => ({
            draftId: draft.id,
            variant: draft.variant,
            content: draft.content,
            chosenAt: draft.chosen_at ? new Date(draft.chosen_at).toISOString() : null,
            model: draft.model,
            createdAt: new Date(draft.created_at).toISOString(),
          })),
        };
      }
    );
  });

  app.get('/v1/desk/storefront/revisions', async (req) => {
    const ctx = await ctxFromHeaders(req);
    if (!ctx.permissions.has('billing.manage') && !ctx.permissions.has('settings.manage')) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, { details: { need: 'billing.manage' } });
    }
    return withTenant(ctx, async (tx) => {
      const rows = await tx<{
        id: string; text: string; status: string; response: string | null;
        created_at: Date | string; updated_at: Date | string;
      }[]>`
        select r.id, r.text, r.status, r.response, r.created_at, r.updated_at
        from storefront_revisions r
        join storefront_briefs b on b.id = r.brief_id
        where b.location_id = ${ctx.locationId}
        order by r.created_at desc`;
      return {
        revisions: rows.map((row) => ({
          id: row.id,
          text: row.text,
          status: row.status,
          response: row.response,
          createdAt: new Date(row.created_at).toISOString(),
          updatedAt: new Date(row.updated_at).toISOString(),
        })),
      };
    });
  });
}
