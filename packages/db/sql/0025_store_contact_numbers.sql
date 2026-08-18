-- ════════════════════════════════════════════════════════════════════════════
--  0025 · 店家自己的两个号码（09-TELNYX §2 接入方式）
--
--  AI 客服的开通是**人工**做的（买号、建 assistant、绑 tool、设转人工），
--  系统这一侧只需要一件事：**让店家把两个号码确认下来**。
--
--    · main            对外公布的号 —— 店家在自己运营商那儿设「无应答转移」的**来源**
--    · transfer_target 人工客服号   —— AI 转人工的**目标**
--    · ai_voice        我们买的落地号 —— 转移的落点，也是 webhook 反查门店的键
--
--  「待开通」不存状态，是**推导**出来的：有 main + transfer_target
--  而没有 ai_voice = 还没开通。存一个状态列就要有人去维护它，
--  而它和三条记录本身随时可能对不上。
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. 新增 purpose ────────────────────────────────────────────────────────
do $$
begin
  alter table phone_lines drop constraint if exists phone_lines_purpose;
  alter table phone_lines add constraint phone_lines_purpose
    check (purpose in ('ai_voice','main','sms','transfer_target'));
end $$;

-- ── 2. ⭐ 唯一约束收窄到「会被反查的号」 ───────────────────────────────────
--
-- 原来是 e164 全局唯一，理由写在 schema 里：同一个号码不可能同时属于两家店，
-- 漏掉的后果是 webhook 随机落到其中一家 —— 无从复现的串店。
--
-- 那个理由**只对会被反查的 purpose 成立**（ai_voice / sms —— webhook 拿着
-- 被叫号码来问「这是谁家的」）。main 和 transfer_target 我们从来不反查。
--
-- 而全局唯一在这两种 purpose 上会造成一个很常见的误伤：
--   **人工客服号通常是老板的手机，而一个老板开两三家店在这行很普遍。**
--   第二家店填同一个手机号就会撞约束，报一个看起来毫无道理的错。
drop index if exists phone_lines_e164_key;

create unique index if not exists phone_lines_e164_routable_key
  on phone_lines (e164)
  where purpose in ('ai_voice','sms');

-- 同一家店同一种用途只留一条（换号是 update，不是再插一条）。
create unique index if not exists phone_lines_loc_purpose_key
  on phone_lines (location_id, purpose)
  where active;

-- ── 3. ⭐ 反查策略也跟着收窄 ───────────────────────────────────────────────
--
-- phone_line_lookup 是给「没有登录用户的 webhook」用的极窄策略（0015）。
-- 它的安全性来自「必须先说出完整号码才能查到那一行」。
--
-- 店家自己的两个号进了同一张表之后，如果不加 purpose 过滤，
-- 这条策略就顺带把它们也暴露在同一个查询面上 —— 而它们**根本不需要被反查**。
-- 判断标准照旧（`09` §5.2）：这个入口能看到的东西，越少越好。
drop policy if exists phone_line_lookup on phone_lines;
create policy phone_line_lookup on phone_lines
  for select
  using (e164 = app_phone_lookup() and purpose in ('ai_voice','sms'));

drop policy if exists location_by_phone_lookup on locations;
create policy location_by_phone_lookup on locations
  for select
  using (exists (
    select 1 from phone_lines p
    where p.location_id = locations.id
      and p.e164 = app_phone_lookup()
      and p.purpose in ('ai_voice','sms')));

drop policy if exists org_by_phone_lookup on organizations;
create policy org_by_phone_lookup on organizations
  for select
  using (exists (
    select 1 from phone_lines p
    where p.org_id = organizations.id
      and p.e164 = app_phone_lookup()
      and p.purpose in ('ai_voice','sms')));
