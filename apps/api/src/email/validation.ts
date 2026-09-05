import { z } from 'zod';
import { withTenant, type TenantContext } from '@gf/db';
import { elasticKey, elasticRequest } from './elastic';
import { isCaptureMode } from '../comms/mode';
export interface ValidationResult {
  result: 'valid' | 'invalid' | 'risky' | 'unknown'; reason: string;
  suggestedEmail?: string | null; cached?: boolean;
}
export function interpretValidation(r: { Result?: string; PredictedStatus?: string; Reason?: string; SuggestedSpelling?: string; Disposable?: boolean; Role?: boolean }): ValidationResult {
  // Predictions and role/disposable flags alone must never block appointment receipts.
  const state = r.Result?.toLowerCase();
  // Live API responses can say Invalid / Service error during provider outages.
  // Such failures say nothing about the recipient and must remain retryable.
  if (/service\s*error|timeout|timed\s*out|temporar|unavailable|connection|greylist|rate\s*limit/i.test(r.Reason ?? '')) {
    return { result: 'unknown', reason: (r.Reason || 'verification_unavailable').slice(0, 500), suggestedEmail: null };
  }
  const result = state === 'invalid' ? 'invalid' : state === 'valid'
    ? (r.Disposable ? 'risky' : 'valid') : state === 'risky' ? 'risky' : 'unknown';
  return { result, reason: (r.Reason || state || 'unknown').slice(0, 500), suggestedEmail: r.SuggestedSpelling || null };
}
export async function validateEmail(email: string, tenant?: TenantContext): Promise<ValidationResult> {
  const normalized = email.trim().toLowerCase();
  if (!z.string().email().safeParse(normalized).success) return { result: 'invalid', reason: 'invalid_format' };
  if (isCaptureMode() || process.env['NODE_ENV'] === 'test') return { result: 'unknown', reason: 'capture' };
  if (!elasticKey()) return { result: 'unknown', reason: 'not_configured' };
  if (tenant?.locationId) {
    try {
      const [cached] = await withTenant(tenant, tx => tx<{ result: ValidationResult['result']; reason: string; suggested_email: string | null }[]>`
        select result,reason,suggested_email from email_validation_cache
        where org_id=${tenant.orgId} and location_id=${tenant.locationId} and email=${normalized} and expires_at>now()`);
      if (cached) return { ...cached, suggestedEmail: cached.suggested_email, cached: true };
    } catch { return { result: 'unknown', reason: 'cache_unavailable' }; }
  }
  let result: ValidationResult;
  try {
    result = interpretValidation(await elasticRequest('POST', `/verifications/${encodeURIComponent(normalized)}`, undefined, elasticKey(), 3500));
  } catch { result = { result: 'unknown', reason: 'verification_unavailable' }; }
  if (tenant?.locationId) {
    // Unknowns are briefly cached to avoid spending quota or repeatedly delaying sends during outages.
    const seconds = result.result === 'unknown' ? 900 : result.result === 'invalid' ? 86400 : 30 * 86400;
    try {
      await withTenant(tenant, tx => tx`
        insert into email_validation_cache(org_id,location_id,email,result,reason,suggested_email,expires_at)
        values(${tenant.orgId},${tenant.locationId},${normalized},${result.result},${result.reason},${result.suggestedEmail ?? null},now()+make_interval(secs=>${seconds}))
        on conflict(org_id,location_id,email) do update set result=excluded.result,reason=excluded.reason,suggested_email=excluded.suggested_email,checked_at=now(),expires_at=excluded.expires_at`);
    } catch { /* Validation is an enhancement, never a booking dependency. */ }
  }
  return result;
}
