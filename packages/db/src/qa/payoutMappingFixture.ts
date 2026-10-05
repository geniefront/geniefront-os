import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
/** Structural failure injection belongs to the DB QA layer, never the runtime API connection. */
export async function withPayoutMappingFixture(run:(fixture:{sharedLocationId:string;injectOtherOrgMapping:()=>Promise<void>})=>Promise<void>){
 const target=new URL(process.env.MIGRATION_DATABASE_URL??'');
 if(process.env.NODE_ENV!=='test'||process.env.DATABASE_TEST_TARGET!=='isolated'||!['localhost','127.0.0.1'].includes(target.hostname)
  ||target.port!=='58332'||target.username!=='postgres'||target.pathname!=='/gf_commerce_stage_ci')throw new Error('Payout mapping fixture requires the dedicated disposable stage database');
 const connection=postgres(target.href,{max:1,onnotice:()=>{}}),sharedLocationId=`00000000-${randomUUID().slice(9)}`;
 try{
  const [db]=await connection<{name:string}[]>`select current_database() as name`;if(db?.name!=='gf_commerce_stage_ci')throw new Error('Wrong payout QA database');
  await connection`insert into locations(id,org_id,name,slug,timezone,business_type,status)
   values(${sharedLocationId},'22222222-2222-4222-8222-222222222222','{}'::jsonb,${`payout-shared-${sharedLocationId}`},'America/Los_Angeles','foot_spa','active')`;
  await run({sharedLocationId,injectOtherOrgMapping:async()=>{
   // Deliberately malformed mapping verifies the SDK adapter rejects a cross-org account before reading funds.
   await connection`update commerce_accounts set org_id='11111111-1111-4111-8111-111111111111'::uuid where location_id=${sharedLocationId} and stripe_account_id='acct_PayoutFixture'`;
  }});
 }finally{
  try{
   await connection`delete from commerce_tasks where location_id=${sharedLocationId}`;
   await connection`delete from commerce_accounts where location_id=${sharedLocationId}`;
   await connection`delete from locations where id=${sharedLocationId}`;
  }finally{await connection.end();}
 }
}
