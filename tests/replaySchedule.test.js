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
