import { describe, expect, it } from 'vitest';
import { missingRequiredQuestionIds } from './HealthFormPage';
import type { FormQuestionDto } from '../types';

const questions: FormQuestionDto[] = [
  { id: 'bool', type: 'bool', required: true, label: { en: 'Boolean' } },
  { id: 'multi', type: 'multi', required: true, label: { en: 'Multiple' } },
  { id: 'hidden', type: 'text', required: true, hidden: true, label: { en: 'Hidden' } },
];

describe('health-form validation', () => {
  it('accepts an explicit false answer and ignores hidden required fields', () => {
    expect(missingRequiredQuestionIds(questions, { bool: false, multi: ['one'] })).toEqual([]);
  });

  it('rejects unanswered and empty multi-select fields', () => {
    expect(missingRequiredQuestionIds(questions, { multi: [] })).toEqual(['bool', 'multi']);
  });
});
