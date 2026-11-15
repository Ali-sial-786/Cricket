// The sweep's outcome (src/game/sweepShot.js): the ball as your bat played
// it - same speed, its own side - helped halfway into a sweeper's arc; a
// slog sweep goes up, a sweep stays down; edges are left alone; no dice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweepShot, SWEEP } from '../src/game/sweepShot.js';
import { Vec3 } from '../src/physics/math.js';
import { CONFIG } from '../src/config.js';

const FACE = { isEdge: false, face: 'front' };
const az = (v) => Math.atan2(v.x, -v.z) * 180 / Math.PI, el = (v) => Math.atan2(v.y, Math.hypot(v.x, v.z)) * 180 / Math.PI;
const dir = (azDeg, elDeg, sp) => { const a = azDeg / 57.2958, e = elDeg / 57.2958; return new Vec3(Math.sin(a) * Math.cos(e) * sp, Math.sin(e) * sp, -Math.cos(a) * Math.cos(e) * sp); };

test('a sweep keeps the speed your bat gave it, stays down, and is helped halfway into the arc square on the leg side', () => {
  const v = dir(-30, 25, 22);                       // off the bat: fine of mid-wicket, in the air
  assert.equal(sweepShot(v, FACE, {}), 'sweep');
  assert.ok(Math.abs(v.length() - 22) < 1e-9, 'speed unchanged');
  assert.ok(el(v) <= SWEEP.flat * 57.3 + 1e-6, `kept down (${el(v).toFixed(1)} deg)`);
  assert.ok(Math.abs(az(v) - (-30 + (-SWEEP.arc[0] * 57.29578 + 30) * SWEEP.help)) < 1e-3, `bearing ${az(v).toFixed(1)}`);
  // already square: left where it is
  const w = dir(-100, 5, 15); sweepShot(w, FACE, {}); assert.ok(Math.abs(az(w) + 100) < 1e-4, `${az(w)}`);
});

test('the reverse sweep: the off side, from where the ball went, or (straight) from the way the bat swept', () => {
  const v = dir(70, 5, 18);
  assert.equal(sweepShot(v, FACE, { reverse: false }), 'reverse sweep');
  assert.ok(az(v) > 50 && az(v) < 150);
  const s = dir(5, 5, 18);
  assert.equal(sweepShot(s, FACE, { reverse: true }), 'reverse sweep');
  assert.ok(az(s) > 0);
  const l = dir(5, 5, 18);
  assert.equal(sweepShot(l, FACE, { reverse: false }), 'sweep');
  assert.ok(az(l) < 0);
});

test('the slog sweep goes up in front of square; edges and the back of the bat are left alone; the same every time', () => {
  const v = dir(-120, 5, 25);
  assert.equal(sweepShot(v, FACE, { slog: true }), 'slog sweep');
  const L = CONFIG.bat.sweepLift.map((x) => x * 57.2958);
  assert.ok(el(v) > 5 && el(v) <= L[1] + 1e-6, `lifted to ${el(v).toFixed(1)} deg`);
  assert.ok(az(v) > -120 && az(v) < -60, `toward in front of square (${az(v).toFixed(0)})`);
  for (const ev of [{ isEdge: true, face: 'front' }, { isEdge: false, face: 'back' }, null]) {
    const e = dir(-20, 10, 20), before = e.clone();
    assert.equal(sweepShot(e, ev, {}), null);
    assert.ok(e.x === before.x && e.y === before.y && e.z === before.z);
  }
  const a = dir(-40, 12, 20), b = dir(-40, 12, 20);
  sweepShot(a, FACE, { slog: true }); sweepShot(b, FACE, { slog: true });
  assert.ok(a.x === b.x && a.y === b.y && a.z === b.z, 'deterministic');
});
