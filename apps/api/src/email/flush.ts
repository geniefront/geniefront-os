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

import { withTenant } from '@gf/db';
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
    }[]>`
      select id, to_email, subject, body_html, body_text, attempts
      from email_outbox
      where location_id = ${tenant.locationId}
        and status = 'pending' and attempts < ${MAX_ATTEMPTS}
      order by created_at
      limit ${BATCH}`);

    for (const r of rows) {
      const res = await sendEmail({
        to: r.to_email, subject: r.subject, html: r.body_html, text: r.body_text,
      });

      await withTenant(tenant, (tx) => {
        if (res.ok) {
          return tx`
            update email_outbox
            set status = 'sent', sent_at = now(), provider_id = ${res.providerId ?? null},
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
