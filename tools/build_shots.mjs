// Batting shots from a video-derived motion capture (mimem.ai: one take of ~20
// broadcast clips of a right-handed batter, Unity-style humanoid FBX), cut
// into single shots, cleaned and retargeted onto the game's 17-bone Humanoid:
//   assets/anim/shots.json  (shot table: type, events, footwork, checks)
//   assets/anim/shots.bin   (int16 frames at 30 Hz: 17 local quaternions + hips offset,
//                            the same layout as clips.bin)
// Usage: node tools/build_shots.mjs <unity.fbx> [node_modules dir with three] [out dir] [--debug dir]
//
// Pipeline (all automatic; the kept list at the bottom was confirmed by eye
// from stick-figure sheets written with --debug):
//  1. sample the take at 60 Hz and retarget every frame onto the game rig
//     (world-rotation deltas from the T-pose rest, like tools/build_clips.mjs);
//  2. find the swings (peaks of hand speed relative to the pelvis) and cut a
//     window round each: from the settled stance ~1 s before to ~0.8 s after;
//  3. reject windows that cross a camera cut or a reconstruction failure:
//     the pelvis teleporting, the pose jumping between frames, a crumpled
//     trunk, no settled stance;
//  4. clean what is left: turn it into the game's frame (bowler toward -Z, a
//     right-hander side-on facing +X), smooth the rotations (zero-phase,
//     lighter where the body moves fast so the swing keeps its snap), put the
//     feet on the floor, find the foot contacts, remove the root drift, pin
//     the planted feet and re-solve the legs with hinge-correct IK;
//  5. mark the events (stance, backlift top, contact, finish), the footwork
//     and classify the shot from explainable features.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const dbgAt = args.indexOf('--debug');
const DEBUG = dbgAt >= 0 ? args.splice(dbgAt, 2)[1] : null;
const src = args[0];
const modDir = args[1] || path.resolve('node_modules');
const here = path.dirname(new URL(import.meta.url).pathname);
const outDir = args[2] || path.resolve(here, '../assets/anim');
globalThis.window = globalThis; globalThis.self = globalThis;
globalThis.document = { createElementNS: () => ({ style: {}, addEventListener() {}, removeEventListener() {} }), createElement: () => ({ style: {}, getContext: () => null }) };
const THREE = await import(pathToFileURL(path.join(modDir, 'three/build/three.module.js')).href);
const { FBXLoader } = await import(pathToFileURL(path.join(modDir, 'three/examples/jsm/loaders/FBXLoader.js')).href);
const { Vector3: V3, Quaternion: Q4 } = THREE;

const RATE = 60;           // processing rate (the source's own)
const OUT_FPS = 30;        // stored rate
const BONES = ['hips', 'spine', 'chest', 'neck', 'head', 'shoulderL', 'elbowL', 'handL', 'shoulderR', 'elbowR', 'handR', 'hipL', 'kneeL', 'ankleL', 'hipR', 'kneeR', 'ankleR'];
const NB = BONES.length;
const BI = Object.fromEntries(BONES.map((b, i) => [b, i]));
const PARENT = { hips: null, spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck', shoulderL: 'chest', elbowL: 'shoulderL', handL: 'elbowL', shoulderR: 'chest', elbowR: 'shoulderR', handR: 'elbowR', hipL: 'hips', kneeL: 'hipL', ankleL: 'kneeL', hipR: 'hips', kneeR: 'hipR', ankleR: 'kneeR' };
const MAP = {
  hips: 'Hips', spine: 'Spine2', chest: 'Chest', neck: 'Neck1', head: 'Head',
  shoulderL: 'LeftArm', elbowL: 'LeftForeArm', handL: 'LeftHand', shoulderR: 'RightArm', elbowR: 'RightForeArm', handR: 'RightHand',
  hipL: 'LeftLeg', kneeL: 'LeftShin', ankleL: 'LeftFoot', hipR: 'RightLeg', kneeR: 'RightShin', ankleR: 'RightFoot',
};
const LIMB_CHILD = {
  shoulderL: 'LeftForeArm', elbowL: 'LeftHand', handL: 'LeftHandMiddle1', shoulderR: 'RightForeArm', elbowR: 'RightHand', handR: 'RightHandMiddle1',
  hipL: 'LeftShin', kneeL: 'LeftFoot', hipR: 'RightShin', kneeR: 'RightFoot',
};

// ---------------------------------------------------------------- source
console.warn = () => {};
const buf = fs.readFileSync(src);
const obj = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
const clip = obj.animations.find((c) => c.tracks.length);
const mixer = new THREE.AnimationMixer(obj);
const bone = {};
obj.traverse((o) => { if (o.isBone && !bone[o.name]) bone[o.name] = o; });
const wq = (n, out = new Q4()) => bone[n].getWorldQuaternion(out);
const wp = (n, out = new V3()) => bone[n].getWorldPosition(out);

obj.updateMatrixWorld(true);                 // the bind pose: a T-pose facing +Z, left on +X (like the game rig)
const restQinv = {}, Ainv = {};
for (const b of BONES) {
  restQinv[b] = wq(MAP[b]).invert();
  Ainv[b] = new Q4();
  if (LIMB_CHILD[b]) Ainv[b].setFromUnitVectors(new V3(0, -1, 0), wp(LIMB_CHILD[b]).sub(wp(MAP[b])).normalize());
}
const srcLeg = wp('LeftLeg').distanceTo(wp('LeftShin')) + wp('LeftShin').distanceTo(wp('LeftFoot'));

// ---------------------------------------------------------------- game rig (canonical pose, as humanoid.js builds it)
const TJ = JSON.parse(fs.readFileSync(path.resolve(here, '../assets/models/athlete.json'), 'utf8')).joints;
const canon = {};
for (const b of BONES) canon[b] = new V3(...TJ[b]);
for (const s of ['L', 'R']) {
  const J = (n) => new V3(...TJ[n + s]);
  canon['elbow' + s] = canon['shoulder' + s].clone().add(new V3(0, -J('shoulder').distanceTo(J('elbow')), 0));
  canon['hand' + s] = canon['elbow' + s].clone().add(new V3(0, -J('elbow').distanceTo(J('hand')), 0));
  canon['knee' + s] = canon['hip' + s].clone().add(new V3(0, -J('hip').distanceTo(J('knee')), 0));
  canon['ankle' + s] = canon['knee' + s].clone().add(new V3(0, -J('knee').distanceTo(J('ankle')), 0));
}
const LOCAL = {};
for (const b of BONES) LOCAL[b] = PARENT[b] ? canon[b].clone().sub(canon[PARENT[b]]) : canon[b].clone();
const THIGH = LOCAL.kneeL.length(), SHIN = LOCAL.ankleL.length(), LEG = THIGH + SHIN;
const ANKLE_H = TJ.ankleL[1];                  // sole to ankle joint
const K = LEG / srcLeg;                        // source metres -> game metres
const HIPMID = canon.hipL.clone().add(canon.hipR).multiplyScalar(0.5).sub(canon.hips);   // hips bone -> hip-joint midpoint
// Points on the foot (ankle frame, canonical): heel and ball of the foot.
const HEEL = new V3(0, -ANKLE_H + 0.012, -0.06), BALL = new V3(0, -ANKLE_H + 0.012, 0.13), MIDF = HEEL.clone().add(BALL).multiplyScalar(0.5);

// World transforms of the game rig from local quats + hips position.
function fk(qs, hp) {
  const Wq = new Array(NB), Wp = new Array(NB);
  for (let k = 0; k < NB; k++) {
    const b = BONES[k], p = PARENT[b];
    if (!p) { Wq[k] = qs[k].clone(); Wp[k] = hp.clone(); continue; }
    const pi = BI[p];
    Wq[k] = Wq[pi].clone().multiply(qs[k]);
    Wp[k] = LOCAL[b].clone().applyQuaternion(Wq[pi]).add(Wp[pi]);
  }
  return { Wq, Wp };
}
const footPt = (F, s, pt) => pt.clone().applyQuaternion(F.Wq[BI['ankle' + s]]).add(F.Wp[BI['ankle' + s]]);

// ---------------------------------------------------------------- sample + retarget the whole take
mixer.clipAction(clip).play();
const N = Math.floor(clip.duration * RATE) + 1;
const TAKE = { q: [], hp: [] };            // per frame: 17 local quats, hips position (game metres, source frame)
{
  const W = {}, _i = new Q4();
  for (let f = 0; f < N; f++) {
    mixer.setTime(f / RATE);
    obj.updateMatrixWorld(true);
    for (const b of BONES) W[b] = wq(MAP[b]).multiply(restQinv[b]).multiply(Ainv[b]);
    const qs = BONES.map((b) => (PARENT[b] ? _i.copy(W[PARENT[b]]).invert().multiply(W[b]).clone() : W[b].clone()).normalize());
    // Hips: put the game's hip joints where the source's are (the bones' pivots differ).
    const mid = wp('LeftLeg').add(wp('RightLeg')).multiplyScalar(0.5 * K);
    TAKE.q.push(qs);
    TAKE.hp.push(mid.sub(HIPMID.clone().applyQuaternion(qs[0])));
  }
  // continuous hemispheres
  for (let k = 0; k < NB; k++) for (let f = 1; f < N; f++) if (TAKE.q[f][k].dot(TAKE.q[f - 1][k]) < 0) { const q = TAKE.q[f][k]; q.set(-q.x, -q.y, -q.z, -q.w); }
}
console.log(`source: ${clip.name} ${clip.duration.toFixed(2)} s, ${N} frames at ${RATE} Hz; leg ${srcLeg.toFixed(3)} m -> game ${LEG.toFixed(3)} m`);


// ---------------------------------------------------------------- game rig as a bone hierarchy (for FK and leg IK)
// The figure's own frame: facing +Z, left +X (the AI batter's root is turned so +Z points to the off side and +X to the bowler).
class Rig {
  constructor() {
    this.b = {};
    for (const n of BONES) {
      const o = new THREE.Object3D();
      o.position.copy(LOCAL[n]);
      if (PARENT[n]) this.b[PARENT[n]].add(o);
      this.b[n] = o;
    }
    this.root = this.b.hips;
  }
  set(qs, hp) { BONES.forEach((n, k) => this.b[n].quaternion.copy(qs[k])); this.b.hips.position.copy(hp); this.root.updateMatrixWorld(true); return this; }
  pos(n, out = new V3()) { return this.b[n].getWorldPosition(out); }
  quat(n, out = new Q4()) { return this.b[n].getWorldQuaternion(out); }
  point(s, pt, out = new V3()) { return out.copy(pt).applyQuaternion(this.quat('ankle' + s)).add(this.pos('ankle' + s)); }
  locals() { return BONES.map((n) => this.b[n].quaternion.clone()); }
  setWorldQuat(n, q) { const o = this.b[n]; const p = o.parent.getWorldQuaternion(new Q4()).invert(); o.quaternion.copy(p.multiply(q)); o.updateMatrixWorld(true); }
}
// Hinge-correct two-bone IK, as in src/render/humanoid.js solveTwoBone (flex -1 = knee).
function solveTwoBone(upper, lower, end, target, pole, flex) {
  const S = upper.getWorldPosition(new V3()), E = lower.getWorldPosition(new V3()), T0 = end.getWorldPosition(new V3());
  const a = S.distanceTo(E), b = E.distanceTo(T0);
  const dir = target.clone().sub(S);
  let d = dir.length();
  if (d < 1e-5) return;
  dir.divideScalar(d);
  d = Math.min(Math.max(d, Math.abs(a - b) + 1e-3), a + b - 1e-4);
  const pv = pole.clone().sub(S); pv.addScaledVector(dir, -pv.dot(dir));
  if (pv.lengthSq() < 1e-10) pv.set(0, 0, 1).addScaledVector(dir, -dir.z);
  pv.normalize();
  const cosA = Math.min(1, Math.max(-1, (a * a + d * d - b * b) / (2 * a * d))), sinA = Math.sqrt(1 - cosA * cosA);
  const Ej = S.clone().addScaledVector(dir, a * cosA).addScaledVector(pv, a * sinA), Tj = S.clone().addScaledVector(dir, d);
  const hu = Ej.clone().sub(S).normalize(), hl = Tj.clone().sub(Ej).normalize();
  const hf = hl.clone().addScaledVector(hu, -hl.dot(hu));
  if (hf.lengthSq() < 1e-8) hf.copy(pv).negate().addScaledVector(hu, pv.dot(hu));
  hf.normalize().multiplyScalar(flex);
  const set = (bone, x, y, z) => {
    const q = new Q4().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    const p = bone.parent.getWorldQuaternion(new Q4()).invert();
    bone.quaternion.copy(p.multiply(q)); bone.updateMatrixWorld(true);
  };
  let hy = hu.clone().negate();
  const hx = new V3().crossVectors(hy, hf).normalize();
  set(upper, hx, hy, hf);
  hy = hl.clone().negate();
  set(lower, hx, hy, new V3().crossVectors(hx, hy).normalize());
}

// ---------------------------------------------------------------- small signal helpers
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// Zero-phase Gaussian smoothing with a per-sample width (samples), edges clamped.
function gauss(arr, sig) {
  const n = arr.length, out = new Array(n);
  for (let i = 0; i < n; i++) {
    const s = typeof sig === 'number' ? sig : sig[i];
    if (s < 0.3) { out[i] = arr[i]; continue; }
    const R = Math.ceil(s * 3);
    let acc = 0, wsum = 0;
    for (let j = -R; j <= R; j++) { const w = Math.exp(-0.5 * (j / s) ** 2); acc += w * arr[clamp(i + j, 0, n - 1)]; wsum += w; }
    out[i] = acc / wsum;
  }
  return out;
}
const speed = (pts, i) => (i ? pts[i].distanceTo(pts[i - 1]) * RATE : 0);

// ---------------------------------------------------------------- whole-take analysis (source frame)
const rig = new Rig();
const A = { hands: [], hips: [], low: [], poseV: [], yawV: [], hipV: [], yaw: [] };
{
  let prevB = null;
  for (let f = 0; f < N; f++) {
    rig.set(TAKE.q[f], TAKE.hp[f]);
    const hips = rig.pos('hips'), hand = rig.pos('handL').add(rig.pos('handR')).multiplyScalar(0.5);
    const lr = rig.pos('hipL').sub(rig.pos('hipR'));
    const yaw = Math.atan2(lr.x, lr.z);
    // body-frame joint positions (pelvis yaw removed) -> how fast the pose itself changes
    const c = Math.cos(-yaw), s = Math.sin(-yaw);
    const B = BONES.map((n) => { const p = rig.pos(n).sub(hips); return new V3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c); });
    let low = 9;
    for (const sd of ['L', 'R']) for (const pt of [HEEL, BALL]) low = Math.min(low, rig.point(sd, pt).y);
    A.hands.push(hand.sub(hips)); A.hips.push(hips); A.low.push(low); A.yaw.push(yaw);
    A.poseV.push(prevB ? B.reduce((acc, p, k) => acc + p.distanceTo(prevB[k]), 0) / NB * RATE : 0);
    A.yawV.push(f ? Math.abs(Math.atan2(Math.sin(yaw - A.yaw[f - 1]), Math.cos(yaw - A.yaw[f - 1]))) * RATE : 0);
    A.hipV.push(f ? Math.hypot(hips.x - A.hips[f - 1].x, hips.z - A.hips[f - 1].z) * RATE : 0);
    prevB = B;
  }
  A.handV = gauss(A.hands.map((_, i) => speed(A.hands, i)), 2);
  A.poseVs = gauss(A.poseV, 2);
  A.yawVs = gauss(A.yawV, 2);
  A.groundStep = A.low.map((v, i) => (i ? Math.abs(v - A.low[i - 1]) * RATE : 0));
}
// Frames that belong to a camera cut or a reconstruction failure.
const BAD = new Uint8Array(N);
{
  const why = new Array(N).fill('');
  for (let f = 1; f < N; f++) {
    if (A.hipV[f] > 2.5) why[f] += 'root ';            // the pelvis flying across the floor (a teleport / the body thrown about)
    if (A.poseVs[f] > 1.9) why[f] += 'pose ';          // the whole pose jumps between frames (a cut to another clip)
    if (A.yawVs[f] > 9) why[f] += 'flip ';              // the pelvis flips round in a frame or two
    if (A.groundStep[f] > 2.5) why[f] += 'ground ';    // the floor under the feet jumps (a cut: new camera, new depth)
  }
  for (let f = 0; f < N; f++) if (why[f]) for (let g = Math.max(0, f - 3); g <= Math.min(N - 1, f + 3); g++) BAD[g] = 1;
  A.why = why;
}
// Swings: peaks of the hands' speed relative to the pelvis.
const peaks = [];
for (let f = 1; f < N - 1; f++) {
  const v = A.handV[f];
  if (v < 1.5) continue;
  let top = true;
  for (let g = Math.max(0, f - 30); g <= Math.min(N - 1, f + 30); g++) if (A.handV[g] > v) { top = false; break; }
  if (top) peaks.push(f);
}

// ---------------------------------------------------------------- windows round the swings, automatic rejection
const act = gauss(A.poseV.map((v, i) => v + 0.5 * A.handV[i]), 4);
const cands = [];
for (const c of peaks) {
  const r = { c, t: +(c / RATE).toFixed(2), why: [] };
  if (BAD[c]) { r.why.push('swing peak on a cut/glitch (' + (A.why.slice(c - 4, c + 5).join('').trim() || 'near one') + ')'); cands.push(r); continue; }
  // Stance: the latest settled frame 1.4-0.55 s before contact.
  let s = -1, best = 9;
  for (let f = Math.max(0, c - Math.round(1.4 * RATE)); f <= c - Math.round(0.55 * RATE); f++) best = Math.min(best, act[f]);
  for (let f = c - Math.round(0.55 * RATE); f >= Math.max(0, c - Math.round(1.4 * RATE)); f--) if (act[f] < best * 1.25 + 0.08) { s = f; break; }
  r.s = s; r.stanceAct = +best.toFixed(2);
  let e = Math.min(N - 1, c + Math.round(0.85 * RATE));
  for (let f = c; f <= e; f++) if (BAD[f]) { e = f - 3; break; }
  r.e = e;
  for (let f = Math.max(0, s); f <= c; f++) if (BAD[f]) { r.why.push(`cut/glitch at ${(f / RATE).toFixed(2)} s between stance and contact (${A.why.slice(f, f + 4).join('').trim() || 'margin'})`); break; }
  if (best > 0.9) r.why.push(`no settled stance before the swing (activity ${best.toFixed(2)})`);
  if (e - c < 0.4 * RATE) r.why.push(`follow-through cut short at ${(e / RATE).toFixed(2)} s`);
  // A crumpled body: the pelvis down at the feet, or the trunk folded flat.
  for (let f = Math.max(0, s); f <= e; f++) {
    const hh = A.hips[f].y - A.low[f];
    if (hh < 0.3) { r.why.push(`crumpled (pelvis ${hh.toFixed(2)} m off the floor at ${(f / RATE).toFixed(2)} s)`); break; }
  }
  cands.push(r);
}
for (const r of cands) console.log(`swing ${r.t.toFixed(2)} s  stance ${r.s >= 0 ? (r.s / RATE).toFixed(2) : '-'} end ${r.e != null ? (r.e / RATE).toFixed(2) : '-'}  peak ${A.handV[r.c].toFixed(1)} m/s  ${r.why.length ? 'REJECT: ' + r.why.join('; ') : 'ok'}`);

// ---------------------------------------------------------------- cleaning one shot
const UPX = new V3(1, 0, 0), Y = new V3(0, 1, 0);
const mirrorQ = (q) => new Q4(q.x, -q.y, -q.z, q.w);
const SWAP = BONES.map((b) => BI[b.endsWith('L') ? b.slice(0, -1) + 'R' : b.endsWith('R') ? b.slice(0, -1) + 'L' : b]);

function clean(r, anchorBack = false) {
  const PAD = 20;
  const f0 = r.s, f1 = r.e, n = f1 - f0 + 1;
  const src = (f) => clamp(f, Math.max(0, f0 - PAD), Math.min(N - 1, f1 + PAD));
  // --- handedness: a right-hander's hands come down from the backlift toward the bowler, who is on
  // the side of his left (front) foot. (The capture's hands are too rough to tell the top hand.)
  rig.set(TAKE.q[f0], TAKE.hp[f0]);
  const rl = rig.pos('ankleL').sub(rig.pos('ankleR')).setY(0);
  if (rl.length() < 0.25) rl.copy(rig.pos('hipL').sub(rig.pos('hipR')).setY(0));
  let topF = r.c - Math.round(0.6 * RATE);
  for (let f = topF; f <= r.c - Math.round(0.08 * RATE); f++) if (A.handV[f] < A.handV[topF]) topF = f;
  const handUp = A.hands[r.c].clone().add(A.hips[r.c]).sub(A.hands[topF]).sub(A.hips[topF]).dot(rl.normalize());
  const vc = A.hands[r.c + 2].clone().add(A.hips[r.c + 2]).sub(A.hands[r.c - 2]).sub(A.hips[r.c - 2]).multiplyScalar(RATE / 4).dot(rl);
  const lefty = handUp + 0.2 * vc < 0;
  const frame = (f) => {
    let qs = TAKE.q[src(f)].map((q) => q.clone()), hp = TAKE.hp[src(f)].clone();
    if (lefty) { qs = SWAP.map((k) => mirrorQ(qs[k])); hp.x = -hp.x; }
    return { qs, hp };
  };
  let st = frame(f0);
  rig.set(st.qs, st.hp);
  const feetV = rig.pos('ankleL').sub(rig.pos('ankleR')).setY(0), pelV = rig.pos('hipL').sub(rig.pos('hipR')).setY(0).normalize();
  const bowl = feetV.length() > 0.25 ? feetV.clone().normalize().add(pelV).normalize() : pelV.clone();
  const turn = new Q4().setFromUnitVectors(bowl, UPX);           // bowler -> +X of the figure (= world -Z with the batter facing +X)
  const origin = rig.pos('ankleL').add(rig.pos('ankleR')).multiplyScalar(0.5).setY(0).applyQuaternion(turn);
  // --- canonical frames, padded for the filters
  const pad0 = Math.max(0, f0 - PAD), pad1 = Math.min(N - 1, f1 + PAD);
  const FR = [];
  for (let f = pad0; f <= pad1; f++) {
    const { qs, hp } = frame(f);
    qs[0] = turn.clone().multiply(qs[0]);
    hp.applyQuaternion(turn).sub(origin);
    FR.push({ qs, hp });
  }
  const off = f0 - pad0, M = FR.length;
  // --- zero-phase smoothing, lighter while the body moves fast (keeps the swing's snap)
  const actv = FR.map((_, i) => A.handV[pad0 + i] + A.poseVs[pad0 + i]);
  const sig = actv.map((a) => 1.3 + 3.2 * (1 - clamp(a / 4, 0, 1)));
  for (let k = 0; k < NB; k++) {
    for (let i = 1; i < M; i++) if (FR[i].qs[k].dot(FR[i - 1].qs[k]) < 0) { const q = FR[i].qs[k]; q.set(-q.x, -q.y, -q.z, -q.w); }
    const c = ['x', 'y', 'z', 'w'].map((a) => gauss(FR.map((F) => F.qs[k][a]), sig));
    FR.forEach((F, i) => F.qs[k].set(c[0][i], c[1][i], c[2][i], c[3][i]).normalize());
  }
  for (const a of ['x', 'y', 'z']) { const v = gauss(FR.map((F) => F.hp[a]), sig); FR.forEach((F, i) => { F.hp[a] = v[i]; }); }
  const S = FR.slice(off, off + n);           // the shot itself
  const raw = S.map((F) => ({ qs: F.qs.map((q) => q.clone()), hp: F.hp.clone() }));
  // --- ground: the lowest foot (or a kneeling knee) on the floor, every frame (smoothed)
  const lowest = (s) => Math.min(rig.point(s, HEEL).y, rig.point(s, BALL).y);
  const g = S.map((F) => { rig.set(F.qs, F.hp); return Math.min(lowest('L'), lowest('R'), rig.pos('kneeL').y - 0.06, rig.pos('kneeR').y - 0.06); });
  const gs = gauss(g, 5);
  S.forEach((F, i) => { F.hp.y -= gs[i]; });
  // Depth along the pitch is what a broadcast camera sees worst: on some front-foot shots the
  // capture slides the back foot back instead of the front foot forward. Same relative motion;
  // here the back foot is held and the body (and the front foot) go forward instead.
  if (anchorBack) {
    const b0 = (() => { rig.set(S[0].qs, S[0].hp); return rig.point('R', MIDF); })();
    const dx = [], dz = [];
    for (const F of S) { rig.set(F.qs, F.hp); const p = rig.point('R', MIDF); dx.push(p.x - b0.x); dz.push(p.z - b0.z); }
    const sx = gauss(dx, 3), sz = gauss(dz, 3);
    S.forEach((F, i) => { F.hp.x -= sx[i]; F.hp.z -= sz[i]; });
  }
  // --- foot contacts: low and slow (the pivot point: the lower of heel and ball)
  const P = { L: [], R: [] }, H = { L: [], R: [] };
  for (const F of S) {
    rig.set(F.qs, F.hp);
    for (const s of ['L', 'R']) {
      const he = rig.point(s, HEEL), ba = rig.point(s, BALL);
      P[s].push(rig.point(s, MIDF)); H[s].push(Math.min(he.y, ba.y));
    }
  }
  const on = {}, V = {}, TOE = { L: 0, R: 0 };
  for (const s of ['L', 'R']) {
    const v = gauss(P[s].map((p, i) => (i ? Math.hypot(p.x - P[s][i - 1].x, p.z - P[s][i - 1].z) * RATE : 0)), 1.5);
    // planted: low and slow, or simply still (a batter never hovers a still foot; the capture often floats one)
    let c = P[s].map((p, i) => ((H[s][i] < 0.04 && v[i] < 0.45) || v[i] < 0.12 ? 1 : 0));
    V[s] = v;
    // close gaps < 6 frames, drop blips < 6 frames
    const runs = (arr, val) => { const out = []; let a = -1; for (let i = 0; i <= arr.length; i++) { if (i < arr.length && arr[i] === val) { if (a < 0) a = i; } else if (a >= 0) { out.push([a, i - 1]); a = -1; } } return out; };
    for (const [a, b] of runs(c, 0)) if (a > 0 && b < n - 1 && b - a + 1 < 6) for (let i = a; i <= b; i++) c[i] = 1;
    for (const [a, b] of runs(c, 1)) if (b - a + 1 < 6) for (let i = a; i <= b; i++) c[i] = 0;
    // a foot held up behind for a long time while barely travelling: the back foot after a drive,
    // which a batter keeps on its toe (the capture folds the knee and lifts it) -> down on the toe
    for (const [a, b] of runs(c, 0)) {
      const travel = Math.hypot(P[s][b].x - P[s][a].x, P[s][b].z - P[s][a].z), dur = (b - a + 1) / RATE;
      let hm = 0; for (let i = a; i <= b; i++) hm += H[s][i] / (b - a + 1);
      if (dur > 0.35 && travel / dur < 0.4 && hm > 0.06) { for (let i = a; i <= b; i++) c[i] = 1; TOE[s] = 1; }
    }
    on[s] = c;
  }
  for (let i = 0; i < n; i++) if (!on.L[i] && !on.R[i]) { if (H.L[i] <= H.R[i]) on.L[i] = 1; else on.R[i] = 1; }   // someone is always standing
  // --- pins: each contact run holds the foot where it landed; in flight the correction moves from one pin to the next
  const D = {}, PIN = { L: [], R: [] };
  for (const s of ['L', 'R']) {
    const d = new Array(n).fill(null), c = on[s];
    let i = 0;
    const runs = [];
    while (i < n) { if (!c[i]) { i++; continue; } let j = i; while (j + 1 < n && c[j + 1]) j++; runs.push([i, j]); i = j + 1; }
    for (const [a, b] of runs) {
      const k = Math.min(b, a + 3), pin = new V3();
      for (let m = a; m <= k; m++) pin.add(P[s][m]);
      pin.divideScalar(k - a + 1);
      for (let m = a; m <= b; m++) { d[m] = new V3(pin.x - P[s][m].x, 0, pin.z - P[s][m].z); PIN[s][m] = pin; }
    }
    // flight: blend between the neighbouring pins' corrections
    for (let m = 0; m < n; m++) {
      if (d[m]) continue;
      let a = m; while (a < n && !d[a]) a++;
      const prev = m > 0 ? d[m - 1] : null, next = a < n ? d[a] : null, start = m;
      for (let q = start; q < a; q++) {
        const u = sstep(start - 1, a, q);
        d[q] = prev && next ? prev.clone().lerp(next, u) : (prev || next || new V3()).clone();
      }
      m = a - 1;
    }
    D[s] = d;
  }
  // --- root drift: move the whole body with its planted feet (only the residual is left to the leg IK)
  const rx = [], rz = [];
  for (let i = 0; i < n; i++) {
    const wL = on.L[i], wR = on.R[i], w = wL + wR;
    rx.push((D.L[i].x * wL + D.R[i].x * wR) / w); rz.push((D.R[i].z * wR + D.L[i].z * wL) / w);
  }
  const rxs = gauss(rx, 4), rzs = gauss(rz, 4);
  S.forEach((F, i) => { F.hp.x += rxs[i]; F.hp.z += rzs[i]; });
  // --- leg IK to the pinned feet, knees bending the way the capture bent them
  const out = [];
  let lifted = 0;
  for (let i = 0; i < n; i++) {
    const F = S[i];
    rig.set(F.qs, F.hp);
    const tgt = {};
    for (const s of ['L', 'R']) {
      const ank = rig.pos('ankle' + s), q = rig.quat('ankle' + s);
      const t = ank.clone().add(D[s][i]).sub(new V3(rxs[i], 0, rzs[i]));
      // feet flat when planted (keep the turn, and a heel raised on the toe)
      if (on[s][i]) {
        const fw = new V3(0, 0, 1).applyQuaternion(q), pitch = Math.asin(clamp(fw.y, -1, 1));
        const yawQ = new Q4().setFromAxisAngle(Y, Math.atan2(fw.x, fw.z));
        const keep = pitch < -0.22 ? new Q4().setFromAxisAngle(UPX, Math.min(-pitch, 0.9)) : TOE[s] && H[s][i] > 0.06 ? new Q4().setFromAxisAngle(UPX, 0.45) : new Q4();   // toes down, heel up
        q.copy(yawQ.multiply(keep));
      }
      // the sole on (never through) the floor; a planted foot exactly on its pin
      const lo = Math.min(HEEL.clone().applyQuaternion(q).y, BALL.clone().applyQuaternion(q).y);
      if (on[s][i]) { const m = MIDF.clone().applyQuaternion(q); t.set(PIN[s][i].x - m.x, -lo, PIN[s][i].z - m.z); }
      else if (t.y + lo < 0) t.y = -lo;
      tgt[s] = { t, q };
    }
    // a sliding step (no lift in the capture) is picked up off the floor
    for (const s of ['L', 'R']) {
      if (on[s][i]) continue;
      let a = i, b = i;
      while (a > 0 && !on[s][a - 1]) a--;
      while (b < n - 1 && !on[s][b + 1]) b++;
      const u = (i - a + 1) / (b - a + 2), dist = P[s][Math.max(0, a - 1)].distanceTo(P[s][Math.min(n - 1, b + 1)]);
      let peak = 0; for (let m = a; m <= b; m++) peak = Math.max(peak, H[s][m]);
      if (peak < 0.04) { tgt[s].t.y += 0.07 * Math.sin(Math.PI * u) * Math.min(1, dist / 0.25); lifted = 1; }
    }
    // legs too short for the targets: lower the pelvis a little
    let need = 0;
    for (const s of ['L', 'R']) { const d = rig.pos('hip' + s).distanceTo(tgt[s].t); need = Math.max(need, d - LEG * 0.995); }
    out.push({ tgt, need });
  }
  const drop = gauss(out.map((o) => Math.max(0, o.need) * 1.1), 3);
  const res = [];
  let maxSlide = 0;
  const pinPrev = {};
  for (let i = 0; i < n; i++) {
    const F = S[i];
    F.hp.y -= drop[i];
    rig.set(F.qs, F.hp);
    for (const s of ['L', 'R']) {
      const { t, q } = out[i].tgt[s];
      const hip = rig.pos('hip' + s), knee = rig.pos('knee' + s);
      const mid = hip.clone().add(t).multiplyScalar(0.5);
      const pole = knee.clone().add(knee.clone().sub(mid).normalize().multiplyScalar(0.5));
      solveTwoBone(rig.b['hip' + s], rig.b['knee' + s], rig.b['ankle' + s], t, pole, -1);
      rig.setWorldQuat('ankle' + s, q);
    }
    // checks: planted feet must not slide
    for (const s of ['L', 'R']) {
      const p = rig.point(s, MIDF);
      if (on[s][i] && pinPrev[s] && on[s][i - 1]) maxSlide = Math.max(maxSlide, Math.hypot(p.x - pinPrev[s].x, p.z - pinPrev[s].z));
      pinPrev[s] = p;
    }
    res.push({ qs: rig.locals(), hp: rig.b.hips.position.clone() });
  }
  return { frames: res, raw, on, toe: TOE, lefty, handUp, origin, bowlYaw: Math.atan2(bowl.x, bowl.z), lifted, maxSlide, drift: Math.hypot(rxs[n - 1] - rxs[0], rzs[n - 1] - rzs[0]), groundRange: Math.max(...gs) - Math.min(...gs) };
}

// ---------------------------------------------------------------- events, features, classification
function features(r, C) {
  const n = C.frames.length, c = r.c - r.s;
  const J = C.frames.map((F) => { rig.set(F.qs, F.hp); const o = {}; for (const b of BONES) o[b] = rig.pos(b); o.midL = rig.point('L', MIDF); o.midR = rig.point('R', MIDF); o.hands = o.handL.clone().add(o.handR).multiplyScalar(0.5); return o; });
  const hv = gauss(J.map((o, i) => (i ? o.hands.clone().sub(o.hips).distanceTo(J[i - 1].hands.clone().sub(J[i - 1].hips)) * RATE : 0)), 2);
  // contact: the fastest hands (sub-frame)
  let ci = c;
  for (let i = Math.max(1, c - 6); i <= Math.min(n - 2, c + 6); i++) if (hv[i] > hv[ci]) ci = i;
  const y0 = hv[ci - 1], y1 = hv[ci], y2 = hv[ci + 1], den = y0 - 2 * y1 + y2;
  const tc = (ci + (Math.abs(den) > 1e-6 ? clamp(0.5 * (y0 - y2) / den, -0.5, 0.5) : 0)) / RATE;
  // backlift top: the hands turn round (slowest) between the pick-up and the downswing
  let top = Math.max(1, ci - Math.round(0.6 * RATE));
  for (let i = top; i <= ci - Math.round(0.08 * RATE); i++) if (hv[i] < hv[top]) top = i;
  // finish: the hands have slowed to a third of their peak
  let fin = Math.min(n - 1, ci + Math.round(0.12 * RATE));
  while (fin < n - 1 && hv[fin] > hv[ci] * 0.33) fin++;
  const yawOf = (o) => Math.atan2(o.hipL.x - o.hipR.x, o.hipL.z - o.hipR.z);    // 0 with the left hip toward the bowler (+X)... (atan2(x,z) = pi/2)
  const s0 = J[0], sc = J[ci], sf = J[fin];
  const dYaw = (a, b) => Math.atan2(Math.sin(yawOf(b) - yawOf(a)), Math.cos(yawOf(b) - yawOf(a)));
  const xz = (v) => [+v.x.toFixed(3), +v.z.toFixed(3)];
  const footLine = sc.midL.clone().sub(sc.midR).setY(0);
  const wOf = (o) => { const l = o.midL.clone().sub(o.midR).setY(0); return clamp(o.hips.clone().sub(o.midR).setY(0).dot(l) / Math.max(1e-4, l.lengthSq()), -0.5, 1.5); };
  const weight = wOf(sc), weightF = wOf(sf);
  const handVel = sc.hands.clone().sub(J[Math.max(0, ci - 2)].hands).multiplyScalar(RATE / 2);
  const f = {
    tc, top: top / RATE, fin: fin / RATE, end: (n - 1) / RATE,
    peak: +hv[ci].toFixed(2),
    frontMove: +(sc.midL.x - s0.midL.x).toFixed(3),       // + toward the bowler
    backMove: +(sc.midR.x - s0.midR.x).toFixed(3),        // - = back toward the stumps
    gap0: +s0.midL.distanceTo(s0.midR).toFixed(3), gapC: +sc.midL.distanceTo(sc.midR).toFixed(3),
    weight: +weight.toFixed(2), weightF: +weightF.toFixed(2),
    hipH: +(sc.hips.y / canon.hips.y).toFixed(3),          // of the standing height
    handsY: +sc.hands.y.toFixed(3),
    handsVel: [+handVel.x.toFixed(2), +handVel.y.toFixed(2), +handVel.z.toFixed(2)],   // +x to the bowler, +z to the off side, -z to the leg side
    turnC: +dYaw(s0, sc).toFixed(2), turnF: +dYaw(s0, sf).toFixed(2),
    feet: { stance: { L: xz(s0.midL), R: xz(s0.midR) }, contact: { L: xz(sc.midL), R: xz(sc.midR) } },
    head: { stance: xz(s0.head), contact: xz(sc.head) },
  };
  // Explainable classification.
  const why = [];
  let type, foot;
  const front = f.frontMove > 0.1 || f.weight > 0.62 || (f.weightF > 0.75 && f.backMove > -0.15);
  const back = !front && (f.backMove < -0.06 || f.weight < 0.45);
  foot = front ? 'front' : back ? 'back' : 'neutral';
  why.push(`front foot ${f.frontMove >= 0 ? '+' : ''}${f.frontMove} m, back foot ${f.backMove >= 0 ? '+' : ''}${f.backMove} m, weight ${f.weight} at contact -> ${foot} foot`);
  if (f.hipH < 0.72) { type = 'sweep'; why.push(`hips at ${(f.hipH * 100).toFixed(0)}% of standing height at contact -> down on one knee`); }
  else if (f.handsY > 1.0 && Math.abs(f.turnF) > 0.9) {
    const leg = f.handsVel[2] < 0;
    type = leg ? 'pull' : 'cut';
    why.push(`hands ${f.handsY} m high at contact (bat across the line), pelvis turns ${f.turnF} rad, hands travelling to the ${leg ? 'leg' : 'off'} side -> ${type}`);
  } else if (f.peak < 2.6) {
    type = foot === 'back' ? 'backdef' : 'defend';
    why.push(`hands only ${f.peak} m/s (a push, no swing) -> ${type}`);
  } else if (foot === 'back') {
    type = f.handsVel[2] < -1 ? 'pull' : 'cut';
    why.push(`back foot, hands travelling ${f.handsVel[2] < -1 ? 'to the leg side' : 'square on the off side'} -> ${type}`);
  } else {
    type = f.handsVel[2] < -2.0 && f.turnF > 0 ? 'flick' : 'drive';
    why.push(`front foot, hands ${f.handsY} m at contact, ${f.peak} m/s along ${f.handsVel.join(',')} -> ${type}`);
  }
  return { f, type, foot, why };
}

// ---------------------------------------------------------------- build
// Verdicts by eye (stick sheets of every window that passed the automatic checks; tools/build_shots.mjs --debug).
// Contact time (s in the take) -> name, or a reason to drop it.
const BY_EYE = {
  6.15: { name: 'drive' },
  1.48: { reject: 'the back foot hangs 10-16 cm off the floor behind the batter for the whole stroke; put down, the stride disappears and the front foot floats instead (no trustworthy footwork)' },
  9.88: { reject: 'same clip family as 1.48 (a replay): one foot always hovering 10-15 cm up, whichever is grounded' },
  38.28: { name: 'pull' },
  45.57: { name: 'sweep' },
  26.83: { reject: 'no batting stance: stands upright with the feet together and the arms held out at shoulder height (a mis-tracked replay)' },
  30.35: { reject: 'pull that turns into a pirouette: pelvis round 135 deg, the front leg kicked up and the legs crossing at the finish' },
  41.47: { reject: 'pull with the pelvis turned 150 deg and the legs crossed at the finish (side-to-side flip in the capture)' },
};
const kept = [];
for (const r of cands) {
  if (r.why.length) continue;
  let C = clean(r), F = features(r, C);
  if (F.foot === 'front' && F.f.backMove < -0.08 && F.f.frontMove < 0.15) { C = clean(r, true); F = features(r, C); C.anchored = true; }
  const eye = Object.entries(BY_EYE).find(([t]) => Math.abs(+t - r.t) < 0.2);
  if (eye && eye[1].reject) { r.why.push('by eye: ' + eye[1].reject); continue; }
  kept.push({ r, C, F, name: eye ? eye[1].name : null });
  console.log(`\n${r.t.toFixed(2)} s -> ${F.type} (${F.foot} foot)  [${(r.s / RATE).toFixed(2)}-${(r.e / RATE).toFixed(2)} s]  ${C.lefty ? 'LEFT-HANDED (mirrored)' : 'right-handed'} (top hand ${C.handUp.toFixed(2)} m higher)`);
  console.log('   ' + F.why.join('\n   '));
  console.log('   ' + JSON.stringify(F.f));
  console.log(`   cleaning: ground moved ${C.groundRange.toFixed(2)} m, root drift removed ${C.drift.toFixed(2)} m, planted-foot slide ${(C.maxSlide * 1000).toFixed(1)} mm/frame, sliding steps lifted: ${C.lifted ? 'yes' : 'no'}${C.toe.L || C.toe.R ? ', floating back foot put down on its toe' : ''}${C.anchored ? ', back foot held (stride re-rooted onto the front foot)' : ''}`);
  console.log('   contact L ' + C.on.L.filter((_, i) => i % 2 === 0).join('') + '\n   contact R ' + C.on.R.filter((_, i) => i % 2 === 0).join(''));
}

if (DEBUG) {
  fs.mkdirSync(DEBUG, { recursive: true });
  const names = [...BONES, 'heelL', 'ballL', 'heelR', 'ballR'];
  const dump = (frames) => frames.filter((_, i) => i % 2 === 0).map((F) => {
    rig.set(F.qs, F.hp);
    const pts = [...BONES.map((b) => rig.pos(b)), rig.point('L', HEEL), rig.point('L', BALL), rig.point('R', HEEL), rig.point('R', BALL)];
    return pts.map((p) => [+p.z.toFixed(4), +p.y.toFixed(4), +(-p.x).toFixed(4)]);       // figure frame -> game world (batter facing +X)
  });
  for (const k of kept) {
    const tag = k.r.t.toFixed(2);
    fs.writeFileSync(path.join(DEBUG, `raw_${tag}.json`), JSON.stringify({ joints: names, rate: 30, frames: dump(k.C.raw) }));
    fs.writeFileSync(path.join(DEBUG, `clean_${tag}.json`), JSON.stringify({ joints: names, rate: 30, frames: dump(k.C.frames), events: k.F.f }));
  }
}

// ---------------------------------------------------------------- write
const PER = NB * 4 + 3;
const table = [], chunks = [];
let offset = 0;
for (const k of kept) {
  const { C, F, r } = k;
  const fr = C.frames.filter((_, i) => i % 2 === 0);            // 60 -> 30 Hz (already low-passed)
  const count = fr.length;
  const data = new Int16Array(count * PER);
  fr.forEach((Fm, f) => {
    Fm.qs.forEach((q, b) => {
      if (f && q.dot(fr[f - 1].qs[b]) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      data.set([q.x, q.y, q.z, q.w].map((v) => Math.round(v * 32767)), f * PER + b * 4);
    });
    const p = Fm.hp.clone().sub(canon.hips).divideScalar(LEG);
    data.set([p.x, p.y, p.z].map((v) => Math.round(clamp(v / 2, -1, 1) * 32767)), f * PER + NB * 4);
  });
  // check on the stored frames: nothing through the floor (planted-foot slide is measured at 60 Hz in clean())
  let footLow = 9;
  fr.forEach((Fm) => {
    rig.set(Fm.qs, Fm.hp);
    for (const s of ['L', 'R']) footLow = Math.min(footLow, rig.point(s, HEEL).y, rig.point(s, BALL).y);
  });
  const fin = (C.frames.length - 1) / RATE;
  const sw = F.f;
  const feetAt = (t) => { rig.set(C.frames[Math.round(t * RATE)].qs, C.frames[Math.round(t * RATE)].hp); return { L: [+rig.point('L', MIDF).x.toFixed(3), +rig.point('L', MIDF).z.toFixed(3)], R: [+rig.point('R', MIDF).x.toFixed(3), +rig.point('R', MIDF).z.toFixed(3)] }; };
  table.push({
    name: k.name, type: F.type, foot: F.foot,
    src: { take: [+(r.s / RATE).toFixed(3), +(r.e / RATE).toFixed(3)], contact: +(r.s / RATE + sw.tc).toFixed(3), mirrored: C.lefty },
    frames: count, fps: OUT_FPS, dur: +((count - 1) / OUT_FPS).toFixed(4), offset,
    events: { stance: 0, top: +sw.top.toFixed(3), contact: +sw.tc.toFixed(3), finish: +Math.min(sw.fin, fin).toFixed(3) },
    // figure frame (metres for the 1.0-scale athlete): +X toward the bowler, +Z the way the batter faces (the off side)
    feet: { stance: sw.feet.stance, contact: sw.feet.contact, finish: feetAt(Math.min(sw.fin, fin)) },
    head: sw.head,
    stride: +Math.hypot(sw.feet.contact.L[0] - sw.feet.stance.L[0], sw.feet.contact.L[1] - sw.feet.stance.L[1]).toFixed(3),
    weight: { contact: sw.weight, finish: sw.weightF },
    hipHeight: sw.hipH, turn: { contact: sw.turnC, finish: sw.turnF }, handSpeed: sw.peak,
    contact: { L: C.on.L.filter((_, i) => i % 2 === 0).join(''), R: C.on.R.filter((_, i) => i % 2 === 0).join('') },
    why: F.why,
    check: { footLow: +footLow.toFixed(3), plantedSlide: +C.maxSlide.toFixed(4) },
  });
  chunks.push(Buffer.from(data.buffer));
  offset += count * PER;
}
const rejected = cands.filter((r) => r.why.length).map((r) => ({ t: r.t, why: r.why }));
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'shots.bin'), Buffer.concat(chunks));
fs.writeFileSync(path.join(outDir, 'shots.json'), JSON.stringify({
  source: 'mimem.ai video-to-3D capture of broadcast batting clips (one take, 47 s, 60 Hz); cut, cleaned and retargeted by tools/build_shots.mjs',
  bones: BONES, stride: PER, qScale: 32767, posScale: 2 / 32767, units: 'hips offset in leg lengths (hip joint to ankle) from the canonical hips; origin = between the stance feet; +X toward the bowler, +Z the way the batter faces',
  leg: +LEG.toFixed(4),
  shots: table, rejected,
}, null, 1));
console.log(`\nwrote ${outDir}/shots.bin (${(offset * 2 / 1024).toFixed(1)} KB, ${table.length} shots: ${table.map((t) => t.name + '=' + t.type).join(', ')}) + shots.json; rejected ${rejected.length} windows`);
