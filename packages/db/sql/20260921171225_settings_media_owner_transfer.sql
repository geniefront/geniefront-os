-- Public media contains only raster images. Each authenticated user writes a unique
-- path in their own directory; there is deliberately no overwrite/delete policy.
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('store_logos','store_logos',true,5242880,array['image/jpeg','image/png','image/webp']),
       ('avatars','avatars',true,5242880,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=true,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists gf_media_insert on storage.objects;
create policy gf_media_insert on storage.objects for insert to authenticated
with check(bucket_id in ('avatars','store_logos') and (storage.foldername(name))[1]=(select auth.uid())::text
  and lower(name) ~ '\.(webp|png|jpeg)$');

-- Durable, retryable handoff. No access is granted until Stripe contact sync succeeds.
create schema if not exists gf_private;
revoke all on schema gf_private from public,anon,authenticated;
grant usage on schema gf_private to app_user;
create table if not exists gf_private.owner_transfers (
 id uuid primary key default gen_random_uuid(), location_id uuid not null references public.locations(id),
 org_id uuid not null, operator_user_id uuid not null, operation_key text not null,
 old_membership_id uuid not null, old_user_id uuid not null, new_user_id uuid not null,
 new_email text not null, reason text not null, stripe_customer_id text,
 state text not null default 'pending' check(state in ('pending','completed')),
 new_membership_id uuid, created_at timestamptz not null default now(), completed_at timestamptz,
 unique(operator_user_id,operation_key)
);
alter table gf_private.owner_transfers enable row level security;
create unique index if not exists owner_transfer_pending on gf_private.owner_transfers(location_id) where state='pending';

create or replace function gf_private.prepare_owner_transfer(p_location uuid,p_old uuid,p_email text,p_reason text,p_key text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,gf_private as $$
declare t gf_private.owner_transfers; m public.memberships; target_user uuid; target_org uuid; customer text; actor uuid;
begin
 if public.gf_platform_assert_operator()<>'super_admin' then raise exception 'requires_super_admin' using errcode='42501'; end if;
 actor:=nullif(current_setting('app.user_id',true),'')::uuid;
 p_email:=lower(btrim(p_email));
 if p_email='' or length(p_email)>320 or length(btrim(p_reason))<3 or length(p_key)>120 then raise exception 'invalid_transfer' using errcode='22023'; end if;
 select * into t from gf_private.owner_transfers where operator_user_id=actor and operation_key=p_key;
 if found then
   if t.location_id<>p_location or t.old_membership_id<>p_old or t.new_email<>p_email or t.reason<>p_reason then raise exception 'transfer_key_reused' using errcode='22023'; end if;
   return to_jsonb(t);
 end if;
 select org_id into target_org from public.locations where id=p_location for update;
 if not found then raise exception 'location_not_found' using errcode='22023'; end if;
 select * into t from gf_private.owner_transfers where location_id=p_location and operator_user_id=actor and old_membership_id=p_old and new_email=p_email and reason=p_reason order by created_at desc limit 1;
 if found then return to_jsonb(t); end if;
 select * into t from gf_private.owner_transfers where location_id=p_location and state='pending';
 if found then
   if t.operator_user_id=actor and t.old_membership_id=p_old and t.new_email=p_email and t.reason=p_reason then return to_jsonb(t); end if;
   raise exception 'transfer_pending' using errcode='22023';
 end if;
 select * into m from public.memberships where id=p_old and org_id=target_org and (location_id=p_location or location_id is null) and status='active' for update;
 if not found or m.user_id is null or not exists(select 1 from public.membership_roles mr join public.roles r on r.id=mr.role_id where mr.membership_id=p_old and r.key='owner') then raise exception 'owner_changed' using errcode='22023'; end if;
 if (select count(distinct mm.id) from public.memberships mm join public.membership_roles mr on mr.membership_id=mm.id join public.roles r on r.id=mr.role_id where mm.org_id=target_org and (mm.location_id=p_location or mm.location_id is null) and mm.status='active' and r.key='owner')<>1 then raise exception 'multiple_owners' using errcode='22023'; end if;
 if (select count(*) from public.locations where org_id=target_org)>1 then raise exception 'org_owner_requires_scoped_transfer' using errcode='22023'; end if;
 perform 1 from public.organizations where id=target_org and owner_user_id=m.user_id for update;
 if not found then raise exception 'owner_changed' using errcode='22023'; end if;
 select id into target_user from auth.users where lower(email)=p_email and email_confirmed_at is not null;
 if target_user is null then raise exception 'new_owner_must_verify_email' using errcode='22023'; end if;
 if target_user=m.user_id then raise exception 'same_owner' using errcode='22023'; end if;
 select stripe_customer_id into customer from public.billing_accounts where location_id=p_location;
 if customer is not null and exists(select 1 from public.billing_accounts where stripe_customer_id=customer and location_id<>p_location) then raise exception 'shared_stripe_customer' using errcode='22023'; end if;
 insert into gf_private.owner_transfers(location_id,org_id,operator_user_id,operation_key,old_membership_id,old_user_id,new_user_id,new_email,reason,stripe_customer_id)
 values(p_location,target_org,actor,p_key,m.id,m.user_id,target_user,p_email,p_reason,customer) returning * into t;
 return to_jsonb(t);
end $$;

create or replace function gf_private.complete_owner_transfer(p_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,gf_private as $$
declare t gf_private.owner_transfers; new_member uuid; owner_role uuid; op uuid;
begin
 if public.gf_platform_assert_operator()<>'super_admin' then raise exception 'requires_super_admin' using errcode='42501'; end if;
 select * into t from gf_private.owner_transfers where id=p_id and operator_user_id=nullif(current_setting('app.user_id',true),'')::uuid for update;
 if not found then raise exception 'transfer_not_found' using errcode='22023'; end if;
 if t.state='completed' then return to_jsonb(t); end if;
 perform 1 from public.locations where id=t.location_id for update;
 if not exists(select 1 from public.memberships where id=t.old_membership_id and user_id=t.old_user_id and status='active') or not exists(select 1 from public.membership_roles mr join public.roles r on r.id=mr.role_id where mr.membership_id=t.old_membership_id and r.key='owner') then raise exception 'owner_changed' using errcode='22023'; end if;
 if not exists(select 1 from auth.users where id=t.new_user_id and lower(email)=t.new_email and email_confirmed_at is not null) then raise exception 'new_owner_must_verify_email' using errcode='22023'; end if;
 if (select count(*) from public.locations where org_id=t.org_id)>1 then raise exception 'org_owner_requires_scoped_transfer' using errcode='22023'; end if;
 insert into public.users(id,email) values(t.new_user_id,t.new_email) on conflict(id) do update set email=excluded.email;
 update public.organizations set owner_user_id=t.new_user_id where id=t.org_id and owner_user_id=t.old_user_id;
 if not found then raise exception 'owner_changed' using errcode='22023'; end if;
 select id into owner_role from public.roles where org_id=t.org_id and key='owner' and (location_id=t.location_id or location_id is null) order by location_id nulls last limit 1;
 if owner_role is null then raise exception 'owner_role_missing' using errcode='22023'; end if;
 -- Keep historical attribution on the old memberships; revoke only this store's access.
 update public.memberships set status='left',ended_on=current_date where user_id=t.old_user_id and org_id=t.org_id and (location_id=t.location_id or location_id is null);
 update public.staff_sessions set revoked_at=now() where membership_id in(select id from public.memberships where user_id=t.old_user_id and org_id=t.org_id and (location_id=t.location_id or location_id is null)) and revoked_at is null;
 insert into public.memberships(org_id,location_id,user_id,status) values(t.org_id,t.location_id,t.new_user_id,'active') returning id into new_member;
 insert into public.membership_roles(membership_id,role_id) values(new_member,owner_role);
 update public.locations set settings=jsonb_set(settings,'{ownership_payment_review}',jsonb_build_object('required',true,'newOwnerEmail',t.new_email,'newOwnerUserId',t.new_user_id,'transferredAt',now()),true),updated_at=now() where id=t.location_id;
 select id into op from public.platform_operators where user_id=t.operator_user_id and status='active';
 insert into public.audit_log(org_id,location_id,actor_id,actor_kind,command,entity_type,entity_id,before,after)
 values(t.org_id,t.location_id,op,'platform','platform.transferOwner','location',t.location_id,
 jsonb_build_object('ownerUserId',t.old_user_id,'membershipId',t.old_membership_id),
 jsonb_build_object('ownerUserId',t.new_user_id,'membershipId',new_member,'email',t.new_email,'reason',t.reason,'paymentMethodRetained',true,'transferId',t.id));
 update gf_private.owner_transfers set state='completed',completed_at=now(),new_membership_id=new_member where id=t.id returning * into t;
 return to_jsonb(t);
end $$;
revoke all on function gf_private.prepare_owner_transfer(uuid,uuid,text,text,text) from public,anon,authenticated;
revoke all on function gf_private.complete_owner_transfer(uuid) from public,anon,authenticated;
grant execute on function gf_private.prepare_owner_transfer(uuid,uuid,text,text,text) to app_user;
grant execute on function gf_private.complete_owner_transfer(uuid) to app_user;
