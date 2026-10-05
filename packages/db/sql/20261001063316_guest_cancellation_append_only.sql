-- Default privileges and test bootstrap grants must not make cancellation history editable.
revoke update,delete,truncate on appointment_guest_cancellations from app_user;
create function gf_guest_cancellation_append_only() returns trigger language plpgsql as $$
begin
 if current_user='app_user' then
  raise exception using errcode='23001',message='guest cancellation history is append-only';
 end if;
 return old;
end $$;
create trigger guest_cancellation_append_only before update or delete on appointment_guest_cancellations
 for each row execute function gf_guest_cancellation_append_only();
