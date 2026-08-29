import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/lib/session';
import { techKeys, useTechTodayQuery } from '../api';
import { playTaskChime } from './audio';
import { readTechSoundEnabled } from './preferences';
import {
  subscribeToTechLocation,
  type TechConnectionState,
  type TechDomainEvent,
} from './realtime';

export function useTechRealtime(): {
  connection: TechConnectionState;
  assignmentFlash: boolean;
} {
  const queryClient = useQueryClient();
  const { membership, membershipId, session, isOnline } = useSession();
  const todayQuery = useTechTodayQuery();
  const [connection, setConnection] = useState<TechConnectionState>('connecting');
  const [assignmentFlash, setAssignmentFlash] = useState(false);
  const lastAlertAt = useRef(0);
  const flashTimer = useRef<number | null>(null);

  const refresh = useCallback(() => {
    if (!membershipId) return;
    void queryClient.invalidateQueries({ queryKey: techKeys.today(membershipId) });
  }, [membershipId, queryClient]);

  useEffect(() => {
    if (!isOnline) {
      setConnection('down');
      return undefined;
    }
    if (!membership || !membershipId || !session?.access_token || !todayQuery.data?.name) {
      setConnection('connecting');
      return undefined;
    }

    const handle = subscribeToTechLocation({
      locationId: membership.locationId,
      membershipId,
      name: todayQuery.data.name,
      accessToken: session.access_token,
      onState: setConnection,
      onEvent: (event: TechDomainEvent) => {
        const affectsMe = !event.membershipId || event.membershipId === membershipId;
        if (event.type === 'ticket.assigned' && !affectsMe) return;

        if (event.type === 'ticket.assigned' && Date.now() - lastAlertAt.current > 1_500) {
          lastAlertAt.current = Date.now();
          if (readTechSoundEnabled()) playTaskChime();
          setAssignmentFlash(true);
          if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
          flashTimer.current = window.setTimeout(() => setAssignmentFlash(false), 4_000);
        }
        refresh();
      },
    });

    return () => handle.close();
  }, [
    isOnline,
    membership,
    membershipId,
    session?.access_token,
    todayQuery.data?.name,
    refresh,
  ]);

  useEffect(() => {
    const reconcile = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', reconcile);
    window.addEventListener('online', refresh);
    return () => {
      document.removeEventListener('visibilitychange', reconcile);
      window.removeEventListener('online', refresh);
    };
  }, [refresh]);

  useEffect(() => () => {
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
  }, []);

  return { connection, assignmentFlash };
}
