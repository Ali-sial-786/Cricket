// The keeper takes a ball with the batter in his ground: the ball is dead.
// And a loose ball nobody can get to never waits for the 20 s timeout: one
// dead at your feet is reached into, one that has beaten the keeper and
// stopped is his to pick up, and a keeper with it by his stumps and nobody
// running has it settled at once.
// It used to freeze play: any appeal earlier in the session (LbwFlow._init
// set a "caught behind" flag named `behind`) hid lbwFlow.behind(), so the
// next clean take made checkLive throw every frame -- the keeper held the
// ball until you left your crease (his attack path skips behind()), and when
// you bowl the AI batter never leaves his, so it hung for good.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BallState } from '../src/physics/ball.js';
import { predict } from '../src/physics/trajectory.js';
import { machineDelivery } from '../src/physics/bowlingMachine.js';
import { CONFIG } from '../src/config.js';
import { LbwFlow } from '../src/game/lbwFlow.js';
import { ContactLog } from '../src/game/edgeTrack.js';
import { Reviews } from '../src/game/reviews.js';
import { BattingSession } from '../src/game/batting.js';
import { BowlingSession } from '../src/game/bowling.js';
import { Vec3, makeRng } from '../src/physics/math.js';
import { PhysicsWorld } from '../src/physics/world.js';
import { Fielding } from '../src/game/fielding.js';

function impactState() {
  const d = machineDelivery({ paceKmh: 135, length: 4.5, line: 0.0 });
  const b = new BallState();
  b.active = true; b.pos.copy(d.releasePos); b.vel.copy(d.vel); b.spin.copy(d.spin); b.swing = d.swing; b.seamDeg = d.seamDeg;
  return predict(b, { maxTime: 3, stop: (s) => s.pos.z >= -1.3 }).final;
}
const button = () => ({ down: false, pressed: false, swallow() {} });
function stubGame() {
  return {
    settings: { difficulty: 'medium' }, rng: () => 0, contacts: new ContactLog(CONFIG), clock: 0, diff: { lbwAgainstPlayer: true },
    drs: { startLbw() {}, startCaught() {}, placeBoard() {}, update() {}, takeCues() { return []; }, hide() {} },
    world: { time: 1, ball: new BallState(), removeBall() {} },
    input: { xr: true, right: { buttons: { a: button(), b: button() } }, left: { buttons: { a: button(), b: button() } }, headPose: { p: { x: 0, y: 1.6, z: -1 } } },
    ui: { prompt() {}, showHud() {}, setHud() {} }, hint() {}, sample() { return true; }, say() {}, crowdReact() {},
    umpires: { signal() {} }, ballView: { setVisible() {}, clearTrail() {} },
  };
}

test('after an LBW appeal and a caught-behind appeal, the keeper taking the next ball is still judged (no throw)', () => {
  const g = stubGame(), flow = new LbwFlow(g, new Reviews(2));
  // an LBW shout earlier in the innings
  flow.start({ impactState: impactState(), path: null, shotOffered: true, playerIsBatter: true, by: 'fielders' });
  for (let i = 0; i < 72 * 10 && !flow.done; i++) flow.update(1 / 72);
  assert.equal(typeof flow.behind, 'function', 'behind() is still a method after an appeal');
  // the next ball: the keeper takes it, you in your ground -- caught behind? (nothing near the bat: no)
  for (const playerIsBatter of [true, false]) {
    let r;
    assert.doesNotThrow(() => { r = flow.behind({ notOut: { kind: 'left' }, path: null, playerIsBatter }); });
    assert.equal(r, false, 'nothing near the bat: no appeal, the ball is dead');
  }
  // a caught-behind flow keeps its own flag (the DRS board's title) without hiding the method
  flow._init({ kind: 'caught', playerIsBatter: true, outRes: { kind: 'caught', by: 'Keeper' }, notOutRes: { kind: 'left' }, behind: true });
  assert.equal(flow.atKeeper, true);
  assert.equal(typeof flow.behind, 'function');
});

// Belt and braces: whatever goes wrong judging a ball, it is a dead ball, never a frozen game.
for (const [name, Session, expect] of [
  ['batting', BattingSession, { unhit: { kind: 'left' }, hit: { kind: 'runs', runs: 1 } }],
  ['bowling', BowlingSession, { unhit: { kind: 'dot', runs: 0 }, hit: { kind: 'runs', runs: 1 } }],
]) {
  test(`${name}: an error judging the ball makes it a dead ball`, () => {
    const err = console.error; console.error = () => {};
    try {
      for (const batted of [false, true]) {
        const got = [];
        const g = { world: { ball: { batted } }, runs: { completed: 1 }, drs: { hide() {} }, ui: { showHud() {} } };
        const s = { game: g, state: 'live', field: {}, byes: null, offer: { offered: false }, reviewFlow: {}, lbw: { active: true, done: false }, finish(res) { got.push(res); this.state = 'settle'; } };
        Session.prototype.deadOnError.call(s, new TypeError('boom'));
        assert.equal(s.state, 'settle');
        assert.deepEqual(got, [batted ? expect.hit : expect.unhit]);
        assert.equal(s.lbw.active, false);
        assert.equal(s.reviewFlow, null);
      }
    } finally { console.error = err; }
  });
}

// A ball left lying still at (x, z), played out until it is back over the stumps (or `secs`).
function loose(x, z, { byes = false, spinner = true, keepOut = null, secs = 8 } = {}) {
  const world = new PhysicsWorld();
  world.launch({ pos: new Vec3(x, CONFIG.ball.radius, z), vel: new Vec3(0, 0, 0.05) });
  world.ball.batted = !byes; world.ball.bounces = 2; world.ball.bouncesSinceBat = 2;
  const f = new Fielding({ rng: makeRng(3) });
  f.autoRuns = false;
  f.reset(); f.setSpinner(spinner); f.newBall(); f.onRelease();
  f.keepOut = keepOut;
  f.onHit(world.ball, 0, predict(world.ball, { maxTime: 9 }), { byes });
  let t = 0, held = null;
  for (; t < secs && !f.throwArrived; t += 1 / 72) {
    world.advanceTo(t);
    world.drainEvents();
    f.update(1 / 72, t, world.ball.active ? world.ball : null, world);
    if (held == null && f.throw) held = t;
  }
  return { f, t, held };
}

// you stand in your crease (the controller's keep-out: nobody within 1.3 m of your head)
const YOU = { x: -0.4, z: -1.05, r: 1.3, path: 2.1 };
for (const at of [[0, -0.8], [0, -1.6], [0.5, -0.6]]) {
  test(`a block dead at your feet (${at}) is reached into and is back over the stumps in a few seconds`, () => {
    const { f, t, held } = loose(at[0], at[1], { keepOut: YOU });
    assert.ok(held != null, `nobody ever picked it up (${f.fielders.map((p) => `${p.name} ${Math.hypot(p.pos.x - at[0], p.pos.z - at[1]).toFixed(1)}`).slice(0, 3).join(', ')})`);
    assert.ok(f.throwArrived, 'it never got back');
    assert.ok(t < 4, `took ${t.toFixed(1)} s`);
  });
}

test('a ball that beat the keeper and stopped behind him is his to pick up (not 20 s of nobody)', () => {
  const { f, t } = loose(-1.2, 1.6, { byes: true, keepOut: YOU });
  assert.ok(f.throwArrived, 'it never got back');
  assert.ok(t < 3, `took ${t.toFixed(1)} s`);
});

test('the keeper with the ball by his stumps and nobody running: settled at once (no 2 s run-in)', () => {
  const { f, t, held } = loose(1.2, -1.6, { keepOut: YOU });
  assert.ok(f.throwArrived && f.fielders[0].action && f.fielders[0].action.type !== 'throw', 'the keeper took it himself');
  assert.ok(t - held < 0.8, `held ${(t - held).toFixed(1)} s`);
});
