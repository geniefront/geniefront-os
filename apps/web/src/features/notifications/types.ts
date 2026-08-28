export type NotificationCategory = 'bookings' | 'operations' | 'customers' | 'system';

export type NotificationLevel = 'info' | 'warning' | 'error' | 'success';

export interface NotificationItem {
  id: string;
  category: NotificationCategory;
  level: NotificationLevel;
  titleKey?: string;
  title: string;
  message: string;
  createdAt: string;
  read: boolean;
  actionUrl?: string;
  actionType?: 'appointment' | 'ticket' | 'queue' | 'customer' | 'settings';
  actionTargetId?: string;
  meta?: {
    customerName?: string;
    serviceName?: string;
    staffName?: string;
    amountDollars?: number;
    ticketId?: string;
    appointmentId?: string;
    customerId?: string;
  };
}

export interface NotificationFilterOptions {
  category?: NotificationCategory | 'all';
  unreadOnly?: boolean;
  searchQuery?: string;
}

export interface NotificationStats {
  total: number;
  unread: number;
  bookingsUnread: number;
  operationsUnread: number;
  customersUnread: number;
  systemUnread: number;
}
