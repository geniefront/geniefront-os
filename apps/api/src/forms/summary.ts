import { withTenant } from '@gf/db';
import { healthAiSummarySchema, type CommandContext, type HealthAiSummary } from '@gf/contracts';
import { generateHealthSummary } from '@gf/ai';
import { decryptAnswers, encryptAnswers, loadFormKey } from '../kiosk/crypto';

interface AuditedSubmission { submissionId: string; questions: unknown[]; answers: Record<string, unknown> | null }
const pending = new Map<string, Promise<HealthAiSummary | null>>();

/** Call only after readSubmission has authorized and audited this request. Never hold a DB transaction while waiting on AI. */
export async function summaryForSubmission(ctx: CommandContext, detail: AuditedSubmission): Promise<HealthAiSummary | null> {
  if (!ctx.permissions.has('customer.view_health_form') || !detail.answers) return null;
  const key = `${ctx.orgId}:${ctx.locationId}:${detail.submissionId}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const work = (async () => {
    try {
      const encryptionKey = loadFormKey(process.env['FORM_ENCRYPTION_KEY']);
      const [row] = await withTenant(ctx, (tx) => tx<{ ai_summary_encrypted: Buffer | null }[]>`
        select ai_summary_encrypted from form_submissions
        where id = ${detail.submissionId} and location_id = ${ctx.locationId}
          and anonymized_at is null and answers_encrypted is not null`);
      if (!row) return null;
      if (row.ai_summary_encrypted) {
        const cached = healthAiSummarySchema.safeParse(decryptAnswers(row.ai_summary_encrypted, encryptionKey));
        if (cached.success) return cached.data;
      }
      const summary = await generateHealthSummary(detail.questions, detail.answers!);
      const saved = await withTenant(ctx, (tx) => tx<{ id: string }[]>`
        update form_submissions set ai_summary_encrypted = ${encryptAnswers(summary, encryptionKey)}
        where id = ${detail.submissionId} and location_id = ${ctx.locationId}
          and anonymized_at is null and answers_encrypted is not null returning id`);
      return saved.length ? summary : null;
    } catch {
      // Do not log questionnaire contents or fail the original form/print request.
      return null;
    }
  })();
  pending.set(key, work);
  try { return await work; } finally { pending.delete(key); }
}
