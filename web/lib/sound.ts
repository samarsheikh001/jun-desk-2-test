// W-20 / I-14: a soft two-note chime for a new reply, synthesized with the Web Audio API (no
// audio files). Shared by the widget frame and the dashboard, so it imports nothing.
//
// Browsers only let a page make sound after the person has interacted with it, so the audio
// context is created (or resumed) on their first pointerdown/keydown in this document
// (`unlockSoundOnInteraction`), and `playChime` does nothing before that: someone who never
// touched the page never hears it. Anything missing or failing is silently nothing.

let context: AudioContext | null = null;
let unlocked = false;
let lastPlayed = 0;

/** At most one chime per this many milliseconds. */
export const CHIME_GAP_MS = 4_000;

/** Creates or resumes the audio context. Call it from inside a user gesture. */
export function unlockSound(): void {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    context ??= new Ctor();
    if (context.state === "suspended") void context.resume().catch(() => {});
    unlocked = true;
  } catch {
    // No Web Audio here: no sound.
  }
}

let listening = false;
/** One listener for the first interaction with this document, removed after it. */
export function unlockSoundOnInteraction(): void {
  if (listening || unlocked) return;
  listening = true;
  const unlock = () => {
    unlockSound();
    document.removeEventListener("pointerdown", unlock, true);
    document.removeEventListener("keydown", unlock, true);
  };
  document.addEventListener("pointerdown", unlock, true);
  document.addEventListener("keydown", unlock, true);
}

/**
 * Plays the chime (E5 then A5, each a quick attack and a ~450 ms decay; loud enough for laptop
 * speakers, still soft). Returns whether it played: not before the first interaction, nor within
 * CHIME_GAP_MS of the last one.
 */
export function playChime(now = Date.now()): boolean {
  if (!unlocked || !context || now - lastPlayed < CHIME_GAP_MS) return false;
  try {
    chime(context);
    lastPlayed = now;
    return true;
  } catch {
    return false;
  }
}

/** "Test sound" buttons: call from the click itself (it unlocks), so it always plays. */
export function previewChime(): void {
  unlockSound();
  try {
    if (context) chime(context);
  } catch {
    // no sound here
  }
}

function chime(ctx: AudioContext): void {
  // A context resumed just now starts its clock late: schedule from when it's running.
  const play = () => {
    const start = ctx.currentTime + 0.02;
    note(ctx, 659.25, start, 0.32);
    note(ctx, 880, start + 0.12, 0.26);
  };
  if (ctx.state === "suspended") void ctx.resume().then(play, () => {});
  else play();
}

function note(ctx: AudioContext, frequency: number, at: number, gain: number): void {
  const osc = ctx.createOscillator();
  const level = ctx.createGain();
  // A sine with its octave, quietly: a bell-like tone that small speakers still carry.
  const octave = ctx.createOscillator();
  const octaveLevel = ctx.createGain();
  octave.type = "sine";
  octave.frequency.setValueAtTime(frequency * 2, at);
  octaveLevel.gain.setValueAtTime(0.25, at);
  octave.connect(octaveLevel).connect(level);
  octave.start(at);
  octave.stop(at + 0.5);
  osc.type = "sine";
  osc.frequency.setValueAtTime(frequency, at);
  level.gain.setValueAtTime(0.0001, at);
  level.gain.exponentialRampToValueAtTime(gain, at + 0.012);
  level.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
  osc.connect(level).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + 0.5);
  osc.onended = () => level.disconnect();
}
