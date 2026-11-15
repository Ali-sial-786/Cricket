// The end of an innings: the wicket limit ends it at once (never "-1 wkts
// left", never another ball), however quickly the next ball is asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Innings, wicketsForOvers } from '../src/game/scoring.js';
import { BattingSession } from '../src/game/batting.js';

test('innings: a 5-wicket chase is over at the 5th wicket, and wickets left never go below 0', () => {
  const inn = new Innings({ balls: 30, wickets: wicketsForOvers(5), target: 48 });
  assert.equal(inn.wicketsLimit, 5);
  for (let i = 0; i < 4; i++) { inn.record({ wicket: 'caught' }); assert.equal(inn.complete, false, `over after ${i + 1}`); }
  assert.equal(inn.wicketsLeft, 1);
  inn.record({ runs: 2 });
  assert.equal(inn.complete, false);
  inn.record({ wicket: 'caught' });
  assert.equal(inn.complete, true);
  assert.equal(inn.wicketsLeft, 0);
  assert.equal(inn.chaseResult, 'lost');
  inn.wickets = 6;                                    // (whatever happened, the board never reads -1)
  assert.equal(inn.wicketsLeft, 0);
});

// A batting session driven by hand: just enough of a game for its between-balls states.
function fakeGame({ replayAt = null } = {}) {
  const g = {
    simTime: 100, realDt: 1 / 72, rigOffset: { x: 0, z: 0 },
    input: { xr: false, right: { connected: false }, headPose: { p: { x: 0, y: 1.6, z: 0 } } },
    world: { ball: { padded: false, active: false, batted: false } },
    diff: { timeScale: 1 }, machine: { setCue() {} }, umpires: { setLook() {}, place() {} },
    ballView: { visible: false }, settings: { autoFeed: true, difficulty: 'medium' },
    replay: { pending: replayAt != null ? { at: replayAt } : null },
    ui: { setHud() {}, setBoard() {}, prompt() {} },
  };
  return g;
}
function session(g, inn) {
  const s = new BattingSession(g, { kind: 'chase', innings: inn, onDone: () => { s.doneCalls = (s.doneCalls || 0) + 1; } });
  s.prepare = () => { s.prepared = (s.prepared || 0) + 1; s.state = 'parked'; };   // (no delivery in this test)
  s.planNext = () => { s.planned = { settings: {} }; };
  s.announce = () => false;
  s.peopleReady = () => true;
  return s;
}
// (the replay, when one is pending, plays once it is due and is then done)
const step = (g, s, n = 1, dt = 1 / 72) => { for (let i = 0; i < n; i++) { g.simTime += dt; if (g.replay.pending && g.simTime >= g.replay.pending.at) g.replay.pending = null; s.update(dt, g.simTime); } };

test('batting session: the next ball asked for during the last wicket\'s result ends the innings, never bowls again', () => {
  const g = fakeGame(), inn = new Innings({ balls: 30, wickets: 5, target: 48 });
  for (let i = 0; i < 5; i++) inn.record({ wicket: 'caught' });
  const s = session(g, inn);
  s.state = 'settle'; s.timer = 3.0;
  s.requestNext();                                     // X at once
  assert.equal(s.state, 'settle', 'skipped the end-of-innings check');
  step(g, s, 3);
  assert.equal(s.doneCalls, 1, 'innings not completed');
  assert.equal(s.prepared, undefined, 'a ball was bowled after the innings was over');
  step(g, s, 200);
  assert.equal(s.doneCalls, 1);
  assert.equal(s.prepared, undefined);
});

test('batting session: an innings found complete between balls ends instead of bowling', () => {
  const g = fakeGame(), inn = new Innings({ balls: 30, wickets: 5, target: 48 });
  for (let i = 0; i < 5; i++) inn.record({ wicket: 'bowled' });
  const s = session(g, inn);
  s.state = 'idle'; s.timer = 0;
  step(g, s, 5);
  assert.equal(s.doneCalls, 1);
  assert.equal(s.prepared, undefined);
});

test('batting session: X during the result waits for the replay to be due (the whole play on its tape), then the next ball comes', () => {
  const g = fakeGame({ replayAt: 101.05 }), inn = new Innings({ balls: 30, wickets: 5, target: 48 });
  inn.record({ runs: 1 });
  const s = session(g, inn);
  s.state = 'settle'; s.timer = 3.0;
  g.simTime = 100.2;
  s.requestNext();
  assert.equal(s.state, 'settle');
  assert.ok(Math.abs(s.timer - 0.85) < 1e-9, `timer ${s.timer}`);
  // still settling (the replay starts on its own at 101.05) until then
  while (g.simTime < 101.0) { step(g, s); assert.equal(s.state, 'settle', `left settle at ${g.simTime.toFixed(3)}`); }
  step(g, s, 10);
  assert.equal(s.state, 'parked');                     // then straight on (no 1e9 wait, no second X)
  assert.equal(s.prepared, 1);
  assert.equal(s.doneCalls, undefined);
});

test('batting session: without a replay pending, X during the result goes straight on (nets without auto-feed too)', () => {
  const g = fakeGame(); g.settings.autoFeed = false;
  const s = new BattingSession(g, { kind: 'nets' });
  s.prepare = () => { s.prepared = (s.prepared || 0) + 1; s.state = 'parked'; };
  s.planNext = () => { s.planned = { settings: {} }; };
  s.announce = () => false;
  s.peopleReady = () => true;
  s.state = 'settle'; s.timer = 2.0;
  s.requestNext();
  step(g, s, 4);
  assert.equal(s.prepared, 1);
});

test('batting session: between balls it waits for the last ball\'s replay before the next delivery', () => {
  const g = fakeGame({ replayAt: 103 }), inn = new Innings({ balls: 30, wickets: 5, target: 48 });
  const s = session(g, inn);
  s.state = 'idle'; s.timer = 0;
  const hold = g.replay.pending;
  for (let i = 0; i < 30; i++) { g.simTime += 1 / 72; g.replay.pending = hold; s.update(1 / 72, g.simTime); }
  assert.equal(s.prepared, undefined, 'bowled before the replay');
  g.replay.pending = null;
  step(g, s, 3);
  assert.equal(s.prepared, 1);
});

