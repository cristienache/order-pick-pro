// Tiny WebAudio chime — no asset needed.
// Plays a short two-tone bell sound. Initialized lazily on first call to avoid
// autoplay policy issues; subsequent calls reuse the same AudioContext.

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

export function playChime() {
  const c = getCtx();
  if (!c) return;
  const now = c.currentTime;
  const tones = [
    { freq: 880, start: 0, dur: 0.18 },
    { freq: 1320, start: 0.12, dur: 0.22 },
  ];
  for (const t of tones) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.value = t.freq;
    gain.gain.setValueAtTime(0, now + t.start);
    gain.gain.linearRampToValueAtTime(0.18, now + t.start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + t.start + t.dur);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(now + t.start);
    osc.stop(now + t.start + t.dur + 0.02);
  }
}
