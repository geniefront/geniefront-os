-- ════════════════════════════════════════════════════════════════════════════
--  0079 · 入站短信按「本店客户」隔离（AUD-10）
--
--  ## 现状
--
--  `sms_inbound` 的策略是 `platform_wide using (true)`，
--  `grant select, insert on sms_inbound to app_user`。
--  也就是说任意租户上下文都能读到**全平台每一家店**客人发来的短信正文。
--
--  0034 里给 `sms_consent` 写的那段理由是站得住的：所有门店共用一个发送号
--  和一个 10DLC brand，客人回 STOP 是对**这个发送者**说的，按 org 存
--  opt-out 会导致「A 店退订、B 店照发」。那张表一行里除了号码没有别的东西。
--
--  但 `sms_inbound` 存的是**消息正文**，理由不能照抄。
--
--  ## 今天没漏，靠的是查询自觉
--
--  `queries/smsInbound.ts` 先在本店 `customers` 里按号码找，再拿这些号码
--  去查入站短信 —— 那段代码是对的，注释也写清楚了。
--  但隔离不该只活在一处查询的纪律里：下一个人写「客服要看所有上行短信」
--  的时候，RLS 会告诉他这是允许的。
--
--  ## 修法：insert 与 select 分开
--
--  · insert 仍然 `with check (true)` —— 入站 webhook 确实没有租户上下文，
--    `to` 是平台号，那条短信到达时还不知道属于谁
--  · select 收窄成「发件号码是本店客户的号码」—— 和查询层现在做的事一样，
--    只是挪进数据库，于是绕不过去
--
--  ⚠️ 保留的口子（认了，和 0034 同一条取舍）：同一个号码在 A、B 两店都是
--  客户时，两店都看得到他发来的短信。共享发送号这个前提下无法再细分，
--  而这已经比「所有店看所有短信」小了一个数量级。
-- ════════════════════════════════════════════════════════════════════════════

drop policy if exists platform_wide on sms_inbound;

-- 写：webhook 没有租户上下文，照旧放行。
create policy inbound_insert_platform on sms_inbound
  for insert with check (true);

-- 读：只有本店客户发来的那些。
create policy inbound_select_own_customers on sms_inbound
  for select using (
    exists (
      select 1 from customers c
      where c.org_id = app_org_id()
        and c.phone_e164 = sms_inbound.from_e164
    )
  );

comment on table sms_inbound is
  '客人发到平台号的上行短信。⚠️ 表本身是平台级的（没有 org_id），'
  '但 SELECT 被 RLS 收窄成「发件号码是本店客户」——'
  'A 店读不到 B 店客人发来的短信（sql/0079, AUD-10）。'
  'INSERT 仍然放行：入站 webhook 到达时没有租户上下文。';
