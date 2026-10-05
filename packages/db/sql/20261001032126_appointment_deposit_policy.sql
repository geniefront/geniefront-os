-- Keep the existing scheduling rules and JSON projection; legacy deposits remain fixed amounts.
alter table location_scheduling_rules
 add column deposit_method text not null default 'fixed' check(deposit_method in('fixed','percentage')),
 add column deposit_percent_bps integer,
 add column retain_deposit_after_cutoff boolean not null default false,
 add constraint scheduling_deposit_method_fields check(
   (deposit_method='fixed' and deposit_percent_bps is null)
   or (deposit_method='percentage' and deposit_percent_bps between 1 and 10000 and deposit_amount_cents=0));
