import postgres from 'postgres';
/** Isolated integration-fixture clock boundary. Not exported from the runtime package. */
export async function expireStageDepositRequest(orderId:string){
 const target=new URL(process.env.TEST_MIGRATION_DATABASE_URL??'');
 if(process.env.NODE_ENV!=='test'||process.env.DATABASE_TEST_TARGET!=='isolated'||process.env.GF_QA_ALLOW_RESET!=='1'
  ||!['localhost','127.0.0.1'].includes(target.hostname)||target.port!=='58332'||target.pathname!=='/gf_commerce_stage_ci'||target.username!=='postgres')
  throw new Error('Disposable commerce-stage clock fixture only');
 const admin=postgres(target.href,{max:1});
 try{await admin.begin(async sql=>{
  // Only this synthetic deadline is changed. Normal app_user requests still exercise every production guard.
  await sql`set local session_replication_role='replica'`;
  await sql`update commerce_deposit_requests set expires_at=clock_timestamp()-interval '1 second' where order_id=${orderId}`;
 });}finally{await admin.end();}
}
