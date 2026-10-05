-- Lost cards keep their asset and append-only financial history. Only the bearer credential is disabled/rotated.
alter table gift_cards add column if not exists credential_disabled boolean not null default false;
alter table gift_cards add column if not exists credential_version integer not null default 1 check(credential_version>0);
alter table email_outbox add column if not exists commerce_gift_card_id uuid references gift_cards(id);
alter table email_outbox add column if not exists commerce_credential_version integer;
alter table email_outbox add column if not exists commerce_order_id uuid references commerce_orders(id);
alter table email_outbox add constraint email_outbox_commerce_credential_pair check(
  (commerce_gift_card_id is null and commerce_credential_version is null) or
  (commerce_gift_card_id is not null and commerce_credential_version>0));
