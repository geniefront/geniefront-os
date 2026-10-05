/** Mirror existing local QA Auth identities into the disposable commerce DB. Never reset Auth or manual-QA data. */
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;process.env.MIGRATION_DATABASE_URL=process.env.TEST_MIGRATION_DATABASE_URL;
for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL'] as const){const url=new URL(process.env[key]!);url.pathname='/gf_commerce_ci';process.env[key]=url.href;}
assertRegressionTarget(process.env);
if(new URL(process.env.DATABASE_URL!).port!=='58332'||!['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL!).hostname))throw new Error('Dedicated commerce DB and local QA Auth are required');
const {adminSql}=await import('../packages/db/src/admin');
const orgId='22222222-2222-4222-8222-222222222222',locationId='bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
try {
  for(const [email,role] of [['qa-local-owner@example.test','owner'],['qa-local-desk@example.test','front_desk'],['qa-local-tech@example.test','tech']] as const){
    const response=await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',
      headers:{apikey:process.env.SUPABASE_ANON_KEY!,'Content-Type':'application/json'},body:JSON.stringify({email,password:process.env.GF_BASELINE_PASSWORD})});
    if(!response.ok)throw new Error(`Local QA ${role} login failed (${response.status}); no Auth changes were made`);
    const value=await response.json() as {user:{id:string};access_token:string};
    await adminSql.begin(async tx=>{
      await tx`insert into auth.users(id,email) values(${value.user.id},${email}) on conflict(id) do nothing`;
      await tx`insert into users(id,email,full_name,locale) values(${value.user.id},${email},${`Commerce QA ${role}`},'en') on conflict(id) do nothing`;
      const [r]=await tx<{id:string}[]>`select id from roles where location_id=${locationId} and key=${role}`;
      if(!r)throw new Error('Run the isolated commerce API tests to seed roles before preparing the browser fixture');
      let [m]=await tx<{id:string}[]>`select id from memberships where location_id=${locationId} and user_id=${value.user.id}`;
      if(!m)[m]=await tx<{id:string}[]>`insert into memberships(org_id,location_id,user_id,status) values(${orgId},${locationId},${value.user.id},'active') returning id`;
      await tx`insert into membership_roles(membership_id,role_id) values(${m!.id},${r.id}) on conflict do nothing`;
    });
    // Session tokens are deliberately discarded rather than persisted into screenshots or logs.
  }
  await adminSql`update commerce_accounts set charges_enabled=false,capabilities='{}'::jsonb where location_id=${locationId} and stripe_account_id='acct_CommerceFixture'`;
  console.log('Commerce browser identities prepared in dedicated DB; local Auth and business data were preserved.');
} finally {await adminSql.end();}
