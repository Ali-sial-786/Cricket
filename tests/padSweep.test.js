import test from 'node:test';
import assert from 'node:assert/strict';
import { padHit } from '../src/game/lbwFlow.js';
import { Vec3 } from '../src/physics/math.js';

const ball = (x, y, z, vz = 42) => ({ active: true, batted: false, padded: false, thrown: false, pos: new Vec3(x, y, z), vel: new Vec3(0, 0, vz) });
const BOX = { halfX: 0.15, front: 0, back: 0.36, top: 0.7, dx: -0.07 };

test('a 150 km/h ball that jumps the pad box in one frame still hits the pad, put back where it met it', () => {
  const b = ball(-0.05, 0.4, 0.5);                    // a frame ago at z = -0.1 (in front), now 0.5 (past the 0.36-deep box)
  assert.equal(padHit(b, 0, 0, BOX), false);          // the old point test misses it
  assert.equal(padHit(b, 0, 0, BOX, { x: -0.05, y: 0.4, z: -0.1 }), true);
  assert.ok(b.pos.z > 0 && b.pos.z < 0.36, `put back in the box (z ${b.pos.z})`);
});

test('the box sits to the leg side of the head, under the legs', () => {
  assert.equal(padHit(ball(0.12, 0.4, 0.1), 0, 0, BOX), false);   // off side of the eyes: no leg drawn there
  assert.equal(padHit(ball(-0.2, 0.4, 0.1), 0, 0, BOX), true);    // under the legs
});

test('a ball passing wide of the box in one frame is no pad hit', () => {
  const b = ball(0.4, 0.4, 0.5);
  assert.equal(padHit(b, 0, 0, BOX, { x: 0.4, y: 0.4, z: -0.1 }), false);
  assert.equal(b.pos.z, 0.5);
});
