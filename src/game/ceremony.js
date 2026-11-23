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
import { noteCrowd, envelope } from '../render/gestures.js';
import { coinToss, nod, offerHand, TOSS_AT } from '../render/ceremonyPoses.js';
import { decisionPending } from './quickSkip.js';
import { SQUADS } from './squad.js';
import { PITCH } from '../physics/pitch.js';
import { makeRng, hypot2 } from '../physics/math.js';

export const CEREMONIES = ['on', 'short', 'off'];
export const CEREMONY_NAMES = { on: 'full', short: 'cards only', off: 'off' };
export const VENUE = 'Harbourside Oval';
const HOME = SQUADS.home, AWAY = SQUADS.away;
const CZ = PITCH.centerZ;
const PI = Math.PI;

// Where a beat puts you (x, z: your head; dx, dz: the way you face).
const toward = (x, z, tx, tz) => { const dx = tx - x, dz = tz - z, d = hypot2(dx, dz) || 1; return { x, z, dx: dx / d, dz: dz / d }; };
export const SPOTS = {
  // on the pavilion side, on a low riser above the outfield (a fade cut takes you there): the square laid
  // out below you with its figures and the stands round it -- at standing height it read as a flat field
  pavilion: { ...toward(24, CZ + 3, 0, CZ), y: 1.2 },      // (1.2 m, not 2: comfortable with nothing drawn under your feet)
  toss: { x: -1.25, z: CZ + 1.2, dx: 1, dz: 0 },      // on the square, the other captain in front of you, the pavilion behind him
  // beside the path out of the pavilion gate, 4.5 m off it: whoever walks out passes in front of you
  gate: toward(GATE.x - 9.5, GATE.z + 3.6, GATE.x - 5, GATE.z),
  // on the outfield in front of the pavilion, looking in at the middle: the fielding side gathers
  // between you and the square and runs out away from you to their marks (few of them are behind you)
  huddle: toward(37, CZ + 4, 0, CZ),
};
const HUDDLE_AT = 4.2;            // m in front of you the fielding side gathers before an innings
const WALK = 1.7;                 // m/s: walking out
// The toss: who stands where (heading: Actor convention, atan2(dirX, dirZ)) and where the coin comes down.
const TOSS = { captain: { x: 0.5, z: CZ + 1.2, face: -PI / 2 }, umpire: { x: 1.0, z: CZ + 2.5, face: Math.atan2(-1.05, -1.25) }, coin: { x: -0.05, z: CZ + 1.25 } };
const CAPTAIN = 4;                // the fielder figure who is the other captain at the toss (mid-off: a cap, no pads)
const WALK_OUT = 14;              // m: the batters walk out from this far (and a new batter runs in from no further: hurryIn)
const WICKET_DELAY = 1.0;         // game s after a wicket before its beat may start (the field gets together)
const SKIP_OUT = 0.2, SKIP_IN = 0.35;
const STRAP = 0.82;               // the strap's scale (1.12 x 0.38 m at 2 m: ~31 degrees wide)

// ---------------------------------------------------------------- the beats
// cue: fade {out|in: s} · vantage {spot} · clear (back where you play, the toss
// figures gone) · cast (the toss figures out) · card {card} · cardOff · board
// {board} · sting {sting} · sound {name} · crowd {mood} · coin · call {fn: a
// ctx function} · walkout (the toss party out of the gate) · huddle / breakHuddle
// (the fielding side gathered in front of you, then off to their marks) · settle
// (everyone on his mark: Field settleNow) · guard (the innings break's guard of
// honour) · release (back where you play).
// wait {for, max}: the beat stands still while that is going on (at most max s).
// if: a ctx flag the cue needs.
export const BEATS = {
  // A match: you stand by the pavilion gate as the other captain and the
  // umpire walk out past you to the middle for the toss, the crowd rising; the title.
  intro: { dur: 3.2, short: 2.2, hold: true, steps: [
    { t: 0, cue: 'fade', out: 0.3, scene: 1 },
    { t: 0.32, cue: 'vantage', spot: 'gate', scene: 1 },
    { t: 0.32, cue: 'walkout', scene: 1 },
    { t: 0.35, cue: 'fade', in: 0.5, scene: 1 },
    { t: 0.35, cue: 'crowd', mood: 'build', scene: 1 },
    { t: 0.5, cue: 'crowd', mood: 'applause', scene: 1 },
    { t: 0.5, ts: 0, cue: 'board', board: 'title' },
    { t: 0.7, ts: 0, cue: 'card', card: 'title' },
    { t: 0.7, ts: 0, cue: 'sting', sting: 'menu' },
    { t: 2.75, ts: 2.0, cue: 'cardOff' },
    { t: 2.85, cue: 'fade', out: 0.3, scene: 1 },
  ] },
  // Cut to the middle: the other captain in front of you, the umpire; then you call (modes.js).
  toss: { dur: 0.7, short: 0, hold: true, steps: [
    { t: 0, cue: 'fade', out: 0.3, scene: 1 },
    { t: 0.32, cue: 'vantage', spot: 'toss' },
    { t: 0.32, cue: 'cast' },
    { t: 0.35, cue: 'fade', in: 0.35, scene: 1 },
    { t: 0.35, cue: 'board', board: 'toss' },
  ] },
  // The coin goes up, lands; the result on the big screen and the strap (he nods, offers his hand).
  flip: { dur: 3.0, short: 2.2, hold: true, steps: [
    { t: 0, cue: 'coin', scene: 1 },
    { t: 0.5, cue: 'sound', name: 'coin', scene: 1 },
    { t: 1.8, ts: 0, cue: 'sound', name: 'chime' },
    { t: 1.8, ts: 0, cue: 'board', board: 'tossResult' },
    { t: 1.8, ts: 0, cue: 'card', card: 'tossResult' },
    { t: 1.9, cue: 'crowd', mood: 'murmur', scene: 1 },
    { t: 2.95, ts: 2.1, cue: 'cardOff' },
  ] },
  // An innings starts (and a chase / an over begins): in the middle with the
  // fielding side in a huddle in front of you; it breaks and they jog out to
  // their marks; cut to where you play with everyone in place: play.
  takeField: { dur: 3.4, short: 2.2, hold: true, steps: [
    { t: 0, cue: 'fade', out: 0.3, scene: 1 },
    { t: 0.32, cue: 'clear' },
    { t: 0.33, cue: 'call', fn: 'begin' },
    { t: 0.34, cue: 'vantage', spot: 'huddle', scene: 1 },
    { t: 0.35, cue: 'huddle', scene: 1 },
    { t: 0.37, cue: 'fade', in: 0.4, scene: 1 },
    { t: 0.4, cue: 'crowd', mood: 'applause', scene: 1 },
    { t: 0.5, ts: 0.1, cue: 'card', card: 'innings' },
    { t: 0.5, ts: 0.1, cue: 'board', board: 'innings' },
    { t: 1.55, cue: 'breakHuddle', scene: 1 },
    { t: 2.55, ts: 2.1, cue: 'cardOff' },
    { t: 2.6, cue: 'fade', out: 0.3, scene: 1 },
    { t: 2.92, cue: 'release' },
    { t: 2.93, cue: 'settle' },
    { t: 2.95, cue: 'fade', in: 0.4, scene: 1 },
  ] },
  // You are out (batting), after the replay: the fielding side's celebration in
  // view (cut round to it if it is behind you), the dismissal card, the
  // walk-off fade, the new batter's card, back at the crease.
  wicket: { dur: 4.8, short: 3.0, hold: true, steps: [
    { t: 0, cue: 'fade', out: 0.25, scene: 1, if: 'behind' },
    { t: 0.27, cue: 'vantage', spot: 'behind', scene: 1, if: 'behind' },
    { t: 0.3, cue: 'fade', in: 0.35, scene: 1, if: 'behind' },
    { t: 1.0, ts: 0, cue: 'card', card: 'dismissal' },   // (the strap is low: the huddle stays in view above it)
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
  // A match's innings break: by the pavilion gate, the side that fielded
  // lines the path and claps as the new pair walks out between them past you.
  inningsBreak: { dur: 4.2, short: 3.2, hold: true, steps: [
    { t: 0, cue: 'fade', out: 0.35, scene: 1 },
    { t: 0.37, cue: 'vantage', spot: 'gate', scene: 1 },
    { t: 0.37, cue: 'guard', scene: 1 },
    { t: 0.4, cue: 'fade', in: 0.45, scene: 1 },
    { t: 0.45, cue: 'crowd', mood: 'applause', scene: 1 },
    { t: 0.5, ts: 0, cue: 'board', board: 'break' },
    { t: 0.6, ts: 0, cue: 'card', card: 'break' },
    { t: 3.7, ts: 3.0, cue: 'cardOff' },
    { t: 3.8, cue: 'fade', out: 0.35, scene: 1 },
  ] },
  // The winning moment, close: the winners celebrating near you (cut to them
  // if they are far off), then the banner; the scorecard page follows (modes.js).
  result: { dur: 4.4, short: 2.6, hold: true, steps: [
    { t: 0, cue: 'crowd', mood: 'result' },
    { t: 0, cue: 'fade', out: 0.3, scene: 1, if: 'cut' },
    { t: 0.32, cue: 'vantage', spot: 'winners', scene: 1, if: 'cut' },
    { t: 0.35, cue: 'fade', in: 0.4, scene: 1, if: 'cut' },
    { t: 1.6, ts: 0, cue: 'board', board: 'result' },
    { t: 1.8, ts: 0, cue: 'card', card: 'result' },
    { t: 3.8, ts: 2.5, cue: 'cardOff' },
    { t: 3.85, cue: 'fade', out: 0.3, scene: 1, if: 'cut' },
    { t: 4.17, cue: 'release', if: 'cut' },
    { t: 4.18, cue: 'fade', in: 0.3, scene: 1, if: 'cut' },
  ] },
  // Nets and the bowling nets: a title card, nothing else.
  nets: { dur: 3.4, short: 3.4, hold: false, steps: [
    { t: 0.3, cue: 'card', card: 'nets' },
    { t: 3.2, cue: 'cardOff' },
  ] },
};
// Cues that leave the game in a state (done at once when a beat is skipped); the rest are effects.
// The beats on the way into play: a skip goes through them at once (rush).
const RUSH = new Set(['intro', 'toss', 'flip', 'takeField', 'inningsBreak']);
const STATE_CUES = new Set(['clear', 'call', 'cardOff', 'vantage', 'cast', 'release', 'settle']);

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
    this.stage = { walkers: [], breaks: [], field: null, huddleOf: null };
    this.rushUntil = -1;
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
    // (the result: the winners' moment starts now, and where to see it from, close, is known before the plan)
    if (name === 'result' && mode !== 'off') { this.celebrate(ctx); ctx.winSpot = mode === 'on' ? this.winnersSpot(ctx) : null; ctx.cut = !!ctx.winSpot; }
    const plan = beat && mode !== 'off' ? beatPlan(beat, mode, ctx) : null;
    // (skipped a moment ago: the beats on the way to play go by at once -- their state, no show)
    const rush = plan && RUSH.has(name) && this.g.clock < this.rushUntil;
    if (rush) { this.rushUntil = this.g.clock + 1.5; for (const st of plan.steps) if (STATE_CUES.has(st.cue)) this.exec(st, ctx); if (done) done(); return false; }
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
    this.release(); this.castOff(); this.coin.hide(); this.hideCard(true); this.endStage();
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
    this.rushUntil = this.g.clock + 1.5;
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
    if (this.cur) this.stepStage(dt); else if (this.stage.walkers.length || this.stage.field) this.endStage();
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
    if (!this.seen || this.seen.inn !== inn) { this.seen = { inn, w: inn.wickets, legal: inn.legal, batted: battedNames(inn.card), bCard: inn.card, bN: battedCount(inn.card) }; this.queue.length = 0; }
    const S = this.seen;
    const skipAt = g.quickSkip && g.quickSkip.last ? g.quickSkip.last.at : null;
    if (inn.wickets > S.w && !inn.complete) this.queue.push({ name: s.isBowling ? 'wicketTaken' : 'wicket', ctx: this.wicketCtx(s, inn, S.batted), at: g.simTime + WICKET_DELAY, skipAt, born: g.clock });
    if (inn.legal > S.legal && inn.legal % 6 === 0 && !inn.complete) this.queue.push({ name: 'over', ctx: this.overCtx(s, inn), at: g.simTime, skipAt, born: g.clock });
    S.w = inn.wickets; S.legal = inn.legal;
    const bn = battedCount(inn.card);
    if (inn.card !== S.bCard || bn !== S.bN) { S.batted = battedNames(inn.card); S.bCard = inn.card; S.bN = bn; }
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
    const P = cr.pool;
    for (let i = 0; i < P.length; i++) {        // (every frame: no iterator)
      const a = P[i], k = a.task;
      if (!k || k.kind !== 'in' || k.age > 0.15 || k._near) continue;
      k._near = true;
      const dx = a.pos.x - k.to.x, dz = a.pos.z - k.to.z, d = hypot2(dx, dz);
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
        case 'vantage': this.goTo(s.spot === 'behind' ? huddleSpot(ctx.focus) : s.spot === 'winners' ? ctx.winSpot : SPOTS[s.spot]); break;
        case 'clear': this.release(); this.castOff(); this.coin.hide(); this.flip = null; this.endStage(); break;
        case 'release': this.release(); this.endStage(); break;
        case 'cast': this.castOn(); break;
        case 'card': this.showCard(s.card, ctx, s); break;
        case 'cardOff': this.hideCard(false); break;
        case 'board': this.showBoard(s.board, ctx); break;
        case 'sting': if (g.sfx && g.settings.sound) g.sfx.sting(s.sting); break;
        case 'sound': if (g.sample) g.sample(s.name, { gain: s.gain ?? 0.8 }); break;
        case 'crowd': this.crowd(s.mood, ctx); break;
        case 'coin': this.startFlip(ctx); break;
        case 'call': if (typeof ctx[s.fn] === 'function') { const f = ctx[s.fn]; ctx[s.fn] = null; f(); } break;
        case 'walkout': this.walkout(); break;
        case 'huddle': this.huddle(); break;
        case 'breakHuddle': this.breakHuddle(); break;
        case 'settle': this.settle(); break;
        case 'guard': this.guard(ctx); break;
        default:
      }
    } catch (e) { console.warn('ceremony', s.cue, e); }
  }

  // Put you at a spot (in the dark: a cut, never a move you see).
  goTo(spot) {
    const g = this.g;
    if (!spot || !g.beginViewOverride) return;
    g.beginViewOverride(spot.x, spot.z, spot.dx, spot.dz, spot.y || 0);
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
    if (!fieldingWon && ctx.winner !== 'tie') noteCrowd('batWin', g.simTime);       // (the batters' bats go up: gestures.js joyAt)
    if (fieldingWon && s && s.field && s.field.huddle) { try { s.field.logic.dead = true; s.field.huddle(); } catch { /* (no huddle: they stand) */ } }
    this.resultField = s && s.done && s.field ? s.field : null;
  }

  // ---------------------------------------------------------------- staging
  // What a beat sets moving, driven here each frame (stepStage): walkers (a
  // figure, a straight walk at its pace), huddle breaks (each man off in his
  // own time), and a finished innings' field kept alive (the innings break).
  endStage() {
    const S = this.stage;
    for (const w of S.walkers) if (w.kind === 'batter') { w.a.visible = false; w.a.h.replayVisible = false; }
    S.walkers.length = 0; S.breaks.length = 0; S.field = null;
  }
  stepStage(dt) {
    const g = this.g, S = this.stage, t = g.simTime;
    for (const b of S.breaks) if (!b.done && (b.at -= dt) <= 0) { b.done = true; const f = b.f; f.state = 'return'; f.target = null; f.huddleUntil = null; f.huddleInner = false; }
    for (const w of S.walkers) {
      w.x += w.vx * dt; w.z += w.vz * dt;
      const sp = hypot2(w.vx, w.vz), hd = Math.atan2(w.vx, w.vz);
      if (w.kind === 'fielder') { const st = w.st; st.x = w.x; st.z = w.z; st.speed = sp; st.face = hd; w.a.update(Math.max(dt, 1e-4), st, { t, ball: null, delivering: false, cam: g.eye ? g.eye.p : null, others: [] }); }
      else {
        w.a.pos.set(w.x, 0, w.z); w.a.speed = sp; w.a.heading = hd;
        if (w.kind === 'umpire') w.a.update(Math.max(dt, 1e-4), g.clock, null);
        else w.a.updateMoving(Math.max(dt, 1e-4), t, null);
      }
    }
    if (S.field && g.session && g.session.field === S.field) S.field.update(dt, t);
  }
  walker(kind, a, x, z, vx, vz, st = null) {
    a.cut(); a.place(x, z, Math.atan2(vx, vz)); a.visible = true;
    this.stage.walkers.push({ kind, a, x, z, vx, vz, st });
  }

  // The match intro: the other captain and the umpire walk out of the gate
  // past you (4-5 m off) toward the middle for the toss.
  walkout() {
    const g = this.g;
    if (g.session || !g.fieldView) return;
    const cap = g.fieldView.actors[CAPTAIN], U = g.umpires;
    if (cap) {
      cap.h.setTeam('away'); cap.foldArms = 0;
      this.walker('fielder', cap, GATE.x - 4.4, GATE.z - 0.3, -WALK, -0.06, { x: 0, z: 0, face: 0, speed: WALK, state: 'return', action: null, crouch: false, armsUp: false, huddle: 0, ceremony: true });
    }
    if (U && U.main) { U.main.still = false; this.walker('umpire', U.main, GATE.x - 3.3, GATE.z + 0.55, -WALK * 1.04, -0.08); }
  }

  // An innings starts: the fielding side in a huddle HUDDLE_AT m in front of
  // you (in the dark: nobody is seen put there), then off to their marks, a
  // few at a time.
  huddle() {
    const g = this.g, s = g.session, L = s && s.field && s.field.logic, v = this.view;
    if (!L || !v) return;
    const H = { x: v.x + v.dx * HUDDLE_AT, z: v.z + v.dz * HUDDLE_AT };
    const F = L.fielders.filter((f) => !f.bowler), n = F.length, base = Math.atan2(-v.dx, -v.dz), r = 1.5;
    F.forEach((f, i) => {
      const a = base + (i + 0.5) * 2 * PI / n;
      f.pos.set(H.x + Math.sin(a) * r, 0, H.z + Math.cos(a) * r);
      f.vel.set(0, 0, 0); f.speed = 0; f.state = 'huddle'; f.target = f.pos.clone(); f.action = null;
      (f.huddleAt = f.huddleAt || f.pos.clone()).set(H.x, 0, H.z);
      f.huddleInner = true; f.huddleCenter = false; f.huddleUntil = g.simTime + 60; f.huddleMood = null;
      f.face = f.yaw = Math.atan2(H.x - f.pos.x, H.z - f.pos.z);
    });
    if (g.fieldView && g.fieldView.placeAll) g.fieldView.placeAll(L.states());
    this.stage.huddleOf = L;
  }
  breakHuddle() {
    const L = this.stage.huddleOf;
    if (!L) return;
    this.stage.huddleOf = null;
    L.fielders.forEach((f, i) => { if (f.state === 'huddle') this.stage.breaks.push({ f, at: ((i * 7) % 5) * 0.11 }); });
  }
  // Everyone on his mark (in the dark): the fielders, the batters, the umpires, the AI bowler on his.
  settle() {
    const g = this.g, s = g.session;
    this.stage.huddleOf = null; this.stage.breaks.length = 0;
    if (!s) return;
    if (s.field && s.field.settleNow) s.field.settleNow();
    if (s.bowlerFig && s.bowlerFig.placeAtMark && s.bowlerFig.actor && s.bowlerFig.actor.home) { try { s.bowlerFig.placeAtMark(); } catch { /* (no mark yet: he walks to it) */ } }
  }

  // The innings break: the side that fielded in two lines either side of the
  // path from the gate, clapping, as the new pair walks out between them past you.
  guard(ctx) {
    const g = this.g, s = g.session, L = s && s.field && s.field.logic;
    if (L) {
      const F = L.fielders.filter((f) => !f.bowler);
      F.forEach((f, i) => {
        const k = Math.floor(i / 2), near = i % 2 === 0, x = GATE.x - 1.6 - k * 1.55 - (near ? 0 : 0.75), z = GATE.z + (near ? 1.5 : -1.5);
        f.pos.set(x, 0, z); f.vel.set(0, 0, 0); f.speed = 0; f.state = 'huddle'; f.target = f.pos.clone(); f.action = null;
        (f.huddleAt = f.huddleAt || f.pos.clone()).set(x, 0, GATE.z);
        f.huddleInner = false; f.huddleCenter = false; f.huddleUntil = g.simTime + 60; f.huddleMood = null;
        f.face = f.yaw = near ? PI : 0;
      });
      if (g.fieldView && g.fieldView.placeAll) g.fieldView.placeAll(L.states());
      this.stage.field = s.field;
    }
    const cr = g.crew, team = ctx.chasing === HOME.name ? 'home' : 'away';
    if (cr && cr.spares) cr.spares.slice(0, 2).forEach((a, k) => {
      a.task = null; a.h.setTeam(team); a.h.setFade(1); a.h.replayVisible = false;
      this.walker('batter', a, GATE.x - 1.8 - k * 0.6, GATE.z + (k ? 0.45 : -0.45), -1.75, -0.03);
    });
  }

  // Where to see the winners from, close: beside the man raising his bat, or
  // the fielding side's huddle (you bowling: it is round you, no cut). null: stay.
  winnersSpot(ctx) {
    const g = this.g, s = g.session;
    if (!s) return null;
    let f = null;
    if (ctx.fieldingWon) {
      if (s.isBowling) return null;
      const L = s.field && s.field.logic;
      f = L && L.huddle && L.huddle.focus ? L.huddle.focus : s.bowlerFig && s.bowlerFig.actor && s.bowlerFig.actor.visible ? s.bowlerFig.actor.pos : null;
    } else if (ctx.winner !== 'tie') {
      const a = s.isBowling ? g.batterView && g.batterView.actor : g.nonStrikerView && g.nonStrikerView.actor;
      f = a && a.visible ? a.pos : null;
    }
    if (!f) return null;
    const side = f.x <= 0 ? -1 : 1;
    return toward(f.x + side * (ctx.fieldingWon ? 5.5 : 3.6), f.z + 1.2, f.x, f.z);
  }

  // ---------------------------------------------------------------- the toss figures
  castOn() {
    const g = this.g;
    if (this.cast || !g.fieldView || g.session) return;
    this.endStage();                  // (the walk out is over: they are in the middle)
    const cap = g.fieldView.actors[CAPTAIN], U = g.umpires;
    if (!cap) return;
    cap.h.setTeam('away'); cap.cut(); cap.place(TOSS.captain.x, TOSS.captain.z, TOSS.captain.face); cap.visible = true;
    cap.foldArms = 0;                 // (standing square to you, arms by his sides: no folded arms, no idle gestures)
    const st = { x: TOSS.captain.x, z: TOSS.captain.z, face: TOSS.captain.face, speed: 0, state: 'set', action: null, crouch: false, armsUp: false, huddle: 0, ceremony: true };
    let ump = null;
    if (U && U.main) {
      ump = U.main;
      U.show(true); if (U.leg) U.leg.visible = false;
      if (!ump.mark) U.place(false);
      ump.mark.set(TOSS.umpire.x, 0, TOSS.umpire.z); ump.off.set(0, 0, 0); ump.goal.x = TOSS.umpire.x; ump.goal.z = TOSS.umpire.z; ump.rest = TOSS.umpire.face;
      ump.task = null; ump.speed = 0; ump.cut(); ump.place(TOSS.umpire.x, TOSS.umpire.z, TOSS.umpire.face); ump.still = true; ump.nodAt = null;
      U.setLook && U.setLook(new THREE.Vector3(TOSS.coin.x, 0.6, TOSS.coin.z));
    }
    this.cast = { cap, st, ump };
  }
  castOff() {
    const g = this.g, c = this.cast;
    if (!c) return;
    this.cast = null;
    c.cap.foldArms = c.cap.keeper ? 0 : 0.25;
    if (c.ump) { c.ump.still = false; c.ump.nodAt = null; }
    if (!g.session || !g.fieldView.visible) c.cap.visible = false;
    if (c.ump && g.umpires) { g.umpires.show(false); g.umpires.place(false); }
  }
  updateCast(dt) {
    const c = this.cast, g = this.g;
    if (!c) return;
    const t = g.simTime;
    c.cap.update(Math.max(dt, 1e-4), c.st, { t, ball: null, delivering: false, cam: g.eye ? g.eye.p : null, others: [] });
    // The toss (src/render/ceremonyPoses.js): the coin held out and flicked up
    // off the thumb, his eyes after it up and down, leaning over to read it;
    // then a nod to you and his hand out to shake yours. The umpire stands
    // square, hands behind his back, watching the coin, and nods at the result.
    const F = this.flip;
    if (F) {
      const coinAt = this.coin.mesh.visible ? this.coin.mesh.position : null;
      coinToss(c.cap, F.tf, coinAt, Math.max(dt, 1e-4), g.eye ? g.eye.p : null);
      nod(c.cap, F.tf - 2.15);
      offerHand(c.cap, envelope(F.tf - 2.5, 2.4, 0.4, 0.5), t);
      c.cap.h.syncShadow();
      if (c.ump && g.umpires) {
        if (coinAt) g.umpires.setLook(coinAt);
        if (F.tf >= 2.25 && c.ump.nodAt == null) c.ump.nod(g.clock);
      }
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
        if (F.tf >= TOSS_AT) {
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
      // a broadcast strap: one at a time, low (22 degrees down) and square on, under whoever the beat is about
      const xr = !!this.g.input?.xr, d = xr ? 2.0 : 2.4;
      const yaw = cue.yaw ?? 0, el = cue.el ?? (xr ? -0.4 : -0.3);
      const c = Math.cos(yaw), sn = Math.sin(yaw), fx = _f.x * c - _f.z * sn, fz = _f.x * sn + _f.z * c;
      P.mesh.position.set(e.p.x + fx * d, e.p.y + el * d, e.p.z + fz * d);
      P.mesh.lookAt(e.p.x, P.mesh.position.y, e.p.z);
    }
    P.mesh.visible = true;
    if (!this.cardOn) { this.cardA = 0; this.cardT = 0; }
    this.cardOn = true;
  }
  // A beat's strap is up (the UI holds its own messages and control hints back meanwhile: one card at a time).
  get cardUp() { return this.cardOn || this.cardA > 0.01; }
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
    if (m.visible) { const k = STRAP * (0.96 + 0.04 * this.cardA); m.scale.set(k, k, 1); }
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
// (a man only ever goes from not having batted to having batted: the names change only when this count does,
// so watch() builds the set again only then, not every frame)
function battedCount(card) { let n = 0; if (card) for (let i = 0; i < card.batters.length; i++) if (card.batters[i].batted) n++; return n; }

// Where to stand to see a celebration behind you: down the pitch, looking back at it.
function huddleSpot(f) {
  if (!f) return null;
  const x = f.x * 0.5, z = Math.min(f.z - 7.5, -6), dx = f.x - x, dz = f.z - z, d = hypot2(dx, dz) || 1;
  return { x, z, dx: dx / d, dz: dz / d };
}

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
    const dx = to.x - from.x, dz = to.z - from.z, L = hypot2(dx, dz) || 1;
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
    if (c.titleCard) return CARDS.title(c);
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
