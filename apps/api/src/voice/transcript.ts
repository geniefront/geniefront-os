export interface VoiceTurn {
  role: 'user' | 'assistant' | 'system';
  text: string;
  startSeconds?: number | undefined;
  endSeconds?: number | undefined;
  speaker?: number | undefined;
}
type Word = { text: string; start: number; end: number; speaker?: number };
function words(value: unknown): Word[] {
  return Array.isArray(value) ? value.filter((w): w is Word => w && typeof w.text === 'string'
    && Number.isFinite(w.start) && w.start >= 0 && Number.isFinite(w.end) && w.end >= w.start) : [];
}
function append(left: string, right: string) {
  return left + (/^[,.;:!?，。！？、；：]/u.test(right) || /[\u3400-\u9fff]$/u.test(left) && /^[\u3400-\u9fff]/u.test(right) ? '' : ' ') + right;
}
/** Telnyx Dial defaults to caller channel 0; direct SIP inbound recordings use caller channel 1.
 * Do not infer roles from diarization IDs: speaker 0 is not necessarily the caller. */
export function recordingTurns(response: { text: string; words?: unknown; channels?: unknown }, callerChannel: 0 | 1 = 0): VoiceTurn[] {
  const channels = Array.isArray(response.channels) ? response.channels : [];
  const dual = channels.length === 2 && channels.some(c => c.index === 0) && channels.some(c => c.index === 1);
  const entries = dual ? channels.flatMap(c => words(c.words).map(w => ({ ...w,
    role: (c.index === callerChannel ? 'user' : 'assistant') as VoiceTurn['role'], speaker: undefined })))
    : words(response.words).map(w => ({ ...w, role: 'system' as const }));
  entries.sort((a,b) => a.start - b.start || a.end - b.end);
  const turns: VoiceTurn[] = [];
  for (const w of entries) {
    const text = w.text.trim(); if (!text) continue;
    const last = turns.at(-1);
    if (last && last.role === w.role && last.speaker === w.speaker
      && w.start - (last.endSeconds ?? 0) < 2 && last.text.length + text.length < 3500) {
      last.text = append(last.text, text); last.endSeconds = Math.max(last.endSeconds!, w.end);
    } else turns.push({ role: w.role, text, startSeconds: w.start, endSeconds: w.end,
      ...(Number.isInteger(w.speaker) ? { speaker: w.speaker } : {}) });
  }
  // No timing/speaker information is preferable to fabricated dialogue.
  return turns.length ? turns : (response.text.match(/[\s\S]{1,4000}/g) ?? []).map(text => ({ role: 'system', text }));
}

export function labelDiarizedTurns(turns: VoiceTurn[], speakers: Array<{id:number;role:'user'|'assistant'|'unknown'}> = []): VoiceTurn[] {
  return turns.map(turn => {
    if (turn.role !== 'system' || turn.speaker === undefined) return turn;
    const matches = speakers.filter(s=>s.id===turn.speaker);
    const role = matches.length===1 ? matches[0]!.role : 'unknown';
    return role === 'unknown' ? turn : {...turn,role};
  });
}
/** A short, unanswered opening is not an appointment inquiry.
 * Require positively labelled assistant speech only; unknown/customer speech never qualifies. */
export function isUnansweredGreeting(durationSeconds:number, turns:readonly {role:string;text:string}[] | undefined):boolean {
 if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > 15 || !turns?.length) return false;
 const speech = turns.filter(turn => turn.text.trim());
 return speech.length > 0 && speech.every(turn => turn.role === 'assistant');
}
