import type { Language } from '@/i18n';

export interface UserProfileData {
  userId: string;
  email: string;
  fullName: string;
  nickname?: string;
  phone?: string;
  avatarUrl?: string;
  locale: Language;
  timezone: string;
  bio?: string;
  createdAt: string;
  // Staff info if linked
  staffInfo?: {
    membershipId: string;
    employeeNo?: string;
    jobTitle?: string;
    levelName?: string;
    skills: string[];
    skillIds: string[];
    skillDirectory: Array<{ id: string; name: string; active: boolean }>;
    isBookable: boolean;
    maxConcurrentAppointments: number;
    inRotation: boolean;
    hasPin: boolean;
  };
}

export interface UpdateUserProfileInput {
  fullName?: string;
  nickname?: string;
  phone?: string | null;
  avatarUrl?: string;
  locale?: Language;
  bio?: string;
  isBookable?: boolean;
  maxConcurrentAppointments?: number;
  skillIds?: string[];
  skills?: string[];
}

export interface ChangePasswordInput {
  oldPassword?: string;
  newPassword: string;
}

export interface SetPinInput {
  pin: string; // 4-6 digits
}

export interface UserSessionItem {
  id: string;
  deviceLabel: string;
  browser: string;
  os: string;
  ipAddress?: string;
  lastActiveAt: string;
  createdAt: string;
  isCurrent: boolean;
}

export interface PersonalNotificationPreferences {
  inApp: {
    appointmentNew: boolean;
    appointmentChanged: boolean;
    appointmentCancelled: boolean;
    paymentFailed: boolean;
    customerFeedback: boolean;
    payoutSettled: boolean;
    systemSecurity: boolean;
  };
  sms: {
    appointmentNew: boolean;
    appointmentChanged: boolean;
    emergencyAlerts: boolean;
  };
  email: {
    dailyDigest: boolean;
    financialReports: boolean;
    securityAlerts: boolean;
  };
}
