export interface CallLine {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  startSeconds?: number;
  endSeconds?: number;
  speaker?: number;
  at?: string;
  tool?: string;
}

export interface CallView {
  callId: string;
  fromE164: string | null;
  startedAt: string | null;
  durationSeconds: number | null;
  aiDurationSeconds?: number | null;
  outcome: string | null;
  toolsUsed: string[];
  booked: boolean;
  appointmentIds?: string[];
  appointmentActions?: Array<{appointmentId:string;action:string;outcome:string}>;
  recordingUrl: string | null;
  recordingId?: string | null;
  billingStatus?: string;
  billableSeconds?: number | null;
  summary?: string | null;
  transcript: CallLine[];
}

export interface CallsQueryResponse {
  total?: number;
  voiceNumber?: string | null;
  calls: CallView[];
  bookedCount: number;
  totalMinutes: number;
}

export interface CallDraftView {
  draftId: string;
  status: string;
  fromE164: string | null;
  fromDisplay: string | null;
  createdAt: string;
  service: { heard: string | null; matchedId: string | null; matchedName: string | null };
  staff: { heard: string | null; matchedId: string | null; matchedName: string | null };
  time: { heard: string | null; slotStartsAt: string | null; durationMin: number | null };
  customer: { id: string | null; displayName: string | null } | null;
  candidates: Array<{ customerId: string; displayName: string; lastVisitOn: string | null }>;
  callerNameHeard: string | null;
  confidenceBp: number;
  lowConfidence: boolean;
  notes: string | null;
  readyToBook: boolean;
  missing: string[];
}

export interface CallDraftsQueryResponse {
  drafts: CallDraftView[];
  pendingCount: number;
}

export interface InboundSms {
  id: string;
  fromE164: string;
  body: string;
  intent: string;
  receivedAt: string;
  customers: Array<{ id: string; name: string }>;
  upcoming: Array<{ appointmentId: string; startsAt: string }>;
}

export interface InboundSmsQueryResponse {
  messages: InboundSms[];
  needsAttention: number;
}

export type DraftDismissReason =
  | "wrong_service"
  | "wrong_time"
  | "wrong_staff"
  | "not_a_booking"
  | "duplicate"
  | "customer_cancelled"
  | "spam"
  | "other";

export interface SendDirectSmsInput {
  toE164: string;
  body: string;
  customerId?: string;
  mediaUrls?: string[];
}