/**
 * 通话对账：把 Telnyx 那边的 conversation 补进 `phone_calls`。
 *
 * ## 它补的是什么洞
 *
 * 挂机 webhook 可能永远不来（Telnyx 的 connection 上可以单独配 webhook 地址，
 * 事件名也可能变）。而漏掉它的后果是**静默**的：
 *
 *   · 没记通话时长 → 没扣客户的语音分钟 → 月底账对不上，没有任何报错
 *   · 没有转录     → AI 在电话里答应了什么，谁也说不清
 *
 * 所以这条路不依赖任何 webhook：主动去问 Telnyx「最近有哪些通话」，
 * 逐条补。**幂等键用 conversation id**，和 webhook 那条腿写的是同一条命令
 * （`call.record`），谁先到都不会重复计费。
 *
 * ## 定位门店仍然只靠被叫号码
 *
 * conversation 的 `metadata.to` 就是店里那个号 —— 和电话工具走同一条路
 * （`tenantForPhoneNumber`）。反查不到的会话直接跳过：那可能是别人的
 * assistant，也可能是 Telnyx 控制台里的试听（`to` 是一串 sip 地址）。
 */

import { tenantForPhoneNumber } from '@gf/db';
import { dispatch } from '../bus';
import { billingSystemContext } from '../billing/autoTopup';
import { maybeAutoTopup } from '../billing/autoTopup';
import type { CommandContext, Permission } from '@gf/contracts';
import { listConversations, fetchTranscript, durationOf } from './conversations';
import '../handlers/phone';
import '../handlers/billing';

/** 和 telnyx/routes.ts 的系统上下文同一套，只是这里只用得到 call.draft */
const RECONCILE_PERMISSIONS: readonly Permission[] = ['call.draft'];

export interface ReconcileResult {
  scanned: number;
  recorded: number;
  skipped: number;
  failed: number;
}

/**
 * 拉一遍最近 `sinceMinutes` 分钟的通话并补账。
 *
 * @param log 出错要留痕 —— 这个任务失败是**静默漏账**，不记就没人知道
 */
export async function reconcileCalls(args: {
  sinceMinutes?: number;
  limit?: number;
  log?: { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void };
} = {}): Promise<ReconcileResult> {
  const apiKey = process.env['TELNYX_API_KEY'];
  const out: ReconcileResult = { scanned: 0, recorded: 0, skipped: 0, failed: 0 };
  if (!apiKey) {
    args.log?.warn({}, 'reconcileCalls: 没有 TELNYX_API_KEY，跳过');
    return out;
  }

  const since = new Date(Date.now() - (args.sinceMinutes ?? 180) * 60_000);
  const conversations = await listConversations(apiKey, { since, ...(args.limit ? { limit: args.limit } : {}) });
  out.scanned = conversations.length;

  for (const c of conversations) {
    // Telnyx 控制台里的试听、别人的 assistant —— `to` 不是一个 E.164 就不是我们的
    if (!c.toE164 || !/^\+[1-9]\d{7,14}$/.test(c.toE164)) { out.skipped++; continue; }

    const t = await tenantForPhoneNumber(c.toE164).catch(() => null);
    if (!t) { out.skipped++; continue; }

    try {
      const transcript = await fetchTranscript(apiKey, c.id);
      const ctx: CommandContext = {
        orgId: t.orgId,
        locationId: t.locationId,
        userId: '00000000-0000-4000-8000-000000000000',
        membershipId: null,
        permissions: new Set(RECONCILE_PERMISSIONS),
        actorKind: 'api',
        locale: (t.locale as CommandContext['locale']) ?? 'en',
        timezone: t.timezone,
      };

      /*
       * ⚠️ 幂等键用 **call_session_id**（拿不到才退回 conversation id）。
       *
       * webhook 那条腿用的就是 call_session_id —— 两条腿必须落在同一个键上，
       * 否则同一通电话会被记两遍，而那是直接给客户多收一份钱。
       */
      const providerCallId = c.callSessionId ?? c.id;

      await dispatch('call.record', {
        providerCallId,
        fromE164: c.fromE164 ?? undefined,
        toE164: c.toE164,
        startedAt: c.createdAt,
        endedAt: c.lastMessageAt ?? undefined,
        durationSeconds: durationOf(c),
        // 调过 book_appointment 的算「办成了事」；只查不订也算 completed ——
        // 「有没有订上」看 tools_used 就知道，不该塞进 outcome 这个维度
        outcome: 'completed',
      }, ctx, { idempotencyKey: `telnyx-hangup-${providerCallId}`, systemOrigin: 'telnyx_call' });

      /*
       * ⚠️ 补料必须是**另一条命令**：上面那条的幂等键和 webhook 那条腿
       * 是同一个，webhook 先到过的话它会命中缓存直接返回 ——
       * 处理器根本不执行，转录就永远写不进去。
       * 而换一个键去 dispatch `call.record` 会**再扣一次语音分钟**。
       */
      await dispatch('call.attachTranscript', {
        providerCallId,
        conversationId: c.id,
        transcript,
        toolsUsed: c.toolsUsed,
      }, ctx, { idempotencyKey: `telnyx-conv-${c.id}`, systemOrigin: 'telnyx_call' });

      out.recorded++;

      // 电话烧的是语音分钟那本账，补完账顺手看一眼要不要自动续充
      void maybeAutoTopup(billingSystemContext(ctx), 'voice_minute', args.log ?? console as never);
    } catch (e) {
      out.failed++;
      args.log?.warn({ conversationId: c.id, err: (e as Error).message },
        'reconcileCalls: 这一条补不进去');
    }
  }

  args.log?.info(out, 'reconcileCalls 完成');
  return out;
}
