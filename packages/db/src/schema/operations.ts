/** Persisted AI business summaries. SQL 0059/0060 own constraints and RLS. */
import { pgTable, uuid, text, integer, jsonb, timestamp, date, index } from 'drizzle-orm/pg-core';
import { organizations, locations } from './tenancy';

const id = () => uuid('id').primaryKey().defaultRandom();
const org = () => uuid('org_id').notNull().references(() => organizations.id);
const location = () => uuid('location_id').notNull().references(() => locations.id);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const aiBusinessSummaries = pgTable('ai_business_summaries', {
  id: id(), orgId: org(), locationId: location(), periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(), generator: text('generator').notNull(),
  generatorVersion: text('generator_version').notNull(), inputFactsSha256: text('input_facts_sha256').notNull(),
  inputRecordCount: integer('input_record_count').notNull(), content: jsonb('content').notNull(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('ai_business_summaries_recent_idx').on(t.locationId, t.generatedAt)]);
