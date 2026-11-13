// Calibration + rig placement maths. Pure JS (physics math types).
//
// The XR reference space ("ref") is the raw local-floor space. The player rig
// maps ref -> world:  world = Ry(yaw) * ref + T.
//
// Bat calibration: the player stands in their stance holding the controller
// like a bat handle and presses a button. We define that moment as "bat
// hanging vertically, face toward the bowler", where "toward the bowler" is
// the horizontal direction the head is facing. The offset quaternion is
// stored in grip space, so it is independent of where the rig is.

import { Vec3, Quat } from '../physics/math.js';

const UP = new Vec3(0, 1, 0);

// Horizontal unit forward (-Z of the head) from a head quaternion.
export function headForward(headQuat) {
  const f = new Vec3(0, 0, -1).applyQuat(headQuat);
  f.y = 0;
  if (f.lengthSq() < 1e-8) f.set(0, 0, -1);
  return f.normalize();
}

// Yaw angle a such that Ry(a) maps (0,0,-1) onto horizontal forward f.
export function yawOfForward(f) { return Math.atan2(-f.x, -f.z); }

export function rotY(out, v, a) {
  const c = Math.cos(a), s = Math.sin(a);
  const x = v.x * c + v.z * s, z = -v.x * s + v.z * c;
  return out.set(x, v.y, z);
}

// Offset (grip-local) rotation so that the bat is vertical with its face
// toward `forwardRef` at the grip orientation `gripQuatRef`.
export function computeBatOffset(gripQuatRef, forwardRef, extraTiltRad = 0) {
  const f = forwardRef.clone(); f.y = 0; f.normalize();
  const x = new Vec3().crossVectors(UP, f).normalize(); // bat +X = Y × Z
  const batRef = new Quat().setFromBasis(x, UP, f);
  const off = new Quat().copy(gripQuatRef).conjugate().multiply(batRef);
  if (extraTiltRad) off.multiply(new Quat().setFromAxisAngle(new Vec3(1, 0, 0), extraTiltRad));
  return off.normalize();
}

// Default offset before calibration: assumes the controller is held like a
// bat handle with its top (thumb end, grip -Z) pointing up the handle and the
// palm of the right hand facing the hitting direction (grip -X).
export function defaultBatOffset() {
  return new Quat().setFromBasis(new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(-1, 0, 0));
}

// Rig transform that puts `anchorRef` (a ref-space point) at world (x, z) and
// turns the horizontal `forwardRef` to face `facing` (-1 = -Z toward the
// bowler from the batting end, +1 = +Z from the bowling end).
export function computeRig(anchorRef, forwardRef, targetX, targetZ, facing = -1) {
  const a = yawOfForward(forwardRef);
  const yaw = facing < 0 ? -a : Math.PI - a;
  const r = rotY(new Vec3(), anchorRef, yaw);
  return { x: targetX - r.x, z: targetZ - r.z, yaw: wrapAngle(yaw) };
}

// Rig transform that puts `anchorRef` at world (x, z) with the horizontal
// `forwardRef` turned to face the world direction (dirX, dirZ).
export function computeRigFacing(anchorRef, forwardRef, targetX, targetZ, dirX, dirZ) {
  const yaw = Math.atan2(-dirX, -dirZ) - yawOfForward(forwardRef);
  const r = rotY(new Vec3(), anchorRef, yaw);
  return { x: targetX - r.x, z: targetZ - r.z, yaw: wrapAngle(yaw) };
}

export function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// Apply rig to a ref-space point.
export function rigToWorld(out, rig, pRef) {
  rotY(out, pRef, rig.yaw);
  out.x += rig.x; out.z += rig.z;
  return out;
}
