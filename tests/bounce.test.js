import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3, makeRng } from '../src/physics/math.js';
import { BallState, aeroParams, applyBounce, integrateFlight } from '../src/physics/ball.js';
import { predict, crossingAtZ } from '../src/physics/trajectory.js';
import { machineDelivery } from '../src/physics/bowlingMachine.js';
import { CONFIG } from '../src/config.js';
import { cfgWith, kmh } from './helpers.js';

function launchState(d) {
  const b = new BallState();
  b.active = true;
  b.pos.copy(d.releasePos);
  b.vel.copy(d.vel);
  b.spin.copy(d.spin);
  b.swing = d.swing;
  b.seamDeg = d.seamDeg;
  return b;
}

test('vertical drop rebounds to e^2 of the drop height (no drag)', () => {
  const cfg = cfgWith({ ball: { dragCoeff: 0 } });
  const P = aeroParams(cfg);
  const b = new BallState();
  b.active = true;
  b.pos.set(0, 1.0 + cfg.ball.radius, -10);
  const h = 1 / cfg.physics.substepHz;
  let bounced = false, apex = 0;
  for (let i = 0; i < 4000; i++) {
    integrateFlight(b, h, P, null, () => { bounced = true; });
    if (bounced) apex = Math.max(apex, b.pos.y - cfg.ball.radius);
    if (bounced && b.vel.y < 0 && b.pos.y < apex) break;
  }
  const e = cfg.surfaces.pitch.restitution;
  assert.ok(Math.abs(apex - e * e) < 0.01, `apex ${apex} expected ${e * e}`);
});

test('bounce never adds energy (translational + rotational), random impacts', () => {
  const P = aeroParams(CONFIG);
  const rng = makeRng(7);
  const m = CONFIG.ball.mass, R = CONFIG.ball.radius, I = CONFIG.ball.inertiaFactor * m * R * R;
  for (let i = 0; i < 500; i++) {
    const b = new BallState();
    b.active = true;
    b.vel.set(rng.range(-3, 3), -rng.range(0.5, 12), rng.range(5, 42));
    b.spin.set(rng.range(-250, 250), rng.range(-80, 80), rng.range(-250, 250));
    const ke0 = 0.5 * m * b.vel.lengthSq() + 0.5 * I * b.spin.lengthSq();
    applyBounce(b, rng() < 0.5 ? 'pitch' : 'outfield', P, null);
    const ke1 = 0.5 * m * b.vel.lengthSq() + 0.5 * I * b.spin.lengthSq();
    assert.ok(ke1 <= ke0 * (1 + 1e-9), `energy grew ${ke0} -> ${ke1}`);
  }
});

test('good-length 140 km/h delivery pitches 6–8 m from the batter’s stumps and bounces sensibly', () => {
  const d = machineDelivery({ paceKmh: 140, length: 7.0, line: 0.0, swing: 0, seam: 0, spinType: 'none' });
  const pr = predict(launchState(d), { maxTime: 2, wicket: true });
  const b0 = pr.bounces[0];
  const dist = 0 - b0.pos.z;
  assert.ok(dist >= 6 && dist <= 8, `pitched ${dist.toFixed(2)} m from stumps`);
  // Speed retained through the bounce: fast balls lose roughly 5–20%.
  const ratio = b0.speedOut / b0.speedIn;
  assert.ok(ratio > 0.78 && ratio < 0.97, `bounce speed ratio ${ratio}`);
  // Height arriving at the batter (popping crease) and at the stumps.
  const atBatter = crossingAtZ(pr, -1.22);
  const atStumps = crossingAtZ(pr, -0.05);
  assert.ok(atBatter.y > 0.35 && atBatter.y < 1.2, `height at batter ${atBatter.y}`);
  assert.ok(atStumps.y > 0.35 && atStumps.y < 1.3, `height at stumps ${atStumps.y}`);
  // Rises after the bounce.
  assert.ok(b0.speedOut > 0 && atBatter.vy > -3, 'ball should still be rising or near apex');
});

test('bouncer gets up above chest height; yorker pitches at the crease', () => {
  const bouncer = machineDelivery({ paceKmh: 145, length: 12.5, line: 0.0 });
  const pb = predict(launchState(bouncer), { maxTime: 2 });
  const hb = crossingAtZ(pb, -1.0).y;
  assert.ok(hb > 1.35, `bouncer height ${hb}`);
  const yorker = machineDelivery({ paceKmh: 140, length: 0.6, line: 0.0 });
  const py = predict(launchState(yorker), { maxTime: 2 });
  const len = -py.bounces[0].pos.z;
  assert.ok(len < 1.5 && len > -0.2, `yorker length ${len}`);
});

test('off-spin turns toward -X (into a RH batter), leg-spin toward +X; magnitude realistic', () => {
  const run = (spinType) => {
    const d = machineDelivery({ paceKmh: 85, length: 5.0, line: 0.0, spinType, spinAmount: 0.85 });
    const pr = predict(launchState(d), { maxTime: 3 });
    return pr.bounces[0].deviationDeg;
  };
  const off = run('off'), leg = run('leg'), none = run('none');
  assert.ok(off < -1.0 && off > -12, `off-spin turn ${off}°`);
  assert.ok(leg > 1.0 && leg < 12, `leg-spin turn ${leg}°`);
  assert.ok(Math.abs(none) < 0.6, `seamer (no seam) deviation ${none}°`);
});

test('seam setting deflects the ball by the configured angle', () => {
  const d = machineDelivery({ paceKmh: 135, length: 6.5, line: 0.0, seam: 1 });
  const pr = predict(launchState(d), { maxTime: 2 });
  const dev = pr.bounces[0].deviationDeg;
  assert.ok(Math.abs(dev - CONFIG.surfaces.seamMaxDeg) < 0.6, `seam deviation ${dev}`);
  const d2 = machineDelivery({ paceKmh: 135, length: 6.5, line: 0.0, seam: -1 });
  const dev2 = predict(launchState(d2), { maxTime: 2 }).bounces[0].deviationDeg;
  assert.ok(dev2 < -CONFIG.surfaces.seamMaxDeg + 0.6, `seam deviation ${dev2}`);
});

test('ball eventually rolls and stops on the outfield', () => {
  const b = new BallState();
  b.active = true;
  b.pos.set(0, 0.5, -30);
  b.vel.set(4, 2, -15);
  const pr = predict(b, { maxTime: 30 });
  assert.equal(pr.end, 'stopped');
  assert.ok(pr.final.vel.length() === 0);
});
