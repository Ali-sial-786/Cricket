// Batting shots from the labelled coaching video (one right-handed batter in
// whites, every shot labelled on screen, static tripod cameras), via
// MediaPipe Pose Landmarker (tools/video_shots/extract_pose.py) and
// tools/video_shots/prepare_takes.py, cleaned and retargeted onto the game's
// 17-bone Humanoid:
//   assets/anim/shots.json  (shot table: type, events, footwork, checks)
//   assets/anim/shots.bin   (int16 frames at 30 Hz: 17 local quaternions + hips offset)
// Same format as tools/build_shots.mjs (the earlier mimem.ai pass), read by src/render/shots.js.
//
// Usage: node tools/video_shots/build_video_shots.mjs <takes.json> [node_modules dir with three] [out dir]
//        [--all] (clean every take in the file and print its checks)  [--debug dir] (stick-figure joints)
//
// Pipeline per chosen take (tools/video_shots/selection.json):
//  1. landmarks (already left/right-repaired and turned so the bowler is +X, up +Y,
//     the off side +Z) smoothed zero-phase, lighter while the body moves fast;
//  2. retargeted: every bone's world rotation is built from the landmarks
//     (pelvis from the hips, chest from the shoulders, head from ears and nose;
//     thigh+shin and upper arm+forearm as hinges: the bend always about the
//     upper bone's X axis, so knees and elbows are hinge-correct by construction,
//     falling back to the foot's direction when the leg is straight; feet from
//     heel to toe);
//  3. root path from the planted feet: MediaPipe's world pose is centred on the
//     hips, so the body is moved over the floor by keeping each planted foot
//     where it landed (feet are planted where the image says they are still:
//     the cameras do not move), the floor under the lowest foot (or a kneeling
//     knee);
//  4. legs re-solved by hinge IK onto the pins, pelvis lowered where the legs
//     would have to stretch;
//  5. events: contact (fastest hands, checked by eye against the ball in the
//     video), top of the backlift, finish.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const DEBUG = flag('--debug');
const ALL = args.includes('--all'); if (ALL) args.splice(args.indexOf('--all'), 1);
const here = path.dirname(new URL(import.meta.url).pathname);
const src = args[0] || path.join(here, 'takes.json');
const modDir = args[1] || path.resolve('node_modules');
const outDir = args[2] || path.resolve(here, '../../assets/anim');
const THREE = await import(pathToFileURL(path.join(modDir, 'three/build/three.module.js')).href);
const { Vector3: V3, Quaternion: Q4, Matrix4: M4 } = THREE;

const RATE = 30;
const BONES = ['hips', 'spine', 'chest', 'neck', 'head', 'shoulderL', 'elbowL', 'handL', 'shoulderR', 'elbowR', 'handR', 'hipL', 'kneeL', 'ankleL', 'hipR', 'kneeR', 'ankleR'];
const NB = BONES.length;
const BI = Object.fromEntries(BONES.map((b, i) => [b, i]));
const PARENT = { hips: null, spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck', shoulderL: 'chest', elbowL: 'shoulderL', handL: 'elbowL', shoulderR: 'chest', elbowR: 'shoulderR', handR: 'elbowR', hipL: 'hips', kneeL: 'hipL', ankleL: 'kneeL', hipR: 'hips', kneeR: 'hipR', ankleR: 'kneeR' };

// ---------------------------------------------------------------- game rig (canonical pose, as humanoid.js builds it)
const TJ = JSON.parse(fs.readFileSync(path.resolve(here, '../../assets/models/athlete.json'), 'utf8')).joints;
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
const ANKLE_H = TJ.ankleL[1];
const HIPMID = canon.hipL.clone().add(canon.hipR).multiplyScalar(0.5).sub(canon.hips);
const HEEL = new V3(0, -ANKLE_H + 0.012, -0.06), BALL = new V3(0, -ANKLE_H + 0.012, 0.13), MIDF = HEEL.clone().add(BALL).multiplyScalar(0.5);

class Rig {
  constructor() {
    this.b = {};
    for (const n of BONES) {
      const o = new THREE.Object3D();
      o.position.copy(LOCAL[n]);
      if (PARENT[n]) this.b[PARENT[n]].add(o);
      this.b[n] = o;
    }
  }
  set(qs, hp) { BONES.forEach((n, k) => this.b[n].quaternion.copy(qs[k])); this.b.hips.position.copy(hp); this.b.hips.updateMatrixWorld(true); return this; }
  pos(n, out = new V3()) { return this.b[n].getWorldPosition(out); }
  quat(n, out = new Q4()) { return this.b[n].getWorldQuaternion(out); }
  point(s, pt, out = new V3()) { return out.copy(pt).applyQuaternion(this.quat('ankle' + s)).add(this.pos('ankle' + s)); }
  locals() { return BONES.map((n) => this.b[n].quaternion.clone()); }
  setWorldQuat(n, q) { const o = this.b[n]; const p = o.parent.getWorldQuaternion(new Q4()).invert(); o.quaternion.copy(p.multiply(q)); o.updateMatrixWorld(true); }
}
// Hinge-correct two-bone IK (as src/render/humanoid.js solveTwoBone; flex -1 = knee).
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
    const q = new Q4().setFromRotationMatrix(new M4().makeBasis(x, y, z));
    const p = bone.parent.getWorldQuaternion(new Q4()).invert();
    bone.quaternion.copy(p.multiply(q)); bone.updateMatrixWorld(true);
  };
  let hy = hu.clone().negate();
  const hx = new V3().crossVectors(hy, hf).normalize();
  set(upper, hx, hy, hf);
  hy = hl.clone().negate();
  set(lower, hx, hy, new V3().crossVectors(hx, hy).normalize());
}

// ---------------------------------------------------------------- helpers
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
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
const runs = (arr, val) => { const out = []; let a = -1; for (let i = 0; i <= arr.length; i++) { if (i < arr.length && arr[i] === val) { if (a < 0) a = i; } else if (a >= 0) { out.push([a, i - 1]); a = -1; } } return out; };
const basisQ = (x, y, z) => new Q4().setFromRotationMatrix(new M4().makeBasis(x, y, z));
const orthoBasis = (x, yHint) => {           // X exact, Y as close to yHint as allowed, Z = X x Y
  const X = x.clone().normalize();
  const Y = yHint.clone().addScaledVector(X, -yHint.dot(X)).normalize();
  return [X, Y, new V3().crossVectors(X, Y)];
};

// ---------------------------------------------------------------- landmarks -> rig
// MediaPipe landmark ids kept by prepare_takes.py.
const LM = { nose: 0, earL: 7, earR: 8, shL: 11, shR: 12, elL: 13, elR: 14, wrL: 15, wrR: 16, idxL: 19, idxR: 20, hipL: 23, hipR: 24, knL: 25, knR: 26, anL: 27, anR: 28, heL: 29, heR: 30, toL: 31, toR: 32 };
const UP = new V3(0, 1, 0);

// World rotations of every bone for one frame of landmark positions P (name -> V3).
function retargetFrame(P) {
  const W = {};
  const hipMid = P.hipL.clone().add(P.hipR).multiplyScalar(0.5), shMid = P.shL.clone().add(P.shR).multiplyScalar(0.5);
  const trunk = shMid.clone().sub(hipMid).normalize();
  // pelvis: the hip line, upright between the vertical and the trunk
  let [x, y, z] = orthoBasis(P.hipL.clone().sub(P.hipR), UP.clone().lerp(trunk, 0.35));
  W.hips = basisQ(x, y, z);
  [x, y, z] = orthoBasis(P.shL.clone().sub(P.shR), trunk);
  W.chest = basisQ(x, y, z);
  W.spine = W.hips.clone().slerp(W.chest, 0.5);
  // head: ear line, nose forward (the nose sits a little below the ears: pitch it back up ~12 deg)
  const earMid = P.earL.clone().add(P.earR).multiplyScalar(0.5);
  const hx = P.earL.clone().sub(P.earR).normalize();
  const fw = P.nose.clone().sub(earMid); fw.addScaledVector(hx, -fw.dot(hx)).normalize();
  const hy = new V3().crossVectors(fw, hx).normalize();
  W.head = basisQ(hx, hy, fw).multiply(new Q4().setFromAxisAngle(new V3(1, 0, 0), -0.2));
  W.neck = W.chest.clone().slerp(W.head, 0.5);
  // limbs as hinges
  const limb = (up, lo, a, b, c, flex, fwdHint) => {
    const u = P[b].clone().sub(P[a]).normalize(), l = P[c].clone().sub(P[b]).normalize();
    const perp = l.clone().addScaledVector(u, -l.dot(u));
    const bend = perp.length();
    const h = fwdHint.clone().addScaledVector(u, -fwdHint.dot(u)).normalize();
    const fold = bend > 1e-6 ? perp.clone().divideScalar(bend).multiplyScalar(flex) : h.clone();
    const w = sstep(0.08, 0.3, bend);
    const Z = h.clone().lerp(fold, w);
    if (Z.lengthSq() < 1e-6) Z.copy(fold);
    Z.addScaledVector(u, -Z.dot(u)).normalize();
    const Yu = u.clone().negate(), Xu = new V3().crossVectors(Yu, Z).normalize();
    W[up] = basisQ(Xu, Yu, new V3().crossVectors(Xu, Yu));
    const lp = l.clone().addScaledVector(Xu, -l.dot(Xu)).normalize();        // hinge: the lower bone stays in the bend plane
    const Yl = lp.clone().negate();
    W[lo] = basisQ(Xu, Yl, new V3().crossVectors(Xu, Yl));
    return Xu;
  };
  for (const s of ['L', 'R']) {
    const foot = P['to' + s].clone().sub(P['he' + s]); foot.y = 0;
    const footF = foot.lengthSq() > 1e-6 ? foot.normalize() : new V3(0, 0, 1).applyQuaternion(W.hips);
    const kx = limb('hip' + s, 'knee' + s, 'hip' + s, 'kn' + s, 'an' + s, -1, footF);
    // foot: heel to toe, across it the knee's hinge axis
    const F = P['to' + s].clone().sub(P['he' + s]).normalize();
    const fx = kx.clone().addScaledVector(F, -kx.dot(F)).normalize();
    W['ankle' + s] = basisQ(fx, new V3().crossVectors(F, fx), F);
    const chestF = new V3(0, 0, 1).applyQuaternion(W.chest);
    const ex = limb('shoulder' + s, 'elbow' + s, 'sh' + s, 'el' + s, 'wr' + s, 1, chestF);
    const hd = P['idx' + s].clone().sub(P['wr' + s]).normalize(), hxx = ex.clone().addScaledVector(hd, -ex.dot(hd)).normalize();
    const hyy = hd.clone().negate();
    W['hand' + s] = basisQ(hxx, hyy, new V3().crossVectors(hxx, hyy));
  }
  // local rotations
  const qs = BONES.map((b) => (PARENT[b] ? W[PARENT[b]].clone().invert().multiply(W[b]) : W[b].clone()).normalize());
  return { qs, hipMid };
}

// ---------------------------------------------------------------- one take
const rig = new Rig();
function cleanTake(T, opt = {}) {
  const n = T.canon.length;
  const ids = T.joints;
  // landmark positions (canonical, metres), smoothed zero-phase; lighter while the body moves fast
  const raw = T.canon.map((fr) => Object.fromEntries(Object.entries(LM).map(([k, id]) => [k, new V3(...fr[ids.indexOf(id)])])));
  // A camera sees the legs' spread along its line of sight worst: where a take's stride came
  // out across the pitch, that depth is scaled down (selection.json `legDepth`).
  if (opt.legDepth != null) {
    const az = T.camAz * Math.PI / 180, u = new V3(-Math.cos(az), 0, -Math.sin(az));
    for (const F of raw) {
      const mid = F.hipL.clone().add(F.hipR).multiplyScalar(0.5);
      for (const k of ['knL', 'knR', 'anL', 'anR', 'heL', 'heR', 'toL', 'toR']) {
        const d = F[k].clone().sub(mid).dot(u);
        F[k].addScaledVector(u, -(1 - opt.legDepth) * d);
      }
    }
  }
  const handV = raw.map((F, i) => (i ? F.wrL.clone().add(F.wrR).sub(raw[i - 1].wrL).sub(raw[i - 1].wrR).length() * 0.5 * RATE : 0));
  const actv = gauss(handV, 2);
  const sig = actv.map((a) => 0.9 + 1.6 * (1 - clamp(a / 4, 0, 1)));
  const P = raw.map(() => ({}));
  for (const k of Object.keys(LM)) for (const a of ['x', 'y', 'z']) {
    const v = gauss(raw.map((F) => F[k][a]), k.startsWith('wr') || k.startsWith('idx') || k.startsWith('el') ? sig.map((s) => s * 0.7) : sig);
    v.forEach((val, i) => { (P[i][k] ||= new V3())[a] = val; });
  }
  // --- retarget every frame (hips at the origin for now)
  const FR = P.map((F) => {
    const { qs } = retargetFrame(F);
    const hp = HIPMID.clone().applyQuaternion(qs[0]).negate();
    return { qs, hp };
  });
  for (let k = 0; k < NB; k++) for (let i = 1; i < n; i++) if (FR[i].qs[k].dot(FR[i - 1].qs[k]) < 0) { const q = FR[i].qs[k]; q.set(-q.x, -q.y, -q.z, -q.w); }
  // Arms (the game puts the hands on its bat; these are for completeness): where MediaPipe
  // loses an arm for a frame or two, turn it no more than 40 deg a frame.
  for (let k = BI.shoulderL; k <= BI.handR; k++) for (let i = 1; i < n; i++) {
    const a = FR[i - 1].qs[k], q = FR[i].qs[k], ang = 2 * Math.acos(clamp(Math.abs(a.dot(q)), 0, 1));
    if (ang > 0.7) q.copy(a.clone().slerp(q, 0.7 / ang));
  }
  // --- feet relative to the pelvis, heights
  const rel = { L: [], R: [] }, H = { L: [], R: [] }, knee = { L: [], R: [] };
  for (const F of FR) {
    rig.set(F.qs, F.hp);
    for (const s of ['L', 'R']) {
      rel[s].push(rig.point(s, MIDF));
      H[s].push(Math.min(rig.point(s, HEEL).y, rig.point(s, BALL).y));
      knee[s].push(rig.pos('knee' + s).y);
    }
  }
  // --- contacts: still in the image (static camera) and not lifted above the other foot
  const on = {};
  const lowest = H.L.map((h, i) => Math.min(h, H.R[i]));
  for (const s of ['L', 'R']) {
    const v = T.footV[s];
    const c = v.map((vv, i) => ((vv < (opt.footStill ?? 0.45) && H[s][i] - lowest[i] < 0.07) || H[s][i] - lowest[i] < 0.012 && vv < 0.6 ? 1 : 0));
    for (const [a, b] of runs(c, 0)) if (a > 0 && b < n - 1 && b - a + 1 < 6) for (let i = a; i <= b; i++) c[i] = 1;
    for (const [a, b] of runs(c, 1)) if (b - a + 1 < 4 && a > 0) for (let i = a; i <= b; i++) c[i] = 0;
    on[s] = c;
  }
  for (let i = 0; i < n; i++) if (!on.L[i] && !on.R[i]) { if (H.L[i] <= H.R[i]) on.L[i] = 1; else on.R[i] = 1; }
  // overrides by eye: frames (in the take) where a foot is known to be planted / in the air
  for (const [s, a, b, val] of opt.contact || []) for (let i = Math.max(0, a); i <= Math.min(n - 1, b); i++) on[s][i] = val;
  // --- root path over the floor: planted feet stay where they landed
  const root = [], PIN = { L: new Array(n), R: new Array(n) }, drag = { L: new Uint8Array(n), R: new Uint8Array(n) };
  let pin = { L: null, R: null }, cur = new V3();
  for (let i = 0; i < n; i++) {
    for (const s of ['L', 'R']) if (on[s][i] && !pin[s]) pin[s] = (i ? root[i - 1] : cur).clone().add(rel[s][i]).setY(0);
    // Both feet down but the pose wants them further apart (or closer) than their pins: the
    // foot further from the pelvis drags (a back toe dragging through a lunge) rather than the
    // legs stretching or the pelvis sinking.
    if (on.L[i] && on.R[i]) {
      const rL = pin.L.clone().sub(rel.L[i]).setY(0), rR = pin.R.clone().sub(rel.R[i]).setY(0);
      const e = rL.clone().sub(rR), el = e.length();
      if (el > 0.03) {
        const s = Math.hypot(rel.L[i].x, rel.L[i].z) > Math.hypot(rel.R[i].x, rel.R[i].z) ? 'L' : 'R';
        const k = (el - 0.03) / el;
        pin[s] = pin[s].clone().addScaledVector(e, s === 'R' ? k : -k);
        drag[s][i] = 1;
      }
    }
    let acc = new V3(), w = 0;
    for (const s of ['L', 'R']) if (on[s][i] && pin[s]) {
      const wt = (drag[s][i] ? 0.2 : 1) + (H[s][i] <= H[s === 'L' ? 'R' : 'L'][i] ? 0.5 : 0);
      acc.addScaledVector(pin[s].clone().sub(rel[s][i]).setY(0), wt); w += wt;
    }
    cur = w ? acc.divideScalar(w) : (i ? root[i - 1].clone() : new V3());
    root.push(cur.clone());
    for (const s of ['L', 'R']) { PIN[s][i] = on[s][i] ? pin[s] : null; if (!on[s][i]) pin[s] = null; }
  }
  // a dragged foot is not a planted one (for the table and the checks)
  const planted = {};
  for (const s of ['L', 'R']) planted[s] = on[s].map((v, i) => (v && !drag[s][i] ? 1 : 0));
  const rx = gauss(root.map((r) => r.x), 2), rz = gauss(root.map((r) => r.z), 2);
  // --- ground: the lowest foot (or a kneeling knee) on the floor
  const g = FR.map((F, i) => Math.min(lowest[i], knee.L[i] - 0.06, knee.R[i] - 0.06));
  const gs = gauss(g, 2);
  FR.forEach((F, i) => { F.hp.x += rx[i]; F.hp.z += rz[i]; F.hp.y -= gs[i]; });
  // --- leg IK onto the pins; flight feet follow their own path (corrected toward the next pin)
  const res = [];
  let maxSlide = 0, footLow = 9;
  const pinPrev = {};
  const tg = [];
  for (let i = 0; i < n; i++) {
    const F = FR[i];
    rig.set(F.qs, F.hp);
    const tgt = {};
    for (const s of ['L', 'R']) {
      const q = rig.quat('ankle' + s);
      const fw = new V3(0, 0, 1).applyQuaternion(q);
      if (on[s][i]) {
        // planted: flat (keep the turn; up on the toe if the capture's heel is up)
        const pitch = Math.asin(clamp(fw.y, -1, 1));
        const yawQ = new Q4().setFromAxisAngle(UP, Math.atan2(fw.x, fw.z));
        const keep = pitch < -0.3 ? new Q4().setFromAxisAngle(new V3(1, 0, 0), Math.min(-pitch, 0.9)) : new Q4();
        q.copy(yawQ.multiply(keep));
      }
      const lo = Math.min(HEEL.clone().applyQuaternion(q).y, BALL.clone().applyQuaternion(q).y);
      const t = rig.pos('ankle' + s);
      if (on[s][i]) { const m = MIDF.clone().applyQuaternion(q); t.set(PIN[s][i].x - m.x, -lo, PIN[s][i].z - m.z); }
      else if (t.y + lo < 0) t.y = -lo;
      tgt[s] = { t, q };
    }
    let need = 0;
    for (const s of ['L', 'R']) {
      const hp = rig.pos('hip' + s), d = hp.distanceTo(tgt[s].t), over = d - LEG * 0.993;
      if (over > 0) need = Math.max(need, over * d / Math.max(0.3, hp.y - tgt[s].t.y));   // lowering the pelvis shortens the reach this much
    }
    tg.push({ tgt, need });
  }
  // a flight foot blends from where it left to where it lands (no jump at either end)
  for (const s of ['L', 'R']) for (const [a, b] of runs(on[s], 0)) {
    if (a === 0 && b === n - 1) continue;
    const off = (i) => { rig.set(FR[i].qs, FR[i].hp); return tg[i].tgt[s].t.clone().sub(rig.pos('ankle' + s)).setY(0); };
    const e0 = a > 0 ? off(a - 1) : off(b + 1), e1 = b < n - 1 ? off(b + 1) : e0;
    for (let i = a; i <= b; i++) tg[i].tgt[s].t.add(e0.clone().lerp(e1, sstep(a - 1, b + 1, i)));
  }
  // feet turn smoothly into and out of their flat, planted orientation
  for (const s of ['L', 'R']) {
    for (let i = 1; i < n; i++) { const a = tg[i - 1].tgt[s].q, q = tg[i].tgt[s].q; if (a.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w); }
    const c = ['x', 'y', 'z', 'w'].map((a) => gauss(tg.map((o) => o.tgt[s].q[a]), 1.5));
    tg.forEach((o, i) => {
      const { t, q } = o.tgt[s];
      q.set(c[0][i], c[1][i], c[2][i], c[3][i]).normalize();
      const lo = Math.min(HEEL.clone().applyQuaternion(q).y, BALL.clone().applyQuaternion(q).y);
      if (on[s][i]) { const m = MIDF.clone().applyQuaternion(q); t.set(PIN[s][i].x - m.x, -lo, PIN[s][i].z - m.z); }
      else if (t.y + lo < 0) t.y = -lo;
    });
  }
  const needs = tg.map((o) => Math.max(0, o.need));
  const drop = gauss(needs.map((v) => v * 1.1), 2).map((v, i) => Math.max(v, needs[i]));
  for (let i = 0; i < n; i++) {
    const F = FR[i];
    F.hp.y -= drop[i];
    rig.set(F.qs, F.hp);
    for (const s of ['L', 'R']) {
      const { t, q } = tg[i].tgt[s];
      const hip = rig.pos('hip' + s), kn = rig.pos('knee' + s);
      const mid = hip.clone().add(t).multiplyScalar(0.5);
      const pole = kn.clone().add(kn.clone().sub(mid).normalize().multiplyScalar(0.5));
      solveTwoBone(rig.b['hip' + s], rig.b['knee' + s], rig.b['ankle' + s], t, pole, -1);
      rig.setWorldQuat('ankle' + s, q);
    }
    for (const s of ['L', 'R']) {
      const p = rig.point(s, MIDF);
      if (planted[s][i] && pinPrev[s] && planted[s][i - 1]) maxSlide = Math.max(maxSlide, Math.hypot(p.x - pinPrev[s].x, p.z - pinPrev[s].z));
      pinPrev[s] = p;
      footLow = Math.min(footLow, rig.point(s, HEEL).y, rig.point(s, BALL).y);
    }
    res.push({ qs: rig.locals(), hp: rig.b.hips.position.clone() });
  }
  // no bone turns more than 0.6 rad between frames (a knee pole flipping where the leg is
  // nearly straight would otherwise swing the thigh round); then the checks on what is stored
  for (let k = 0; k < NB; k++) for (let i = 1; i < n; i++) {
    const a = res[i - 1].qs[k], q = res[i].qs[k];
    if (q.dot(a) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
    const ang = 2 * Math.acos(clamp(a.dot(q), 0, 1));
    if (ang > 0.6) q.copy(a.clone().slerp(q, 0.6 / ang));
  }
  // ... and the legs put back on their targets (pole: the knee as it now is)
  for (let i = 0; i < n; i++) {
    rig.set(res[i].qs, res[i].hp);
    for (const s of ['L', 'R']) {
      const { t, q } = tg[i].tgt[s];
      const hip = rig.pos('hip' + s), kn = rig.pos('knee' + s);
      const pole = kn.clone().add(kn.clone().sub(hip.clone().add(t).multiplyScalar(0.5)).normalize().multiplyScalar(0.5));
      solveTwoBone(rig.b['hip' + s], rig.b['knee' + s], rig.b['ankle' + s], t, pole, -1);
      rig.setWorldQuat('ankle' + s, q);
    }
    res[i].qs = rig.locals();
  }
  maxSlide = 0; footLow = 9;
  const prevP = {};
  for (let i = 0; i < n; i++) {
    rig.set(res[i].qs, res[i].hp);
    for (const s of ['L', 'R']) {
      const p = rig.point(s, MIDF);
      if (planted[s][i] && i && planted[s][i - 1]) maxSlide = Math.max(maxSlide, Math.hypot(p.x - prevP[s].x, p.z - prevP[s].z));
      prevP[s] = p;
      footLow = Math.min(footLow, rig.point(s, HEEL).y, rig.point(s, BALL).y);
    }
  }
  // origin: between the stance feet
  rig.set(res[0].qs, res[0].hp);
  const o = rig.point('L', MIDF).add(rig.point('R', MIDF)).multiplyScalar(0.5).setY(0);
  res.forEach((F) => F.hp.sub(o));
  return { frames: res, on: planted, maxSlide, footLow, drop: Math.max(...drop) };
}

// ---------------------------------------------------------------- features of a cleaned take
function features(C, ev) {
  const fr = C.frames, n = fr.length;
  const J = fr.map((F) => { rig.set(F.qs, F.hp); const o = {}; for (const b of BONES) o[b] = rig.pos(b); o.midL = rig.point('L', MIDF); o.midR = rig.point('R', MIDF); return o; });
  const at = (t) => J[clamp(Math.round(t * RATE), 0, n - 1)];
  const xz = (v) => [+v.x.toFixed(3), +v.z.toFixed(3)];
  const yawOf = (o) => Math.atan2(o.hipL.x - o.hipR.x, o.hipL.z - o.hipR.z);
  const dYaw = (a, b) => Math.atan2(Math.sin(yawOf(b) - yawOf(a)), Math.cos(yawOf(b) - yawOf(a)));
  const wOf = (o) => { const l = o.midL.clone().sub(o.midR).setY(0); return clamp(o.hips.clone().sub(o.midR).setY(0).dot(l) / Math.max(1e-4, l.lengthSq()), -0.5, 1.5); };
  const s0 = J[0], sc = at(ev.contact), sf = at(ev.finish);
  return {
    feet: { stance: { L: xz(s0.midL), R: xz(s0.midR) }, contact: { L: xz(sc.midL), R: xz(sc.midR) }, finish: { L: xz(sf.midL), R: xz(sf.midR) } },
    head: { stance: xz(s0.head), contact: xz(sc.head) },
    stride: +Math.hypot(sc.midL.x - s0.midL.x, sc.midL.z - s0.midL.z).toFixed(3),
    backMove: +(sc.midR.x - s0.midR.x).toFixed(3), frontMove: +(sc.midL.x - s0.midL.x).toFixed(3),
    weight: { contact: +wOf(sc).toFixed(2), finish: +wOf(sf).toFixed(2) },
    hipHeight: +(sc.hips.y / canon.hips.y).toFixed(3),
    turn: { contact: +dYaw(s0, sc).toFixed(2), finish: +dYaw(s0, sf).toFixed(2) },
  };
}

// ---------------------------------------------------------------- build
const D = JSON.parse(fs.readFileSync(src, 'utf8'));
const SEL = JSON.parse(fs.readFileSync(path.join(here, 'selection.json'), 'utf8'));
const byKey = (seg, peak) => D.takes.find((t) => t.seg === seg && Math.abs(t.peak - peak) < 0.05);

if (ALL) {
  for (const T of D.takes) {
    const C = cleanTake(T);
    console.log(`${String(T.seg).padStart(2)} ${T.view} ${T.label.padEnd(22).slice(0, 22)} pk ${T.peak.toFixed(2)}  slide ${(C.maxSlide * 1000).toFixed(1)} mm  drop ${(C.drop * 100).toFixed(1)} cm  L ${C.on.L.join('')}  R ${C.on.R.join('')}`);
  }
}

const kept = [];
for (const S of SEL.kept) {
  const T = byKey(S.seg, S.peak);
  if (!T) throw new Error('no take ' + S.seg + ' ' + S.peak);
  const a = Math.round(((S.t0 ?? T.t0) - T.t0) * RATE), b = Math.round(((S.t1 ?? T.t1) - T.t0) * RATE);
  const cut = { ...T, canon: T.canon.slice(a, b + 1), footV: { L: T.footV.L.slice(a, b + 1), R: T.footV.R.slice(a, b + 1) } };
  const C = cleanTake(cut, { contact: S.contact, footStill: S.footStill, legDepth: S.legDepth });
  const t0 = T.t0 + a / RATE;
  const abs = (k, v) => v ?? T.t0 + T.events[k];
  S.contact_t = +abs('contact', S.contact_t).toFixed(3);
  // top of the backlift: the hands highest above the pelvis 0.1-0.7 s before contact (unless given)
  const tcRel = S.contact_t - t0;
  let topRel = S.top != null ? S.top - t0 : null;
  if (topRel == null) {
    const ids = T.joints, hy = (f) => (f[ids.indexOf(15)][1] + f[ids.indexOf(16)][1]) / 2;
    let best = -9;
    for (let i = Math.max(1, Math.round((tcRel - 0.7) * RATE)); i <= Math.round((tcRel - 0.1) * RATE); i++) {
      const y = hy(cut.canon[i]);
      if (y > best) { best = y; topRel = i / RATE; }
    }
  }
  const dur = Math.floor((C.frames.length - 1) / RATE * 1000) / 1000;
  const ev = { stance: 0, top: +topRel.toFixed(3), contact: +tcRel.toFixed(3), finish: +Math.min(Math.max(abs('finish', S.finish) - t0, tcRel + 0.25), dur).toFixed(3) };
  kept.push({ S, T, C, ev, t0, F: features(C, ev) });
  console.log(`${S.name.padEnd(14)} ${S.type.padEnd(8)} seg ${S.seg} ${t0.toFixed(2)}-${(t0 + (C.frames.length - 1) / RATE).toFixed(2)} s  slide ${(C.maxSlide * 1000).toFixed(1)} mm  low ${(C.footLow * 1000).toFixed(1)} mm  drop ${(C.drop * 100).toFixed(1)} cm`);
  console.log('   L ' + C.on.L.join('') + '\n   R ' + C.on.R.join(''));
  console.log('   ' + JSON.stringify(kept[kept.length - 1].F));
}

if (DEBUG) {
  fs.mkdirSync(DEBUG, { recursive: true });
  const names = [...BONES, 'heelL', 'ballL', 'heelR', 'ballR'];
  for (const k of kept) {
    const frames = k.C.frames.map((F) => {
      rig.set(F.qs, F.hp);
      const pts = [...BONES.map((b) => rig.pos(b)), rig.point('L', HEEL), rig.point('L', BALL), rig.point('R', HEEL), rig.point('R', BALL)];
      return pts.map((p) => [+p.x.toFixed(4), +p.y.toFixed(4), +p.z.toFixed(4)]);     // figure frame: +X bowler, +Z off side
    });
    fs.writeFileSync(path.join(DEBUG, `${k.S.name}.json`), JSON.stringify({ joints: names, rate: RATE, t0: k.t0, events: k.ev, frames }));
  }
}

// ---------------------------------------------------------------- write
const PER = NB * 4 + 3;
const table = [], chunks = [];
let offset = 0;
for (const k of kept) {
  const { C, S, T, ev, F } = k;
  const fr = C.frames, count = fr.length;
  const data = new Int16Array(count * PER);
  fr.forEach((Fm, f) => {
    Fm.qs.forEach((q, b) => {
      if (f && q.dot(fr[f - 1].qs[b]) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      data.set([q.x, q.y, q.z, q.w].map((v) => Math.round(v * 32767)), f * PER + b * 4);
    });
    const p = Fm.hp.clone().sub(canon.hips).divideScalar(LEG);
    data.set([p.x, p.y, p.z].map((v) => Math.round(clamp(v / 2, -1, 1) * 32767)), f * PER + NB * 4);
  });
  table.push({
    name: S.name, type: S.type, foot: S.foot, label: T.label,
    src: { video: 'coaching video', take: [+k.t0.toFixed(2), +(k.t0 + (count - 1) / RATE).toFixed(2)], contact: S.contact_t, view: S.view || T.view, mirrored: false },
    frames: count, fps: RATE, dur: +((count - 1) / RATE).toFixed(4), offset,
    events: ev,
    feet: F.feet, head: F.head, stride: F.stride, weight: F.weight, hipHeight: F.hipHeight, turn: F.turn,
    contact: { L: C.on.L.join(''), R: C.on.R.join('') },
    why: [S.why],
    check: { footLow: +C.footLow.toFixed(3), plantedSlide: +C.maxSlide.toFixed(4) },
  });
  chunks.push(Buffer.from(data.buffer));
  offset += count * PER;
}
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'shots.bin'), Buffer.concat(chunks));
fs.writeFileSync(path.join(outDir, 'shots.json'), JSON.stringify({
  source: 'coaching video of one right-handed batter playing every shot, labelled on screen, static cameras; MediaPipe Pose Landmarker (heavy) per frame; cut, repaired, cleaned and retargeted by tools/video_shots/',
  bones: BONES, stride: PER, qScale: 32767, posScale: 2 / 32767, units: 'hips offset in leg lengths (hip joint to ankle) from the canonical hips; origin = between the stance feet; +X toward the bowler, +Z the way the batter faces',
  leg: +LEG.toFixed(4),
  shots: table, rejected: SEL.rejected,
}, null, 1));
console.log(`\nwrote ${outDir}/shots.bin (${(offset * 2 / 1024).toFixed(1)} KB, ${table.length} shots) + shots.json`);
