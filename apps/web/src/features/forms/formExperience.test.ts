import { describe, expect, it } from 'vitest';
import { INDUSTRY_PRESETS } from './mockData';
import {
  HEALTH_FORM_CATEGORY_OPTIONS,
  HEALTH_FORM_EXPERIENCES,
  inferHealthFormCategory,
} from './formExperience';

describe('industry-specific public health form experience', () => {
  it('offers one selectable template for each supported business type', () => {
    expect(HEALTH_FORM_CATEGORY_OPTIONS.map((option) => option.value)).toEqual([
      'massage', 'facial', 'nail', 'lash', 'scalp', 'hair',
    ]);
  });

  it('uses a full pain assessment and body map only for massage', () => {
    expect(HEALTH_FORM_EXPERIENCES.massage.assessmentMode).toBe('pain_body_map');
    for (const category of ['facial', 'nail', 'lash', 'scalp', 'hair'] as const) {
      expect(HEALTH_FORM_EXPERIENCES[category].assessmentMode).not.toBe('pain_body_map');
    }
  });

  it('maps every preset to complete safety and assessment sections', () => {
    for (const preset of INDUSTRY_PRESETS) {
      const experience = HEALTH_FORM_EXPERIENCES[preset.category];
      const ids = new Set(preset.template.questions.map((question) => question.id));
      expect(inferHealthFormCategory(preset.template.key), preset.id).toBe(preset.category);
      expect(experience.safetyQuestionIds.every((id) => ids.has(id)), `${preset.id} safety`).toBe(true);
      expect(experience.assessmentQuestionIds.every((id) => ids.has(id)), `${preset.id} assessment`).toBe(true);
    }
  });
});
