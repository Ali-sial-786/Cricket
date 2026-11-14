// Nobody walks into the player or through the stumps: the field logic and the
// running logic played out for several hits, measuring every frame how close
// each fielder / runner comes to the player's head and to the stumps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3, makeRng } from '../src/physics/math.js';
import { PhysicsWorld } from '../src/physics/world.js';
import { predict } from '../src/physics/trajectory.js';
import { PITCH } from '../src/physics/pitch.js';
import { Fielding, PLAYER_CLEAR, STUMP_CLEAR, steerAround } from '../src/game/fielding.js';
import { Runs, RUNNER_CLEAR } from '../src/game/running.js';

const EPS = 1e-6;
const STUMPS = [{ x: 0, z: PITCH.battingStumpsZ }, { x: 0, z: PITCH.bowlingStumpsZ }];

// head: the player's head on the ground. playerBatting: he is the striker
// (otherwise he has just bowled, at the bowling end, and both batters are AI).
function play({ toward, speed, elev, head, playerBatting = true, calls = 1, spinner = false, seed = 7 }) {
  const world = new PhysicsWorld();
  const from = new Vec3(-0.2, 0.8, -1.6);
  const d = new Vec3(toward.x - from.x, 0, toward.z - from.z).normalize();
  const vel = new Vec3(d.x * Math.cos(elev), Math.sin(elev), d.z * Math.cos(elev)).scale(speed);
  world.launch({ pos: from, vel });
  world.ball.batted = true;
  world.ball.bouncesSinceBat = 0;
  const f = new Fielding({ rng: makeRng(seed), catchSkill: 0, spinner, bowlerFields: playerBatting });
  f.autoRuns = false;
  const runs = new Runs();
  f.keepOut = { x: head.x, z: head.z, r: PLAYER_CLEAR };
  runs.keepOut = { x: head.x, z: head.z, r: RUNNER_CLEAR, striker: playerBatting };
  f.obstacles = [{ x: -0.95, z: PITCH.bowlingStumpsZ - 1.9 }, { x: -17.5, z: -1.3 }];   // the umpires
  f.onHit(world.ball, 0, predict(world.ball, { maxTime: 10, h: 1 / 240 }));
  runs.begin(0, playerBatting ? { x: head.x, z: head.z } : { x: -0.4, z: -1.1 }, { x: 1.35, z: -18.75 });
  const boundaryAhead = f.boundaryAhead();
  let left = playerBatting || !boundaryAhead ? calls : 0;
  const m = { head: Infinity, stumps: Infinity, runner: Infinity, outcome: null, boundaryAhead, maxP: 0 };
  let outcome = null;
  const dt = 1 / 60;
  for (let t = dt; t < 12; t += dt) {
    world.advanceTo(t);
    for (const e of world.drainEvents()) if (e.type === 'boundary') { f.onBoundary(e); if (f.outcome && !outcome) { outcome = f.outcome; runs.close({ boundary: true }); } }
    f.update(dt, t, world.ball.active ? world.ball : null, world);
    if (!outcome && left > 0 && !runs.running && runs.call()) left--;
    if (!outcome && f.outcome) { outcome = f.outcome; runs.close({ boundary: f.outcome.kind === 'boundary' }); }
    if (!outcome && f.throwArrived) {
      outcome = runs.running && runs.shortBy() > 0 ? { kind: 'runout', end: f.throwArrived.end } : { kind: 'runs', runs: runs.completed };
      runs.close({ stop: outcome.kind === 'runout' });
    }
    runs.update(dt);
    m.maxP = Math.max(m.maxP, runs.p);
    for (const fl of f.fielders) {
      if (fl.bowler && !f.bowlerFields) continue;            // you are the bowler
      m.head = Math.min(m.head, Math.hypot(fl.pos.x - head.x, fl.pos.z - head.z));
      for (const s of STUMPS) m.stumps = Math.min(m.stumps, Math.hypot(fl.pos.x - s.x, fl.pos.z - s.z));
    }
    for (const striker of playerBatting ? [false] : [true, false]) {
      const st = runs.state(striker);
      m.runner = Math.min(m.runner, Math.hypot(st.x - head.x, st.z - head.z));
    }
    if (outcome && t > (m.outT ??= t) + 3) break;          // and a few seconds after it is dead
  }
  m.outcome = outcome;
  m.f = f;
  m.runs = runs;
  return m;
}

const check = (m, label) => {
  assert.ok(m.head >= PLAYER_CLEAR - EPS, `${label}: a fielder came ${m.head.toFixed(2)} m from your head`);
  assert.ok(m.stumps >= STUMP_CLEAR - EPS, `${label}: a fielder stood ${m.stumps.toFixed(2)} m from the stumps`);
  assert.ok(m.runner >= RUNNER_CLEAR - EPS, `${label}: a runner came ${m.runner.toFixed(2)} m from your head`);
};

test('you bat: a four, a run-out and quick singles keep everyone out of your space and out of the stumps', () => {
  for (const head of [{ x: -0.4, z: -0.9 }, { x: 0.1, z: -0.2 }, { x: 0.5, z: -1.3 }]) {
    const four = play({ toward: { x: 40, z: -40 }, speed: 34, elev: -0.05, head });
    assert.equal(four.outcome.kind, 'boundary');
    check(four, 'four');
    // A push to point and two called runs: the throw beats the second.
    const out = play({ toward: { x: 22, z: -3 }, speed: 9, elev: -0.1, head, calls: 2 });
    check(out, 'run-out');
    // Dabbed just in front, a quick single; the keeper comes up to the stumps.
    for (const toward of [{ x: 3, z: -8 }, { x: -4, z: -7 }, { x: 0.6, z: -6 }]) check(play({ toward, speed: 6, elev: -0.15, head, spinner: true }), 'single');
  }
});

test('you bowl: the AI batters and the fielders run round you at the bowling end', () => {
  for (const head of [{ x: 0.6, z: -18.6 }, { x: -0.8, z: -19.3 }, { x: 0, z: -20.4 }]) {
    check(play({ toward: { x: 2, z: -14 }, speed: 8, elev: -0.1, head, playerBatting: false, calls: 2 }), 'straight push');
    check(play({ toward: { x: -22, z: -6 }, speed: 12, elev: -0.1, head, playerBatting: false, calls: 2 }), 'to midwicket');
  }
});

test('the AI batters do not set off on a ball that is going to the rope; on a boundary they pull up', () => {
  const four = play({ toward: { x: 40, z: -40 }, speed: 34, elev: -0.05, head: { x: 0.6, z: -18.6 }, playerBatting: false, calls: 3 });
  assert.equal(four.outcome.kind, 'boundary');
  assert.equal(four.boundaryAhead, true);
  assert.equal(four.maxP, 0, 'they never left the crease');
  // A run already under way when it crosses the rope stops: they walk back.
  const r = new Runs();
  r.begin(0); r.call();
  for (let i = 0; i < 100; i++) r.update(0.01);
  const p = r.p;
  r.close({ boundary: true });
  for (let i = 0; i < 400; i++) r.update(0.01);
  assert.ok(p > 0.1 && p < 0.8);
  assert.equal(r.p, 0, 'back in the crease they left');
});

test('the non-striker passes wide of you on the far side, whichever side of the stumps you stand', () => {
  for (const hx of [-0.9, -0.4, 0, 0.4, 0.9]) {
    const r = new Runs();
    r.keepOut = { x: hx, z: -1.0, r: RUNNER_CLEAR, striker: true };
    r.begin(0, { x: hx, z: -1.0 }, { x: 1.35, z: -18.75 });
    r.call();
    let min = Infinity;
    for (let i = 0; i < 600; i++) { r.update(0.01); const s = r.state(false); min = Math.min(min, Math.hypot(s.x - hx, s.z + 1.0)); }
    assert.equal(r.completed, 1);
    assert.ok(min >= RUNNER_CLEAR - EPS, `x ${hx}: ${min.toFixed(2)} m`);
    assert.ok(Math.sign(r.state(false).x) === (hx > 0 ? -1 : 1), 'on the other side of the pitch from you');
  }
});

test('steering round the player: the path bends along the tangent, never into him', () => {
  const o = { x: 0, z: 0, r: 1.3 };
  // Straight at him from the front with the goal right behind him.
  let x = 0.01, z = -6;
  for (let i = 0; i < 2000; i++) {
    const u = steerAround(x, z, 0, 6, o);
    x += u.x * 0.01; z += u.z * 0.01;
    const d = Math.hypot(x, z);
    if (d < o.r) { x *= o.r / d; z *= o.r / d; }
    assert.ok(Math.hypot(x, z) >= o.r - EPS);
  }
  assert.ok(z > 5, `got round him (z ${z.toFixed(2)})`);
});
