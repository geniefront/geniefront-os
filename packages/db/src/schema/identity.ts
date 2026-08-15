/**
 * 身份 / 员工 / 权限（02-DATA-MODEL §2）
 *
 * users 全局唯一，memberships 是「这个人在这家店的身份」。
 * 一个技师在两家不同老板的店上班 = 两条 membership，分属两个 org，互相看不见。
 */

import {
  pgTable, uuid, text, jsonb, boolean, integer, timestamp, date, index, uniqueIndex, primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, locations } from './tenancy.js';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** 与 Supabase Auth 的 auth.users 一一对应（id 相同） */
export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: text('email'),
  phone: text('phone'),
  fullName: text('full_name'),
  locale: text('locale').notNull().default('en'),
  avatarUrl: text('avatar_url'),
  createdAt: createdAt(),
});

export const memberships = pgTable('memberships', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  /** null = org 级身份（多店老板） */
  locationId: uuid('location_id').references(() => locations.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  employmentType: text('employment_type').notNull().default('w2'), // w2|1099_booth
  status: text('status').notNull().default('active'),              // active|suspended|left
  startedOn: date('started_on'),
  endedOn: date('ended_on'),
  createdAt: createdAt(),
}, (t) => [
  index('memberships_user_idx').on(t.userId, t.status),
  index('memberships_location_idx').on(t.locationId, t.status),
]);

export const roles = pgTable('roles', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  locationId: uuid('location_id').references(() => locations.id),
  key: text('key').notNull(),
  name: jsonb('name').notNull(),
  isPreset: boolean('is_preset').notNull().default(false),
});

export const rolePermissions = pgTable('role_permissions', {
  roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  permission: text('permission').notNull(),
}, (t) => [primaryKey({ columns: [t.roleId, t.permission] })]);

/** 多对多 —— 一人多角色（店长兼技师）天生支持（01 §5.1） */
export const membershipRoles = pgTable('membership_roles', {
  membershipId: uuid('membership_id').notNull().references(() => memberships.id, { onDelete: 'cascade' }),
  roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.membershipId, t.roleId] })]);

export const permissionOverrides = pgTable('permission_overrides', {
  membershipId: uuid('membership_id').notNull().references(() => memberships.id, { onDelete: 'cascade' }),
  permission: text('permission').notNull(),
  allow: boolean('allow').notNull(),
}, (t) => [primaryKey({ columns: [t.membershipId, t.permission] })]);

export const staffLevels = pgTable('staff_levels', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  key: text('key').notNull(),
  name: jsonb('name').notNull(),
  sort: integer('sort').notNull().default(0),
  /** 等级差异化三维之一：同一项目高级技师收更高价（00 §3.0） */
  priceModifierBp: integer('price_modifier_bp').notNull().default(10000),
  /** 多人服务时的小费加权系数。10000 = 1.0x */
  tipWeightBp: integer('tip_weight_bp').notNull().default(10000),
});

/**
 * staff_profiles 挂在 membership 上而不是 user 上：
 * 同一个人在 A 店叫 Amy 等级 Master、在 B 店叫阿美等级 Level 2，互不干扰。
 */
export const staffProfiles = pgTable('staff_profiles', {
  membershipId: uuid('membership_id').primaryKey().references(() => memberships.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  displayName: jsonb('display_name').notNull(),
  levelId: uuid('level_id').references(() => staffLevels.id),
  gender: text('gender'),
  bio: jsonb('bio'),
  languages: text('languages').array().notNull().default(sql`'{}'::text[]`),
  hireDate: date('hire_date'),
  pinHash: text('pin_hash'),
  photoUrl: text('photo_url'),
  /** ⭐ 店长/前台/老板也接客时打开。决定是否出现在日程表列里、能否被排单。 */
  isBookable: boolean('is_bookable').notNull().default(false),
  /** ⭐ 技师并发上限。默认 1；美甲店可设 2（做手时脚在泡水/等干）。软约束。 */
  maxConcurrentAppointments: integer('max_concurrent_appointments').notNull().default(1),
  bookableOnline: boolean('bookable_online').notNull().default(false),
  color: text('color'),
}, (t) => [
  index('staff_profiles_location_idx').on(t.locationId, t.isBookable),
]);

export const skills = pgTable('skills', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  key: text('key').notNull(),
  name: jsonb('name').notNull(),
});

export const staffSkills = pgTable('staff_skills', {
  membershipId: uuid('membership_id').notNull().references(() => memberships.id, { onDelete: 'cascade' }),
  skillId: uuid('skill_id').notNull().references(() => skills.id, { onDelete: 'cascade' }),
  proficiency: integer('proficiency').notNull().default(1),
}, (t) => [primaryKey({ columns: [t.membershipId, t.skillId] })]);

/** 共享 iPad：设备令牌换门店级会话，技师再输 PIN 切身份。PIN 不能远程登录。 */
export const deviceTokens = pgTable('device_tokens', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  label: text('label').notNull(),
  tokenHash: text('token_hash').notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('device_tokens_hash_idx').on(t.tokenHash),
]);

/** 记住上次进的店，多店身份的人登录后直接进 */
export const userLastLocation = pgTable('user_last_location', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});
