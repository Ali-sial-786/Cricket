import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3, DEG, makeRng } from '../src/physics/math.js';
import { mapRelease, playerDelivery } from '../src/game/bowlingInput.js';
import { PLAYER_BOWLERS, nextBowler, seamFromWrist } from '../src/game/bowlerTypes.js';
import { PhysicsWorld } from '../src/physics/world.js';

const rel = new Vec3(0.45, 2.0, -19.0);
const hand = (speed = 14, elevDeg = -8) => new Vec3(0, Math.sin(elevDeg * DEG), Math.cos(elevDeg * DEG)).scale(speed);
const fwd = new Vec3(0, 0, 1), back = new Vec3(0, 0, -1);
const cw = new Vec3(0, 0, 30), ccw = new Vec3(0, 0, -30), none = new Vec3();
const bowl = (type, opts = {}) => mapRelease({ releasePos: rel, handVel: hand(opts.speed), handAngVel: opts.w || none, palmDir: opts.palm || fwd, swingChoice: opts.seam || 0, assist: false, bowler: PLAYER_BOWLERS[type] });

test('the same arm speed gives each bowler their own pace', () => {
  const f = bowl('fast').paceKmh, m = bowl('medium').paceKmh, o = bowl('offspin').paceKmh, l = bowl('legspin').paceKmh;
  assert.ok(f > m && m > o && o >= l, `${f} ${m} ${o} ${l}`);
  for (const t of ['fast', 'medium', 'offspin', 'legspin']) {
    const [lo, hi] = PLAYER_BOWLERS[t].pace;
    assert.ok(bowl(t, { speed: 4 }).paceKmh >= lo - 1e-9 && bowl(t, { speed: 40 }).paceKmh <= hi + 1e-9, t);
  }
});

test('an off-spinner bowls the off-break, the doosra and the arm ball, never a leg-break', () => {
  assert.equal(bowl('offspin', { w: cw }).name, 'off-break');
  assert.equal(bowl('offspin', { w: cw }).spinType, 'off');
  const doosra = bowl('offspin', { w: cw, palm: back });
  assert.equal(doosra.name, 'doosra'); assert.equal(doosra.spinType, 'leg');
  const arm = bowl('offspin');
  assert.equal(arm.name, 'arm ball'); assert.equal(arm.spinType, 'none');
  const wrong = bowl('offspin', { w: ccw });
  assert.equal(wrong.name, 'arm ball'); assert.notEqual(wrong.spinType, 'leg'); assert.ok(wrong.note.length > 0);
});

test('a leg-spinner bowls the leg-break, the googly, the top-spinner and the slider, never an off-break or a doosra', () => {
  assert.equal(bowl('legspin', { w: ccw }).name, 'leg-break');
  assert.equal(bowl('legspin', { w: ccw }).spinType, 'leg');
  const googly = bowl('legspin', { w: ccw, palm: back });
  assert.equal(googly.name, 'googly'); assert.equal(googly.spinType, 'off');
  const top = bowl('legspin', { w: cw });
  assert.equal(top.name, 'top-spinner'); assert.equal(top.spinType, 'top'); assert.ok(top.note.length > 0);
  assert.equal(bowl('legspin').name, 'slider');
  for (const o of [{ w: cw }, { w: ccw }, { w: cw, palm: back }, { w: ccw, palm: back }, {}]) {
    const n = bowl('legspin', o).name;
    assert.ok(!/off-break|doosra|cutter|swinger/.test(n), n);
  }
});

test('seamers swing it with the seam position and cut it with the wrist; they never bowl spin', () => {
  const out = bowl('fast', { seam: 1 }), inn = bowl('fast', { seam: -1 }), up = bowl('fast');
  assert.equal(out.name, 'outswinger'); assert.ok(out.swing > 0);
  assert.equal(inn.name, 'inswinger'); assert.ok(inn.swing < 0);
  assert.equal(up.name, 'seam-up'); assert.equal(up.swing, 0);
  const offc = bowl('fast', { w: cw }), legc = bowl('fast', { w: ccw });
  assert.equal(offc.name, 'off-cutter'); assert.ok(offc.seamDeg < 0, 'seams in');
  assert.equal(legc.name, 'leg-cutter'); assert.ok(legc.seamDeg > 0, 'seams away');
  assert.equal(bowl('fast', { palm: back }).name, 'slower ball');
  assert.ok(bowl('fast', { palm: back }).paceKmh < up.paceKmh * 0.85);
  for (const o of [{ w: cw }, { w: ccw }, { w: cw, palm: back }, {}]) assert.ok(!/break|doosra|googly/.test(bowl('medium', o).name));
});

test('fast bowlers swing it more, medium-pacers seam it more', () => {
  assert.ok(Math.abs(bowl('fast', { seam: 1 }).swing) > Math.abs(bowl('medium', { seam: 1 }).swing));
  assert.ok(Math.abs(bowl('medium', { w: cw }).seamDeg) > Math.abs(bowl('fast', { w: cw }).seamDeg));
});

test('an outswinger really curves away from a right-hander, an inswinger in', () => {
  const xAtBatter = (seam) => {
    const d = playerDelivery({ releasePos: rel, handVel: hand(15), handAngVel: none, palmDir: fwd, swingChoice: seam, assist: false, bowler: PLAYER_BOWLERS.fast });
    const w = new PhysicsWorld();
    // Launch the same straight ball with and without the swing to isolate the curve.
    w.launch({ pos: d.releasePos, vel: d.vel, spin: d.spin, swing: d.swing, seamDeg: 0, seamRandomScale: 0 });
    const v0 = d.vel.clone();
    let x = 0;
    for (let t = 0; t < 1.2 && w.ball.bounces === 0; t += 1 / 240) { w.advanceTo(t); x = w.ball.pos.x; }
    const tFlight = w.time;
    return x - (d.releasePos.x + v0.x * tFlight);          // sideways movement in the air
  };
  assert.ok(xAtBatter(1) > 0.05, `outswing ${xAtBatter(1)}`);
  assert.ok(xAtBatter(-1) < -0.05, `inswing ${xAtBatter(-1)}`);
});

test('wrist turn sets the seam with a dead zone; the bowler list cycles', () => {
  assert.equal(seamFromWrist(0.1), 0);
  assert.ok(seamFromWrist(0.36) > 0.4 && seamFromWrist(0.36) < 0.6);
  assert.equal(seamFromWrist(1), 1);
  assert.equal(seamFromWrist(-1), -1);
  assert.equal(nextBowler('fast'), 'medium');
  assert.equal(nextBowler('legspin'), 'fast');
  assert.equal(nextBowler('fast', -1), 'legspin');
  void makeRng;
});

test('pace comes from the downswing speed, spread across the bowler\'s range', () => {
  const at = (paceSpeed, type = 'fast') => mapRelease({ releasePos: rel, handVel: hand(8), handAngVel: none, palmDir: fwd, assist: false, bowler: PLAYER_BOWLERS[type], paceSpeed }).paceKmh;
  const [lo, hi] = PLAYER_BOWLERS.fast.pace;
  assert.ok(Math.abs(at(3) - lo) < 1e-6 && Math.abs(at(20) - hi) < 1e-6);
  assert.ok(at(7) < at(10) && at(10) < at(13), `${at(7)} ${at(10)} ${at(13)}`);
  assert.ok(at(13, 'legspin') < 100 && at(13, 'legspin') > at(7, 'legspin'));
});

test('lengths are capped per bowler (no 15 m bouncers)', () => {
  const late = (type) => mapRelease({ releasePos: rel, handVel: hand(14, -60), handAngVel: none, palmDir: fwd, assist: false, bowler: PLAYER_BOWLERS[type] }).length;
  assert.equal(late('fast'), PLAYER_BOWLERS.fast.maxLength);
  assert.equal(late('offspin'), PLAYER_BOWLERS.offspin.maxLength);
});

test('a short ball from a quick bowler gets up; a good length arrives about bail height', async () => {
  const heightAtBatter = (elev, paceSpeed) => {
    const d = playerDelivery({ releasePos: new Vec3(0.45, 1.6, -19.0), handVel: hand(12, elev), handAngVel: none, palmDir: fwd, assist: false, bowler: PLAYER_BOWLERS.fast, paceSpeed });
    const w = new PhysicsWorld();
    w.launch({ pos: d.releasePos, vel: d.vel, spin: d.spin, swing: d.swing, seamDeg: 0, seamRandomScale: 0 });
    for (let t = 1 / 480; t < 2; t += 1 / 480) { w.advanceTo(t); if (w.ball.pos.z >= -1.22) return { y: w.ball.pos.y, len: d.length }; }
    return null;
  };
  const good = heightAtBatter(-8, 13), short = heightAtBatter(-33, 13);
  assert.ok(good.y > 0.45 && good.y < 0.95, `good length ${good.len.toFixed(1)} m -> ${good.y.toFixed(2)} m`);
  assert.ok(short.len > 9.5 && short.y > 1.2 && short.y < 2.1, `short ${short.len.toFixed(1)} m -> ${short.y.toFixed(2)} m`);
});

test('the seam angle that swings it away also nips it away off the pitch (more for a medium-pacer)', () => {
  const r = () => 0.5;
  const away = (type) => mapRelease({ releasePos: rel, handVel: hand(), handAngVel: none, palmDir: fwd, swingChoice: 1, assist: false, bowler: PLAYER_BOWLERS[type], rng: Object.assign(r, { gauss: () => 0 }) });
  assert.ok(away('fast').seamDeg > 0 && away('fast').swing > 0);
  assert.ok(away('medium').seamDeg > away('fast').seamDeg);
  assert.equal(away('medium').name, 'away-seamer');
  assert.equal(away('fast').name, 'outswinger');
});
