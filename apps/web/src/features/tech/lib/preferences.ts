const SOUND_KEY = 'gf.tech.sound-enabled';
const WAKE_LOCK_KEY = 'gf.tech.wake-lock-enabled';

function readBoolean(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === 'true';
  } catch {
    return fallback;
  }
}

function writeBoolean(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Device-local preferences are optional and must never block work.
  }
}

export const readTechSoundEnabled = (): boolean => readBoolean(SOUND_KEY, true);
export const readTechWakeLockEnabled = (): boolean => readBoolean(WAKE_LOCK_KEY, true);
export const writeTechSoundEnabled = (value: boolean): void => writeBoolean(SOUND_KEY, value);
export const writeTechWakeLockEnabled = (value: boolean): void => writeBoolean(WAKE_LOCK_KEY, value);
