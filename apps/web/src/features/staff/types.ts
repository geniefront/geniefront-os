import type { PlanKind, CommissionBase } from '../payroll/types';

export interface StaffDirectoryItem {
  id: string;
  membershipId: string;
  employeeNo: string;
  isBookable: boolean;
  maxConcurrentAppointments: number;
  name: string;
  phone: string;
  email?: string;
  jobTitle: string;
  jobTitleId: string | null;
  level: string;
  levelId: string | null;
  skills: string[];
  skillIds: string[];
  status: 'active' | 'on_leave' | 'resigned';
  hireDate: string;
  payroll: {
    kind: PlanKind;
    ratePercent: number;
    hourlyRateDollars: number;
    base: CommissionBase;
  } | null;
  note?: string;
}

export interface SaveStaffProfileInput {
  membershipId?: string;
  idempotencyKey?: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  employeeNo?: string;
  jobTitle?: string;
  jobTitleId?: string | null;
  level?: string;
  levelId?: string | null;
  skills?: string[];
  skillIds?: string[];
  status?: 'active' | 'on_leave' | 'resigned' | 'suspended' | 'left';
  hireDate?: string;
  note?: string;
  isBookable?: boolean;
  maxConcurrentAppointments?: number;
  inRotation?: boolean;
  payroll?: {
    kind: PlanKind;
    ratePercent: number;
    hourlyRateDollars: number;
    base: CommissionBase;
  };
}

export interface SetEmploymentInput {
  membershipId: string;
  status: 'active' | 'on_leave' | 'resigned' | 'suspended' | 'left';
}

export interface DirectoryOption { id: string; key: string; name: string; active: boolean; sort: number }
