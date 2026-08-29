-- 0065 · Kiosk 手写签名应用层加密

alter table form_submissions
  add column if not exists signature_encrypted bytea;

comment on column form_submissions.signature_encrypted is
  'AES-256-GCM 加密的 Kiosk 内联签名；与健康答案共用受管密钥，避免数据库备份泄露手写签名';

create or replace function health_anonymize_content() returns trigger
language plpgsql as $$
begin
  if new.anonymized_at is not null then
    new.answers_encrypted := null;
    new.signature_url := null;
    new.signature_encrypted := null;
  end if;
  return new;
end $$;

drop trigger if exists form_submissions_anonymize_content on form_submissions;
create trigger form_submissions_anonymize_content
  before insert or update on form_submissions
  for each row execute function health_anonymize_content();

update form_submissions
set signature_url = null, signature_encrypted = null
where anonymized_at is not null
  and (signature_url is not null or signature_encrypted is not null);
