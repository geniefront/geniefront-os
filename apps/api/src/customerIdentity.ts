import type postgres from 'postgres';
import { AppError, ERROR_CODES } from '@gf/contracts';

/** Follow a customer merge without rewriting the immutable asset ledger. */
export async function canonicalCustomer(
  tx: postgres.TransactionSql, customerId: string, lock = false,
): Promise<string> {
  await lockCustomerIdentity(tx);
  const seen = new Set<string>();
  let id = customerId;
  while (!seen.has(id)) {
    seen.add(id);
    const [row] = await tx<{ id: string; merged_into_id: string | null }[]>`
      select id, merged_into_id from customers where id = ${id} ${lock ? tx`for update` : tx``}`;
    if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'customer' } });
    if (!row.merged_into_id) return row.id;
    id = row.merged_into_id;
  }
  throw new AppError(ERROR_CODES.VALIDATION_FAILED, { details: { reason: 'customer_merge_cycle' } });
}

/** Recursive aliases also support preexisting chains. RLS applies at every step. */
export function customerAssetIds(tx: postgres.TransactionSql, root: string) {
  return tx`(with recursive family as (
    select id from customers where id = ${root}
    union
    select c.id from customers c join family f on c.merged_into_id = f.id
  ) select id from family)`;
}

/** RLS-scoped identity families; asset/financial rows retain their original customer ids. */
export function customerFamilies(tx:postgres.TransactionSql,roots?:readonly string[]){
 return tx`(with recursive family as(
  select id,org_id,id as root_id from customers where merged_into_id is null ${roots?tx`and id=any(${[...roots]}::uuid[])`:tx``}
  union
  select c.id,c.org_id,f.root_id from customers c join family f on c.merged_into_id=f.id and c.org_id=f.org_id
 )select id,root_id from family)`;
}
/** Readers and asset writers share this lock; an explicit merge takes its exclusive counterpart. */
export async function lockCustomerIdentity(tx:postgres.TransactionSql){
 await tx`select pg_advisory_xact_lock_shared(hashtext(app_org_id()::text),hashtext('customer.merge'))`;
}
export async function canonicalCustomerMap(tx:postgres.TransactionSql,ids:readonly string[]){
 await lockCustomerIdentity(tx);if(!ids.length)return new Map<string,string>();
 const rows=await tx<{id:string;root_id:string}[]>`with recursive paths as(
  select id,org_id,id as original_id,merged_into_id,array[id] as path from customers where id=any(${[...new Set(ids)]}::uuid[])
  union all select c.id,c.org_id,p.original_id,c.merged_into_id,p.path||c.id from paths p join customers c on c.id=p.merged_into_id and c.org_id=p.org_id where not c.id=any(p.path)
 )select original_id as id,id as root_id from paths where merged_into_id is null`;
 if(rows.length!==new Set(ids).size)throw new AppError(ERROR_CODES.NOT_FOUND,{details:{entity:'customer'}});
 return new Map(rows.map(r=>[r.id,r.root_id]));
}
