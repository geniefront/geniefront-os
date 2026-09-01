-- ════════════════════════════════════════════════════════════════════════════
--  0087 · 把默认短信模板收进单段（修正 0086 早期草稿）
--
--  ## 背景
--
--  0086 的一版早期草稿曾被应用到 staging。那一版里有五条默认短信模板的
--  措辞偏长，在**最坏情况**的变量取值下会超出 160 字符：
--
--    {{shop_name}}    30   「Golden Lotus Nails and Day Spa」
--    {{service_name}} 31   「Deluxe Spa Pedicure with Callus」
--    {{when}}         19   「Wed Aug 26, 12:30 PM」
--    {{shop_phone}}   14   「(617) 555-0142」
--
--  再加上入队时补的固定文本（`GenieFront: ` 12 + ` Reply STOP to opt out.` 23），
--  `appointment_confirm` 与 `appointment_reminder` 分别落在 163 与 164。
--
--  ⚠️ 超出 160 的后果不是报错，而是**每一条都变成两段**：顾客看到的完全
--  一样，账单翻倍，且只会在月底的数字里显现。
--
--  ## 为什么是一份新迁移而不是改 0086
--
--  0086 已在 staging 落库，而其种子逻辑带 `where not exists` —— 重跑不会
--  覆盖已有行。全新环境按 0086 的现行文本种下，本迁移匹配不到任何行、
--  自然空跑；staging 则由本迁移收敛到同一文本。两条路殊途同归。
--
--  ## ⚠️ 只改「仍是当初那份默认值」的行
--
--  匹配条件包含**完整的旧正文**。店主自己改写过的模板正文与之不同，
--  一个字都不会被动到。
-- ════════════════════════════════════════════════════════════════════════════

update notification_templates set
  body = 'Booked: {{service_name}} at {{shop_name}}, {{when}}. Changes: {{shop_phone}}.',
  updated_at = now()
where channel = 'sms' and event_key = 'appointment_confirm'
  and body = 'Booked at {{shop_name}} - {{service_name}}, {{when}}. To change call {{shop_phone}}.';

update notification_templates set
  body = 'Cancelled: {{shop_name}}, {{when}}. Call {{shop_phone}} to rebook.',
  updated_at = now()
where channel = 'sms' and event_key = 'appointment_cancelled'
  and body = 'Your appointment at {{shop_name}} on {{when}} was cancelled. Call {{shop_phone}} to rebook.';

-- ⚠️ 提醒短信刻意去掉了项目名：店名 + 时间 + 电话已足够，
--    带上之后长店名与长项目名的组合必然超出一段。
update notification_templates set
  body = 'Reminder: {{shop_name}}, {{when}}. Changes: {{shop_phone}}.',
  updated_at = now()
where channel = 'sms' and event_key = 'appointment_reminder'
  and body = 'Reminder: {{service_name}} at {{shop_name}}, {{when}}. To change call {{shop_phone}}.';

update notification_templates set
  body = 'New: {{customer_name}}, {{when}}. Confirm: {{confirm_url}}',
  updated_at = now()
where channel = 'sms' and event_key = 'staff_pending_confirm'
  and body = 'New request: {{customer_name}} - {{service_name}}, {{when}}. Confirm: {{confirm_url}}';

update notification_templates set
  body = 'Moved: {{customer_name}}, {{old_when}} to {{when}}.',
  updated_at = now()
where channel = 'sms' and event_key = 'staff_changed'
  and body = 'Schedule change: {{customer_name}} - {{service_name}} moved from {{old_when}} to {{when}}.';
