-- ════════════════════════════════════════════════════════════════════════════
--  0083 · 收回 anon / authenticated 对三个 SECURITY DEFINER 函数的执行权
--
--  ## 问题
--
--  Supabase 的安全检查在 staging 上报出三个 `SECURITY DEFINER` 函数
--  **匿名可调**（`/rest/v1/rpc/<name>`，只要拿到 anon key —— 而 anon key
--  本来就在每个前端的包里）：
--
--    · gf_purge_command_idempotency(int)          ⚠️ 它会**删数据**
--    · gf_assert_stripe_ids_single_org()
--    · gf_billing_tenant_for_stripe_refs(text,text)
--
--  最严重的是第一个：它删 `command_idempotency` 里过了保留期的行。
--  下限钳在 24 小时，所以删不掉重放窗口内的东西 —— 但它是一个
--  **不需要任何身份就能触发的写操作**，而且可以被无限次调用；
--  0078 把它设计成「由应用每小时调一次」，不是「谁都能调」。
--
--  另外两个是读：一个吐出「哪个 org 用了这个 stripe customer」，
--  一个在跨 org 复用时抛错 —— 单独看信息量不大，但它们都在
--  `SECURITY DEFINER` 之下**绕过 RLS**，没有任何理由对匿名访客开放。
--
--  ## 为什么原来的 revoke 不够
--
--  0072 / 0078 里写的是 `revoke all on function ... from public`。
--  这一句只收回 PUBLIC 伪角色那一份，而 **Supabase 给 `public` schema 里的
--  新函数设了默认权限**，anon / authenticated / service_role 各自拿到了
--  一份**独立的** EXECUTE —— 收 PUBLIC 收不掉它们。
--
--  0074（运营台）和 0082（测试收件箱）已经是对的写法：
--  `revoke all ... from public, anon, authenticated`，再显式 `grant ... to app_user`。
--  这份迁移把同样的写法补给上面三个。
--
--  ## ⚠️ user_in_location(uuid) 故意不动
--
--  它同样是 definer、同样对 `authenticated` 开放，但那是**必须的**：
--  Realtime 的频道授权（0011 / 0013）与 Storage 的对象策略（0014 / 0016）
--  都在 `authenticated` 身份下执行这个函数。0055 收完之后又专门
--  重新 grant 了一次，就是这个原因。收掉它 = 技师端的实时频道和
--  价目表照片同时失效。
-- ════════════════════════════════════════════════════════════════════════════

revoke all on function public.gf_purge_command_idempotency(int)
  from public, anon, authenticated;
revoke all on function public.gf_assert_stripe_ids_single_org()
  from public, anon, authenticated;
revoke all on function public.gf_billing_tenant_for_stripe_refs(text, text)
  from public, anon, authenticated;

-- 运行时角色照旧：保留期清理（apps/api/src/ops/retention.ts）与发票 webhook
-- 定位门店（packages/db/src/billingLookup.ts）都走 app_user。
grant execute on function public.gf_purge_command_idempotency(int) to app_user;
grant execute on function public.gf_billing_tenant_for_stripe_refs(text, text) to app_user;

-- gf_assert_stripe_ids_single_org() 是 0080/0081 的自检，只在迁移与运维时
-- 由 postgres 调用（函数属主本来就有执行权），运行时角色不需要它。

comment on function public.gf_purge_command_idempotency(int) is
  'AUD-09：删除超出保留期的幂等记录。保留期下限 24 小时，窗口内的重放不受影响。'
  '⚠️ 只有 app_user 可执行 —— 它是写操作，不能对 anon 开放（0083）。';
