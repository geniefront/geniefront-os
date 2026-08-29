export interface TechServiceNote {
  authorMembershipId: string;
  visibility: 'management' | 'assigned_staff';
  content: string;
  containsSensitiveData: boolean;
  updatedAt: string;
}

/**
 * The bedside-safe task projection returned by `/v1/staff/me/today`.
 * Contact masking and health-form redaction are server responsibilities.
 */
export interface TechTask {
  ticketId: string;
  ticketItemId: string;
  customerName: string;
  customerPhone: string | null;
  serviceName: string;
  durationMin: number;
  resourceName: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  state: 'waiting' | 'in_service' | 'done';
  isRequest: boolean;
  details: Array<{ key: string; label: string; value: string }>;
  alerts: string[];
  customerLocale: string | null;
  note: string | null;
  serviceNotes: TechServiceNote[];
  tip: {
    cashCents: number;
    cardCents: number;
    directCashCents: number;
    status: 'awaiting_checkout' | 'no_tip' | 'received_direct' | 'awaiting_payout' | 'settled';
    editable: boolean;
  };
}

export interface TechToday {
  businessDate: string;
  membershipId: string;
  name: string;
  current: TechTask | null;
  next: TechTask | null;
  tasks: TechTask[];
  doneCount: number;
  onDuty: boolean;
  workedMinutes: number;
  rotation: {
    position: number | null;
    isNextUp: boolean;
    onBreak: boolean;
  };
  earnings: {
    serviceRevenueCents: number;
    commissionCents: number;
    tipCashCents: number;
    tipCardCents: number;
    payCents: number;
    cashTipOwedCents: number;
  };
}

export type PunchKind = 'clock_in' | 'clock_out' | 'break_start' | 'break_end';

export interface TechRosterShift {
  membershipId: string;
  businessDate: string;
  startMin: number;
  endMin: number;
  breakMin: number;
  status: 'planned' | 'published' | 'off';
  offReason: string | null;
  note: string | null;
  fromTemplate: boolean;
  realMinutes: number;
}

export interface TechRoster {
  fromDate: string;
  toDate: string;
  dates: string[];
  timezone: string;
  staff: Array<{ membershipId: string; name: string; isBookable: boolean }>;
  shifts: TechRosterShift[];
  templates: Array<{
    membershipId: string;
    weekday: number;
    startMin: number;
    endMin: number;
    breakMin: number;
  }>;
  totals: Array<{ membershipId: string; minutes: number }>;
  hasUnpublished: boolean;
}
