import { describe, expect, it } from 'vitest';
import { deskBaseUrl, deskLoginUrl } from './desk';

describe('desk login origin', () => {
  it('never points at the marketing site itself', () => {
    expect(deskBaseUrl()).not.toMatch(/:5180/);
    expect(deskLoginUrl()).toBe(`${deskBaseUrl()}/`);
  });
});
