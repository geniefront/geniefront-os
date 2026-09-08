-- ════════════════════════════════════════════════════════════════════════════
--  0115 · 入站短信归属证据落库（U09 / routingScope · 计划 §3.3）
--
--  ## 0112 之后还差的一刀
--
--  0112 把「发到门店专属线」的入站短信隔离到唯一 (org, location)，靠的是
--  RLS 里现场调 `gf_sms_line_owner(to_e164)`。**平台共享号**（没有任何门店
--  在 `phone_lines` 里认领的那些）仍然回落 0079 口径「发件号码是本店客户」：
--
--    · 同 org 两店不隔离；
--    · 无法唯一归属的回复没有降级隐藏（计划 §3.2 规则 4 / 5、§3.4）；
--    · 归属靠现场反查 —— 号码换绑后历史短信会跟着新归属走（计划 §3.3）。
--
--  ## 本迁移做的事
--
--  给 `sms_inbound` 补**接收时固定**的归属证据列，从此读取只认这几列、
--  不再现场反查 `phone_lines`：
--
--    routing_scope       store | platform | unresolved
--    bound_line_id       命中的 phone_lines 行（专属线才有）
--    resolved_org        归属 org（scope=store 必非空）
--    resolved_location   归属 location（scope=store 必非空）
--    resolved_at         定归属的时刻
--
--  归属在 `recordInboundSms`（webhook 落库那一刻）判定，规则见该函数：
--
--    1. `to` 命中门店专属线（`gf_sms_line_owner`）→ store，写 resolved + line。
--    2. `to` 是平台共享号，且**恰好一家店**对这个发件号码发过短信
--       （`gf_sms_outbox_owner` —— 可靠且唯一的会话归属证据，不是「最近发过」
--       也不是「同号客户」）→ store，写 resolved，line 为空。
--    3. 其余（0 家或 ≥2 家、纯陌生号）→ platform（系统关键词）/ unresolved。
--       两者对**所有**租户上下文不可见 —— 按用户给出的降级许可（计划 §3.2.5）。
--
--  ## 号码换绑
--
--  归属已经冻在行里，读取不再查 `phone_lines` 当前值 —— 换绑 / 转让后
--  新持有者读不到旧持有者名下的历史短信（计划 §3.3）。
--
--  ## provider 去重
--
--  0034 没给 `sms_inbound` 唯一约束，webhook 重放会插重复行、把未读数顶高。
--  这里补 `unique (provider_id) where provider_id is not null`。
--  `recordInboundSms` 不用 `on conflict do nothing`（那会触发 SELECT 策略检查，
--  而 platform / unresolved 归属的行对任何租户不可见），改为捕获唯一冲突当幂等。
--
--  ## 历史行回填（计划 §3.3「只在有可靠证据时回填」）
--
--    · `to` 命中当前专属线 → store（专属线全局唯一，是可靠证据）；
--    · 否则恰好一家店对该发件号发过短信 → store；
--    · 其余 → unresolved（**不**按客户手机号批量归店）。
--
--  收窄方向：发到平台号的历史行，此前「发件人是本店客户」就能看，现在起
--  只有拿到可靠绑定的那家店能看，其余不可见。原始行一条不删，供平台排障。
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. 归属证据列 ──────────────────────────────────────────────────────────
--     不加外键：`sms_inbound` 是永不删除的凭据表，既有的 from/to 也都是裸文本。
--     归属一旦冻结就与 `phone_lines` / 门店的后续生命周期脱钩（号码停用、换绑、
--     门店重建都不该动历史短信的归属）。
alter table sms_inbound add column if not exists routing_scope     text;
alter table sms_inbound add column if not exists bound_line_id     uuid;
alter table sms_inbound add column if not exists resolved_org      uuid;
alter table sms_inbound add column if not exists resolved_location uuid;
alter table sms_inbound add column if not exists resolved_at       timestamptz;
alter table sms_inbound drop constraint if exists sms_inbound_bound_line_id_fkey;
alter table sms_inbound drop constraint if exists sms_inbound_resolved_org_fkey;
alter table sms_inbound drop constraint if exists sms_inbound_resolved_location_fkey;

-- ── 2. 被叫号码 → 认领它的专属线（0112 的函数，补一个 line_id 返回列）──────
--     返回类型变了，`create or replace` 不允许改返回列，必须先 drop；
--     0112 的策略引用了它，一并在下面重建。
drop policy if exists inbound_select_own on sms_inbound;
drop policy if exists inbound_select_own_customers on sms_inbound;
drop function if exists gf_sms_line_owner(text);

create function gf_sms_line_owner(p_to_e164 text)
returns table (org_id uuid, location_id uuid, line_id uuid)
language sql
security definer
set search_path = public
stable
as $$
  select p.org_id, p.location_id, p.id
  from phone_lines p
  where p.e164 = p_to_e164
    and p.purpose in ('ai_voice', 'sms')
  limit 1
$$;

revoke all on function public.gf_sms_line_owner(text) from public, anon, authenticated;
grant execute on function public.gf_sms_line_owner(text) to app_user;

comment on function public.gf_sms_line_owner(text) is
  '入站短信的被叫号码 → 认领它的 org/location/line_id（仅 ai_voice / sms 这类'
  '全局唯一、会被 webhook 反查的号）。跨 org 只读，供 recordInboundSms 落库时'
  '定归属用（0112 / 0115）。只有 app_user 可执行，不对 anon 开放。';

-- ── 3. 发件号码 → 对它发过短信的门店（可靠且唯一的会话归属证据）───────────
--     只有恰好一家店对这个号发过站内短信时，回复才唯一可归属。
--     ≥2 家 → 调用方按 unresolved 处理（计划 §3.2.4：不靠「同号客户」猜）。
--     limit 2 足够让调用方分辨「恰好一家」与「多于一家」。
create or replace function gf_sms_outbox_owner(p_peer_e164 text)
returns table (org_id uuid, location_id uuid)
language sql
security definer
set search_path = public
stable
as $$
  select distinct o.org_id, o.location_id
  from sms_outbox o
  where o.to_e164 = p_peer_e164
    and o.location_id is not null
  limit 2
$$;

revoke all on function public.gf_sms_outbox_owner(text) from public, anon, authenticated;
grant execute on function public.gf_sms_outbox_owner(text) to app_user;

comment on function public.gf_sms_outbox_owner(text) is
  '发件号码 → 对它发过站内短信的门店集合（去重，最多两行）。供 recordInboundSms '
  '判定平台共享号回复的会话归属：恰好一行时唯一可归属，否则按 unresolved 降级'
  '（0115，计划 §3.2.4）。跨 org 只读，只有 app_user 可执行。';

-- ── 4. 历史行回填 ─────────────────────────────────────────────────────────
--     UPDATE 的目标表不能在自己的 FROM 里被 LATERAL 引用，回填用相关子查询。
--     一次性脚本，多调几次函数无妨。
--
--     专属线命中（可靠）
update sms_inbound s
   set routing_scope = 'store',
       bound_line_id = (select line_id from gf_sms_line_owner(s.to_e164)),
       resolved_org = (select org_id from gf_sms_line_owner(s.to_e164)),
       resolved_location = (select location_id from gf_sms_line_owner(s.to_e164)),
       resolved_at = coalesce(s.resolved_at, s.received_at)
 where s.routing_scope is null
   and exists (select 1 from gf_sms_line_owner(s.to_e164));

--     平台共享号，但恰好一家店对该发件号发过短信（可靠且唯一）
update sms_inbound s
   set routing_scope = 'store',
       resolved_org = (select org_id from gf_sms_outbox_owner(s.from_e164) limit 1),
       resolved_location = (select location_id from gf_sms_outbox_owner(s.from_e164) limit 1),
       resolved_at = coalesce(s.resolved_at, s.received_at)
 where s.routing_scope is null
   and (select count(*) from gf_sms_outbox_owner(s.from_e164)) = 1;

--     其余：无可靠证据 —— 不按客户手机号批量归店
update sms_inbound
   set routing_scope = case when intent in ('opt_out','opt_in','help')
                            then 'platform' else 'unresolved' end
 where routing_scope is null;

-- ── 5. 约束 ──────────────────────────────────────────────────────────────
alter table sms_inbound alter column routing_scope set default 'unresolved';
alter table sms_inbound alter column routing_scope set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sms_inbound_routing_scope') then
    alter table sms_inbound add constraint sms_inbound_routing_scope
      check (routing_scope in ('store','platform','unresolved'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sms_inbound_store_resolved') then
    alter table sms_inbound add constraint sms_inbound_store_resolved
      check (routing_scope <> 'store'
             or (resolved_org is not null and resolved_location is not null));
  end if;
end $$;

create unique index if not exists sms_inbound_provider_id
  on sms_inbound (provider_id) where provider_id is not null;

create index if not exists sms_inbound_resolved
  on sms_inbound (resolved_org, resolved_location, received_at desc)
  where routing_scope = 'store';

-- ── 6. SELECT 策略：只认落库时定下的归属，不再现场反查 ────────────────────
create policy inbound_select_own on sms_inbound
  for select using (
    routing_scope = 'store'
    and resolved_org = app_org_id()
    and resolved_location = app_location_id()
  );

-- INSERT 策略（inbound_insert_platform，0079）不变：webhook 到达时没有租户上下文。

comment on table sms_inbound is
  '客人发到我们号码的上行短信。表本身平台级（无 org_id）。归属在 recordInboundSms '
  '落库时固定写入 routing_scope / resolved_org / resolved_location：命中门店专属线，'
  '或平台共享号上恰好一家店与该号有过站内短信会话 → store，仅该门店（org 且 '
  'location）可读；否则 platform / unresolved，对所有租户不可见（0079 + 0112 + 0115，'
  'AUD-10 / U09）。INSERT 仍放行：入站 webhook 到达时没有租户上下文。';
