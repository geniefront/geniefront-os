import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { describeType, describeInput, COMMAND_INPUT_HINTS } from './aiSchema.js';
import { AppointmentCreate } from './commands/appointment.js';

describe('aiSchema Expansion (29 §6.1)', () => {
  it('expands nested objects in arrays instead of truncating to object[]', () => {
    const schema = z.object({
      list: z.array(
        z.object({
          id: z.string().uuid(),
          count: z.number().int(),
          optionalNote: z.string().optional(),
        }),
      ),
    });

    const result = describeInput(schema);
    expect(result).not.toContain('list:object[]');
    expect(result).toContain('list:{id:uuid, count:int, optionalNote:string?}[]');
  });

  it('appointment.create input preserves sub-fields in items', () => {
    const rawDescribed = describeInput(AppointmentCreate.input);
    expect(rawDescribed).not.toContain('items:object[]');
    expect(rawDescribed).toContain('serviceId:uuid');
  });

  it('provides explicit hints for high-frequency commands', () => {
    const hinted = describeInput(AppointmentCreate.input, 'appointment.create');
    expect(hinted).toBe(COMMAND_INPUT_HINTS['appointment.create']);
  });
});
