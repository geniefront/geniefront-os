-- ════════════════════════════════════════════════════════════════════════════
--  0010 · 把 Phase 1b 的新权限补给已经存在的预设角色
--
--  权限存在 role_permissions 里，不是从 ROLE_PRESETS 实时算的 ——
--  店主可以在预设基础上勾选调整，所以那张表才是事实。
--  代价是：加了新权限就必须有这么一条数据迁移，
--  否则老板升级完打开日结页，看到的是「没有权限」。
--
--  只补 is_preset = true 的角色。店主自己改过的自定义角色不碰 ——
--  那是他明确表达过的意图，我们没有资格替他加权限。
--
--  可重复执行（on conflict do nothing）。
-- ════════════════════════════════════════════════════════════════════════════

do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      -- 老板：全都要
      ('owner',      array['dayclose.manage','tip.payout','report.view','payroll.configure']),
      -- 店长：日结、发小费、看报表都归他
      ('manager',    array['dayclose.manage','tip.payout','report.view','payroll.configure']),
      -- ⭐ 前台：Desk-Only 的店，打烊数钱和发现金小费就是前台干的（宪法第 14 条）。
      --    但**不给** report.view —— 历史营业报表是老板的账（决策 19 极致隐私）。
      ('front_desk', array['dayclose.manage','tip.payout'])
    ) as t(role_key, perms)
  loop
    insert into role_permissions (role_id, permission)
    select r.id, p
    from roles r, unnest(spec.perms) as p
    where r.key = spec.role_key and r.is_preset = true
    on conflict do nothing;
  end loop;
end $$;
