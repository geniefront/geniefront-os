/**
 * 派单提醒：声音 + 震动（`00` §2，宪法第 11 条）。
 *
 * 使用场景是决定性的：**手机装在围裙口袋里，店里在放音乐，技师戴着手套。**
 * 所以三条一起上 —— 听见一条就够，三条都没感觉到才是失败。
 *
 * 用 Web Audio 合成而不是放一个 mp3：
 *   · 不用额外请求，断网也响
 *   · 音色可以调到「在嘈杂环境里穿透力强」（两个短促的高音）
 *   · 一个 20KB 的音频文件在门店的网速下可能比事件本身还慢到
 */

let ctx: AudioContext | null = null;

/**
 * ⚠️ 浏览器要求音频必须由用户手势解锁。
 * 技师第一次点「我在岗」时调一次，之后才响得出来 ——
 * 不解锁的话，整个提醒功能会静默失效，而没有任何报错。
 */
export function unlockAudio(): void {
  try {
    ctx ??= new (window.AudioContext ?? (window as unknown as {
      webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    void ctx.resume();
    // 播一个 0 音量的极短音，把 iOS 的音频通道真正打开
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.value = 0;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.01);
  } catch {
    /* 不支持就算了，震动和界面翻转还在 */
  }
}

export function audioReady(): boolean {
  return ctx !== null && ctx.state === 'running';
}

/** 「叮！新客人」—— 两声上行的短音，在嘈杂环境里比长音好认 */
export function playAssignSound(): void {
  if (!ctx) return;
  const now = ctx.currentTime;
  for (const [i, freq] of [880, 1320].entries()) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    const t = now + i * 0.18;
    // 包络：快起快落。没有包络的方波在手机小喇叭上会"啪"一声爆音
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.18);
  }
}

/** 完成/打卡之类的轻确认音 */
export function playTick(): void {
  if (!ctx) return;
  const now = ctx.currentTime;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'triangle';
  o.frequency.value = 660;
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.2, now + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
  o.connect(g).connect(ctx.destination);
  o.start(now);
  o.stop(now + 0.14);
}

/**
 * 震动。iOS Safari 至今不支持 Vibration API ——
 * 这正是声音和界面翻转不能省的原因，不能把提醒押在震动上。
 */
export function vibrate(pattern: number | number[] = [120, 60, 120]): void {
  try { navigator.vibrate?.(pattern); } catch { /* 不支持 */ }
}

/** 派单：三管齐下 */
export function alertAssigned(): void {
  playAssignSound();
  vibrate([140, 70, 140]);
}
