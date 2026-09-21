import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AppError, ERROR_CODES, serviceShortNamesSchema, missingServiceShortNames, SERVICE_SHORT_NAME_LOCALES, type ServiceShortNames } from '@gf/contracts';
import { withTenant } from '@gf/db';
import { generateServiceShortNames, SHORT_NAME_MODEL, SHORT_NAME_RATES, costMillicents, billableTokens } from '@gf/ai';
import { dispatch } from '../bus';
import { assertAiAdmission } from '../billing/aiAdmission';
import { maybeAutoTopup } from '../billing/autoTopup';
import type { CtxFromHeaders } from './utils';
const request=z.union([
  z.object({serviceIds:z.array(z.string().uuid()).min(1).max(25)}).strict(),
  z.object({name:z.record(z.enum(SERVICE_SHORT_NAME_LOCALES),z.string().max(200)).refine(n=>Object.values(n).some(v=>v.trim())),shortNames:serviceShortNamesSchema.default({})}).strict(),
]);
export function registerServiceShortNameRoutes(app:FastifyInstance,ctxFromHeaders:CtxFromHeaders) {
  app.post('/v1/desk/services/short-names/generate',{bodyLimit:50000},async req=>{
    const ctx=await ctxFromHeaders(req);
    if(!ctx.permissions.has('catalog.manage')||!ctx.permissions.has('ai.use'))throw new AppError(ERROR_CODES.PERMISSION_DENIED);
    const parsed=request.safeParse(req.body);
    if(!parsed.success)throw new AppError(ERROR_CODES.VALIDATION_FAILED);
    const input=parsed.data;
    const rows='serviceIds' in input ? await withTenant(ctx,tx=>tx<{id:string;name:Record<string,string>;short_names:ServiceShortNames;updated_at:string}[]>`
      select id,name,short_names,updated_at::text from services where location_id=${ctx.locationId} and id=any(${[...new Set(input.serviceIds)]}) order by id`) : [];
    if('serviceIds' in input && rows.length!==new Set(input.serviceIds).size)throw new AppError(ERROR_CODES.NOT_FOUND);
    const targets=rows.filter(r=>missingServiceShortNames(r.short_names).length);
    const sources='name' in input ? [{seq:0,name:input.name,shortNames:input.shortNames}] : targets.map((r,seq)=>({seq,name:r.name,shortNames:r.short_names}));
    if(!sources.length)return {updated:0,skipped:0};
    if('name' in input && !missingServiceShortNames(input.shortNames).length)return {shortNames:input.shortNames};
    if(!process.env.OPENAI_API_KEY)throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE,{details:{service:'openai'}});
    await assertAiAdmission(ctx);
    const generated=await generateServiceShortNames(sources,{apiKey:process.env.OPENAI_API_KEY});
    await dispatch('ai.recordAssist',{feature:'service_short_names',model:SHORT_NAME_MODEL,tokens:billableTokens(generated.usage),costMillicents:costMillicents(generated.usage,SHORT_NAME_RATES),rounds:1,hadProposal:!generated.error},ctx,{systemOrigin:'service_short_names'});
    void maybeAutoTopup(ctx,'credit',req.log);
    if(generated.error)throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE,{details:{reason:generated.error}});
    if('name' in input)return {shortNames:generated.items[0]!.shortNames};
    const saved=await dispatch<{updated:number;skipped:number}>('catalog.fillServiceShortNames',{items:generated.items.map(r=>({serviceId:targets[r.seq]!.id,expectedUpdatedAt:targets[r.seq]!.updated_at,shortNames:r.shortNames}))},ctx);
    return saved.result;
  });
}
