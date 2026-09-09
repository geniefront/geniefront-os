-- 0119 · U01/S3 新门店功能默认值
--
-- 只影响迁移后新建的门店。旧店缺字段有兼容含义（沿用已发布健康表与
-- 既有电话线路状态），因此绝不能在这里批量回填 false。

create or replace function location_feature_defaults_before_insert()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  existing_features jsonb;
begin
  new.settings := coalesce(new.settings, '{}'::jsonb);
  existing_features := case
    when jsonb_typeof(new.settings -> 'features') = 'object'
      then new.settings -> 'features'
    else '{}'::jsonb
  end;
  new.settings := jsonb_set(
    new.settings,
    '{features}',
    jsonb_build_object(
      'health_forms_enabled', false,
      'ai_voice_requested', false
    ) || existing_features,
    true
  );
  return new;
end
$$;

revoke all on function location_feature_defaults_before_insert() from public;

drop trigger if exists locations_feature_defaults_before_insert on locations;
create trigger locations_feature_defaults_before_insert
  before insert on locations
  for each row execute function location_feature_defaults_before_insert();

comment on function location_feature_defaults_before_insert() is
  'U01: initialize explicit feature choices for new locations; explicit insert values win.';
