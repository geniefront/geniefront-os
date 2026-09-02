import { describe, expect, it } from 'vitest';
import { hostedManagePath, manageTokenFromHash } from './manageToken';

describe('manageTokenFromHash', () => {
  it('reads #g/{token} and ignores anything else', () => {
    expect(manageTokenFromHash('#g/mt_secret')).toBe('mt_secret');
    expect(manageTokenFromHash('#/g/mt_secret')).toBe('mt_secret');
    expect(manageTokenFromHash('#g/mt_%2Fslash')).toBe('mt_/slash');
    expect(manageTokenFromHash('#other')).toBe('');
    expect(manageTokenFromHash('')).toBe('');
  });

  it('builds a fragment URL that does not put the token in the path', () => {
    expect(hostedManagePath('lotus-nails', 'mt_secret')).toBe('/l/lotus-nails#g/mt_secret');
    expect(hostedManagePath('lotus-nails', 'mt_secret').split('#')[0]).not.toContain('mt_');
  });
});
