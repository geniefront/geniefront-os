import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '@gf/contracts';
const mocks = vi.hoisted(() => ({ tenant: vi.fn(), generate: vi.fn() }));
vi.mock('@gf/db', () => ({ withTenant: mocks.tenant }));
vi.mock('@gf/ai', () => ({ generateHealthSummary: mocks.generate }));
import { summaryForSubmission } from './summary';
import { encryptAnswers, loadFormKey } from '../kiosk/crypto';
const text = { 'zh-Hans': '未提供', en: 'Not provided', ko: '미제공', es: 'No indicado', vi: 'Chưa cung cấp' };
const lines = { 'zh-Hans': [], en: [], ko: [], es: [], vi: [] };
const summary = { riskLevel: 'low', headline: text, keyAlerts: lines, avoidAreasList: lines, focusNotes: text, technicianAdvice: text };
const ctx = { userId: 'user', membershipId: 'member', actorKind: 'user', locale: 'en', timezone: 'America/New_York', orgId: 'org', locationId: 'location', permissions: new Set(['customer.view_health_form']) } as CommandContext;
const detail = { submissionId: 'submission', questions: [], answers: { conditions: { pregnancy: false } } };
beforeEach(() => { mocks.tenant.mockReset(); mocks.generate.mockReset(); process.env.FORM_ENCRYPTION_KEY = '12'.repeat(32); });
describe('audited summary cache', () => {
  it('never reads or generates for unauthorized or erased submissions', async () => {
    expect(await summaryForSubmission({ ...ctx, permissions: new Set() }, detail)).toBeNull();
    expect(await summaryForSubmission(ctx, { ...detail, answers: null })).toBeNull();
    expect(mocks.tenant).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('reuses encrypted summaries across consumers', async () => {
    mocks.tenant.mockResolvedValue([{ ai_summary_encrypted: encryptAnswers(summary, loadFormKey(process.env.FORM_ENCRYPTION_KEY)) }]);
    expect(await summaryForSubmission(ctx, detail)).toEqual(summary);
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('generates once for simultaneous requests and persists before returning', async () => {
    mocks.tenant.mockResolvedValueOnce([{ ai_summary_encrypted: null }]).mockResolvedValueOnce([{ id: 'submission' }]);
    mocks.generate.mockResolvedValue(summary);
    const results = await Promise.all([summaryForSubmission(ctx, detail), summaryForSubmission(ctx, detail)]);
    expect(results).toEqual([summary, summary]);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.tenant).toHaveBeenCalledTimes(2);
  });
  it('does not return a generated summary after concurrent erasure', async () => {
    mocks.tenant.mockResolvedValueOnce([{ ai_summary_encrypted: null }]).mockResolvedValueOnce([]);
    mocks.generate.mockResolvedValue(summary);
    expect(await summaryForSubmission(ctx, detail)).toBeNull();
  });
  it('preserves access to the original form when AI is unavailable', async () => {
    mocks.tenant.mockResolvedValue([{ ai_summary_encrypted: null }]);
    mocks.generate.mockRejectedValue(new Error('provider unavailable'));
    expect(await summaryForSubmission(ctx, detail)).toBeNull();
  });
});
