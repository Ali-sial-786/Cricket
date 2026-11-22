// Match presentation: the short scripted beats between pieces of play, the
// way a broadcast does them. The ground revealed from the pavilion with the
// title card, the toss in the middle with a real coin, the teams taking the
// field, a wicket (the celebration, the walk-off card, the new batter), the
// end of an over, the innings break and the result.
//
// Each beat is one small table of timed cues (BEATS: seconds from its start;
// `scene` cues are left out when Settings -> Ceremonies is 'short', which
// keeps only the cards; `ts` is a cue's time in the short version). A beat:
//   * moves you only by a fade and a cut (game.beginViewOverride under the
//     replay's fade), to a fixed spot (SPOTS), never flown; you can look round;
//   * is skipped by the off-hand trigger (N / Space on a monitor): down to
//     dark, its remaining state cues done (a cut back, the session started),
//     back in; and it ends by itself after `dur` s;
//   * `hold`: while it plays the next delivery waits (the session is held at
//     its first step, holdSession: nothing in its rules or its scoring sees a
//     beat) and your inputs to play are ignored;
//   * runs on real time, never touches game.rng (the coin's tumble has its
//     own dice), and with Ceremonies 'off' nothing here runs at all: the flow
//     code (modes.js) takes its old path.
// The in-play beats are found by watching the innings (update(): a wicket,
// an over done) and wait for the ball's replay, a review, a skip to finish.
import * as THREE from 'three';
import { CanvasPanel, fitText } from '../ui/panel.js';
import { C, font, rr, slant, vgrad, hgrad, caps, chip, teamBlock, teamByName, ballDot, drawIcon } from '../ui/theme.js';
import { GATE, STRIKER_SPOT, walkTask } from '../render/crew.js';
import { noteCrowd } from '../render/gestures.js';
import { decisionPending } from './quickSkip.js';
import { SQUADS } from './squad.js';
import { PITCH } from '../physics/pitch.js';
import { makeRng } from '../physics/math.js';

export const CEREMONIES = ['on', 'short', 'off'];
export const CEREMONY_NAMES = { on: 'full', short: 'cards only', off: 'off' };
export const VENUE = 'Harbourside Oval';
const HOME = SQUADS.home, AWAY = SQUADS.away;
const CZ = PITCH.centerZ;
const PI = Math.PI;

// Where a beat puts you (x, z: your head; dx, dz: the way you face).
const toward = (x, z, tx, tz) => { const dx = tx - x, dz = tz - z, d = Math.hypot(dx, dz) || 1; return { x, z, dx: dx / d, dz: dz / d }; };
export const SPOTS = {
  pavilion: toward(24, CZ + 3, 0, CZ),                  // on the outfield in front of the pavilion, the middle and the far stands before you
  toss: { x: -1.25, z: CZ + 1.2, dx: 1, dz: 0 },      // on the square, the other captain in front of you, the pavilion behind him
};
// The toss: who stands where (heading: Actor convention, atan2(dirX, dirZ)) and where the coin comes down.
const TOSS = { captain: { x: 0.5, z: CZ + 1.2, face: -PI / 2 }, umpire: { x: 1.0, z: CZ + 2.5, face: Math.atan2(-1.05, -1.25) }, coin: { x: -0.05, z: CZ + 1.25 } };
const CAPTAIN = 4;                // the fielder figure who is the other captain at the toss (mid-off: a cap, no pads)
const TAKE_FIELD_RUN = 12;        // m: the fielders come out this far from their marks (a jog), from the pavilion side
const WALK_OUT = 14;              // m: the batters walk out from this far (and a new batter runs in from no further: hurryIn)
const WICKET_DELAY = 1.0;         // game s after a wicket before its beat may start (the field gets together)
const SKIP_OUT = 0.2, SKIP_IN = 0.35;

// ---------------------------------------------------------------- the beats
// cue: fade {out|in: s} · vantage {spot} · clear (back where you play, the toss
// figures gone) · cast (the toss figures out) · card {card} · cardOff · board
// {board} · sting {sting} · sound {name} · crowd {mood} · coin · call {fn: a
// ctx function} · arrange (the field coming out) · celebrate · hurryIn.
// wait {for, max}: the beat stands still while that is going on (at most max s).
// if: a ctx flag the cue needs.
export const BEATS = {
  // The first ball of a match / chase / over: the ground from the pavilion, the title.
  intro: { dur: 7.0, short: 2.6, hold: true, steps: [
    { t: 0, cue: 'fade', out: 0.4, scene: 1 },
    { t: 0.42, cue: 'vantage', spot: 'pavilion', scene: 1 },
    { t: 0.42, cue: 'cast', scene: 1, if: 'toss' },
    { t: 0.45, cue: 'fade', in: 1.2, scene: 1 },
    { t: 0.45, cue: 'crowd', mood: 'build', scene: 1 },
    { t: 0.5, ts: 0, cue: 'board', board: 'title' },
    { t: 1.4, ts: 0, cue: 'card', card: 'title', el: -0.3 },         // (low: the middle and the toss figures above it)
    { t: 1.4, ts: 0, cue: 'sting', sting: 'menu' },
    { t: 6.2, ts: 2.4, cue: 'cardOff' },
    { t: 6.55, cue: 'fade', out: 0.4, scene: 1 },
  ] },
  // Cut to the middle: the other captain in front of you, the umpire; then you call (modes.js).
  toss: { dur: 1.3, short: 0, hold: true, steps: [
    { t: 0, cue: 'fade', out: 0.3, scene: 1 },
    { t: 0.32, cue: 'vantage', spot: 'toss', scene: 1 },
    { t: 0.32, cue: 'cast', scene: 1 },
    { t: 0.35, cue: 'fade', in: 0.7, scene: 1 },
    { t: 0.35, cue: 'board', board: 'toss' },
  ] },
  // The coin goes up, lands; the result on the big screen and a card.
  flip: { dur: 4.8, short: 2.6, hold: true, steps: [
    { t: 0, cue: 'coin', scene: 1 },
    { t: 0.5, cue: 'sound', name: 'coin', scene: 1 },
    { t: 2.05, ts: 0, cue: 'sound', name: 'chime' },
    { t: 2.05, ts: 0, cue: 'board', board: 'tossResult' },
    { t: 2.15, ts: 0, cue: 'card', card: 'tossResult', el: -0.3 },
    { t: 2.3, cue: 'crowd', mood: 'murmur', scene: 1 },
    { t: 4.6, ts: 2.4, cue: 'cardOff' },
  ] },
  // An innings starts: back where you play, the fielders jogging out to their
  // marks, the batters walking out, the crowd applauding; then play (the first
  // ball still waits for everyone to be in place, as every ball does).
  takeField: { dur: 4.6, short: 2.4, hold: true, steps: [
    { t: 0, cue: 'fade', out: 0.35, scene: 1 },
    { t: 0.37, cue: 'clear' },
    { t: 0.38, cue: 'call', fn: 'begin' },
    { t: 0.39, cue: 'arrange', scene: 1 },
    { t: 0.42, cue: 'fade', in: 0.8, scene: 1 },
    { t: 0.6, cue: 'crowd', mood: 'applause', scene: 1 },
    { t: 0.9, ts: 0.1, cue: 'card', card: 'innings' },
    { t: 0.9, ts: 0.1, cue: 'board', board: 'innings' },
    { t: 4.4, ts: 2.3, cue: 'cardOff' },
  ] },
  // You are out (batting), after the replay: the fielding side's celebration in
  // view (cut round to it if it is behind you), the dismissal card, the
  // walk-off fade, the new batter's card, back at the crease.
  wicket: { dur: 4.8, short: 3.0, hold: true, steps: [
    { t: 0, cue: 'fade', out: 0.25, scene: 1, if: 'behind' },
    { t: 0.27, cue: 'vantage', spot: 'huddle', scene: 1, if: 'behind' },
    { t: 0.3, cue: 'fade', in: 0.35, scene: 1, if: 'behind' },
    { t: 1.0, ts: 0, cue: 'card', card: 'dismissal', el: -0.22 },   // (low: the huddle stays in view above it)
    { t: 1.0, ts: 0, cue: 'board', board: 'dismissal' },
    { t: 2.9, cue: 'wait', for: 'huddle', max: 2.0, scene: 1 },          // (never fade over the huddle: until it breaks up)
    { t: 3.0, cue: 'fade', out: 0.3, scene: 1 },
    { t: 3.32, cue: 'clear', scene: 1 },
    { t: 3.32, ts: 1.7, cue: 'card', card: 'newBatter' },
    { t: 3.5, cue: 'fade', in: 0.45, scene: 1 },
    { t: 4.6, ts: 2.9, cue: 'cardOff' },
  ] },
  // You took a wicket (bowling): the batter's card, the new man (who comes from nearer: hurryIn).
  wicketTaken: { dur: 4.2, short: 3.2, hold: false, steps: [
    { t: 0, cue: 'card', card: 'dismissal' },
    { t: 0, cue: 'board', board: 'dismissal' },
    { t: 2.4, ts: 1.8, cue: 'card', card: 'newBatter', if: 'newBatter' },
    { t: 4.0, ts: 3.0, cue: 'cardOff' },
  ] },
  // The end of an over: a compact summary, held up long enough to read (the
  // next ball usually waits as long anyway, for the new bowler and the field).
  over: { dur: 2.6, short: 2.6, hold: true, steps: [
    { t: 0, cue: 'card', card: 'over' },
    { t: 0, cue: 'board', board: 'over' },
    { t: 2.45, cue: 'cardOff' },
  ] },
  // A match's innings break: the field empties, the score and the target on the big screen.
  inningsBreak: { dur: 7.4, short: 4.0, hold: true, steps: [
    { t: 0, cue: 'fade', out: 0.4, scene: 1 },
    { t: 0.42, cue: 'call', fn: 'endFirst', scene: 1 },
    { t: 0.42, cue: 'vantage', spot: 'pavilion', scene: 1 },
    { t: 0.45, cue: 'fade', in: 1.0, scene: 1 },
    { t: 0.5, ts: 0, cue: 'board', board: 'break' },
    { t: 0.9, ts: 0, cue: 'card', card: 'break' },
    { t: 1.0, cue: 'crowd', mood: 'applause', scene: 1 },
    { t: 6.8, ts: 3.8, cue: 'cardOff' },
    { t: 6.95, cue: 'fade', out: 0.4, scene: 1 },
  ] },
  // The winning moment held, then the result (the scorecard page follows: modes.js).
  result: { dur: 4.8, short: 2.6, hold: true, steps: [
    { t: 0, cue: 'crowd', mood: 'result' },
    { t: 0, cue: 'celebrate', scene: 1 },
    { t: 0.6, ts: 0, cue: 'board', board: 'result' },
    { t: 1.0, ts: 0, cue: 'card', card: 'result' },
    { t: 4.6, ts: 2.5, cue: 'cardOff' },
  ] },
  // Nets and the bowling nets: a title card, nothing else.
  nets: { dur: 3.4, short: 3.4, hold: false, steps: [
    { t: 0.3, cue: 'card', card: 'nets' },
    { t: 3.2, cue: 'cardOff' },
  ] },
};
// Cues that leave the game in a state (done at once when a beat is skipped); the rest are effects.
const STATE_CUES = new Set(['clear', 'call', 'cardOff', 'arrange']);

export const ceremonyMode = (g) => (g && g.settings && CEREMONIES.includes(g.settings.ceremonies) ? g.settings.ceremonies : 'on');

// The steps of a beat as it plays in this mode, in time order, with its length.
export function beatPlan(beat, mode = 'on', ctx = {}) {
  const short = mode === 'short';
  const dur = short ? beat.short : beat.dur;
  const steps = beat.steps
    .filter((s) => !(short && s.scene) && (!s.if || ctx[s.if]))
    .map((s) => ({ ...s, t: short ? Math.min(dur, s.ts ?? s.t * (beat.short / beat.dur)) : s.t }))
    .sort((a, b) => a.t - b.t);
  return { dur, steps };
}

// Player of the match from a match's innings (Scorecards): runs (a few more
// for a not-out finish, a run for each six) against 20 a wicket less half of
// what the bowler conceded beyond a run a ball; one man's batting and bowling
// add up. A tie goes to the winning side. -> { name, team, text } | null.
export function playerOfMatch(innings, winner = null) {
  const by = new Map();
  const add = (name, team, pts, text) => {
    const k = `${team}|${name}`, e = by.get(k);
    if (e) { e.pts += pts; e.text += ` & ${text}`; } else by.set(k, { name, team, pts, text });
  };
  for (const inn of innings) {
    const c = inn && inn.card;
    if (!c) continue;
    const bat = c.team, bowl = bat === HOME.name ? AWAY.name : HOME.name;
    for (const b of c.batters) if (b.balls > 0 || b.out) add(b.name, bat, b.runs + (b.out ? 0 : 3) + b.sixes, `${b.runs}${b.out ? '' : '*'} (${b.balls})`);
    for (const w of c.bowlers) if (w.balls > 0) add(w.name, bowl, 20 * w.wickets - 0.5 * Math.max(0, w.runs - w.balls), `${w.wickets}/${w.runs} (${Math.floor(w.balls / 6)}.${w.balls % 6} ov)`);
  }
  const all = [...by.values()];
  if (!all.length) return null;
  all.sort((a, b) => b.pts - a.pts || (b.team === winner) - (a.team === winner));
  const p = all[0];
  return { name: p.name, team: p.team, text: p.text };
}

// The next delivery waits while a holding beat plays: the session's first
// step of a delivery (batting: peopleReady / prepare; bowling: nextBall, and
// the bowler page at the start) is held, nothing else. Wrapped on the session object only.
export function holdSession(game, s) {
  if (!s || s._held) return s;
  s._held = true;
  const held = () => !!(game.ceremony && game.ceremony.holding);
  // (batting: "is everyone ready?" says no while held -- its own count of the wait and its hurrying
  // of the field go on as ever, so the beat overlaps the walk back instead of adding to it)
  if (typeof s.peopleReady === 'function') {
    const f = s.peopleReady;
    s.peopleReady = function (...a) { const r = f.apply(this, a); return r && !held(); };
  }
  for (const k of ['prepare', 'nextBall']) {
    const f = s[k];
    if (typeof f !== 'function') continue;
    s[k] = function (...a) { if (held()) return undefined; return f.apply(this, a); };
  }
  if (typeof s.chooseBowler === 'function') {
    const f = s.chooseBowler;
    s.chooseBowler = function (...a) { if (game.ceremony && game.ceremony.deferPage(() => f.apply(this, a))) return undefined; return f.apply(this, a); };
  }
  return s;
}

const overText = (balls) => `${Math.floor(balls / 6)}.${balls % 6}`;
const cap1 = (s) => String(s || '').toUpperCase();

export class Ceremony {
  constructor(game) {
    this.g = game;
    this.cur = null;            // the beat playing: { name, beat, ctx, done, steps, i, t, dur, hold }
    this.skipping = null;       // { t }: going down to dark to finish the beat
    this.queue = [];            // in-play beats waiting for their moment: { name, ctx, at, short }
    this.seen = null;           // the innings as last seen (wickets, balls)
    this.page = null;           // a deferred bowler page (holdSession)
    this.view = null;           // the spot a beat has put you at
    this.rng = makeRng(4242);   // the coin's tumble (never game.rng: the game's dice must not change)
    this.card = new CanvasPanel({ width: 1.36, height: 0.46, ppm: 760, name: 'beatCard', bg: null, interactive: false });
    const m = this.card.mesh;
    m.renderOrder = 45; m.material.depthTest = false; m.visible = false; m.material.opacity = 0;
    if (game.scene) game.scene.add(m);
    this.cardOn = false; this.cardA = 0;
    this.coin = new Coin(game.scene);
    this.cast = null;           // the toss figures: { captain, umpire }
    this.flip = null;           // the coin's toss in progress
  }

  mode() { return ceremonyMode(this.g); }
  get active() { return !!this.cur; }
  // (a beat still waiting for its moment holds the next ball too: the wicket's, after the replay)
  // (and a bowler page held back: you get the ball when it has been up)
  get holding() { return this.beatHolds() || !!this.page; }
  beatHolds() { return !!(this.cur && this.cur.hold) || this.queue.some((q) => BEATS[q.name].hold); }

  // Play a beat; done() when it has finished (by itself or skipped). With
  // Ceremonies off (or a beat with no short version, in 'short') its calls
  // are made and done() runs at once. opts.short: the cards only, whatever the setting.
  play(name, ctx = {}, done = null, opts = {}) {
    const beat = BEATS[name];
    if (this.cur) this.finish(false);
    const mode = opts.short && this.mode() === 'on' ? 'short' : this.mode();
    const plan = beat && mode !== 'off' ? beatPlan(beat, mode, ctx) : null;
    if (!plan || plan.dur <= 0) {
      if (beat) for (const s of beat.steps) if (s.cue === 'call' && !(mode === 'short' && s.scene)) this.exec(s, ctx);
      if (done) done();
      return false;
    }
    this.cur = { name, beat, ctx, done, steps: plan.steps, i: 0, t: 0, dur: plan.dur, hold: !!beat.hold, scene: mode === 'on' };
    // (the end of an innings: what the game had floating in the view -- the delivery card, hints -- goes)
    if (name === 'result' || name === 'inningsBreak') { const u = this.g.ui; u.setBowlCard?.(null); u.clearHints?.(); u.prompt?.('', 0); }
    this.skipping = null;
    this.tick(0);
    return true;
  }

  // Abandon whatever is on (the game was quit): back where you play, nothing called.
  stop() {
    if (this.skipping) this.g.replay?.fade.cut(SKIP_IN);
    this.cur = null; this.skipping = null; this.queue.length = 0; this.page = null;
    this.release(); this.castOff(); this.coin.hide(); this.hideCard(true);
  }

  // The bowler page is held back until the beat is over (and the field has come out).
  deferPage(fn) {
    if (!this.cur || !this.cur.hold) return false;
    this.page = { fn, t: 0 };
    return true;
  }

  // Before anything reads the controllers: the skip press (used up here).
  input() {
    const g = this.g, c = this.cur;
    if (!c || !c.hold || this.skipping) return;
    const I = g.input, b = g.replay && g.replay.skipHand ? g.replay.skipHand().buttons.trigger : null;
    const xr = !!I.xr;
    const press = xr ? !!(b && b.down) : !!(I.desktop && (I.desktop.took('KeyN') || I.desktop.took('Space') || I.desktop.took('Enter')));
    if (!press) return;
    if (xr && b.swallow) b.swallow();
    this.skip();
  }

  skip() {
    const c = this.cur, fade = this.g.replay && this.g.replay.fade;
    if (!c) return;
    // (a beat that has you somewhere else, or is still to: down to dark first)
    if (fade && c.scene && (this.view || c.steps.slice(c.i).some((s) => s.cue === 'vantage' || s.cue === 'clear' || s.cue === 'call'))) {
      this.skipping = { t: 0 };
      if (!fade.fadingOut) fade.fadeOut(SKIP_OUT);
      return;
    }
    this.finish(true);
  }

  // The beat is over: whatever state it was still to set is set, then done().
  finish(skipped) {
    const c = this.cur;
    if (!c) return;
    for (let i = c.i; i < c.steps.length; i++) if (STATE_CUES.has(c.steps[i].cue)) this.exec(c.steps[i], c.ctx);
    c.i = c.steps.length;
    if (skipped) { this.hideCard(true); this.flip = null; this.coin.hide(); }
    this.cur = null;
    if (c.done) c.done();
  }

  tick(dt) {
    const c = this.cur;
    if (!c) return;
    // (held at a wait cue: the time stands still and the beat is that much longer)
    if (c.wait) {
      c.wait.t += dt;
      if (c.wait.t < c.wait.max && this.waiting(c.wait.for)) { c.dur += dt; return; }
      c.wait = null;
    }
    c.t += dt;
    while (this.cur === c && !c.wait && c.i < c.steps.length && c.steps[c.i].t <= c.t) {
      const st = c.steps[c.i++];
      if (st.cue === 'wait') { if (this.waiting(st.for)) c.wait = { for: st.for, max: st.max || 2, t: 0 }; } else this.exec(st, c.ctx);
    }
    if (this.cur === c && c.t >= c.dur) this.finish(false);
  }

  // Once a frame, after the eye is placed (real seconds).
  update(dt) {
    const g = this.g;
    if (this.skipping) {
      const fade = g.replay.fade;
      this.skipping.t += dt;
      if (fade.dark || this.skipping.t > 0.6) { this.skipping = null; this.finish(true); fade.cut(SKIP_IN); }
    } else if (this.cur) {
      // A menu opened over a beat (the game paused or quit): the beat is done with at once.
      if (g.ui && g.ui.menuOpen && this.cur.hold && !this.cur.ctx.menuOk) {
        if (!g.session) { this.stop(); g.state = 'menu'; } else this.finish(true);
      } else if (!(g.replay && g.replay.active)) this.tick(dt);
    }
    if (this.mode() !== 'off') this.watch(dt);
    if (this.page) {
      this.page.t += dt;
      const f = g.session && g.session.field;
      if (!this.beatHolds() && (!f || f.settled() || this.page.t > 8)) { const p = this.page; this.page = null; p.fn(); }
    }
    // the winning moment: the finished innings' field still moves (the huddle, the walk back)
    if (this.resultField && this.cur && this.cur.name === 'result' && g.session && g.session.field === this.resultField) {
      this.resultField.update(dt, g.simTime);
      if (g.session.bowlerFig && g.session.bowlerFig.update) g.session.bowlerFig.update(dt, g.simTime);
    } else this.resultField = null;
    this.updateCast(dt);
    this.updateCoin(dt);
    this.updateCard(dt);
  }

  // Is that still going on? 'huddle': the fielding side round the wicket-taker (Fielding.celebrateWicket).
  waiting(what) {
    const g = this.g, s = g.session, L = s && s.field && s.field.logic;
    if (what === 'huddle') return !!L && L.fielders.some((f) => f.state === 'huddle' || (f.huddleCenter && f.huddleUntil != null && g.simTime < f.huddleUntil));
    return false;
  }

  // ---------------------------------------------------------------- watching play
  // A wicket or the end of an over: noted at once (with what the card will
  // say), played when the ball's replay, any review and any skip are over.
  watch(dt) {
    const g = this.g, s = g.session, inn = s && s.innings;
    if (!inn) { this.seen = null; this.queue.length = 0; return; }
    if (!this.seen || this.seen.inn !== inn) { this.seen = { inn, w: inn.wickets, legal: inn.legal, batted: battedNames(inn.card) }; this.queue.length = 0; }
    const S = this.seen;
    const skipAt = g.quickSkip && g.quickSkip.last ? g.quickSkip.last.at : null;
    if (inn.wickets > S.w && !inn.complete) this.queue.push({ name: s.isBowling ? 'wicketTaken' : 'wicket', ctx: this.wicketCtx(s, inn, S.batted), at: g.simTime + WICKET_DELAY, skipAt, born: g.clock });
    if (inn.legal > S.legal && inn.legal % 6 === 0 && !inn.complete) this.queue.push({ name: 'over', ctx: this.overCtx(s, inn), at: g.simTime, skipAt, born: g.clock });
    S.w = inn.wickets; S.legal = inn.legal; S.batted = battedNames(inn.card);
    this.hurryIn();
    while (this.queue.length && g.clock - this.queue[0].born > 25) this.queue.shift();     // (never waiting for ever)
    const q = this.queue[0];
    if (!q || this.cur) return;
    const st = s.state;
    if (st === 'cue' || st === 'runup' || st === 'live' || (s.isBowling && s.runStarted && s.runStarted())) { this.queue.length = 0; return; }   // (play has moved on)
    const R = g.replay, quiet = !(R && (R.active || R.pending)) && !(g.quickSkip && g.quickSkip.busy) && !decisionPending(s) && !g.ui.menuOpen && g.state === 'play';
    if (!quiet || g.simTime < q.at) return;
    this.queue.shift();
    // (skipped on to the next ball since: the cards only)
    const last = g.quickSkip && g.quickSkip.last ? g.quickSkip.last.at : null;
    this.play(q.name, q.ctx, null, { short: last !== q.skipAt });
  }

  wicketCtx(s, inn, before) {
    const g = this.g, c = inn.card, fow = c && c.fow.length ? c.fow[c.fow.length - 1] : null;
    const b = c && fow ? c.batters.find((x) => x.name === fow.name) : null;
    const nb = c ? c.batters.find((x) => x.batted && !before.has(x.name)) : null;
    const L = s.field && s.field.logic, hud = L && L.huddle;
    const focus = hud && hud.focus ? { x: hud.focus.x, z: hud.focus.z } : null;
    return {
      at: g.clock, batting: !s.isBowling, team: c ? c.team : '', score: inn.scoreText, overs: inn.overs,
      out: b ? { name: b.name, how: b.out || '', runs: b.runs, balls: b.balls, fours: b.fours, sixes: b.sixes } : null,
      fow: fow ? `${fow.wicket}-${String(fow.score).split('/')[0]}${fow.overs ? ` (${fow.overs})` : ''}` : '',
      newBatter: nb ? nb.name : null, need: inn.target != null ? `need ${inn.runsNeeded} off ${inn.ballsLeft}` : `${inn.ballsLeft} balls left`,
      // (the celebration is behind you -- a keeper's or a slip's catch: cut round to it)
      behind: !s.isBowling && !!focus && focus.z > -3.5, focus,
    };
  }

  overCtx(s, inn) {
    const c = inn.card, n = inn.legal / 6, last = inn.log.length ? inn.log[inn.log.length - 1].over : n - 1;
    const balls = inn.log.filter((l) => l.over === last).map((l) => l.sym);
    const bw = c && c.bowler ? c.bowler : null;
    const team = teamByName((c && c.team) || inn.label || (inn.batting === 'player' ? HOME.name : AWAY.name));
    return {
      n, balls, team, score: inn.scoreText, overs: inn.overs,
      bowler: bw ? `${bw.name} ${overText(bw.balls)}-${bw.runs}-${bw.wickets}` : '',
      chase: inn.target != null ? `Need ${inn.runsNeeded} off ${inn.ballsLeft}${inn.ballsLeft ? ` · RRR ${(inn.runsNeeded * 6 / inn.ballsLeft).toFixed(2)}` : ''}` : `Run rate ${(inn.runs * 6 / Math.max(1, inn.legal)).toFixed(2)}`,
    };
  }

  // A new batter on his way out from the gate comes from nearer (WALK_OUT m):
  // moved while he has not yet faded in, so nobody sees it.
  hurryIn() {
    const cr = this.g.crew;
    if (!cr || !cr.pool) return;
    for (const a of cr.pool) {
      const k = a.task;
      if (!k || k.kind !== 'in' || k.age > 0.15 || k._near) continue;
      k._near = true;
      const dx = a.pos.x - k.to.x, dz = a.pos.z - k.to.z, d = Math.hypot(dx, dz);
      if (d <= WALK_OUT + 1) continue;
      a.place(k.to.x + dx / d * WALK_OUT, k.to.z + dz / d * WALK_OUT, Math.atan2(-dx, -dz));
    }
  }

  // ---------------------------------------------------------------- cues
  exec(s, ctx) {
    const g = this.g;
    try {
      switch (s.cue) {
        case 'fade': {
          const f = g.replay && g.replay.fade;
          if (!f) break;
          if (s.out != null) f.fadeOut(s.out); else f.cut(s.in);
          break;
        }
        case 'vantage': this.goTo(s.spot === 'huddle' ? huddleSpot(ctx.focus) : SPOTS[s.spot]); break;
        case 'clear': this.release(); this.castOff(); this.coin.hide(); this.flip = null; break;
        case 'cast': this.castOn(); break;
        case 'card': this.showCard(s.card, ctx, s); break;
        case 'cardOff': this.hideCard(false); break;
        case 'board': this.showBoard(s.board, ctx); break;
        case 'sting': if (g.sfx && g.settings.sound) g.sfx.sting(s.sting); break;
        case 'sound': if (g.sample) g.sample(s.name, { gain: s.gain ?? 0.8 }); break;
        case 'crowd': this.crowd(s.mood, ctx); break;
        case 'coin': this.startFlip(ctx); break;
        case 'call': if (typeof ctx[s.fn] === 'function') { const f = ctx[s.fn]; ctx[s.fn] = null; f(); } break;
        case 'arrange': this.arrange(); break;
        case 'celebrate': this.celebrate(ctx); break;
        default:
      }
    } catch (e) { console.warn('ceremony', s.cue, e); }
  }

  // Put you at a spot (in the dark: a cut, never a move you see).
  goTo(spot) {
    const g = this.g;
    if (!spot || !g.beginViewOverride) return;
    g.beginViewOverride(spot.x, spot.z, spot.dx, spot.dz);
    if (g.viewOverride) g.viewOverride.scene = true;      // (no catching hands)
    if (!this.view && g.ui && g.ui.showHud) g.ui.showHud(false);   // (the score panel by the pitch is not part of the scene)
    this.view = spot;
  }
  release() {
    const g = this.g, f = g.replay && g.replay.fade;
    if (!this.view) return;
    this.view = null;
    const dark = !!(f && f.dark);
    if (g.viewOverride && g.viewOverride.scene) g.endViewOverride();
    if (g.ui && g.ui.showHud) g.ui.showHud(true);
    if (dark) f.fadeOut(0.01);                           // (endViewOverride brings the view in: it stays dark until the beat's own fade)
  }

  crowd(mood, ctx) {
    const g = this.g, A = g.audio, cm = g.crowd && g.crowd.mood;
    const sound = g.settings && g.settings.sound;
    try {
      if (mood === 'build') { if (cm) cm.excite = Math.max(cm.excite, 0.45); if (sound) A.cheer(0.35); }
      else if (mood === 'murmur') { if (sound) A.cheer(0.45); }
      else if (mood === 'applause') { if (sound) g.sample('applause_warm', { gain: 0.8 }); g.env.crowdReact?.('milestone', 0.7, null); if (cm) cm.excite = Math.max(cm.excite, 0.5); }
      else if (mood === 'result') {
        const home = ctx.winner === 'home', tie = ctx.winner === 'tie';
        g.env.crowdReact?.(tie ? 'milestone' : home ? 'wicketFor' : 'wicketAgainst', 1, null);
        if (sound) { A.react(tie ? 'milestone' : home ? 'win' : 'lose', 1, null); if (home || tie) g.cheer(0.9); }
      }
    } catch { /* optional: the ground reacts even with the sound off */ }
  }

  // The winning moment: the fielding side's body language (gestures.js) and,
  // when they won, the huddle round their bowler (the session's own field).
  celebrate(ctx) {
    const g = this.g, s = g.session;
    const fieldingWon = ctx.fieldingWon;
    noteCrowd(fieldingWon ? 'wicketFor' : 'six', g.simTime);
    if (fieldingWon && s && s.field && s.field.huddle) { try { s.field.logic.dead = true; s.field.huddle(); } catch { /* (no huddle: they stand) */ } }
    this.resultField = s && s.done && s.field ? s.field : null;
  }

  // The field taking the field: everyone out from the pavilion side a jog
  // from his mark; the batters walking out; the AI bowler to his mark.
  arrange() {
    const g = this.g, s = g.session;
    if (!s) return;
    const L = s.field && s.field.logic;
    if (L) {
      for (const f of L.fielders) {
        if (f.bowler) continue;
        const dx = GATE.x - f.home.x, dz = GATE.z - f.home.z, d = Math.hypot(dx, dz) || 1, k = Math.min(TAKE_FIELD_RUN, d * 0.9) / d;
        f.pos.set(f.home.x + dx * k, 0, f.home.z + dz * k);
        f.vel.set(0, 0, 0); f.speed = 0; f.state = 'return'; f.target = null;
        f.face = f.yaw = Math.atan2(-dx, -dz);
      }
      if (g.fieldView && g.fieldView.placeAll) g.fieldView.placeAll(L.states());
    }
    const from = (to) => { const dx = GATE.x - to.x, dz = GATE.z - to.z, d = Math.hypot(dx, dz) || 1; return { x: to.x + dx / d * WALK_OUT, z: to.z + dz / d * WALK_OUT, h: Math.atan2(-dx, -dz) }; };
    const ns = g.nonStrikerView, bv = g.batterView;
    if (ns && ns.visible && ns.walkHome) {
      const p = from(ns.home); ns.actor.cut(); ns.actor.place(p.x, p.z, p.h);
      ns.walkHome(walkTask(ns.home, null, { speed: 2.3, tol: 0.12 }));
    }
    if (s.isBowling && bv && bv.shown) {
      const p = from(STRIKER_SPOT); bv.actor.cut(); bv.actor.place(p.x, p.z, p.h);
      bv.actor.task = walkTask(STRIKER_SPOT, PI / 2, { speed: 2.3 }); bv.wasBat = false; bv.blend = null;
    }
    const bw = s.bowlerFig && s.bowlerFig.actor;
    if (bw && bw.visible) { bw.cut(); bw.place(1.2, PITCH.bowlingStumpsZ + 3, PI); }
  }

  // ---------------------------------------------------------------- the toss figures
  castOn() {
    const g = this.g;
    if (this.cast || !g.fieldView || g.session) return;
    const cap = g.fieldView.actors[CAPTAIN], U = g.umpires;
    if (!cap) return;
    cap.h.setTeam('away'); cap.cut(); cap.place(TOSS.captain.x, TOSS.captain.z, TOSS.captain.face); cap.visible = true;
    const st = { x: TOSS.captain.x, z: TOSS.captain.z, face: TOSS.captain.face, speed: 0, state: 'set', action: null, crouch: false, armsUp: false, huddle: 0 };
    let ump = null;
    if (U && U.main) {
      ump = U.main;
      U.show(true); if (U.leg) U.leg.visible = false;
      if (!ump.mark) U.place(false);
      ump.mark.set(TOSS.umpire.x, 0, TOSS.umpire.z); ump.off.set(0, 0, 0); ump.goal.x = TOSS.umpire.x; ump.goal.z = TOSS.umpire.z; ump.rest = TOSS.umpire.face;
      ump.task = null; ump.speed = 0; ump.cut(); ump.place(TOSS.umpire.x, TOSS.umpire.z, TOSS.umpire.face);
      U.setLook && U.setLook(new THREE.Vector3(TOSS.coin.x, 0.6, TOSS.coin.z));
    }
    this.cast = { cap, st, ump };
  }
  castOff() {
    const g = this.g, c = this.cast;
    if (!c) return;
    this.cast = null;
    if (!g.session || !g.fieldView.visible) c.cap.visible = false;
    if (c.ump && g.umpires) { g.umpires.show(false); g.umpires.place(false); }
  }
  updateCast(dt) {
    const c = this.cast, g = this.g;
    if (!c) return;
    const t = g.simTime;
    c.cap.update(Math.max(dt, 1e-4), c.st, { t, ball: null, delivering: false, cam: g.eye ? g.eye.p : null, others: [] });
    // the coin in his right hand, held out in front of him, then flicked up
    const F = this.flip, h = c.cap.h;
    if (F && F.tf < 1.0) {
      const up = F.tf < 0.55 ? sstep01(F.tf / 0.4) : 1 - sstep01((F.tf - 0.62) / 0.38);
      h.update();
      c.cap.forward(_f);
      h.worldPos('shoulderR', _a);
      _b.copy(_a).addScaledVector(_f, 0.33).add(_up.set(0, -0.12 + 0.2 * (F.tf > 0.55 ? 1 : 0), 0));
      h.worldPos('handR', _c);
      _c.lerp(_b, up);
      h.ikArm('R', _c, _d.copy(_a).add(_up.set(0, -0.5, 0)).addScaledVector(_f, -0.2));
    }
  }

  // ---------------------------------------------------------------- the coin
  startFlip(ctx) {
    const c = this.cast;
    if (!c) return;
    this.flip = { tf: 0, face: ctx.coin === 'tails' ? 'tails' : 'heads', launched: false };
  }
  updateCoin(dt) {
    const F = this.flip, c = this.cast, coin = this.coin;
    if (F) {
      F.tf += dt;
      if (!F.launched && c) {
        c.cap.h.update();
        c.cap.h.worldPos('handR', _a);
        coin.hold(_a, c.cap.heading);
        if (F.tf >= 0.55) {
          F.launched = true;
          coin.toss(_a, _b.set(TOSS.coin.x, 0, TOSS.coin.z), F.face, this.rng);
        }
      }
    }
    coin.update(dt);
  }

  // ---------------------------------------------------------------- cards
  showCard(kind, ctx, cue = {}) {
    const spec = CARDS[kind] ? CARDS[kind](ctx, this.g) : null;
    if (!spec) return;
    const P = this.card;
    P.set([{ type: 'custom', draw: (g) => drawBeatCard(g, P.W, P.H, spec) }], '');
    P.update();
    // In front of where you look now, a little below eye level, upright, square on.
    const e = this.g.eye;
    if (e) {
      _q.set(e.q.x, e.q.y, e.q.z, e.q.w);
      _f.set(0, 0, -1).applyQuaternion(_q); _f.y = 0;
      if (_f.lengthSq() < 1e-6) _f.set(0, 0, -1);
      _f.normalize();
      // (beside the control hints and the message strip when a game is on: they keep to the left)
      const s = this.g.session, xr = !!this.g.input?.xr, d = xr ? 2.2 : 2.6;
      const yaw = cue.yaw ?? (!s ? 0 : s.isBowling ? 12 : 13) * PI / 180, el = cue.el ?? (s && s.isBowling ? -0.2 : xr ? -0.12 : -0.2);
      const c = Math.cos(yaw), sn = Math.sin(yaw), fx = _f.x * c - _f.z * sn, fz = _f.x * sn + _f.z * c;
      P.mesh.position.set(e.p.x + fx * d, e.p.y + el * d, e.p.z + fz * d);
      P.mesh.lookAt(e.p.x, P.mesh.position.y, e.p.z);
    }
    P.mesh.visible = true;
    if (!this.cardOn) { this.cardA = 0; this.cardT = 0; }
    this.cardOn = true;
  }
  hideCard(now) { this.cardOn = false; if (now) { this.cardA = 0; this.card.mesh.visible = false; } }
  updateCard(dt) {
    const m = this.card.mesh, g = this.g;
    // (a delivery on its way, a replay, a menu: the card is not in the way)
    const away = (g.replay && g.replay.active) || (g.ui && g.ui.menuOpen) || (g.ui && g.ui.quiet === 'clear');
    const want = this.cardOn && !away ? 1 : 0;
    if (this.cardOn && g.ui && g.ui.quiet === 'clear' && !this.holding) this.cardOn = false;
    this.cardA += Math.max(-dt / 0.2, Math.min(dt / 0.25, want - this.cardA));
    m.visible = this.cardA > 0.01;
    m.material.opacity = this.cardA;
    if (m.visible) { const k = 0.96 + 0.04 * this.cardA; m.scale.set(k, k, 1); }
  }

  showBoard(kind, ctx) {
    const ui = this.g.ui;
    if (!ui || !BOARDS[kind]) return;
    const b = BOARDS[kind](ctx, this.g);
    if (!b) return;
    if (b.sting && ui.bigSting) ui.bigSting(b.sting.kind, b.sting.word, b.sting.sub, b.secs || 5);
    else if (b.lines && ui.boardCard) ui.boardCard(b.lines, b.secs || 6);
  }
}

function battedNames(card) { return new Set(card ? card.batters.filter((b) => b.batted).map((b) => b.name) : []); }

// Where to stand to see a celebration behind you: down the pitch, looking back at it.
function huddleSpot(f) {
  if (!f) return null;
  const x = f.x * 0.5, z = Math.min(f.z - 7.5, -6), dx = f.x - x, dz = f.z - z, d = Math.hypot(dx, dz) || 1;
  return { x, z, dx: dx / d, dz: dz / d };
}

const sstep01 = (u) => { const t = Math.min(1, Math.max(0, u)); return t * t * (3 - 2 * t); };
const _q = new THREE.Quaternion(), _f = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _up = new THREE.Vector3();

// ---------------------------------------------------------------- the coin
// A toss coin (a 5 cm medallion: big enough to read at your feet), heads a crowned monogram, tails the stumps: one mesh,
// one Lambert material over a small atlas (its faces and its milled edge),
// built once. Tossed: up from the captain's hand with a tumble that brings it
// down on the face that was decided, a hop and a wobble on the turf.
const COIN_R = 0.026, COIN_T = 0.0036, G = 9.81, REST = 0.003 + COIN_T / 2 + 0.0005;   // (the pitch's surface is 3 mm up)
class Coin {
  constructor(scene) {
    const geo = new THREE.CylinderGeometry(COIN_R, COIN_R, COIN_T, 36, 1);
    // one material: the side, the top (heads) and the bottom (tails) each to their part of the atlas
    const uv = geo.attributes.uv;
    for (const gr of geo.groups) {
      const vs = new Set();
      for (let i = gr.start; i < gr.start + gr.count; i++) vs.add(geo.index ? geo.index.getX(i) : i);
      for (const v of vs) {
        let u = uv.getX(v), w = uv.getY(v);
        if (gr.materialIndex === 0) { u = 0.02 + u * 0.06; w = 0.5 + w * 0.02; }       // the edge: a strip of milling
        else if (gr.materialIndex === 1) u = 0.5 * u;                                   // heads (left half)
        else u = 0.5 + 0.5 * u;                                                         // tails (right half)
        uv.setXY(v, u, w);
      }
    }
    geo.clearGroups();
    const tex = new THREE.CanvasTexture(coinAtlas());
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    this.mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex, emissive: 0x4a3810 }));
    this.mesh.name = 'tossCoin';
    this.mesh.visible = false;
    if (scene) scene.add(this.mesh);
    this.s = null;
    this._ax = new THREE.Vector3(); this._q = new THREE.Quaternion(); this._yaw = new THREE.Quaternion();
  }
  hide() { this.mesh.visible = false; this.s = null; }
  // In the captain's fingers, flat, heads up.
  hold(p, heading) {
    const m = this.mesh;
    m.visible = true;
    m.position.set(p.x, p.y + 0.02, p.z);
    m.quaternion.setFromAxisAngle(_up.set(0, 1, 0), heading);
    this.s = null;
  }
  toss(from, to, face, rng) {
    const h = 0.75 + 0.2 * rng(), vy = Math.sqrt(2 * G * h);
    const down = from.y + h - REST, T = vy / G + Math.sqrt(2 * down / G);
    const dx = to.x - from.x, dz = to.z - from.z, L = Math.hypot(dx, dz) || 1;
    const turns = Math.round(T * (9 + 3 * rng()));
    this.s = {
      p: new THREE.Vector3(from.x, from.y, from.z), v: new THREE.Vector3(dx / T, vy, dz / T), t: 0, T,
      axis: new THREE.Vector3(-dz / L, 0, dx / L), spin: (2 * PI * turns + (face === 'tails' ? PI : 0)) / T, ang: 0,
      landed: false, hop: 0, wob: 0.35 + 0.1 * rng(), face, yaw: Math.atan2(dx, dz),
    };
  }
  update(dt) {
    const s = this.s, m = this.mesh;
    if (!s || !m.visible) return;
    s.t += dt;
    if (!s.landed) {
      s.v.y -= G * dt;
      s.p.addScaledVector(s.v, dt);
      s.ang += s.spin * dt;
      if (s.t >= s.T || s.p.y <= REST) {
        // down: the face that was called is the one up; a small hop and a settling wobble
        s.landed = true; s.lt = 0; s.p.y = REST; s.ang = s.face === 'tails' ? PI : 0;
        s.v.set(s.v.x * 0.15, 0.55, s.v.z * 0.15);
      }
    } else {
      s.lt += dt;
      if (s.p.y > REST || s.v.y > 0) { s.v.y -= G * dt; s.p.addScaledVector(s.v, dt); if (s.p.y < REST) { s.p.y = REST; s.v.set(0, 0, 0); } }
    }
    const wob = s.landed ? s.wob * Math.exp(-s.lt * 5) * Math.cos(s.lt * 26) : 0;
    m.position.copy(s.p);
    if (s.landed) m.position.y += COIN_R * Math.abs(Math.sin(wob));
    this._yaw.setFromAxisAngle(_up.set(0, 1, 0), s.yaw);
    m.quaternion.setFromAxisAngle(s.axis, s.ang + wob).multiply(this._yaw);
  }
}

// The coin's faces, 256 x 128: heads (a crowned monogram) left, tails (the stumps) right, a milled band.
function coinAtlas() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const x = c.getContext('2d');
  if (!x || !x.createRadialGradient) return c;
  x.fillStyle = '#b8892a'; x.fillRect(0, 0, 256, 128);
  // milled edge strip (u 0.02-0.08, v 0.5-0.52)
  for (let i = 0; i < 16; i++) { x.fillStyle = i % 2 ? '#8a6418' : '#e2b85a'; x.fillRect(5 + i, 62, 1, 4); }
  for (const [cx, label] of [[64, 'H'], [192, 'T']]) {
    const gr = x.createRadialGradient(cx - 18, 46, 4, cx, 64, 64);
    gr.addColorStop(0, '#ffe7a3'); gr.addColorStop(0.55, '#e0ae45'); gr.addColorStop(1, '#9a6c1c');
    x.fillStyle = gr; x.beginPath(); x.arc(cx, 64, 63, 0, PI * 2); x.fill();
    x.strokeStyle = 'rgba(90,60,10,0.75)'; x.lineWidth = 3; x.beginPath(); x.arc(cx, 64, 56, 0, PI * 2); x.stroke();
    for (let i = 0; i < 24; i++) { const a = (i / 24) * PI * 2; x.fillStyle = 'rgba(110,75,15,0.7)'; x.beginPath(); x.arc(cx + Math.cos(a) * 50, 64 + Math.sin(a) * 50, 1.6, 0, PI * 2); x.fill(); }
    x.save(); x.translate(cx, 64);
    if (label === 'H') {
      x.fillStyle = 'rgba(95,62,10,0.9)'; x.font = font(900, 54); x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('H', 0, 8);
      x.beginPath(); x.moveTo(-20, -18); x.lineTo(-14, -34); x.lineTo(-6, -22); x.lineTo(0, -38); x.lineTo(6, -22); x.lineTo(14, -34); x.lineTo(20, -18); x.closePath(); x.fill();
    } else {
      x.fillStyle = 'rgba(95,62,10,0.9)';
      for (const sx of [-14, 0, 14]) x.fillRect(sx - 3.5, -24, 7, 50);
      x.fillRect(-19, -31, 17, 4); x.fillRect(2, -31, 17, 4);
    }
    x.restore();
  }
  return c;
}

// ---------------------------------------------------------------- what the cards say
// Each returns a card spec for drawBeatCard: { tag, title, sub, color, teams, chips, balls }.
const homeT = () => teamByName(HOME.name), awayT = () => teamByName(AWAY.name);
export const CARDS = {
  title: (c) => c.mode === 'chase'
    ? { tag: 'RUN CHASE', title: `${cap1(HOME.name)} NEED ${c.target}`, sub: `off ${c.balls} balls · ${c.wickets} wickets · ${VENUE}`, teams: [homeT(), awayT()], color: homeT().c2 }
    : c.mode === 'over'
      ? { tag: 'BOWL AN OVER', title: `DEFEND ${c.target - 1}`, sub: `${AWAY.name} need ${c.target} off 6 balls · ${VENUE}`, teams: [homeT(), awayT()], color: C.accent }
      : { tag: 'MATCH DAY', title: `${cap1(HOME.name)}  v  ${cap1(AWAY.name)}`, sub: `${c.overs} over${c.overs === 1 ? '' : 's'} a side · ${c.wickets} wickets · ${VENUE}`, teams: [homeT(), awayT()], color: C.accent },
  tossResult: (c) => ({
    tag: `THE TOSS · ${cap1(c.coin)}`, color: c.won ? homeT().c2 : awayT().c2,
    title: c.won ? `${cap1(HOME.name)} WIN THE TOSS` : `${cap1(AWAY.name)} WIN THE TOSS`,
    sub: c.won ? 'You called it: bat or bowl?' : c.aiBats ? `${AWAY.name} will bat first: you bowl` : `${AWAY.name} will bowl first: you bat`,
    coin: c.coin,
  }),
  innings: (c) => {
    const bowlSide = c.playerBats ? AWAY.name : HOME.name;
    const tag = c.mode === 'chase' ? 'RUN CHASE' : c.mode === 'over' ? 'BOWL AN OVER' : c.second ? '2ND INNINGS' : '1ST INNINGS';
    return { tag, title: `${cap1(bowlSide)} TAKE THE FIELD`, sub: c.target != null ? `Target ${c.target} · ${c.batting} need ${c.target} off ${c.balls} balls` : `${c.openers} open the batting · ${c.overs} over${c.overs === 1 ? '' : 's'}`, color: (c.playerBats ? awayT() : homeT()).c2, teams: c.playerBats ? [homeT(), awayT()] : [awayT(), homeT()] };
  },
  dismissal: (c) => {
    const o = c.out;
    if (!o) return null;
    const sr = o.balls ? Math.round((o.runs * 100) / o.balls) : 0;
    return { tag: 'WICKET', title: cap1(o.name), sub: `${o.how || 'out'} · ${o.runs} off ${o.balls} ball${o.balls === 1 ? '' : 's'}`, color: C.wicket, chips: [['4s', o.fours], ['6s', o.sixes], ['SR', sr], ['FOW', c.fow]] };
  },
  newBatter: (c) => (c.newBatter ? { tag: 'NEW BATTER', title: cap1(c.newBatter), sub: `${c.team} ${c.score} (${c.overs} ov) · ${c.need}`, color: c.batting ? homeT().c2 : awayT().c2 } : null),
  over: (c) => ({ tag: `END OF OVER ${c.n}`, title: `${c.team.short}  ${c.score}`, sub: [c.bowler, c.chase].filter(Boolean).join(' · '), color: c.team.c2, balls: c.balls }),
  break: (c) => ({ tag: 'INNINGS BREAK', title: `${cap1(c.team)} ${c.score}`, sub: `${c.overs} overs · ${c.best}`, color: C.accent, chips: [['TARGET', c.target], [cap1(c.chasing), `NEED ${c.target} OFF ${c.balls}`]] }),
  result: (c) => ({ tag: 'RESULT', title: c.title, sub: c.potm ? `Player of the match: ${c.potm.name} · ${c.potm.text}` : c.sub || '', color: c.winner === 'home' ? C.ok : c.winner === 'tie' ? C.accent : C.wicket }),
  nets: (c) => ({ tag: 'NETS', title: c.title, sub: c.sub, color: C.primary }),
};

// What the big screen shows (ui.boardCard: [header, big, row, row]; ui.bigSting: a sting).
export const BOARDS = {
  title: (c) => ({ lines: [c.mode === 'match' ? 'MATCH DAY' : c.mode === 'chase' ? 'RUN CHASE' : 'BOWL AN OVER', `${HOME.short}  v  ${AWAY.short}`, `${HOME.name} v ${AWAY.name}`, c.mode === 'match' ? `${c.overs} overs a side · ${VENUE}` : VENUE], secs: 7 }),
  toss: () => ({ lines: ['THE TOSS', `${HOME.short}  v  ${AWAY.short}`, `${AWAY.name}' captain tosses`, `${HOME.name} to call`], secs: 9 }),
  tossResult: (c) => ({ sting: { kind: 'milestone', word: cap1(c.coin), sub: `${c.won ? HOME.name : AWAY.name} win the toss` }, secs: 5 }),
  innings: (c) => ({ lines: [c.second ? '2ND INNINGS' : c.mode === 'match' ? '1ST INNINGS' : cap1(c.modeName), `${cap1(c.playerBats ? AWAY.name : HOME.name)} TAKE THE FIELD`, c.target != null ? `Target ${c.target}` : `${c.openers}`, `${c.overs} over${c.overs === 1 ? '' : 's'} · ${VENUE}`], secs: 5 }),
  dismissal: (c) => (c.out ? { lines: ['WICKET', `${cap1(c.out.name)}  ${c.out.runs} (${c.out.balls})`, c.out.how || 'out', `FOW ${c.fow} · ${c.team} ${c.score}`], secs: 5 } : null),
  over: (c) => ({ lines: [`END OF OVER ${c.n}`, `${c.team.short} ${c.score}`, `This over: ${c.balls.join('  ')}`, [c.bowler, c.chase].filter(Boolean).join(' · ')], secs: 5 }),
  break: (c) => ({ lines: ['INNINGS BREAK', `${c.team.toUpperCase()} ${c.score}`, c.best, `${c.chasing} need ${c.target} off ${c.balls}`], secs: 8 }),
  result: (c) => ({ sting: { kind: 'milestone', word: c.word, sub: c.margin || c.title }, secs: 6 }),
};

// ---------------------------------------------------------------- the card
// A broadcast lower third: a dark glass card with the beat's colour down its
// left edge, a slanted tag on top, the title big and leaning, a line under
// it and a row of stat chips or the over's balls. Drawn once per beat.
export function drawBeatCard(g, W, H, s) {
  const N = 'beatCard', col = s.color || C.accent;
  const x = 10, y = 44, w = W - 20, h = H - y - 14;
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 18; g.shadowOffsetY = 6;
  rr(g, x, y, w, h, 24); g.fillStyle = 'rgba(7,12,22,0.95)'; g.fill();
  g.restore();
  g.save(); rr(g, x, y, w, h, 24); g.clip();
  g.fillStyle = vgrad(g, y, y + h, 'rgba(255,255,255,0.10)', 'rgba(255,255,255,0)'); g.fillRect(x, y, w, h * 0.55);
  g.fillStyle = hgrad(g, x, x + w * 0.6, hexA(col, 0.22), hexA(col, 0)); g.fillRect(x, y, w * 0.6, h);
  g.fillStyle = col; g.fillRect(x, y, 14, h);
  g.fillStyle = hexA(col, 0.9); g.fillRect(x + 14, y + h - 5, w - 14, 5);
  g.restore();
  // the tag
  g.save();
  g.font = font(900, 30);
  const tag = s.tag || '', tw = Math.min(w - 120, g.measureText(tag).width + tag.length * 2.4 + 70);
  slant(g, x + 34, y - 32, tw, 54, 16); g.fillStyle = col; g.fill();
  g.restore();
  caps(g, s.tag || '', x + 34 + 30, y - 4, 30, inkOn(col), { weight: 900, track: 0.08, maxW: tw - 50 });
  // the title (between the two teams' blocks when it names both)
  const teams = s.teams && s.teams.length === 2 ? s.teams : null, coin = s.coin;
  const tx0 = x + 48 + (teams ? 170 : 0) + (coin ? 120 : 0), tx1 = x + w - 36 - (teams ? 170 : 0);
  if (teams) { teamBlock(g, teams[0], x + 40, y + 26, 150, 92, 50); teamBlock(g, teams[1], x + w - 190, y + 26, 150, 92, 50); }
  if (coin) drawCoinIcon(g, x + 100, y + 76, 52, coin);
  const r = fitText(g, s.title || '', { maxW: tx1 - tx0, size: 74, min: 34, weight: 900 });
  g.save();
  g.translate(teams ? (tx0 + tx1) / 2 : tx0, y + 78); g.transform(1, 0, -0.12, 1, 0, 0);
  g.fillStyle = '#ffffff'; g.textAlign = teams ? 'center' : 'left'; g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = 10; g.shadowOffsetY = 3;
  g.fillText(s.title || '', 0, 0);
  g.restore();
  void r;
  // the line under it
  if (s.sub) {
    const sx = teams ? x + 48 : tx0, sw = x + w - 36 - sx;
    const rs = fitText(g, s.sub, { maxW: sw, size: 34, min: 20, weight: 600 });
    g.fillStyle = C.text2; g.textAlign = teams ? 'center' : 'left'; g.textBaseline = 'middle';
    g.fillText(s.sub, teams ? x + w / 2 : sx, y + 150);
    void rs;
  }
  // a row: the over's balls, or stat chips
  const ry = y + 196;
  if (s.balls && s.balls.length) {
    caps(g, 'THIS OVER', x + 48, ry + 24, 24, C.text3);
    let bx = x + 210;
    for (const b of s.balls) bx += ballDot(g, bx + 22, ry + 24, 22, b) + 12;
  } else if (s.chips && s.chips.length) {
    let cx = x + 48;
    for (const [k, v] of s.chips) {
      if (v == null || v === '') continue;
      g.save(); g.font = font(800, 24);
      const kw = g.measureText(k).width; g.restore();
      const wv = chip(g, String(v), cx + kw + 26, ry + 4, 44, { bg: 'rgba(255,255,255,0.12)', fg: '#fff', px: 26 });
      caps(g, k, cx, ry + 26, 24, C.text3, { weight: 800 });
      cx += kw + 26 + wv + 28;
      if (cx > x + w - 120) break;
    }
  }
  void N;
}
function drawCoinIcon(g, cx, cy, r, face) {
  g.save();
  const gr = g.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r);
  gr.addColorStop(0, '#fff0b8'); gr.addColorStop(0.55, '#e3b24a'); gr.addColorStop(1, '#94661a');
  g.beginPath(); g.arc(cx, cy, r, 0, PI * 2); g.fillStyle = gr; g.fill();
  g.lineWidth = 3; g.strokeStyle = 'rgba(80,52,8,0.7)'; g.beginPath(); g.arc(cx, cy, r * 0.86, 0, PI * 2); g.stroke();
  g.fillStyle = 'rgba(80,52,8,0.9)';
  if (face === 'tails') { for (const sx of [-0.26, 0, 0.26]) g.fillRect(cx + sx * r - r * 0.06, cy - r * 0.42, r * 0.12, r * 0.9); g.fillRect(cx - r * 0.36, cy - r * 0.55, r * 0.72, r * 0.08); }
  else { g.font = font(900, r * 1.0); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('H', cx, cy + r * 0.06); }
  g.restore();
}
export { drawCoinIcon };
function hexA(hex, a) {
  const h = String(hex).replace('#', '');
  if (h.length !== 6) return `rgba(255,201,60,${a})`;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
// Dark text on a light tag, white on a dark one.
function inkOn(hex) {
  const h = String(hex).replace('#', '');
  if (h.length !== 6) return '#16120a';
  const n = parseInt(h, 16), l = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return l > 150 ? '#16120a' : '#ffffff';
}
void drawIcon;
