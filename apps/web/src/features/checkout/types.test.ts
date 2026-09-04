import { describe, expect, it } from 'vitest';
import { paymentStageFor, type OpenTicket } from './types';

const ticket = (overrides: Partial<OpenTicket> = {}): OpenTicket => ({
  ticketId: 'ticket-1',
  customerName: 'Guest',
  customerId: null,
  subtotalCents: 10_000,
  groupId: null,
  groupLabel: null,
  businessDate: '2026-08-29',
  daysAgo: 0,
  items: [],
  availablePackages: [],
  checkoutTiming: 'after_service_combined',
  serviceSettledAt: null,
  tipSettledAt: null,
  serviceCompleted: false,
  ...overrides,
});

describe('paymentStageFor', () => {
  it('runs service-then-tip as two distinct stages', () => {
    expect(paymentStageFor(ticket({ checkoutTiming: 'service_then_tip' }))).toBe('service');
    expect(paymentStageFor(ticket({
      checkoutTiming: 'service_then_tip',
      serviceSettledAt: '2026-08-29T10:00:00Z',
      serviceCompleted: false,
    }))).toBeNull();
    expect(paymentStageFor(ticket({
      checkoutTiming: 'service_then_tip',
      serviceSettledAt: '2026-08-29T10:00:00Z',
      serviceCompleted: true,
    }))).toBe('tip');
  });

  it('allows upfront combined payment only once', () => {
    expect(paymentStageFor(ticket({ checkoutTiming: 'upfront_combined' }))).toBe('combined');
    expect(paymentStageFor(ticket({
      checkoutTiming: 'upfront_combined',
      serviceSettledAt: '2026-08-29T10:00:00Z',
      tipSettledAt: '2026-08-29T10:00:00Z',
    }))).toBeNull();
  });

  it('waits for completion in the default combined flow', () => {
    expect(paymentStageFor(ticket())).toBeNull();
    expect(paymentStageFor(ticket({ serviceCompleted: true }))).toBe('combined');
  });
});
