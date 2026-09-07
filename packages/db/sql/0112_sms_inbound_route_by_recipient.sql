-- ════════════════════════════════════════════════════════════════════════════
--  0112 · 入站短信按「收到它的那个号码」归属（U09 / AUD-10 续）
--
--  ## 0079 明说保留、现在要收掉的那个口子
--
--  0079 把 `sms_inbound` 的 SELECT 收成「发件号码是本店客户」，当时明确
--  认下一个代价：**同一个手机号在 A、B 两店都登记成客户时，两店都能读到
--  他发来的短信**。理由是「共享发送号这个前提下无法再细分」。
--
--  这个前提对**平台共享号**成立，对**店铺自己的号**不成立。
--  `phone_lines` 里 `purpose in ('ai_voice','sms')` 的号码是**全局唯一**的
--  （0025 的 `phone_lines_e164_routable_key`），webhook 正是拿被叫号码反查
--  门店。短信发到这种号上时，归属是确定的：就是那一行 `phone_lines` 指向
--  的 org + location，跟发件人是不是别家客户没有关系。
--
--  ## 修法（只动 SELECT，INSERT 不变）
--
--    · `to_e164` 命中某家店的 ai_voice / sms 号
--        → 只有那家店（org **且** location）可读；新客未建档也算
--    · `to_e164` 是平台共享号（没有任何门店在 phone_lines 里认领）
--        → 维持 0079 口径：发件号码是本店客户
--
--  跨 org 判断「这个被叫号是不是某家店的专属线」必须越过 RLS
--  （本店上下文看不到别家的 phone_lines），所以走一个极窄的
--  SECURITY DEFINER 读取函数，只对 app_user 开放 —— 套路同 0088 的
--  `gf_appointments_due_for_reminder`、0078 的清理函数。
--
--  ## 本迁移**没有**处理的（交接给 routingScope 工作项）
--
--    · 平台共享号上「同 org 两店 / 无预约新客咨询 / 回复的会话归属」的细分
--      —— 需要给 sms_inbound 补归属证据列（routing_scope / bound_line_id /
--      resolved org·location）之后再做，本迁移不加列、不回填。
--    · 号码转让 / 重新分配后历史短信的归属冻结 —— 现在 `phone_lines` 换绑
--      是就地 UPDATE，会让历史短信跟着新归属走。函数**不按 active 过滤**，
--      让停用线的历史短信仍锁在原 (org, location)，是这个方向上能做到的最
--      小缓解，完整方案仍待接手。
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. 被叫号码 → 认领它的门店（跨 org 只读，面窄到只够做归属判断）────────
create or replace function gf_sms_line_owner(p_to_e164 text)
returns table (org_id uuid, location_id uuid)
language sql
security definer
set search_path = public
stable
as $$
  select p.org_id, p.location_id
  from phone_lines p
  where p.e164 = p_to_e164
    and p.purpose in ('ai_voice', 'sms')
  limit 1
$$;

revoke all on function public.gf_sms_line_owner(text) from public, anon, authenticated;
grant execute on function public.gf_sms_line_owner(text) to app_user;

comment on function public.gf_sms_line_owner(text) is
  '入站短信的被叫号码 → 认领它的 org/location（仅 ai_voice / sms 这类全局唯一、'
  '会被 webhook 反查的号）。跨 org 只读，供 sms_inbound 的 RLS 与查询层做归属'
  '判定用（0112）。只有 app_user 可执行，不对 anon 开放。';

-- ── 2. SELECT 策略：先按被叫号码归属，命中不了再回落到 0079 的口径 ────────
drop policy if exists inbound_select_own_customers on sms_inbound;
drop policy if exists inbound_select_own on sms_inbound;

create policy inbound_select_own on sms_inbound
  for select using (
    -- (1) 发到本店专属线：归属确定，只有 org + location 都对得上的那家店可读
    exists (
      select 1 from gf_sms_line_owner(sms_inbound.to_e164) o
      where o.org_id = app_org_id()
        and o.location_id = app_location_id()
    )
    -- (2) 发到平台共享号（没有任何门店认领）：维持 0079 —— 发件号码是本店客户
    or (
      not exists (select 1 from gf_sms_line_owner(sms_inbound.to_e164))
      and exists (
        select 1 from customers c
        where c.org_id = app_org_id()
          and c.phone_e164 = sms_inbound.from_e164
      )
    )
  );

comment on table sms_inbound is
  '客人发到我们号码的上行短信。表本身平台级（无 org_id），SELECT 由 RLS 收窄：'
  'to_e164 命中门店专属线（ai_voice / sms）时，只有该门店（org 且 location）可读，'
  '含未建档新客；发到平台共享号时回落到「发件号码是本店客户」'
  '（sql/0079 + sql/0112，AUD-10）。INSERT 仍放行：入站 webhook 到达时没有租户上下文。';
