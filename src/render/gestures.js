// Body language: what the fielding side does when something happens (a
// wicket, a boundary, a play-and-miss, an appeal), what a man does with his
// hands while he waits for the next ball, and a head that follows the ball
// at a neck's pace.
//
//   noteCrowd(kind, t)        every crowd reaction (Game.crowdReact) passes through here
//   moodAt(t)                 { mood, age, n } while the fielding side is reacting, else null
//   reactionFor(mood, seed, n) which way this man reacts to it (pure)
//   idleGesture(seed, slot)   what he does with his hands between balls (pure)
//   poseArms(h, fwd, kind, w, t, S)  the hands where the gesture puts them (IK), by weight w
//   lookSteady(h, target, amt, dt, S) Humanoid.lookAt, turning no faster than a neck does
//
// Gestures are drawn over whatever the body is already doing (idle, walk):
// the legs are untouched, so nothing slides; the arms are solved onto points
// on the body (hips, head, chest) and slerped in from the pose underneath, so
// they come and go over a few tenths, never in one frame.
import * as THREE from 'three';
import { sstep } from './anim.js';

// Crowd reaction kinds -> what the fielding side does. (Both kinds of wicket:
// the men on the field are always the fielding side, whoever you are.)
const EVENT_MOOD = {
  wicketAgainst: 'celebrate', wicketFor: 'celebrate',
  four: 'dejected', six: 'dejected', boundaryAgainst: 'dejected', dropped: 'dejected',
  beaten: 'ooh', miss: 'ooh', close: 'ooh',
  appeal: 'appeal',
};
const RANK = { ooh: 1, dejected: 2, appeal: 3, celebrate: 4 };
export const MOOD_DUR = { celebrate: 3.4, dejected: 2.8, ooh: 1.7, appeal: 1.6 };
export const moodFor = (kind) => EVENT_MOOD[kind] || null;

const M = { mood: null, t0: -1e9, n: 0 };
// A stronger mood replaces a weaker one; a weaker one does not cut a stronger one short
// (a run-out's "close" a moment after the wicket's celebration).
export function noteCrowd(kind, t) {
  const m = moodFor(kind);
  if (!m || !Number.isFinite(t)) return;
  const live = M.mood && t >= M.t0 && t - M.t0 < MOOD_DUR[M.mood];
  if (live && RANK[m] < RANK[M.mood]) return;
  if (live && m === M.mood && t - M.t0 < 0.5) return;
  M.mood = m; M.t0 = t; M.n++;
}
const _now = { mood: null, age: 0, n: 0 };
export function moodAt(t) {
  if (!M.mood || t < M.t0 || t - M.t0 >= MOOD_DUR[M.mood]) return null;
  _now.mood = M.mood; _now.age = t - M.t0; _now.n = M.n;
  return _now;
}
export function clearMood() { M.mood = null; M.t0 = -1e9; }

// The ball while it is live (FieldView sets it every frame; the bowler watches it after letting it go).
export const live = { ball: null };

// A repeatable 0..1 per (figure, slot).
export function hash01(a, b) { const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return x - Math.floor(x); }

const VARIANTS = {
  celebrate: ['arms', 'clap', 'fist', 'arms', 'clap'],
  dejected: ['head', 'hips', 'knees', 'hips', 'head'],
  ooh: ['head', 'head', 'hips'],
  appeal: ['appeal'],
};
// How this man reacts to the n-th event: a variant, how late he reacts (s), and
// a little more or less of it (each man is his own: the field never moves as one).
// far: m from the batter's stumps. Only the men round the bat appeal or groan
// at a play-and-miss; a man in the deep claps a wicket, or throws his arms up, from where he is.
export function reactionFor(mood, seed, n = 0, far = 0) {
  const V = VARIANTS[mood];
  if (!V) return null;
  if ((mood === 'appeal' && far > 24) || (mood === 'ooh' && far > 32)) return { kind: null, delay: 0, amt: 0 };
  const r = hash01(seed, n * 7.3 + 1), r2 = hash01(seed + 3.1, n * 5.7 + 2);
  const kind = mood === 'celebrate' && far > 50 ? (r < 0.6 ? 'clap' : 'arms') : V[Math.floor(r * V.length) % V.length];
  return { kind, delay: 0.05 + 0.4 * r2 + Math.min(0.3, far * 0.004), amt: 0.8 + 0.2 * hash01(seed, n + 9) };
}
// Between balls: mostly just standing (the idle clip), now and then hands on
// the hips, a clap of encouragement, hands behind the back, wiping the hands.
export const IDLE_SLOT = 7;
export function idleGesture(seed, slot, keeper = false) {
  const r = hash01(seed, slot);
  if (keeper) return r < 0.3 ? 'clap' : r < 0.5 ? 'wipe' : null;
  return r < 0.42 ? null : r < 0.62 ? 'hips' : r < 0.74 ? 'clap' : r < 0.87 ? 'behind' : 'wipe';
}
// Weight of a gesture over its life: in over `a` s, held, out over `b` s before `dur`.
export function envelope(age, dur, a = 0.3, b = 0.45) {
  if (age <= 0 || age >= dur) return 0;
  return sstep(0, a, age) * (1 - sstep(dur - b, dur, age));
}

// ------------------------------------------------------------- arm poses
const ARMS = ['shoulderL', 'elbowL', 'handL', 'shoulderR', 'elbowR', 'handR'];
const _l = new THREE.Vector3(), _u = new THREE.Vector3(0, 1, 0), _t = new THREE.Vector3(), _p = new THREE.Vector3(), _b = new THREE.Vector3(), _q = new THREE.Quaternion();
export function gestureStore() { return { q: ARMS.map(() => new THREE.Quaternion()), n: null, h: null, nOk: false }; }

// Arms (and a little of the trunk and head) into gesture `kind` over the pose
// on the figure, by weight w. fwd: the figure's forward (world, unit). t: s (for
// anything that moves: a clap, a fist pump).
export function poseArms(h, fwd, kind, w, t, S) {
  if (!kind || w <= 0.001) return;
  w = Math.min(1, w);
  const B = h.bones, sc = h.root.scale.y;
  for (let i = 0; i < 6; i++) S.q[i].copy(B[ARMS[i]].quaternion);
  _l.set(fwd.z, 0, -fwd.x);                                    // the figure's left
  // the trunk first (the hands are placed on it)
  if (kind === 'knees') { h.addRot('spine', 0.55 * w, 0, 0); h.addRot('chest', 0.15 * w, 0, 0); h.addRot('neck', -0.25 * w, 0, 0); }
  else if (kind === 'head') { h.addRot('spine', -0.06 * w, 0, 0); h.addRot('neck', -0.12 * w, 0, 0); }
  else if (kind === 'arms' || kind === 'appeal') { h.addRot('spine', (kind === 'appeal' ? 0.12 : -0.12) * w, 0, 0); h.addRot('neck', -0.15 * w, 0, 0); }
  h.update();
  for (const side of ['L', 'R']) {
    const sg = side === 'L' ? 1 : -1;
    const sh = h.worldPos('shoulder' + side, _b);
    if (kind === 'hips') {
      h.worldPos('hip' + side, _t).addScaledVector(_l, sg * 0.07 * sc).addScaledVector(_u, 0.1 * sc).addScaledVector(fwd, -0.01);
      _p.copy(sh).addScaledVector(_l, sg * 0.7).addScaledVector(fwd, -0.35).addScaledVector(_u, -0.2);
    } else if (kind === 'behind') {
      h.worldPos('hips', _t).addScaledVector(fwd, -0.2 * sc).addScaledVector(_l, sg * 0.03).addScaledVector(_u, 0.05 * sc);
      _p.copy(sh).addScaledVector(_l, sg * 0.5).addScaledVector(fwd, -0.2);
    } else if (kind === 'head') {
      h.worldPos('head', _t).addScaledVector(_u, 0.13 * sc).addScaledVector(_l, sg * 0.06 * sc).addScaledVector(fwd, 0.01);
      _p.copy(sh).addScaledVector(_l, sg * 0.6).addScaledVector(_u, 0.35).addScaledVector(fwd, 0.1);
    } else if (kind === 'clap') {
      const gap = 0.025 + 0.11 * Math.abs(Math.sin(t * Math.PI * 2.4));
      h.worldPos('chest', _t).addScaledVector(fwd, 0.34 * sc).addScaledVector(_u, -0.05 * sc).addScaledVector(_l, sg * gap);
      _p.copy(sh).addScaledVector(_l, sg * 0.45).addScaledVector(_u, -0.6);
    } else if (kind === 'wipe') {
      const rub = 0.05 * Math.sin(t * 9 + (side === 'L' ? 0 : 2));
      h.worldPos('hip' + side, _t).addScaledVector(fwd, 0.13 * sc).addScaledVector(_u, (-0.12 + rub) * sc).addScaledVector(_l, sg * 0.03);
      _p.copy(sh).addScaledVector(_l, sg * 0.5).addScaledVector(fwd, -0.2).addScaledVector(_u, -0.3);
    } else if (kind === 'knees') {
      h.worldPos('knee' + side, _t).addScaledVector(_u, 0.08 * sc).addScaledVector(fwd, 0.05);
      _p.copy(sh).addScaledVector(_l, sg * 0.5).addScaledVector(_u, -0.2);
    } else if (kind === 'arms') {
      const pump = 0.06 * Math.sin(t * 10 + (side === 'L' ? 0 : 1.3));
      _t.copy(sh).addScaledVector(_u, (0.6 + pump) * sc).addScaledVector(_l, sg * 0.22 * sc).addScaledVector(fwd, 0.06);
      _p.copy(sh).addScaledVector(_l, sg * 0.7).addScaledVector(fwd, -0.2);
    } else if (kind === 'appeal') {
      // (out toward the umpire, the right hand higher: "How's that?")
      const hi = side === 'R' ? 1 : 0;
      _t.copy(sh).addScaledVector(_u, (0.3 + 0.28 * hi) * sc).addScaledVector(fwd, (0.42 - 0.12 * hi) * sc).addScaledVector(_l, sg * 0.1 * sc);
      _p.copy(sh).addScaledVector(_l, sg * 0.7).addScaledVector(_u, -0.3);
    } else if (kind === 'fist' || kind === 'fistL') {
      if ((kind === 'fist') !== (side === 'R')) continue;       // one fist pumps (fist: the right), the other arm is left as it is
      const pump = sstep(0, 0.12, (t * 1.6) % 1) * (1 - sstep(0.35, 0.6, (t * 1.6) % 1));
      _t.copy(sh).addScaledVector(_u, (0.05 + 0.3 * pump) * sc).addScaledVector(fwd, 0.22 * sc).addScaledVector(_l, sg * 0.06);
      _p.copy(sh).addScaledVector(_l, sg * 0.5).addScaledVector(_u, -0.5).addScaledVector(fwd, 0.1);
    } else return;
    h.ikArm(side, _t, _p);
  }
  if (w < 1) for (let i = 0; i < 6; i++) { _q.copy(B[ARMS[i]].quaternion); B[ARMS[i]].quaternion.copy(S.q[i]).slerp(_q, w); }
}

// The head toward a world point (Humanoid.lookAt), its turn limited to `rate`
// rad/s from what was shown last frame: a ball appearing (or a figure that
// was looking elsewhere) is turned to, not snapped to. target null: whatever
// the pose has, still at that pace.
export function lookSteady(h, target, amt, dt, S, rate = 7) {
  if (target) h.lookAt(target, amt);
  const n = h.bones.neck.quaternion, hd = h.bones.head.quaternion;
  if (S.nOk && dt > 0 && dt < 0.1) {
    const m = rate * dt;
    let a = S.n.angleTo(n); if (a > m) n.copy(S.n.slerp(n, m / a));
    a = S.h.angleTo(hd); if (a > m) hd.copy(S.h.slerp(hd, m / a));
  }
  (S.n ||= new THREE.Quaternion()).copy(n); (S.h ||= new THREE.Quaternion()).copy(hd); S.nOk = true;
}
