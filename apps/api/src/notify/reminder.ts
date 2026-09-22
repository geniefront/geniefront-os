/**
 * 次日预约提醒（2026-09-01 店主定，四类事务性通知之一）。
 *
 * ## 为什么此前不存在
 *
 * 批 7 建好了 `appointment_reminder` 这个事件键、模板表与规则表，`offset_min`
 * 那一列也存了值 —— 但**全仓没有任何代码读它**。也就是说提醒从来没有发过，
 * 而设置页上那个开关看起来是好的。
 *
 * ## 为什么在应用里定时，而不是 pg_cron
 *
 * 与 `ops/retention.ts` 同一个判断：托管实例上 `pg_cron` 不一定开着，而
 * 「上线时忘了开扩展」是一种**静默**失败 —— 提醒不发，没有人会收到通知。
 * 放在应用里，跑没跑得起来、发了多少条，日志里都看得见。
 *
 * ## 跨租户扫描怎么绕开 RLS
 *
 * 取件走 SECURITY DEFINER 函数 `gf_appointments_due_for_reminder()`
 * （sql/0088），它只返回「哪几单该提醒了」；真正写发件箱仍要按门店
 * `withTenant` 进去。应用侧**没有**能看见所有租户的写权限（宪法第 5 条）。
 *
 * ## 判定口径在 SQL 里，不在这里
 *
 * 「门店本地日期意义上的明天」「本地时间过了 18 点」「这一单排过没有」
 * 三条都在那个函数里。放在应用里的话，每加一个调用方就要把三条判据
 * 再实现一遍，而其中任何一条写错都表现为「有些店的顾客收不到提醒」。
 */

import type { FastifyInstance } from 'fastify';
import { sql, withTenant } from '@gf/db';
import type { CommandContext } from '@gf/contracts';
import { bookingSummary } from './bookingSummary';
import { notifyEvent } from './dispatch';
import { guestManageLink, manageUrlVar } from './manageUrl';
import { appointmentServiceLabel } from './appointmentServiceLabel';
import { flushSms } from '../sms/flush';
import { flushEmails } from '../email/flush';
import { formatWhen } from '../email/render';
import { pickText } from '@gf/contracts';

/** 门店本地时间过了这个点才发。整天平摊的话，凌晨两点会给顾客发短信。 */
const DEFAULT_SEND_HOUR = 18;
/** 一轮最多处理多少单。发不完的下一轮接着来 —— 别让一次运行跑几分钟。 */
const DEFAULT_BATCH = 200;
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

interface DueRow { org_id: string; location_id: string; appointment_id: string }

/**
 * 跑一轮：取件 → 按门店渲染入队 → 投递。
 *
 * 返回真正入队了几条通知（不是几单）。
 */
export async function runReminderSweep(
  app: FastifyInstance,
  opts: { sendHour?: number; limit?: number } = {},
): Promise<number> {
  const sendHour = opts.sendHour ?? DEFAULT_SEND_HOUR;
  const limit = opts.limit ?? DEFAULT_BATCH;

  const due = await sql<DueRow[]>`
    select * from gf_appointments_due_for_reminder(${sendHour}, ${limit})`;
  if (due.length === 0) return 0;

  /*
   * 按门店分组：`withTenant` 一次只进一个租户，而同一家店的多单可以共用
   * 一次事务。跨店混在一起逐单开事务的话，一百单就是一百次上下文切换。
   */
  const byLocation = new Map<string, DueRow[]>();
  for (const row of due) {
    const list = byLocation.get(row.location_id);
    if (list) list.push(row);
    else byLocation.set(row.location_id, [row]);
  }

  let queued = 0;
  for (const [locationId, rows] of byLocation) {
    const tenant = { orgId: rows[0]!.org_id, locationId, membershipId: null };
    try {
      queued += await withTenant(tenant, async (tx) => {
        let n = 0;
        for (const row of rows) {
          n += await enqueueOneReminder(tx, tenant, row.appointment_id);
        }
        return n;
      });

      /*
       * ⚠️ 投递在事务之外。事务里发的话，回滚之后顾客已经收到一条提醒，
       * 而发件箱里没有那一行（与确认信同一条纪律）。
       */
      void flushSms(tenant, app.log);
      void flushEmails(tenant, app.log);
    } catch (e) {
      // 一家店失败不该拖垮整轮。下一轮会重新取到这几单（尚未入队即未去重）
      app.log.warn({ err: e, locationId }, 'appointment reminder: 该门店本轮失败');
    }
  }

  return queued;
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * 单张预约的提醒入队。
 *
 * ⚠️ 变量全部按英语取值、时间用英文短格式 —— 顾客侧的邮件与短信恒为英语
 * （`email/render.ts` 文件头），而同一组变量会同时喂给两个渠道。
 */
async function enqueueOneReminder(
  tx: Tx,
  tenant: { orgId: string; locationId: string },
  appointmentId: string,
): Promise<number> {
  // The scan is only a hint. Serialize with mutations and recheck the date
  // after acquiring the row lock so a cancelled/moved booking cannot enqueue
  // a stale reminder between the sweep and rendering.
  const [current] = await tx`select a.id from appointments a
    join locations l on l.id = a.location_id
    where a.id = ${appointmentId} and a.location_id = ${tenant.locationId}
      and a.status = 'booked'
      and (a.starts_at at time zone l.timezone)::date
          = ((now() at time zone l.timezone)::date + 1)
    for update of a`;
  if (!current) return 0;

  const [row] = await tx<{
    email: string | null; phone: string | null; customer_name: unknown;
    shop_name: unknown; timezone: string; slug: string; service_name: unknown;
    staff_name: unknown; starts_at: string;
    manage_token_digest: string | null;
    manage_token_wrapped: Buffer | Uint8Array | null;
  }[]>`
    select c.email, c.phone_e164 as phone, c.display_name as customer_name,
           l.name as shop_name, l.timezone, l.slug,
           s.name as service_name, case when ai.is_request then sp.display_name else null end as staff_name,
           a.starts_at::text as starts_at,
           a.manage_token_digest, a.manage_token_wrapped
    from appointments a
    join locations l on l.id = a.location_id
    left join appointment_items ai
           on ai.appointment_id = a.id and ai.status <> 'cancelled'
    left join customers c on c.id = a.customer_id
    left join services s on s.id = ai.service_id
    left join staff_profiles sp on sp.membership_id = ai.membership_id
    where a.id = ${appointmentId}
    limit 1`;
  if (!row) return 0;

  const [line] = await tx<{ e164: string }[]>`
    select coalesce(nullif(trim(l.phone), ''), (select e164 from phone_lines where location_id=l.id and purpose='main' and active limit 1)) as e164
    from locations l where l.id = ${tenant.locationId}`;

  const serviceLabel = await appointmentServiceLabel(
    tx, tenant.locationId, appointmentId, pickText(row.service_name, 'en', ''));

  const vars = {
    customer_name: pickText(row.customer_name, 'en', ''),
    shop_name: pickText(row.shop_name, 'en', ''),
    service_name: serviceLabel,
    staff_name: row.staff_name ? pickText(row.staff_name, 'en', '') : '',
    when: formatWhen(new Date(row.starts_at).toISOString(), row.timezone, 'en-US'),
    shop_phone: line?.e164 ?? '',
    manage_url: manageUrlVar(guestManageLink({
      shopSlug: row.slug,
      wrapped: row.manage_token_wrapped,
      digest: row.manage_token_digest,
    })),
  };

  /*
   * `membershipId: null` —— 定时任务背后没有人。硬塞一个真实 membership
   * 会让审计流水指向某位前台，而她什么都没做过（与 Stripe webhook 一致）。
   */
  const ctx: CommandContext = {
    orgId: tenant.orgId,
    locationId: tenant.locationId,
    userId: '00000000-0000-4000-8000-000000000000',
    membershipId: null,
    permissions: new Set<string>(),
    actorKind: 'api',
    locale: 'en',
    timezone: row.timezone,
  } as CommandContext;

  return notifyEvent(tx, ctx, {
    event: 'appointment_reminder',
    emailDetails: await bookingSummary(tx,tenant.locationId,appointmentId),
    entityType: 'appointment',
    entityId: appointmentId,
    vars,
    toEmail: row.email,
    toPhone: row.phone,
    locale: 'en',
  });
}

export function startReminderJob(app: FastifyInstance): void {
  const sendHour = Number(process.env['APPOINTMENT_REMINDER_HOUR'] ?? DEFAULT_SEND_HOUR);
  const intervalMs = Number(process.env['APPOINTMENT_REMINDER_INTERVAL_MS'] ?? DEFAULT_INTERVAL_MS);

  const run = async (): Promise<void> => {
    try {
      const queued = await runReminderSweep(app, { sendHour });
      /*
       * 发了 0 条也记一句。这条日志的用途是回答「提醒到底有没有在跑」——
       * 只在发出东西时才记的话，那个问题就没有答案了（与 retention 一致）。
       */
      app.log.info({ queued, sendHour }, 'appointment reminder sweep');
    } catch (e) {
      app.log.warn({ err: e }, 'appointment reminder sweep failed');
    }
  };

  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
}
