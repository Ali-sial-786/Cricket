// Turns a motion-captured bat swing (a Mixamo-rigged FBX, e.g. a baseball hit)
// into the small set of body-mechanics curves the batters use: how the hips
// and shoulders turn, how the weight moves onto the front foot, the stride,
// the drop of the hips and the pivot of the back foot — all against time
// relative to contact. Arms and bat are NOT taken from the clip: in the game
// the hands always go to the real (physics) bat.
//
//   node tools/build_swing.mjs path/to/swing.fbx > src/render/swingProfile.js
//
// Needs three.js resolvable from where it is run (npm i three@0.180.0).
import fs from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

globalThis.window = globalThis; globalThis.self = globalThis;
globalThis.document = { createElementNS: () => ({ style: {}, addEventListener() {}, removeEventListener() {} }), createElement: () => ({ style: {}, getContext: () => null }) };

const RATE = 30, BEFORE = 1.0, AFTER = 0.9;
const buf = fs.readFileSync(process.argv[2]);
const obj = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
const clip = obj.animations.find((c) => c.tracks.length) || obj.animations[0];
const mixer = new THREE.AnimationMixer(obj);
mixer.clipAction(clip).play();
const bone = {};
obj.traverse((o) => { if (o.isBone && !bone[o.name.replace('mixamorig', '')]) bone[o.name.replace('mixamorig', '')] = o; });
const J = ['Hips', 'Spine2', 'Head', 'LeftArm', 'RightArm', 'LeftHand', 'RightHand', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'];
const at = (t) => {
  mixer.setTime(t);
  obj.updateMatrixWorld(true);
  const p = {};
  for (const n of J) p[n] = bone[n].getWorldPosition(new THREE.Vector3());
  return p;
};
// Contact: the hands are moving fastest just before the bat meets the ball.
const dt = 1 / 120;
let tc = 0, best = 0, prev = at(0);
for (let t = dt; t < clip.duration; t += dt) {
  const p = at(t);
  const v = p.LeftHand.clone().add(p.RightHand).sub(prev.LeftHand).sub(prev.RightHand).length() / (2 * dt);
  if (v > best) { best = v; tc = t; }
  prev = p;
}
tc += 0.03;
const t0 = Math.max(0, tc - BEFORE), t1 = Math.min(clip.duration, tc + AFTER);
const P0 = at(t0);
const legLen = P0.LeftUpLeg.distanceTo(P0.LeftLeg) + P0.LeftLeg.distanceTo(P0.LeftFoot);
// Toward the pitcher: from the back foot to the front foot in the stance. Which is the front one?
// The foot that strides (moves most before contact).
const Pc = at(tc);
const moved = (n) => Math.hypot(Pc[n].x - P0[n].x, Pc[n].z - P0[n].z);
const front = moved('LeftFoot') >= moved('RightFoot') ? 'Left' : 'Right', back = front === 'Left' ? 'Right' : 'Left';
const fwd = new THREE.Vector3(P0[front + 'Foot'].x - P0[back + 'Foot'].x, 0, P0[front + 'Foot'].z - P0[back + 'Foot'].z).normalize();
const yawOf = (a, b) => Math.atan2(b.x - a.x, b.z - a.z);                 // heading of the left->right (or any) axis
const unwrap = (a, ref) => { while (a - ref > Math.PI) a -= 2 * Math.PI; while (a - ref < -Math.PI) a += 2 * Math.PI; return a; };
const out = { pelvisYaw: [], chestYaw: [], weight: [], drop: [], stride: [], strideLift: [], heel: [], pivot: [] };
const y0 = { pelvis: yawOf(P0.RightUpLeg, P0.LeftUpLeg), chest: yawOf(P0.RightArm, P0.LeftArm), foot: yawOf(P0[back + 'Foot'], P0[back + 'ToeBase']) };
let lp = 0, lc = 0, lf = 0;
const n = Math.round((t1 - t0) * RATE) + 1;
for (let i = 0; i < n; i++) {
  const p = at(t0 + i / RATE);
  lp = unwrap(yawOf(p.RightUpLeg, p.LeftUpLeg) - y0.pelvis, lp);
  lc = unwrap(yawOf(p.RightArm, p.LeftArm) - y0.chest, lc);
  lf = unwrap(yawOf(p[back + 'Foot'], p[back + 'ToeBase']) - y0.foot, lf);
  out.pelvisYaw.push(lp); out.chestYaw.push(lc); out.pivot.push(lf);
  const fb = new THREE.Vector3().subVectors(p[front + 'Foot'], p[back + 'Foot']); fb.y = 0;
  const hb = new THREE.Vector3().subVectors(p.Hips, p[back + 'Foot']); hb.y = 0;
  out.weight.push(hb.dot(fb) / fb.lengthSq());
  out.drop.push((P0.Hips.y - p.Hips.y) / legLen);
  out.stride.push(new THREE.Vector3().subVectors(p[front + 'Foot'], P0[front + 'Foot']).dot(fwd) / legLen);
  out.strideLift.push(Math.max(0, p[front + 'Foot'].y - P0[front + 'Foot'].y) / legLen);
  const ft = new THREE.Vector3().subVectors(p[back + 'ToeBase'], p[back + 'Foot']);
  const ft0 = new THREE.Vector3().subVectors(P0[back + 'ToeBase'], P0[back + 'Foot']);
  out.heel.push(Math.atan2(-ft.y, Math.hypot(ft.x, ft.z)) - Math.atan2(-ft0.y, Math.hypot(ft0.x, ft0.z)));
}
// Turning toward the pitcher counts as positive whichever way round the clip was recorded.
const sgn = Math.sign(out.pelvisYaw[out.pelvisYaw.length - 1]) || 1;
for (const k of ['pelvisYaw', 'chestYaw', 'pivot']) out[k] = out[k].map((v) => v * sgn);
const fmt = (a) => '[' + a.map((v) => +v.toFixed(3)).join(', ') + ']';
process.stderr.write(`clip ${clip.duration.toFixed(2)} s, contact at ${tc.toFixed(2)} s, front foot ${front}, leg ${legLen.toFixed(1)}, ${n} samples\n`);
process.stdout.write(`// Body mechanics of a real bat swing, measured from motion capture by
// tools/build_swing.mjs (do not edit by hand). Each curve is sampled ${RATE} times a
// second starting ${(tc - t0).toFixed(2)} s before contact:
//   pelvisYaw / chestYaw  how far the hips / the shoulders have turned toward the bowler (rad)
//   weight                where the hips are between the back foot (0) and the front foot (1)
//   drop                  how far the hips have sunk (leg lengths)
//   stride, strideLift    the front foot going down the pitch and off the ground (leg lengths)
//   heel, pivot           the back heel coming up and the back foot turning on its toe (rad)
export const SWING = {
  rate: ${RATE}, before: ${(tc - t0).toFixed(3)}, after: ${(t1 - tc).toFixed(3)},
${Object.keys(out).map((k) => `  ${k}: ${fmt(out[k])},`).join('\n')}
};

const _keys = ${JSON.stringify(Object.keys(out))};
// Sample every curve at t seconds relative to contact (clamped to the clip).
export function swingAt(t, out = {}) {
  const f = Math.min(SWING.pelvisYaw.length - 1, Math.max(0, (t + SWING.before) * SWING.rate));
  const i = Math.floor(f), j = Math.min(SWING.pelvisYaw.length - 1, i + 1), k = f - i;
  for (const key of _keys) { const a = SWING[key]; out[key] = a[i] + (a[j] - a[i]) * k; }
  return out;
}
`);
