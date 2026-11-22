// Poses for the match ceremonies (src/game/ceremony.js), drawn over a figure
// that has just been posed by its own update (FielderActor.update), arms by
// IK slerped in by weight, so they come and go over a few tenths:
//
//   coinToss(a, tf, coin, dt)  the captain's toss: coin held out, the thumb
//                              flick (the coin leaves at tf = TOSS_AT), eyes on
//                              the coin up and down, then leaning over to read it
//   nod(a, u)                  a nod (u: s since it began)
//   offerHand(a, w, t)         the right hand held out to shake yours
import * as THREE from 'three';
import { sstep } from './anim.js';
import { lookSteady, envelope } from './gestures.js';

export const TOSS_AT = 0.55;                    // s into the flip that the coin leaves the thumb (ceremony.js launches it then)
const ARMS = ['shoulderR', 'elbowR', 'handR'];
const _f = new THREE.Vector3(), _l = new THREE.Vector3(), _t = new THREE.Vector3(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion();

// The right arm onto `target` (pole: where the elbow points), by weight w.
function armTo(a, target, pole, w) {
  if (w <= 0.001) return;
  const h = a.h, B = h.bones, Q = a._gs.q;
  for (let i = 0; i < 3; i++) Q[i].copy(B[ARMS[i]].quaternion);
  h.ikArm('R', target, pole);
  if (w < 1) for (let i = 0; i < 3; i++) { _q.copy(B[ARMS[i]].quaternion); B[ARMS[i]].quaternion.copy(Q[i]).slerp(_q, w); }
}
function frame(a) {
  a.h.update();
  a.forward(_f); _l.set(_f.z, 0, -_f.x);
  return a.h.worldPos('shoulderR', _s);
}

// tf: s since the flip began (ceremony.js flip.tf); coin: the coin's position (world) or null.
// you: your head (world): once he has read the coin he looks up at you.
export function coinToss(a, tf, coin, dt, you = null) {
  const h = a.h, sc = h.root.scale.y;
  const sh = frame(a);
  // out in front at the bottom of the chest, forearm level; the flick: up and a touch forward, the hand following the coin
  const hold = sstep(0, 0.35, tf) * (1 - sstep(1.0, 1.45, tf));
  const flick = sstep(TOSS_AT - 0.13, TOSS_AT, tf) * (1 - sstep(TOSS_AT + 0.1, TOSS_AT + 0.45, tf));
  _t.copy(sh).addScaledVector(_f, (0.32 + 0.05 * flick) * sc).addScaledVector(_l, 0.04).addScaledVector(_u, (-0.24 + 0.17 * flick) * sc);
  _p.copy(sh).addScaledVector(_l, -0.5).addScaledVector(_u, -0.5).addScaledVector(_f, -0.1);
  armTo(a, _t, _p, hold);
  // when it is down: leaning over a little to read it
  const lean = sstep(1.55, 1.9, tf) * (1 - sstep(2.1, 2.5, tf));
  if (lean > 0.001) { h.addRot('spine', 0.28 * lean, 0, 0); h.addRot('chest', 0.08 * lean, 0, 0); }
  // eyes on the coin, up and down (a quick neck: it is a quick coin)
  lookSteady(h, tf > 2.05 && you ? you : coin, 1, dt, a._gs, tf > 2.05 ? 6 : 14);
}

export function nod(a, u) {
  if (u <= 0 || u >= 0.9) return;
  const k = Math.sin(Math.PI * 2 * u / 0.45) * (1 - sstep(0.5, 0.9, u)) * sstep(0, 0.08, u);
  a.h.addRot('neck', 0.16 * k, 0, 0); a.h.addRot('head', 0.1 * k, 0, 0);
}

// w: weight (0..1); t: s (for the shake).
export function offerHand(a, w, t) {
  if (w <= 0.001) return;
  const sc = a.h.root.scale.y, sh = frame(a);
  const shake = 0.025 * Math.sin(t * 13) * sstep(0.6, 0.9, w);
  _t.copy(sh).addScaledVector(_f, 0.48 * sc).addScaledVector(_l, 0.1).addScaledVector(_u, (-0.36 + shake) * sc);
  _p.copy(sh).addScaledVector(_l, -0.6).addScaledVector(_u, -0.5);
  armTo(a, _t, _p, w);
}
export { envelope };
const _u = new THREE.Vector3(0, 1, 0);
