import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { CommandContext } from '@gf/contracts';
vi.mock('./staff', () => ({maskPhone: (value: string | null) => value ? '***' : null}));
import { loadOrders } from './orders';
import { loadReceipt } from './receipt';
const ctx = {locationId:'location',locale:'en',permissions:new Set()} as unknown as CommandContext;
function transaction(responses: unknown[][]) {
  const queries: Array<{sql:string; values:unknown[]}> = [];
  const tx = ((strings: TemplateStringsArray | unknown[], ...values:unknown[]) => {
    if (!('raw' in strings)) return strings;
    queries.push({sql:strings.join('?'),values});
    return Promise.resolve(responses.shift() ?? []);
  }) as unknown as postgres.TransactionSql;
  return {tx,queries};
}
const ticket = {id:'ticket',business_date:'2026-09-10',opened_at:'2026-09-10T12:00:00Z',closed_at:null,status:'open'};
describe('receipt query', () => {
  it('scopes the exact receipt lookup to the active location and returns not found', async () => {
    const {tx,queries} = transaction([[]]);
    await expect(loadReceipt(tx,ctx,'missing')).rejects.toMatchObject({code:'NOT_FOUND'});
    expect(queries[0]?.sql).toContain('t.location_id =');
    expect(queries[0]?.sql).toContain('t.id =');
    expect(queries[0]?.values).toContain('location');
    expect(queries[0]?.values).toContain('missing');
  });
  it('does not duplicate a service charge for multiple staff and preserves its sold name', async () => {
    const item = {ticket_id:'ticket',id:'item',name_snapshot:'Sold massage',service_name:{en:'Renamed service'},qty:1,total_cents:10000};
    const {tx} = transaction([[ticket],[{count:'1'}],[{...item,staff_name:{en:'Alice'}},{...item,staff_name:{en:'Bob'}}],[],[]]);
    const result = await loadOrders(tx,ctx,{ticketId:'ticket'});
    expect(result.rows[0]?.items).toHaveLength(1);
    expect(result.rows[0]?.items[0]).toMatchObject({name:'Sold massage',staffName:'Alice / Bob',totalCents:10000});
  });
});
