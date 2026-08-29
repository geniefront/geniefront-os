/**
 * 屏幕常亮控制工具 (Screen Wake Lock API)。
 *
 * 技师在服务治疗（如足疗、做美甲、美容护理）时，大屏倒计时保持屏幕常亮，
 * 避免频繁黑屏需要脱手套解锁。
 */

let wakeLock: WakeLockSentinel | null = null;

export async function requestScreenWakeLock(): Promise<boolean> {
  if (typeof window === 'undefined' || !('wakeLock' in navigator)) {
    return false;
  }
  try {
    if (wakeLock && !wakeLock.released) {
      return true;
    }
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
    return true;
  } catch (err) {
    console.warn('Wake Lock request failed:', err);
    return false;
  }
}

export function releaseScreenWakeLock(): void {
  if (wakeLock && !wakeLock.released) {
    void wakeLock.release();
    wakeLock = null;
  }
}
