// Appeals, the on-field decision, and DRS reviews (shared by the batting and
// bowling sessions): LBW, and catches where the edge is the question (caught
// behind, bat-pad, a faint edge to the slips).
//
//   LBW      the pad (or the body) is struck: the fielders go up (or, when you
//            bowl and they keep quiet, you may appeal with B). The umpire's
//            decision (lbw.js umpireDecision; a faint inside edge is missed
//            sometimes), then the aggrieved side may review: Snicko and Hot
//            Spot first ("bat first?") when the bat was involved, then ball
//            tracking.
//   caught   a catch off an edge (edgeTrack.js edgeQuestion), or the keeper
//            taking a ball that went close to the bat / with a noise as it
//            passed (behind): an appeal, the umpire's decision (edgeTrack.js
//            umpireCaught: thick edges almost always right, faint ones missed,
//            pad / bat-on-ground noise sometimes given), a review decided by
//            Snicko and Hot Spot. A clean catch off the middle is out by
//            itself (no flow at all): the catching itself is untouched.
//
// Order with the replay (DECISIONS R1): the ball, the appeal / decision /
// review (the session stays in 'review'), the verdict, then the ball's replay.
// What really touched what comes from the contact log (g.contacts,
// edgeTrack.js), which the physics fills every step.
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { PITCH } from '../physics/pitch.js';
import { predict } from '../physics/trajectory.js';
import { HINTS } from '../ui/controllerHint.js';
import { trackLbw, umpireDecision, reviewOutcome, lawOut } from './lbw.js';
import { shouldAppeal } from './bowlingRules.js';
import {
  ContactLog, edgeTruth, edgeEvidence, edgeInvolved, umpireCaught, umpireHearsEdge, fieldersAppeal,
  appealWorthy, edgeQuestion, caughtReview, aiWillReview, EDGE,
} from './edgeTrack.js';

// Has an unbatted ball reached the batter's legs? (bx, bz) = where the batter
// stands. The box reaches `front` m toward the bowler and `back` m behind.
// (Where he stood is kept on the ball for the contact log / Hot Spot.)
export function padHit(ball, bx, bz, { halfX = 0.2, front = 0.24, back = 0.24, top = 0.74 } = {}) {
  if (!ball.active || ball.batted || ball.padded || ball.thrown || ball.vel.z <= 0) return false;
  const p = ball.pos;
  const hit = p.y < top && Math.abs(p.x - bx) < halfX && p.z > bz - front && p.z < bz + back;
  if (hit) ball.padAt = { x: bx, z: bz, halfX };
  return hit;
}

// An edge onto the pad: a batted ball, EDGE.batPadGap s or less after the bat,
// still going toward the stumps, in the same box.
export function padHitAfterEdge(ball, bx, bz, box = {}, since = 0) {
  if (!ball.active || !ball.batted || ball.padded || ball.thrown || ball.vel.z <= 0.5 || since > EDGE.batPadGap) return false;
  const { halfX = 0.2, front = 0.24, back = 0.24, top = 0.74 } = box;
  const p = ball.pos;
  const hit = p.y < top && Math.abs(p.x - bx) < halfX && p.z > bz - front && p.z < bz + back;
  if (hit) ball.padAt = { x: bx, z: bz, halfX };
  return hit;
}

// Take the pace off the ball after it hits the pad.
export function deflectOffPad(ball, rng = Math.random, k = 1) {
  ball.padded = true;
  ball.vel.set(ball.vel.x * 0.3 + (rng() - 0.5) * 2.5 * k, Math.abs(ball.vel.y) * 0.3 + 0.6 * k, -ball.vel.z * 0.12);
  ball.spin.scale(0.2);
}

// The ball changed course off the pad after the bat: the fielders plan again
// (a catch you were waiting for that has not started yet is dropped).
export function replanAfterPad(field, ball, t) {
  if (!field || !field.onHit) return;
  const c = field.catch;
  if (c && c.state === 'live') return;                    // already under it
  if (c && c.state === 'pending') { c.f.playerControlled = false; field.catch = null; }
  field.onHit(ball, t, predict(ball, { maxTime: 9, h: 1 / 240 }));
}

const ACC = { easy: 0.8, medium: 0.86, hard: 0.92 };
export const APPEAL = {
  window: 2.6,          // s (real) you have to appeal when the fielders keep quiet
  quiet: 0.12,          // chance the fielders stay quiet on a shout they would make (unsighted, not sure)
  hearEdge: { faint: 0.1, thin: 0.4, thick: 0.75, full: 0.9 },   // the fielders hear an edge onto the pad (then no LBW shout)
};
const _head = new THREE.Vector3();

export class LbwFlow {
  constructor(game, reviews) {
    this.g = game;
    this.reviews = reviews;          // { player, ai } left this innings (reviews.js)
    this.active = false;
    this.done = false;
    this.out = false;
    this.kind = 'lbw';
    this.noAppeal = false;
  }

  get accuracy() { return ACC[this.g.settings.difficulty] || 0.86; }
  rng() { return this.g.rng ? this.g.rng() : Math.random(); }

  // This delivery's contact log, frozen (the next ball will not change it).
  snapshot() {
    const c = this.g.contacts;
    return c ? c.snapshot() : new ContactLog();
  }

  // Would the fielders stay quiet on an LBW shout? (Then, bowling, you can appeal.)
  fieldersQuiet() { return this.rng() < APPEAL.quiet; }

  // The pad strike in the live log now (the log itself would only see it on
  // the next physics step).
  notePad(impactState) {
    const c = this.g.contacts, b = this.g.world && this.g.world.ball;
    if (!c || c._padSeen) return;
    c._padSeen = true;
    c.addPad({ t: this.g.world ? this.g.world.time : 0, pos: impactState.pos, vin: impactState.vel, at: (b && b.padAt) || impactState.padAt || null });
  }

  _init({ kind, path = null, playerIsBatter, outRes = null, notOutRes = null, behind = false, log = null }) {
    this.kind = kind;
    this.path = path;
    this.playerIsBatter = playerIsBatter;
    this.log = log || this.snapshot();
    this.truth = edgeTruth(this.log);
    this.outRes = outRes; this.notOutRes = notOutRes; this.behind = behind;
    this.active = true; this.done = false; this.out = false; this.finalOut = false;
    this.reviewed = false; this.noAppeal = false; this.appealBy = null;
    this.canPlayer = false; this.aiWill = false; this.track = null;
    this.t = 0; this.phase = null;
  }

  // ------------------------------------------------------------- entry points

  // An LBW shout. by: 'fielders' (they go up), 'player' (you appeal), 'offer'
  // (they kept quiet: you may appeal with B; no press, no appeal).
  start({ impactState, path, shotOffered, playerIsBatter, by = 'fielders' }) {
    this.notePad(impactState);
    this._init({ kind: 'lbw', path, playerIsBatter });
    this.track = trackLbw({ impactState, cfg: CONFIG });
    this.shotOffered = shotOffered;
    this.truthOut = lawOut(this.track, { shotOffered, batFirst: this.truth.batFirst });
    if (by === 'offer') this._offer();
    else this._appeal(by);
  }

  // A catch (field.result() kind 'caught'). A clean catch off the middle of
  // the bat is out as it stands: false, nothing starts. Off an edge (or bat-
  // pad) the appeal starts (or, bowling and the fielders quiet, your chance
  // to appeal; batting and they kept quiet, it is not out): true.
  caught(res, { notOut, path = null, playerIsBatter }) {
    const log = this.snapshot();
    const truth = edgeTruth(log);
    const lb = log.lastBall;
    const catchDist = lb ? Math.hypot(lb.x, lb.z - PITCH.battingStumpsZ) : 0;
    if (!edgeQuestion(truth, { catchDist })) return false;
    this._init({ kind: 'caught', path, playerIsBatter, outRes: res, notOutRes: notOut, log, behind: /keeper/i.test(res.by || '') });
    this.truthOut = truth.touched;
    if (res.by === 'you') this._appeal('player');                       // your own catch: everyone goes up
    else if (fieldersAppeal(truth, { rng: () => this.rng(), catchTaken: true })) this._appeal('fielders');
    else if (!playerIsBatter) this._offer();
    else { this.noAppeal = true; this.finish(false); }                   // nobody went up: not out
    return true;
  }

  // The keeper took a ball that beat the bat: caught behind? Only when it went
  // close to the bat or there was a noise as it passed. true = an appeal (or
  // your chance to appeal) has started.
  behind({ notOut, path = null, playerIsBatter }) {
    const log = this.snapshot();
    const truth = edgeTruth(log);
    if (truth.touched || !appealWorthy(truth)) return false;
    if (playerIsBatter && this.g.diff && this.g.diff.lbwAgainstPlayer === false) return false;   // easy: no phantom edges against you
    const appeal = fieldersAppeal(truth, { rng: () => this.rng(), catchTaken: false });
    if (!appeal && playerIsBatter) return false;
    if (!appeal && truth.pass.d > 0.12 && truth.noise !== 'noise') return false;   // not worth offering you
    this._init({ kind: 'caught', path, playerIsBatter, outRes: { kind: 'caught', by: 'Keeper' }, notOutRes: notOut, log, behind: true });
    this.truthOut = false;
    if (appeal) this._appeal('fielders');
    else this._offer();
    return true;
  }

  // An edge onto the pad. Returns null (no pad), 'appeal' (the fielders go up
  // for LBW: the review will find the bat first) or 'play' (off the pad, still
  // in play: the fielders plan again). at: where the batter stands { x, z }.
  batPad(ball, at, box = undefined, { path = null, shotOffered = true, playerIsBatter, since = 0, field = null, t = 0 } = {}) {
    if (!padHitAfterEdge(ball, at.x, at.z, box, since)) return null;
    const impact = ball.clone();
    deflectOffPad(ball, () => this.rng(), 0.6);
    this.notePad(impact);
    let track = null;
    try { track = trackLbw({ impactState: impact, cfg: CONFIG }); } catch { track = null; }
    const truth = edgeTruth(this.g.contacts || new ContactLog());
    const heard = this.rng() < (APPEAL.hearEdge[truth.thickness || 'thin'] ?? 0.4);
    if (track && !heard && shouldAppeal(track, { shotOffered }) && lawOut(track, { shotOffered })) {
      this._init({ kind: 'lbw', path, playerIsBatter });
      this.track = track;
      this.shotOffered = shotOffered;
      this.truthOut = lawOut(track, { shotOffered, batFirst: this.truth.batFirst });
      this._appeal('fielders');
      return 'appeal';
    }
    replanAfterPad(field, ball, t);
    return 'play';
  }

  // What the delivery comes to, for the session's finish(). notOutLbw: the
  // not-out result of an LBW in this session ({ kind: 'dot', padded: true }).
  result(notOutLbw = { kind: 'dot', padded: true }) {
    if (this.kind === 'caught') return this.out ? this.outRes : { ...this.notOutRes };
    return this.out ? { kind: 'lbw' } : { ...notOutLbw, ...(this.noAppeal ? { noAppeal: true } : {}) };
  }

  // ------------------------------------------------------------- phases

  _offer() {
    this.phase = 'window'; this.t = 0;
    this.offered = true;
  }

  _appeal(by) {
    const g = this.g, acc = this.accuracy, rng = () => this.rng();
    this.appealBy = by;
    if (this.kind === 'lbw') {
      const heard = umpireHearsEdge(this.truth, { rng, accuracy: acc });
      this.onFieldOut = umpireDecision(this.track, { shotOffered: this.shotOffered, batFirst: heard, rng, accuracy: acc });
    } else this.onFieldOut = umpireCaught(this.truth, { rng, accuracy: acc });
    this.phase = 'appeal'; this.t = 0;
    g.sample('appeal') || g.sample('howzat');
    g.sample('howzat', { gain: 0.9 });
    if (this.kind === 'lbw') g.say('appeal');     // (its lines include "hit the pad", "leg before": not for a catch)
    g.crowdReact('appeal');
    g.ui.prompt(by === 'player' && !(this.outRes && this.outRes.by === 'you') ? 'HOWZAT?! — you appeal' : 'HOWZAT?!', 1.6, '#ffd34d');
    g.ui.setHud({ big: 'Appeal…', bigColor: '#ffd34d', detail: '' });     // (not the last ball's result)
    if (this.kind === 'lbw') g.sample('pad', { gain: 0.9 });
  }

  startReview(byPlayer) {
    const g = this.g;
    this.reviewed = true; this.reviewBy = byPlayer ? 'player' : 'ai';
    const seed = ((Math.round((this.log.launchT || 0) * 1000) >>> 0) % 100000) + 1;
    const hp = g.input.headPose.p;
    _head.set(hp.x, hp.y, hp.z);
    if (this.kind === 'lbw') {
      const showEdge = edgeInvolved(this.truth);
      const ev = showEdge ? edgeEvidence(this.log, { review: 'lbw', seed }) : null;
      const b = this.truth.bat;
      const batText = this.truth.batFirst ? (b.where === 'edge' && b.edge ? `${b.edge.toUpperCase()} EDGE FIRST` : b.where === 'glove' ? 'GLOVE FIRST' : 'BAT FIRST') : null;
      this.outcome = reviewOutcome(this.track, { onFieldOut: this.onFieldOut, shotOffered: this.shotOffered, batFirst: this.truth.batFirst, edgeRows: ev ? ev.rows : null, batText });
      g.drs.startLbw({ track: this.track, deliveryPath: this.path, onFieldOut: this.onFieldOut, outcome: this.outcome, viewerPos: _head, edge: ev });
    } else {
      const ev = edgeEvidence(this.log, { review: 'caught', seed });
      this.outcome = caughtReview(this.truth, { onFieldOut: this.onFieldOut });
      g.drs.startCaught({ edge: ev, deliveryPath: this.path, onFieldOut: this.onFieldOut, outcome: this.outcome, viewerPos: _head, title: this.behind ? 'CAUGHT BEHIND' : 'CAUGHT' });
    }
    if (!this.playerIsBatter) g.drs.placeBoard(_head, { distance: 9, scale: 2.2, height: 3.4 });
    g.ui.showHud(false);          // the review board takes its place
    g.ui.setHud({ big: 'Under review…', bigColor: '#7fd3ff' });
    g.umpires.signal('review', g.clock);
    g.say('review');
    g.ui.prompt(byPlayer ? 'You review the decision' : this.playerIsBatter ? 'The fielding side reviews' : 'The batter reviews', 2.5, '#7fd3ff');
    this.phase = 'review'; this.t = 0;
  }

  finish(out) {
    this.out = out; this.done = true; this.active = false;
    this.g.drs.hide();
    this.g.ui.showHud(true);
  }

  // dt = real seconds.
  update(dt) {
    const g = this.g;
    if (!this.active) return;
    this.t += dt;
    if (this.phase === 'window') {
      // The fielders kept quiet: the ball is dead, you may appeal (B) — only
      // now, never while the ball is on its way.
      const R = g.input.right;
      if (this.t > 0.2) {
        g.hint([HINTS.appeal], 0.4);
        if (!this.windowTold) {
          this.windowTold = true;
          g.ui.prompt(`No appeal — ${g.input.xr ? 'B' : 'X'} to appeal`, APPEAL.window - 0.2, '#cfe3f5');
          g.ui.setHud({ big: 'Appeal?', bigColor: '#cfe3f5', detail: '' });
        }
      }
      if (this.t > 0.15 && R.buttons.b.down) {
        if (R.buttons.b.swallow) R.buttons.b.swallow();
        this._appeal('player');
        return;
      }
      if (this.t > APPEAL.window) { this.noAppeal = true; this.finish(false); }
    } else if (this.phase === 'appeal' && this.t > 1.7) {
      const out = this.onFieldOut;
      g.umpires.signal(out ? 'out' : 'notout', g.clock);
      g.sample(out ? 'umpire_out' : 'umpire_not_out');
      if (this.kind === 'lbw' || !out) g.say('lbw_call', { out: this.kind === 'lbw' && out });
      g.ui.prompt(out ? (this.kind === 'lbw' ? 'OUT — LBW' : 'OUT — CAUGHT') : 'NOT OUT', 2.2, out ? '#ff5a5a' : '#7dff8a');
      g.ui.setHud({ big: out ? `Given OUT — ${this.kind === 'lbw' ? 'LBW' : 'CAUGHT'}` : 'NOT OUT', bigColor: out ? '#ff5a5a' : '#7dff8a' });
      this.phase = 'decision'; this.t = 0;
      // The ball is dead: it doesn't lie about on the pitch through the review.
      if (this.kind === 'lbw') {
        g.world.removeBall();
        g.ballView.setVisible(false);
        g.ballView.clearTrail?.();
      }
      const playerAggrieved = this.playerIsBatter ? out : !out;
      this.canPlayer = playerAggrieved && this.reviews.player > 0;
      this.aiWill = !playerAggrieved && aiWillReview({
        kind: this.kind, aiBatting: !this.playerIsBatter, onFieldOut: out, truthOut: this.truthOut, left: this.reviews.ai, rng: () => this.rng(),
      });
    } else if (this.phase === 'decision') {
      const R = g.input.right, L = g.input.left;
      if (this.canPlayer) {
        if (this.t > 0.9) { g.ui.prompt(`Review? ${this.reviews.player} left`, 0.5, '#7fd3ff'); g.hint([HINTS.review], 0.5); }
        if (this.t > 0.15 && (R.buttons.a.down || L.buttons.a.down)) {
          for (const b of [R.buttons.a, L.buttons.a]) if (b.down && b.swallow) b.swallow();
          this.startReview(true);
          return;
        }
      } else if (this.aiWill && this.t > 1.4) { this.startReview(false); return; }
      if (this.t > (this.canPlayer ? 4.5 : this.aiWill ? 2 : 1.8)) this.finish(this.onFieldOut);
    } else if (this.phase === 'review') {
      g.drs.update(dt);
      for (const cue of g.drs.takeCues()) {
        if (cue === 'stinger') g.sample('drs_stinger');
        else if (cue.startsWith('chime')) g.sample('chime', { gain: 0.8 });
        else if (cue === 'out') g.sample('umpire_out');
        else if (cue === 'not_out') g.sample('umpire_not_out');
        else if (cue === 'spike') g.sample('bat_edge', { gain: 0.35 });
      }
      if (g.drs.done) {
        const r = g.drs.result;
        settleReview(this.reviews, this.reviewBy, r);
        g.say('review_result', { overturned: r.out !== this.onFieldOut, umpires_call: r.umpiresCall });
        g.umpires.signal(r.out ? 'out' : 'notout', g.clock);
        g.ui.prompt(r.out ? 'DECISION: OUT' : 'DECISION: NOT OUT', 2.5, r.out ? '#ff5a5a' : '#7dff8a');
        g.ui.setHud({ big: r.out ? `OUT — ${this.kind === 'lbw' ? 'LBW' : 'CAUGHT'}` : 'NOT OUT', bigColor: r.out ? '#ff5a5a' : '#7dff8a' });
        // The review is over: its tracking line, markers and board go now
        // (the board has already held the decision), and the HUD comes back.
        g.drs.hide();
        g.ui.showHud(true);
        this.finalOut = r.out;
        this.phase = 'final'; this.t = 0;
      }
    } else if (this.phase === 'final' && this.t > 1.6) {
      this.finish(this.finalOut);
    }
  }
}

// A review by `side` is over: lost unless it was kept (overturned, umpire's call).
export function settleReview(reviews, side, { reviewKept }) {
  if (reviews.settle) return reviews.settle(side, { reviewKept });
  if (!reviewKept) reviews[side] = Math.max(0, (reviews[side] || 0) - 1);
  return reviews[side];
}
