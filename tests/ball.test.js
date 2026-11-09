import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from '../src/physics/math.js';
import { BallState, aeroParams, integrateFlight } from '../src/physics/ball.js';
import { predict, crossingAtZ } from '../src/physics/trajectory.js';
import { CONFIG } from '../src/config.js';
import { cfgWith, kmh } from './helpers.js';

function flyUntil(ball, P, cond, maxT = 5) {
  const h = 1 / CONFIG.physics.substepHz;
  let t = 0;
  while (t < maxT && !cond(ball, t)) { integrateFlight(ball, h, P, null); t += h; }
  return t;
}

test('free fall without drag matches analytic gravity', () => {
  const cfg = cfgWith({ ball: { dragCoeff: 0 } });
  const P = aeroParams(cfg);
  const b = new BallState();
  b.active = true;
  b.pos.set(0, 10, 0);
  const t = flyUntil(b, P, (_, t) => t >= 0.5 - 1e-9);
  const expected = 10 - 0.5 * 9.81 * t * t;
  assert.ok(Math.abs(b.pos.y - expected) < 1e-3, `y=${b.pos.y} expected ${expected}`);
});

test('drag costs a 140 km/h delivery a plausible amount of speed before the batter', () => {
  const b = new BallState();
  b.active = true;
  b.pos.set(0, 2.2, -18.75);
  b.vel.set(0, 0.5, kmh(140));
  const P = aeroParams(CONFIG);
  flyUntil(b, P, (ball) => ball.pos.z >= -1);
  const loss = 1 - b.vel.length() / kmh(140);
  assert.ok(loss > 0.04 && loss < 0.16, `speed loss ${(loss * 100).toFixed(1)}%`);
});

test('outswing (+) moves the ball toward +X (off side for a RH batter), inswing toward -X', () => {
  const base = new BallState();
  base.active = true;
  base.pos.set(0, 2.2, -18.75);
  base.vel.set(0, 1.5, kmh(135));
  const plain = crossingAtZ(predict(base, { maxTime: 2 }), -1.2);
  const out = base.clone(); out.swing = 1;
  const inn = base.clone(); inn.swing = -1;
  const pOut = crossingAtZ(predict(out, { maxTime: 2, stop: (b) => b.bounces > 0 }), -1.2) ||
    crossingAtZ(predict(out, { maxTime: 2 }), -1.2);
  const dOut = crossingAtZ(predict(out, { maxTime: 2 }), -1.2).x - plain.x;
  const dIn = crossingAtZ(predict(inn, { maxTime: 2 }), -1.2).x - plain.x;
  assert.ok(pOut);
  assert.ok(dOut > 0.15 && dOut < 1.0, `outswing deviation ${dOut}`);
  assert.ok(dIn < -0.15 && dIn > -1.0, `inswing deviation ${dIn}`);
});

test('topspin dips (lands shorter), backspin holds up (lands longer)', () => {
  const mk = (wx) => {
    const b = new BallState();
    b.active = true;
    b.pos.set(0, 2.0, -18.5);
    b.vel.set(0, 2.0, kmh(85));
    b.spin.set(wx, 0, 0); // +x = topspin for travel along +z
    const pr = predict(b, { maxTime: 3, stop: (ball) => ball.bounces > 0 });
    return pr.bounces[0].pos.z;
  };
  const none = mk(0), top = mk(150), back = mk(-150);
  assert.ok(top < none - 0.1, `topspin bounce z ${top} vs ${none}`);
  assert.ok(back > none + 0.1, `backspin bounce z ${back} vs ${none}`);
});

test('pure sidespin (axis along velocity) produces no Magnus drift', () => {
  const cfg = cfgWith({ physics: { gravity: 0 } });
  const b = new BallState();
  b.active = true;
  b.pos.set(0, 1.0, -18.5);
  b.vel.set(0, 0, kmh(85));
  b.spin.set(0, 0, 180);
  const c = crossingAtZ(predict(b, { cfg, maxTime: 3 }), -1);
  assert.ok(Math.abs(c.x) < 1e-6 && Math.abs(c.y - 1.0) < 1e-6, `drift ${c.x}, ${c.y}`);
});
