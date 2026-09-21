import {afterAll,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {withTenant,closeDb,setSmsConsent} from '@gf/db';
const provider=vi.hoisted(()=>({sendSms:vi.fn().mockResolvedValue({ok:true}),smsConfigured:()=>true}));
vi.mock('./sms/send',()=>provider);
import {flushSms} from './sms/flush';
const tenant={orgId:'11111111-1111-4111-8111-111111111111',locationId:'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',membershipId:null};
afterAll(closeDb);
it('still suppresses opted-out shop recipients even when GF notices have no opt-out footer',async()=>{
 const phone='+16175550126',id=randomUUID();
 await setSmsConsent(phone,'opted_out','STOP');
 try {
  await withTenant(tenant,tx=>tx`insert into sms_outbox(id,org_id,location_id,kind,to_e164,from_e164,body,segments,entity_type,entity_id) values(${id},${tenant.orgId},${tenant.locationId},'appointment_changed',${phone},'+16175550125','GF: 新预约｜Amy 6175550123',1,'booking_shop:created',${randomUUID()})`);
  await flushSms(tenant);
  const [row]=await withTenant(tenant,tx=>tx`select status,last_error from sms_outbox where id=${id}`);
  expect(row).toMatchObject({status:'suppressed',last_error:'opted_out'});
  expect(provider.sendSms).not.toHaveBeenCalledWith(expect.objectContaining({to:phone}));
 } finally {await setSmsConsent(phone,'opted_in','START');}
});
