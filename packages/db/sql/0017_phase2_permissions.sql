-- ════════════════════════════════════════════════════════════════════════════
--  0017 · 把 Phase 2 的新权限补给已经存在的预设角色
--
--  和 0010 同一个道理：权限存在 role_permissions 里，不是从 ROLE_PRESETS
--  实时算的 —— 店主可以在预设基础上勾选调整，所以那张表才是事实。
--  代价是加了新权限就必须有这么一条数据迁移，否则老板升级完打开叫号页，
--  看到的是「没有权限」。
--
--  只补 is_preset = true 的角色。店主改过的自定义角色不碰。
--  可重复执行。
-- ════════════════════════════════════════════════════════════════════════════

do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      -- 老板：全都要
      ('owner',      array['queue.join','queue.manage','form.submit','call.draft']),
      -- 店长：叫号、代客人取号、代签免责书
      ('manager',    array['queue.join','queue.manage','form.submit']),
      -- ⭐ 前台：没有 iPad 的店，取号和签免责书就是前台代做的（宪法第 14 条）。
      --    Kiosk 是可选增强，这几条权限保证了没有它照样跑得通。
      ('front_desk', array['queue.join','queue.manage','form.submit'])
      -- ⚠️ 技师**不给**：叫号是前台的调度动作，
      --    技师自己把下一位叫到自己名下，轮牌就形同虚设了（决策 12）
    ) as t(role_key, perms)
  loop
    insert into role_permissions (role_id, permission)
    select r.id, p
    from roles r, unnest(spec.perms) as p
    where r.key = spec.role_key and r.is_preset = true
    on conflict do nothing;
  end loop;
end $$;

-- ⚠️ `call.draft` 只补给 owner，而且只是为了让老板能在后台手工补一条来电草案。
-- **AI 电话那个 actor 不从这里拿权限** —— 它的权限是代码里写死的一个集合
-- （apps/api/src/telnyx/routes.ts 的 PHONE_AI_PERMISSIONS），
-- 不经过角色表，也就不可能被谁在界面上不小心勾出更大的权限。
