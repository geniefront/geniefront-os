-- Customer self-service has no employee actor. Preserve existing staff provenance.
alter table appointment_guest_cancellations
 alter column created_by drop not null,
 add column actor_source text not null default 'staff',
 add constraint guest_cancellation_actor_source check(
   (actor_source='staff' and created_by is not null)
   or (actor_source='customer' and created_by is null));
