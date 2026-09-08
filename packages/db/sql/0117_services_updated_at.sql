-- ════════════════════════════════════════════════════════════════════════════
--  0117 · `services` 补 `updated_at` + 自动触发器（U04 / 计划 §7.2）
--
--  批量编辑（`catalog.bulkUpdateServices`）在确认页展示一批项目、老板勾选后
--  提交。这中间若有别人改了其中某个项目，批量提交会**悄悄覆盖**掉那次改动。
--  §7.2：「预览后其他人修改服务时拒绝旧版本覆盖或显式合并」。
--
--  `services` 此前**没有任何版本 / 时间戳列**。这里补 `updated_at`（`not null
--  default now()`）并挂一个 `before update` 触发器，让**任何** UPDATE 路径
--  （SaveService / 批量 / blueprint 落地 / archive…）都自动推进它 ——
--  批量 handler 拿它做乐观锁比对，不用每条改法各自记时间。
--
--  纯加列 + 触发器，既有行 `updated_at` 初始化为 `now()`，不改任何写行为。
-- ════════════════════════════════════════════════════════════════════════════

alter table services add column if not exists updated_at timestamptz not null default now();

-- 通用「碰一下 updated_at」触发器函数。以后别的表要同款行为可直接复用。
create or replace function gf_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end
$$;

revoke all on function public.gf_touch_updated_at() from public, anon, authenticated;

drop trigger if exists services_touch_updated_at on services;
create trigger services_touch_updated_at
  before update on services
  for each row execute function gf_touch_updated_at();

comment on column services.updated_at is
  '最后一次 UPDATE 的时刻，由 services_touch_updated_at 触发器自动维护。'
  '批量编辑用它做乐观锁：确认页取到的值与提交时不一致 = 期间被人改过（0117，U04）。';
