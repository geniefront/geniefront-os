-- Derived health content has the same encryption and tenant protection as answers.
alter table form_submissions add column if not exists ai_summary_encrypted bytea;
create or replace function clear_form_summary_on_erasure() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.anonymized_at is not null or new.answers_encrypted is null
     or new.answers_encrypted is distinct from old.answers_encrypted then
    new.ai_summary_encrypted := null;
  end if;
  return new;
end $$;
drop trigger if exists clear_form_summary_on_erasure on form_submissions;
create trigger clear_form_summary_on_erasure before update on form_submissions
for each row execute function clear_form_summary_on_erasure();
