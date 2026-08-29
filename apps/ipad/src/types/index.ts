export type Language = 'zh-Hans' | 'en' | 'ko' | 'es' | 'vi';

export interface KioskServiceDto {
  id: string;
  name: Record<string, string>;
  durationMin: number;
  basePriceCents?: number;
  isAddon?: boolean;
}

export interface KioskDeviceConfig {
  requireSignature: boolean;
  requireHealthAllergies: boolean;
  requirePressurePreference: boolean;
  requireBodySorenessMap: boolean;
  autoCreateCrmProfile: boolean;
  autoPromptTipPercentages: boolean;
  suggestedTipPercentages: number[];
}

export interface KioskHelloResponse {
  deviceLabel: string;
  terminalType: string | null;
  locationName: Record<string, string>;
  timezone: string;
  businessDate: string;
  services: KioskServiceDto[];
  addons?: KioskServiceDto[];
  deviceConfig: KioskDeviceConfig;
}

export interface AppointmentMatchDto {
  appointmentId: string;
  maskedName: string;
  startsAt: string;
  alreadyQueued: boolean;
}

export interface CheckInLookupResponse {
  businessDate: string;
  matches: AppointmentMatchDto[];
}

export interface GuestIntake {
  id: string;
  name: string;
  phone: string;
  email?: string;
  serviceId: string | null;
  addonIds: string[];
  isFormSubmitted?: boolean;
  submissionId?: string;
}

export interface QueueJoinResult {
  queueId: string;
  ticketNumber: number;
  aheadCount: number;
  quotedWaitMin: number | null;
  businessDate: string;
}

export interface QueueStatusResponse {
  ticketNumber: number;
  status: string;
  aheadCount: number;
  quotedWaitMin: number | null;
}

export interface FormQuestionDto {
  id: string;
  type: 'bool' | 'text' | 'choice' | 'multi';
  label: Record<string, string>;
  options?: { value: string; label: Record<string, string> }[];
  required?: boolean;
  hidden?: boolean;
  sync?: 'avoid_areas' | 'health_flag';
}

export interface KioskFormTemplateDto {
  templateId: string;
  key: string;
  version: number;
  title: Record<string, string>;
  questions: FormQuestionDto[];
  requiresSignature: boolean;
}

export interface KioskRequiredFormsResponse {
  forms: KioskFormTemplateDto[];
}

export interface SubmitFormPayload {
  templateId: string;
  appointmentId?: string;
  queueId?: string;
  answers: Record<string, unknown>;
  signatureDataUrl?: string;
  signerName: string;
  signerRelation: 'self' | 'guardian';
  locale: Language;
  idempotencyKey: string;
}

export interface SubmitFormResult {
  submissionId: string;
  expiresOn: string | null;
}

export interface DeviceCommandDto {
  commandId: string;
  kind: 'wake' | 'reset_home';
  createdAt: string;
}

export interface DeviceHeartbeatResponse {
  serverTime: string;
  commands: DeviceCommandDto[];
}

export interface ClaimPairingResponse {
  deviceToken: string;
  deviceId: string;
  orgId: string;
  locationId: string;
  terminalType: string;
}
