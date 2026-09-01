-- ════════════════════════════════════════════════════════════════════════════
--  0086 · 通知模板默认值、营销邮件退订、发件箱退订地址
--
--  ## 1. 为什么要种默认模板
--
--  0044 建了 `notification_templates`，但**没有任何种子数据**。表现是：
--  店主在通知设置页把某个事件的渠道打开之后，`notify/dispatch.ts` 在
--  `if (!tpl) continue` 处静默跳过 —— 开关是开的，界面上没有任何提示，
--  而顾客一条通知也收不到。这类故障没有报错、没有日志，只能由顾客投诉
--  「改期了怎么没通知我」反向发现。
--
--  规则（`notification_rules`）**仍然默认关闭**，这一条不变：装上本版本
--  的那一刻不应有任何门店突然开始给顾客发短信。本迁移只保证「打开开关
--  即可用」。
--
--  ## 2. 语言一律 en
--
--  面向顾客的邮件与短信恒为英语（`apps/api/src/email/render.ts` 文件头）。
--  因此只种 `locale = 'en'` 一份。店主仍可自行新增其他语言的模板，
--  但顾客侧的取模板逻辑固定传 `'en'`。
--
--  ## 3. 短信模板的字符预算
--
--  每条短信在入队时会被 `withComplianceFooter()` 前后各加一段固定文本
--  （`GenieFront: ` 12 字符 + ` Reply STOP to opt out.` 23 字符 = 35）。
--  余下的 125 字符要装得下最坏情况的变量：
--
--    {{shop_name}}    30   「Golden Lotus Nails and Day Spa」
--    {{service_name}} 31   「Deluxe Spa Pedicure with Callus」
--    {{when}}         19   「Wed Aug 26, 12:30 PM」
--    {{shop_phone}}   14   「(617) 555-0142」
--
--  ⚠️ 超出 160 的后果不是报错，而是**每一条都变成两段**：顾客看到的完全
--  一样，账单翻倍，且只会在月底的数字里显现。因此默认模板的措辞抠到了
--  这个程度（例如提醒短信刻意不带项目名）。店主自行改写时不受此约束，
--  但计费按段记录（`sms/segments.ts`）。
--
--  ## 4. 短信模板不含署名与退订说明
--
--  `GenieFront:` 前缀与 `Reply STOP to opt out.` 由 `sms/render.ts` 的
--  `withComplianceFooter()` 在入队时统一补齐。**刻意不写进模板** ——
--  写进模板意味着店主可以把它删掉，而这两项是合规要求，不能交给编辑框。
--
--  ## 5. 营销邮件退订
--
--  `birthday` / `holiday` / `winback` / `review_request` 属商业性邮件，
--  CAN-SPAM 要求提供可用的退订方式。`gf_email_unsubscribe()` 供公开退订
--  端点调用：它是 SECURITY DEFINER，因为调用方只持有一个退订令牌，
--  既没有会话也没有租户上下文。
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. 发件箱记住这一封的退订地址 ──────────────────────────────────────────
--
-- 渲染发生在入队那一刻（0029 的设计），退订地址同属「那封信本身」的一部分：
-- 投递时再拼一次会让令牌多经手一遍，而它只应被拼一次。
alter table email_outbox
  add column if not exists unsubscribe_url text;

comment on column email_outbox.unsubscribe_url is
  '营销邮件的一键退订地址（RFC 8058）。非营销邮件为 null。'
  '投递时写进 List-Unsubscribe 头（apps/api/src/email/flush.ts）。';

-- ── 1b. 营销短信的静默时段标记 ─────────────────────────────────────────────
--
-- TCPA 限制商业性短信只能在收件人当地 08:00–21:00 之间发送。事务性短信
-- （顾客本人刚下的单的确认）不受此限，也**不应**受限 —— 晚上十点订的单
-- 拖到次日早八点才确认，等于确认没有发生。
--
-- ⚠️ 用布尔标记而不是预先算好的时间戳：时区与夏令时在入队与投递之间可能
-- 变化，把判定留到投递那一刻才是准确的（`apps/api/src/sms/flush.ts`）。
--
-- ⚠️ 也不能靠 `kind` 区分 —— `outboxKind()` 把 12 个通知事件压进 4 个 kind
-- 值（0029 的 check 白名单），营销事件在 outbox 里与改期通知同名。
alter table sms_outbox
  add column if not exists quiet_hours boolean not null default false;

comment on column sms_outbox.quiet_hours is
  'true = 商业性短信，只能在门店时区的 08:00–21:00 之间投递（TCPA）。'
  '事务性短信为 false，任何时刻均可投递（0086）。';

-- ── 2. 公开退订 ────────────────────────────────────────────────────────────
create or replace function gf_email_unsubscribe(
  p_customer_id uuid, p_org_id uuid
) returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  n integer;
begin
  /*
   * ⚠️ 顾客 id 与 org id 必须同时匹配。
   *
   * 令牌里两者都编码了，缺一不可 —— 只按 customer_id 更新意味着任何人
   * 猜中一个 uuid 就能改到别的组织的数据。多这一个 where 条件即可杜绝。
   *
   * ⚠️ 退订是 **org 维度**：`customers` 表本身是 org 维度的（一位顾客在
   * 同一个老板的三家店里是同一行），因此退订一次即对该组织全部门店生效。
   */
  update customers
     set marketing_email_opt_in = false
   where id = p_customer_id
     and org_id = p_org_id
     and marketing_email_opt_in = true;

  get diagnostics n = row_count;
  -- 已经退订过时同样返回 true：对收件人而言结果一致，不应报错
  return n > 0 or exists (
    select 1 from customers
     where id = p_customer_id and org_id = p_org_id
  );
end $$;

revoke all on function public.gf_email_unsubscribe(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.gf_email_unsubscribe(uuid, uuid) to app_user;

comment on function public.gf_email_unsubscribe(uuid, uuid) is
  '营销邮件退订。调用方只持有一个 HMAC 令牌，没有会话与租户上下文，'
  '故为 SECURITY DEFINER。⚠️ 顾客 id 与 org id 必须同时匹配（0086）。';

-- ── 3. 默认通知模板 ────────────────────────────────────────────────────────
create or replace function gf_seed_notification_templates(
  p_org_id uuid, p_location_id uuid
) returns integer
language plpgsql security definer set search_path = public
as $$
declare
  n integer := 0;
begin
  insert into notification_templates
    (org_id, location_id, event_key, channel, locale, version, subject, body, active)
  select p_org_id, p_location_id, t.event_key, t.channel, 'en', 1, t.subject, t.body, true
  from (values
    -- ══ 顾客侧 ══════════════════════════════════════════════════════════
    ('appointment_confirm', 'email',
     'Appointment confirmed · {{when}} · {{shop_name}}',
     E'Hi {{customer_name}},\n\nYour appointment at {{shop_name}} is confirmed.\n\n  Service: {{service_name}}\n  Time: {{when}}\n  Specialist: {{staff_name}}\n\nTo reschedule or cancel, please call {{shop_phone}}.\n\n— {{shop_name}}'),
    ('appointment_confirm', 'sms', null,
     'Booked: {{service_name}} at {{shop_name}}, {{when}}. Changes: {{shop_phone}}.'),

    ('appointment_changed', 'email',
     'Appointment updated · {{when}} · {{shop_name}}',
     E'Hi {{customer_name}},\n\nYour appointment at {{shop_name}} has been moved from {{old_when}} to {{when}}.\n\n  Service: {{service_name}}\n  Specialist: {{staff_name}}\n\nIf this does not work for you, please call {{shop_phone}}.\n\n— {{shop_name}}'),
    ('appointment_changed', 'sms', null,
     'Your appointment at {{shop_name}} moved to {{when}}. Questions? Call {{shop_phone}}.'),

    ('appointment_cancelled', 'email',
     'Appointment cancelled · {{shop_name}}',
     E'Hi {{customer_name}},\n\nYour {{service_name}} appointment at {{shop_name}} on {{when}} has been cancelled.\n\nTo book again, please call {{shop_phone}}.\n\n— {{shop_name}}'),
    ('appointment_cancelled', 'sms', null,
     'Cancelled: {{shop_name}}, {{when}}. Call {{shop_phone}} to rebook.'),

    ('appointment_reminder', 'email',
     'Reminder: your appointment at {{shop_name}}',
     E'Hi {{customer_name}},\n\nThis is a reminder of your upcoming appointment.\n\n  Service: {{service_name}}\n  Time: {{when}}\n  Specialist: {{staff_name}}\n\nTo reschedule or cancel, please call {{shop_phone}}.\n\n— {{shop_name}}'),
    -- ⚠️ 提醒短信刻意不带项目名：店名 + 时间 + 电话已足够，
    --    带上之后长店名 + 长项目名的组合会超出一段（见本节末尾的字符预算）
    ('appointment_reminder', 'sms', null,
     'Reminder: {{shop_name}}, {{when}}. Changes: {{shop_phone}}.'),

    -- ══ 技师侧 ══════════════════════════════════════════════════════════
    -- ⚠️ 只种短信：`notifyAppointmentChange` 的技师侧 `toEmail` 恒为 null，
    --    邮件模板种了也不会被取用（notify/dispatch.ts）。
    ('staff_pending_confirm', 'sms', null,
     'New: {{customer_name}}, {{when}}. Confirm: {{confirm_url}}'),
    ('staff_assigned', 'sms', null,
     'Assigned: {{customer_name}} - {{service_name}}, {{when}}.'),
    ('staff_changed', 'sms', null,
     'Moved: {{customer_name}}, {{old_when}} to {{when}}.'),
    ('staff_cancelled', 'sms', null,
     'Cancelled: {{customer_name}} - {{service_name}}, {{when}}.'),

    -- ══ 营销侧 ══════════════════════════════════════════════════════════
    ('birthday', 'email',
     'Happy birthday from {{shop_name}}',
     E'Hi {{customer_name}},\n\nHappy birthday from all of us at {{shop_name}}!\n\nCall {{shop_phone}} to book your birthday treat.\n\n— {{shop_name}}'),
    ('birthday', 'sms', null,
     'Happy birthday from {{shop_name}}! Call {{shop_phone}} to book your treat.'),

    ('holiday', 'email',
     '{{holiday_name}} from {{shop_name}}',
     E'Hi {{customer_name}},\n\nWishing you a wonderful {{holiday_name}} from {{shop_name}}.\n\nCall {{shop_phone}} to book.\n\n— {{shop_name}}'),
    ('holiday', 'sms', null,
     '{{holiday_name}} greetings from {{shop_name}}! Call {{shop_phone}} to book.'),

    ('winback', 'email',
     'We miss you at {{shop_name}}',
     E'Hi {{customer_name}},\n\nIt has been {{days_since}} days since your last visit to {{shop_name}}.\n\nCall {{shop_phone}} to book your next appointment.\n\n— {{shop_name}}'),
    ('winback', 'sms', null,
     'We miss you at {{shop_name}} - it has been {{days_since}} days. Call {{shop_phone}}.'),

    ('review_request', 'email',
     'How did we do? · {{shop_name}}',
     E'Hi {{customer_name}},\n\nThank you for visiting {{shop_name}}. Would you take a moment to tell us how we did?\n\n  {{review_url}}\n\n— {{shop_name}}'),
    ('review_request', 'sms', null,
     'Thanks for visiting {{shop_name}}! Mind leaving a quick review? {{review_url}}')
  ) as t(event_key, channel, subject, body)
  -- 已经有这个事件 × 渠道 × 语言的模板就不动：店主自己写过的一律优先
  where not exists (
    select 1 from notification_templates x
     where x.location_id = p_location_id
       and x.event_key = t.event_key
       and x.channel = t.channel
       and x.locale = 'en'
  );

  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.gf_seed_notification_templates(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.gf_seed_notification_templates(uuid, uuid) to app_user;

comment on function public.gf_seed_notification_templates(uuid, uuid) is
  '为一家门店种一套英语默认通知模板。已存在的同键模板不覆盖。'
  '⚠️ 通知规则仍默认关闭 —— 本函数只保证「打开开关即可用」（0086）。';

-- ── 3b. 删门店时一并删掉模板与规则 ─────────────────────────────────────────
--
-- 0044 建的两条外键没有 `on delete cascade`。此前这不成问题：那两张表在
-- 店主动手配置之前是空的。种了默认模板之后，**每一家门店天生就带着一批
-- 引用它的行**，于是删门店会被外键挡住。
--
-- ⚠️ 这不是「为了让测试通过」而放宽约束：一家门店的通知模板与规则是它的
-- 附属数据，门店不存在时它们没有任何意义，级联删除才是正确语义。
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'notification_templates'::regclass and contype = 'f'
       and confrelid = 'locations'::regclass
  loop
    execute format('alter table notification_templates drop constraint %I', c);
  end loop;

  for c in
    select conname from pg_constraint
     where conrelid = 'notification_rules'::regclass and contype = 'f'
       and confrelid = 'locations'::regclass
  loop
    execute format('alter table notification_rules drop constraint %I', c);
  end loop;
end $$;

alter table notification_templates
  add constraint notification_templates_location_id_fkey
  foreign key (location_id) references locations(id) on delete cascade;

alter table notification_rules
  add constraint notification_rules_location_id_fkey
  foreign key (location_id) references locations(id) on delete cascade;

-- ── 4. 建店时自动种 ───────────────────────────────────────────────────────
--
-- 挂触发器而不是写在 `location.create` 处理器里：第一家门店由
-- `gf_provision_tenant()`（sql/0030）在数据库内创建，处理器那条路径根本
-- 覆盖不到。挂在表上则两条路径都覆盖。
create or replace function gf_locations_seed_notifications() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform gf_seed_notification_templates(new.org_id, new.id);
  return new;
end $$;

drop trigger if exists locations_seed_notifications on locations;
create trigger locations_seed_notifications
  after insert on locations
  for each row execute function gf_locations_seed_notifications();

-- ── 5. 回填存量门店 ───────────────────────────────────────────────────────
do $$
declare r record;
begin
  for r in select id, org_id from locations loop
    perform gf_seed_notification_templates(r.org_id, r.id);
  end loop;
end $$;
