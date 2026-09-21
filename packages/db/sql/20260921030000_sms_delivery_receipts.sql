alter table public.sms_outbox add column if not exists delivery_state text;
alter table public.sms_outbox add column if not exists delivery_at timestamptz;
create index if not exists sms_outbox_provider_idx on public.sms_outbox(provider_id) where provider_id is not null;
create table if not exists public.sms_delivery_receipts (
  provider_id text primary key,
  state text not null check (state in ('accepted','unconfirmed','failed','delivered')),
  occurred_at timestamptz not null,
  error text
);
alter table public.sms_delivery_receipts enable row level security;
alter table public.sms_delivery_receipts force row level security;
revoke all on public.sms_delivery_receipts from public, anon, authenticated, app_user;

-- Only the verified provider webhook calls this narrow function. Retain early receipts
-- until the sender transaction attaches its provider ID; terminal delivery never regresses.
create or replace function public.gf_record_sms_delivery(p_id text,p_state text,p_at timestamptz,p_error text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_id is null or p_id='' or length(p_id)>200 or p_state not in ('accepted','unconfirmed','failed','delivered') or p_at is null then
    raise exception 'invalid_sms_receipt';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_id, 9871));
  insert into public.sms_delivery_receipts values (p_id,p_state,p_at,left(p_error,1000))
  on conflict(provider_id) do update set state=excluded.state,occurred_at=excluded.occurred_at,error=excluded.error
  where array_position(array['accepted','unconfirmed','failed','delivered'],excluded.state)
      > array_position(array['accepted','unconfirmed','failed','delivered'],sms_delivery_receipts.state)
    or (excluded.state=sms_delivery_receipts.state and excluded.occurred_at>sms_delivery_receipts.occurred_at);
  update public.sms_outbox o set delivery_state=r.state,delivery_at=r.occurred_at,
    last_error=case when r.state='failed' then r.error else o.last_error end
    from public.sms_delivery_receipts r where o.provider_id=r.provider_id and r.provider_id=p_id;
end $$;
revoke all on function public.gf_record_sms_delivery(text,text,timestamptz,text) from public,anon,authenticated;
grant execute on function public.gf_record_sms_delivery(text,text,timestamptz,text) to app_user;

create or replace function public.gf_attach_sms_receipt() returns trigger
language plpgsql security definer set search_path='' as $$
declare receipt public.sms_delivery_receipts%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.provider_id, 9871));
  select * into receipt from public.sms_delivery_receipts where provider_id=new.provider_id;
  if found then
    new.delivery_state=receipt.state;
    new.delivery_at=receipt.occurred_at;
    if receipt.state='failed' then new.last_error=receipt.error; end if;
  end if;
  return new;
end $$;
revoke all on function public.gf_attach_sms_receipt() from public,anon,authenticated,app_user;
drop trigger if exists sms_attach_receipt on public.sms_outbox;
create trigger sms_attach_receipt before insert or update of provider_id on public.sms_outbox
for each row when(new.provider_id is not null) execute function public.gf_attach_sms_receipt();
