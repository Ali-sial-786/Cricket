import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3, DEG } from '../src/physics/math.js';
import { mapRelease, playerDelivery } from '../src/game/bowlingInput.js';
import { BallState } from '../src/physics/ball.js';
import { firstBounce } from '../src/physics/trajectory.js';
import { CONFIG } from '../src/config.js';

const rel = new Vec3(0.45, 2.0, -19.0);
const handAt = (speed, elevDeg, azDeg = 0) => new Vec3(
  Math.cos(elevDeg * DEG) * Math.sin(azDeg * DEG), Math.sin(elevDeg * DEG), Math.cos(elevDeg * DEG) * Math.cos(azDeg * DEG),
).scale(speed);

test('hand speed maps to pace with the multiplier and the cap', () => {
  const m = mapRelease({ releasePos: rel, handVel: handAt(12, -8), handAngVel: new Vec3() });
  assert.ok(Math.abs(m.paceKmh - 12 * CONFIG.bowling.paceMultiplier * 3.6) < 0.01);
  const fast = mapRelease({ releasePos: rel, handVel: handAt(40, -8), handAngVel: new Vec3() });
  assert.equal(fast.paceKmh, CONFIG.bowling.paceCapKmh);
});

test('neutral elevation gives the neutral length; higher release = fuller', () => {
  const n = mapRelease({ releasePos: rel, handVel: handAt(14, CONFIG.bowling.neutralElevationDeg), handAngVel: new Vec3(), assist: false });
  assert.ok(Math.abs(n.length - CONFIG.bowling.neutralLength) < 1e-6);
  const up = mapRelease({ releasePos: rel, handVel: handAt(14, CONFIG.bowling.neutralElevationDeg + 10), handAngVel: new Vec3(), assist: false });
  assert.ok(up.length < n.length);
});

test('azimuth to the right of straight moves the line to +X (off side of a RH batter)', () => {
  const a = mapRelease({ releasePos: rel, handVel: handAt(14, -8, 0), handAngVel: new Vec3(), assist: false });
  const b = mapRelease({ releasePos: rel, handVel: handAt(14, -8, 2), handAngVel: new Vec3(), assist: false });
  assert.ok(b.line > a.line + 0.1);
});

test('assist pulls the pitch point toward the aim marker', () => {
  const aim = { x: 0.1, z: -6 };
  const args = { releasePos: rel, handVel: handAt(14, 5, 3), handAngVel: new Vec3(), aim };
  const off = mapRelease({ ...args, assist: false });
  const on = mapRelease({ ...args, assist: true });
  const dOff = Math.hypot(off.target.x - aim.x, off.target.z - aim.z);
  const dOn = Math.hypot(on.target.x - aim.x, on.target.z - aim.z);
  assert.ok(dOn < dOff * 0.6, `assisted ${dOn} vs ${dOff}`);
});

test('wrist roll along the travel direction gives off-spin, the other way leg-spin', () => {
  const off = mapRelease({ releasePos: rel, handVel: handAt(9, -8), handAngVel: new Vec3(0, 0, 25), assist: false });
  const leg = mapRelease({ releasePos: rel, handVel: handAt(9, -8), handAngVel: new Vec3(0, 0, -25), assist: false });
  const none = mapRelease({ releasePos: rel, handVel: handAt(9, -8), handAngVel: new Vec3(0, 0, 1), assist: false, swingChoice: 1 });
  assert.equal(off.spinType, 'off');
  assert.equal(leg.spinType, 'leg');
  assert.equal(none.spinType, 'none');
  assert.ok(none.swing > 0);
  assert.equal(off.swing, 0);
});

test('player delivery pitches on the mapped target', () => {
  const d = playerDelivery({ releasePos: rel, handVel: handAt(14, -6, 1), handAngVel: new Vec3(), swingChoice: 1, aim: { x: 0.1, z: -6.5 }, assist: true });
  const b = new BallState();
  b.active = true;
  b.pos.copy(d.releasePos); b.vel.copy(d.vel); b.spin.copy(d.spin); b.swing = d.swing;
  const hit = firstBounce(b);
  assert.ok(Math.hypot(hit.pos.x - d.target.x, hit.pos.z - d.target.z) < 0.03);
});
