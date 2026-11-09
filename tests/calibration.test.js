import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3, Quat } from '../src/physics/math.js';
import { computeBatOffset, computeRig, rigToWorld, headForward, defaultBatOffset } from '../src/game/calibration.js';

test('rig maps the anchor to the target and the head forward to -Z (batting) / +Z (bowling)', () => {
  const fwd = new Vec3(Math.sin(0.7), 0, Math.cos(0.7)).normalize(); // arbitrary facing
  const anchor = new Vec3(1.2, 0.9, -0.4);
  for (const facing of [-1, 1]) {
    const rig = computeRig(anchor, fwd, -0.05, -1.1, facing);
    const w = rigToWorld(new Vec3(), rig, anchor);
    assert.ok(Math.abs(w.x + 0.05) < 1e-9 && Math.abs(w.z + 1.1) < 1e-9);
    const tip = rigToWorld(new Vec3(), rig, anchor.clone().add(fwd));
    const dir = tip.sub(w);
    assert.ok(Math.abs(dir.x) < 1e-9 && Math.abs(dir.z - facing) < 1e-9, `dir ${dir.x},${dir.z}`);
  }
});

test('bat offset makes the calibrated pose vertical with the face toward the bowler', () => {
  const grip = new Quat().setFromAxisAngle(new Vec3(0.3, 0.8, -0.2).normalize(), 1.9);
  const fwd = new Vec3(0.2, 0, -1).normalize();
  const off = computeBatOffset(grip, fwd);
  const bat = new Quat().multiplyQuats(grip, off);
  const y = new Vec3(0, 1, 0).applyQuat(bat);
  const z = new Vec3(0, 0, 1).applyQuat(bat);
  assert.ok(y.distanceTo(new Vec3(0, 1, 0)) < 1e-9);
  assert.ok(z.distanceTo(fwd) < 1e-9);
});

test('head forward ignores pitch', () => {
  const q = new Quat().setFromAxisAngle(new Vec3(1, 0, 0), -0.6); // looking down
  const f = headForward(q);
  assert.ok(f.distanceTo(new Vec3(0, 0, -1)) < 1e-9);
});

test('default offset is a proper rotation', () => {
  const q = defaultBatOffset();
  assert.ok(Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) < 1e-9);
  // bat +Y should be grip -Z
  const y = new Vec3(0, 1, 0).applyQuat(q);
  assert.ok(y.distanceTo(new Vec3(0, 0, -1)) < 1e-9);
});
