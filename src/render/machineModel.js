// The bowling machine's body: two stacked tyred wheels (the ball leaves from
// between them, toward +Z), guards, side plates, the drive motors, a hopper of
// balls feeding a chute into the back of the wheels, the head on a column over a
// splayed tripod, a control box with its cable to the ground, and the mast for
// the cue-light board. All merged into one vertex-coloured mesh (one draw).
import * as THREE from 'three';
import { part, merge } from './util.js';

const STEEL = 0x8c939b, DARK = 0x2a2d32, TYRE = 0x1b1c1e, HUB = 0xc9ced4, ORANGE = 0xe8701e, BLUE = 0x1f5f9e, RUBBER = 0x141414;

// outletY: the release height (the gap between the wheels), at the origin.
export function machineGeometry(outletY) {
  const P = [];
  const WR = 0.18, WY = 0.188, WZ = -0.03;                       // wheel radius, centre offsets
  for (const s of [1, -1]) {
    const y = outletY + s * WY;
    const tyre = new THREE.TorusGeometry(WR - 0.026, 0.026, 7, 22); tyre.rotateY(Math.PI / 2);
    P.push(part(tyre, TYRE, [0, y, WZ]));
    P.push(part(new THREE.CylinderGeometry(WR - 0.04, WR - 0.04, 0.05, 14), HUB, [0, y, WZ], [0, 0, Math.PI / 2]));
    P.push(part(new THREE.CylinderGeometry(0.03, 0.03, 0.07, 8), DARK, [0, y, WZ], [0, 0, Math.PI / 2]));
    // guard over the back of each wheel
    P.push(part(new THREE.CylinderGeometry(WR + 0.03, WR + 0.03, 0.085, 12, 1, true, Math.PI * 0.5, Math.PI * 1.05), ORANGE, [0, y, WZ], [0, 0, Math.PI / 2]));
    // motor on the right side of each axle
    P.push(part(new THREE.CylinderGeometry(0.06, 0.06, 0.14, 10), DARK, [0.14, y, WZ], [0, 0, Math.PI / 2]));
    P.push(part(new THREE.CylinderGeometry(0.062, 0.062, 0.02, 10), ORANGE, [0.09, y, WZ], [0, 0, Math.PI / 2]));
    P.push(part(new THREE.CylinderGeometry(0.035, 0.035, 0.02, 8), STEEL, [0.22, y, WZ], [0, 0, Math.PI / 2]));
  }
  // side plates holding both axles
  for (const x of [-0.065, 0.065]) P.push(part(new THREE.BoxGeometry(0.014, 0.72, 0.3), ORANGE, [x, outletY, WZ - 0.03]));
  // the head's base yoke and the column down to the tripod
  P.push(part(new THREE.BoxGeometry(0.16, 0.05, 0.24), DARK, [0, outletY - 0.39, WZ - 0.03]));
  const hubY = 0.62;
  P.push(part(new THREE.CylinderGeometry(0.03, 0.034, outletY - 0.41 - hubY, 8), STEEL, [0, (outletY - 0.41 + hubY) / 2, WZ - 0.02]));
  P.push(part(new THREE.CylinderGeometry(0.05, 0.05, 0.08, 8), DARK, [0, hubY, WZ - 0.02]));
  // tripod: three splayed legs, rubber feet
  for (let i = 0; i < 3; i++) {
    const a = Math.PI + (i / 3) * Math.PI * 2;
    const fx = Math.sin(a) * 0.6, fz = WZ - 0.02 + Math.cos(a) * 0.6;
    const top = new THREE.Vector3(0, hubY, WZ - 0.02), foot = new THREE.Vector3(fx, 0.03, fz);
    const len = top.distanceTo(foot), mid = top.clone().add(foot).multiplyScalar(0.5);
    const leg = new THREE.CylinderGeometry(0.018, 0.022, len, 6);
    leg.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), foot.clone().sub(top).normalize()));
    P.push(part(leg, STEEL, [mid.x, mid.y, mid.z]));
    P.push(part(new THREE.CylinderGeometry(0.04, 0.045, 0.03, 8), RUBBER, [fx, 0.015, fz]));
  }
  // hopper of balls behind and above the wheels, its chute into the gap
  const hop = [0, outletY + 0.52, -0.52];
  P.push(part(new THREE.CylinderGeometry(0.17, 0.07, 0.2, 12, 1, true), 0xd8dde2, hop));
  P.push(part(new THREE.TorusGeometry(0.17, 0.008, 4, 16), DARK, [hop[0], hop[1] + 0.1, hop[2]], [Math.PI / 2, 0, 0]));
  for (const [dx, dz, dy] of [[0.05, 0.02, 0.06], [-0.06, 0.04, 0.07], [0.0, -0.07, 0.065], [0.08, -0.05, 0.09], [-0.03, -0.02, 0.1]]) {
    P.push(part(new THREE.IcosahedronGeometry(0.036, 1), 0xf3efe4, [hop[0] + dx, hop[1] + dy - 0.03, hop[2] + dz]));
  }
  const chute = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, outletY + 0.44, -0.5), new THREE.Vector3(0, outletY + 0.27, -0.42),
    new THREE.Vector3(0, outletY + 0.09, -0.3), new THREE.Vector3(0, outletY + 0.01, -0.2)]);
  P.push(part(new THREE.TubeGeometry(chute, 10, 0.045, 7, false), 0xb7c0c8));
  // control box on the column (dial, switch) and its cable to the ground
  P.push(part(new THREE.BoxGeometry(0.16, 0.2, 0.1), BLUE, [-0.1, 1.2, WZ - 0.02]));
  P.push(part(new THREE.CylinderGeometry(0.028, 0.028, 0.02, 10), 0xeeeeee, [-0.1, 1.23, WZ + 0.04], [Math.PI / 2, 0, 0]));
  P.push(part(new THREE.BoxGeometry(0.03, 0.03, 0.02), 0xd43d2a, [-0.13, 1.14, WZ + 0.035]));
  const cable = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.1, 1.1, WZ - 0.06), new THREE.Vector3(-0.15, 0.7, -0.15), new THREE.Vector3(-0.3, 0.12, -0.4),
    new THREE.Vector3(-0.5, 0.01, -0.9), new THREE.Vector3(-0.4, 0.01, -1.6)]);
  P.push(part(new THREE.TubeGeometry(cable, 16, 0.008, 4, false), 0x161616));
  // the cue-light mast and the board's hoods (the board and lights are their own meshes)
  P.push(part(new THREE.CylinderGeometry(0.014, 0.014, 0.6, 6), STEEL, [0, outletY + 0.55, -0.39]));
  return merge(P);
}
