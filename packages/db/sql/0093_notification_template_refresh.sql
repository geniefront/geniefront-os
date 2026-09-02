-- ════════════════════════════════════════════════════════════════════════════
--  0093 · 刷新默认通知模板文案（店主改过的不动）
--
--  0086 已在存量库落库，其种子函数带 `where not exists` —— 重跑不会覆盖
--  已有行。本迁移做两件事：
--
--    1. CREATE OR REPLACE 种子函数，使之后新建的门店拿到新文案
--    2. 只更新「正文仍是 0086/0087 那份默认值」的行
--
--  ⚠️ 匹配条件包含完整旧正文。店主自己改写过的模板一个字都不会被动到。
-- ════════════════════════════════════════════════════════════════════════════

create or replace function gf_seed_notification_templates(
  p_org_id uuid, p_location_id uuid
) returns integer
language plpgsql security definer set search_path = public
as $$
declare
  n integer := 0;
begin
  insert into notification_templates
    (org_id, location_id, event_key, channel, locale, version, subject, body, active)
  select p_org_id, p_location_id, t.event_key, t.channel, 'en', 1, t.subject, t.body, true
  from (values
    ('appointment_confirm', 'email',
     'Appointment confirmed · {{when}} · {{shop_name}}',
     E'Hi {{customer_name}},\n\nYou''re booked at {{shop_name}}.\n\n  Service: {{service_name}}\n  Time: {{when}}\n  Specialist: {{staff_name}}\n\nTo change this appointment, please call {{shop_phone}}.\n\nSee you then,\n{{shop_name}}'),
    ('appointment_confirm', 'sms', null,
     'Booked: {{service_name}} at {{shop_name}}, {{when}}. Changes: {{shop_phone}}.'),
    ('appointment_changed', 'email',
     'Appointment updated · {{when}} · {{shop_name}}',
     E'Hi {{customer_name}},\n\nYour appointment at {{shop_name}} has been moved.\n\n  From: {{old_when}}\n  To: {{when}}\n  Service: {{service_name}}\n  Specialist: {{staff_name}}\n\nIf this time does not work, please call {{shop_phone}}.\n\n— {{shop_name}}'),
    ('appointment_changed', 'sms', null,
     'Your appointment at {{shop_name}} moved to {{when}}. Questions? Call {{shop_phone}}.'),
    ('appointment_cancelled', 'email',
     'Appointment cancelled · {{shop_name}}',
     E'Hi {{customer_name}},\n\nYour {{service_name}} at {{shop_name}} on {{when}} has been cancelled.\n\nTo book again, please call {{shop_phone}}.\n\n— {{shop_name}}'),
    ('appointment_cancelled', 'sms', null,
     'Cancelled: {{shop_name}}, {{when}}. Call {{shop_phone}} to rebook.'),
    ('appointment_reminder', 'email',
     'Reminder: your appointment at {{shop_name}}',
     E'Hi {{customer_name}},\n\nReminder: you have an appointment at {{shop_name}}.\n\n  Service: {{service_name}}\n  Time: {{when}}\n  Specialist: {{staff_name}}\n\nTo change this appointment, please call {{shop_phone}}.\n\n— {{shop_name}}'),
    ('appointment_reminder', 'sms', null,
     'Reminder: {{shop_name}}, {{when}}. Changes: {{shop_phone}}.'),
    ('staff_pending_confirm', 'sms', null,
     'New: {{customer_name}}, {{when}}. Confirm: {{confirm_url}}'),
    ('staff_assigned', 'sms', null,
     'Assigned: {{customer_name}} - {{service_name}}, {{when}}.'),
    ('staff_changed', 'sms', null,
     'Moved: {{customer_name}}, {{old_when}} to {{when}}.'),
    ('staff_cancelled', 'sms', null,
     'Cancelled: {{customer_name}} - {{service_name}}, {{when}}.'),
    ('birthday', 'email',
     'Happy birthday from {{shop_name}}',
     E'Hi {{customer_name}},\n\nHappy birthday from everyone at {{shop_name}}!\n\nTreat yourself - call {{shop_phone}} and we will find a time that works.\n\n— {{shop_name}}'),
    ('birthday', 'sms', null,
     'Happy birthday from {{shop_name}}! Call {{shop_phone}} to book.'),
    ('holiday', 'email',
     '{{holiday_name}} from {{shop_name}}',
     E'Hi {{customer_name}},\n\nWishing you a wonderful {{holiday_name}} from everyone at {{shop_name}}.\n\nWhen you are ready to book, call {{shop_phone}}.\n\n— {{shop_name}}'),
    ('holiday', 'sms', null,
     '{{holiday_name}} greetings from {{shop_name}}! Call {{shop_phone}} to book.'),
    ('winback', 'email',
     'We miss you at {{shop_name}}',
     E'Hi {{customer_name}},\n\nIt has been {{days_since}} days since we last saw you at {{shop_name}}. We would love to have you back.\n\nCall {{shop_phone}} to book your next visit.\n\n— {{shop_name}}'),
    ('winback', 'sms', null,
     'We miss you at {{shop_name}} - it has been {{days_since}} days. Call {{shop_phone}}.'),
    ('review_request', 'email',
     'How did we do? · {{shop_name}}',
     E'Hi {{customer_name}},\n\nThank you for visiting {{shop_name}}. If you have a minute, we would love to hear how we did.\n\n  {{review_url}}\n\n— {{shop_name}}'),
    ('review_request', 'sms', null,
     'Thanks for visiting {{shop_name}}! Mind leaving a quick review? {{review_url}}')
  ) as t(event_key, channel, subject, body)
  where not exists (
    select 1 from notification_templates x
     where x.location_id = p_location_id
       and x.event_key = t.event_key
       and x.channel = t.channel
       and x.locale = 'en'
  );

  get diagnostics n = row_count;
  return n;
end $$;

-- 存量默认行：只在正文仍是旧默认值时改写。

update notification_templates set
  body = E'Hi {{customer_name}},\n\nYou''re booked at {{shop_name}}.\n\n  Service: {{service_name}}\n  Time: {{when}}\n  Specialist: {{staff_name}}\n\nTo change this appointment, please call {{shop_phone}}.\n\nSee you then,\n{{shop_name}}',
  updated_at = now()
where channel = 'email' and event_key = 'appointment_confirm'
  and body = E'Hi {{customer_name}},\n\nYour appointment at {{shop_name}} is confirmed.\n\n  Service: {{service_name}}\n  Time: {{when}}\n  Specialist: {{staff_name}}\n\nTo reschedule or cancel, please call {{shop_phone}}.\n\n— {{shop_name}}';

update notification_templates set
  body = E'Hi {{customer_name}},\n\nYour appointment at {{shop_name}} has been moved.\n\n  From: {{old_when}}\n  To: {{when}}\n  Service: {{service_name}}\n  Specialist: {{staff_name}}\n\nIf this time does not work, please call {{shop_phone}}.\n\n— {{shop_name}}',
  updated_at = now()
where channel = 'email' and event_key = 'appointment_changed'
  and body = E'Hi {{customer_name}},\n\nYour appointment at {{shop_name}} has been moved from {{old_when}} to {{when}}.\n\n  Service: {{service_name}}\n  Specialist: {{staff_name}}\n\nIf this does not work for you, please call {{shop_phone}}.\n\n— {{shop_name}}';

update notification_templates set
  body = E'Hi {{customer_name}},\n\nYour {{service_name}} at {{shop_name}} on {{when}} has been cancelled.\n\nTo book again, please call {{shop_phone}}.\n\n— {{shop_name}}',
  updated_at = now()
where channel = 'email' and event_key = 'appointment_cancelled'
  and body = E'Hi {{customer_name}},\n\nYour {{service_name}} appointment at {{shop_name}} on {{when}} has been cancelled.\n\nTo book again, please call {{shop_phone}}.\n\n— {{shop_name}}';

update notification_templates set
  body = E'Hi {{customer_name}},\n\nReminder: you have an appointment at {{shop_name}}.\n\n  Service: {{service_name}}\n  Time: {{when}}\n  Specialist: {{staff_name}}\n\nTo change this appointment, please call {{shop_phone}}.\n\n— {{shop_name}}',
  updated_at = now()
where channel = 'email' and event_key = 'appointment_reminder'
  and body = E'Hi {{customer_name}},\n\nThis is a reminder of your upcoming appointment.\n\n  Service: {{service_name}}\n  Time: {{when}}\n  Specialist: {{staff_name}}\n\nTo reschedule or cancel, please call {{shop_phone}}.\n\n— {{shop_name}}';

update notification_templates set
  body = E'Hi {{customer_name}},\n\nHappy birthday from everyone at {{shop_name}}!\n\nTreat yourself - call {{shop_phone}} and we will find a time that works.\n\n— {{shop_name}}',
  updated_at = now()
where channel = 'email' and event_key = 'birthday'
  and body = E'Hi {{customer_name}},\n\nHappy birthday from all of us at {{shop_name}}!\n\nCall {{shop_phone}} to book your birthday treat.\n\n— {{shop_name}}';

update notification_templates set
  body = 'Happy birthday from {{shop_name}}! Call {{shop_phone}} to book.',
  updated_at = now()
where channel = 'sms' and event_key = 'birthday'
  and body = 'Happy birthday from {{shop_name}}! Call {{shop_phone}} to book your treat.';

update notification_templates set
  body = E'Hi {{customer_name}},\n\nWishing you a wonderful {{holiday_name}} from everyone at {{shop_name}}.\n\nWhen you are ready to book, call {{shop_phone}}.\n\n— {{shop_name}}',
  updated_at = now()
where channel = 'email' and event_key = 'holiday'
  and body = E'Hi {{customer_name}},\n\nWishing you a wonderful {{holiday_name}} from {{shop_name}}.\n\nCall {{shop_phone}} to book.\n\n— {{shop_name}}';

update notification_templates set
  body = E'Hi {{customer_name}},\n\nIt has been {{days_since}} days since we last saw you at {{shop_name}}. We would love to have you back.\n\nCall {{shop_phone}} to book your next visit.\n\n— {{shop_name}}',
  updated_at = now()
where channel = 'email' and event_key = 'winback'
  and body = E'Hi {{customer_name}},\n\nIt has been {{days_since}} days since your last visit to {{shop_name}}.\n\nCall {{shop_phone}} to book your next appointment.\n\n— {{shop_name}}';

update notification_templates set
  body = E'Hi {{customer_name}},\n\nThank you for visiting {{shop_name}}. If you have a minute, we would love to hear how we did.\n\n  {{review_url}}\n\n— {{shop_name}}',
  updated_at = now()
where channel = 'email' and event_key = 'review_request'
  and body = E'Hi {{customer_name}},\n\nThank you for visiting {{shop_name}}. Would you take a moment to tell us how we did?\n\n  {{review_url}}\n\n— {{shop_name}}';
