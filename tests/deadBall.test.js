// A ball nobody is doing anything with never holds up the game:
//   - an unhit delivery that dies short of the keeper (or beside him, out of
//     the way of his gloves) is walked up to and picked up: the ball is dead
//     in his hands (and a batter out of his ground could still be stumped);
//   - between balls the ring fielders who walked in as the bowler ran up go
//     back to their marks, turn round and walk when the mark is behind them,
//     and are set (and facing in) well before the bowler's wait runs out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng, Vec3 } from '../src/physics/math.js';
import { PITCH } from '../src/physics/pitch.js';
import { Fielding } from '../src/game/fielding.js';

const stoppedBall = (x, z) => ({ pos: new Vec3(x, 0.036, z), vel: new Vec3(0, 0, 0), bounces: 3, batted: false });

for (const [label, spinner, at] of [
  ['standing back, it died on the pitch in front of the stumps', false, [0.15, -1.2]],
  ['standing back, it stopped between the stumps and him', false, [-0.3, 1.5]],
  ['standing up, it came to rest beside the stumps', true, [0.35, 0.1]],
  ['standing up, it died a yard in front of the crease', true, [-0.2, -2.0]],
]) {
  test(`the keeper walks up and picks up a dead ball (${label})`, () => {
    const f = new Fielding({ rng: makeRng(5) });
    f.reset();
    f.setSpinner?.(spinner);
    f.newBall();
    f.onRelease();
    const k = f.fielders[0], ball = stoppedBall(at[0], at[1]);
    const dt = 1 / 72;
    let t = 10, got = null, maxV = 0;
    for (let i = 0; i < 72 * 5 && got !== 'take'; i++, t += dt) {
      got = f.keeperFetch(ball, t);
      const p0 = k.pos.clone();
      f.update(dt, t, null, null);
      maxV = Math.max(maxV, Math.hypot(k.pos.x - p0.x, k.pos.z - p0.z) / dt);
    }
    assert.equal(got, 'take', `never picked up (keeper at ${k.pos.x.toFixed(2)}, ${k.pos.z.toFixed(2)})`);
    assert.ok(f.keeperHold, 'the ball is in his gloves');
    assert.ok(t - 10 < 3.6, `took ${(t - 10).toFixed(1)} s`);
    assert.ok(maxV < 3.6, `walked up at ${maxV.toFixed(1)} m/s (no sprint)`);
    assert.ok(f.ballOverride && f.ballOverride.holder === 0, 'he holds it');
  });
}

test('between balls the ring fielders walk back from their walk-in and are set, facing in, within 4 s', () => {
  const f = new Fielding({ rng: makeRng(9) });
  f.reset(); f.newBall();
  const dt = 1 / 72;
  let t = 0;
  f.walkIn();
  for (let i = 0; i < 72 * 3; i++, t += dt) f.update(dt, t, null, null);
  f.onRelease();
  const off = f.fielders.filter((p) => !p.bowler && Math.hypot(p.pos.x - p.home.x, p.pos.z - p.home.z) > 1);
  assert.ok(off.length >= 3, 'the ring walked in');
  f.ballDead();
  let k = 0;
  for (; k < 72 * 10 && !f.settled(); k++, t += dt) f.update(dt, t, null, null);
  assert.ok(f.settled(), `still not set: ${f.fielders.filter((p) => !p.bowler && Math.hypot(p.pos.x - p.home.x, p.pos.z - p.home.z) > 0.6).map((p) => p.name).join(', ')}`);
  assert.ok(k / 72 < 4, `took ${(k / 72).toFixed(1)} s`);
});

test('a fielder 10 m from a mark behind him turns and walks back (no slow backpedal)', () => {
  const f = new Fielding({ rng: makeRng(2) });
  f.reset(); f.newBall(); f.onRelease();
  const p = f.fielders.find((x) => x.name === 'mid-off');
  // he is 10 m in front of his mark, facing the batter
  const dir = Math.atan2(0 - p.home.x, PITCH.battingStumpsZ - p.home.z);
  p.pos.set(p.home.x + Math.sin(dir) * 10, 0, p.home.z + Math.cos(dir) * 10);
  p.yaw = p.face = dir; p.state = 'set';
  f.ballDead();
  const dt = 1 / 72; let t = 0, k = 0;
  for (; k < 72 * 10 && Math.hypot(p.pos.x - p.home.x, p.pos.z - p.home.z) > 0.6; k++, t += dt) f.update(dt, t, null, null);
  assert.ok(k / 72 < 5, `10 m back took ${(k / 72).toFixed(1)} s`);
});
