import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3, makeRng } from '../src/physics/math.js';
import { PhysicsWorld } from '../src/physics/world.js';
import { predict } from '../src/physics/trajectory.js';
import { Fielding, FIELD } from '../src/game/fielding.js';

// Launch a "hit" ball from the batter toward (dirX, dirZ) and play it out.
function play({ toward, speed, elev, catchSkill = 1, seed = 5 }) {
  const world = new PhysicsWorld();
  const from = new Vec3(0, 0.8, -1.6);
  const d = new Vec3(toward.x - from.x, 0, toward.z - from.z).normalize();
  const vel = new Vec3(d.x * Math.cos(elev), Math.sin(elev), d.z * Math.cos(elev)).scale(speed);
  world.launch({ pos: from, vel });
  world.ball.batted = true;
  world.ball.bouncesSinceBat = 0;
  const f = new Fielding({ rng: makeRng(seed), catchSkill });
  f.onHit(world.ball, 0, predict(world.ball, { maxTime: 10 }));
  for (let t = 1 / 60; t < 14 && !f.outcome; t += 1 / 60) {
    world.advanceTo(t);
    for (const e of world.drainEvents()) if (e.type === 'boundary') f.onBoundary(e);
    f.update(1 / 60, t, world.ball.active ? world.ball : null, world);
  }
  return { f, outcome: f.outcome };
}

test('a lofted drive straight at cover is caught by a sure-handed fielder', () => {
  const cover = FIELD.find((x) => x.name === 'cover');
  const { outcome } = play({ toward: cover, speed: 17, elev: 0.42 });
  assert.equal(outcome && outcome.kind, 'caught');
  assert.equal(outcome.by, 'Cover');
});

test('a big hit over long-on is a six; a hard ground shot into the gap reaches the rope for four', () => {
  const six = play({ toward: { x: -2, z: -70 }, speed: 40, elev: 0.6 }).outcome;
  assert.deepEqual(six, { kind: 'boundary', runs: 6 });
  const four = play({ toward: { x: 40, z: -40 }, speed: 34, elev: -0.05 }).outcome;
  assert.equal(four.kind, 'boundary');
  assert.equal(four.runs, 4);
});

test('a soft push into the gap gets runs, a block to a close fielder gets none', () => {
  // Bisector of the cover / mid-off gap (~36° off straight), ground shot.
  const a = 36 * Math.PI / 180;
  const gap = play({ toward: { x: Math.sin(a) * 40, z: -1.6 - Math.cos(a) * 40 }, speed: 21, elev: -0.08 }).outcome;
  assert.ok(gap.kind === 'runs' || gap.kind === 'boundary', gap.kind);
  assert.ok(gap.runs >= 1, `runs ${gap.runs}`);
  const block = play({ toward: { x: 0, z: -12 }, speed: 7, elev: -0.2 }).outcome;
  assert.equal(block.kind, 'runs');
  assert.equal(block.runs, 0);
});

// ---- the keeper only has the ball if he can physically reach it ----
function bowlPast({ x = 0.2, y, vy = -1, spinner = false, speed = 30 }) {
  const f = new Fielding({ rng: makeRng(3), spinner });
  const k = f.fielders[0];
  const ball = { pos: new Vec3(x, y, k.pos.z - 3), vel: new Vec3(0, vy, speed), bounces: 1, batted: false };
  let got = null, t = 0;
  for (; t < 1 && !got; t += 1 / 240) {
    ball.pos.z += ball.vel.z / 240;
    f.keeperTrack(ball, t);
    f.update(1 / 240, t, null, null);
    got = f.keeperTry(ball, t);
  }
  return { f, got };
}

test('a ball at chest height straight to the keeper is taken', () => {
  const { f, got } = bowlPast({ y: 1.2, vy: 0 });
  assert.equal(got, 'take');
  assert.equal(f.keeperHold, true);
  assert.equal(f.fielders[0].action.how, 'take');
});

test('a bouncer above his standing reach makes him leap; one well over his head beats him', () => {
  const leap = bowlPast({ y: 2.4, vy: 0 });
  assert.equal(leap.got, 'take');
  assert.equal(leap.f.fielders[0].action.how, 'leap');
  const over = bowlPast({ y: 3.2, vy: 0 });
  assert.equal(over.got, 'miss');
  assert.equal(over.f.keeperHold, false);
  assert.ok(over.f.keeperMissed);
  assert.equal(over.f.keeperAttack(1), null, 'no ball, no stumping');
});

test('a ball fired far down the leg side beats the dive', () => {
  const { f, got } = bowlPast({ x: -3.4, y: 0.6, vy: 0, speed: 38 });
  assert.equal(got, 'miss');
  assert.equal(f.keeperHold, false);
});

test('standing up to the spinner he breaks the wicket himself; standing back he has to throw', () => {
  const up = bowlPast({ y: 0.9, vy: 0, spinner: true, speed: 20 }).f;
  const at = up.keeperAttack(0.5);
  assert.equal(up.attack.kind, 'break');
  assert.ok(at >= 0.5 && at < 1.2);
  const back = bowlPast({ y: 0.9, vy: 0 }).f;
  back.keeperAttack(0.5, () => 0.01, 0.5);
  assert.equal(back.attack.kind, 'shy');
  assert.equal(back.attack.hit, true);
  back.keeperAttack(0.5, () => 0.99, 0.5);
  assert.equal(back.attack.hit, false);
});
