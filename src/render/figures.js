// Original low-poly humanoid figures (batter, bowler, fielders, keeper).
// Each figure = one merged body mesh + two arm meshes (3 draw calls).
// Local frame: feet at y = 0, facing +Z.
import * as THREE from 'three';
import { part, merge, vertexColorMat } from './util.js';

const ARM_LEN = 0.64;

export function buildFigure({ shirt = 0x2457a6, trousers = 0x2457a6, skin = 0xc68e62, head = 'cap', pads = false, gloves = false, capColor = 0x183a75 } = {}) {
  const group = new THREE.Group();
  const P = [];
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  // Legs + shoes
  for (const sx of [-1, 1]) {
    P.push(part(box(0.15, 0.86, 0.17), trousers, [sx * 0.1, 0.47, 0]));
    P.push(part(box(0.13, 0.08, 0.27), 0xf2f2f2, [sx * 0.1, 0.04, 0.04]));
    if (pads) P.push(part(box(0.17, 0.55, 0.09), 0xf4f4f4, [sx * 0.1, 0.36, 0.1]));
  }
  // Torso, hips
  P.push(part(box(0.36, 0.2, 0.22), trousers, [0, 0.98, 0]));
  P.push(part(box(0.44, 0.58, 0.25), shirt, [0, 1.36, 0]));
  P.push(part(box(0.12, 0.08, 0.12), skin, [0, 1.68, 0]));
  // Head
  P.push(part(new THREE.IcosahedronGeometry(0.115, 1), skin, [0, 1.81, 0.01]));
  if (head === 'helmet') {
    P.push(part(new THREE.SphereGeometry(0.135, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.55), 0x1b2a4a, [0, 1.83, -0.005]));
    P.push(part(box(0.2, 0.012, 0.09), 0x1b2a4a, [0, 1.85, 0.13]));
    P.push(part(box(0.2, 0.11, 0.015), 0x9aa0a6, [0, 1.76, 0.135]));
  } else if (head === 'cap') {
    P.push(part(new THREE.SphereGeometry(0.122, 10, 5, 0, Math.PI * 2, 0, Math.PI * 0.45), capColor, [0, 1.83, 0]));
    P.push(part(box(0.16, 0.012, 0.11), capColor, [0, 1.865, 0.12]));
  } else if (head === 'hat') {
    P.push(part(new THREE.CylinderGeometry(0.2, 0.2, 0.015, 12), 0xf4f1e6, [0, 1.87, 0]));
    P.push(part(new THREE.CylinderGeometry(0.11, 0.12, 0.09, 10), 0xf4f1e6, [0, 1.91, 0]));
  }
  const body = new THREE.Mesh(merge(P), vertexColorMat());
  group.add(body);

  const arms = [];
  for (const sx of [-1, 1]) {
    const ap = [part(box(0.09, ARM_LEN * 0.92, 0.1), shirt, [0, -ARM_LEN * 0.46, 0])];
    ap.push(part(box(0.1, 0.1, 0.1), gloves ? 0xf4f4f4 : skin, [0, -ARM_LEN, 0]));
    const arm = new THREE.Mesh(merge(ap), vertexColorMat());
    arm.position.set(sx * 0.27, 1.6, 0);
    group.add(arm);
    arms.push(arm);
  }
  group.userData = { body, armL: arms[0], armR: arms[1], runPhase: 0 };
  return group;
}

const _down = new THREE.Vector3(0, -1, 0);
const _d = new THREE.Vector3(), _inv = new THREE.Matrix4(), _local = new THREE.Vector3();

// Point an arm (child of figure) at a world-space target, stretching to reach.
export function reachArm(figure, arm, targetWorld) {
  figure.updateMatrixWorld(true);
  _inv.copy(figure.matrixWorld).invert();
  _local.copy(targetWorld).applyMatrix4(_inv);
  _d.subVectors(_local, arm.position);
  const len = _d.length();
  if (len < 1e-4) return;
  _d.divideScalar(len);
  arm.quaternion.setFromUnitVectors(_down, _d);
  arm.scale.set(1, Math.min(1.6, Math.max(0.5, len / ARM_LEN)), 1);
}

// Simple running animation: arm swing + bob. speed in m/s.
export function animateRun(figure, dt, speed) {
  const u = figure.userData;
  const body = u.body;
  if (speed > 0.3) {
    u.runPhase += dt * (4 + speed * 1.4);
    const s = Math.sin(u.runPhase);
    u.armL.rotation.set(s * 0.9, 0, 0);
    u.armR.rotation.set(-s * 0.9, 0, 0);
    u.armL.scale.set(1, 1, 1); u.armR.scale.set(1, 1, 1);
    body.position.y = Math.abs(Math.cos(u.runPhase)) * 0.05;
    body.rotation.x = Math.min(0.25, speed * 0.03);
  } else {
    u.armL.rotation.x *= 0.9; u.armR.rotation.x *= 0.9;
    body.position.y *= 0.8;
    body.rotation.x *= 0.8;
  }
}

export function setReadyPose(figure, crouch = 0) {
  const u = figure.userData;
  u.body.position.y = -crouch;
  u.body.rotation.x = crouch * 0.8;
  u.armL.rotation.set(-0.5 * crouch * 3, 0, 0.2);
  u.armR.rotation.set(-0.5 * crouch * 3, 0, -0.2);
}
