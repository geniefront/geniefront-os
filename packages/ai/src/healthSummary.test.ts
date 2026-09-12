import { describe, expect, it, vi } from 'vitest';
import { generateHealthSummary, healthSummaryFacts } from './healthSummary';

const text = { 'zh-Hans': '未提供', en: 'Not provided', ko: '미제공', es: 'No indicado', vi: 'Chưa cung cấp' };
const lines = { 'zh-Hans': [], en: [], ko: [], es: [], vi: [] };
const summary = { riskLevel: 'low', headline: text, keyAlerts: lines, avoidAreasList: lines, focusNotes: text, technicianAdvice: text };

describe('health summaries', () => {
  it('keeps custom questions and explicit false values but strips identity fields', () => {
    const facts = healthSummaryFacts([{ id: 'q_allergy', label: { en: 'Allergies' } }, { id: 'q_phone' }], {
      q_allergy: false, conditions: { pregnancy: true }, bodyMapAvoid: ['right_knee'],
      q_phone: '555-0100', clientInfo: { name: 'Private' }, signatureDataUrl: 'private',
    });
    expect(facts.answers).toEqual({ q_allergy: false, conditions: { pregnancy: true }, bodyMapAvoid: ['right_knee'] });
    expect(JSON.stringify(facts)).not.toContain('Private');
    expect(facts.questions).toHaveLength(1);
  });
  it('uses model output rather than a preset and validates all languages', async () => {
    const invoke = vi.fn().mockResolvedValue({ status: 'completed', toolCalls: [{ name: 'record_health_summary', arguments: summary }] });
    expect(await generateHealthSummary([], {}, { invoke })).toEqual(summary);
    expect(invoke.mock.calls[0]![0].instructions).toContain('Missing answers');
    invoke.mockResolvedValue({ status: 'completed', toolCalls: [{ name: 'record_health_summary', arguments: { ...summary, headline: { en: 'Incomplete' } } }] });
    await expect(generateHealthSummary([], {}, { invoke })).rejects.toThrow();
  });
  it('does not invent a fallback when the provider refuses', async () => {
    await expect(generateHealthSummary([], {}, { invoke: vi.fn().mockResolvedValue({ status: 'refusal' }) })).rejects.toThrow('health_summary_refused');
  });
});
