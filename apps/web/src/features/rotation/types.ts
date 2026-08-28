/**
 * 技师轮牌类型定义。
 *
 * 与服务端 `GET /v1/desk/rotation` 及 `rotation.*` 命令严格对齐。
 */

export type RotationEntryState = 'available' | 'on_break' | 'in_service' | 'off' | 'not_arrived';

export interface SkillItem {
  id: string;
  key: string;
  name: string;
}

export interface RotationTrailEvent {
  at: string;
  reason: string;
  turns: number;
  note: string | null;
}

export interface FullRotationEvent {
  id: string;
  membershipId: string;
  staffName: string;
  reason: string;
  deltaTurns: number;
  at: string;
  note: string | null;
  actorId: string | null;
}

export interface RotationEntry {
  membershipId: string;
  name: string;
  turns: number;
  owed: number;
  state: RotationEntryState;
  position: number | null;
  manualRank: number | null;
  why: string | string[];
  skills: SkillItem[];
  levelName?: string | null;
  arrivedAt: string | null;
  leftAt: string | null;
  trail: RotationTrailEvent[];
}

export interface RotationPolicy {
  enabled: boolean;
  carryOverNextDay: boolean;
  startingMode: 'clock_in_order' | 'designated_staff' | 'carry_over' | 'balanced';
  startingStaffMembershipId: string | null;
  requestCountsAsTurn: boolean;
  skipNoSkill: 'no_penalty' | 'counts_as_turn';
  owedTurnPriority: boolean;
  onBreak: 'off_rotation' | 'stay_in_place';
}

export interface RotationStanding {
  businessDate: string;
  todayDate?: string;
  policy: RotationPolicy;
  nextUpMembershipId: string | null;
  entries: RotationEntry[];
  fullEvents?: FullRotationEvent[];
}

export type RotationOverrideReason =
  | 'guest_requested'
  | 'staff_on_break'
  | 'desk_coordination'
  | 'skill_mismatch'
  | 'owed_makeup'
  | 'other';

export interface RotationReorderInput {
  membershipId: string;
  toPosition: number;
  reason: RotationOverrideReason;
  note?: string;
}

export interface RotationSkipInput {
  membershipId: string;
  kind: 'no_skill' | 'off';
  note?: string;
}

export interface RotationSetBreakInput {
  membershipId: string;
  onBreak: boolean;
  note?: string;
}

export interface RotationCheckInInput {
  membershipId: string;
  note?: string;
}

export interface RotationCheckOutInput {
  membershipId: string;
  note?: string;
}

export interface RotationUpdatePolicyInput {
  enabled?: boolean;
  carryOverNextDay?: boolean;
  startingMode?: 'clock_in_order' | 'designated_staff' | 'carry_over' | 'balanced';
  startingStaffMembershipId?: string | null;
  requestCountsAsTurn?: boolean;
  skipNoSkill?: 'no_penalty' | 'counts_as_turn';
  owedTurnPriority?: boolean;
  onBreak?: 'off_rotation' | 'stay_in_place';
}

export interface RotationAssignInput {
  membershipId: string;
  isRequest?: boolean;
  amountCents?: number;
  customerName?: string;
  note?: string;
}
