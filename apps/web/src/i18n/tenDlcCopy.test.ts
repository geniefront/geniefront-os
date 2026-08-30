import { describe, expect, it } from 'vitest';
import { translations, ALL_TRANSLATION_KEYS } from './index';
import { UI_LANGUAGES } from './types';

const SUCCESS_KEYS = [
  'settings.st10dlcSubmitted',
  'settings.st10dlcReviewing',
  'settings.st10dlcReviewTitle',
  'settings.st10dlcReviewDesc',
  'settings.st10dlcSubmitNote',
  'settings.stSubmit10dlcConfirmTitle',
  'settings.stSubmit10dlcConfirmBody',
  'settings.stSubmit10dlcConfirmAction',
  'crm.msgPendingTitle',
  'crm.msgPendingDesc',
  'crm.msgUnderReview',
] as const;

const FORBIDDEN = /carrier review|filed with the US TCR|starts the carrier review|TCR 机构|自动发起运营商审核|正对接运营商/i;

describe('10DLC user-facing copy is internal review, not carrier filing', () => {
  it('success and pending-review strings mention GenieFront review and not a carrier/TCR filing', () => {
    for (const { code } of UI_LANGUAGES) {
      for (const key of SUCCESS_KEYS) {
        expect(ALL_TRANSLATION_KEYS).toContain(key);
        const text = translations[code][key];
        expect(text, `${code}/${key}`).toBeTruthy();
        expect(text, `${code}/${key}`).not.toMatch(FORBIDDEN);
        if (key === 'settings.st10dlcSubmitted' || key === 'settings.st10dlcReviewing') {
          expect(text, `${code}/${key}`).toMatch(/GenieFront/);
        }
      }
    }
  });
});
