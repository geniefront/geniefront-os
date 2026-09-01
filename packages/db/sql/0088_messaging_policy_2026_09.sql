-- ════════════════════════════════════════════════════════════════════════════
--  0088 · 外发消息范围收窄（2026-09-01 店主定）
--
--  ## 这一批要落实的四条决定
--
--  1. **顾客侧只发四样**：预约确认、预约修改、预约取消、次日提醒。
--     其余（营销四类、技师侧、前台手打）在门店自己的 10DLC 获批之前
--     一律不发 —— 判定在 `apps/api/src/sms/gate.ts`，本迁移不涉及。
--  2. **营销邮件需要门店专属发件域名**，在 Resend 完成验证之前不发。
--     发件地址存 `locations.marketing_email_from`（例如
--     `oasisspa@mkt.geniefront.com`）；为空即视为未就绪。
--  3. **消费小票的短信与邮件取消**，只保留打印。
--  4. **预约类邮件抄送店家一份**，默认开，可在设置里关。
--
--  ## 为什么用列而不是塞进 settings jsonb
--
--  这两项都会被**发信路径**在每一封信之前读到，且都是布尔 / 短文本的
--  硬开关。放进 jsonb 意味着每一处读取都要解析、判空、再收敛类型，而
--  「解析失败时按什么处理」这个问题会在每一处各回答一次。
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. 营销邮件的门店专属发件地址 ─────────────────────────────────────────
alter table locations
  add column if not exists marketing_email_from text;

comment on column locations.marketing_email_from is
  '营销邮件的发件地址，须是 Resend 中已完成域名验证的地址'
  '（如 oasisspa@mkt.geniefront.com）。'
  '⚠️ 为空 = 未就绪，营销邮件一律不发（0088）。'
  '事务性邮件不走这一列，用平台的 FROM_EMAIL。';

/*
 * ⚠️ 约束只做最基本的形状校验。
 *
 * 「这个地址在 Resend 那边验过没有」数据库无从判断，真正的答案只有发一次
 * 才知道；这里挡住的是明显填错的值（写成域名、写成一句话）。
 */
alter table locations
  drop constraint if exists locations_marketing_email_from_shape;
alter table locations
  add constraint locations_marketing_email_from_shape
  check (marketing_email_from is null
         or marketing_email_from ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$');

-- ── 1b. 发件箱记住这一封从哪个地址发出 ────────────────────────────────────
--
-- 事务性邮件走平台的 `FROM_EMAIL`，营销邮件走门店自己的地址。与退订地址
-- 同一条纪律（0086）：发件人属于「那封信本身」的一部分，在入队那一刻定下，
-- 投递时不再重新决定 —— 否则店主在两者之间改了配置，发出去的信与
-- 发件箱里记录的那一封对不上。
alter table email_outbox
  add column if not exists from_email text;

comment on column email_outbox.from_email is
  '这一封的发件地址。null = 用平台默认的 FROM_EMAIL（事务性邮件）。'
  '营销邮件写门店的 marketing_email_from（0088）。';

-- ── 2. 预约类邮件抄送店家 ─────────────────────────────────────────────────
alter table locations
  add column if not exists appointment_email_copy_to_shop boolean not null default true;

comment on column locations.appointment_email_copy_to_shop is
  '预约确认 / 改期 / 取消 / 提醒的邮件是否抄送门店自己一份。默认开。'
  '⚠️ 抄送地址取 locations.email；该列为空时不抄送，也不报错（0088）。';

-- ── 3. 次日提醒的取件函数 ─────────────────────────────────────────────────
--
-- ## 为什么必须是 SECURITY DEFINER
--
-- 提醒是**跨租户的定时扫描**：要在一次运行里看到所有门店明天的预约。
-- 而 `apps/` 拿不到能看见所有租户的连接（宪法第 5 条，CI 会拦）。
-- 与 `gf_purge_command_idempotency`（0078）同一个套路：开一个极窄的口子，
-- 它只返回「哪些预约该提醒了」，调用方拿到之后仍要按门店 `withTenant`
-- 进去才写得动 outbox。
--
-- ## 判定口径
--
--   · **门店本地日期 = 明天**（不是「24 小时后」）。店主说的是「明天的
--     预约提醒」，而顾客理解的「明天」是日历上的明天，与此刻差几小时无关；
--   · 门店本地时间已过 `p_send_hour`（默认 18 点）才发。整天平摊的话，
--     凌晨两点会给客人发短信；
--   · 已经排过提醒的**不再返回**。去重本可以只靠 outbox 的唯一索引，
--     但那样每小时都会为同一批预约白跑一遍事务。
create or replace function gf_appointments_due_for_reminder(
  p_send_hour integer default 18,
  p_limit integer default 200
) returns table (
  org_id uuid,
  location_id uuid,
  appointment_id uuid
)
language sql security definer set search_path = public
as $$
  select a.org_id, a.location_id, a.id
  from appointments a
  join locations l on l.id = a.location_id
  where a.status = 'booked'
    and l.status <> 'archived'
    -- 门店本地日期意义上的「明天」
    and (a.starts_at at time zone l.timezone)::date
        = ((now() at time zone l.timezone)::date + 1)
    -- 本地时间过了发送时点才发
    and extract(hour from (now() at time zone l.timezone)) >= p_send_hour
    -- 这一单还没排过提醒（两个发件箱任一有记录都算排过）
    and not exists (
      select 1 from sms_outbox o
       where o.entity_type = 'appointment' and o.entity_id = a.id
         and o.kind = 'appointment_reminder')
    and not exists (
      select 1 from email_outbox o
       where o.entity_type = 'appointment' and o.entity_id = a.id
         and o.kind = 'appointment_reminder')
  order by a.starts_at
  limit p_limit
$$;

revoke all on function public.gf_appointments_due_for_reminder(integer, integer)
  from public, anon, authenticated;
grant execute on function public.gf_appointments_due_for_reminder(integer, integer) to app_user;

comment on function public.gf_appointments_due_for_reminder(integer, integer) is
  '返回门店本地时间「明天」且尚未排过提醒的预约。跨租户只读，'
  '调用方仍须按门店进 withTenant 才写得动发件箱。'
  '⚠️ 只有 app_user 可执行，不对 anon 开放（0088，参照 0083）。';
