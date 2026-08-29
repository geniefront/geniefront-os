import { describe, expect, it } from 'vitest';
import { selectTechTaskCards, serviceTimerView } from './viewModel';
import type { TechTask, TechToday } from '../types';

function task(id: string, state: TechTask['state']): TechTask {
  return {
    ticketId: `ticket-${id}`,
    ticketItemId: id,
    customerName: 'Guest',
    customerPhone: null,
    serviceName: 'Service',
    durationMin: 60,
    resourceName: null,
    startedAt: state === 'in_service' ? '2026-08-29T12:00:00.000Z' : null,
    finishedAt: state === 'done' ? '2026-08-29T13:00:00.000Z' : null,
    state,
    isRequest: false,
    details: [],
    alerts: [],
    customerLocale: null,
    note: null,
    serviceNotes: [],
    tip: { cashCents: 0, cardCents: 0, directCashCents: 0, status: 'awaiting_checkout', editable: false },
  };
}

function snapshot(tasks: TechTask[], current: TechTask | null, next: TechTask | null): TechToday {
  return {
    businessDate: '2026-08-29',
    membershipId: 'membership',
    name: 'Tech',
    current,
    next,
    tasks,
    doneCount: 0,
    onDuty: true,
    workedMinutes: 0,
    rotation: { position: 1, isNextUp: true, onBreak: false },
    earnings: {
      serviceRevenueCents: 0,
      commissionCents: 0,
      tipCashCents: 0,
      tipCardCents: 0,
      payCents: 0,
      cashTipOwedCents: 0,
    },
  };
}

describe('selectTechTaskCards', () => {
  it('keeps the in-service task primary and the waiting task next', () => {
    const current = task('current', 'in_service');
    const next = task('next', 'waiting');
    expect(selectTechTaskCards(snapshot([current, next], current, next))).toEqual({ primary: current, next });
  });

  it('shows the first waiting task as primary and finds the following task', () => {
    const first = task('first', 'waiting');
    const second = task('second', 'waiting');
    expect(selectTechTaskCards(snapshot([first, second], null, first))).toEqual({ primary: first, next: second });
  });
});

describe('serviceTimerView', () => {
  it('formats remaining time and progress', () => {
    expect(serviceTimerView('2026-08-29T12:00:00.000Z', 60, Date.parse('2026-08-29T12:15:00.000Z')))
      .toEqual({ display: '45:00', overtime: false, progressPercent: 25 });
  });

  it('formats overtime without exceeding 100 percent', () => {
    expect(serviceTimerView('2026-08-29T12:00:00.000Z', 60, Date.parse('2026-08-29T13:02:03.000Z')))
      .toEqual({ display: '+02:03', overtime: true, progressPercent: 100 });
  });

  it('fails safely for invalid timestamps', () => {
    expect(serviceTimerView('not-a-date', 60, Date.now()))
      .toEqual({ display: '00:00', overtime: false, progressPercent: 0 });
  });
});
