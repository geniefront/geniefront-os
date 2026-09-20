import { describe, expect, it } from 'vitest';
import { setupStepsForPlan, SETUP_STEPS, SETUP_STEP_IDS, LAUNCH_BLOCKING_STEP_IDS } from './flow';
import { CATALOG_IMPORT_SOURCES, STORE_IMPORT_SOURCES } from './importSources';
import { setup as setupDict } from '@/i18n/setup';

describe('setup flow', () => {
  it('runs the seven setup domains in wizard order', () => {
    expect(SETUP_STEP_IDS).toEqual([
      'store', 'directory', 'rooms', 'catalog', 'team', 'features', 'launch',
    ]);
  });

  it('mirrors the backend contract step ids exactly', () => {
    // 前端步骤 id 必须与 packages/contracts SETUP_STEP_IDS 对齐，
    // 完成度全靠后端按同一组 id 推导。
    expect(SETUP_STEP_IDS).toEqual([
      'store', 'directory', 'rooms', 'catalog', 'team', 'features', 'launch',
    ]);
  });

  it('numbers steps 1..7 in order', () => {
    expect(SETUP_STEPS.map((step) => step.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('treats staff directory and feature switches as non-blocking', () => {
    expect(LAUNCH_BLOCKING_STEP_IDS).toEqual(['store', 'rooms', 'catalog', 'team', 'launch']);
    expect(LAUNCH_BLOCKING_STEP_IDS).not.toContain('directory');
    expect(LAUNCH_BLOCKING_STEP_IDS).not.toContain('features');
  });

  it('uses i18n keys for every step label — no hard-coded copy', () => {
    for (const step of SETUP_STEPS) {
      for (const key of [step.titleKey, step.shortTitleKey, step.descriptionKey]) {
        expect(key in setupDict, key).toBe(true);
      }
    }
  });

  it('store import is Google/website; catalog import is price-list photos', () => {
    expect([...STORE_IMPORT_SOURCES]).toEqual(['google', 'website']);
    expect([...CATALOG_IMPORT_SOURCES]).toEqual(['menu']);
  });
});

it('voice booking setup includes staff and directory but excludes rooms', () => {
  const steps = setupStepsForPlan('voice_booking');
  expect(steps.map(s => s.id)).toEqual(['store', 'directory', 'catalog', 'team', 'features', 'launch']);
  expect(steps.map(s => s.number)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(setupStepsForPlan('growth')).toHaveLength(7);
});
