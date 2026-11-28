// Which balls the game queues a replay for (src/game/replay.js Replay.schedule,
// with replayDirector.js classify), what the session tells it (note), and the
// last ball again on demand (againReady).
import { test } from 'node:test';
import assert from 'node:assert/strict';
// (the replay's module draws its labels on a canvas when it loads: a stand-in document)
const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => ({ addColorStop() {} })), set: (o, k, v) => { o[k] = v; return true; } });
globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, style: {} }) };
const { Replay } = await import('../src/game/replay.js');

function replay(mode, session = { state: 'settle', isBowling: false }) {
  const R = Object.create(Replay.prototype);
  Object.assign(R, { g: { settings: mode == null ? {} : { replay: mode }, state: 'play', session, ui: { menuOpen: false }, quickSkip: { busy: false } }, marks: {}, pending: null, active: false, count: 0 });
  return R;
}
// One ball: released at 10, its result noted by the session, dead at 12.
function ball(R, res, outcome = {}, extra = {}) {
  R.mark('release', 10);
  Object.assign(R.marks, extra);
  R.note(res, { runs: 0, wicket: null, boundary: 0, ...outcome });
  return R.schedule(12);
}

test('highlights (the default, and old saves): wickets, boundaries and close calls are replayed; leaves, dots and singles are not', () => {
  for (const mode of [null, 'highlights', 'bowler']) {
    assert.equal(ball(replay(mode), { kind: 'left' }), false, `${mode}: a leave`);
    assert.equal(ball(replay(mode), { kind: 'runs', runs: 0 }), false, `${mode}: a dot`);
    assert.equal(ball(replay(mode), { kind: 'runs', runs: 1 }, { runs: 1 }), false, `${mode}: a single`);
    assert.equal(ball(replay(mode), { kind: 'bowled' }, { wicket: 'bowled' }), true, `${mode}: bowled`);
    assert.equal(ball(replay(mode), { kind: 'boundary', runs: 4 }, { runs: 4, boundary: 4 }), true, `${mode}: a four`);
    assert.equal(ball(replay(mode), { kind: 'runs', runs: 1 }, { runs: 1 }, { dropT: 11 }), true, `${mode}: a drop`);
    assert.equal(ball(replay(mode), { kind: 'beaten', padded: true }, {}, { review: 10.7 }), true, `${mode}: an lbw shout`);
  }
  const R = replay('highlights');
  ball(R, { kind: 'boundary', runs: 6 }, { runs: 6, boundary: 6 });
  assert.equal(R.marks.story, 'six'); assert.equal(R.marks.tier, 'boundary');
  assert.ok(R.pending && R.pending.at >= 12 + 1.0, 'it waits for its aftermath on the tape');
});

test('every ball replays them all; off none (and a ball already replayed is not queued again)', () => {
  for (const res of [{ kind: 'left' }, { kind: 'runs', runs: 1 }, { kind: 'bowled' }]) {
    assert.equal(ball(replay('every'), res, res.kind === 'bowled' ? { wicket: 'bowled' } : {}), true, `every: ${res.kind}`);
    assert.equal(ball(replay('off'), res, res.kind === 'bowled' ? { wicket: 'bowled' } : {}), false, `off: ${res.kind}`);
  }
  const R = replay('every');
  R.mark('release', 10); R.marks.played = true;
  assert.equal(R.schedule(12), false);
});

test('the last ball again: between balls (the result; batting, the walk back too), never in a decision, a menu, a skip or a replay', () => {
  const R = replay('highlights');
  ball(R, { kind: 'left' });
  R.count = 10;
  R.marks.dead = 11;
  assert.equal(R.againReady(), true, 'the result');
  R.g.session = { state: 'idle', isBowling: false }; assert.equal(R.againReady(), true, 'batting, between balls');
  R.g.session = { state: 'idle', isBowling: true }; assert.equal(R.againReady(), false, 'bowling at your mark: A / B pick the delivery');
  R.g.session = { state: 'runup', isBowling: false }; assert.equal(R.againReady(), false, 'the bowler has set off');
  R.g.session = { state: 'review', isBowling: false }; assert.equal(R.againReady(), false, 'an appeal / review');
  R.g.session = { state: 'settle', isBowling: false };
  R.g.ui.menuOpen = true; assert.equal(R.againReady(), false, 'a menu'); R.g.ui.menuOpen = false;
  R.g.quickSkip.busy = true; assert.equal(R.againReady(), false, 'skipping'); R.g.quickSkip.busy = false;
  R.active = true; assert.equal(R.againReady(), false, 'a replay on'); R.active = false;
  R.pending = { at: 13 }; assert.equal(R.againReady(), false, 'its own replay still to come'); R.pending = null;
  R.marks = {}; assert.equal(R.againReady(), false, 'no ball yet');
});

test('read off the tape: a lofted shot down by a fielder, a hard hit stopped by the rope, a ball past the batter\'s head', () => {
  // a stand-in tape: the ball's place as a function of tape time, the figures fixed
  const tapeOf = (pos, people) => { const R = replay('highlights'); R.tapeBall = (t, o) => { const p = pos(t); o.x = p[0]; o.y = p[1]; o.z = p[2]; return true; }; R.bodiesAt = () => people; return R; };
  const man = (x, z) => ({ a: { x, y: 1.85, z }, b: { x, y: 0.95, z }, c: { x, y: 0.05, z } });
  // lofted 2.5 s to 25 m away, up 7.5 m, coming down 3 m from a fielder (and in a gap)
  const loft = (t) => { const u = Math.max(0, t - 10); return u < 2.5 ? [0, Math.max(0.036, 12 * u - 4.9 * u * u), -25 * u / 2.5] : [0, 0.036, -25]; };
  assert.ok(tapeOf(loft, [man(2, -27)]).flight(10, 14).safeT > 12, 'down by a fielder');
  assert.equal(tapeOf(loft, [man(20, -27)]).flight(10, 14).safeT, null, 'down in a gap');
  // 30 m/s along the ground, stopped 62 m from the middle
  const hard = (t) => { const u = Math.max(0, t - 10), d = Math.min(30 * u, 52); return [d, 0.036, -10.06]; };
  assert.ok(tapeOf(hard, []).flight(10, 14).savedT > 11.5, 'stopped by the rope');
  const soft = (t) => { const u = Math.max(0, t - 10), d = Math.min(12 * u, 52); return [d, 0.036, -10.06]; };
  assert.equal(tapeOf(soft, []).flight(10, 14).savedT, null, 'not hit hard');
  // a bouncer 20 cm past the striker's head (the figure at the crease)
  const R = tapeOf((t) => [0.35 + 0.12 + 0.036 + 0.02, 1.85 - 0.12, -1.4 + 25 * (t - 10)], [man(0.35, -0.4)]);
  const gap = R.headGap(10.04, false);
  assert.ok(gap != null && gap < 0.3, `past the head by ${gap}`);
});

test('the over\'s tally: the second four of an over gets take 1 only, a second close call none; a new over starts afresh', () => {
  const R = replay('highlights');
  const four = () => { ball(R, { kind: 'boundary', runs: 4 }, { runs: 4, boundary: 4 }); const n = R.marks.maxTakes; R.pending = null; return n; };
  const edge = () => { ball(R, { kind: 'runs', runs: 0 }, {}, { edge: true }); const n = R.marks.maxTakes; R.pending = null; return n; };
  assert.equal(four(), 2); assert.equal(four(), 1); assert.equal(edge(), 1); assert.equal(edge(), 0);
  four(); four();                                   // (balls 5 and 6)
  assert.equal(four(), 2, 'a new over');
});
