/**
 * 技师在线状态（Phase 1c，01 §6）。
 *
 * 前台看板上那个绿点回答的是一个很具体的问题：
 * **「我派给她，她手机上会响吗？」**
 *
 * 灰点不代表人不在店里 —— 只代表这一端收不到推送，
 * 所以前台该口头喊一声（Desk-Only 模式本来就是这么跑的，宪法第 14 条）。
 * 界面文案必须说清这一点，否则前台会以为技师翘班了。
 *
 * 顺带订阅同一个频道的领域事件，让前台的轮牌板/在做的单也能秒级刷新 ——
 * 一个连接干两件事，不为「在线点」单开一条。
 */

import { supabase } from './supabase';

export type ConnState = 'connecting' | 'live' | 'down';

export interface PresenceHandle {
  close: () => void;
}

export function watchLocation(args: {
  locationId: string;
  accessToken: string;
  /** 在线的 membershipId 集合变化时回调 */
  onPresence: (online: Set<string>) => void;
  /** 收到任何领域事件 —— 前台据此刷新看板 */
  onEvent: (type: string) => void;
  onState: (s: ConnState) => void;
}): PresenceHandle {
  supabase.realtime.setAuth(args.accessToken);

  const channel = supabase.channel(`location:${args.locationId}`, {
    config: { private: true, presence: { key: 'desk' } },
  });

  const sync = () => {
    const state = channel.presenceState<{ membershipId?: string }>();
    const online = new Set<string>();
    for (const entries of Object.values(state)) {
      for (const e of entries) if (e.membershipId) online.add(e.membershipId);
    }
    args.onPresence(online);
  };

  channel.on('presence', { event: 'sync' }, sync);
  channel.on('presence', { event: 'join' }, sync);
  channel.on('presence', { event: 'leave' }, sync);
  channel.on('broadcast', { event: '*' }, (msg) => {
    const type = (msg as { payload?: { type?: string } }).payload?.type;
    if (type) args.onEvent(type);
  });

  args.onState('connecting');
  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      args.onState('live');
      // 前台自己也报个到，但不带 membershipId —— 它不该出现在"技师在线"里
      void channel.track({ desk: true, at: Date.now() });
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      args.onState('down');
    }
  });

  return { close: () => { void supabase.removeChannel(channel); } };
}
