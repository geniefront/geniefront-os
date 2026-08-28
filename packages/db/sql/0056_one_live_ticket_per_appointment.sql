-- 0056: one active visit ticket per appointment
--
-- Idempotency keys protect retries of one request. They do not protect two
-- clients (or two buttons) using different keys. This index is the final guard:
-- an appointment may be reopened after a void, but can never have two live
-- tickets at the same time.

create unique index if not exists tickets_one_live_per_appointment_idx
  on tickets (appointment_id)
  where appointment_id is not null and status <> 'voided';

create unique index if not exists walkin_queue_one_active_per_appointment_idx
  on walkin_queue (appointment_id)
  where appointment_id is not null and status <> 'left';
