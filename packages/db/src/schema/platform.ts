/**
 * GenieFront operator console (sql/0074).
 *
 * platform_operators is a global allow-list, not a tenant table.
 * support_requests are tenant-scoped customer tickets.
 */

import {
  pgTable, uuid, text, timestamp, index,
} from 'drizzle-orm/pg-core';
import { organizations, locations } from './tenancy';
import { users, memberships } from './identity';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const platformOperators = pgTable('platform_operators', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id),
  role: text('role').notNull(), // super_admin | support
  status: text('status').notNull().default('active'), // active | revoked
  notes: text('notes'),
  createdAt: createdAt(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const supportRequests = pgTable('support_requests', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  submittedByUserId: uuid('submitted_by_user_id').references(() => users.id),
  submittedByMembershipId: uuid('submitted_by_membership_id').references(() => memberships.id),
  category: text('category').notNull().default('general'),
  subject: text('subject').notNull(),
  description: text('description').notNull(),
  status: text('status').notNull().default('open'),
  priority: text('priority').notNull().default('normal'),
  assignedOperatorId: uuid('assigned_operator_id').references(() => platformOperators.id),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, (t) => [
  index('support_requests_status_idx').on(t.status, t.createdAt),
  index('support_requests_location_idx').on(t.locationId, t.createdAt),
]);

export const supportRequestNotes = pgTable('support_request_notes', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  requestId: uuid('request_id').notNull().references(() => supportRequests.id, { onDelete: 'cascade' }),
  authorOperatorId: uuid('author_operator_id').references(() => platformOperators.id),
  body: text('body').notNull(),
  createdAt: createdAt(),
}, (t) => [
  index('support_request_notes_request_idx').on(t.requestId, t.createdAt),
]);
