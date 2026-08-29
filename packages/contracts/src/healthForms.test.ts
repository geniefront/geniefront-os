import { describe, expect, it } from 'vitest';
import {
  HEALTH_FORM_EXPERIENCES,
  healthFormTemplateKeyForBusinessType,
  inferHealthFormCategory,
} from './healthForms';

describe('shared health-form experience', () => {
  it('selects one canonical template for each store type', () => {
    expect(healthFormTemplateKeyForBusinessType('nail')).toBe('nail_pedicure_intake');
    expect(healthFormTemplateKeyForBusinessType('foot_spa')).toBe('massage_intake');
    expect(healthFormTemplateKeyForBusinessType('lash')).toBe('lash_services_intake');
    expect(healthFormTemplateKeyForBusinessType('mixed')).toBe('nail_pedicure_intake');
  });

  it('only enables the body map for massage forms', () => {
    expect(HEALTH_FORM_EXPERIENCES[inferHealthFormCategory('nail_pedicure_intake')].assessmentMode)
      .toBe('nail_foot');
    expect(HEALTH_FORM_EXPERIENCES[inferHealthFormCategory('massage_intake')].assessmentMode)
      .toBe('pain_body_map');
  });
});
