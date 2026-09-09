-- ════════════════════════════════════════════════════════════════════════════
--  0121 · 订阅码到期提醒信（计划批 5）
--
--  只做一件事：给 `email_outbox.kind` 的白名单加一档 `license_expiring`。
--
--  ⚠️⚠️ 那是一条 **check 白名单**（sql/0029 建，0038 / 0039 / 0085 / 0090
--  各扩过一次）。
--  加一档只能「drop 掉整条再按全量列表重建」—— 所以下面这一行必须是
--  **当前全部类型的完整清单**，漏掉任何一个，那个类型的历史行会让这条
--  迁移直接失败（0039 第一版就漏了 form_invite，撞了一次）。
--
--  再加新类型时：复制下面这一行，在末尾追加，不要凭记忆重写。
--
--  ## 为什么订阅码到期要单独一档，而不是复用 trial_ending
--
--  去重靠 `(entity_type, entity_id, kind)` 的唯一索引。复用同一个 kind 的话，
--  一家先试用、后改用订阅码的店只会收到其中一封 —— 而被吞掉的那封恰好是
--  「你的服务三天后停」，没有任何日志会显示它被吞了。
-- ════════════════════════════════════════════════════════════════════════════

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'email_outbox_kind') then
    alter table email_outbox drop constraint email_outbox_kind;
  end if;
  -- ⬇︎ 完整清单 = sql/0090 那一份 + 末尾追加 license_expiring。
  -- ⚠️ `receipt` 留着：小票功能已于 2026-09-01 移除，但历史行带着这个值，
  -- 收窄白名单会让那些行在任何一次 update 时失败（0090 的原注释）。
  alter table email_outbox add constraint email_outbox_kind
    check (kind in (
      'appointment_confirm', 'appointment_changed', 'appointment_reminder',
      'receipt', 'platform_notice', 'form_invite',
      'trial_ending', 'payment_failed', 'subscription_canceled',
      'license_expiring'
    ));
end $$;
