alter table customer_paid_memberships add column manage_access_version integer not null default 1 check(manage_access_version>0);
-- Only an already verified paid invoice extends the private link; explicit revocation always wins.
create function gf_membership_extend_access() returns trigger language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
 update customer_paid_memberships set manage_token_expires_at=greatest(manage_token_expires_at,new.period_end+interval '30 days')
 where id=new.membership_id and org_id=new.org_id and location_id=new.location_id and manage_token_revoked_at is null;
 return new;
end $$;
revoke all on function gf_membership_extend_access() from public,anon,authenticated;
grant execute on function gf_membership_extend_access() to app_user;
create trigger membership_extend_access after insert on customer_membership_invoices for each row execute function gf_membership_extend_access();
update customer_paid_memberships m set manage_token_expires_at=greatest(m.manage_token_expires_at,i.covered_until+interval '30 days')
 from(select membership_id,max(period_end) as covered_until from customer_membership_invoices group by membership_id)i
 where i.membership_id=m.id and m.manage_token_revoked_at is null;
create function gf_membership_access_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public,pg_temp as $$
begin
 if new.manage_token_hash is distinct from old.manage_token_hash or new.manage_token_revoked_at is distinct from old.manage_token_revoked_at then
  if new.manage_access_version<>old.manage_access_version+1 or
   (old.manage_token_revoked_at is not null and new.manage_token_revoked_at is null and new.manage_token_hash=old.manage_token_hash) or
   (new.manage_token_hash<>old.manage_token_hash and new.manage_token_wrapped=old.manage_token_wrapped) then
   raise exception using errcode='23001',message='membership access changes require a new revision and replacement credential';
  end if;
 elsif new.manage_access_version<>old.manage_access_version then
  raise exception using errcode='23001',message='membership access revision requires a credential change';
 end if;
 return new;
end $$;
revoke all on function gf_membership_access_guard() from public,anon,authenticated;
grant execute on function gf_membership_access_guard() to app_user;
create trigger membership_access_guard before update on customer_paid_memberships for each row execute function gf_membership_access_guard();
