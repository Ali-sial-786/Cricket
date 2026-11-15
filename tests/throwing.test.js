// Throws in the field: where a fielder throws, how accurately, who covers the
// stumps, and what a throw nobody takes does (overthrows), with the scoring
// the Laws give it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3, makeRng } from '../src/physics/math.js';
import { PhysicsWorld, InterpolatedBatProvider } from '../src/physics/world.js';
import { Pose } from '../src/physics/math.js';
import { predict } from '../src/physics/trajectory.js';
import { PITCH } from '../src/physics/pitch.js';
import { CONFIG } from '../src/config.js';
import { decideThrow, directHitChance, throwScatter, aimThrow, continuation, throwPoint, overthrowRuns, boundaryOverthrowRuns, crossedNow, THROW } from '../src/game/throwing.js';
import { Fielding, PLAYER_CLEAR, receiverSpot } from '../src/game/fielding.js';
import { Runs, planMoreRuns } from '../src/game/running.js';
import { Innings, runsText } from '../src/game/scoring.js';
import { Scorecard } from '../src/game/scorecard.js';

const C2C = PITCH.length - 2 * PITCH.poppingOffset;
const ready = { readyIn: 0, backed: false };
const nobody = { readyIn: Infinity, backed: false };

// ------------------------------------------------------------- the decision
test('a run-out on and the keeper over the stumps: the throw goes into his gloves', () => {
  const d = decideThrow({ from: { x: 18, z: -12 }, runner: { remaining: 9, v: 6 }, ends: { batting: ready, bowling: nobody } });
  assert.equal(d.kind, 'gloves');
  assert.equal(d.end, 'batting');
  assert.ok(d.short > THROW.chance);
});

test('a run-out on, nobody at the stumps yet, close in: a shy at them', () => {
  const d = decideThrow({ from: { x: 9, z: -8 }, runner: { remaining: 8, v: 6 }, ends: { batting: { readyIn: 3, backed: true }, bowling: { readyIn: 3 } } });
  assert.equal(d.kind, 'direct');
  assert.ok(d.pHit > THROW.minHit);
});

test('no shy at empty stumps with nobody backing up unless the run-out is a good one', () => {
  // a long way out and side on: a poor chance of hitting, nobody there or behind
  const thin = decideThrow({ from: { x: 30, z: -3 }, runner: { remaining: 4.2, v: 6 }, ends: { batting: { readyIn: 2.5 }, bowling: { readyIn: 2.5 } } });
  assert.notEqual(thin.kind, 'direct', JSON.stringify(thin));
  // the same throw with the batter well short: worth it
  const good = decideThrow({ from: { x: 14, z: -6 }, runner: { remaining: 12, v: 6 }, ends: { batting: { readyIn: 4 }, bowling: { readyIn: 4 } } });
  assert.equal(good.kind, 'direct', JSON.stringify(good));
});

test('nothing on: a safe return to the keeper; from the deep on one bounce', () => {
  const near = decideThrow({ from: { x: 20, z: -14 }, runner: null, ends: { batting: ready, bowling: ready } });
  assert.equal(near.kind, 'return');
  assert.equal(near.end, 'batting');
  assert.equal(near.bounce, false);
  const deep = decideThrow({ from: { x: 40, z: -40 }, runner: null, ends: { batting: ready, bowling: ready } });
  assert.equal(deep.kind, 'return');
  assert.equal(deep.bounce, true);
  // right by the bowler's end and much nearer it: there
  const straight = decideThrow({ from: { x: 2, z: -24 }, runner: null, ends: { batting: ready, bowling: ready } });
  assert.equal(straight.end, 'bowling');
});

test('nobody at either end yet: he holds it until a teammate will be there, but not for long while they run', () => {
  const ends = { batting: { readyIn: 2.0 }, bowling: { readyIn: 4.0 } };
  const wait = decideThrow({ from: { x: 30, z: -20 }, runner: null, ends });
  assert.equal(wait.end, 'batting');
  assert.ok(wait.wait > 0.3, `waits ${wait.wait}`);
  const running = decideThrow({ from: { x: 30, z: -20 }, runner: { remaining: 2, v: 6 }, ends: { batting: { readyIn: 2.0, backed: true }, bowling: { readyIn: 4 } }, held: THROW.holdRunning + 0.1 });
  assert.equal(running.wait, 0, 'held long enough: it goes');
});

test('the player chooses the end: the throw goes there', () => {
  const d = decideThrow({ from: { x: 20, z: -14 }, runner: null, ends: { batting: ready, bowling: ready }, forced: 'bowling' });
  assert.equal(d.end, 'bowling');
  const empty = decideThrow({ from: { x: 20, z: -14 }, runner: { remaining: 9, v: 6 }, ends: { batting: ready, bowling: nobody }, forced: 'bowling' });
  assert.equal(empty.end, 'bowling');
  assert.equal(empty.kind, 'direct', 'nobody there: at the stumps');
});

// ------------------------------------------------------------- accuracy
test('a shy is likelier to hit square on to the pitch than side on, and from close in', () => {
  const sig = (d) => throwScatter(d, { kind: 'direct' });
  const along = directHitChance({ x: 0, z: -15 }, 'batting', sig(15));
  const square = directHitChance({ x: 15, z: 0 }, 'batting', sig(15));
  assert.ok(along > square * 1.8, `${along} vs ${square}`);
  assert.ok(directHitChance({ x: 8, z: -6 }, 'batting', sig(10)) > directHitChance({ x: 24, z: -18 }, 'batting', sig(30)));
  assert.ok(directHitChance({ x: 8, z: -6 }, 'batting', throwScatter(10, { kind: 'direct', hurried: true })) < directHitChance({ x: 8, z: -6 }, 'batting', sig(10)));
});

test('the hit chance matches what thrown balls actually do against the wicket box', () => {
  const rng = makeRng(4);
  for (const from of [{ x: 0, z: -14 }, { x: 14, z: -2 }, { x: 12, z: -12 }]) {
    let hits = 0; const N = 3000;
    for (let i = 0; i < N; i++) {
      const th = { from: new Vec3(from.x, 1.2, from.z), end: 'batting', kind: 'direct' };
      aimThrow(th, rng, {});
      if (th.result === 'hit') hits++;
    }
    const d = Math.hypot(from.x, from.z), p = directHitChance(from, 'batting', throwScatter(d, { kind: 'direct' }));
    assert.ok(Math.abs(hits / N - p) < 0.09, `from ${JSON.stringify(from)}: thrown ${(hits / N).toFixed(2)} vs predicted ${p.toFixed(2)}`);
  }
});

test('a throw that misses carries on along its line at most of its pace (it does not stop)', () => {
  const th = { from: new Vec3(20, 1.2, -10), end: 'batting', kind: 'direct' };
  aimThrow(th, () => 1e-6, {});                                   // (a wild one)
  assert.equal(th.result, 'miss');
  th.tStart = 0; th.tArrive = th.flight;
  const v = continuation(th);
  const dir = new Vec3(th.to.x - th.from.x, 0, th.to.z - th.from.z).normalize();
  const hv = Math.hypot(v.x, v.z);
  assert.ok(hv > 10, `carries on at ${hv.toFixed(1)} m/s`);
  assert.ok((v.x * dir.x + v.z * dir.z) / hv > 0.98, 'along its line');
  // the flight starts at the hand and ends at its target
  const p0 = throwPoint(th, 0), p1 = throwPoint(th, 1);
  assert.ok(p0.distanceTo(th.from) < 1e-9 && p1.distanceTo(th.to) < 1e-9);
});

test('a throw into a receiver who is there is taken; one well wide of him is not', () => {
  const rcv = { pos: receiverSpot('batting', 1), there: true };
  const ok = { from: new Vec3(15, 1.2, -10), end: 'batting', kind: 'gloves' };
  aimThrow(ok, () => 0.5, { receiver: rcv });
  assert.equal(ok.result, 'take');
  const wild = { from: new Vec3(15, 1.2, -10), end: 'batting', kind: 'gloves' };
  aimThrow(wild, () => 1e-6, { receiver: rcv });
  assert.equal(wild.result, 'miss');
  const empty = { from: new Vec3(15, 1.2, -10), end: 'batting', kind: 'gloves' };
  aimThrow(empty, () => 0.5, { receiver: { pos: rcv.pos, there: false } });
  assert.equal(empty.result, 'miss', 'nobody there in time');
});

// ------------------------------------------------------------- scoring
test('overthrows to the rope: four plus the runs completed, plus the one in progress only if they had crossed at the throw (Law 19.8)', () => {
  assert.deepEqual(boundaryOverthrowRuns({ completed: 1, crossed: false }), { runs: 5, ran: 1, overthrows: 4 });   // (the 2019 final: 5, not 6)
  assert.deepEqual(boundaryOverthrowRuns({ completed: 1, crossed: true }), { runs: 6, ran: 2, overthrows: 4 });
  assert.equal(boundaryOverthrowRuns({}).runs, 4);
  assert.deepEqual(overthrowRuns(4, 2), { runs: 4, base: 2, overthrows: 2 });
  assert.deepEqual(overthrowRuns(1, 2), { runs: 1, base: 1, overthrows: 0 });
  const r = new Runs(); r.begin(0); r.call();
  for (let i = 0; i < 100; i++) r.update(0.01);
  assert.equal(crossedNow(r), r.p > 0.5);
  for (let i = 0; i < 150; i++) r.update(0.01);
  assert.equal(crossedNow(r), r.running && r.p - Math.floor(r.p) >= 0.5);
});

test('result text for overthrows', () => {
  assert.equal(runsText({ runs: 2 }), '2 runs');
  assert.equal(runsText({ runs: 1 }), '1 run');
  assert.equal(runsText({ runs: 4, overthrows: 2 }), '2 + 2 overthrows');
  assert.equal(runsText({ runs: 4, overthrows: 4 }), '4 overthrows');
  assert.equal(runsText({ runs: 5, overthrows: 4 }), '1 + 4 overthrows');
  assert.equal(runsText({ runs: 1, overthrows: 1 }), '1 overthrow');
  assert.equal(runsText({ runs: 3, overthrows: 1, byes: true }), '2 byes + 1 overthrow');
  assert.equal(runsText({ runs: 0 }), null);
});

test('overthrows on the card: runs to the batter, not a four, and the strike goes by the runs they ran', () => {
  const card = new Scorecard(['A', 'B', 'C', 'D']);
  const inn = new Innings({ balls: 12, wickets: 3, card });
  card.setBowler('X');
  // 1 run completed, not crossed on the second at the throw, it goes for four: 5, the batters stay as after 1 run
  inn.record({ runs: 5, overthrows: 4, boundary: 0 });
  assert.equal(inn.runs, 5);
  assert.equal(inn.fours, 0);
  assert.equal(card.batters[0].runs, 5);
  assert.equal(card.batters[0].fours, 0);
  assert.equal(card.onStrike.name, 'B', 'odd number run: they changed ends');
  // 2 + 2 overthrows: four runs run, no change of ends
  inn.record({ runs: 4, overthrows: 2 });
  assert.equal(inn.runs, 9);
  assert.equal(card.onStrike.name, 'B');
  assert.equal(card.batters[1].runs, 4);
});

// ------------------------------------------------------------- the field
function hitBall(world, toward, speed, elev = -0.08) {
  const from = new Vec3(-0.2, 0.8, -1.6);
  const d = new Vec3(toward.x - from.x, 0, toward.z - from.z).normalize();
  world.launch({ pos: from, vel: new Vec3(d.x * Math.cos(elev), Math.sin(elev), d.z * Math.cos(elev)).scale(speed) });
  world.ball.batted = true; world.ball.bouncesSinceBat = 0;
}
function field(opts = {}) {
  const f = new Fielding({ rng: makeRng(opts.seed ?? 3), catchSkill: 0, bowlerFields: opts.bowlerFields ?? true, spinner: false });
  f.autoRuns = false;
  if (opts.head) f.keepOut = { x: opts.head.x, z: opts.head.z, r: PLAYER_CLEAR };
  return f;
}

test('the keeper covers his stumps from standing back, even though he was moving with the ball\'s line', () => {
  const world = new PhysicsWorld(), f = field();
  const k = f.fielders[0];
  k.state = 'gather'; k.target = new Vec3(0.4, 0, k.home.z); k.leap = { t: 0.3, how: 'dive', x: 0.9, y: 0.5, side: 1 };
  hitBall(world, { x: 30, z: -25 }, 20);
  f.onHit(world.ball, 0, predict(world.ball, { maxTime: 10, h: 1 / 240 }));
  assert.equal(k.state, 'stumps');
  assert.equal(k.leap, null, 'no dive for a ball that has been hit');
  assert.equal(f.cover.batting, k);
  const bw = f.fielders[f.fielders.length - 1];
  assert.equal(f.cover.bowling, bw, 'the bowler covers his end');
  let there = null;
  for (let t = 1 / 60; t < 4; t += 1 / 60) {
    world.advanceTo(t);
    f.update(1 / 60, t, world.ball.active ? world.ball : null, world);
    if (there == null && Math.hypot(k.pos.x, k.pos.z) < 1.0) there = t;
  }
  assert.ok(there != null && there < 2.2, `keeper over the stumps after ${there} s`);
  assert.ok(f.backer && f.backer.state === 'backstop', 'someone backs up');
});

test('the keeper chasing the ball himself: the nearest free man covers his stumps; you bowling: nobody comes to stand by yours', () => {
  const head = { x: 0.5, z: -18.4 };
  const world = new PhysicsWorld(), f = field({ bowlerFields: false, head });
  hitBall(world, { x: 1.5, z: 6 }, 5, -0.2);                       // dribbled behind: the keeper's
  f.onHit(world.ball, 0, predict(world.ball, { maxTime: 10, h: 1 / 240 }));
  const k = f.fielders[0];
  assert.equal(k.state, 'chase');
  assert.ok(f.cover.batting && f.cover.batting !== k && !f.cover.batting.bowler, 'someone else at the keeper\'s end');
  let minHead = Infinity, coveredYours = false;
  for (let t = 1 / 60; t < 6; t += 1 / 60) {
    world.advanceTo(t);
    f.update(1 / 60, t, world.ball.active ? world.ball : null, world);
    if (f.cover.bowling) coveredYours = true;
    for (const fl of f.fielders) if (!fl.bowler) minHead = Math.min(minHead, Math.hypot(fl.pos.x - head.x, fl.pos.z - head.z));
  }
  assert.equal(coveredYours, false, 'your stumps are yours (a throw there is at the stumps)');
  assert.ok(minHead >= PLAYER_CLEAR - 1e-6, `a fielder came ${minHead.toFixed(2)} m from you`);
  // ... and a throw to your end goes at the stumps
  const d = decideThrow({ from: { x: 12, z: -24 }, runner: null, ends: { batting: ready, bowling: nobody }, forced: 'bowling' });
  assert.equal(d.kind, 'direct');
});

test('the man over the stumps keeps them until the keeper, coming back, is there too', () => {
  const world = new PhysicsWorld(), f = field();
  hitBall(world, { x: 1.5, z: 6 }, 5, -0.2);
  f.onHit(world.ball, 0, predict(world.ball, { maxTime: 10, h: 1 / 240 }));
  const k = f.fielders[0], slip = f.cover.batting;
  assert.ok(slip && slip !== k);
  // the slip is over the stumps; the keeper, free again, is 12 m away
  slip.pos.copy(receiverSpot('batting', slip.coverSide || 1)); slip.speed = 0; slip.vel.set(0, 0, 0);
  k.state = 'set'; k.action = null; k.pos.set(3, 0, 12);
  f.throw = null; f.ballOverride = null;
  f.assignCovers(2);
  assert.equal(f.cover.batting, slip, 'he stays');
  assert.equal(k.state, 'stumps', 'the keeper comes back to his stumps all the same');
  assert.ok(k.target && Math.sign(k.target.x) === -Math.sign(slip.target.x), '... to the other side of them');
  k.pos.set(0.4, 0, 0.65);
  slip.pos.set(2.5, 0, 2.5);
  f.assignCovers(2.1);
  assert.equal(f.cover.batting, k, 'the keeper, right there, takes them back');
});

test('a throw nobody takes runs on with the ball physics (never stops dead); fielders go after it', () => {
  const world = new PhysicsWorld(), f = field();
  const runs = new Runs(); f.runs = runs; runs.begin(0);
  hitBall(world, { x: 35, z: -30 }, 17);
  f.onHit(world.ball, 0, predict(world.ball, { maxTime: 10, h: 1 / 240 }));
  runs.call();
  let t = 0, missed = false, released = false, prev = null, rolled = 0, ev = [];
  for (t = 1 / 60; t < 14; t += 1 / 60) {
    world.advanceTo(t);
    for (const e of world.drainEvents()) if (e.type === 'boundary') f.onBoundary(e);
    const wild = !released && f.throw && !f.throw.released && t >= f.throw.tStart;   // (this one goes wild)
    if (wild) { released = true; f.rng = () => 1e-6; }
    f.update(1 / 60, t, world.ball.active ? world.ball : null, world);
    if (wild) f.rng = makeRng(5);
    ev.push(...f.events.splice(0));
    runs.update(1 / 60);
    if (!missed && ev.some((e) => e.type === 'overthrow')) { missed = true; prev = world.ball.pos.clone(); }
    if (missed && world.ball.active && prev) { rolled = Math.max(rolled, Math.hypot(world.ball.pos.x - prev.x, world.ball.pos.z - prev.z)); }
    if (missed && (f.fielded || f.outcome)) break;
  }
  assert.ok(missed, 'the throw got away');
  assert.ok(f.overthrow && f.overthrow.count >= 1);
  assert.ok(rolled > 5, `ran on ${rolled.toFixed(1)} m`);
  assert.ok(f.fielded || (f.outcome && f.outcome.kind === 'boundary'), 'picked up again, or over the rope');
});

test('overthrows over the rope score four plus the runs as at the throw', () => {
  const f = field();
  f.hitT = 0; f.started = true; f.dead = false;
  f.overthrow = { t: 3, base: 1, count: 1, atThrow: { completed: 1, crossed: true } };
  f.onBoundary({ onFull: false });
  assert.equal(f.outcome.kind, 'boundary');
  assert.equal(f.outcome.runs, 6);
  assert.equal(f.outcome.overthrows, 4);
  assert.equal(f.outcome.ran, 2);
  assert.equal(f.message, '2 + 4 overthrows');
});

test('the keeper\'s shy that misses: the ball carries on past the stumps as a live ball', () => {
  const world = new PhysicsWorld(), f = field();
  f.shy = { from: new Vec3(0.2, 0.75, 4.7), to: new Vec3(0.4, 0.25, -0.6), tStart: 0, at: 0.3, hit: false };
  f.keeperHold = true;
  f.shyMissed(world, 0.3);
  assert.equal(world.ball.active, true);
  assert.ok(world.ball.vel.z < -5, 'on toward the bowler\'s end');
  assert.equal(world.ball.batted, false, 'not hit: byes');
  assert.equal(f.ballOverride, null);
  assert.ok(f.overthrow && f.overthrow.count === 1);
  const z0 = world.ball.pos.z;
  world.advanceTo(1.0);
  assert.ok(world.ball.pos.z < z0 - 3, 'and it rolls on');
});

test('AI batters run more on an overthrow the longer the ball will be away', () => {
  const rng = () => 0.5;
  const r = new Runs(); r.begin(0); r.call();
  for (let i = 0; i < 200; i++) r.update(0.01);
  assert.equal(planMoreRuns(1.5, r, 0.4, rng), 0, 'picked up straight away: stay');
  assert.ok(planMoreRuns(5, r, 0.4, rng) >= 1);
  assert.ok(planMoreRuns(9, r, 0.4, rng) > planMoreRuns(5, r, 0.4, rng));
  assert.equal(planMoreRuns(Infinity, r, 0.4, rng), 2);
});

test('run out in the middle of a dive: he comes to rest short of the line, not across it', () => {
  const r = new Runs(); r.begin(0); r.call(); r.diveHeld = true;
  let i = 0;
  while (!r.diving && i++ < 1000) r.update(1 / 60);
  for (let k = 0; k < 6; k++) r.update(1 / 60);
  const short = r.shortBy();
  assert.ok(short > 0.5, `short ${short}`);
  r.close({ stop: false, short });
  for (let k = 0; k < 120; k++) r.update(1 / 60);
  const left = (1 - r.p) * C2C;
  assert.ok(left > 1.0 + short * 0.4, `lies ${left.toFixed(2)} m from his ground (was ${short.toFixed(2)} m short with the bat)`);
  // and a run in progress that counts (overthrows to the rope, crossed at the throw) is finished
  const q = new Runs(); q.begin(0); q.call();
  for (let k = 0; k < 140; k++) q.update(1 / 60);
  q.close({ boundary: true, to: 1 });
  for (let k = 0; k < 600; k++) q.update(1 / 60);
  assert.equal(q.p, 1);
});

test('a diver takes a natural moment to get up', () => {
  const r = new Runs(); r.begin(0); r.call(); r.diveHeld = true;
  let landed = null, up = null;
  for (let t = 0; t < 8; t += 1 / 60) {
    r.update(1 / 60);
    const s = r.state(true);
    if (landed == null && s.dive && s.dive.down > 0) landed = t;
    if (landed != null && up == null && s.dive && s.dive.up >= 1) up = t;
  }
  assert.ok(up - landed > 1.0, `prone to up in ${(up - landed).toFixed(2)} s`);
  assert.ok(CONFIG.field.getUp < 2);
});

test('a thrown ball carrying on never meets a bat (no catch, no "shot"); one into the stumps is marked as a throw', () => {
  const through = (thrown) => {
    const world = new PhysicsWorld();
    const prov = new InterpolatedBatProvider();
    const pose = new Pose(new Vec3(-0.3, 1.0, -1.2));          // a bat held upright at the striker's crease, face down the pitch
    prov.snap(0, pose, pose.p.clone());
    world.addBat('ai', prov, undefined, 1);
    world.launch({ pos: new Vec3(-0.3, 0.55, 2.0), vel: new Vec3(0, 0, -15) });   // a throw going down the pitch past him
    world.ball.batted = true; world.ball.bouncesSinceBat = 1;
    world.ball.thrown = thrown;
    world.advanceTo(0.5);
    return { events: world.drainEvents().map((e) => e.type), ball: world.ball };
  };
  const hit = through(false);
  assert.ok(hit.events.includes('bat'), 'the same ball as a delivery is hit (the bat is in its way)');
  const thrown = through(true);
  assert.ok(!thrown.events.includes('bat'), 'a throw goes past');
  assert.ok(thrown.ball.bouncesSinceBat >= 1, 'and can never be caught');
  // into the stumps
  const world = new PhysicsWorld();
  world.launch({ pos: new Vec3(0, 0.3, -3), vel: new Vec3(0, 0, 12) });
  world.ball.thrown = true;
  world.advanceTo(0.5);
  const w = world.drainEvents().find((e) => e.type === 'wicket');
  assert.ok(w && w.thrown === true && w.end === 'batting');
  // a clone keeps what it is
  assert.equal(world.ball.clone().thrown, true);
});

test('a direct hit with the batters home is an overthrow only once it is judged so; none once the ball is dead', () => {
  const world = new PhysicsWorld(), f = field();
  f.hitT = 0; f.started = true; f.dead = false;
  f.throw = { f: f.fielders[4], end: 'batting', result: 'hit', from: new Vec3(8, 1.2, -8), to: new Vec3(0.05, 0.4, 0), tStart: 0, tArrive: 0.5, arc: 0.3, atThrow: { completed: 0, crossed: false } };
  f.ballOverride = { pos: new Vec3() };
  f.arrive(0.5, world);
  assert.ok(f.throwArrived && f.throwArrived.direct);
  assert.equal(f.events.filter((e) => e.type === 'overthrow').length, 0, 'no overthrow call before the run-out is judged');
  assert.equal(f.events.filter((e) => e.type === 'stumps').length, 1);
  f.directRunsOn(0.6);
  assert.equal(f.events.filter((e) => e.type === 'overthrow').length, 1);
  assert.ok(f.overthrow && f.overthrow.count === 1);
  // a throw that arrives once the ball is dead: no more play
  const g = field(); const w2 = new PhysicsWorld();
  g.hitT = 0; g.started = true; g.dead = true;
  g.throw = { f: g.fielders[4], end: 'batting', result: 'miss', from: new Vec3(8, 1.2, -8), to: new Vec3(1.5, 1.0, 0.4), tStart: 0, tArrive: 0.5, arc: 0.3 };
  g.ballOverride = { pos: new Vec3() };
  g.arrive(0.5, w2);
  assert.equal(w2.ball.active, false);
  assert.equal(g.overthrow, null);
});
