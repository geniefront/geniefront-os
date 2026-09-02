-- ════════════════════════════════════════════════════════════════════════════
--  0100 · Add {{manage_url}} to default customer appointment templates
--
--  Only rows that still exactly equal the 0093 default body are rewritten.
--  Customized shop templates are left untouched.
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
     E'Hi {{customer_name}},\n\nYou''re booked at {{shop_name}}.\n\n  Service: {{service_name}}\n  Time: {{when}}\n  Specialist: {{staff_name}}\n\n{{manage_url}}To change this appointment, please call {{shop_phone}}.\n\nSee you then,\n{{shop_name}}'),
    ('appointment_confirm', 'sms', null,
     'Booked: {{service_name}} at {{shop_name}}, {{when}}. {{manage_url}}'),
    ('appointment_changed', 'email',
     'Appointment updated · {{when}} · {{shop_name}}',
     E'Hi {{customer_name}},\n\nYour appointment at {{shop_name}} has been moved.\n\n  From: {{old_when}}\n  To: {{when}}\n  Service: {{service_name}}\n  Specialist: {{staff_name}}\n\n{{manage_url}}If this time does not work, please call {{shop_phone}}.\n\n— {{shop_name}}'),
    ('appointment_changed', 'sms', null,
     'Your appointment at {{shop_name}} moved to {{when}}. {{manage_url}}'),
    ('appointment_cancelled', 'email',
     'Appointment cancelled · {{shop_name}}',
     E'Hi {{customer_name}},\n\nYour {{service_name}} at {{shop_name}} on {{when}} has been cancelled.\n\n{{manage_url}}To book again, please call {{shop_phone}}.\n\n— {{shop_name}}'),
    ('appointment_cancelled', 'sms', null,
     'Cancelled: {{shop_name}}, {{when}}. {{manage_url}}'),
    ('appointment_reminder', 'email',
     'Reminder: your appointment at {{shop_name}}',
     E'Hi {{customer_name}},\n\nReminder: you have an appointment at {{shop_name}}.\n\n  Service: {{service_name}}\n  Time: {{when}}\n  Specialist: {{staff_name}}\n\n{{manage_url}}To change this appointment, please call {{shop_phone}}.\n\n— {{shop_name}}'),
    ('appointment_reminder', 'sms', null,
     'Reminder: {{shop_name}}, {{when}}. {{manage_url}}'),
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

update notification_templates set
  body = E'Hi {{customer_name}},\n\nYou''re booked at {{shop_name}}.\n\n  Service: {{service_name}}\n  Time: {{when}}\n  Specialist: {{staff_name}}\n\n{{manage_url}}To change this appointment, please call {{shop_phone}}.\n\nSee you then,\n{{shop_name}}',
  updated_at = now()
where channel = 'email' and event_key = 'appointment_confirm'
  and body = E'Hi {{customer_name}},\n\nYou''re booked at {{shop_name}}.\n\n  Service: {{service_name}}\n  Time: {{when}}\n  Specialist: {{staff_name}}\n\nTo change this appointment, please call {{shop_phone}}.\n\nSee you then,\n{{shop_name}}';

update notification_templates set
  body = 'Booked: {{service_name}} at {{shop_name}}, {{when}}. {{manage_url}}',
  updated_at = now()
where channel = 'sms' and event_key = 'appointment_confirm'
  and body = 'Booked: {{service_name}} at {{shop_name}}, {{when}}. Changes: {{shop_phone}}.';

update notification_templates set
  body = E'Hi {{customer_name}},\n\nYour appointment at {{shop_name}} has been moved.\n\n  From: {{old_when}}\n  To: {{when}}\n  Service: {{service_name}}\n  Specialist: {{staff_name}}\n\n{{manage_url}}If this time does not work, please call {{shop_phone}}.\n\n— {{shop_name}}',
  updated_at = now()
where channel = 'email' and event_key = 'appointment_changed'
  and body = E'Hi {{customer_name}},\n\nYour appointment at {{shop_name}} has been moved.\n\n  From: {{old_when}}\n  To: {{when}}\n  Service: {{service_name}}\n  Specialist: {{staff_name}}\n\nIf this time does not work, please call {{shop_phone}}.\n\n— {{shop_name}}';

update notification_templates set
  body = 'Your appointment at {{shop_name}} moved to {{when}}. {{manage_url}}',
  updated_at = now()
where channel = 'sms' and event_key = 'appointment_changed'
  and body = 'Your appointment at {{shop_name}} moved to {{when}}. Questions? Call {{shop_phone}}.';

update notification_templates set
  body = E'Hi {{customer_name}},\n\nYour {{service_name}} at {{shop_name}} on {{when}} has been cancelled.\n\n{{manage_url}}To book again, please call {{shop_phone}}.\n\n— {{shop_name}}',
  updated_at = now()
where channel = 'email' and event_key = 'appointment_cancelled'
  and body = E'Hi {{customer_name}},\n\nYour {{service_name}} at {{shop_name}} on {{when}} has been cancelled.\n\nTo book again, please call {{shop_phone}}.\n\n— {{shop_name}}';

update notification_templates set
  body = 'Cancelled: {{shop_name}}, {{when}}. {{manage_url}}',
  updated_at = now()
where channel = 'sms' and event_key = 'appointment_cancelled'
  and body = 'Cancelled: {{shop_name}}, {{when}}. Call {{shop_phone}} to rebook.';

update notification_templates set
  body = E'Hi {{customer_name}},\n\nReminder: you have an appointment at {{shop_name}}.\n\n  Service: {{service_name}}\n  Time: {{when}}\n  Specialist: {{staff_name}}\n\n{{manage_url}}To change this appointment, please call {{shop_phone}}.\n\n— {{shop_name}}',
  updated_at = now()
where channel = 'email' and event_key = 'appointment_reminder'
  and body = E'Hi {{customer_name}},\n\nReminder: you have an appointment at {{shop_name}}.\n\n  Service: {{service_name}}\n  Time: {{when}}\n  Specialist: {{staff_name}}\n\nTo change this appointment, please call {{shop_phone}}.\n\n— {{shop_name}}';

update notification_templates set
  body = 'Reminder: {{shop_name}}, {{when}}. {{manage_url}}',
  updated_at = now()
where channel = 'sms' and event_key = 'appointment_reminder'
  and body = 'Reminder: {{shop_name}}, {{when}}. Changes: {{shop_phone}}.';
