-- ════════════════════════════════════════════════════════════════════════════
--  0076 · 预约 / 排队只能指向**本 org** 的客户（AUD-05）
--
--  ## 问题
--
--  `appointments.customer_id` 的外键是 `references customers(id)` —— 没有
--  org 谓词。而 Postgres 的外键检查是**以表 owner 身份**执行的，
--  **绕过 RLS**。也就是说：写一个别家门店的 customer uuid，
--  数据库看来完全合法，会写进去。
--
--  写进去之后所有读路径都被 RLS 过滤成 NULL —— 客人在界面上凭空消失，
--  库里留着一条跨租户引用，而且从头到尾没有任何报错。
--
--  应用层的校验已经加在 `appointment.assignCustomer` 里了（AUD-05 主修）。
--  这一条是第二道：**让数据库自己拒绝**，这样任何将来新写的路径
--  （补数据脚本、导入工具、下一个忘了校验的 handler）都过不去。
--
--  ## 为什么是复合外键而不是触发器
--
--  触发器要自己处理 update / insert / 以及被引用行改 org 的情况，
--  而复合外键是声明式的、由 Postgres 保证，没有漏写分支的可能。
--  代价是要给 `customers` 加一个 `(org_id, id)` 的唯一约束 ——
--  `id` 本来就是主键，所以这个约束不改变任何语义，只是给外键一个落点。
-- ════════════════════════════════════════════════════════════════════════════

-- ── 0. 先自检：现网已经串了的话必须响亮地失败 ───────────────────────────────
do $$
declare
  bad_appt int;
  bad_queue int;
begin
  select count(*) into bad_appt
    from appointments a join customers c on c.id = a.customer_id
   where a.customer_id is not null and c.org_id <> a.org_id;

  select count(*) into bad_queue
    from walkin_queue w join customers c on c.id = w.customer_id
   where w.customer_id is not null and c.org_id <> w.org_id;

  if bad_appt > 0 or bad_queue > 0 then
    raise exception
      '存在跨 org 的客户引用（appointments=% walkin_queue=%）。'
      '这是 AUD-05 描述的那种串租户引用，必须人工核对后再上这条迁移。',
      bad_appt, bad_queue;
  end if;
end $$;

-- ── 1. 给外键一个落点。id 是主键，加这个不改变任何语义 ──────────────────────
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'customers_org_id_unique'
  ) then
    alter table customers add constraint customers_org_id_unique unique (org_id, id);
  end if;
end $$;

-- ── 2. 复合外键 ─────────────────────────────────────────────────────────────
--
-- ⚠️ 保留原来那条单列外键不动：它管的是「客户存在」，
-- 这一条管的是「客户是本店的」。两条约束回答的是两个问题。
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'appointments_customer_same_org'
  ) then
    alter table appointments
      add constraint appointments_customer_same_org
      foreign key (org_id, customer_id) references customers (org_id, id);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'walkin_queue_customer_same_org'
  ) then
    alter table walkin_queue
      add constraint walkin_queue_customer_same_org
      foreign key (org_id, customer_id) references customers (org_id, id);
  end if;
end $$;

comment on constraint appointments_customer_same_org on appointments is
  'AUD-05：预约只能指向本 org 的客户。单列外键的检查绕过 RLS，挡不住跨租户 uuid。';
