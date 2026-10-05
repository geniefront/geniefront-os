-- A deposit request is a separate transaction notice, never a booking confirmation.
alter table email_outbox drop constraint email_outbox_kind;
alter table email_outbox add constraint email_outbox_kind check(kind in(
 'appointment_confirm','appointment_changed','appointment_reminder','appointment_deposit_pending',
 'receipt','platform_notice','form_invite','trial_ending','payment_failed','subscription_canceled','license_expiring'));
