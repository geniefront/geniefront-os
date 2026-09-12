-- Preserve the preset manager's existing refund capability under its own permission.
-- Custom roles and membership-level deny overrides are intentionally untouched.
insert into role_permissions(role_id, permission)
select r.id, 'ticket.refund' from roles r
where r.is_preset and r.key = 'manager'
  and exists (select 1 from role_permissions p where p.role_id = r.id and p.permission = 'ticket.void')
on conflict do nothing;

-- Customer alias traversal and immutable-ledger balance aggregation.
create index if not exists customers_merged_into_idx on customers(merged_into_id)
  where merged_into_id is not null;
create index if not exists customer_credit_customer_kind_idx
  on customer_credit_ledger(org_id, customer_id, kind);
