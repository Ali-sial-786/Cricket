// Skip to the next ball (src/game/quickSkip.js): when a press may skip, the
// press itself (fresh, used up, never a held one), the fade down to dark and
// back, and what the sessions do with it (skipToNext): straight to the next
// delivery, never past the end of an innings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuickSkip, skipAllowed, decisionPending, SKIP } from '../src/game/quickSkip.js';
import { Innings } from '../src/game/scoring.js';
// (the replay's module draws its labels on a canvas when it loads: a stand-in document)
const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => ({ addColorStop() {} })), set: (o, k, v) => { o[k] = v; return true; } });
globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, style: {} }) };
const { Controller } = await import('../src/xr/input.js');
const { ViewFade } = await import('../src/game/replay.js');
const { BattingSession } = await import('../src/game/batting.js');
const { BowlingSession } = await import('../src/game/bowling.js');

const base = { gameState: 'play', hasSession: true, done: false, menuOpen: false, decision: false, replayActive: false, isBowling: false, state: 'settle' };

test('a press may skip once the ball is dead: the result, the replay, between balls; never before or during a delivery', () => {
  assert.equal(skipAllowed(base), true, 'batting: the result');
  assert.equal(skipAllowed({ ...base, state: 'idle' }), true, 'batting: between balls (the walk back)');
  assert.equal(skipAllowed({ ...base, replayActive: true }), true, 'the replay');
  for (const st of ['live', 'runup', 'cue', 'review']) assert.equal(skipAllowed({ ...base, state: st }), false, `batting: ${st}`);
  assert.equal(skipAllowed({ ...base, isBowling: true }), true, 'bowling: the result');
  for (const st of ['ready', 'live', 'review']) assert.equal(skipAllowed({ ...base, isBowling: true, state: st }), false, `bowling: ${st}`);
  assert.equal(skipAllowed({ ...base, menuOpen: true }), false, 'a menu open');
  assert.equal(skipAllowed({ ...base, decision: true }), false, 'an appeal / review');
  assert.equal(skipAllowed({ ...base, decision: true, replayActive: true }), false);
  assert.equal(skipAllowed({ ...base, done: true }), false, 'the innings is over');
  assert.equal(skipAllowed({ ...base, gameState: 'menu' }), false);
  assert.equal(skipAllowed({ ...base, hasSession: false }), false);
});

test('a decision is pending during an appeal, a review, the third umpire, or whenever the session says so', () => {
  assert.equal(decisionPending(null), false);
  assert.equal(decisionPending({ state: 'settle', lbw: { active: false }, third: { active: false }, reviewFlow: null }), false);
  assert.equal(decisionPending({ state: 'review' }), true);
  assert.equal(decisionPending({ state: 'settle', lbw: { active: true } }), true);
  assert.equal(decisionPending({ state: 'settle', third: { active: true } }), true);
  assert.equal(decisionPending({ state: 'settle', reviewFlow: {} }), true);
  assert.equal(decisionPending({ state: 'settle', decisionPending: () => true }), true, 'an appeal of the DRS flow');
  assert.equal(decisionPending({ state: 'settle', decisionPending: () => false }), false);
});

test('the fade goes down to dark from where it is, stays dark, and cut() brings the view back in', () => {
  const f = Object.create(ViewFade.prototype);
  Object.assign(f, { mesh: { visible: false, material: { opacity: 0 }, position: { copy() {} }, quaternion: { copy() {} } }, left: 0, sec: 1, outSec: 0, outT: 0 });
  const eye = { p: {}, q: {} };
  f.fadeOut(0.25);
  assert.equal(f.level, 0);
  for (let i = 0; i < 9; i++) f.update(eye, 1 / 72);
  assert.ok(f.level > 0.45 && f.level < 0.55 && !f.dark, `half way: ${f.level}`);
  for (let i = 0; i < 12; i++) f.update(eye, 1 / 72);
  assert.ok(f.dark && f.level === 1, 'dark');
  for (let i = 0; i < 30; i++) f.update(eye, 1 / 72);
  assert.ok(f.dark, 'stays dark');
  f.cut(0.25);
  assert.ok(!f.fadingOut && f.level === 1);
  for (let i = 0; i < 20; i++) f.update(eye, 1 / 72);
  assert.equal(f.level, 0, 'back in');
  // from part way in: down from there
  f.cut(0.25); f.update(eye, 0.125); f.fadeOut(0.25);
  assert.ok(Math.abs(f.level - 0.5) < 1e-9);
});

// A game with just enough for QuickSkip: a session that records skipToNext.
function fakeGame({ state = 'settle', isBowling = false, xr = true } = {}) {
  const L = new Controller('left'), R = new Controller('right');
  L.connected = R.connected = true;
  const fade = { level: 0, outSec: 0, cut(sec) { this.outSec = 0; this.level = 1; this.cutSec = sec; }, fadeOut(sec) { this.outSec = sec; }, get fadingOut() { return this.outSec > 0; }, get dark() { return this.outSec > 0 && this.level >= 1; } };
  const g = {
    state: 'play', clock: 10, mainHand: 'right', coachSeen: new Set(['skip']), coach() {},
    input: { xr, left: L, right: R, desktop: { took: () => false } },
    ui: { menuOpen: false, clearHints() {}, prompt() {} },
    replay: { active: false, pending: { at: 5 }, marks: { release: 1 }, fade, skipHand: () => L, stop() { this.active = false; this.stopped = true; } },
    session: { state, isBowling, done: false, calls: 0, skipToNext(hold) { this.calls++; this.hold = hold; this.state = isBowling ? 'ready' : 'idle'; return 'next'; } },
  };
  return { g, L, fade };
}
const frame = (q, g, n = 1) => { for (let i = 0; i < n; i++) { g.clock += 1 / 72; q.update(1 / 72); } };
const press = (b, on) => b.set(on);

test('one fresh press: dark over 0.25 s, then everything is put in place and the view comes back in; the press is used up', () => {
  const { g, L, fade } = fakeGame();
  const q = new QuickSkip(g);
  press(L.buttons.trigger, true);
  frame(q, g);
  assert.equal(q.phase, 'out');
  assert.equal(fade.outSec, SKIP.out);
  assert.equal(L.buttons.trigger.pressed, false, 'swallowed: reads as up');
  press(L.buttons.trigger, true); frame(q, g);
  assert.equal(L.buttons.trigger.down, false, 'held on: still nothing');
  assert.equal(g.session.calls, 0, 'nothing moves until it is dark');
  fade.level = 1; frame(q, g);
  assert.equal(g.session.calls, 1);
  assert.equal(g.session.hold, SKIP.in, 'the next delivery starts as the view clears');
  assert.equal(g.replay.pending, null, 'the replay that was due is gone');
  assert.equal(g.replay.marks.played, true);
  assert.equal(q.phase, 'in');
  assert.equal(fade.cutSec, SKIP.in);
  frame(q, g, Math.ceil(SKIP.in * 72) + 1);
  assert.equal(q.phase, null);
  assert.equal(g.session.calls, 1, 'once');
});

test('a trigger already held when the ball goes dead (a dive) does not skip; it takes a fresh press', () => {
  const { g, L } = fakeGame({ state: 'live' });
  const q = new QuickSkip(g);
  press(L.buttons.trigger, true); frame(q, g);               // the dive, held
  g.session.state = 'settle';
  for (let i = 0; i < 60; i++) { press(L.buttons.trigger, true); frame(q, g); }
  assert.equal(q.phase, null, 'held through the end of the ball: no skip');
  press(L.buttons.trigger, false); frame(q, g);
  press(L.buttons.trigger, true); frame(q, g);
  assert.equal(q.phase, 'out', 'a fresh press skips');
});

test('during a replay one press stops it and goes to the next ball; nothing with a menu open or a decision pending', () => {
  const r = fakeGame({ state: 'settle' }); r.g.replay.active = true;
  const q = new QuickSkip(r.g);
  press(r.L.buttons.trigger, true); frame(q, r.g);
  r.fade.level = 1; frame(q, r.g);
  assert.ok(r.g.replay.stopped && r.g.session.calls === 1);
  const m = fakeGame(); m.g.ui.menuOpen = true;
  const q2 = new QuickSkip(m.g);
  press(m.L.buttons.trigger, true); frame(q2, m.g);
  assert.equal(q2.phase, null);
  const d = fakeGame(); d.g.session.decisionPending = () => true;
  const q3 = new QuickSkip(d.g);
  press(d.L.buttons.trigger, true); frame(q3, d.g);
  assert.equal(q3.phase, null);
  // a menu opened while it goes dark: back in, nothing skipped
  const o = fakeGame(); const q4 = new QuickSkip(o.g);
  press(o.L.buttons.trigger, true); frame(q4, o.g);
  o.g.ui.menuOpen = true; o.fade.level = 1; frame(q4, o.g);
  assert.equal(o.g.session.calls, 0);
  assert.equal(q4.phase, null);
});

test('the right trigger (the bat hand) does not skip; with the bat in the left hand the right one does', () => {
  const { g, L } = fakeGame();
  const q = new QuickSkip(g);
  press(g.input.right.buttons.trigger, true); frame(q, g);
  assert.equal(q.phase, null);
  g.replay.skipHand = () => g.input.right;
  press(g.input.right.buttons.trigger, false); frame(q, g);
  press(g.input.right.buttons.trigger, true); frame(q, g);
  assert.equal(q.phase, 'out');
  void L;
});

// ---- the sessions
function batGame() {
  const calls = [];
  const g = {
    simTime: 100, realDt: 1 / 72, clock: 0, rigOffset: { x: 0, z: 0 }, rng: () => 0.5,
    input: { xr: true, right: { connected: false }, headPose: { p: { x: 0, y: 1.6, z: 0 } } },
    world: { ball: { padded: false, active: false, batted: false }, removeBall() { calls.push('removeBall'); }, resetWickets() {} },
    stumps: { batting: { reset() { calls.push('stumps'); } }, bowling: { reset() {} } },
    diff: { timeScale: 1 }, machine: { setCue() {} }, umpires: { setLook() {}, place() {}, signal() {} },
    ballView: { visible: true, setVisible(v) { this.visible = v; }, clearTrail() {} }, settings: { autoFeed: true, difficulty: 'medium' },
    replay: { pending: null }, say() {},
    ui: { setHud() {}, setBoard() {}, prompt(t, secs) { calls.push(['prompt', t, secs]); } },
  };
  return { g, calls };
}

test('batting: from the result straight to the next ball - everyone placed, the stumps up, the ball gone, the run-up after `hold` s', () => {
  const { g, calls } = batGame(), inn = new Innings({ balls: 30, wickets: 5, target: 48 });
  const s = new BattingSession(g, { kind: 'chase', innings: inn });
  const did = [];
  s.field = { settleNow: () => did.push('field'), settled: () => true, update() {} };
  s.bowlerFig = { placeAtMark: () => did.push('bowler'), atMark: () => true, update() {} };
  s.planNext = () => { did.push('plan'); s.planned = { settings: {}, delivery: {} }; };
  s.prepare = () => { s.state = 'runup'; s.prepared = g.simTime; };
  s.announce = () => { s.announced = true; return false; };
  s.state = 'settle'; s.timer = 3.0;
  assert.equal(s.skipToNext(0.25), 'next');
  assert.equal(s.state, 'idle');
  assert.deepEqual(did, ['plan', 'field', 'bowler'], 'the next ball decided first, then everyone put where it needs him');
  assert.ok(calls.includes('stumps') && calls.includes('removeBall') && !g.ballView.visible);
  assert.equal(s.timer, 0.25);
  const t0 = g.simTime;
  for (let i = 0; i < 60 && s.state === 'idle'; i++) { g.simTime += 1 / 72; s.update(1 / 72, g.simTime); }
  assert.equal(s.state, 'runup');
  assert.ok(s.prepared - t0 >= 0.24 && s.prepared - t0 < 0.3, `the run-up ${(s.prepared - t0).toFixed(3)} s after`);
});

test('batting: a new bowler or a free hit gets its card for 1 s (not 1.8)', () => {
  const { g, calls } = batGame(), inn = new Innings({ balls: 30, wickets: 5, target: 48 });
  inn.freeHit = true;
  const s = new BattingSession(g, { kind: 'chase', innings: inn });
  s.field = { settleNow() {}, settled: () => true, update() {}, setSpinner() {} };
  s.planned = { settings: { newBowler: true, bowler: 'R. Thunder', bowlerLabel: 'Fast' }, delivery: {} };
  s.state = 'settle';
  s.skipToNext(0.25);
  const p = calls.find((c) => Array.isArray(c) && c[0] === 'prompt');
  assert.ok(p && /R\. Thunder/.test(p[1]) && /FREE HIT/.test(p[1]), JSON.stringify(p));
  assert.equal(s.timer, 1.0);
});

test('batting: never past the end of the innings - the skip goes to its end, no ball after it', () => {
  const { g } = batGame(), inn = new Innings({ balls: 30, wickets: 5, target: 48 });
  for (let i = 0; i < 5; i++) inn.record({ wicket: 'caught' });
  let done = 0;
  const s = new BattingSession(g, { kind: 'chase', innings: inn, onDone: () => done++ });
  s.prepare = () => { throw new Error('a ball after the innings'); };
  s.state = 'settle';
  assert.equal(s.skipToNext(0.25), 'done');
  assert.equal(done, 1);
  assert.equal(s.done, true);
  assert.equal(s.skipToNext(0.25), null);
  assert.equal(done, 1);
});

test('batting: nothing to skip once the next delivery has started', () => {
  const { g } = batGame();
  const s = new BattingSession(g, { kind: 'nets' });
  for (const st of ['cue', 'runup', 'live', 'review']) { s.state = st; assert.equal(s.skipToNext(0.25), null, st); assert.equal(s.state, st); }
  // the machine without auto-feed: its countdown starts at once (no wait for X)
  g.settings.autoFeed = false;
  s.state = 'settle'; s.planNext = () => { s.planned = { settings: {}, delivery: {} }; };
  assert.equal(s.skipToNext(0.25), 'next');
  assert.equal(s.timer, 0);
});

test('bowling: from the result back on your mark with the next ball; the end of the innings is not skipped past', () => {
  const s = Object.create(BowlingSession.prototype);
  const did = [];
  Object.assign(s, { game: { ballView: { clearTrail() {} } }, state: 'settle', done: false, keeperUp: false, innings: null });
  s.field = { setSpinner: () => did.push('spinner'), settleNow: () => did.push('field') };
  s.nextBall = () => { did.push('next'); s.state = 'ready'; };
  assert.equal(s.skipToNext(), 'next');
  assert.deepEqual(did, ['spinner', 'field', 'next']);
  assert.equal(s.skipToNext(), null, 'ready: nothing to skip');
  const inn = new Innings({ balls: 6, wickets: 5, target: 12, batting: 'ai' });
  for (let i = 0; i < 6; i++) inn.record({ runs: 0 });
  let done = 0;
  Object.assign(s, { state: 'settle', innings: inn, onDone: () => done++ });
  assert.equal(s.skipToNext(), 'done');
  assert.equal(done, 1);
});
