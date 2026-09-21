import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import type {CommandContext} from '@gf/contracts';
const mocks=vi.hoisted(()=>({generate:vi.fn(),admission:vi.fn(),dispatch:vi.fn(),query:vi.fn(),topup:vi.fn()}));
vi.mock('@gf/ai',()=>({generateServiceShortNames:mocks.generate,SHORT_NAME_MODEL:'test',SHORT_NAME_RATES:{},costMillicents:()=>1,billableTokens:()=>2}));
vi.mock('@gf/db',()=>({withTenant:(_ctx:unknown,fn:(tx:unknown)=>unknown)=>fn(mocks.query)}));
vi.mock('../bus',()=>({dispatch:mocks.dispatch,assertSubscriptionAllowsWrite:mocks.admission}));
vi.mock('../billing/aiAdmission',()=>({assertAiAdmission:mocks.admission}));
vi.mock('../billing/autoTopup',()=>({maybeAutoTopup:mocks.topup}));
import {registerServiceShortNameRoutes} from './serviceShortNames';
const names={en:'Deep','zh-Hans':'深层','zh-Hant':'深層',ko:'심부',vi:'Sâu',es:'Profundo'};
const id='aaaaaaaa-0000-4000-8000-000000000001';
let app:FastifyInstance;
let ctx:CommandContext;
beforeEach(()=>{
 vi.clearAllMocks();vi.stubEnv('OPENAI_API_KEY','test');
 ctx={orgId:'org',locationId:'location',membershipId:'owner',userId:'user',actorKind:'user',locale:'en',timezone:'UTC',permissions:new Set(['ai.use','catalog.manage'])};
 mocks.generate.mockResolvedValue({items:[{seq:0,shortNames:names}],usage:{}});
 mocks.admission.mockResolvedValue(undefined);mocks.dispatch.mockResolvedValue({result:{updated:1,skipped:0}});
 mocks.query.mockResolvedValue([{id,name:{en:'Deep Tissue'},short_names:{},updated_at:'version'}]);
 app=Fastify();registerServiceShortNameRoutes(app,async()=>ctx);
 app.setErrorHandler((err,_req,reply)=>reply.code(400).send({code:(err as {code?:string}).code}));
});
afterEach(async()=>{await app.close();vi.unstubAllEnvs();});
it('generates all languages for an unsaved service without persisting a catalog row',async()=>{
 const res=await app.inject({method:'POST',url:'/v1/desk/services/short-names/generate',payload:{name:{en:'Deep'},shortNames:{}}});
 expect(res.statusCode).toBe(200);expect(res.json().shortNames).toEqual(names);
 expect(mocks.dispatch).not.toHaveBeenCalled();
});
it('loads authoritative tenant rows and saves using their observed version',async()=>{
 const res=await app.inject({method:'POST',url:'/v1/desk/services/short-names/generate',payload:{serviceIds:[id]}});
 expect(res.json()).toEqual({updated:1,skipped:0});
 expect(mocks.dispatch).toHaveBeenCalledWith('catalog.fillServiceShortNames',{items:[{serviceId:id,expectedUpdatedAt:'version',shortNames:names}]},ctx);
 expect(mocks.query.mock.calls[0]!.slice(1)).toContain('location');
});
it('rejects a missing or other-tenant service before spending AI usage',async()=>{
 mocks.query.mockResolvedValue([]);
 const res=await app.inject({method:'POST',url:'/v1/desk/services/short-names/generate',payload:{serviceIds:[id]}});
 expect(res.statusCode).toBe(400);expect(mocks.generate).not.toHaveBeenCalled();
});
it('allows catalog managers without copilot access, but rejects non-managers',async()=>{
 ctx.permissions=new Set(['catalog.manage']);
 const ok=await app.inject({method:'POST',url:'/v1/desk/services/short-names/generate',payload:{serviceIds:[id]}});
 expect(ok.statusCode).toBe(200);expect(mocks.admission).toHaveBeenCalled();
 mocks.generate.mockClear();ctx.permissions=new Set(['ai.use']);
 const denied=await app.inject({method:'POST',url:'/v1/desk/services/short-names/generate',payload:{serviceIds:[id]}});
 expect(denied.statusCode).toBe(400);expect(mocks.generate).not.toHaveBeenCalled();
});
it('never saves invalid model output',async()=>{
 mocks.generate.mockResolvedValue({items:[],usage:{},error:'invalid_short_names'});
 const res=await app.inject({method:'POST',url:'/v1/desk/services/short-names/generate',payload:{serviceIds:[id]}});
 expect(res.statusCode).toBe(400);expect(mocks.dispatch).not.toHaveBeenCalled();
});

it('checks the subscription gate before spending on generation',async()=>{
 mocks.admission.mockRejectedValue(new Error('Subscription inactive'));
 await app.inject({method:'POST',url:'/v1/desk/services/short-names/generate',payload:{name:{en:'Deep'},shortNames:{}}});
 expect(mocks.generate).not.toHaveBeenCalled();
});
