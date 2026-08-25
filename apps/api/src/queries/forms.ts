/**
 * 健康表在**前台一侧**的读取（`docs/15` §5）。
 *
 * 这个文件和别的 queries/ 不一样的地方只有一处，但那一处是整块的核心：
 *
 * > **看一眼健康表本身就是一件要留痕的事。**
 *
 * 普通的 `audit_log` 只记写操作。健康数据不行 —— 02 §5 要求「读也审计」，
 * 所以 `readSubmission()` 每被调用一次就往 `form_access_log` 写一行：
 * 谁、什么时候、因为什么、从哪个 IP，看了谁的健康表。
 * 出了纠纷，这张表是**能自证清白**的东西（「我们没人翻过她的表」）。
 *
 * ## 三层权限，别混
 *
 *   · 列表（签过没有、什么时候到期）   `customer.read`
 *     —— 前台要知道「这位客人还得签一份」，这不需要看内容
 *   · 内容（他到底勾了什么）           `customer.view_health_form` ⭐ 留痕
 *   · 明细里的手机号等联系方式          另看 `customer.view_contact`
 *
 * 技师默认三条都没有（决策 16）。他在床边需要知道的是「避开右膝」，
 * 那一条已经由 `form.submit` 回填进客户档案了（handlers/kiosk.ts 的
 * `syncToProfile`），不需要读这张加密表。
 */

import type postgres from 'postgres';
import { AppError, ERROR_CODES, type CommandContext } from '@gf/contracts';
import { loadFormKey, decryptAnswers } from '../kiosk/crypto';

export interface FormTemplateView {
  templateId: string;
  key: string;
  version: number;
  title: Record<string, string>;
  questions: unknown[];
  requiresSignature: boolean;
  validDays: number | null;
  serviceIds: string[];
  publishedAt: string | null;
  /** 这一版被签过几次。老板改模板前要看得见「已经有 84 个人签了上一版」 */
  signedCount: number;
}

export interface FormSubmissionView {
  submissionId: string;
  templateId: string;
  templateKey: string;
  templateTitle: Record<string, string>;
  templateVersion: number;
  customerId: string | null;
  customerName: string | null;
  signerName: string | null;
  signerRelation: string;
  /** kiosk | desk | link */
  source: string;
  locale: string;
  signedAt: string | null;
  createdAt: string;
  expiresOn: string | null;
  /** 到期了就不算数 —— 「三年前签过一次」在法律上站不住 */
  expired: boolean;
  /** 客人要求删除之后：签过这个事实还在，内容没了 */
  anonymized: boolean;
  hasSignature: boolean;
}

export interface FormShareView {
  shareId: string;
  customerId: string | null;
  customerName: string | null;
  channel: string;
  /** 邮箱按 `customer.view_contact` 脱敏 */
  sentTo: string | null;
  templateCount: number;
  createdAt: string;
  expiresAt: string;
  openedAt: string | null;
  submittedAt: string | null;
  revokedAt: string | null;
  /** pending | opened | done | expired | revoked —— 前台只看这一个字段 */
  state: string;
}

/** 模板 + 已签 + 在外面飘着的链接，一次给全 —— 这一页只发一次请求 */
export async function loadForms(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  opts: { days?: number; limit?: number; customerId?: string } = {},
): Promise<{
  templates: FormTemplateView[];
  submissions: FormSubmissionView[];
  shares: FormShareView[];
  /** 能不能看内容。前端靠它决定「查看」按钮是不是灰的 */
  canViewContent: boolean;
}> {
  const days = Math.min(365, Math.max(1, opts.days ?? 30));
  const limit = Math.min(200, Math.max(1, opts.limit ?? 100));
  const canSeeContact = ctx.permissions.has('customer.view_contact');

  const templates = await tx<{
    id: string; key: string; version: number; title: unknown; schema: unknown;
    requires_signature: boolean; valid_days: number | null; service_ids: unknown;
    published_at: Date | string | null; signed_count: string;
  }[]>`
    select t.id, t.key, t.version, t.title, t.schema, t.requires_signature,
           t.valid_days, t.service_ids, t.published_at,
           (select count(*) from form_submissions s where s.template_id = t.id) as signed_count
    from form_templates t
    where t.location_id = ${ctx.locationId} and t.active
    order by t.key`;

  const subs = await tx<{
    id: string; template_id: string; template_key: string; template_title: unknown;
    template_version: number; customer_id: string | null; customer_name: string | null;
    signer_name: string | null; signer_relation: string; source: string; locale: string;
    signed_at: Date | string | null; created_at: Date | string;
    expires_on: string | null; anonymized_at: Date | string | null;
    has_signature: boolean;
  }[]>`
    select s.id, s.template_id, t.key as template_key, t.title as template_title,
           s.template_version, s.customer_id, c.display_name as customer_name,
           s.signer_name, s.signer_relation, s.source, s.locale,
           s.signed_at, s.created_at, s.expires_on::text as expires_on, s.anonymized_at,
           (s.signature_url is not null) as has_signature
    from form_submissions s
    join form_templates t on t.id = s.template_id
    left join customers c on c.id = s.customer_id
    where s.location_id = ${ctx.locationId}
      ${opts.customerId ? tx`and s.customer_id = ${opts.customerId}` : tx``}
      and s.created_at > now() - make_interval(days => ${days})
    order by s.created_at desc
    limit ${limit}`;

  const shares = await tx<{
    id: string; customer_id: string | null; customer_name: string | null;
    channel: string; sent_to: string | null; template_ids: unknown;
    created_at: Date | string; expires_at: Date | string;
    opened_at: Date | string | null; submitted_at: Date | string | null;
    revoked_at: Date | string | null;
  }[]>`
    select f.id, f.customer_id, c.display_name as customer_name, f.channel, f.sent_to,
           f.template_ids, f.created_at, f.expires_at, f.opened_at,
           f.submitted_at, f.revoked_at
    from form_share_links f
    left join customers c on c.id = f.customer_id
    where f.location_id = ${ctx.locationId}
      ${opts.customerId ? tx`and f.customer_id = ${opts.customerId}` : tx``}
      and f.created_at > now() - make_interval(days => ${days})
    order by f.created_at desc
    limit ${limit}`;

  const today = new Date().toISOString().slice(0, 10);

  return {
    canViewContent: ctx.permissions.has('customer.view_health_form'),
    templates: templates.map((t) => ({
      templateId: t.id,
      key: t.key,
      version: t.version,
      title: (t.title ?? {}) as Record<string, string>,
      questions: Array.isArray(t.schema) ? t.schema : [],
      requiresSignature: t.requires_signature,
      validDays: t.valid_days,
      serviceIds: Array.isArray(t.service_ids) ? t.service_ids as string[] : [],
      publishedAt: t.published_at ? new Date(t.published_at).toISOString() : null,
      signedCount: Number(t.signed_count),
    })),
    submissions: subs.map((s) => ({
      submissionId: s.id,
      templateId: s.template_id,
      templateKey: s.template_key,
      templateTitle: (s.template_title ?? {}) as Record<string, string>,
      templateVersion: s.template_version,
      customerId: s.customer_id,
      customerName: s.customer_name,
      signerName: s.signer_name,
      signerRelation: s.signer_relation,
      source: s.source,
      locale: s.locale,
      signedAt: s.signed_at ? new Date(s.signed_at).toISOString() : null,
      createdAt: new Date(s.created_at).toISOString(),
      expiresOn: s.expires_on,
      expired: Boolean(s.expires_on && s.expires_on < today),
      anonymized: s.anonymized_at !== null,
      hasSignature: s.has_signature,
    })),
    shares: shares.map((f) => ({
      shareId: f.id,
      customerId: f.customer_id,
      customerName: f.customer_name,
      channel: f.channel,
      // 邮箱也是联系方式 —— 和手机号同一条口径（决策 16 防挖客）
      sentTo: f.sent_to ? (canSeeContact ? f.sent_to : maskEmail(f.sent_to)) : null,
      templateCount: Array.isArray(f.template_ids) ? f.template_ids.length : 0,
      createdAt: new Date(f.created_at).toISOString(),
      expiresAt: new Date(f.expires_at).toISOString(),
      openedAt: f.opened_at ? new Date(f.opened_at).toISOString() : null,
      submittedAt: f.submitted_at ? new Date(f.submitted_at).toISOString() : null,
      revokedAt: f.revoked_at ? new Date(f.revoked_at).toISOString() : null,
      state: shareState(f),
    })),
  };
}

/**
 * ⭐ **打开一份已签的表。看一眼就留一条痕。**
 *
 * `reason` 是必填的，而且是个枚举：
 *
 *   · `service_prep`     马上要给他做，先看一眼禁忌 —— 九成是这条
 *   · `incident_review`  出事了，回头查
 *   · `customer_request` 客人自己要一份
 *   · `export`           打印 / 导出 PDF
 *
 * 为什么必填：一条只写「某某在周二下午看过」的日志，在纠纷里几乎没有用；
 * 而带着理由的那一条能回答「你们凭什么翻她的健康表」。
 * 让人在下拉框里选一下的成本，远小于事后解释不清的成本。
 *
 * ⚠️ **留痕先于返回内容**：先写日志再解密。反过来的话，一次解密到一半
 * 失败的读取就不会留下任何痕迹 —— 而那恰恰是最该留痕的一次。
 */
export async function readSubmission(
  tx: postgres.TransactionSql,
  ctx: CommandContext,
  submissionId: string,
  reason: string,
): Promise<{
  submissionId: string;
  templateTitle: Record<string, string>;
  templateVersion: number;
  questions: unknown[];
  answers: Record<string, unknown> | null;
  signerName: string | null;
  signerRelation: string;
  signatureUrl: string | null;
  signedAt: string | null;
  locale: string;
  source: string;
  ip: string | null;
  expiresOn: string | null;
  anonymized: boolean;
  customerName: string | null;
}> {
  if (!ctx.permissions.has('customer.view_health_form')) {
    throw new AppError(ERROR_CODES.PERMISSION_DENIED, {
      details: { need: 'customer.view_health_form' },
    });
  }

  const [row] = await tx<{
    id: string; template_version: number; title: unknown; schema: unknown;
    answers_encrypted: Buffer | null; enc_alg: string | null;
    signer_name: string | null; signer_relation: string; signature_url: string | null;
    signed_at: Date | string | null; locale: string; source: string; ip: string | null;
    expires_on: string | null; anonymized_at: Date | string | null;
    customer_name: string | null;
  }[]>`
    select s.id, s.template_version, t.title, t.schema,
           s.answers_encrypted, s.enc_alg, s.signer_name, s.signer_relation,
           s.signature_url, s.signed_at, s.locale, s.source, s.ip,
           s.expires_on::text as expires_on, s.anonymized_at,
           c.display_name as customer_name
    from form_submissions s
    join form_templates t on t.id = s.template_id
    left join customers c on c.id = s.customer_id
    where s.id = ${submissionId} and s.location_id = ${ctx.locationId}`;

  if (!row) throw new AppError(ERROR_CODES.NOT_FOUND, { details: { entity: 'form_submission' } });

  // ⭐ 先留痕，再解密
  await tx`
    insert into form_access_log (org_id, location_id, submission_id, membership_id, reason, ip)
    values (${ctx.orgId}, ${ctx.locationId}, ${submissionId},
            ${ctx.membershipId}, ${reason}, ${ctx.ip ?? null})`;

  let answers: Record<string, unknown> | null = null;
  if (row.answers_encrypted && !row.anonymized_at) {
    const key = loadFormKey(process.env['FORM_ENCRYPTION_KEY']);
    /**
     * ⚠️ 解不开就**报错**，不返回半个结果（crypto.ts 文件头有长注释）。
     * 常见原因只有一个：`FORM_ENCRYPTION_KEY` 换过了 —— 那把钥匙丢了，
     * 所有已签的表就永久解不开，而这条报错是唯一会说出这件事的地方。
     */
    answers = decryptAnswers(row.answers_encrypted, key) as Record<string, unknown>;
  }

  return {
    submissionId: row.id,
    templateTitle: (row.title ?? {}) as Record<string, string>,
    templateVersion: row.template_version,
    questions: Array.isArray(row.schema) ? row.schema : [],
    answers,
    signerName: row.signer_name,
    signerRelation: row.signer_relation,
    signatureUrl: row.signature_url,
    signedAt: row.signed_at ? new Date(row.signed_at).toISOString() : null,
    locale: row.locale,
    source: row.source,
    ip: row.ip,
    expiresOn: row.expires_on,
    anonymized: row.anonymized_at !== null,
    customerName: row.customer_name,
  };
}

/** 前台只需要看一个词，不需要自己去比较四个时间戳 */
function shareState(f: {
  expires_at: Date | string;
  opened_at: Date | string | null;
  submitted_at: Date | string | null;
  revoked_at: Date | string | null;
}): string {
  if (f.revoked_at) return 'revoked';
  if (f.submitted_at) return 'done';
  if (new Date(f.expires_at).getTime() < Date.now()) return 'expired';
  // ⭐ 「点开了但没填完」要和「根本没点开」分开：前者打电话催一下就成了，
  // 后者多半是没收到（邮箱填错、进了垃圾箱），要换个方式重发
  return f.opened_at ? 'opened' : 'pending';
}

/** `a••••@gmail.com` —— 够前台认出是哪个邮箱，又抄不走 */
function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '••••';
  return `${email[0]}••••${email.slice(at)}`;
}
