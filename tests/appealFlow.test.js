// The appeal / decision / review flow (src/game/lbwFlow.js) with a stand-in
// game: your appeal (B) when the fielders keep quiet, the umpire's call, your
// review (A), the reviews spent or kept, and no button doing two things.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BallState } from '../src/physics/ball.js';
import { predict } from '../src/physics/trajectory.js';
import { machineDelivery } from '../src/physics/bowlingMachine.js';
import { CONFIG } from '../src/config.js';
import { LbwFlow } from '../src/game/lbwFlow.js';
import { ContactLog } from '../src/game/edgeTrack.js';
import { Reviews } from '../src/game/reviews.js';

function impactState(settings = { paceKmh: 135, length: 4.5, line: 0.0 }, padZ = -1.3) {
  const d = machineDelivery(settings);
  const b = new BallState();
  b.active = true; b.pos.copy(d.releasePos); b.vel.copy(d.vel); b.spin.copy(d.spin); b.swing = d.swing; b.seamDeg = d.seamDeg;
  return predict(b, { maxTime: 3, stop: (s) => s.pos.z >= padZ }).final;
}

const button = () => ({ down: false, pressed: false, swallowed: 0, swallow() { this.swallowed++; this.down = false; this.pressed = false; } });

function stubGame({ rng = () => 0.5, contacts = new ContactLog(CONFIG) } = {}) {
  const log = [];
  const drs = {
    active: false, done: false, result: null, started: null, t: 0,
    startLbw(o) { this.started = { kind: 'lbw', ...o }; this.t = 0; this.active = true; },
    startCaught(o) { this.started = { kind: 'caught', ...o }; this.t = 0; this.active = true; },
    placeBoard() {},
    update(dt) {
      this.t += dt;
      if (this.active && this.t > 1) {
        const o = this.started.outcome;
        this.active = false; this.done = true;
        this.result = { kind: this.started.kind, out: o.out, umpiresCall: o.umpiresCall, reviewKept: o.reviewKept };
      }
    },
    takeCues() { return []; },
    hide() { this.done = false; this.active = false; },
  };
  const g = {
    settings: { difficulty: 'medium' }, rng, contacts, drs, clock: 0, diff: { lbwAgainstPlayer: true },
    world: { time: 1, ball: new BallState(), removeBall() {} },
    input: { xr: true, right: { buttons: { a: button(), b: button() } }, left: { buttons: { a: button(), b: button() } }, headPose: { p: { x: 0, y: 1.6, z: -19 } } },
    ui: { prompt(text) { log.push(['prompt', text]); }, showHud() {} },
    hint(list) { log.push(['hint', list[0].label]); },
    sample() { return true; }, say(what, ctx) { log.push(['say', what, ctx]); }, crowdReact() {},
    umpires: { signal(s) { log.push(['signal', s]); } },
    ballView: { setVisible() {}, clearTrail() {} },
    log,
  };
  return g;
}

// Run the flow for `secs` (real time) at 72 Hz; press(t) can push buttons.
function run(flow, g, secs, press = null) {
  const dt = 1 / 72;
  for (let t = 0; t < secs && !flow.done; t += dt) {
    for (const c of [g.input.right, g.input.left]) for (const b of Object.values(c.buttons)) b.down = false;
    if (press) press(flow, g);
    flow.update(dt);
  }
}

test('appeal button: the fielders keep quiet, you appeal (B), given not out, you review (A), overturned', () => {
  const g = stubGame({ rng: () => 0 });               // rng 0: the umpire gets the plumb one wrong
  const reviews = new Reviews(2);
  const flow = new LbwFlow(g, reviews);
  flow.start({ impactState: impactState(), path: null, shotOffered: true, playerIsBatter: false, by: 'offer' });
  assert.equal(flow.phase, 'window');
  run(flow, g, 0.5);
  assert.ok(g.log.some((l) => l[0] === 'hint' && l[1] === 'APPEAL'), 'the appeal hint, once the ball is dead');
  assert.equal(flow.phase, 'window');
  // B: you appeal (the press is used up: it cannot also pick a delivery)
  const B = g.input.right.buttons.b;
  run(flow, g, 0.1, () => { B.down = true; });
  assert.equal(flow.phase, 'appeal');
  assert.equal(flow.appealBy, 'player');
  assert.ok(B.swallowed >= 1);
  assert.equal(flow.onFieldOut, false, 'given not out');
  run(flow, g, 1.8);
  assert.equal(flow.phase, 'decision');
  assert.equal(flow.canPlayer, true);
  // B again does not review (A does)
  run(flow, g, 0.4, () => { B.down = true; });
  assert.equal(flow.phase, 'decision');
  const A = g.input.right.buttons.a;
  run(flow, g, 0.05, () => { A.down = true; });
  assert.equal(flow.phase, 'review');
  assert.ok(A.swallowed >= 1);
  assert.equal(g.drs.started.kind, 'lbw');
  assert.equal(g.drs.started.outcome.out, true);
  assert.equal(g.drs.started.outcome.overturned, true);
  run(flow, g, 4);
  assert.equal(flow.done, true);
  assert.deepEqual(flow.result({ kind: 'dot', padded: true }), { kind: 'lbw' });
  assert.equal(reviews.player, 2, 'overturned: review kept');
});

test('appeal button: no press, no appeal (and the ball is not out)', () => {
  const g = stubGame();
  const flow = new LbwFlow(g, new Reviews(2));
  flow.start({ impactState: impactState(), path: null, shotOffered: true, playerIsBatter: false, by: 'offer' });
  run(flow, g, 4);
  assert.equal(flow.done, true);
  assert.deepEqual(flow.result({ kind: 'dot', padded: true }), { kind: 'dot', padded: true, noAppeal: true });
  assert.ok(!g.log.some((l) => l[0] === 'signal'), 'the umpire was never asked');
});

test('reviews: a failed review is lost; with none left there is no review', () => {
  // You bat: given out (plumb, right), you review: stays out, review lost.
  const g = stubGame({ rng: () => 0.99 });
  const reviews = new Reviews(2);
  let flow = new LbwFlow(g, reviews);
  flow.start({ impactState: impactState(), path: null, shotOffered: true, playerIsBatter: true });
  run(flow, g, 1.8);
  assert.equal(flow.onFieldOut, true);
  run(flow, g, 0.05, () => { g.input.right.buttons.a.down = true; });
  run(flow, g, 5);
  assert.equal(flow.done, true);
  assert.equal(flow.out, true);
  assert.equal(reviews.player, 1);
  // none left: the prompt never offers one and A does nothing
  reviews.player = 0;
  flow = new LbwFlow(g, reviews);
  flow.start({ impactState: impactState(), path: null, shotOffered: true, playerIsBatter: true });
  run(flow, g, 6, (f, gg) => { gg.input.right.buttons.a.down = true; });
  assert.equal(flow.reviewed, false);
  assert.equal(flow.out, true);
});

test('caught: a faint edge to the keeper, the fielders quiet, your appeal; a middled catch needs none', () => {
  // the log: a faint edge, caught 15 m back
  const contacts = new ContactLog(CONFIG);
  contacts.launchT = 0;
  contacts.addBat({ t: 0.6, face: 'side', part: 'blade', local: { x: 0.07 + 0.9 * CONFIG.ball.radius, y: -0.55, z: 0.03 }, speedIn: 30, batId: 'ai' },
    { bladeHalf: { x: 0.07, z: 0.025 }, toeY: -0.79, shoulderY: -0.18, handleTopY: 0.12, sweetY: -0.62, faceZ: 0.025, handleRadius: 0.017 }, null, { x: 1, y: 0, z: 0 });
  contacts.lastBall = { x: 0.3, y: 1, z: 14 };
  // rng: 0.9 -> the fielders (0.7 for a faint edge) do not go up; then 0.5 -> the umpire hears it
  const seq = [0.9, 0.5]; let i = 0;
  const g = stubGame({ rng: () => seq[Math.min(i++, seq.length - 1)], contacts });
  const reviews = new Reviews(2);
  const flow = new LbwFlow(g, reviews);
  const started = flow.caught({ kind: 'caught', by: 'Keeper' }, { notOut: { kind: 'runs', runs: 0 }, playerIsBatter: false });
  assert.equal(started, true);
  assert.equal(flow.phase, 'window');
  run(flow, g, 0.4, (f, gg) => { if (f.t > 0.3) gg.input.right.buttons.b.down = true; });
  assert.equal(flow.phase, 'appeal');
  run(flow, g, 8);
  assert.equal(flow.done, true);
  assert.equal(flow.out, true);
  assert.deepEqual(flow.result(), { kind: 'caught', by: 'Keeper' });
  // the same catch off the middle of the bat: out by itself, no flow
  const mid = new ContactLog(CONFIG); mid.launchT = 0;
  mid.addBat({ t: 0.6, face: 'front', part: 'blade', local: { x: 0, y: -0.6, z: 0.06 }, speedIn: 30 },
    { bladeHalf: { x: 0.07, z: 0.025 }, toeY: -0.79, shoulderY: -0.18, handleTopY: 0.12, sweetY: -0.62, faceZ: 0.025, handleRadius: 0.017 });
  mid.lastBall = { x: 20, y: 1, z: -30 };
  const g2 = stubGame({ contacts: mid });
  assert.equal(new LbwFlow(g2, new Reviews(2)).caught({ kind: 'caught', by: 'Mid-off' }, { notOut: { kind: 'runs', runs: 0 }, playerIsBatter: false }), false);
});
