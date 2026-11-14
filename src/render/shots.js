// Batting shots from a real (video-derived) motion capture, cut, cleaned and
// retargeted onto the game's 17-bone Humanoid by tools/build_shots.mjs.
//
//   loadShots()                   once, beside loadClips(); fails soft
//   shotsReady()                  false -> callers keep the procedural body
//   shotFor(type, want)           the capture to use for a game shot type (or null)
//   poseShot(h, use, time, mask)  pose `h` from it (same frame layout as clips.js)
//
// A shot's frame (figure-local, metres for the 1.0-scale athlete): +X toward
// the bowler, +Z the way the batter faces (the off side), origin between the
// stance feet. With the batter's heading at +pi/2 (facing +X in the world) that
// is world -Z toward the bowler, as the game has it.
import * as THREE from 'three';

let D = null;
const NB = 17;

export async function loadShots(base = './assets/anim/') {
  if (D) return D;
  try {
    const [meta, bin] = await Promise.all([
      fetch(base + 'shots.json').then((r) => { if (!r.ok) throw new Error('shots.json ' + r.status); return r.json(); }),
      fetch(base + 'shots.bin').then((r) => { if (!r.ok) throw new Error('shots.bin ' + r.status); return r.arrayBuffer(); }),
    ]);
    if (meta.bones.length !== NB) throw new Error('shots: unexpected bone count');
    D = { q: new Int16Array(bin), stride: meta.stride, qs: 1 / meta.qScale, ps: meta.posScale, bones: meta.bones, shots: meta.shots };
  } catch (e) {
    console.warn('Batting shots unavailable, using procedural batting:', e.message || e);
    D = null;
  }
  return D;
}

export const shotsReady = () => !!D;

// Which capture plays which of the game's shots. Only shots that read as real
// cricket survived the cleaning (a front-foot drive, a pull, a sweep); a
// forward defence is the drive's stride and weight transfer checked at contact
// (no follow-through, much less turn) and the flick is played off the same
// front-foot stride. Back-foot defence and the cut have no clean capture and
// stay procedural.
const USE = {
  drive: { type: 'drive' },
  flick: { type: 'drive', turn: 0.8 },
  defend: { type: 'drive', hold: true, turn: 0.35 },
  pull: { type: 'pull' },
  hook: { type: 'pull' },
  sweep: { type: 'sweep' },
};

// want: { stride, hipHeight } of the planned shot (optional): the nearest capture of the type.
export function shotFor(type, want = null) {
  if (!D) return null;
  const u = USE[type];
  if (!u) return null;
  let best = null, bd = Infinity;
  for (const s of D.shots) {
    if (s.type !== u.type) continue;
    const d = want ? Math.abs((want.stride ?? s.stride) - s.stride) + 2 * Math.abs((want.hipHeight ?? s.hipHeight) - s.hipHeight) : 0;
    if (d < bd) { bd = d; best = s; }
  }
  return best ? { shot: best, hold: !!u.hold, turn: u.turn ?? 1, type } : null;
}

const _q = new THREE.Quaternion(), _p = new THREE.Vector3();
const BIT = (names) => names.reduce((m, n) => m | (1 << ['hips', 'spine', 'chest', 'neck', 'head', 'shoulderL', 'elbowL', 'handL', 'shoulderR', 'elbowR', 'handR', 'hipL', 'kneeL', 'ankleL', 'hipR', 'kneeR', 'ankleR'].indexOf(n)), 0);
export const SHOT_BODY = BIT(['hips', 'spine', 'chest', 'neck', 'head', 'hipL', 'kneeL', 'ankleL', 'hipR', 'kneeR', 'ankleR']);

// Pose from shot `s` (an entry of shots.json) at `time` (s from its stance);
// the hips translation goes with the hips bone, scaled to the figure's legs.
export function poseShot(h, s, time, mask = SHOT_BODY) {
  if (!D) return false;
  const leg = h._shotLeg || (h._shotLeg = h.bones.kneeL.position.length() + h.bones.ankleL.position.length());
  const f = Math.min(Math.max(time, 0) * s.fps, s.frames - 1);
  const i0 = Math.floor(f), u = f - i0, i1 = Math.min(i0 + 1, s.frames - 1);
  const q = D.q, S = D.stride, a0 = s.offset + i0 * S, a1 = s.offset + i1 * S, qs = D.qs;
  for (let k = 0; k < NB; k++) {
    if (!(mask & (1 << k))) continue;
    const o0 = a0 + k * 4, o1 = a1 + k * 4;
    let x1 = q[o1], y1 = q[o1 + 1], z1 = q[o1 + 2], w1 = q[o1 + 3];
    if (q[o0] * x1 + q[o0 + 1] * y1 + q[o0 + 2] * z1 + q[o0 + 3] * w1 < 0) { x1 = -x1; y1 = -y1; z1 = -z1; w1 = -w1; }
    _q.set(q[o0] + (x1 - q[o0]) * u, q[o0 + 1] + (y1 - q[o0 + 1]) * u, q[o0 + 2] + (z1 - q[o0 + 2]) * u, q[o0 + 3] + (w1 - q[o0 + 3]) * u);
    _q.x *= qs; _q.y *= qs; _q.z *= qs; _q.w *= qs;
    h.boneList[k].quaternion.copy(_q.normalize());
  }
  if (mask & 1) {
    const p0 = a0 + NB * 4, p1 = a1 + NB * 4, sc = D.ps * leg;
    _p.set(q[p0] + (q[p1] - q[p0]) * u, q[p0 + 1] + (q[p1 + 1] - q[p0 + 1]) * u, q[p0 + 2] + (q[p1 + 2] - q[p0 + 2]) * u).multiplyScalar(sc);
    h.bones.hips.position.copy(h.hipsRest).add(_p);
  }
  return true;
}
