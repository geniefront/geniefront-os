import { describe, expect, it } from 'vitest';
import { deriveAppointmentBoardState, type AppointmentBoardTicket } from './appointmentBoardState';

const ticket = (over: Partial<AppointmentBoardTicket> = {}): AppointmentBoardTicket => ({
  ticketId: 't1',
  number: 7,
  status: 'in_service',
  checkoutTiming: 'after_service_combined',
  serviceSettledAt: null,
  tipSettledAt: null,
  serviceCompleted: false,
  items: [
    { ticketItemId: 'i1', name: 'A', startedAt: '2026-09-07T10:00:00Z', finishedAt: null },
    { ticketItemId: 'i2', name: 'B', startedAt: null, finishedAt: null },
  ],
  ...over,
});

describe('deriveAppointmentBoardState (U06 / §6.4)', () => {
  it('cancelled / no_show are terminal, not "booked"', () => {
    const s = deriveAppointmentBoardState({ appointmentStatus: 'cancelled', items: [{ status: 'booked' }], ticket: null });
    expect(s.terminal).toBe('cancelled');
    expect(s.nextAction.kind).toBe('blocked');
    const n = deriveAppointmentBoardState({ appointmentStatus: 'no_show', items: [], ticket: null });
    expect(n.terminal).toBe('no_show');
  });

  it('booked appointment with no ticket → check_in', () => {
    const s = deriveAppointmentBoardState({ appointmentStatus: 'booked', items: [{ status: 'booked' }], ticket: null });
    expect(s.stage).toBe('booked');
    expect(s.nextAction).toEqual({ kind: 'check_in' });
  });

  it('multi-item ticket in progress → start the not-started item, and reports partial N/M', () => {
    const s = deriveAppointmentBoardState({ appointmentStatus: 'in_service', items: [{}, {}], ticket: ticket() });
    expect(s.stage).toBe('in_service');
    expect(s.fulfillment).toEqual({ done: 0, total: 2 });
    expect(s.nextAction).toEqual({ kind: 'start_item', ticketItemId: 'i2' });
  });

  it('one of two done → finish the running one, not a whole-ticket complete', () => {
    const s = deriveAppointmentBoardState({
      appointmentStatus: 'in_service', items: [{}, {}],
      ticket: ticket({ items: [
        { ticketItemId: 'i1', name: 'A', startedAt: 'x', finishedAt: 'y' },
        { ticketItemId: 'i2', name: 'B', startedAt: 'x', finishedAt: null },
      ] }),
    });
    expect(s.fulfillment).toEqual({ done: 1, total: 2 });
    expect(s.nextAction).toEqual({ kind: 'finish_item', ticketItemId: 'i2' });
  });

  it('all items done, payment due → ready_checkout + pay_combined', () => {
    const s = deriveAppointmentBoardState({
      appointmentStatus: 'in_service', items: [{}],
      ticket: ticket({
        serviceCompleted: true,
        items: [{ ticketItemId: 'i1', name: 'A', startedAt: 'x', finishedAt: 'y' }],
      }),
    });
    expect(s.stage).toBe('ready_checkout');
    expect(s.paymentStage).toBe('combined');
    expect(s.nextAction.kind).toBe('pay_combined');
  });

  it('service_then_tip: service unpaid blocks starting items (pay first)', () => {
    const s = deriveAppointmentBoardState({
      appointmentStatus: 'in_service', items: [{}],
      ticket: ticket({ checkoutTiming: 'service_then_tip' }),
    });
    expect(s.nextAction).toEqual({ kind: 'pay_service' });
  });

  it('paid + all done → completed, nothing due', () => {
    const s = deriveAppointmentBoardState({
      appointmentStatus: 'completed', items: [{}],
      ticket: ticket({
        serviceCompleted: true, serviceSettledAt: 'x', tipSettledAt: 'y',
        items: [{ ticketItemId: 'i1', name: 'A', startedAt: 'x', finishedAt: 'y' }],
      }),
    });
    expect(s.stage).toBe('completed');
    expect(s.paid).toBe(true);
    expect(s.paymentStage).toBeNull();
  });

  it('empty ticket (all items removed) is not "done"', () => {
    const s = deriveAppointmentBoardState({
      appointmentStatus: 'in_service', items: [],
      ticket: ticket({ items: [] }),
    });
    expect(s.stage).toBe('in_service');
    expect(s.fulfillment).toEqual({ done: 0, total: 0 });
  });
});
