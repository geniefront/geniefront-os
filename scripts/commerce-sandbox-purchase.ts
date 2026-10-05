// Prepare a genuine Checkout through the running isolated API, using existing local QA Auth. No payment is simulated here.
import {writeFile} from 'node:fs/promises';
import {assertRegressionTarget} from '../packages/db/src/qa/regressionSafety';
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
process.env.MIGRATION_DATABASE_URL=process.env.TEST_MIGRATION_DATABASE_URL;
const db=new URL(process.env.DATABASE_URL??'');if(db.port!=='58332')throw new Error('Dedicated QA database required');
db.pathname='/gf_commerce_ci';process.env.DATABASE_URL=db.href;
const migration=new URL(process.env.MIGRATION_DATABASE_URL??'');migration.pathname='/gf_commerce_ci';process.env.MIGRATION_DATABASE_URL=migration.href;
assertRegressionTarget(process.env);
if(process.env.COMMERCE_STRIPE_MODE==='live'||!process.env.COMMERCE_TEST_ACCOUNT_ID)throw new Error('Existing test account required');
const {withTenant,closeDb}=await import('../packages/db/src/index');
const tenant={orgId:'22222222-2222-4222-8222-222222222222',locationId:'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'};
try{
  const auth=await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`,{method:'POST',
    headers:{apikey:process.env.SUPABASE_ANON_KEY!,'content-type':'application/json'},
    body:JSON.stringify({email:'qa-local-owner@example.test',password:process.env.GF_BASELINE_PASSWORD})});
  if(!auth.ok)throw new Error(`Local QA login failed (${auth.status})`);
  const session=await auth.json() as {access_token:string;user:{id:string}};
  const [m]=await withTenant(tenant,tx=>tx`select id from memberships where location_id=${tenant.locationId} and user_id=${session.user.id}`);
  const [account]=await withTenant(tenant,tx=>tx`select stripe_account_id,livemode,charges_enabled from commerce_accounts where location_id=${tenant.locationId} and not livemode`);
  if(!m||!account?.charges_enabled||account.livemode||account.stripe_account_id!==process.env.COMMERCE_TEST_ACCOUNT_ID)throw new Error('Ready, mapped test merchant required');
  const headers={'content-type':'application/json',authorization:`Bearer ${session.access_token}`,'x-membership-id':m.id};
  const command=async(name:string,input:unknown)=>{
    const response=await fetch(`http://127.0.0.1:3087/v1/commands/${name}`,{method:'POST',headers,
      body:JSON.stringify({input,idempotencyKey:crypto.randomUUID()})});
    const body=await response.json() as {result:Record<string,unknown>;code?:string};
    if(!response.ok)throw new Error(`QA command ${name}: ${response.status} ${body.code}`);return body.result;
  };
  await command('commerce.saveSettings',{salesEnabled:true,depositsEnabled:false,membershipsEnabled:false});
  const template=await command('giftcard.saveTemplate',{name:{en:'Stripe sandbox $80 for $100','zh-Hans':'Stripe 沙盒 80 售价 100 面值'},
    faceValueCents:10000,salePriceCents:8000,onlineSale:true});
  const response=await fetch('http://127.0.0.1:3087/v1/public/shops/golden-foot/commerce/orders',{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify({kind:'gift_card',templateId:template.templateId,businessKey:crypto.randomUUID(),
      customer:{name:'Stripe Sandbox QA Buyer',email:'stripe-sandbox-qa@example.test'},locale:'en'})});
  const order=await response.json() as {orderId:string;token:string;url:string|null;code?:string};
  if(!response.ok||!order.url)throw new Error(`Checkout creation failed (${response.status} ${order.code??'no_url'})`);
  const privatePath='/tmp/commerce-stripe-checkout-private.json';
  await writeFile(privatePath,JSON.stringify({...order,accessToken:session.access_token,membershipId:m.id}),{mode:0o600});
  console.log(JSON.stringify({created:true,orderId:order.orderId,testMode:true,amountCents:8000,privatePath}));
}finally{await closeDb();}
