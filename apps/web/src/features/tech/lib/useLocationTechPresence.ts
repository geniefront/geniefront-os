import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/lib/session';

/** Read-only front-desk projection of technician app presence. */
export function useLocationTechPresence(): ReadonlySet<string> {
  const { membership, session, isOnline } = useSession();
  const [onlineIds, setOnlineIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (!isOnline || !membership || !session?.access_token) {
      setOnlineIds(new Set());
      return undefined;
    }
    void supabase.realtime.setAuth(session.access_token);
    const channel = supabase.channel(`location:${membership.locationId}`, {
      config: { private: true },
    });
    const sync = () => {
      const next = new Set<string>();
      for (const presences of Object.values(channel.presenceState())) {
        for (const raw of presences) {
          const presence = raw as unknown as { membershipId?: unknown; client?: unknown };
          if (presence.client === 'tech' && typeof presence.membershipId === 'string') {
            next.add(presence.membershipId);
          }
        }
      }
      setOnlineIds(next);
    };
    channel.on('presence', { event: 'sync' }, sync).subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [isOnline, membership, session?.access_token]);

  return onlineIds;
}
