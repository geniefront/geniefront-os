-- Compact ranges identify purchased units without one row per session.
-- Projection for old assets preserves quantity only; it does not claim historical unit provenance.
alter table customer_packages add column available_units int4multirange not null default '{}';
alter table customer_package_ledger add column unit_ranges int4multirange;
alter table commerce_refunds add column reserved_unit_ranges int4multirange;
update customer_packages set available_units=int4multirange(int4range(total_sessions-remaining_sessions+reserved_sessions,total_sessions,'[)'))
 where total_sessions>0 and remaining_sessions>=reserved_sessions and total_sessions>=remaining_sessions;
-- Since purchase refunds freeze the whole finite package, at most one pending reservation owns its allocated prefix.
update commerce_refunds r set reserved_unit_ranges=int4multirange(int4range(cp.total_sessions-cp.remaining_sessions,cp.total_sessions-cp.remaining_sessions+r.asset_quantity,'[)'))
 from commerce_payments p join commerce_orders o on o.id=p.order_id join customer_packages cp on cp.id=o.asset_id
 where r.payment_id=p.id and o.kind='package' and r.status='pending' and cp.total_sessions>0
   and r.asset_quantity>0 and r.asset_quantity=cp.reserved_sessions;
