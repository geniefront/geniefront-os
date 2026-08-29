import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

export type TechConnectionState = 'connecting' | 'live' | 'down';

export type TechDomainEventType =
  | 'ticket.assigned'
  | 'ticket.changed'
  | 'rotation.changed'
  | 'appointment.changed'
  | 'dayclose.changed'
  | 'shift.changed';

export interface TechDomainEvent {
  type: TechDomainEventType;
  entityId?: string;
  membershipId?: string;
  businessDate?: string;
}

export interface TechRealtimeHandle {
  channel: RealtimeChannel;
  close: () => void;
}

/**
 * Subscribe to the tenant-private location channel. Broadcast payloads never
 * become UI data; callers only use them to invalidate the authorized snapshot.
 */
export function subscribeToTechLocation(args: {
  locationId: string;
  membershipId: string;
  name: string;
  accessToken: string;
  onEvent: (event: TechDomainEvent) => void;
  onState: (state: TechConnectionState) => void;
}): TechRealtimeHandle {
  supabase.realtime.setAuth(args.accessToken);

  const channel = supabase.channel(`location:${args.locationId}`, {
    config: {
      private: true,
      presence: { key: args.membershipId },
    },
  });

  channel.on('broadcast', { event: '*' }, (message) => {
    const event = (message as { payload?: TechDomainEvent }).payload;
    if (event?.type) args.onEvent(event);
  });

  args.onState('connecting');
  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      args.onState('live');
      void channel.track({
        membershipId: args.membershipId,
        name: args.name,
        client: 'tech',
        at: Date.now(),
      });
      return;
    }
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      args.onState('down');
    }
  });

  return {
    channel,
    close: () => {
      void supabase.removeChannel(channel);
    },
  };
}
