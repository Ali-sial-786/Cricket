// The mix, as numbers (no Web Audio here, so it can be tested): four groups (crowd, effects,
// commentary, UI) into a master with headroom, a limiter and a soft clip; each recording
// normalised to its class's reference loudness (levels.js, measured by tools/audio_levels.py) so
// cue gains say what is meant (0.5 = 6 dB under the class) whatever the file's own level; the
// player's volume steppers; how far sounds carry.
import { LEVELS } from './levels.js';

export const MIX = {
  // (the limiter adds ~2.3 dB of make-up gain, the Web Audio compressor's own: the master allows for it)
  master: 0.5,                 // into the limiter: a six + its roar + the commentary + a bat crack peak just under it
  limiter: { threshold: -4, knee: 3, ratio: 20, attack: 0.002, release: 0.2 },
  clip: 0.9,                   // the soft clip after the limiter: linear below this (of full scale), never past 1
  groups: { crowd: 0.8, fx: 1.0, voice: 0.85, ui: 0.6 },
  duck: { crowd: 0.66, attack: 0.12, release: 0.7 },   // the crowd under the commentators (-3.6 dB)
  maxVoices: 24,               // one-shot sources at once (the bed's loops are not counted)
  hrtf: true,                  // near effects through the HRTF panner (the crowd: equal-power, it is wide anyway)
};

// The loudness (LUFS-ish, loudest 400 ms) a class is normalised to at gain 1.
export const REF = { bed: -14, crowd: -14, bat: -14, impact: -18, voice: -14, ui: -19 };
const CLASS = [[/^crowd_bed$/, 'bed'], [/^(crowd_|applause|cheer_|roar_)/, 'crowd'], [/^bat_/, 'bat'],
  [/^(appeal|howzat)$/, 'voice'], [/^(stumps|bails|gloves|pad|catch|footstep)/, 'impact']];
export function classOf(name) { for (const [re, c] of CLASS) if (re.test(name)) return c; return 'ui'; }

/** The gain that brings a clip to its class's reference (1 for a clip that was not measured). */
export function normGain(name) {
  const l = LEVELS[name];
  if (!l) return 1;
  const g = 10 ** ((REF[classOf(name)] - l[0]) / 20);
  return Math.min(3, Math.max(0.3, g));
}

/** A volume stepper (0..1) as a gain: squared, so the steps sound even (50% = -12 dB, about half as loud). */
export const volGain = (v) => { const x = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1; return x * x; };

/** The groups' gains from the settings (sound off: master 0). */
export function groupGains(s = {}) {
  const v = (k) => volGain(s[k] ?? 1), G = MIX.groups;
  return {
    master: s.sound === false ? 0 : MIX.master * v('volMaster'),
    crowd: G.crowd * v('volCrowd'), fx: G.fx * v('volEffects'), voice: G.voice * v('volCommentary'), ui: G.ui * v('volEffects'),
  };
}

// How far a sound carries. The panners use the inverse law (refDistance, rolloffFactor), kept
// gentle so a keeper 20 m away is still heard (-12 dB), and the air takes the top off far away.
export const SPACE = { ref: 3, rolloff: 0.55, sound: 343 };
export function distanceGain(d, ref = SPACE.ref, rolloff = SPACE.rolloff) {
  return d <= ref ? 1 : ref / (ref + rolloff * (d - ref));
}
export function airCutoff(d) { return Math.max(2200, Math.min(20000, 20000 / (1 + Math.max(0, d - 6) / 16))); }
// Beyond a cricket pitch the sound arrives noticeably late (a boundary board at 65 m: 0.19 s).
export function travelDelay(d) { return d > 12 ? d / SPACE.sound : 0; }

/** The soft clip's curve: linear to `knee`, then a tanh shoulder that never reaches 1. */
export function clipCurve(n = 1024, knee = MIX.clip) {
  const c = new Float32Array(n), room = 1 - knee;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x);
    c[i] = Math.sign(x) * (a <= knee ? a : knee + room * Math.tanh((a - knee) / room));
  }
  return c;
}
