/**
 * 实时感知层（01 §6，决策 13）。
 *
 * 订阅 `location:{id}` 私有频道。授权走 Realtime 自己的 RLS 策略
 * （sql/0011），别的店的频道会被服务端明确拒绝 —— 不是我们在前端判断。
 *
 * 事件里只有 id + 类型，没有业务数据。收到之后重新拉那条有 RLS 的读接口，
 * 而不是直接把事件里的东西显示出来。
 */

import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';

export type EventType =
  | 'ticket.assigned' | 'ticket.changed' | 'rotation.changed'
  | 'appointment.changed' | 'dayclose.changed' | 'shift.changed';

export interface DomainEvent {
  type: EventType;
  entityId?: string;
  membershipId?: string;
  businessDate?: string;
}

export type ConnState = 'connecting' | 'live' | 'down';

export interface RealtimeHandle {
  channel: RealtimeChannel;
  close: () => void;
}

/**
 * 订阅本店频道 + 加入 presence（前台看板据此显示在线绿点）。
 *
 * @param onEvent 收到任何领域事件时调用。调用方负责 invalidate 查询。
 * @param onState 连接状态变化。断线时界面要变，而不是假装还连着 ——
 *        「看起来正常但其实收不到派单」是这一层最坏的失败模式。
 */
export function subscribeLocation(args: {
  locationId: string;
  membershipId: string;
  name: string;
  accessToken: string;
  onEvent: (e: DomainEvent) => void;
  onState: (s: ConnState) => void;
}): RealtimeHandle {
  supabase.realtime.setAuth(args.accessToken);

  const channel = supabase.channel(`location:${args.locationId}`, {
    config: {
      private: true,
      presence: { key: args.membershipId },
    },
  });

  channel.on('broadcast', { event: '*' }, (msg) => {
    const payload = (msg as { payload?: DomainEvent }).payload;
    if (payload?.type) args.onEvent(payload);
  });

  args.onState('connecting');
  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      args.onState('live');
      // presence：告诉前台「我在线」。只报 id 和名字，不报位置不报别的
      void channel.track({ membershipId: args.membershipId, name: args.name, at: Date.now() });
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      args.onState('down');
    }
  });

  return {
    channel,
    close: () => { void supabase.removeChannel(channel); },
  };
}
