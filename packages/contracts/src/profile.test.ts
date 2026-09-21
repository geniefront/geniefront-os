import { describe, expect, it } from 'vitest';
import { UpdateUserProfile } from './commands/profile';

describe('profile phone PATCH semantics', () => {
  it('preserves omission and accepts an explicit clear', () => {
    expect(UpdateUserProfile.input.parse({ fullName: 'Test' })).not.toHaveProperty('phone');
    expect(UpdateUserProfile.input.parse({ phone: null }).phone).toBeNull();
  });
  it('normalizes international numbers and rejects malformed input', () => {
    expect(UpdateUserProfile.input.parse({ phone: '+1 (617) 555-0199' }).phone).toBe('+16175550199');
    for (const phone of ['', 'invalid', '123']) expect(UpdateUserProfile.input.safeParse({ phone }).success).toBe(false);
  });
});
