import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { missingRequiredQuestionIds } from './HealthFormPage';
import { HealthFormPage } from './HealthFormPage';
import type { FormQuestionDto } from '../types';
import { LanguageProvider } from '../context/LanguageContext';

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

  it('renders the Web nail intake experience without the massage body map or 1/1 counter', () => {
    const canvasContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    localStorage.setItem('gf_kiosk_language', 'en');
    render(
      <MemoryRouter initialEntries={[{
        pathname: '/health-form',
        state: {
          appointmentId: 'appointment-1',
          queueId: 'queue-1',
          queueResult: {
            queueId: 'queue-1', appointmentId: 'appointment-1', ticketNumber: 8,
            aheadCount: 1, quotedWaitMin: 10, businessDate: '2026-08-29',
          },
          forms: [{
            templateId: 'template-1', key: 'nail_pedicure_intake', version: 3,
            title: { en: 'Nail & Pedicure Consultation Form' },
            questions: [{
              id: 'q_nail_fungus', type: 'bool', required: true,
              label: { en: 'Do you currently have nail fungus?' },
            }],
            requiresSignature: true,
          }],
          guests: [{
            id: 'guest-1', name: 'Jane Doe', phone: '5125550142', email: '',
            serviceId: null, addonIds: [],
          }],
        },
      }]}>
        <LanguageProvider>
          <Routes><Route path="/health-form" element={<HealthFormPage />} /></Routes>
        </LanguageProvider>
      </MemoryRouter>,
    );

    expect(screen.getByText('Client information')).toBeInTheDocument();
    expect(screen.getByText('1. Nail and foot health screening')).toBeInTheDocument();
    expect(screen.getByText('Do you currently have nail fungus?')).toBeInTheDocument();
    expect(screen.queryByText('Body Soreness & Avoidance Areas')).not.toBeInTheDocument();
    expect(screen.queryByText('1 / 1')).not.toBeInTheDocument();
    canvasContext.mockRestore();
  });
});
