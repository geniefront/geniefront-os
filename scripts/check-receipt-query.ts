// Execute the real receipt query against an existing isolated test DB, read-only.
// Run: pnpm exec tsx --env-file=.env scripts/check-receipt-query.ts
if (process.env.DATABASE_TEST_TARGET !== 'isolated' || !process.env.TEST_DATABASE_URL || !process.env.TEST_MIGRATION_DATABASE_URL) {
  throw new Error('An isolated test database is required. No database was touched.');
}
if (process.env.TEST_DATABASE_URL === process.env.DATABASE_URL || process.env.TEST_MIGRATION_DATABASE_URL === process.env.MIGRATION_DATABASE_URL) {
  throw new Error('Test database must differ from the application database.');
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.DB_POOL_MAX = '1';
const {default:postgres} = await import('../apps/api/node_modules/postgres/src/index.js');
const admin = postgres(process.env.TEST_MIGRATION_DATABASE_URL, {max:1,connect_timeout:5});
const {sql,withTenant} = await import('../packages/db/src/client');
try {
  const [ticket] = await admin.begin('read only', async tx => tx<{id:string;org_id:string;location_id:string}[]>`select id,org_id,location_id from tickets order by opened_at desc limit 1`);
  if (!ticket) throw new Error('No existing test ticket is available. No seed/reset was run.');
  await sql`set default_transaction_read_only = on`;
  const {loadReceipt} = await import('../apps/api/src/queries/receipt');
  const context = {orgId:ticket.org_id,locationId:ticket.location_id,membershipId:null,userId:null,locale:'en',timezone:'America/New_York',actorKind:'user',permissions:new Set(['ticket.read'])};
  const result = await withTenant(context,tx=>loadReceipt(tx,context as never,ticket.id));
  if (result.order.ticketId !== ticket.id || !result.store.timezone) throw new Error('Receipt identity mismatch');
  if (new Set(result.order.items.map(item=>item.itemId)).size !== result.order.items.length) throw new Error('Duplicate line items');
  await withTenant({...context,locationId:'00000000-0000-4000-8000-000000000000'}, async tx => {
    try { await loadReceipt(tx,{...context,locationId:'00000000-0000-4000-8000-000000000000'} as never,ticket.id); throw new Error('Tenant isolation failed'); }
    catch(error) { if ((error as {code?:string}).code !== 'NOT_FOUND') throw error; }
  });
  console.log(`PASS real isolated read-only receipt query (${result.order.items.length} distinct items)`);
} finally { await sql.end(); await admin.end(); }
