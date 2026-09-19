export type VoiceSegment = { start: number; end: number; category: string };
/** Never trust model-supplied totals; validate intervals and round only once per call. */
export function billableVoiceSeconds(duration: number, segments: readonly VoiceSegment[]): number {
  if (!Number.isFinite(duration) || duration < 0) throw new Error('Invalid voice duration');
  let previous = 0;
  let seconds = 0;
  for (const segment of [...segments].sort((a, b) => a.start - b.start)) {
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end)
      || Math.abs(segment.start - previous) > 0.01 || segment.start < previous
      || segment.end <= segment.start || segment.end > duration + 0.5
      || !['business','spam','sales','silence','off_topic','system_failure'].includes(segment.category)) {
      throw new Error('Invalid or overlapping classification intervals');
    }
    if (segment.category === 'business') seconds += Math.min(duration, segment.end) - segment.start;
    previous = segment.end;
  }
  if (Math.abs(previous - duration) > 0.5) throw new Error('Incomplete voice classification');
  return Math.min(Math.ceil(seconds), Math.ceil(duration));
}
