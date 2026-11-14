// Authored animation clips (Quaternius Universal Animation Library, CC0),
// retargeted offline onto the game's 17-bone Humanoid by tools/build_clips.mjs.
//
//   loadClips()                       once, beside loadAthlete(); fails soft
//   clipsReady()                      false -> callers use the procedural poses
//   applyClip(h, name, time, w, mask) pose (w = 1) or slerp toward (w < 1) a clip
//   clipInfo(name)                    { dur, loop, speed, stride, phase0, events }
//   applyLocomotion(h, phase, speed)  walk / jog / sprint blended by speed
//   strideAt(h, speed)                metres per cycle that keeps those feet planted
//
// Frames are int16 quaternions (local, relative to the canonical pose) plus a
// hips offset in leg lengths, sampled at 30 Hz and interpolated linearly; no
// allocation per call.
import * as THREE from 'three';

let D = null;                 // { q: Int16Array, stride, clips: Map, bones: [] }
const NB = 17;

export async function loadClips(base = './assets/anim/') {
  if (D) return D;
  try {
    const [meta, bin] = await Promise.all([
      fetch(base + 'clips.json').then((r) => { if (!r.ok) throw new Error('clips.json ' + r.status); return r.json(); }),
      fetch(base + 'clips.bin').then((r) => { if (!r.ok) throw new Error('clips.bin ' + r.status); return r.arrayBuffer(); }),
    ]);
    if (meta.bones.length !== NB) throw new Error('clips: unexpected bone count');
    const clips = new Map();
    for (const c of meta.clips) clips.set(c.name, c);
    D = { q: new Int16Array(bin), stride: meta.stride, qs: 1 / meta.qScale, ps: meta.posScale, bones: meta.bones, clips };
  } catch (e) {
    console.warn('Animation clips unavailable, using procedural poses:', e.message || e);
    D = null;
  }
  return D;
}

export const clipsReady = () => !!D;
export const clipInfo = (name) => (D ? D.clips.get(name) || null : null);

// Bone masks for partial application.
export const MASK_ALL = 0x1ffff;
const bit = (names) => names.reduce((m, n) => m | (1 << ['hips', 'spine', 'chest', 'neck', 'head', 'shoulderL', 'elbowL', 'handL', 'shoulderR', 'elbowR', 'handR', 'hipL', 'kneeL', 'ankleL', 'hipR', 'kneeR', 'ankleR'].indexOf(n)), 0);
export const MASK_LEGS = bit(['hips', 'hipL', 'kneeL', 'ankleL', 'hipR', 'kneeR', 'ankleR']);
export const MASK_ARMS = bit(['shoulderL', 'elbowL', 'handL', 'shoulderR', 'elbowR', 'handR']);
export const MASK_TRUNK = bit(['spine', 'chest', 'neck', 'head']);
const HIPS_POS = 1 << 17;     // in a mask: also set the hips translation (on by default with the hips bone)

const _q = new THREE.Quaternion(), _p = new THREE.Vector3();

function rig(h) {
  // Cached per figure: its bones in the clip order and its leg length (model units).
  if (!h._clipRig) {
    h._clipRig = {
      bones: D.bones.map((n) => h.bones[n]),
      leg: h.bones.kneeL.position.length() + h.bones.ankleL.position.length(),
    };
  }
  return h._clipRig;
}

// Pose `h` from clip `name` at `time` (s). weight < 1 slerps from the pose
// already on the figure. mask: which bones (MASK_*); hips translation goes with the hips bone.
export function applyClip(h, name, time, weight = 1, mask = MASK_ALL) {
  if (!D || weight <= 0) return false;
  const c = D.clips.get(name);
  if (!c) return false;
  const R = rig(h);
  const n = c.frames;
  let f;
  if (c.loop) { const span = n / c.fps; let t = time % span; if (t < 0) t += span; f = t * c.fps; }
  else f = Math.min(Math.max(time, 0) * c.fps, n - 1);
  const i0 = Math.floor(f), u = f - i0;
  const i1 = c.loop ? (i0 + 1) % n : Math.min(i0 + 1, n - 1);
  const q = D.q, S = D.stride, a0 = c.offset + i0 * S, a1 = c.offset + i1 * S, qs = D.qs;
  for (let k = 0; k < NB; k++) {
    if (!(mask & (1 << k))) continue;
    const o0 = a0 + k * 4, o1 = a1 + k * 4;
    let x1 = q[o1], y1 = q[o1 + 1], z1 = q[o1 + 2], w1 = q[o1 + 3];
    if (q[o0] * x1 + q[o0 + 1] * y1 + q[o0 + 2] * z1 + q[o0 + 3] * w1 < 0) { x1 = -x1; y1 = -y1; z1 = -z1; w1 = -w1; }
    _q.set(q[o0] + (x1 - q[o0]) * u, q[o0 + 1] + (y1 - q[o0 + 1]) * u, q[o0 + 2] + (z1 - q[o0 + 2]) * u, q[o0 + 3] + (w1 - q[o0 + 3]) * u);
    _q.x *= qs; _q.y *= qs; _q.z *= qs; _q.w *= qs;
    _q.normalize();
    const b = R.bones[k];
    if (weight >= 1) b.quaternion.copy(_q); else b.quaternion.slerp(_q, weight);
  }
  if (mask & (1 | HIPS_POS)) {
    const p0 = a0 + NB * 4, p1 = a1 + NB * 4, s = D.ps * R.leg;
    _p.set(q[p0] + (q[p1] - q[p0]) * u, q[p0 + 1] + (q[p1 + 1] - q[p0 + 1]) * u, q[p0 + 2] + (q[p1 + 2] - q[p0 + 2]) * u).multiplyScalar(s).add(h.hipsRest);
    const hp = h.bones.hips.position;
    if (weight >= 1) hp.copy(_p); else hp.lerp(_p, weight);
  }
  return true;
}

// ------------------------------------------------------------ locomotion
// Walk (~0.9 m/s), jog (~5 m/s) and sprint (~7.5 m/s for a 1.87 m figure),
// phase-aligned on the left foot's touchdown and blended by speed. Below the
// walk's own speed the walk fades into whatever is underneath (idle).
const GAITS = ['walk', 'jog', 'sprint'];
const _w = [0, 0, 0];
function gaitWeights(h, speed) {
  const L = rig(h).leg * h.root.scale.y;                 // leg length, metres
  const vw = D.clips.get('walk').speed * L, vj = D.clips.get('jog').speed * L, vs = D.clips.get('sprint').speed * L;
  // The jog takes over from the walk between a brisk walk and a steady run.
  const a = Math.min(1, Math.max(0, (speed - vw * 1.45) / (vj * 0.62 - vw * 1.45)));
  const b = Math.min(1, Math.max(0, (speed - vj * 0.95) / (vs * 0.9 - vj * 0.95)));
  const ea = a * a * (3 - 2 * a), eb = b * b * (3 - 2 * b);
  _w[0] = 1 - ea; _w[1] = ea * (1 - eb); _w[2] = ea * eb;
  return L;
}

// Metres per full cycle (two steps) at this speed, for the blend the figure is using.
export function strideAt(h, speed) {
  if (!D) return null;
  const L = gaitWeights(h, speed);
  let s = 0;
  for (let i = 0; i < 3; i++) s += _w[i] * D.clips.get(GAITS[i]).stride * L;
  return Math.max(0.6, s);
}

// phase: radians (Actor.phase; 0 = left foot down). weight: over what is posed.
export function applyLocomotion(h, phase, speed, weight = 1, mask = MASK_ALL) {
  if (!D || weight <= 0) return false;
  gaitWeights(h, speed);
  const vw = D.clips.get('walk').speed * rig(h).leg * h.root.scale.y;
  const fade = Math.min(1, Math.max(0, speed / (vw * 0.75)));     // slow: a small walk over the idle
  const cyc = phase / (Math.PI * 2), R = rig(h), k = weight * fade;
  if (k < 1) R.snap = h.snapshot(R.snap);           // what is posed underneath
  let acc = 0;
  for (let i = 0; i < 3; i++) {
    const w = _w[i];
    if (w < 1e-3) continue;
    const c = D.clips.get(GAITS[i]);
    acc += w;
    applyClip(h, GAITS[i], (cyc + c.phase0) * c.dur, w / acc, mask);
  }
  if (k < 1) h.blendFrom(R.snap, k);
  return true;
}
