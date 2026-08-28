/**
 * Kiosk 门口端的命令实现（Phase 2）
 *
 * 两条贯穿全篇的纪律：
 *
 * 1. **前台能代做每一件事**（宪法第 14 条）。每条命令都接受
 *    `source: 'kiosk' | 'desk'`，代做留痕，没有 iPad 的店照常跑。
 * 2. **健康表的答案在进库之前已经是密文**（02 §5）。审计里也不留内容 ——
 *    留「谁在什么时候签了哪一版」就够了，再存一份明文等于白加密。
 */

import { randomUUID } from 'node:crypto';
import {
  IssueDeviceToken, RevokeDeviceToken, JoinQueue, UpdateQueueEntry,
  SaveFormTemplate, SubmitForm, ShareForm, RevokeFormShare,
  AppError, ERROR_CODES, pickText,
} from '@gf/contracts';
import { jsonb, ts } from '@gf/db';
import { businessDateOf } from '@gf/scheduling';
import { registerHandler, type HandlerArgs } from '../bus';
import { generateDeviceToken, hashDeviceToken } from '../kiosk/deviceAuth';
import { loadFormKey, encryptAnswers, ENC_ALG } from '../kiosk/crypto';
import { generateFormToken, hashFormToken, formShareUrl } from '../forms/token';
import { qrSvg } from '../forms/qr';
import { renderFormInvite, formatWhen } from '../email/render';
import type postgres from 'postgres';

/** 门店此刻的营业日 */
async function currentDate(tx: postgres.TransactionSql, locationId: string): Promise<string> {
  const [loc] = await tx<{ tz: string; cutoff: string }[]>`
    select timezone as tz, business_day_cutoff::text as cutoff
    from locations where id = ${locationId}`;
  return businessDateOf(new Date(), loc!.tz, loc!.cutoff);
}

// ─────────────────────────────────────────────────────────── 设备配对

registerHandler(IssueDeviceToken, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof IssueDeviceToken.input._type>) => {
  const token = generateDeviceToken();

  const [row] = await tx<{ id: string }[]>`
    insert into device_tokens (org_id, location_id, label, token_hash)
    values (${ctx.orgId}, ${ctx.locationId}, ${input.label}, ${hashDeviceToken(token)})
    returning id`;

  // ⚠️ 审计里只留「配了一台叫什么的设备」。令牌本身连摘要都不记 ——
  // audit_log 是给人翻的，翻的人不该有机会看到任何和令牌沾边的东西
  audit({ entityType: 'device', entityId: row!.id, after: { label: input.label } });

  // 明文只在这一次返回里存在。之后库里只有摘要
  return { deviceId: row!.id, token };
});

registerHandler(RevokeDeviceToken, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof RevokeDeviceToken.input._type>) => {
  const rows = await tx<{ id: string; label: string }[]>`
    update device_tokens set revoked_at = now()
    where id = ${input.deviceId} and location_id = ${ctx.locationId} and revoked_at is null
    returning id, label`;
  if (rows.length === 0) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'device' } });
  }

  audit({ entityType: 'device', entityId: input.deviceId,
          after: { revoked: true, label: rows[0]!.label } });
  return { deviceId: input.deviceId };
});

// ─────────────────────────────────────────────────────────── 走单队列

registerHandler(JoinQueue, async ({ input, ctx, tx, audit, emit }: HandlerArgs<
  typeof JoinQueue.input._type>) => {
  const businessDate = await currentDate(tx, ctx.locationId);
  let customerId = input.customerId ?? null;

  if (input.appointmentId) {
    const [appointment] = await tx<{
      id: string; customer_id: string | null; status: string; business_date: string;
    }[]>`
      select id, customer_id, status, business_date::text as business_date
      from appointments
      where id = ${input.appointmentId} and location_id = ${ctx.locationId}
      for update`;
    if (!appointment) {
      throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'appointment' } });
    }
    if (appointment.status === 'cancelled' || appointment.status === 'done') {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'appointment_not_checkinable', status: appointment.status },
      });
    }
    if (appointment.business_date !== businessDate) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'appointment_not_today', appointmentBusinessDate: appointment.business_date },
      });
    }
    if (input.customerId && input.customerId !== appointment.customer_id) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'appointment_customer_mismatch' },
      });
    }
    const [existing] = await tx<{ id: string }[]>`
      select id from walkin_queue
      where appointment_id = ${appointment.id} and status <> 'left'
      limit 1`;
    if (existing) {
      throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
        details: { reason: 'appointment_already_queued', queueId: existing.id },
      });
    }
    customerId = appointment.customer_id;
  }

  // ⚠️ 先锁住这家店今天的队列，再取下一个号。
  //
  // 不锁的话，两个人同时在 Kiosk 上点「取号」会拿到同一个号 ——
  // 唯一索引会挡住其中一个，但客人看到的是一个莫名其妙的错误。
  // 这里用 advisory lock 而不是锁表：只锁「这家店的今天」，
  // 别的店同时取号互不影响。
  await tx`select pg_advisory_xact_lock(
    hashtext(${`queue:${ctx.locationId}:${businessDate}`}))`;

  const [maxRow] = await tx<{ n: number | null }[]>`
    select max(ticket_number) as n from walkin_queue
    where location_id = ${ctx.locationId} and business_date = ${businessDate}`;
  const ticketNumber = (maxRow?.n ?? 0) + 1;

  // 前面还有几位 —— 客人最想知道的就是这个数
  const [ahead] = await tx<{ n: string }[]>`
    select count(*) as n from walkin_queue
    where location_id = ${ctx.locationId} and business_date = ${businessDate}
      and status = 'waiting'`;
  const aheadCount = Number(ahead!.n);

  /**
   * 估等待时间。
   *
   * 刻意做得很笨：**前面人数 × 一个粗略的平均时长 ÷ 在岗人数**。
   * 不去查排期算精确值，因为 walk-in 的等待本来就取决于
   * 「下一个做完的人什么时候做完」，那是个前台看一眼就知道、
   * 而系统算不准的数。给一个明显是估的数，比给一个精确但错的数好 ——
   * 客人会拿它当承诺。
   */
  const [onDuty] = await tx<{ n: string }[]>`
    select count(*) as n from shifts s
    join staff_profiles sp on sp.membership_id = s.membership_id
    where s.location_id = ${ctx.locationId} and s.business_date = ${businessDate}
      and s.status = 'published' and sp.is_bookable = true`;
  const staffCount = Math.max(1, Number(onDuty!.n));
  const quotedWaitMin = aheadCount === 0 ? 0 : Math.ceil((aheadCount * 40) / staffCount / 5) * 5;

  /*
   * ⭐ 点名的技师和项目要**先验存在、且属于这家店**。
   *
   * 不验的话有两种坏法：
   *   · id 打错 → 撞 `walkin_queue_requested_staff_id_memberships_id_fk`，
   *     整条命令抛出去是一个 **500 INTERNAL**。前端看到的是「系统炸了」，
   *     而真相是「这个技师不存在」—— 一个它自己能修的错
   *   · id 是**同一个 org 里另一家店**的人 → 外键查得到（它只认 memberships.id，
   *     不认 location），于是这条 walk-in 点了一个今天不在这家店的技师，
   *     一直到前台准备派单才发现
   *
   * ⚠️ `requestedStaffId` 是 **membership id**（`staff_profiles` 的主键就是
   * `membership_id`，它没有自己的 id 列）。日程快照 `staff[].membershipId`
   * 里那个值可以直接传进来。
   */
  if (input.requestedStaffId) {
    const [ok] = await tx<{ membership_id: string }[]>`
      select membership_id from staff_profiles
      where membership_id = ${input.requestedStaffId} and location_id = ${ctx.locationId}`;
    if (!ok) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        details: { entity: 'staff', requestedStaffId: input.requestedStaffId },
      });
    }
  }
  if (input.requestedServiceId) {
    const [ok] = await tx<{ id: string }[]>`
      select id from services
      where id = ${input.requestedServiceId} and location_id = ${ctx.locationId}`;
    if (!ok) {
      throw new AppError(ERROR_CODES.NOT_FOUND, {
        details: { entity: 'service', requestedServiceId: input.requestedServiceId },
      });
    }
  }

  const [row] = await tx<{ id: string }[]>`
    insert into walkin_queue
      (org_id, location_id, business_date, ticket_number, customer_id, walk_in_name,
       requested_service_id, requested_staff_id, party_size, appointment_id,
       quoted_wait_min, source)
    values (${ctx.orgId}, ${ctx.locationId}, ${businessDate}, ${ticketNumber},
            ${customerId}, ${input.walkInName ?? null},
            ${input.requestedServiceId ?? null}, ${input.requestedStaffId ?? null},
            ${input.partySize}, ${input.appointmentId ?? null},
            ${quotedWaitMin}, ${input.source})
    returning id`;

  if (input.appointmentId) {
    await tx`update appointments set status = 'checked_in'
             where id = ${input.appointmentId}`;
  }

  audit({
    entityType: 'queue', entityId: row!.id,
    after: {
      ticketNumber, businessDate, source: input.source,
      partySize: input.partySize, aheadCount,
    },
  });

  // 前台那块屏上的队列要当场跳 —— 客人还站在门口
  emit({ type: 'queue.changed', entityId: row!.id, businessDate });

  return { queueId: row!.id, ticketNumber, aheadCount, quotedWaitMin, businessDate };
});

registerHandler(UpdateQueueEntry, async ({ input, ctx, tx, audit, emit }: HandlerArgs<
  typeof UpdateQueueEntry.input._type>) => {
  const [cur] = await tx<{ id: string; status: string; business_date: string }[]>`
    select id, status, business_date::text from walkin_queue
    where id = ${input.queueId} and location_id = ${ctx.locationId}`;
  if (!cur) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'queue' } });

  // 走了必须有原因。「等太久走的」是老板最该看到的数 ——
  // 它直接对应流失，而不强制的话没人会填
  if (input.status === 'left' && !input.leftReason) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'left_reason_required' },
    });
  }

  await tx`
    update walkin_queue set
      status = ${input.status},
      called_at = ${input.status === 'called' ? tx`coalesce(called_at, now())` : tx`called_at`},
      seated_at = ${input.status === 'seated' ? tx`coalesce(seated_at, now())` : tx`seated_at`},
      left_at   = ${input.status === 'left'   ? tx`now()` : tx`left_at`},
      left_reason = ${input.leftReason ?? null}
    where id = ${input.queueId}`;

  audit({
    entityType: 'queue', entityId: input.queueId,
    before: { status: cur.status },
    after: { status: input.status, leftReason: input.leftReason ?? null },
  });
  emit({ type: 'queue.changed', entityId: input.queueId, businessDate: cur.business_date });

  return { queueId: input.queueId, status: input.status };
});

// ─────────────────────────────────────────────────── 健康表 / 同意书

registerHandler(SaveFormTemplate, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SaveFormTemplate.input._type>) => {
  // 改内容 = 发新版本。已发布的那一版不可改（sql/0016 的触发器兜底）——
  // submissions 指着「他当时签的第几版」，就地改会让证据链断掉
  const [prev] = await tx<{ v: number }[]>`
    select max(version) as v from form_templates
    where location_id = ${ctx.locationId} and key = ${input.key}`;
  const version = (prev?.v ?? 0) + 1;

  // 老版本下架，但**留着** —— 历史签名还指向它
  await tx`
    update form_templates set active = false
    where location_id = ${ctx.locationId} and key = ${input.key}`;

  const [row] = await tx<{ id: string }[]>`
    insert into form_templates
      (org_id, location_id, key, version, title, schema,
       requires_signature, valid_days, service_ids, published_at, active)
    values (${ctx.orgId}, ${ctx.locationId}, ${input.key}, ${version},
            ${jsonb(input.title)}::jsonb, ${jsonb(input.questions)}::jsonb,
            ${input.requiresSignature}, ${input.validDays},
            ${jsonb(input.serviceIds)}::jsonb, now(), true)
    returning id`;

  audit({
    entityType: 'form_template', entityId: row!.id,
    after: {
      key: input.key, version,
      title: pickText(input.title, ctx.locale),
      questionCount: input.questions.length,
      requiresSignature: input.requiresSignature,
      validDays: input.validDays,
    },
  });
  return { templateId: row!.id, version };
});

registerHandler(SubmitForm, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SubmitForm.input._type>) => {
  const [tpl] = await tx<{
    id: string; version: number; requires_signature: boolean;
    valid_days: number | null; schema: unknown; key: string;
  }[]>`
    select id, version, requires_signature, valid_days, schema, key
    from form_templates
    where id = ${input.templateId} and location_id = ${ctx.locationId}`;
  if (!tpl) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'form_template' } });

  // 必答题没答就退回。**在这里挡而不是只靠前端** ——
  // 「怀孕了吗」漏答和答「否」在法律上完全不是一回事
  const questions = (tpl.schema ?? []) as FormQuestion[];
  const missing = questions
    .filter((q) => q.required && (input.answers[q.id] === undefined || input.answers[q.id] === null))
    .map((q) => q.id);
  if (missing.length > 0) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'required_answers_missing', missing },
    });
  }

  if (tpl.requires_signature && !input.signatureDataUrl) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'signature_required' },
    });
  }

  // ⭐ 加密之后才落库。密钥在环境变量，库被拖走也拿不到健康数据（02 §5）
  const key = loadFormKey(process.env['FORM_ENCRYPTION_KEY']);
  const encrypted = encryptAnswers(input.answers, key);

  const expiresOn = tpl.valid_days === null
    ? null
    : new Date(Date.now() + tpl.valid_days * 86400_000).toISOString().slice(0, 10);

  const [row] = await tx<{ id: string }[]>`
    insert into form_submissions
      (org_id, location_id, customer_id, template_id, template_version,
       answers_encrypted, enc_alg,
       signature_url, signed_at, signer_name, signer_relation,
       ip, user_agent, locale, source, on_behalf_by, expires_on, share_link_id)
    values (${ctx.orgId}, ${ctx.locationId}, ${input.customerId ?? null},
            ${tpl.id}, ${tpl.version},
            ${encrypted}, ${ENC_ALG},
            ${input.signatureDataUrl ?? null},
            ${input.signatureDataUrl ? tx`now()` : null},
            ${input.signerName}, ${input.signerRelation},
            ${ctx.ip ?? null}, ${null}, ${input.locale}, ${input.source},
            ${input.source === 'desk' ? ctx.membershipId : null},
            ${expiresOn}::date, ${input.shareLinkId ?? null})
    returning id`;

  // ⭐ 回填客户档案（见下面那个函数的头注释：只搬部位和一个布尔）
  const synced = input.customerId
    ? await syncToProfile(tx, ctx, input.customerId, questions, input.answers)
    : null;

  /**
   * 审计里**不留内容**（命令的 auditRedact 已经抹了 answers 和签名图）。
   *
   * 留的是「谁、什么时候、签了哪一版、用哪种语言看的」—— 出事时要证明的
   * 恰恰是这几件；而再存一份明文答案，等于前面的加密白做了。
   */
  audit({
    entityType: 'form_submission', entityId: row!.id,
    after: {
      templateKey: tpl.key,
      templateVersion: tpl.version,
      signerRelation: input.signerRelation,
      // ⭐ 他当时看的是哪种语言 ——「我看不懂英文」是最常见的抗辩
      locale: input.locale,
      source: input.source,
      signed: Boolean(input.signatureDataUrl),
      expiresOn,
      // ⚠️ 只记「回填了几个部位、有没有置禁忌标记」，不记是哪些部位 ——
      // 部位本身也是健康信息的一半（「避开右膝」= 右膝有事）
      syncedAreas: synced?.areaCount ?? 0,
      syncedHealthFlag: synced?.healthFlag ?? false,
    },
  });

  return { submissionId: row!.id, expiresOn };
});

// ─────────────────────────────────────────── 健康表 → 客户档案（02 §5）

interface FormQuestion {
  id: string;
  type?: 'bool' | 'text' | 'choice' | 'multi';
  required?: boolean;
  /** 见 contracts 里 SaveFormTemplate 的注释：只有两个去处，都不搬明细 */
  sync?: 'avoid_areas' | 'health_flag';
}

/**
 * 把健康表里**够做事的那一点点**回填进客户档案。
 *
 * ## 为什么必须有这一步
 *
 * 02 §5 要求健康表和落单要素**双向关联**：客人在表里勾了「近期手术 · 右膝」，
 * 开单时那个部位就该已经在「避开」里了。不这么做的话，这张表在临床上
 * 等于没填 —— 签完就沉到一张加密表里，而真正要用它的是三十分钟后
 * 站在床边、没有 `customer.view_health_form` 权限的技师。
 *
 * ## ⚠️ 但**只搬两样东西**，明细一个字都不出加密表
 *
 *   · `profile.avoid_areas`  哪几块别按。**操作信息**，不是诊断 ——
 *     「避开右膝」和「他右膝做过手术」在泄露风险上不是一回事
 *   · `profile.health_flag`  一个布尔。前台和技师看到的永远是
 *     「有禁忌，见前台」（02 §3.1 那张表最后一列写的就是这句）
 *
 * 「怀孕 28 周」「血栓史」「正在服用抗凝药」这些字**只存在于
 * `form_submissions.answers_encrypted` 里**，要看得有
 * `customer.view_health_form`，而且看一眼就留一条 `form_access_log`。
 *
 * ## ⚠️ 只并不减
 *
 * 这次没勾的部位**不会**把上次勾的抹掉：客人这次填的是脸部护理那张表，
 * 上面根本没有「膝盖」这一题 —— 拿它去覆盖，等于让一次无关的填表
 * 悄悄解除了一条真实的禁忌。要去掉得由人在客户档案里动手。
 */
async function syncToProfile(
  tx: postgres.TransactionSql,
  ctx: { orgId: string },
  customerId: string,
  questions: FormQuestion[],
  answers: Record<string, unknown>,
): Promise<{ areaCount: number; healthFlag: boolean }> {
  const areas = new Set<string>();
  let healthFlag = false;

  for (const q of questions) {
    if (!q.sync) continue;
    const a = answers[q.id];
    if (a === undefined || a === null || a === '') continue;

    /**
     * ⚠️ **「以上都没有」不是一个答案，是没有答案。**
     *
     * 模板库里每一道多选题最后都有一个 `none` 选项 —— 客人勾了它，
     * 数组是非空的，但他说的恰恰是「我没有这些情况」。
     * 不在这里剔掉的话，**认真勾了「以上都没有」的人会被标成有禁忌**，
     * 而那个标记很快就会因为满屏都是而被前台无视 —— 于是真有禁忌的
     * 那一位也跟着看不见了。
     */
    const values = (Array.isArray(a) ? a : [a])
      .filter((v) => v !== 'none' && v !== 'no');

    if (q.sync === 'avoid_areas') {
      // multi 是数组，choice 是一个字符串。两种都收
      for (const v of values) {
        if (typeof v === 'string' && v.length > 0 && v.length <= 40) areas.add(v);
      }
    } else {
      // ⚠️ `false` 和空数组同样**不是**「有禁忌」
      const has = Array.isArray(a) ? values.length > 0 : a !== false;
      if (has) healthFlag = true;
    }
  }

  if (areas.size === 0 && !healthFlag) return { areaCount: 0, healthFlag: false };

  await tx`
    insert into customer_preferences (customer_id, org_id, profile)
    values (${customerId}, ${ctx.orgId}, '{}'::jsonb)
    on conflict (customer_id) do nothing`;

  /**
   * jsonb 里**就地**合并，不读回来改再写回去 —— 客人在门口 iPad 上交表的
   * 同时，前台可能正在改这一行的偏好；读-改-写会把其中一边整个吞掉。
   */
  if (areas.size > 0) {
    await tx`
      update customer_preferences
      set profile = profile || jsonb_build_object('avoid_areas', (
            select coalesce(jsonb_agg(distinct v), '[]'::jsonb) from (
              select jsonb_array_elements_text(
                       coalesce(profile -> 'avoid_areas', '[]'::jsonb)) as v
              union
              select unnest(${[...areas]}::text[])
            ) t))
      where customer_id = ${customerId}`;
  }

  if (healthFlag) {
    await tx`
      update customer_preferences
      set profile = profile || '{"health_flag": true}'::jsonb
      where customer_id = ${customerId}`;
  }

  return { areaCount: areas.size, healthFlag };
}

/** 供路由生成幂等键 —— Kiosk 那台 iPad 的网常常是店里最差的 */
export const kioskIdempotencyKey = (prefix: string): string => `${prefix}-${randomUUID()}`;

// ───────────────────────────────────────────────── 把表发给客人（`docs/15`）

registerHandler(ShareForm, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof ShareForm.input._type>) => {
  if (input.channel === 'email' && !input.email) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'email_required_for_email_channel' },
    });
  }

  /**
   * 要签哪几份。
   *
   * ⚠️ 没点名就取**当前在用的全部**，而不是「上次发的那几份」——
   * 老板刚加了一份新的免责书，前台不该因为用的是同一个按钮而漏掉它。
   */
  const rows = input.templateIds.length > 0
    ? await tx<{ id: string; title: unknown }[]>`
        select id, title from form_templates
        where location_id = ${ctx.locationId} and active
          and id in ${tx(input.templateIds)}`
    : await tx<{ id: string; title: unknown }[]>`
        select id, title from form_templates
        where location_id = ${ctx.locationId} and active
          and published_at is not null
        order by created_at`;

  if (rows.length === 0) {
    // 一条打开是空白的链接比没有链接更糟：客人以为自己填过了
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'no_active_form_templates' },
    });
  }

  const token = generateFormToken();
  const expiresAt = new Date(Date.now() + input.expiresInHours * 3600_000);

  const [row] = await tx<{ id: string }[]>`
    insert into form_share_links
      (org_id, location_id, customer_id, appointment_id, template_ids,
       token_hash, channel, sent_to, locale, created_by, expires_at)
    values (${ctx.orgId}, ${ctx.locationId},
            ${input.customerId ?? null}, ${input.appointmentId ?? null},
            ${jsonb(rows.map((r) => r.id))}::jsonb,
            ${hashFormToken(token)}, ${input.channel},
            ${input.channel === 'email' ? input.email! : null},
            ${input.locale}, ${ctx.membershipId}, ${ts(expiresAt)}::timestamptz)
    returning id`;

  let emailQueued = false;
  if (input.channel === 'email') {
    const [shop] = await tx<{ name: unknown; tz: string }[]>`
      select name, timezone as tz from locations where id = ${ctx.locationId}`;
    const [line] = await tx<{ e164: string }[]>`
      select e164 from phone_lines
      where location_id = ${ctx.locationId} and purpose = 'main' and active limit 1`;
    const [cust] = input.customerId
      ? await tx<{ display_name: string }[]>`
          select display_name from customers where id = ${input.customerId}`
      : [];

    /**
     * ⚠️ 渲染发生在**这一刻**（业务事务里），不是发信的时候 ——
     * 和预约确认信同一条纪律：outbox 那一行**就是那封信本身**。
     * 而这里还多一层：信里带着令牌，发信时再拼一次等于把令牌
     * 多经手一遍，而它只该被拼一次。
     */
    const msg = renderFormInvite({
      customerName: cust?.display_name ?? '您好',
      shopName: pickText(shop!.name, input.locale, ''),
      formTitles: rows.map((r) => pickText(r.title, input.locale, '健康表')),
      url: formShareUrl(token),
      expiresText: formatWhen(expiresAt.toISOString(), shop!.tz),
      shopPhone: line?.e164 ?? null,
    });

    await tx`
      insert into email_outbox
        (org_id, location_id, kind, to_email, subject, body_html, body_text,
         entity_type, entity_id)
      values (${ctx.orgId}, ${ctx.locationId}, 'form_invite', ${input.email!},
              ${msg.subject}, ${msg.html}, ${msg.text},
              'form_share', ${row!.id})
      on conflict (entity_type, entity_id, kind) do nothing`;
    emailQueued = true;
  }

  /**
   * 审计留「发过一条、发的哪几份、发到哪个渠道」。
   * ⚠️ 邮箱由命令的 `auditRedact` 抹掉，令牌连摘要都不记 ——
   * audit_log 是给人翻的，翻的人不该有机会看到任何和令牌沾边的东西。
   */
  audit({
    entityType: 'form_share', entityId: row!.id,
    after: {
      channel: input.channel,
      templateCount: rows.length,
      customerId: input.customerId ?? null,
      expiresAt: expiresAt.toISOString(),
      locale: input.locale,
    },
  });

  return {
    shareId: row!.id,
    // 明文只在这一次返回里存在。之后库里只有摘要
    token,
    url: formShareUrl(token),
    qrSvg: await qrSvg(formShareUrl(token)),
    expiresAt: expiresAt.toISOString(),
    emailQueued,
  };
});

registerHandler(RevokeFormShare, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof RevokeFormShare.input._type>) => {
  const rows = await tx<{ id: string }[]>`
    update form_share_links set revoked_at = now()
    where id = ${input.shareId} and location_id = ${ctx.locationId} and revoked_at is null
    returning id`;
  if (rows.length === 0) {
    throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'form_share' } });
  }
  audit({ entityType: 'form_share', entityId: input.shareId, after: { revoked: true } });
  return { shareId: input.shareId };
});
