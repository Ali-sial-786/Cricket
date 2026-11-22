// The wicket huddle (Fielding.celebrateWicket): with the ball dead the men
// near the wicket-taker jog in and stand round him, the deep fielders come in
// part of the way, and everyone is back on his mark and set in time for the
// next ball; nothing of it happens while the ball is live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng } from '../src/physics/math.js';
import { Fielding } from '../src/game/fielding.js';

const TAU = Math.PI * 2;
const ang = (a, b) => { let d = b - a; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; };

function field(seed = 7) {
  const f = new Fielding({ rng: makeRng(seed) });
  f.reset(); f.started = true;
  f.ballDead();
  return f;
}

test('a wicket with the ball dead: the near men jog to the bowler and stand round him, the deep ones come part of the way, then all are back and set within the time the next ball waits anyway (+1 s)', () => {
  const f = field();
  const focus = { x: 1.0, z: -12.5 };
  const start = f.fielders.map((p) => ({ x: p.pos.x, z: p.pos.z }));
  const n = f.celebrateWicket(100, focus, -1, undefined, 11.5);
  assert.ok(n >= 3, `${n} men in the huddle`);
  const dt = 1 / 60, closest = f.fielders.map(() => Infinity);
  let settledAt = null;
  for (let k = 0; k < 60 * 20; k++) {
    const t = 100 + k * dt;
    f.update(dt, t, null, null);
    f.fielders.forEach((p, i) => { closest[i] = Math.min(closest[i], Math.hypot(p.pos.x - focus.x, p.pos.z - focus.z)); });
    if (settledAt == null && k > 60 && f.settled()) settledAt = k * dt;
  }
  const inner = f.fielders.filter((p) => p.huddleInner !== undefined);
  const ring = f.fielders.filter((p, i) => !p.bowler && closest[i] < 2.0);
  assert.ok(ring.length >= 3, `${ring.length} men got round him`);
  // the deep men came in, but not all the way
  f.fielders.forEach((p, i) => {
    if (p.bowler || closest[i] < 2.0) return;
    const d0 = Math.hypot(start[i].x - focus.x, start[i].z - focus.z);
    assert.ok(closest[i] < d0 - 1, `${p.name} came in (${d0.toFixed(1)} -> ${closest[i].toFixed(1)} m)`);
  });
  void inner;
  assert.ok(settledAt != null && settledAt < 11.5 + 1, `everyone back and set after ${settledAt} s`);
  for (const p of f.fielders) if (!p.bowler) assert.ok(Math.abs(ang(p.yaw, f.restFace(p))) < 0.12, `${p.name} faces the batter again`);
});

test('the huddle round the man who took the catch: he stays where he is, the others come to him', () => {
  const f = field(3);
  const c = f.fielders.findIndex((p) => p.name === 'mid-off');
  const at = { x: f.fielders[c].pos.x, z: f.fielders[c].pos.z };
  f.celebrateWicket(50, f.fielders[c].pos, c, undefined, 12);
  let moved = 0;
  for (let k = 0; k < 60 * 4; k++) { f.update(1 / 60, 50 + k / 60, null, null); moved = Math.max(moved, Math.hypot(f.fielders[c].pos.x - at.x, f.fielders[c].pos.z - at.z)); }
  assert.ok(moved < 0.5, `the catcher wandered ${moved.toFixed(2)} m`);
  const near = f.fielders.filter((p, i) => i !== c && Math.hypot(p.pos.x - at.x, p.pos.z - at.z) < 4).length;
  assert.ok(near >= 1, 'someone has reached him');
});

test('nothing of the huddle while the ball is live', () => {
  const f = field(5);
  f.walkIn(); f.onRelease();                 // the next ball is on its way
  const before = f.fielders.map((p) => p.state);
  assert.equal(f.celebrateWicket(10, { x: 0, z: -15 }), 0);
  assert.deepEqual(f.fielders.map((p) => p.state), before);
  assert.ok(!f.fielders.some((p) => p.state === 'huddle'));
});

test('the next ball breaks a huddle up: everyone heads for his mark', () => {
  const f = field(9);
  f.celebrateWicket(10, { x: 0.5, z: -16 });
  for (let k = 0; k < 60; k++) f.update(1 / 60, 10 + k / 60, null, null);
  f.newBall();
  assert.ok(!f.fielders.some((p) => p.state === 'huddle'));
  assert.ok(f.fielders.every((p) => p.huddleUntil == null));
});
