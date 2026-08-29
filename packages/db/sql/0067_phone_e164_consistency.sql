-- 0067 · 电话号码统一为 E.164
--
-- NOT VALID 会立即约束所有新写入/更新，同时不因历史脏数据阻断部署。
-- 历史号码应通过人工确认国家码后再清洗，不能把无法判断的短号自动改错。

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'customers_phone_e164_format') then
    alter table customers add constraint customers_phone_e164_format
      check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'staff_profiles_phone_e164_format') then
    alter table staff_profiles add constraint staff_profiles_phone_e164_format
      check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'phone_lines_e164_format') then
    alter table phone_lines add constraint phone_lines_e164_format
      check (e164 ~ '^\+[1-9][0-9]{7,14}$') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'locations_phone_e164_format') then
    alter table locations add constraint locations_phone_e164_format
      check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$') not valid;
  end if;
end $$;

comment on constraint customers_phone_e164_format on customers is
  '所有渠道统一保存 E.164；历史非规范值待人工确认国家码后再 VALIDATE';
