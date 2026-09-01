/**
 * 把这家店待发的邮件发掉。
 *
 * ⭐ **只扫自己这家店**（`where location_id = …`）。跨租户的定时扫描
 * 需要一个能看到所有店的连接，而 `apps/` 拿不到（宪法第 5 条，CI 会拦）——
 * 和「不做跨租户自动续充扫描」是同一条。
 *
 * 触发点挂在这家店自己的动作后面：建单之后、结账之后。
 * 一封信发不出去，最坏情况是等这家店下一次操作时补发；
 * 再不济前台打个电话 —— 不值得为它引一个队列。
 *
 * ⚠️ 整个函数**吞掉所有异常**。它永远在业务事务提交之后跑，
 * 这时候业务已经成了；这里抛出去只会把一个成功的操作显示成失败。
 */

import { withTenant, emailSuppressedSet, normalizeSuppressionEmail } from '@gf/db';
import { sendEmail, emailConfigured } from './send';
import type { FastifyBaseLogger } from 'fastify';

/** 一次最多发几封。发不完的下次接着来 —— 别让一个请求卡在发信上 */
const BATCH = 5;
/** 试这么多次还不成就不再试了。避免一个坏地址永远占着队首 */
const MAX_ATTEMPTS = 3;

export async function flushEmails(
  tenant: { orgId: string; locationId: string; membershipId: string | null },
  log?: FastifyBaseLogger,
): Promise<void> {
  if (!emailConfigured()) return;

  try {
    const rows = await withTenant(tenant, (tx) => tx<{
      id: string; to_email: string; subject: string;
      body_html: string; body_text: string; attempts: number;
      unsubscribe_url: string | null; from_email: string | null;
    }[]>`
      select id, to_email, subject, body_html, body_text, attempts,
             unsubscribe_url, from_email
      from email_outbox
      where location_id = ${tenant.locationId}
        and status = 'pending' and attempts < ${MAX_ATTEMPTS}
      order by created_at
      limit ${BATCH}`);

    if (rows.length === 0) return;

    /**
     * ⭐ 发之前**统一查一次抑制名单**（0091）。
     *
     * 与短信侧的退订判定同一个位置、同一条理由：入队的那一刻这个地址
     * 可能还是好的，而两者之间隔着几秒到几分钟。硬退过或投诉过的地址
     * 再发一次，扣的是**发信域名的信誉** —— 而信誉掉下去之后受损的是所有
     * 门店的事务性邮件送达率，那件事没有任何人会来投诉。
     */
    const suppressed = await emailSuppressedSet(rows.map((r) => r.to_email));

    for (const r of rows) {
      if (suppressed.has(normalizeSuppressionEmail(r.to_email))) {
        /*
         * ⚠️ `failed` 而不是 `sent`。这一封确实没发出去，而把它记成成功
         * 会让「发信成功率」这个数字永远难看不了，掩盖真正的投递故障。
         *
         * 也不留在 pending：抑制是永久的，留着只会让补发扫描每一轮都
         * 重新捡起它。
         */
        await withTenant(tenant, (tx) => tx`
          update email_outbox
          set status = 'failed', last_error = 'suppressed',
              attempts = attempts + 1
          where id = ${r.id}`);
        log?.info({ outboxId: r.id }, 'email suppressed: bounced or complained before');
        continue;
      }

      /*
       * ⚠️ 退订地址在**入队时**就已算好并存进 outbox（0086）。
       * 在此处现拼的话，令牌会多经手一遍，而它只应被拼一次。
       */
      const res = await sendEmail({
        to: r.to_email, subject: r.subject, html: r.body_html, text: r.body_text,
        unsubscribeUrl: r.unsubscribe_url,
        from: r.from_email,
      });

      await withTenant(tenant, (tx) => {
        if (res.ok) {
          // ⭐ captured ≠ sent：capture 模式下这封**没有真的发出去**。
          // 混成 sent 的话，staging 上「发信成功率」会是一个假的 100%，
          // 而真正的投递故障就藏在这个 100% 底下（sql/0082）
          return tx`
            update email_outbox
            set status = ${res.captured ? 'captured' : 'sent'},
                sent_at = now(), provider_id = ${res.providerId ?? null},
                attempts = attempts + 1
            where id = ${r.id}`;
        }
        // 4xx（地址不合法、域名没验证）重试多少次都一样 —— 直接标死，
        // 否则一个打错的邮箱会在每次补发里都重试，永远占着队首
        const dead = res.permanent || r.attempts + 1 >= MAX_ATTEMPTS;
        return tx`
          update email_outbox
          set status = ${dead ? 'failed' : 'pending'},
              attempts = attempts + 1, last_error = ${res.error ?? null}
          where id = ${r.id}`;
      });

      if (!res.ok) log?.warn({ outboxId: r.id, error: res.error }, 'email send failed');
    }
  } catch (e) {
    // ⚠️ 吞掉。业务事务已经提交了，这里抛出去只会把一个成功的操作显示成失败。
    log?.warn({ err: e }, 'flushEmails failed');
  }
}
