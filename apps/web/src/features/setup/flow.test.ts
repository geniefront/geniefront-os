import { describe, expect, it } from 'vitest';
import { REQUIRED_SETUP_STEP_IDS, SETUP_STEPS } from './flow';

describe('setup flow', () => {
  it('keeps the four launch-critical setup steps in order', () => {
    expect(SETUP_STEPS.map((step) => step.id)).toEqual([
      'store',
      'catalog',
      'team',
      'launch',
    ]);
  });

  it('keeps only the operational minimum in the blocking setup', () => {
    expect(REQUIRED_SETUP_STEP_IDS).toContain('store');
    expect(REQUIRED_SETUP_STEP_IDS).toContain('catalog');
    expect(REQUIRED_SETUP_STEP_IDS).toContain('team');
    expect(REQUIRED_SETUP_STEP_IDS).toContain('launch');
    expect(REQUIRED_SETUP_STEP_IDS).toHaveLength(4);
  });

  it('does not include optional website, notifications, or POS steps', () => {
    const copy = SETUP_STEPS.map((step) => `${step.title} ${step.description}`).join(' ');
    expect(copy.toLowerCase()).not.toContain('pos');
    expect(copy).not.toContain('读卡器');
    expect(copy).not.toContain('通知');
    expect(copy).not.toContain('主页');
  });
});
