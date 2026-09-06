export type RoomType = 'room' | 'chair' | 'table' | 'bed' | 'sofa' | 'vip' | 'station' | string;
export type RoomStatus = 'available' | 'in_service' | 'cleaning' | 'maintenance';

export interface RoomSession {
  ticketItemId?: string;
  appointmentId: string | null;
  ticketId: string | null;
  customerName: string;
  staffNames: string[];
  serviceName: string;
  startedAt: string | null;
  estimatedEndAt: string | null;
  progressMinutes: number;
  totalMinutes: number;
}

export interface UpcomingSession {
  appointmentId: string;
  customerName: string;
  staffName: string;
  serviceName: string;
  startsAt: string;
  startsInMinutes: number;
  durationMin: number;
}

export interface TimelineSlot {
  id: string;
  appointmentId: string;
  customerName: string;
  staffName: string;
  serviceName: string;
  startsAt: string;
  endsAt: string;
  status: string;
}

export interface RoomMetrics {
  total: number;
  available: number;
  inService: number;
  cleaning: number;
  maintenance: number;
  occupancyRate: number;
}

export interface RoomItem {
  id: string;
  name: string;
  type: string;
  typeKey: string;
  capacity: number;
  maxStaff?: number | null;
  status: RoomStatus;
  active?: boolean;
  currentSession?: RoomSession | null;
  currentSessions?: RoomSession[];
  occupiedCount?: number;
  rawStatus?: string;
  waitingCleaningCount?: number;
  cleaningCount?: number;
  upcomingSession?: UpcomingSession | null;
  todaySlots?: TimelineSlot[];
}

export interface RoomsQueryResponse {
  rooms: RoomItem[];
  metrics?: RoomMetrics;
}

export interface SetResourceStatusInput {
  resourceId: string;
  status: RoomStatus;
  note?: string;
  guestName?: string;
  serviceName?: string;
}

export interface SaveResourceInput {
  resourceId?: string;
  name: string;
  type: string;
  capacity?: number;
  maxStaff?: number | null;
  active?: boolean;
}
