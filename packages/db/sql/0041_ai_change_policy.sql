-- 0041 · AI 电话改期/取消 + 号码与话术可配（批 3，docs/09、docs/14）
--
-- 两块：
--   ① AI 能不能**直接**改期/取消，条件全部由老板在后台设，不写死在代码里
--   ② 每条 AI 线的助手名 / 开场白 / 是否让 AI 自己生成欢迎语
--
-- ⭐ 为什么条件要可配：一家两个技师的小店和一家二十人的店，对
-- 「AI 自作主张取消一单」的容忍度差一个数量级。写死一套四条判据，
-- 小店嫌太松、大店嫌太紧，而两边都只能来找我们改代码。

-- ── ① AI 变更策略：放在 locations.settings.ai_change 里 ────────────────────
--
-- 和 online_booking 同一个位置、同一个理由：它是一组阈值，不是实体。
-- 为四个数字建张表只会多出一处「两边不一致」的可能。
--
-- 默认值刻意保守 —— 老板没看过这一页之前，AI 只能提变更请求不能自己执行。
update locations
set settings = jsonb_set(
      settings, '{ai_change}',
      coalesce(settings->'ai_change', '{}'::jsonb) || jsonb_build_object(
        -- 总开关。**默认 false**：没配过的店，AI 一律只落复核队列
        'enabled',            coalesce(settings->'ai_change'->'enabled', 'false'::jsonb),
        -- 来电号码必须和单子上的手机号精确相等
        'require_exact_caller', coalesce(settings->'ai_change'->'require_exact_caller', 'true'::jsonb),
        -- 名下将来只有一个未开始的单时才允许直接动
        'require_single_upcoming', coalesce(settings->'ai_change'->'require_single_upcoming', 'true'::jsonb),
        -- 距开始至少多少小时。0 = 不限
        'min_hours_ahead',    coalesce(settings->'ai_change'->'min_hours_ahead', '24'::jsonb),
        -- 组单一律落队列（改一个要问另一个）
        'block_group',        coalesce(settings->'ai_change'->'block_group', 'true'::jsonb),
        -- 今天的单一律转人，哪怕满足小时数
        'block_same_day',     coalesce(settings->'ai_change'->'block_same_day', 'true'::jsonb),
        -- 分别控制：有的店愿意让 AI 改期但绝不让它取消
        'allow_reschedule',   coalesce(settings->'ai_change'->'allow_reschedule', 'true'::jsonb),
        'allow_cancel',       coalesce(settings->'ai_change'->'allow_cancel', 'false'::jsonb)
      ), true)
where settings->'ai_change' is null;

-- ── ② 每条线的话术 ────────────────────────────────────────────────────────
alter table phone_lines
  -- AI 自报家门用的名字（"This is Emily"）。空 = 不报名字
  add column if not exists assistant_name text,
  -- 开场白模板，支持 {{store_name}} / {{caller_name}} / {{assistant_name}}
  add column if not exists greeting_template text,
  -- ⭐ 让 AI 自己生成欢迎语（按门店类型、时段、是不是老客）
  add column if not exists greeting_ai_generated boolean not null default false,
  -- 这条线接不接 AI。⚠️ 和 active 不是一回事：
  -- active=false 是「这个号不再属于本店」，ai_answer=false 是
  -- 「号还在、还能反查、但今天先别让 AI 接」—— 后者是个日常开关
  add column if not exists ai_answer boolean not null default true;

comment on column phone_lines.greeting_template is
  '开场白模板。变量 {{store_name}} / {{caller_name}} / {{assistant_name}}。'
  ' 空 = 用系统默认。greeting_ai_generated=true 时这一列作为「语气参考」而不是逐字稿';
comment on column phone_lines.ai_answer is
  '这条线今天让不让 AI 接。和 active 分开：active 管归属，这个管日常开关';

-- ── ③ 复核队列要能装下「改期/取消请求」──────────────────────────────────
alter table call_drafts
  -- new | reschedule | cancel
  add column if not exists kind text not null default 'new',
  -- 改期/取消指向的那一单
  add column if not exists target_appointment_id uuid references appointments(id),
  -- AI 听到的原话（"能不能改到周六下午"）。前台复核时要看见原话
  add column if not exists requested_text text,
  -- 为什么没让 AI 直接执行 —— 前台要知道是哪一条闸拦下的
  add column if not exists gate_reason text;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'call_drafts_kind') then
    alter table call_drafts drop constraint call_drafts_kind;
  end if;
  alter table call_drafts add constraint call_drafts_kind
    check (kind in ('new', 'reschedule', 'cancel'));
end $$;

comment on column call_drafts.gate_reason is
  '没让 AI 直接执行的原因（caller_mismatch / multiple_upcoming / too_soon /'
  ' group_ticket / same_day / disabled / not_allowed）。前台要知道是哪条闸拦的';

create index if not exists call_drafts_target_idx
  on call_drafts (target_appointment_id) where target_appointment_id is not null;
