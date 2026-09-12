import type postgres from 'postgres';
import { AppError, ERROR_CODES } from '@gf/contracts';

/** Follow a customer merge without rewriting the immutable asset ledger. */
export async function canonicalCustomer(
  tx: postgres.TransactionSql, customerId: string, lock = false,
): Promise<string> {
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
