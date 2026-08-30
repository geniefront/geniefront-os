import { describe, expect, it } from 'vitest';
import { REQUIRED_SETUP_STEP_IDS, SETUP_STEPS } from './flow';

describe('setup flow', () => {
  it('keeps the seven onboarding domains in order', () => {
    expect(SETUP_STEPS.map((step) => step.id)).toEqual([
      'import',
      'store',
      'catalog',
      'team',
      'booking',
      'experience',
      'launch',
    ]);
  });

  it('does not make optional imports or branding block launch', () => {
    expect(REQUIRED_SETUP_STEP_IDS).not.toContain('import');
    expect(REQUIRED_SETUP_STEP_IDS).not.toContain('experience');
    expect(REQUIRED_SETUP_STEP_IDS).toContain('store');
    expect(REQUIRED_SETUP_STEP_IDS).toContain('launch');
  });

  it('does not include a POS hardware step', () => {
    const copy = SETUP_STEPS.map((step) => `${step.title} ${step.description}`).join(' ');
    expect(copy.toLowerCase()).not.toContain('pos');
    expect(copy).not.toContain('读卡器');
  });
});

