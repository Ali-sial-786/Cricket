// The presentation beats (src/game/ceremony.js) never change what is played:
// a one-over match played through the real flow (modes.js: the toss, both
// innings, the innings break, the result) with the ceremonies on, cards only,
// off, and on with every beat skipped, gives the same toss, the same sessions
// in the same order, the same scores and the same result; every beat ends by
// itself within its length; with them off nothing of theirs runs at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
// (the cards and the coin draw on canvases: a stand-in document)
const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => ({ addColorStop() {}, width: 10 })), set: (o, k, v) => { o[k] = v; return true; } });
globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, style: {} }) };
const { makeRng } = await import('../src/physics/math.js');
const { ViewFade } = await import('../src/game/replay.js');
const M = await import('../src/game/modes.js');
const { Ceremony, BEATS, beatPlan, playerOfMatch, holdSession } = await import('../src/game/ceremony.js');
const { Innings } = await import('../src/game/scoring.js');
const { Scorecard } = await import('../src/game/scorecard.js');

// A session that plays its innings by itself: a ball every 1.2 s of play (its
// first step, prepare(), is what a beat holds), outcomes from its own dice.
let seed = 0;
class FakeSession {
  constructor(game, o) {
    Object.assign(this, o);
    this.game = game; this.state = 'idle'; this.done = false; this.wait = 0;
    this.isBowling = this.constructor === FakeBowling;
    this.dice = makeRng(1000 + seed++);
  }
  enter() { this.game.log.push(['enter', this.kind, this.title]); }
  exit() {}
  update(dt) {
    if (this.done || !this.innings) return;
    this.wait += dt;
    if (this.wait >= 1.2) { this.wait = 0; this.prepare(); }
  }
  prepare() {
    const r = this.dice(), inn = this.innings;
    if (inn.card && !inn.card.bowler) inn.card.setBowler(this.isBowling ? 'You' : 'M. Okoro');
    inn.record(r < 0.18 ? { wicket: 'bowled' } : { runs: [0, 1, 2, 4, 6][Math.floor(r * 5)], boundary: r > 0.6 && r < 0.8 ? 4 : r >= 0.8 ? 6 : 0 });
    this.game.log.push(['ball', this.kind, inn.scoreText, inn.legal]);
    if (inn.complete) { this.done = true; this.onDone(inn); }
  }
}
class FakeBowling extends FakeSession {}

function fakeGame(mode, { skipAll = false } = {}) {
  const scene = new THREE.Scene();
  const g = {
    settings: { ceremonies: mode, overs: 1, difficulty: 'medium', sound: false, replay: 'off', machine: { paceKmh: 130, spinType: 'none' } },
    rng: makeRng(77), scene, state: 'menu', session: null, simTime: 0, clock: 0, log: [], resultInfo: null, viewOverride: null,
    input: { xr: false, desktop: { took: () => skipAll }, left: { connected: true }, right: { connected: true } },
    eye: { p: new THREE.Vector3(0, 1.6, 0), q: new THREE.Quaternion() },
    ui: { menuOpen: false, quiet: null, page: 'main', closeMenu() { this.menuOpen = false; }, openMenu(p) { this.menuOpen = true; this.page = p; }, boardCard() {}, bigSting() {} },
    startSessionObj(s) { if (this.session) this.endSession(); this.session = s; this.state = 'play'; this.ui.menuOpen = false; s.enter(); },
    endSession() { if (this.session) { this.session.exit(); this.session = null; } },
    showResult(info) { this.resultInfo = info; this.ui.openMenu('result'); this.log.push(['card', info.title]); },
    beginViewOverride(x, z) { this.viewOverride = { x, z }; }, endViewOverride() { this.viewOverride = null; },
    say() {}, sample() {}, cheer() {}, crowdReact() {},
  };
  g.replay = { active: false, pending: null, fade: new ViewFade(scene), skipHand: () => ({ buttons: { trigger: { down: false } } }) };
  g.ceremony = new Ceremony(g);
  return g;
}

// Play a match from the menu (startWithIntro with the ceremonies on; the plain
// start with them off), picking the first choice on every card, to the result.
function playMatch(mode, opts = {}) {
  seed = 0;
  const S = M.SESSIONS, saved = { ...S };
  S.Batting = FakeSession; S.Bowling = FakeBowling;
  try {
    const g = fakeGame(mode, opts), dt = 1 / 72;
    if (mode === 'off') M.startMatch(g); else { g.state = 'play'; M.startWithIntro(g, 'match'); }
    const beats = [];
    let longest = 0, run = 0, cur = null;
    for (let i = 0; i < 72 * 400; i++) {
      g.clock += dt;
      if (!(g.ui.menuOpen && g.session)) g.simTime += dt;
      g.ceremony.input();
      if (g.session && !g.ui.menuOpen) g.session.update(dt, g.simTime);
      g.ceremony.update(dt);
      g.replay.fade.update(g.eye, dt);
      const c = g.ceremony.cur;
      if (c && c !== cur) { beats.push(c.name); run = 0; }
      cur = c;
      run = c ? run + dt : 0;
      if (c) longest = Math.max(longest, run - c.dur);
      if (g.ui.menuOpen && g.resultInfo) {
        const r = g.resultInfo;
        const was = r;
        if (r.choices) r.choices[0].fn(); else if (r.next) r.next(); else break;
        if (g.resultInfo === was && !g.ceremony.active) g.ui.closeMenu();     // (a card that led nowhere new: as if closed)
      }
    }
    return { g, beats, longest, log: g.log.filter((l) => l[0] !== 'card' || /win|tied/i.test(l[1])), result: g.resultInfo && g.resultInfo.title };
  } finally { Object.assign(S, saved); }
}

test('a one-over match: the same toss, sessions, balls, scores and result with the ceremonies on, cards only, off, or every beat skipped', () => {
  const off = playMatch('off');
  assert.ok(off.result && /win|tied/i.test(off.result), `the match ended: ${off.result}`);
  assert.ok(off.log.filter((l) => l[0] === 'enter').length === 2, 'two innings');
  assert.deepEqual(off.beats, [], 'with the ceremonies off nothing of theirs runs');
  for (const [mode, o] of [['on', {}], ['short', {}], ['on', { skipAll: true }]]) {
    const r = playMatch(mode, o);
    assert.deepEqual(r.log, off.log, `${mode}${o.skipAll ? ' (skipped)' : ''}: the same game`);
    assert.equal(r.result, off.result);
    if (process.env.BEATS) console.log(mode, o.skipAll ? 'skipped' : '', r.beats.join(','), r.log.length);
    assert.ok(r.beats.length >= 4, `${mode}: beats played: ${r.beats.join(',')}`);
    assert.ok(r.longest <= 0.05, `${mode}: a beat ran ${r.longest.toFixed(2)} s past its length`);
    assert.equal(r.g.viewOverride, null, 'back where you play at the end');
  }
  const on = playMatch('on');
  for (const b of ['intro', 'toss', 'flip', 'takeField', 'inningsBreak', 'result']) assert.ok(on.beats.includes(b), `the ${b} beat played (${on.beats.join(',')})`);
});

test('a holding beat holds the next delivery and nothing else; it ends by itself or when skipped', () => {
  seed = 0;
  const g = fakeGame('on');
  const inn = new Innings({ balls: 12, wickets: 3, batting: 'player', card: new Scorecard(['A', 'B', 'C', 'D'], { team: 'Harbour Kings' }) });
  const s = holdSession(g, new FakeSession(g, { kind: 'chase', title: 't', innings: inn, onDone: () => {} }));
  g.startSessionObj(s);
  g.ceremony.play('takeField', { begin: () => {} });
  assert.ok(g.ceremony.holding);
  const step = (n) => { for (let i = 0; i < n; i++) { g.clock += 1 / 72; g.simTime += 1 / 72; g.ceremony.input(); s.update(1 / 72); g.ceremony.update(1 / 72); g.replay.fade.update(g.eye, 1 / 72); } };
  step(72 * 2);
  assert.equal(inn.legal, 0, 'no ball while the beat holds');
  step(72 * 3);
  assert.ok(!g.ceremony.active, 'the beat ended by itself');
  step(72 * 2);
  assert.ok(inn.legal > 0, 'play goes on after it');
  // skipped: the off-hand trigger (N on a monitor) ends it at once (after the fade down, if it has you elsewhere)
  g.ceremony.play('result', { winner: 'home' });
  g.input.desktop.took = () => true;
  step(2);
  assert.ok(!g.ceremony.active, 'skipped');
});

test('cards only: the scene cues are left out and the beat is shorter; a beat with no short version just runs its calls', () => {
  for (const [name, beat] of Object.entries(BEATS)) {
    const on = beatPlan(beat, 'on', { toss: true, behind: true, newBatter: true }), sh = beatPlan(beat, 'short', { toss: true, behind: true, newBatter: true });
    assert.equal(sh.steps.filter((s) => s.scene).length, 0, name);
    assert.ok(sh.dur <= on.dur, name);
    assert.ok(on.steps.every((s) => s.t <= on.dur) && sh.steps.every((s) => s.t <= sh.dur), `${name}: every cue inside the beat`);
  }
  const g = fakeGame('short');
  let called = 0, done = 0;
  g.ceremony.play('toss', {}, () => done++);
  assert.equal(done, 1, 'the toss scene has no cards-only version');
  g.ceremony.play('takeField', { begin: () => called++ }, () => done++);
  for (let i = 0; i < 72 * 3; i++) g.ceremony.update(1 / 72);
  assert.equal(called, 1, 'its call made');
  assert.equal(done, 2, 'and over within its short length');
  g.settings.ceremonies = 'off';
  g.ceremony.play('takeField', { begin: () => called++ }, () => done++);
  assert.equal(called, 2, 'off: the call at once');
  assert.equal(done, 3);
});

test('player of the match: the best performance of the game, a tie to the winners', () => {
  const a = new Scorecard(['A. One', 'B. Two', 'C. Three'], { team: 'Harbour Kings' });
  a.setBowler('X. Bowl');
  for (const o of [{ runs: 4, boundary: 4 }, { runs: 6, boundary: 6 }, { runs: 1 }, { runs: 2 }, { wicket: 'bowled' }]) a.record(o, {});
  const b = new Scorecard(['P. Four', 'Q. Five'], { team: 'Summit Stars' });
  b.setBowler('You');
  for (const o of [{ wicket: 'caught' }, { runs: 0 }, { wicket: 'bowled' }, { runs: 1 }]) b.record(o, {});
  const p = playerOfMatch([{ card: a }, { card: b }], 'Harbour Kings');
  assert.equal(p.name, 'You', JSON.stringify(p));
  assert.equal(p.team, 'Harbour Kings');
  assert.match(p.text, /^2\/0/);
  assert.equal(playerOfMatch([]), null);
});

test('the strap never goes over a figure near you: the first clear slot to the side, or none (the big screen has it)', async () => {
  const { Humanoid } = await import('../src/render/humanoid.js');
  const g = fakeGame('on'), C = g.ceremony, saved = Humanoid.all.slice();
  const man = (x, z) => ({ root: { visible: true, position: { x, y: 0, z } }, fade: 1 });
  const eye = new THREE.Vector3(0, 1.6, 0), fwd = new THREE.Vector3(0, 0, -1);
  try {
    Humanoid.all.length = 0;
    assert.deepEqual(C.strapSlot(eye, fwd, 2, 0.38, {}).yaw, 0, 'nobody about: straight ahead');
    Humanoid.all.push(man(0, -3));
    const s = C.strapSlot(eye, fwd, 2, 0.38, {});
    assert.ok(s && Math.abs(s.yaw) > 0.2, `a man in front: to one side (${s && s.yaw})`);
    for (let a = -1.2; a <= 1.2; a += 0.15) Humanoid.all.push(man(Math.sin(a) * 3, -Math.cos(a) * 3));
    assert.equal(C.strapSlot(eye, fwd, 2, 0.38, {}), null, 'a ring of people: no strap');
  } finally { Humanoid.all.length = 0; Humanoid.all.push(...saved); }
});

test('every beat leaves nothing behind: no walkers, no borrowed marks, the coin and the strap gone', () => {
  const r = playMatch('on');
  const C = r.g.ceremony;
  assert.equal(C.stageBusy(), false);
  assert.equal(C.coin.mesh.visible, false);
  assert.ok(!C.cardOn);
  assert.equal(C.cast, null);
});
