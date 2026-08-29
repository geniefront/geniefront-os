import type { TechTask, TechToday } from '../types';

export function selectTechTaskCards(snapshot: TechToday): {
  primary: TechTask | null;
  next: TechTask | null;
} {
  const primary = snapshot.current ?? snapshot.next ?? null;
  const next = snapshot.current
    ? snapshot.next
    : snapshot.tasks.find(
        (task) => task.state === 'waiting' && task.ticketItemId !== primary?.ticketItemId,
      ) ?? null;
  return { primary, next };
}

export interface ServiceTimerView {
  display: string;
  overtime: boolean;
  progressPercent: number;
}

export function serviceTimerView(
  startedAt: string | null,
  durationMin: number,
  nowMs: number,
): ServiceTimerView {
  if (!startedAt) return { display: '00:00', overtime: false, progressPercent: 0 };
  const startedMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startedMs)) return { display: '00:00', overtime: false, progressPercent: 0 };

  const totalSeconds = Math.max(1, durationMin * 60);
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
  const remainingSeconds = totalSeconds - elapsedSeconds;
  const overtime = remainingSeconds < 0;
  const absoluteSeconds = Math.abs(remainingSeconds);
  const minutes = String(Math.floor(absoluteSeconds / 60)).padStart(2, '0');
  const seconds = String(absoluteSeconds % 60).padStart(2, '0');

  return {
    display: `${overtime ? '+' : ''}${minutes}:${seconds}`,
    overtime,
    progressPercent: overtime ? 100 : Math.min(100, Math.round((elapsedSeconds / totalSeconds) * 100)),
  };
}
