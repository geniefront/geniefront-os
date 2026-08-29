import { describe, expect, it } from 'vitest';
import { UI_LANGUAGES } from '@/i18n/types';
import { bodyPartText, publicFormCopy, publicText } from './publicCopy';

describe('public health form translations', () => {
  it('provides non-empty copy for every supported UI language', () => {
    for (const [key, translations] of Object.entries(publicFormCopy)) {
      for (const { code } of UI_LANGUAGES) {
        expect(translations[code], `${key}.${code}`).toBeTruthy();
      }
    }
  });

  it('keeps English signing instructions free of Chinese characters and block-letter wording', () => {
    const englishSigningCopy = [
      publicText('signatureRequired', 'en'),
      publicText('signatureHint', 'en'),
      publicText('legalName', 'en'),
    ].join(' ');

    expect(englishSigningCopy).not.toMatch(/[\u3400-\u9fff]/u);
    expect(englishSigningCopy.toLowerCase()).not.toContain('block letter');
    expect(englishSigningCopy).not.toContain('正楷');
  });

  it('uses native translations instead of English fallback for every non-English language', () => {
    for (const language of ['zh-Hans', 'ko', 'es', 'vi'] as const) {
      expect(publicText('signatureHint', language)).not.toBe(publicText('signatureHint', 'en'));
      expect(publicText('bodyMapInstructions', language)).not.toBe(publicText('bodyMapInstructions', 'en'));
    }
  });

  it('localizes selected body-part names', () => {
    expect(bodyPartText('Head/Face', 'en')).toBe('Head/face');
    expect(bodyPartText('Head/Face', 'ko')).toBe('머리/얼굴');
    expect(bodyPartText('Head/Face', 'es')).toBe('Cabeza/rostro');
    expect(bodyPartText('Head/Face', 'vi')).toBe('Đầu/mặt');
  });
});
