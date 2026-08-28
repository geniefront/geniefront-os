/**
 * 硬件/副屏配对会话数据模型（Hardware Server Pairing）
 */

import {
  pgTable, uuid, text, timestamp, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations, locations } from './tenancy';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const orgCol = () => uuid('org_id').notNull().references(() => organizations.id);
const locCol = () => uuid('location_id').notNull().references(() => locations.id);

export const pairingSessions = pgTable('pairing_sessions', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  code: text('code').notNull(),
  terminalType: text('terminal_type').notNull().default('customer-facing'), // customer-facing | kiosk
  status: text('status').notNull().default('pending'), // pending | paired | expired
  qrPayload: text('qr_payload').notNull(),
  pairedDeviceId: uuid('paired_device_id'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('pairing_code_uidx').on(t.code),
  index('pairing_loc_status_idx').on(t.locationId, t.status),
]);
