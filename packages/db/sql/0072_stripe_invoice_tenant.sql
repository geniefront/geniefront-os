-- ════════════════════════════════════════════════════════════════════════════
--  0072 · Stripe invoice webhook tenant lookup
--
--  Invoice events often have empty object metadata. Tenant resolution then
--  needs a signed-webhook-only lookup from a Stripe subscription/customer id
--  we previously stored on billing_accounts.
--
--  This is the same narrow SECURITY DEFINER pattern as sql/0030: the runtime
--  still connects as app_user, and the function returns at most one tenant.
--  Zero matches or more than one match → no row. Never guess.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.gf_billing_tenant_for_stripe_refs(
  p_subscription_id text,
  p_customer_id text
) returns table (org_id uuid, location_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sub_id text := nullif(trim(coalesce(p_subscription_id, '')), '');
  v_cus_id text := nullif(trim(coalesce(p_customer_id, '')), '');
  v_sub_count int := 0;
  v_cus_count int := 0;
  v_org uuid;
  v_loc uuid;
  v_row_customer text;
begin
  if v_sub_id is not null then
    select count(*) into v_sub_count
      from billing_accounts
     where stripe_subscription_id = v_sub_id;

    if v_sub_count > 1 then
      return;
    end if;

    if v_sub_count = 1 then
      select ba.org_id, ba.location_id, ba.stripe_customer_id
        into v_org, v_loc, v_row_customer
        from billing_accounts ba
       where ba.stripe_subscription_id = v_sub_id;

      if v_cus_id is not null
         and v_row_customer is not null
         and v_row_customer <> v_cus_id then
        return;
      end if;

      org_id := v_org;
      location_id := v_loc;
      return next;
      return;
    end if;
  end if;

  if v_cus_id is not null then
    select count(*) into v_cus_count
      from billing_accounts
     where stripe_customer_id = v_cus_id;

    if v_cus_count <> 1 then
      return;
    end if;

    select ba.org_id, ba.location_id
      into v_org, v_loc
      from billing_accounts ba
     where ba.stripe_customer_id = v_cus_id;

    org_id := v_org;
    location_id := v_loc;
    return next;
  end if;
end;
$$;

revoke all on function public.gf_billing_tenant_for_stripe_refs(text, text) from public;
grant execute on function public.gf_billing_tenant_for_stripe_refs(text, text) to app_user;

comment on function public.gf_billing_tenant_for_stripe_refs(text, text) is
  'Signed Stripe webhook only: map a subscription/customer id we stored to at most one tenant. Ambiguous or unknown → no row.';
