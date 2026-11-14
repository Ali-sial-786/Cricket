// Retargets animation clips from Quaternius' Universal Animation Library (CC0;
// carried by the Universal Base Character in Courtside's sportsmate.glb, a
// 65-joint UE-style rig) onto the game's 17-bone Humanoid and writes
//   assets/anim/clips.json  (clip table: frames, duration, loop, events, gait)
//   assets/anim/clips.bin   (int16 frames: 17 local quaternions + hips offset)
// Usage: node tools/build_clips.mjs <sportsmate.glb> [node_modules dir with three] [out dir]
//
// How: the game rig's canonical pose is "standing, arms straight down, every
// local rotation identity". For each mapped bone take the source bone's world
// rotation relative to its rest (T-pose) world rotation, D(t) = R(t)·R_rest⁻¹,
// and pre-compose the fixed rotation A⁻¹ that turns the canonical bone
// direction (limbs: -Y) onto the source's rest bone direction (arms: out to the
// side; legs and trunk: as they are). The target's world rotation is
// D(t)·A⁻¹, made local with its parent's. The source faces +Z with its left
// on +X, like the game's rig, so nothing is mirrored. Hips translation is
// stored in leg lengths (the runtime scales it by the figure's own legs).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = process.argv[2];
const modDir = process.argv[3] || path.resolve('node_modules');
const outDir = process.argv[4] || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../assets/anim');
const THREE = await import(pathToFileURL(path.join(modDir, 'three/build/three.module.js')).href);

const FPS = 30;
// name in the source, name in the game, loop?
const CLIPS = [
  ['idle', 'idle', true], ['idle_fold_arms', 'idle_fold_arms', true],
  ['walk', 'walk', true], ['jog', 'jog', true], ['sprint', 'sprint', true],
  ['bb_defense', 'set', true],                // athletic set (legs and trunk; the arms stay procedural)
  ['overhand_throw', 'throw', false],
  ['bb_cheer', 'cheer', true], ['bb_sad', 'sad', false],
];
// Not used: 'pickup' lifts something from waist height (no bend to the ground),
// 'crouch_idle' is a sneak, 'bb_squat' a deep squat; the ball pick-up stays procedural.
const LOCO = new Set(['walk', 'jog', 'sprint']);
// The source character is big-headed and carries its head ~12 degrees down;
// on the game's proportions that reads as dejected, so lift it a little
// (local pitch added to every frame; negative X = up).
const LIFT = { neck: -0.07, head: -0.15 };

// Target bones (order = the game's athlete.json order) -> source joint.
const BONES = ['hips', 'spine', 'chest', 'neck', 'head', 'shoulderL', 'elbowL', 'handL', 'shoulderR', 'elbowR', 'handR', 'hipL', 'kneeL', 'ankleL', 'hipR', 'kneeR', 'ankleR'];
const PARENT = { hips: null, spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck', shoulderL: 'chest', elbowL: 'shoulderL', handL: 'elbowL', shoulderR: 'chest', elbowR: 'shoulderR', handR: 'elbowR', hipL: 'hips', kneeL: 'hipL', ankleL: 'kneeL', hipR: 'hips', kneeR: 'hipR', ankleR: 'kneeR' };
const MAP = {
  hips: 'pelvis', spine: 'spine_01', chest: 'spine_03', neck: 'neck_01', head: 'Head',
  shoulderL: 'upperarm_l', elbowL: 'lowerarm_l', handL: 'hand_l', shoulderR: 'upperarm_r', elbowR: 'lowerarm_r', handR: 'hand_r',
  hipL: 'thigh_l', kneeL: 'calf_l', ankleL: 'foot_l', hipR: 'thigh_r', kneeR: 'calf_r', ankleR: 'foot_r',
};
// Limb bones: rest direction toward the child joint, which the canonical pose points along -Y.
const LIMB_CHILD = {
  shoulderL: 'lowerarm_l', elbowL: 'hand_l', handL: 'middle_01_l', shoulderR: 'lowerarm_r', elbowR: 'hand_r', handR: 'middle_01_r',
  hipL: 'calf_l', kneeL: 'foot_l', hipR: 'calf_r', kneeR: 'foot_r',
};

// ---------------------------------------------------------------- GLB
const buf = fs.readFileSync(src);
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString());
const bin = buf.subarray(20 + jsonLen + 8);
const NC = { SCALAR: 1, VEC3: 3, VEC4: 4 };
function acc(i) {
  const a = gltf.accessors[i], bv = gltf.bufferViews[a.bufferView], n = NC[a.type];
  if (a.componentType !== 5126) throw new Error('expected float accessor');
  const base = bin.byteOffset + (bv.byteOffset || 0) + (a.byteOffset || 0);
  return new Float32Array(bin.buffer.slice(base, base + a.count * n * 4));
}
const nodes = gltf.nodes.map((n) => {
  const o = new THREE.Object3D();
  o.name = n.name;
  if (n.translation) o.position.fromArray(n.translation);
  if (n.rotation) o.quaternion.fromArray(n.rotation);
  if (n.scale) o.scale.fromArray(n.scale);
  return o;
});
const parentOf = [];
gltf.nodes.forEach((n, i) => (n.children || []).forEach((c) => { nodes[i].add(nodes[c]); parentOf[c] = i; }));
const skinJoints = gltf.skins[0].joints;
const byName = {};
for (const j of skinJoints) byName[gltf.nodes[j].name] = nodes[j];
let top = byName.root; while (top.parent) top = top.parent;
const rest = skinJoints.map((j) => ({ p: nodes[j].position.clone(), q: nodes[j].quaternion.clone(), s: nodes[j].scale.clone() }));
const resetRest = () => skinJoints.forEach((j, k) => { nodes[j].position.copy(rest[k].p); nodes[j].quaternion.copy(rest[k].q); nodes[j].scale.copy(rest[k].s); });

const wq = (name, out = new THREE.Quaternion()) => byName[name].getWorldQuaternion(out);
const wp = (name, out = new THREE.Vector3()) => byName[name].getWorldPosition(out);

// ---------------------------------------------------------------- rest frame
resetRest();
top.updateMatrixWorld(true);
const restQinv = {}, Ainv = {};
for (const b of BONES) {
  restQinv[b] = wq(MAP[b]).invert();
  Ainv[b] = new THREE.Quaternion();
  if (LIMB_CHILD[b]) {
    const d = wp(LIMB_CHILD[b]).sub(wp(MAP[b])).normalize();
    Ainv[b].setFromUnitVectors(new THREE.Vector3(0, -1, 0), d);
  }
}
const restPelvis = wp('pelvis');
const srcLeg = wp('thigh_l').distanceTo(wp('calf_l')) + wp('calf_l').distanceTo(wp('foot_l'));
const srcAnkleH = wp('foot_l').y, srcBallH = wp('ball_l').y;
console.log(`source: leg ${srcLeg.toFixed(3)}, pelvis ${restPelvis.toArray().map((v) => v.toFixed(3))}, facing +Z (toes z ${wp('ball_l').z.toFixed(3)} > ankle z ${wp('foot_l').z.toFixed(3)}), left thigh x ${wp('thigh_l').x.toFixed(3)}`);

// ---------------------------------------------------------------- sampling
function sampler(anim) {
  const ch = anim.channels.map((c) => {
    const s = anim.samplers[c.sampler];
    return { node: nodes[c.target.node], path: c.target.path, step: s.interpolation === 'STEP', t: acc(s.input), v: acc(s.output) };
  });
  const dur = Math.max(...ch.map((c) => c.t[c.t.length - 1]));
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  return {
    dur,
    set(time) {
      resetRest();
      for (const c of ch) {
        const t = c.t, n = c.path === 'rotation' ? 4 : 3;
        let i = 0;
        while (i < t.length - 1 && t[i + 1] <= time) i++;
        const j = Math.min(i + 1, t.length - 1);
        const u = c.step || j === i ? 0 : Math.min(1, Math.max(0, (time - t[i]) / (t[j] - t[i])));
        const tgt = c.path === 'rotation' ? c.node.quaternion : c.path === 'translation' ? c.node.position : c.node.scale;
        if (n === 4) { qa.fromArray(c.v, i * 4); qb.fromArray(c.v, j * 4); tgt.copy(qa).slerp(qb, u); }
        else tgt.set(c.v[i * 3] + (c.v[j * 3] - c.v[i * 3]) * u, c.v[i * 3 + 1] + (c.v[j * 3 + 1] - c.v[i * 3 + 1]) * u, c.v[i * 3 + 2] + (c.v[j * 3 + 2] - c.v[i * 3 + 2]) * u);
      }
      top.updateMatrixWorld(true);
    },
  };
}

const W = {}; for (const b of BONES) W[b] = new THREE.Quaternion();
const _pinv = new THREE.Quaternion(), _lift = new THREE.Quaternion(), _xAxis = new THREE.Vector3(1, 0, 0);
// Pose the target from the source's current state -> local quats + hips offset (leg lengths).
function retarget(outQ, outP) {
  for (const b of BONES) W[b].copy(wq(MAP[b])).multiply(restQinv[b]).multiply(Ainv[b]);
  BONES.forEach((b, k) => {
    const p = PARENT[b];
    const q = p ? _pinv.copy(W[p]).invert().multiply(W[b]).clone() : W[b].clone();
    if (LIFT[b]) q.multiply(_lift.setFromAxisAngle(_xAxis, LIFT[b]));
    q.normalize();
    outQ.push(q);
  });
  const pp = wp('pelvis').sub(restPelvis).divideScalar(srcLeg);
  outP.push(pp);
}

// Simple forward kinematics of the TARGET (unit leg length, canonical offsets)
// for validation: where do the feet and hands end up?
const TJ = JSON.parse(fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../assets/models/athlete.json'), 'utf8')).joints;
const tLeg = Math.hypot(...TJ.hipL.map((v, i) => v - TJ.kneeL[i])) + Math.hypot(...TJ.kneeL.map((v, i) => v - TJ.ankleL[i]));
const tArm = Math.hypot(...TJ.shoulderL.map((v, i) => v - TJ.elbowL[i])), tFore = Math.hypot(...TJ.elbowL.map((v, i) => v - TJ.handL[i]));
const canon = {};
for (const b of BONES) canon[b] = new THREE.Vector3(...TJ[b]);
for (const s of ['L', 'R']) {
  canon['elbow' + s] = canon['shoulder' + s].clone().add(new THREE.Vector3(0, -tArm, 0));
  canon['hand' + s] = canon['elbow' + s].clone().add(new THREE.Vector3(0, -tFore, 0));
  const th = Math.hypot(...TJ['hip' + s].map((v, i) => v - TJ['knee' + s][i]));
  canon['knee' + s] = canon['hip' + s].clone().add(new THREE.Vector3(0, -th, 0));
  canon['ankle' + s] = canon['knee' + s].clone().add(new THREE.Vector3(0, -(tLeg - th), 0));
}
function fk(qs, hp) {
  const Wq = {}, Wp = {};
  BONES.forEach((b, k) => {
    const p = PARENT[b];
    if (!p) { Wq[b] = qs[k].clone(); Wp[b] = canon.hips.clone().addScaledVector(hp, tLeg); return; }
    Wq[b] = Wq[p].clone().multiply(qs[k]);
    Wp[b] = canon[b].clone().sub(canon[p]).applyQuaternion(Wq[p]).add(Wp[p]);
  });
  return { Wq, Wp };
}

// ---------------------------------------------------------------- build
const table = [];
const frames = [];          // Int16 chunks
let offset = 0;
const PER = BONES.length * 4 + 3;
for (const [srcName, name, loop] of CLIPS) {
  const anim = gltf.animations.find((a) => a.name === srcName);
  if (!anim) throw new Error('missing clip ' + srcName);
  const S = sampler(anim);
  const n = Math.max(2, Math.round(S.dur * FPS));
  const count = loop ? n : n + 1;                 // loops: the last frame wraps to the first
  const Q = [], P = [];
  // Per foot, in source leg lengths: lowest point (heel or toe) above its rest
  // height, the heel's own height, and the heel / toe positions along Z.
  const two = () => ({ L: [], R: [] });
  const footY = two(), footA = two(), footZa = two(), footZb = two(), handY = two(), handZ = two();
  for (let f = 0; f < count; f++) {
    const time = (f / n) * S.dur;
    S.set(time);
    retarget(Q, P);
    for (const s of ['L', 'R']) {
      const l = s.toLowerCase();
      footY[s].push(Math.min(wp('foot_' + l).y - srcAnkleH, wp('ball_' + l).y - srcBallH) / srcLeg);   // lowest of heel / toe
      footA[s].push((wp('foot_' + l).y - srcAnkleH) / srcLeg);
      footZa[s].push(wp('foot_' + l).z / srcLeg);
      footZb[s].push(wp('ball_' + l).z / srcLeg);
      handY[s].push(wp('hand_' + l).y / srcLeg);
      handZ[s].push(wp('hand_' + l).z / srcLeg);
    }
  }
  // Keep quaternion hemispheres continuous (frames are interpolated linearly).
  for (let k = 0; k < BONES.length; k++) {
    for (let f = 1; f < count; f++) { const a = Q[(f - 1) * BONES.length + k], b = Q[f * BONES.length + k]; if (a.dot(b) < 0) b.set(-b.x, -b.y, -b.z, -b.w); }
  }
  // Ground the clip: some float a little (the source's own feet never reach
  // the floor); drop the hips so the lowest heel / toe of the clip touches it.
  const ground = Math.min(...footY.L, ...footY.R);
  if (Math.abs(ground) > 0.004) for (const p of P) p.y -= ground;
  let wrap = 0;
  for (let k = 0; k < BONES.length; k++) wrap = Math.max(wrap, Q[k].angleTo(Q[(count - 1) * BONES.length + k]));   // loop seam check (one frame apart)
  const data = new Int16Array(count * PER);
  for (let f = 0; f < count; f++) {
    for (let k = 0; k < BONES.length; k++) {
      const q = Q[f * BONES.length + k];
      data.set([q.x, q.y, q.z, q.w].map((v) => Math.round(v * 32767)), f * PER + k * 4);
    }
    const p = P[f];
    data.set([p.x, p.y, p.z].map((v) => Math.round(Math.max(-1, Math.min(1, v / 2)) * 32767)), f * PER + BONES.length * 4);   // +-2 leg lengths
  }
  const meta = { name, src: srcName, frames: count, fps: n / S.dur, dur: +S.dur.toFixed(4), loop, offset, grounded: +(-ground).toFixed(4) };
  // ---- events / gait
  if (LOCO.has(name)) {
    // Ground speed: how fast the lowest point of a planted foot (heel or toe)
    // slides back under the body. Cycle phase 0 = the left foot's touchdown.
    const speeds = [], on = { L: [], R: [] };
    for (const s of ['L', 'R']) {
      for (let f = 0; f < count; f++) on[s].push(footY[s][f] < 0.035 ? 1 : 0);
      for (let f = 0; f < count; f++) {
        const g = (f + 1) % count;
        if (!on[s][f] || !on[s][g]) continue;
        const k = footY[s][f] === footA[s][f] ? footZa : footZb;      // the point that is down
        speeds.push(-(k[s][g] - k[s][f]) * meta.fps);
      }
    }
    speeds.sort((a, b) => a - b);
    const speed = speeds[Math.floor(speeds.length / 2)];
    let td = 0;
    for (let f = 0; f < count; f++) if (on.L[f] && !on.L[(f - 1 + count) % count]) { td = f; break; }
    meta.speed = +speed.toFixed(4);                // leg lengths per second
    meta.stride = +(speed * S.dur).toFixed(4);     // leg lengths per cycle (two steps)
    meta.phase0 = +(td / n).toFixed(4);            // cycle fraction of the left foot's touchdown
    meta.contact = { L: on.L.join(''), R: on.R.join('') };
  }
  if (name === 'throw') {
    // Release: the throwing hand's fastest forward travel while above the shoulder line.
    let best = 0, bf = 0, side = 'R';
    for (const s of ['L', 'R']) for (let f = 1; f < count; f++) {
      const v = (handZ[s][f] - handZ[s][f - 1]) * meta.fps;
      if (handY[s][f] > 1.3 && v > best) { best = v; bf = f; side = s; }
    }
    meta.events = { release: +(((bf - 0.5) / n) * S.dur).toFixed(4), hand: side };
  }
  // ---- validation numbers (target FK)
  let footMin = 9, footMax = -9, handInside = 0;
  for (let f = 0; f < count; f++) {
    const { Wp } = fk(Q.slice(f * BONES.length, (f + 1) * BONES.length), P[f]);
    for (const s of ['L', 'R']) { const y = Wp['ankle' + s].y - canon['ankle' + s].y; footMin = Math.min(footMin, y); footMax = Math.max(footMax, y); }
    // hands through the torso: wrist within 0.1 of the spine -> neck segment
    for (const s of ['L', 'R']) {
      const h = Wp['hand' + s], a = Wp.spine, b = Wp.neck;
      const ab = b.clone().sub(a), t = Math.max(0, Math.min(1, h.clone().sub(a).dot(ab) / ab.lengthSq()));
      if (h.distanceTo(a.clone().addScaledVector(ab, t)) < 0.1) handInside++;
    }
  }
  meta.check = { footLow: +footMin.toFixed(3), footHigh: +footMax.toFixed(3), handInTorsoFrames: handInside };
  console.log(name.padEnd(15), `${S.dur.toFixed(2)}s ${count}f first-last ${wrap.toFixed(2)}rad`, JSON.stringify({ speed: meta.speed, stride: meta.stride, phase0: meta.phase0, events: meta.events, check: meta.check }));
  if (meta.contact) console.log('   contact L', meta.contact.L, '\n   contact R', meta.contact.R);
  delete meta.contact;
  table.push(meta);
  frames.push(Buffer.from(data.buffer));
  offset += count * PER;
}
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'clips.bin'), Buffer.concat(frames));
fs.writeFileSync(path.join(outDir, 'clips.json'), JSON.stringify({
  source: "Quaternius Universal Animation Library (CC0), via Courtside's sportsmate.glb; retargeted by tools/build_clips.mjs",
  bones: BONES, stride: PER, qScale: 32767, posScale: 2 / 32767, units: 'hips offset in leg lengths (hip joint to ankle)',
  clips: table,
}, null, 1));
console.log(`wrote ${outDir}/clips.bin (${(offset * 2 / 1024).toFixed(1)} KB) + clips.json`);
