// A six carries over the advertising boards and comes down where its flight
// meets the stand (src/physics/stands.js: the bowl's surface, analytic): in the
// crowd it is gone (no bounce back onto the field) with a 'stand' event; one
// that drops short of the stand bounces on the grass behind the boards and
// comes back off the stand's front wall; a ball along the ground (or landing
// just over the rope) meets the boards as it always has.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from '../src/physics/math.js';
import { PhysicsWorld } from '../src/physics/world.js';
import { groundDistance } from '../src/physics/pitch.js';
import { CONFIG } from '../src/config.js';
import { STAND, standHeightAt, roofUnderAt, roofedAt, bearing } from '../src/physics/stands.js';
import { SUN_BLOCKERS, BOWL, ROOF } from '../src/render/stadium.js';

const F = CONFIG.field, R = CONFIG.ball.radius;
const BOARDS = F.boundaryRadius + F.boardsOffset;

// speed (m/s), elevation and bearing (deg; 0 straight back past the bowler, + the off side)
function hit(speed, el, az, secs = 10) {
  const w = new PhysicsWorld(undefined, 5);
  const E = el * Math.PI / 180, A = az * Math.PI / 180;
  w.launch({ pos: new Vec3(-0.2, 0.9, -1.6), vel: new Vec3(Math.sin(A) * Math.cos(E) * speed, Math.sin(E) * speed, -Math.cos(A) * Math.cos(E) * speed) });
  w.ball.batted = true; w.ball.bouncesSinceBat = 0;
  const out = { stand: null, boundary: null, maxR: 0, minRAfter: Infinity, w };
  for (let t = 1 / 72; t < secs && w.ball.active; t += 1 / 72) {
    w.advanceTo(t);
    for (const e of w.drainEvents()) { if (e.type === 'stand') out.stand = e; if (e.type === 'boundary') out.boundary = e; }
    const g = groundDistance(w.ball.pos.x, w.ball.pos.z);
    out.maxR = Math.max(out.maxR, g);
    if (out.maxR > BOARDS + 1) out.minRAfter = Math.min(out.minRAfter, g);
  }
  return out;
}

test('the stands the ball meets are the stands that are built (stands.js against stadium.js)', () => {
  assert.equal(STAND.wallR, BOWL.wallR); assert.equal(STAND.wallTop, BOWL.wallTop); assert.equal(STAND.outerR, BOWL.outerR);
  assert.deepEqual(STAND.roof, ROOF);
  for (let a = 0.1; a < 360; a += 0.37) {
    assert.equal(roofedAt(a), SUN_BLOCKERS.roofed(a), `roof at ${a}`);
    for (let r = 60; r < 115; r += 0.29) assert.equal(standHeightAt(r, a), SUN_BLOCKERS.top(a, r), `stand at ${a} deg, ${r} m`);
  }
});

test('a six carries over the boards and comes down in the stand: gone into the crowd, never back onto the field', () => {
  const s = hit(41, 35, 60);
  assert.ok(s.boundary && s.boundary.onFull, 'a six');
  assert.ok(s.stand, 'it came down in the stand');
  const p = s.stand.pos, r = groundDistance(p.x, p.z), h = standHeightAt(r, bearing(p.x, p.z - (-10.06)));
  assert.ok(r > STAND.wallR, `in the stand (r ${r.toFixed(1)})`);
  assert.ok(Math.abs(p.y - R - h) < 0.6, `on the seats (y ${p.y.toFixed(2)}, the tier ${h})`);
  assert.equal(s.w.ball.active, false, 'gone');
  assert.ok(s.minRAfter > BOARDS, 'never back inside the boards');
  assert.equal(s.stand.onFull, true);
});

test('a big six reaches the upper tier, a bigger one the roof', () => {
  const up = hit(44, 38, 160), roof = hit(48, 42, -100);
  const ru = groundDistance(up.stand.pos.x, up.stand.pos.z);
  assert.ok(ru > STAND.up.r0 && up.stand.pos.y > STAND.up.y0, `upper tier (r ${ru.toFixed(1)}, y ${up.stand.pos.y.toFixed(1)})`);
  assert.equal(roof.stand.roof, true, 'onto the roof');
  const rr = groundDistance(roof.stand.pos.x, roof.stand.pos.z);
  assert.ok(roofUnderAt(rr, bearing(roof.stand.pos.x, roof.stand.pos.z + 10.06)) > 0);
});

test('a flat six that drops short of the stand bounces on the grass and comes back off its front wall', () => {
  const s = hit(36, 45, 90);
  assert.ok(s.boundary && s.boundary.onFull, 'a six');
  assert.equal(s.stand, null, 'not into the crowd');
  assert.ok(s.maxR < STAND.wallR, `stopped by the wall (max r ${s.maxR.toFixed(2)})`);
  assert.ok(s.minRAfter > BOARDS, 'stays behind the boards');
});

test('a four along the ground, and a ball landing just over the rope, meet the boards as before', () => {
  // (along the ground; bounced in front of the rope; six on the full, landing 1.4 m / 2.6 m past the rope)
  for (const [sp, el, az, six] of [[34, 0, 30, false], [30, 3, -70, false], [28, 18, 10, false], [34.4, 30, 0, true], [34.8, 30, 0, true]]) {
    const s = hit(sp, el, az);
    assert.ok(s.boundary, `${sp} ${el} ${az}: over the rope`);
    assert.equal(s.boundary.onFull, six, `${sp} ${el} ${az}: ${six ? 'six' : 'four'}`);
    assert.equal(s.stand, null);
    assert.ok(s.maxR <= BOARDS - R + 1e-9, `${sp} ${el} ${az}: stopped at the boards (max r ${s.maxR.toFixed(3)})`);
  }
});
