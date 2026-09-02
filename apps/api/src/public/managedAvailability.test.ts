import { describe, expect, it } from 'vitest';
import { guestRescheduleShapeReason } from './managedAvailability';

describe('guestRescheduleShapeReason', () => {
  const item = {
    membership_id: 'st-1',
    starts_at: '2099-06-15T18:00:00.000Z',
    ends_at: '2099-06-15T18:45:00.000Z',
    duration_min: 45,
    resource_id: null,
  };

  it('allows single-item, multi-item, and named-specialist appointments', () => {
    expect(guestRescheduleShapeReason([item])).toBeNull();
    expect(guestRescheduleShapeReason([
      item,
      { ...item, starts_at: '2099-06-15T18:45:00.000Z', ends_at: '2099-06-15T19:30:00.000Z' },
    ])).toBeNull();
    expect(guestRescheduleShapeReason([{ ...item, membership_id: null }])).toBeNull();
  });

  it('rejects empty, invalid, or resource-held appointments', () => {
    expect(guestRescheduleShapeReason([])).toBe('shape_unsupported');
    expect(guestRescheduleShapeReason([{ ...item, duration_min: 0 }])).toBe('shape_unsupported');
    expect(guestRescheduleShapeReason([{ ...item, resource_id: 'res-1' }])).toBe('shape_unsupported');
  });
});
