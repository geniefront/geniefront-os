import { api } from '../api/client';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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


it('#21 submits each guest form with their own visit, including a failed retry', async () => {
  const submit = vi.spyOn(api, 'submitForm').mockRejectedValueOnce(new Error('response lost'))
    .mockResolvedValue({ submissionId: 'saved', expiresOn: null });
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  localStorage.setItem('gf_kiosk_language', 'en');
  const visits = ['A', 'B'].map(id => ({
    guest: { id, name: `Guest ${id}`, phone: '5125550142', serviceId: null, addonIds: [] },
    queueResult: { appointmentId: `visit-${id}`, queueId: `queue-${id}`, ticketNumber: 1, aheadCount: 0, quotedWaitMin: 0, businessDate: '2026-09-12' },
    forms: [{ templateId: `template-${id}`, key: 'nail_pedicure_intake', version: 1, title: { en: `Form ${id}` }, questions: [], requiresSignature: false }],
  }));
  const view = render(<MemoryRouter initialEntries={[{ pathname: '/health-form', state: { visits, queueResult: visits[0]!.queueResult } }]}>
    <LanguageProvider><Routes>
      <Route path="/health-form" element={<HealthFormPage />} />
      <Route path="/success" element={<div>Complete</div>} />
    </Routes></LanguageProvider>
  </MemoryRouter>);
  fireEvent.submit(view.container.querySelector('form')!);
  await screen.findByText('response lost');
  fireEvent.submit(view.container.querySelector('form')!);
  await waitFor(() => expect(view.container.querySelector('input')?.value).toBe('Guest B'));
  fireEvent.submit(view.container.querySelector('form')!);
  await screen.findByText('Complete');
  expect(submit.mock.calls.map(([input]) => [input.appointmentId, input.queueId, input.templateId])).toEqual([
    ['visit-A', 'queue-A', 'template-A'], ['visit-A', 'queue-A', 'template-A'], ['visit-B', 'queue-B', 'template-B'],
  ]);
  expect(submit.mock.calls[0]![0].idempotencyKey).toBe(submit.mock.calls[1]![0].idempotencyKey);
  expect(submit.mock.calls[2]![0].idempotencyKey).not.toBe(submit.mock.calls[0]![0].idempotencyKey);
  submit.mockRestore(); canvas.mockRestore();
});
