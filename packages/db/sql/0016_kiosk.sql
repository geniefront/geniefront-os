-- ════════════════════════════════════════════════════════════════════════════
--  0016 · Phase 2：Kiosk 门口端（走单队列 + 健康表 / 同意书）
--
--  这一份里最要紧的两件事：
--    1. **设备令牌维度的解析策略** —— 门口 iPad 打进来时不知道 org_id，
--       但这不需要绕过 RLS（同 identity_self / phone_line_lookup 的思路）
--    2. **健康表不可删除、读要留痕** —— 它是出事时的唯一证据（00 §2）
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. 常规租户隔离 ────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'walkin_queue','form_templates','form_submissions','form_access_log'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force  row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format($f$
      create policy tenant_isolation on %I
        using (org_id = app_org_id()) with check (org_id = app_org_id())
    $f$, t);
  end loop;
end $$;

grant select, insert, update, delete on
  walkin_queue, form_templates, form_submissions, form_access_log to app_user;

-- ── 2. ⭐ 设备令牌维度解析 ─────────────────────────────────────────────────
--
-- 和 0015 的号码解析一模一样的道理：门口 iPad 只带得出一个令牌摘要，
-- 带不出 org_id。**缺的是上下文，不是权限**。
--
-- 策略只放行摘要**恰好相等**的那一行：
--   · 只 for select
--   · 必须先说出完整的 SHA-256 摘要才查得到 —— 枚举不出设备表
--   · 查到的只有一行
--
-- ⚠️ 正常租户上下文下 app.device_token_hash 是空的，
-- `token_hash = null` 恒为 null（不是 true），所以这条策略在日常路径上等于不存在。
create or replace function app_device_token_hash() returns text
language sql stable as $$
  select nullif(current_setting('app.device_token_hash', true), '')
$$;

drop policy if exists device_token_lookup on device_tokens;
create policy device_token_lookup on device_tokens
  for select
  using (token_hash = app_device_token_hash());

-- last_seen_at 要能写：老板在设置里看「这台 iPad 还在不在用」，
-- 那是决定要不要吊销的唯一依据。只允许改这一列之外的事仍然被 tenant_isolation 挡着
drop policy if exists device_token_touch on device_tokens;
create policy device_token_touch on device_tokens
  for update
  using (token_hash = app_device_token_hash())
  with check (token_hash = app_device_token_hash());

-- 令牌解析要顺带取门店时区和 org 默认语言
drop policy if exists location_by_device on locations;
create policy location_by_device on locations
  for select
  using (exists (
    select 1 from device_tokens d
    where d.location_id = locations.id and d.token_hash = app_device_token_hash()));

drop policy if exists org_by_device on organizations;
create policy org_by_device on organizations
  for select
  using (exists (
    select 1 from device_tokens d
    where d.org_id = organizations.id and d.token_hash = app_device_token_hash()));

-- ── 3. 健康表：不删除，读留痕（宪法第 9 条 / 02 §5）────────────────────────
--
-- 客人要求删除时走**匿名化**：抹掉答案与签名，保留「签过、什么时候、第几版」。
-- 整行删掉的话，出事时我们既拿不出内容、也证明不了他签过 —— 两头落空。
revoke delete on form_submissions, form_access_log from app_user;

create or replace function health_no_delete() returns trigger
language plpgsql as $$
begin
  if current_user = 'app_user' then
    raise exception '健康表记录不可删除，只能匿名化（anonymized_at）'
      using errcode = 'restrict_violation';
  end if;
  return old;
end $$;

do $$
declare t text;
begin
  foreach t in array array['form_submissions','form_access_log'] loop
    execute format('drop trigger if exists %I_no_delete on %I', t, t);
    execute format(
      'create trigger %I_no_delete before delete on %I
         for each row execute function health_no_delete()', t, t);
  end loop;
end $$;

-- 已发布的模板不可改内容 —— submissions 指着「他当时签的第几版」。
-- 就地改的话，出事时拿不出他签的到底是什么，而那是这张表的全部意义。
create or replace function form_template_frozen() returns trigger
language plpgsql as $$
begin
  if old.published_at is not null and current_user = 'app_user'
     and (new.title is distinct from old.title
          or new.schema is distinct from old.schema
          or new.requires_signature is distinct from old.requires_signature) then
    raise exception '这一版模板已经发布，内容不能再改 —— 请发一个新版本'
      using errcode = 'restrict_violation';
  end if;
  return new;
end $$;

drop trigger if exists form_templates_frozen on form_templates;
create trigger form_templates_frozen
  before update on form_templates
  for each row execute function form_template_frozen();

-- ── 4. 值域约束 ────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'walkin_queue_status') then
    alter table walkin_queue add constraint walkin_queue_status
      check (status in ('waiting','called','seated','left'));
  end if;

  -- 走了必须有原因：「等太久走的」和「说了一声先去吃饭」是两回事，
  -- 而前者直接对应流失，是老板最该看到的数
  if not exists (select 1 from pg_constraint where conname = 'walkin_queue_left_reason') then
    alter table walkin_queue add constraint walkin_queue_left_reason
      check (status <> 'left' or left_reason is not null);
  end if;

  -- 一条队列记录至少要认得出是谁：有客户 id、或者有个名字、或者挂着预约
  if not exists (select 1 from pg_constraint where conname = 'walkin_queue_identifiable') then
    alter table walkin_queue add constraint walkin_queue_identifiable
      check (customer_id is not null or walk_in_name is not null or appointment_id is not null);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'form_submissions_signer') then
    alter table form_submissions add constraint form_submissions_signer
      check (signer_relation in ('self','guardian'));
  end if;
end $$;

-- ── 5. 签名图片的私有桶 ────────────────────────────────────────────────────
--
-- 和价目表那个桶（0014）同一个模式：浏览器直传、授权走 Storage 自己的 RLS、
-- API 侧一行 Storage 代码都不写（宪法第 5 条）。
--
-- ⚠️ 但这个桶比价目表那个敏感得多 —— 里面是**客人的手写签名**。
-- 路径同样以 location_id 开头，只有该店的活跃成员能读写。
do $$
begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('signatures', 'signatures', false, 2097152, array['image/png'])
  on conflict (id) do update set
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

  execute $p$drop policy if exists signatures_rw on storage.objects$p$;
  execute $p$
    create policy signatures_rw on storage.objects
      for all to authenticated
      using (
        bucket_id = 'signatures'
        and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
        and public.user_in_location(((storage.foldername(name))[1])::uuid)
      )
      with check (
        bucket_id = 'signatures'
        and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
        and public.user_in_location(((storage.foldername(name))[1])::uuid)
      )
  $p$;

  raise notice '✓ signatures 私有桶与策略已就绪';
exception
  when insufficient_privilege or undefined_table then
    raise warning '跳过 signatures 桶（storage schema 不可写）：% —— 签名会以 data URL 存在提交记录里', sqlerrm;
end $$;
