import { expect, it } from 'vitest';
import { getSavedUserAvatar, saveUserAvatar, USER_AVATAR_STORAGE_KEY } from './avatarPresets';
it('isolates browser avatars by account and ignores the legacy shared value', () => {
  localStorage.clear();
  localStorage.setItem(USER_AVATAR_STORAGE_KEY, JSON.stringify({ customImageUrl: 'legacy-user' }));
  saveUserAvatar({ mode: 'custom', customImageUrl: 'user-a' }, 'a');
  expect(getSavedUserAvatar('a').customImageUrl).toBe('user-a');
  expect(getSavedUserAvatar('b').customImageUrl).toBe('');
  expect(getSavedUserAvatar().customImageUrl).toBe('');
});
