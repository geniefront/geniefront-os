import { useEffect, useRef, useState } from 'react';
import type { CallView } from './types';

type Source = Pick<CallView, 'callId' | 'recordingId' | 'recordingUrl'>;
export function useCallAudio(selectedId: string | null, resolve: (call: Source) => Promise<string | null>, onError: () => void) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const active = useRef<string | null>(null);
  const version = useRef(0);
  const speedRef = useRef(1);
  const [playingCallId, setPlaying] = useState<string | null>(null);
  const [currentTime, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  function release() {
    version.current++;
    const old = audio.current;
    audio.current = null;
    if (old) {
      old.ontimeupdate = old.onloadedmetadata = old.onended = old.onerror = null;
      old.pause();
      old.removeAttribute('src');
      old.load();
    }
  }
  function reset(id: string | null = null) {
    release(); active.current = id;
    setPlaying(null); setTime(0); setDuration(0); setSpeed(1); speedRef.current = 1;
  }
  useEffect(() => { if (active.current !== selectedId) reset(selectedId); }, [selectedId]);
  useEffect(() => () => { release(); }, []);
  async function toggle(call: Source) {
    if (active.current !== call.callId) reset(call.callId);
    if (audio.current && !audio.current.paused) { version.current++; audio.current.pause(); setPlaying(null); return; }
    const ticket = ++version.current;
    try {
      let player = audio.current;
      if (!player) {
        const url = await resolve(call);
        if (version.current !== ticket) return;
        if (!url) throw new Error('Missing recording');
        player = new Audio(url); audio.current = player;
        const instance = player;
        const update = () => {
          if (audio.current !== instance) return;
          setTime(instance.currentTime);
          setDuration(Number.isFinite(instance.duration) ? instance.duration : 0);
        };
        instance.onloadedmetadata = instance.ontimeupdate = update;
        instance.onended = () => { if (audio.current === instance) { setPlaying(null); setTime(0); instance.currentTime = 0; } };
        instance.onerror = () => { if (audio.current === instance) { reset(call.callId); onError(); } };
      }
      player.playbackRate = speedRef.current;
      await player.play();
      if (version.current === ticket && audio.current === player) setPlaying(call.callId);
      else if (audio.current !== player) player.pause();
    } catch {
      if (version.current === ticket) { reset(call.callId); onError(); }
    }
  }
  function seek(time: number) {
    if (!audio.current || !Number.isFinite(audio.current.duration)) return;
    const value = Math.max(0, Math.min(time, audio.current.duration));
    audio.current.currentTime = value; setTime(value);
  }
  function changeSpeed(value: number) {
    speedRef.current = value; setSpeed(value);
    if (audio.current) audio.current.playbackRate = value;
  }
  const matches = active.current === selectedId;
  return { toggle, reset, seek, changeSpeed, playingCallId,
    currentTime: matches ? currentTime : 0, duration: matches ? duration : 0, speed: matches ? speed : 1 };
}
