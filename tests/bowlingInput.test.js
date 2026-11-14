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
  assert.equal(off.name, 'off-break');
  assert.equal(leg.spinType, 'leg');
  assert.equal(leg.name, 'leg-break');
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

test('back of the hand turns an off-spin action into a doosra and a leg-spin action into a googly', () => {
  const back = new Vec3(0, 0, -1), front = new Vec3(0, 0, 1);
  const doosra = mapRelease({ releasePos: rel, handVel: handAt(9, -8), handAngVel: new Vec3(0, 0, 25), palmDir: back, assist: false });
  assert.equal(doosra.name, 'doosra');
  assert.equal(doosra.spinType, 'leg');          // turns away from the right-hander
  const googly = mapRelease({ releasePos: rel, handVel: handAt(9, -8), handAngVel: new Vec3(0, 0, -25), palmDir: back, assist: false });
  assert.equal(googly.name, 'googly');
  assert.equal(googly.spinType, 'off');          // turns in
  const offb = mapRelease({ releasePos: rel, handVel: handAt(9, -8), handAngVel: new Vec3(0, 0, 25), palmDir: front, assist: false });
  assert.equal(offb.name, 'off-break');
});

test('the same wrist action at pace is a cutter', () => {
  const c = mapRelease({ releasePos: rel, handVel: handAt(15, -8), handAngVel: new Vec3(0, 0, 25), assist: false });
  assert.equal(c.name, 'off-cutter');
  assert.ok(c.seamDeg < 0);
});

test('letting go very early gives a full toss that reaches the batter on the full; late gives a bouncer', () => {
  const early = playerDelivery({ releasePos: rel, handVel: handAt(14, CONFIG.bowling.neutralElevationDeg + 55), handAngVel: new Vec3(), assist: false });
  assert.ok(early.fullToss, 'full toss expected');
  assert.ok(early.name.includes('full toss'));
  const b = new BallState();
  b.active = true; b.pos.copy(early.releasePos); b.vel.copy(early.vel); b.spin.copy(early.spin);
  const hit = firstBounce(b);
  assert.ok(hit.pos.z > early.fullToss.z, `bounced at ${hit.pos.z}, before the batter`);
  const late = mapRelease({ releasePos: rel, handVel: handAt(14, CONFIG.bowling.neutralElevationDeg - 40), handAngVel: new Vec3(), assist: false });
  assert.ok(late.length > 11 && late.name.includes('bouncer'), late.name);
});

// ---- pace floor (Quest recording: HUD read "27 km/h" for a 127 km/h ball; no path may really go that slow)
import { paceFloorKmh } from '../src/game/bowlingInput.js';
import { playerBowler } from '../src/game/bowlerTypes.js';

test('pace floor: no delivery from any bowler, choice, run-up state or release leaves the hand slower than the floor', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  rnd.gauss = () => rnd() - 0.5;
  for (const key of ['fast', 'medium', 'offspin', 'legspin']) {
    const b = playerBowler(key), floor = paceFloorKmh(b);
    assert.ok(floor > 30 && floor < b.pace[0]);
    const choices = [null, ...b.deliveryList.map((d) => d.key)];
    for (let i = 0; i < 160; i++) {
      // Hand speeds down to the drop threshold (a hand barely moving by the head),
      // every direction (very early = full toss through solveThrough), every run-up
      // factor from a standstill / pulled-out-and-resumed (stand) to a full run.
      const sp = [3, 3.5, 5, 9, 16][i % 5];
      const el = (rnd() * 160 - 80) * DEG, az = (rnd() * 120 - 60) * DEG;
      const hv = new Vec3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).scale(sp);
      const d = playerDelivery({
        releasePos: new Vec3(rnd() - 0.4, 1.3 + rnd() * 0.8, -19.4 + rnd()), handVel: hv, handAngVel: new Vec3(rnd() * 40 - 20, 0, rnd() * 40 - 20),
        palmDir: new Vec3(0, 0, i % 4 ? 1 : -1), swingChoice: -1, bowler: b, choice: choices[i % choices.length],
        paceScale: [CONFIG.bowling.runUp[key].stand, 0.93, 1][i % 3], aim: i % 2 ? { x: rnd() * 2 - 1, z: -13 + rnd() * 12.7 } : null, assist: !!(i % 2), rng: rnd,
        paceSpeed: i % 7 ? null : 1,
      });
      const launch = d.vel.length() * 3.6;
      assert.ok(launch >= floor - 0.01, `${key} ${d.name}: ${launch.toFixed(1)} < ${floor}`);
      assert.ok(Math.abs(launch - d.paceKmh) < 0.05, 'paceKmh is the real launch speed');
    }
  }
});

test('pace floor: a fast bowler\'s slowest possible ball is nowhere near 27 or 30 km/h', () => {
  const b = playerBowler('fast');
  const d = playerDelivery({ releasePos: new Vec3(0.3, 1.7, -19), handVel: handAt(3, 40), handAngVel: new Vec3(), palmDir: new Vec3(0, 0, -1), bowler: b, choice: 'slower', paceScale: 0.5, assist: false });
  assert.ok(d.paceKmh >= paceFloorKmh(b) && d.paceKmh > 70, `${d.paceKmh}`);
  assert.ok(d.fullToss, 'a very early release is a full toss (solveThrough path)');
});

test('pace floor: bad inputs (NaN run-up factor) still give a real pace', () => {
  const b = playerBowler('medium');
  const d = playerDelivery({ releasePos: rel, handVel: handAt(10, -8), handAngVel: new Vec3(), bowler: b, choice: 'stock', paceScale: NaN });
  assert.ok(Number.isFinite(d.paceKmh) && d.paceKmh >= paceFloorKmh(b));
});
