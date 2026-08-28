-- GenieFront does not custody customer funds, operate POS hardware, or execute payroll.
-- Keep accounting facts and AI summaries; remove provider/payout execution models that
-- would imply a financial service the product does not provide.

drop table if exists payroll_batch_items;
drop table if exists payroll_batches;
drop table if exists provider_webhook_events;
drop table if exists payout_batches;
drop table if exists merchant_balance_snapshots;
drop table if exists provider_connections;

-- 0052 carried a demo-only POS batch payload. Card totals may still be entered
-- manually, but GenieFront has no terminal-batch concept.
alter table day_closes drop column if exists terminal_batches;

-- Identical facts and locale reuse the same generated summary, protecting the
-- store's AI allowance from repeated button clicks.
delete from ai_business_summaries older
using ai_business_summaries newer
where older.location_id = newer.location_id
  and older.input_facts_sha256 = newer.input_facts_sha256
  and older.generator_version = newer.generator_version
  and (older.generated_at, older.id) < (newer.generated_at, newer.id);
create unique index if not exists ai_business_summaries_location_facts_generator_key
  on ai_business_summaries(location_id, input_facts_sha256, generator_version);
