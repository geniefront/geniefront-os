import {beforeAll,afterAll,it,expect} from 'vitest';
import {withTenant,closeDb} from '@gf/db';
import {dispatch} from './bus';
import {buildContext} from './actor';
import './handlers/setup';
const tenant={orgId:'11111111-1111-4111-8111-111111111111',locationId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',membershipId:null};
let ctx:Awaited<ReturnType<typeof buildContext>>;
beforeAll(async()=>{const [m]=await withTenant(tenant,tx=>tx`select id,user_id from memberships where location_id=${tenant.locationId} and user_id is not null order by created_at limit 1`);ctx=await buildContext({userId:m!.user_id,membershipId:m!.id});});
afterAll(closeDb);
it('persists names, preserves omitted values, fills missing languages, and skips stale AI results',async()=>{
 const input={name:{en:'Deep Tissue'},durationMin:60,basePriceCents:7500};
 const saved=await dispatch<{serviceId:string}>('catalog.saveService',{...input,shortNames:{'zh-Hans':'深压'}},ctx);
 const serviceId=saved.result.serviceId;
 await dispatch('catalog.saveService',{...input,serviceId,durationMin:90},ctx);
 const read=()=>withTenant(tenant,tx=>tx`select short_names,updated_at::text as updated_at,duration_min from services where id=${serviceId}`).then(r=>r[0]!);
 let row=await read();expect(row.short_names).toEqual({'zh-Hans':'深压'});
 const version=row.updated_at;
 await dispatch('catalog.fillServiceShortNames',{items:[{serviceId,expectedUpdatedAt:version,shortNames:{en:'Deep','zh-Hans':'深层',ko:'심부'}}]},ctx);
 row=await read();expect(row.short_names).toEqual({'zh-Hans':'深压',en:'Deep',ko:'심부'});expect(row.duration_min).toBe(90);
 const stale=await dispatch('catalog.fillServiceShortNames',{items:[{serviceId,expectedUpdatedAt:version,shortNames:{es:'Profundo'}}]},ctx);
 expect(stale.result).toEqual({updated:0,skipped:1});expect((await read()).short_names.es).toBeUndefined();
 await expect(dispatch('catalog.fillServiceShortNames',{items:[{serviceId:'00000000-0000-4000-8000-000000000000',expectedUpdatedAt:version,shortNames:{en:'Other'}}]},ctx)).rejects.toMatchObject({code:'NOT_FOUND'});
});
it('validates abbreviated names before writing',async()=>{
 await expect(dispatch('catalog.saveService',{name:{en:'Service'},durationMin:30,basePriceCents:3000,shortNames:{'zh-Hans':'a'.repeat(13)}},ctx)).rejects.toBeTruthy();
});
