// Procedural animation library for Humanoid rigs.
//
// Conventions (figure local frame, facing +Z, left = +X):
//   hip/shoulder rotX < 0  -> limb swings forward
//   knee rotX > 0          -> knee flexes (shin back)
//   elbow rotX < 0         -> elbow flexes (forearm forward)
//   spine/chest rotX > 0   -> lean forward;  rotY > 0 -> turn to the left
import * as THREE from 'three';

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const mix = (a, b, t) => a + (b - a) * t;
// Piecewise-linear-in-time keyframes with smooth easing: keys = [[t, value], ...]
export function keys(k, t) {
  if (t <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) {
    if (t <= k[i][0]) {
      const u = (t - k[i - 1][0]) / (k[i][0] - k[i - 1][0]);
      const e = u * u * (3 - 2 * u);
      return k[i - 1][1] + (k[i][1] - k[i - 1][1]) * e;
    }
  }
  return k[k.length - 1][1];
}

// Stride length (one full cycle = two steps) for a given speed (m/s).
export const strideFor = (speed) => 1.25 + 0.3 * speed;

// ------------------------------------------------------------- base poses
export function poseIdle(h, t, amt = 1) {
  const br = Math.sin(t * 1.7) * 0.02 * amt;
  h.rot('spine', 0.03 + br, 0, 0);
  h.rot('chest', br * 0.5, 0, 0);
  h.rot('shoulderL', 0.04, 0, 0.07);
  h.rot('shoulderR', 0.04, 0, -0.07);
  h.rot('elbowL', -0.18, 0, 0);
  h.rot('elbowR', -0.18, 0, 0);
  h.rot('hipL', 0, 0, 0.03);
  h.rot('hipR', 0, 0, -0.03);
  h.rot('kneeL', 0.05, 0, 0);
  h.rot('kneeR', 0.05, 0, 0);
  h.rot('ankleL', -0.05, 0, 0);
  h.rot('ankleR', -0.05, 0, 0);
}

// Walk ↔ run blended by speed. phase in radians.
export function poseLocomotion(h, phase, speed, lean = 0) {
  if (speed < 0.05) return;
  const run = sstep(2.2, 4.6, speed);
  const go = Math.min(1, speed / 1.0);
  const s = Math.sin(phase), c = Math.cos(phase);
  const A = (0.36 + 0.52 * run) * go;
  const kB = (0.06 + 0.22 * run) * go;
  const kS = (0.5 + 1.25 * run) * go;
  const thL = -A * s, thR = A * s;
  const kL = kB + kS * Math.pow(Math.max(0, c), 1.4);
  const kR = kB + kS * Math.pow(Math.max(0, -c), 1.4);
  h.rot('hipL', thL, 0, 0.03);
  h.rot('hipR', thR, 0, -0.03);
  h.rot('kneeL', kL, 0, 0);
  h.rot('kneeR', kR, 0, 0);
  h.rot('ankleL', -(thL + kL) * 0.7 + 0.15 * run * Math.max(0, -s), 0, 0);
  h.rot('ankleR', -(thR + kR) * 0.7 + 0.15 * run * Math.max(0, s), 0, 0);
  const bob = (0.025 + 0.03 * run) * go * (0.5 - 0.5 * Math.cos(2 * phase));
  h.bones.hips.position.y = h.hipsRest.y - 0.035 * run * go - (0.03 * go - bob);
  h.rot('hips', 0, -0.13 * s * go, 0);
  h.rot('spine', 0.05 + 0.17 * run * go + lean, 0.06 * s * go, 0);
  h.rot('chest', 0.02 * run, 0.16 * s * go, 0);
  const B = (0.32 + 0.55 * run) * go;
  h.rot('shoulderL', B * s, 0, 0.08 + 0.05 * run);
  h.rot('shoulderR', -B * s, 0, -0.08 - 0.05 * run);
  h.rot('elbowL', -(0.25 + 1.2 * run) - 0.2 * run * Math.max(0, -s), 0, 0);
  h.rot('elbowR', -(0.25 + 1.2 * run) - 0.2 * run * Math.max(0, s), 0, 0);
  h.rot('neck', -0.05 * run, -0.1 * s * go, 0);
  h.rot('head', -0.08 * run, 0, 0);
}

// Feet planted at world targets via leg IK; feet kept flat along `yaw`.
const _ft = new THREE.Vector3(), _pole = new THREE.Vector3(), _fq = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);
export function plantFeet(h, footL, footR, kneeForward) {
  h.update();
  for (const [side, target] of [['L', footL], ['R', footR]]) {
    if (!target) continue;
    h.worldPos('knee' + side, _pole).add(kneeForward);
    _ft.copy(target);
    _ft.y += 0.075 * h.root.scale.y;      // ankle height above the sole
    h.ikLeg(side, _ft, _pole);
  }
  // Flat feet facing the root's forward (plus a small toe-out).
  h.root.getWorldQuaternion(_fq);
  h.setWorldQuat('ankleL', _fq);
  h.setWorldQuat('ankleR', _fq);
}

// Athletic "ready" crouch (fielders as the ball is bowled). k: 0..1
export function poseReady(h, k, keeper = false) {
  const d = keeper ? 0.42 : 0.17;
  h.bones.hips.position.y = h.hipsRest.y - d * k;
  h.rot('spine', (keeper ? 0.55 : 0.4) * k, 0, 0);
  h.rot('chest', 0.12 * k, 0, 0);
  h.rot('neck', -0.25 * k, 0, 0);
  h.rot('head', -0.2 * k, 0, 0);
  h.rot('shoulderL', -(keeper ? 1.0 : 0.65) * k, 0, 0.12 + 0.1 * k);
  h.rot('shoulderR', -(keeper ? 1.0 : 0.65) * k, 0, -0.12 - 0.1 * k);
  h.rot('elbowL', -0.55 * k - 0.15, 0, 0);
  h.rot('elbowR', -0.55 * k - 0.15, 0, 0);
}

// Overarm throw. k = time since start / duration; release at k ≈ 0.62.
export function poseThrow(h, k) {
  h.rot('hipL', keys([[0, 0], [0.4, -0.55], [0.7, -0.45], [1, -0.2]], k), 0, 0.08);
  h.rot('kneeL', keys([[0, 0.1], [0.4, 0.35], [0.7, 0.15], [1, 0.1]], k), 0, 0);
  h.rot('hipR', keys([[0, 0], [0.4, 0.25], [0.7, 0.45], [1, 0.2]], k), 0, -0.08);
  h.rot('kneeR', keys([[0, 0.1], [0.4, 0.3], [0.7, 0.7], [1, 0.3]], k), 0, 0);
  h.rot('hips', 0, keys([[0, 0], [0.4, -0.6], [0.7, 0.35], [1, 0.2]], k), 0);
  h.rot('spine', keys([[0, 0.1], [0.4, -0.05], [0.7, 0.45], [1, 0.3]], k), 0, 0);
  h.rot('chest', 0, keys([[0, 0], [0.4, -0.55], [0.7, 0.45], [1, 0.3]], k), 0);
  h.rot('shoulderR', keys([[0, 0.3], [0.42, 2.45], [0.62, 3.95], [0.8, 4.6], [1, 4.3]], k), 0, keys([[0, -0.2], [0.42, -0.55], [0.8, -0.2], [1, -0.1]], k));
  h.rot('elbowR', keys([[0, -0.6], [0.42, -1.5], [0.62, -0.25], [1, -0.4]], k), 0, 0);
  h.rot('shoulderL', keys([[0, 0], [0.42, -1.45], [0.7, -0.3], [1, 0.1]], k), 0, keys([[0, 0.1], [0.42, 0.25], [1, 0.2]], k));
  h.rot('elbowL', -0.3, 0, 0);
}

// Diving stop / catch. side = +1 to the figure's left (+X), -1 to the right.
export function poseDive(h, k, side) {
  const roll = side * 1.45 * keys([[0, 0], [0.32, 1], [0.62, 1], [1, 0]], k);
  h.bones.hips.position.y = h.hipsRest.y * keys([[0, 1], [0.15, 0.95], [0.38, 0.28], [0.65, 0.28], [1, 1]], k);
  h.rot('hips', 0, 0, -roll);
  h.rot('spine', 0.1, 0, -side * 0.15);
  const reach = keys([[0, 0], [0.25, 1], [0.7, 1], [1, 0]], k);
  h.rot('shoulderL', -0.3 * reach, 0, side > 0 ? 2.7 * reach : 0.8 * reach);
  h.rot('shoulderR', -0.3 * reach, 0, side < 0 ? -2.7 * reach : -0.8 * reach);
  h.rot('elbowL', -0.15, 0, 0);
  h.rot('elbowR', -0.15, 0, 0);
  h.rot('hipL', -0.2 * reach, 0, side > 0 ? 0.1 : 0.35 * reach);
  h.rot('hipR', -0.2 * reach, 0, side < 0 ? -0.1 : -0.35 * reach);
  h.rot('kneeL', 0.5 * reach, 0, 0);
  h.rot('kneeR', 0.8 * reach, 0, 0);
}

// Bend down to pick the ball up. k: 0..1 (bottom at 0.5).
export function posePickup(h, k) {
  const b = Math.sin(Math.PI * clamp(k, 0, 1));
  h.bones.hips.position.y = h.hipsRest.y - 0.3 * b;
  h.rot('spine', 0.75 * b, 0, 0);
  h.rot('chest', 0.35 * b, 0, 0);
  h.rot('neck', -0.3 * b, 0, 0);
  h.rot('hipL', -0.9 * b, 0, 0.12);
  h.rot('kneeL', 1.3 * b, 0, 0);
  h.rot('ankleL', -0.4 * b, 0, 0);
  h.rot('hipR', -0.3 * b, 0, -0.12);
  h.rot('kneeR', 1.1 * b, 0, 0);
  h.rot('ankleR', -0.6 * b, 0, 0);
  h.rot('shoulderL', -0.4 * b, 0, 0.2);
  h.rot('shoulderR', -1.1 * b, 0, -0.1);
  h.rot('elbowR', -0.1, 0, 0);
}

export function poseCelebrate(h, t, k = 1) {
  const j = Math.max(0, Math.sin(t * 8.5));
  h.bones.hips.position.y = h.hipsRest.y + 0.12 * j * k - 0.05 * k;
  h.rot('kneeL', 0.35 * (1 - j) * k, 0, 0);
  h.rot('kneeR', 0.35 * (1 - j) * k, 0, 0);
  h.rot('hipL', -0.15 * (1 - j) * k, 0, 0.05);
  h.rot('hipR', -0.15 * (1 - j) * k, 0, -0.05);
  h.rot('shoulderL', -2.75 * k, 0, (0.45 + 0.15 * Math.sin(t * 11)) * k);
  h.rot('shoulderR', -2.75 * k, 0, -(0.45 + 0.15 * Math.sin(t * 11 + 1)) * k);
  h.rot('elbowL', -0.3 * k, 0, 0);
  h.rot('elbowR', -0.3 * k, 0, 0);
  h.rot('spine', -0.1 * k, 0, 0);
  h.rot('head', -0.25 * k, 0, 0);
}

// Hands-up appeal / signal pose blending in.
export function poseHandsTogether(h, k) {
  h.rot('shoulderL', -1.2 * k, 0, -0.25 * k);
  h.rot('shoulderR', -1.2 * k, 0, 0.25 * k);
  h.rot('elbowL', -0.9 * k, 0, 0);
  h.rot('elbowR', -0.9 * k, 0, 0);
}
