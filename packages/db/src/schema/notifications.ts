/**
 * 个人资料扩展、通知偏好、设备会话与应用内通知中心 (Profile & Notifications)
 */

import {
  pgTable, uuid, text, jsonb, boolean, integer, timestamp, index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, locations } from './tenancy';
import { users } from './identity';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const orgCol = () => uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' });
const locCol = () => uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' });

/** 用户设备登录活跃会话 */
export const userDeviceSessions = pgTable('user_device_sessions', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  deviceLabel: text('device_label').notNull(),
  browser: text('browser'),
  os: text('os'),
  ipAddress: text('ip_address'),
  refreshTokenHash: text('refresh_token_hash'),
  isActive: boolean('is_active').notNull().default(true),
  lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [
  index('user_device_sessions_user_idx').on(t.userId, t.isActive),
]);

/** 个人多渠道通知偏好 (应用内、短信、邮件) */
export const userNotificationPreferences = pgTable('user_notification_preferences', {
  userId: uuid('user_id').notNull().primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  inApp: jsonb('in_app').notNull().default(sql`'{"appointmentNew": true, "appointmentChanged": true, "appointmentCancelled": true, "paymentFailed": true, "customerFeedback": true, "payoutSettled": true, "systemSecurity": true}'::jsonb`),
  sms: jsonb('sms').notNull().default(sql`'{"appointmentNew": true, "appointmentChanged": false, "emergencyAlerts": true}'::jsonb`),
  email: jsonb('email').notNull().default(sql`'{"dailyDigest": true, "financialReports": true, "securityAlerts": true}'::jsonb`),
  updatedAt: updatedAt(),
});

/** 应用内通知消息表 */
export const inAppNotifications = pgTable('in_app_notifications', {
  id: id(),
  orgId: orgCol(),
  locationId: locCol(),
  recipientUserId: uuid('recipient_user_id').references(() => users.id, { onDelete: 'cascade' }),
  category: text('category').notNull(), // 'bookings' | 'operations' | 'customers' | 'system'
  level: text('level').notNull().default('info'), // 'info' | 'warning' | 'error' | 'success'
  title: text('title').notNull(),
  titleKey: text('title_key'),
  message: text('message').notNull(),
  read: boolean('read').notNull().default(false),
  readAt: timestamp('read_at', { withTimezone: true }),
  actionType: text('action_type'), // 'appointment' | 'ticket' | 'queue' | 'customer' | 'settings'
  actionTargetId: text('action_target_id'),
  actionUrl: text('action_url'),
  meta: jsonb('meta').default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('in_app_notif_loc_read_idx').on(t.locationId, t.recipientUserId, t.read),
  index('in_app_notif_created_idx').on(t.createdAt),
]);
