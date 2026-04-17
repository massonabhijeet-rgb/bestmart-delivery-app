/**
 * Notification chime using the Web Audio API.
 * No audio files required — tones are synthesised in the browser.
 *
 * IMPORTANT: unlockAudio() MUST be called directly inside a user-gesture
 * handler (click/keydown). Browsers (Chrome, Safari) block AudioContext
 * from starting unless it was created or resumed inside such a handler.
 */

let ctx: AudioContext | null = null;
let unlocked = false;

/**
 * Call this DIRECTLY inside a click handler — not inside useEffect.
 * Creates the AudioContext for the first time (or resumes it) while the
 * browser still trusts the user gesture, so future playback works.
 */
export function unlockAudio(): void {
  try {
    if (!ctx) {
      ctx = new AudioContext();
    }
    if (ctx.state === 'suspended') {
      void ctx.resume().then(() => { unlocked = true; });
    } else {
      unlocked = true;
    }
  } catch {
    // Web Audio not supported — ignore silently
  }
}

export function isAudioUnlocked(): boolean {
  return unlocked;
}

function playTone(
  audioCtx: AudioContext,
  frequency: number,
  startTime: number,
  duration: number,
  peakGain = 0.38,
): void {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.type = 'sine';
  osc.frequency.setValueAtTime(frequency, startTime);
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(peakGain, startTime + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.05);
}

/** 3-note ascending chime: E5 → G#5 → B5 */
export function playOrderAlert(): void {
  if (!ctx || !unlocked) return;
  try {
    const now = ctx.currentTime;
    playTone(ctx, 659.25, now,        0.28, 0.36);
    playTone(ctx, 830.61, now + 0.20, 0.28, 0.36);
    playTone(ctx, 987.77, now + 0.40, 0.45, 0.42);
  } catch {
    // ignore
  }
}
