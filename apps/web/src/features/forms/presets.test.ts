import { describe, expect, it } from 'vitest';
import { SaveFormTemplate } from '@gf/contracts';
import { FORM_PRESETS } from './presets';

describe('health-form presets', () => {
  it('all presets satisfy the same backend contract used at publish time', () => {
    for (const preset of FORM_PRESETS) {
      expect(SaveFormTemplate.input.safeParse(preset.template), preset.id).toMatchObject({ success: true });
    }
  });
});
