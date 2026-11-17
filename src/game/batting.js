// Batting session: the player bats against the bowling machine (nets) or an
// AI bowling attack (run chase / match) with fielders, umpires and an innings.
//
// Controls (XR / desktop):
//   right trigger / Shift   stride down the pitch (more power, harder to time)
//   right grip / S          sweep (swing toward the off side = reverse sweep;
//                           with the trigger too = slog sweep)
//   left stick / arrows     move in the crease
//   X / Space               RUN (and "next ball" in the nets)
//   Y / G                   turn back mid-run        hold left (off-hand) trigger / V   dive for the line
//   left (off-hand) trigger, ball dead: skip to the next delivery (quickSkip.js)
//   A / Z                   review a decision against you (LBW, caught off an edge)
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { Vec3, msToKmh, clamp } from '../physics/math.js';
import { lengthName, lineName, groundDistance, battingPoppingZ } from '../physics/pitch.js';
import { machineDelivery } from '../physics/bowlingMachine.js';
import { predict, crossingAtZ } from '../physics/trajectory.js';
import { LbwFlow, padHit, deflectOffPad } from './lbwFlow.js';
import { isWide, strikerHeights, isShortPitched, BouncerCount, bouncerCall } from './bowlingRules.js';
import { ThirdUmpireFlow } from './thirdUmpire.js';
import { Reviews } from './reviews.js';
import { BackFoot, creaseShort } from './crease.js';
import { HINTS } from '../ui/controllerHint.js';
import { ShotEvidence, pointVelocity } from './shotOffered.js';
import { sweepShot } from './sweepShot.js';
import { BatGeometry } from '../physics/bat.js';

const _fw = new Vec3(), _toe = new Vec3(), _lever = new Vec3(), _bv = new Vec3(), _mid = new Vec3();
let _sweetY = null;               // the middle of the (visible) bat, along its +Y from your hand
const UNHIT_DEAD = 6;           // s of game time after the release: a ball nobody hit and nobody is doing anything with is dead
const ATTACK_DEAD = 2.5;         // s after the keeper's attack was due: dead ball, whatever became of it
const PLAYER_PAD = { halfX: 0.15, front: 0, back: 0.36, top: 0.7, dx: -0.07 };   // (m from your head: the legs are behind it and to its leg side, footwork.js FEET)
import { Innings, runsText } from './scoring.js';

const KMH = (v) => Math.round(msToKmh(v));
const _hand = new THREE.Vector3();
const STANCE = { x: -0.4, z: -1.05 };
const ANNOUNCE = 1.8;            // s a new bowler's card / a free hit is up before the bowler sets off
const SKIP_ANNOUNCE = 1.0;       // ... after a skip to the next ball (skipToNext)
// Between balls the bowler waits for everyone to be in place: after
// WAIT_HURRY s whoever is not runs; after the cap the ball is bowled anyway.
const WAIT_HURRY = 2.5, WAIT_CAP = 7, WAIT_CAP_WICKET = 13;
// Down low yourself = a sweep (readLowSweep): eyes below `on` x your standing eye height (out above `off`),
// the middle of the bat below `bat` x it and across the line or swinging round (> `swing` m/s), `hold` s;
// out too when the middle of the bat stays above `high` x standing for `highFor` s; never to a ball
// coming at you above `short` x standing.
const LOW = { on: 0.68, off: 0.76, bat: 0.3, swing: 3, hold: 0.12, high: 0.55, highFor: 0.15, short: 0.55 };
const SWEEP_IN = 4.5, SWEEP_OUT = 3.5;   // 1/s: the sweep button's hold on your figure comes in over 0.22 s, goes over 0.29 s

// The shot read-out. launch: degrees above the horizontal of the ball as it
// left the bat (whichever way it went); where: which way it went, as a
// fielding position (a right-hander's: off side +x, the bowler -z), so a top
// edge that climbs over your shoulder reads "41° · fine leg", not a low drive.
export function launchAngle(v) { return Math.atan2(v.y, Math.hypot(v.x, v.z)) * 180 / Math.PI; }
export function shotWhere(v) {
  if (Math.hypot(v.x, v.z) < 0.15 * Math.hypot(v.x, v.y, v.z) + 1e-6) return v.y > 0 ? 'straight up' : 'into the ground';
  const a = Math.atan2(v.x, -v.z) * 180 / Math.PI, d = Math.abs(a), off = a > 0;   // 0: back past the bowler, 90: square, 180: behind
  if (d < 12) return 'straight';
  if (d > 168) return 'over the keeper';
  const names = off ? [[27, 'mid-off'], [50, 'extra cover'], [72, 'cover'], [104, 'point'], [135, 'gully'], [168, 'third man']]
    : [[27, 'mid-on'], [62, 'midwicket'], [104, 'square leg'], [135, 'backward square'], [168, 'fine leg']];
  for (const [lim, n] of names) if (d < lim) return n;
  return off ? 'third man' : 'fine leg';
}
// (h.load, 0..1, when the swing reports it: how full the backlift was.)
export function shotReadout(h) {
  const load = h.load != null ? ` · backlift ${Math.round(h.load * 100)}%` : '';
  return `Exit ${KMH(h.exit)} km/h · ${Math.round(h.launch)}° · ${shotWhere(h.dir)} · bat ${h.batSpeed.toFixed(1)} m/s${load} · sweet ${Math.round(h.quality * 100)}%${h.advanced ? ' · stepped out' : ''}\nCarry ${Math.round(h.carry)} m`;
}

// The running buttons (while the batters can run): in the headset Y turns
// back and the off-hand trigger (held) dives; on a monitor G turns back and
// V dives (the keys stand in for the left trigger and Y: input.js).
export function runControls(input, off) {
  const L = input.left;
  if (!input.xr) return { back: L.buttons.trigger, dive: L.buttons.b, diveHand: L };
  return { back: L.buttons.b, dive: off.buttons.trigger, diveHand: off };
}

export class BattingSession {
  constructor(game, { kind = 'nets', title = 'Nets · Batting', innings = null, bowler = 'machine', fielders = null, aiBowler = null, onDone = null } = {}) {
    this.game = game;
    this.kind = kind;
    this.title = title;
    this.innings = innings;
    this.bowler = bowler;          // 'machine' | 'ai'
    this.field = fielders;         // FieldController or null
    this.aiBowler = aiBowler;
    this.bowlerFig = null;
    this.onDone = onDone;
    this.isBowling = false;
    this.state = 'idle';
    this.timer = 1.2;
    this.stats = { balls: 0, fours: 0, sixes: 0, middled: 0, edges: 0, bowled: 0, bestCarry: 0 };
    this.done = false;
    this.crease = { x: 0, z: 0 };
    this.advance = 0;
    this.backFoot = new BackFoot();  // where your real back foot is (headset), src/game/crease.js
    this.creasePin = 0;              // 0..1: your figure's back foot held on it (a stumping being judged)
    this.reviews = new Reviews(CONFIG.match.reviews);   // 2 per side this innings
    this.lbw = new LbwFlow(game, this.reviews);
    this.third = new ThirdUmpireFlow(game);
    this.reviewFlow = null; this.pendingRes = null;
    this.noBall = false; this.freeHit = false; this.noBallWhy = '';
    this.bouncers = new BouncerCount();   // fast short-pitched balls this over (ICC 41.6)
    this.path = [];
    this.offer = new ShotEvidence();     // did you play at this ball (shotOffered.js)
    this.partnership = 0;
    this.dots = 0;
  }

  enter() {
    const g = this.game;
    g.setEnd('batting');
    g.machine.setVisible(this.bowler === 'machine');
    g.machine.setRelease(g.settings.machine.release);
    g.machine.setCue(0);
    g.aimMarker.visible = false;
    if (this.bowler === 'ai' && g.figures) this.bowlerFig = g.figures.bowler;
    if (this.bowlerFig) this.bowlerFig.show(true);
    g.setTeams(true);
    g.batterView.runnerOnly = true;
    g.batterView.show(false);
    g.nonStrikerView.show(!!this.innings);
    g.nonStrikerView.reset();
    g.umpires.place(false);
    g.umpires.show(!!this.field);
    if (this.field) this.field.enter();
    this.resetEnds();
    this.updateHud();
    if (this.innings) {
      g.say('toss', { choice: this.innings.target != null ? 'bowl' : 'bat' });
      g.say('innings', { chase: this.innings.target != null });
    }
    g.coach('bat', this.field ? [HINTS.stepOut, HINTS.sweep, HINTS.move] : [HINTS.stepOut, HINTS.sweep, HINTS.next], 7);
  }

  exit() {
    const g = this.game;
    g.machine.setCue(0);
    if (this.bowlerFig) this.bowlerFig.show(false);
    if (this.field) this.field.exit();
    g.nonStrikerView.show(false);
    g.umpires.show(false);
    g.ballOverride = null;
    g.timeScaleTarget = 1;
    g.setRigOffset(0, 0);
    g.playerBat.mods = null;
    g.drs.hide();
    g.ui.setHud({ players: '' });
    g.ui.showHud(true);
  }

  footer() {
    if (this.game.input.xr) return this.field ? 'X run · Y back · hold L-trigger dive · stick click: menu' : 'X: next ball · left stick click: menu · hold left grip: recenter';
    return this.field ? 'Space run · G back · V dive · Shift step out · S sweep · Esc menu' : 'Mouse: bat · Space: next ball · Shift step out · S sweep · Esc menu';
  }

  usesY() { return !!(this.field && this.state === 'live' && (this.hit || this.byes)); }

  // What may be in your view (src/ui/ui.js quiet): from the moment the
  // bowler sets off (or the machine counts down) until the ball has reached
  // you, nothing at all; while it is in play, only the calls of the moment
  // and the running controls; between balls, everything.
  // An appeal (your window to appeal included), an umpire's decision, a DRS
  // review or the third umpire is under way (lbwFlow.js, thirdUmpire.js): the
  // ball is dead but nothing may skip on to the next delivery yet.
  decisionPending() {
    return this.state === 'review' || !!(this.lbw && this.lbw.active) || !!(this.third && this.third.active) || !!(this.game.drs && this.game.drs.active);
  }

  quiet() {
    const st = this.state;
    if (st === 'cue' || st === 'runup') return 'clear';
    if (st !== 'live') return null;
    return this.hit || this.byes || this.stumpAt || this.crossedCrease || this.game.world.ball.padded ? 'live' : 'clear';
  }

  resetEnds() {
    const g = this.game;
    g.stumps.batting.reset(); g.stumps.bowling.reset();
    g.world.resetWickets();
  }

  // You standing upright at the popping crease: head and shoulder heights (the wide / bouncer calls).
  striker() { const g = this.game; return strikerHeights(g.input.xr && g.standEye ? g.standEye : null); }

  // Where the batter's legs are (for pads / the crease).
  body() {
    const g = this.game;
    if (g.input.xr) return g.input.headPose.p;
    return { x: STANCE.x + this.crease.x, z: STANCE.z + this.crease.z - this.advance };
  }

  // ------------------------------------------------------------- input (real time)
  handleInput(input) {
    const g = this.game, L = input.left, R = input.right, B = CONFIG.bat, dt = g.realDt || 0.016;
    const preBall = this.state === 'cue' || this.state === 'runup' || (this.state === 'live' && !this.hit && !this.byes && !g.world.ball.padded);
    // Move in the crease with the left stick.
    // Stick forward = the way your left controller points (you stand side-on).
    if (Math.abs(L.stick.x) > 0.15 || Math.abs(L.stick.y) > 0.15) {
      let fx = 0, fz = -1;
      if (input.xr && L.connected) {
        _fw.set(0, 0, -1).applyQuat(L.rayPose.q);
        if (Math.hypot(_fw.x, _fw.z) > 0.2) { const n = Math.hypot(_fw.x, _fw.z); fx = _fw.x / n; fz = _fw.z / n; }
      }
      const mx = fx * -L.stick.y + -fz * L.stick.x, mz = fz * -L.stick.y + fx * L.stick.x;
      this.crease.x = clamp(this.crease.x + mx * B.creaseMoveSpeed * dt, -B.creaseBox[0], B.creaseBox[0]);
      this.crease.z = clamp(this.crease.z + mz * B.creaseMoveSpeed * dt, -B.creaseBox[1], B.creaseBox[1]);
    }
    // Stride down the pitch while the trigger is held.
    const want = preBall && R.buttons.trigger.pressed ? B.advanceDistance : 0;
    if (want > 0 && this.advance === 0) g.say('charge');
    this.advance += clamp(want - this.advance, -B.advanceSpeed * dt, B.advanceSpeed * dt);
    g.setRigOffset(this.crease.x, this.crease.z - this.advance);
    const f = this.advance / B.advanceDistance;
    g.playerBat.mods = { faceLed: B.faceLed, power: 1 + B.advancePower * f, sigmaScale: 1 - B.advanceSweetShrink * f, loftPower: 0.2 * f };

    // Sweep: your figure goes down on the back knee whenever the grip is held - before the ball, through
    // the shot, after it - however you are standing yourself, and gets up when you let go. Down low
    // yourself, with the bat across the line low or swinging at the ball, is a sweep too (readLowSweep).
    this.lowSweep = this.readLowSweep(dt);
    const sweeping = R.buttons.squeeze.pressed || this.lowSweep;
    this.sweepK = clamp((this.sweepK || 0) + (sweeping ? SWEEP_IN : -SWEEP_OUT) * dt, 0, 1);
    this.sweepSlog = sweeping ? R.buttons.trigger.pressed || this.advance > 0.4 : this.sweepSlog;
    // a reverse sweep: the middle of the bat swung toward the off side of your stance while sweeping
    if (sweeping) { const s = this.sweepSide(); if (s.speed > 2.5) this.sweepReverse = s.off > 0.35; }
    else if (this.sweepK <= 0) this.sweepReverse = false;

    if (this.lbw.active) return;
    const run = this.field && this.state === 'live' && (this.hit || this.byes) && !this.field.result();
    if (run) {
      const r = g.runs;
      if (L.buttons.a.down || (input.xr && !L.connected && R.buttons.a.down)) { if (this.field.callRun()) g.ui.prompt('RUN!', 1.0, '#7dff8a'); }
      // Y turns back; hold the off-hand trigger to dive: your batter throws himself at the line as soon as it is in range.
      const rb = runControls(input, g.replay ? g.replay.skipHand() : L);
      if (rb.back.down && this.field.turnBack()) g.ui.prompt('BACK!', 1.0, '#ff9f43');
      r.diveHeld = rb.dive.pressed;
      r.diveEnd = this.field.throwEnd();
      if (r.diveStarted) { r.diveStarted = false; g.ui.prompt('DIVE!', 0.8, '#ffd34d'); rb.diveHand.pulse(0.6, 60); g.sample('footstep', { gain: 0.9 }); }
      // The running controls stay up for as long as you can run.
      if (!r.running && !r.closed) g.hint(r.completed > 0 ? [HINTS.another] : [HINTS.run], 0.5);
      else if (r.running) g.hint([HINTS.back, HINTS.dive], 0.5);
    } else if (L.buttons.a.down || (input.xr && !L.connected && R.buttons.a.down)) this.requestNext();
  }

  // X / Space between balls: the next ball now. During the result ('settle')
  // it only cuts the wait short: the ball's replay still plays first, with
  // the whole of the play on its tape (it starts once TAIL s of aftermath are
  // recorded), and the end of the innings is still checked on the way out of
  // 'settle' (so a finished innings never gets another ball).
  requestNext() {
    if (this.state === 'idle') { this.timer = 0; return; }
    if (this.state !== 'settle') return;
    this.nextAsked = true;
    const R = this.game.replay, p = R && R.pending;
    this.timer = Math.min(this.timer, p ? Math.max(0, (R.dueAt ? R.dueAt() : p.at) - this.game.simTime) : 0);
  }

  // The replay has put you back: straight on, if the next ball was asked for.
  afterReplay() { if (this.state === 'settle' && this.nextAsked) this.timer = 0; }

  autoNext() { return this.kind !== 'nets' || this.game.settings.autoFeed; }

  // ------------------------------------------------------------- per frame (game time)
  update(dt, t) {
    const g = this.game;
    if (this.done) return;
    // Your real back foot follows your head every frame (it is planted unless your head moves it).
    this.ground();
    this.creasePin = clamp(this.creasePin + (this.stumpAt && (this.state === 'live' || this.state === 'review') ? 6 : -3) * (g.realDt || dt), 0, 1);
    g.timeScaleTarget = this.state === 'live' && !this.hit && !this.byes && !g.world.ball.padded && g.world.ball.active && g.world.ball.pos.z < 0.5 ? g.diff.timeScale : 1;   // (the slow-down is for the ball coming at you: past you, it is over)
    if (this.state === 'idle') {
      if (this.innings && this.innings.complete) { this.complete(); return; }   // (never a ball after the last one)
      if (this.autoNext() || this.timer <= 0) this.timer -= dt;
      // The next ball is decided now, so that everyone can walk to where it
      // needs him (the bowler to his mark, the umpire and the non-striker to
      // the right side of the stumps) before the bowler runs in.
      if (!this.planned) this.planNext();
      this.waitField = (this.waitField || 0) + dt;
      if (this.timer <= 0 && g.replay && g.replay.pending) { /* (the last ball's replay first: Replay.dueAt) */ }
      else if (this.timer <= 0 && !this.announced && this.announce()) { /* (the card is up: the field walks back meanwhile) */ }
      else if (this.timer <= 0 && this.peopleReady()) { this.waitField = 0; this.prepare(t); }
    } else if (this.state === 'cue') {
      const el = t - this.cueStart, cd = CONFIG.machine.countdownSec;
      const stage = el < cd / 2 ? 1 : el < cd ? 2 : 3;
      if (stage !== this.cueStage) { this.cueStage = stage; g.machine.setCue(stage); g.sfx.beep(stage); }
      if (el >= cd) this.release(t);
    } else if (this.state === 'runup') {
      if (this.bowlerFig.update(dt, t)) this.release(t);
      else if (this.bowlerFig.holdingBall()) { g.ballOverride = { pos: this.bowlerFig.handPos(_hand) }; g.ballView.setVisible(true); }
    } else if (this.state === 'live') {
      try { this.checkLive(t); } catch (e) { this.deadOnError(e); }
    } else if (this.state === 'review') {
      try {
        const flow = this.reviewFlow || this.lbw;
        flow.update(g.realDt || dt);
        if (flow.done) {
          const res = flow === this.lbw ? this.lbw.result({ kind: 'beaten', padded: true }) : this.pendingRes;
          this.reviewFlow = null;
          this.finish(res);
        }
      } catch (e) { this.deadOnError(e); }
    } else if (this.state === 'settle') {
      this.timer -= dt;
      if (this.timer <= 0) {
        g.machine.setCue(0);
        if (this.innings && this.innings.complete) { this.complete(); return; }
        this.timer = this.nextAsked ? 0 : this.autoNext() ? 0.3 : 1e9;
        this.state = 'idle'; this.nextAsked = false;
      }
    }
    if (this.field) this.field.update(dt, t);
    if (this.bowlerFig && this.state !== 'runup') this.bowlerFig.update(dt, t);
    g.umpires.setLook(g.ballView.visible ? g.ballView.mesh.position : null);
  }

  // Between balls: who bowls next and a free hit are told BEFORE the bowler
  // sets off (the card is up for ANNOUNCE s while the field walks back, then
  // the run-up starts with a clear view), never over the run-up. True if
  // there was something to tell.
  announce(hold = ANNOUNCE) {
    const g = this.game;
    if (!this.planned) this.planNext();
    const next = this.planned.settings;
    this.announced = true;
    const freeHit = !!(this.innings && this.innings.freeHit), lines = [];
    if (next.newBowler) {
      lines.push(`${next.bowler} — ${next.bowlerLabel}`);
      g.say('over', { style: next.spinner ? 'SPIN' : next.bowlerType === 'swing' ? 'SWING' : 'FAST', balls: this.innings ? this.innings.ballsLeft : 6 });
    }
    if (freeHit) { lines.push('FREE HIT — you can only be run out'); g.umpires.signal('freehit', g.clock); }
    if (this.aiBowler) g.ui.setHud({ sub: this.aiBowler.describe(next) });
    if (!lines.length) return false;
    g.ui.prompt(lines.join('\n'), hold + 0.4, '#ffd34d');
    this.timer = hold;
    return true;
  }

  // The ball is dead and you skip the rest of it (quickSkip.js, while the
  // view is dark): the result's wait, the replay and the walk back are over at
  // once. The next ball is decided, everyone is stood where it needs him (the
  // bowler on his mark), the stumps go back up and the ball goes; the
  // delivery starts `hold` s from now (the bowler's run-up, the machine's
  // countdown), after a new bowler's or a free hit's card (SKIP_ANNOUNCE s).
  // The score, the strike and the new batter are the result's own (finish()).
  // Never past the end of the innings: that goes to its end.
  // Returns 'next', 'done' (the innings is over) or null (nothing to skip).
  skipToNext(hold = 0) {
    const g = this.game;
    if (this.done) return null;
    if (this.state === 'settle') { g.machine.setCue(0); this.state = 'idle'; this.nextAsked = false; }
    if (this.state !== 'idle') return null;
    if (this.innings && this.innings.complete) { this.complete(); return 'done'; }
    g.timeScaleTarget = 1;
    if (!this.planned) this.planNext();
    if (this.field) this.field.settleNow();
    if (this.bowlerFig && this.bowlerFig.placeAtMark) this.bowlerFig.placeAtMark();
    this.resetEnds();
    g.world.removeBall();
    g.ballOverride = null;
    g.ballView.setVisible(false);
    g.ballView.clearTrail();
    this.waitField = 0;
    this.timer = this.autoNext() ? hold : 0;
    if (!this.announced) this.announce(SKIP_ANNOUNCE);
    return 'next';
  }

  // Decide the next delivery and tell everyone where it needs them (they walk there).
  planNext() {
    const g = this.game;
    const settings = this.aiBowler ? this.aiBowler.next(this.innings) : g.settings.machine;
    const rel = this.bowler === 'ai'
      ? new Vec3((settings.release === 'around' ? -1 : 1) * CONFIG.machine.releaseX, settings.spinner ? CONFIG.bowlerAI.releaseHeight : CONFIG.bowlerAI.releaseHeightPace, CONFIG.machine.releaseZ)
      : null;
    const delivery = machineDelivery(settings, g.rng, CONFIG, rel);
    this.planned = { settings, delivery };
    // The umpire and the non-striker stay out of the bowler's way.
    if (this.bowler === 'ai') {
      const side = settings.release === 'around' ? -1 : 1;
      if (this.lastSide != null && side !== this.lastSide && !settings.newBowler) g.say('wicket_side', { around: side < 0 });
      this.lastSide = side;
      g.umpires.place(false, side);
      if (this.innings) g.nonStrikerView.setSide(side);
      if (this.bowlerFig && this.bowlerFig.setMark) this.bowlerFig.setMark(delivery.releasePos, settings.runup);
      if (this.field) this.field.setSpinner(!!settings.spinner);      // (the keeper up to the stumps, or back)
    }
  }

  // Is everyone in place for the bowler to run in? Fielders on their marks,
  // batters at their ends, umpires in position, the bowler on his mark facing
  // you. The wait is capped: after WAIT_HURRY s whoever is not there runs, and
  // after the cap the ball is bowled anyway (the bowler himself always walks
  // to his mark first).
  peopleReady() {
    const g = this.game, w = this.waitField || 0;
    const cap = g.crew && g.crew.busy && g.crew.busy() ? WAIT_CAP_WICKET : WAIT_CAP;
    const fig = this.bowlerFig;
    if (fig && fig.atMark && !fig.atMark()) { if (w > WAIT_HURRY) fig.hurry(); if (w < cap + 8) return false; }
    if (!this.field || this.field.settled()) return true;
    if (w > WAIT_HURRY) this.field.hurry(cap - w);
    return w > cap;
  }

  prepare(t) {
    const g = this.game;
    this.resetEnds();
    g.ballView.setVisible(false);
    g.ballView.clearTrail();
    g.world.removeBall();
    // A new ball: the last one's result, delivery and shot lines go (an appeal
    // or a review of this one writes its own; the result writes the verdict).
    g.ui.setHud({ big: '', last: '', detail: this.newBatter ? `New batter in: ${this.newBatter}` : '' });
    this.newBatter = null;
    if (!this.planned) this.planNext();
    const settings = this.planned.settings;
    this.delivery = this.planned.delivery;
    this.planned = null;
    this.announced = false;
    this.settingsUsed = settings;
    this.hit = null; this.byes = null; this.firstBounce = null; this.wide = false; this.crossedCrease = false; this.shortChecked = false; this.bouncerNote = '';
    this.offer.reset(); this.stumpAt = 0; this.stumpBroke = false; this.path.length = 0; this.shotName = '';
    this.pendingRes = null; this.reviewFlow = null;
    this.backFoot.reset();           // taking guard
    // Extras: the AI bowler oversteps now and then; the ball after a no-ball is a free hit.
    this.freeHit = !!(this.innings && this.innings.freeHit);
    this.noBall = !!(this.innings && this.bowler === 'ai' && g.rng() < (CONFIG.match.noBallChance[g.settings.difficulty] ?? 0.03));
    this.noBallWhy = '';
    if (this.innings && this.innings.card && settings.bowler) this.innings.card.setBowler(settings.bowler, settings.bowlerLabel);
    if (this.field) { this.field.reset(); this.field.setSpinner(!!settings.spinner); this.field.beginDelivery(); }
    if (this.bowlerFig) this.bowlerFig.show(true);
    if (this.bowler === 'machine') {
      g.machine.setRelease(settings.release || 'over');
      this.state = 'cue';
      this.cueStart = t;
      this.cueStage = 0;
    } else {
      this.state = 'runup';
      this.bowlerFig.startRunup(t, this.delivery.releasePos, settings.runup);
      if (!settings.newBowler) g.say('runup');
    }
    // The delivery has started: nothing in the view until the ball has reached you
    // (no bowler card, no last-ball panel, no control line, no instruction cards): see quiet().
  }

  release(t) {
    const g = this.game, d = this.delivery, s = this.settingsUsed;
    g.world.launch({ pos: d.releasePos, vel: d.vel, spin: d.spin, swing: d.swing, seamDeg: d.seamDeg });
    g.ballOverride = null;
    if (this.field) this.field.released();
    g.ballView.setVisible(true);
    g.ballView.mesh.quaternion.identity();
    this.launchT = t;
    this.state = 'live';
    // When and where the ball will reach you (for the figure that plays your shot).
    {
      const pred = predict(g.world.ball, { maxTime: 3, h: 1 / 240, stop: (bb) => bb.pos.z > 0.5 });
      const c = crossingAtZ(pred, -1.5), b0 = pred.bounces[0], k = crossingAtZ(pred, battingPoppingZ);
      this.ballInfo = { id: (this.ballInfo ? this.ballInfo.id : 0) + 1, arrive: c ? t + c.t : null, y: c ? c.y : null, length: b0 ? -b0.pos.z : -1 };
      this.atCrease = k ? { y: k.y, bounced: !!b0 && b0.pos.z < battingPoppingZ } : null;   // (the height it would have passed you at)
    }
    this.guardX = this.body().x;     // where you took guard: moving across neither makes nor saves a wide
    g.sample('whoosh', { gain: 0.5 }) || g.sfx.whoosh(d.vel.length() * 0.4);
    // (A no-ball is called and signalled; its words wait for the result: nothing is written over the ball in flight.)
    if (this.noBall) { g.umpires.signal('noball', g.clock); g.sample('umpire_not_out', { gain: 0.6 }); }
    const len = d.length;
    g.say('release', { type: s.name && /googly|doosra|arm ball|slower|outswing|inswing/.test(s.name) ? s.name.replace('outswinger', 'outswing').replace('inswinger', 'inswing').replace(' ', '_') : s.spinType === 'off' ? 'off_spin' : s.spinType === 'leg' ? 'leg_spin' : s.bowlerType === 'swing' ? 'swing' : 'fast',
      length: len < 2 ? 'yorker' : len > 10.5 ? 'bouncer' : undefined, pace: d.paceKmh });
  }

  checkLive(t) {
    const g = this.game, b = g.world.ball;
    if (b.active && !b.batted) this.path.push({ x: b.pos.x, y: b.pos.y, z: b.pos.z });
    // Did you play at it? The middle of your bat while the ball comes to you (shotOffered.js):
    // played and missed vs left alone, and the LBW "shot offered".
    if (!b.batted && b.pos.z > -7 && b.pos.z < 0.5) this.trackOffer();
    if (!this.crossedCrease && b.pos.z > battingPoppingZ) {
      this.crossedCrease = true;
      if (!b.batted && !b.padded && isWide(b.pos.x, b.pos.y, { shiftX: this.body().x - (this.guardX ?? this.body().x), head: this.striker().head })) this.wide = true;   // too wide, or over your head
    }
    // Past you (or hit): a bouncer over your shoulder? One an over; the next is a no-ball.
    if (!this.shortChecked && (this.crossedCrease || b.batted || b.padded)) {
      this.shortChecked = true;
      const live = this.crossedCrease && !b.batted && !b.padded, at = live ? { y: b.pos.y, bounced: b.bounces > 0 } : this.atCrease;
      if (this.innings && this.bowler === 'ai' && at && isShortPitched({ ...at, shoulder: this.striker().shoulder, spinner: !!this.settingsUsed.spinner })) {
        const r = this.bouncers.add(Math.floor(this.innings.legal / 6));
        if (r.noBall && !this.noBall) { this.noBall = true; this.noBallWhy = 'second bouncer in the over'; g.umpires.signal('noball', g.clock); g.sample('umpire_not_out', { gain: 0.6 }); }
        else if (!r.noBall) this.bouncerNote = bouncerCall(r);
      }
    }
    // Into your legs: not a wide (Law 22.3). (With no LBW the ball goes through them.)
    if (this.wide && !(this.field && g.diff.lbwAgainstPlayer) && !this.hit) { const body = this.body(); if (padHit(b.clone(), body.x, body.z, PLAYER_PAD)) this.wide = false; }
    // Struck on the pad: LBW appeal (match modes, not on easy).
    if (this.field && g.diff.lbwAgainstPlayer && !this.hit && !b.thrown) {      // (not a throw going past you)
      // Your head stands in for your legs, so the box is kept tight and sits
      // behind it (nothing ahead of your eyes, where you play the ball), and
      // the bat always gets the first go at the ball.
      const body = this.body();
      const was = this.path.length > 1 ? this.path[this.path.length - 2] : null, at = b.pos.clone();
      const padded = padHit(b, body.x, body.z, PLAYER_PAD, was);
      if (padded && g.batDistance(b.pos) <= 0.3) b.pos.copy(at);     // (the bat is there: it gets its go, from where the ball really is)
      else if (padded) {
        const impact = b.clone();
        deflectOffPad(b, g.rng);
        this.wide = false;                                   // it hit you: not a wide (Law 22.3)
        if (this.noBall || this.freeHit) { this.finish({ kind: 'beaten', padded: true }); return; }
        this.state = 'review';
        this.lbw.start({ impactState: impact, path: this.path.slice(), shotOffered: this.offer.offered, playerIsBatter: true });
        return;
      }
    }
    // An edge onto the pad (lbwFlow.js batPad): an LBW shout (the review finds the bat first), or still in play.
    if (this.field && g.diff.lbwAgainstPlayer && this.hit && this.hit.edge && !this.noBall && !this.freeHit && !b.padded) {
      const bp = this.lbw.batPad(b, this.body(), PLAYER_PAD, { path: this.path.slice(), shotOffered: this.offer.offered, playerIsBatter: true, since: t - this.hit.t, field: this.field, t });
      if (bp === 'appeal') { this.state = 'review'; this.reviewFlow = null; return; }
    }
    if (this.field && (b.batted || this.byes)) {
      const res = this.field.result();
      // A catch off an edge: the umpire's decision, and maybe a review (lbwFlow.js caught).
      if (res && res.kind === 'caught' && !this.noBall && !this.freeHit && this.lbw.caught(res, { notOut: { kind: 'runs', runs: 0 }, path: this.path.slice(), playerIsBatter: true })) { this.state = 'review'; this.reviewFlow = null; return; }
      if (res) { if (!this.upstairs(res)) this.finish(res); return; }
      if (t - this.launchT > 20) this.finish({ kind: 'runs', runs: g.runs.completed });
      return;
    }
    // Not hit. What happens next is whatever the ball and the keeper really do.
    if (!b.batted && this.field) {
      if (this.field.keeperHold) {
        // He has it. Only now can you be stumped (or thrown out from where he stands back).
        if (!this.stumpAt) {
          if (this.shortOfGround() <= 0.02) {
            const notOut = { kind: this.offer.offered ? 'beaten' : 'left' };
            // Close to the bat (or a noise as it passed): an appeal for caught behind (lbwFlow.js behind).
            if (!this.noBall && !this.freeHit && this.lbw.behind({ notOut, path: this.path.slice(), playerIsBatter: true })) { this.state = 'review'; this.reviewFlow = null; return; }
            this.finish(notOut); return;
          }
          this.stumpAt = this.field.keeperAttack(t);
          g.ui.prompt('GET BACK!', 1, '#ff5a5a');
          return;
        }
        if (t < this.stumpAt) return;
        // (whatever happened to his attack, the ball is dead a moment later: nothing waits on it for ever)
        if (t > this.stumpAt + ATTACK_DEAD && !this.byes) { this.finish({ kind: 'beaten', shyMissed: true }); return; }
        const atk = this.field.attack, margin = this.shortOfGround(), lim = CONFIG.match.thirdUmpire;   // m short of your ground
        // (his shy misses: the ball runs on past the stumps -- byes, if you can run them)
        if (atk.kind === 'shy' && !atk.hit) { if (b.active) this.startByes(t, true); return; }
        if (atk.kind === 'break' && !this.stumpBroke) { this.stumpBroke = true; this.field.breakStumps('batting', t, 0); }
        const res = margin <= 0 ? { kind: 'beaten', backInTime: true }
          : atk.kind === 'break' ? { kind: 'stumped' } : { kind: 'runout', runs: 0, margin, end: 'batting', who: 'striker' };
        if (Math.abs(margin) < lim) {                                  // close ones go upstairs
          this.pendingRes = res; this.reviewFlow = this.third; this.state = 'review';
          this.third.start({ kind: atk.kind === 'break' ? 'stumping' : 'run_out', end: 'batting', margin, out: margin > 0, by: this.groundBy });
        } else this.finish(res);
        return;
      }
      // It beat the keeper as well: byes. Run if you like; it can go for four.
      if (this.field.keeperMissed && b.active) { this.startByes(t); return; }
    } else if (!b.batted && b.pos.z > 2.4) {                           // nets: past the stumps
      this.finish({ kind: this.offer.offered ? 'beaten' : 'left' });
      return;
    }
    if (b.batted && !this.field) {
      const far = groundDistance(b.pos.x, b.pos.z) > 95;
      if (b.stopped || far || t - this.hit.t > 6 || (b.crossedBoundary && t - this.hit.t > 1.2)) {
        this.finish(this.netsHitResult(b));
        return;
      }
    }
    if (t - this.launchT > (b.batted ? 12 : UNHIT_DEAD)) this.finish({ kind: b.batted ? 'hit' : this.offer.offered ? 'beaten' : 'left' });
  }

  // The ball has gone past the bat and the keeper: it is in play, like a hit.
  startByes(t, shy = false) {
    const g = this.game, b = g.world.ball;
    this.byes = { t };
    g.timeScaleTarget = 1;
    this.field.onHit(b, t, predict(b, { maxTime: 9, h: 1 / 240 }), { byes: true });
    g.ui.prompt(shy ? 'He misses the stumps — run!' : this.wide && !this.noBall ? 'WIDE — and past the keeper! Run?' : 'Past the keeper — BYES! Run?', 2.2, '#ffd34d');
    g.crowdReact('close');
  }

  // A sweep is on: the grip held, or you are down low in a sweep (readLowSweep).
  sweepHeld() { return this.game.input.right.buttons.squeeze.pressed || !!this.lowSweep; }

  // The button's own hold on the view (Game.updateRigDrop: it lowers your eyes to a kneeling
  // sweeper's): 1 while the grip is held and nothing else has the view, else 0.
  sweepDrop() {
    const g = this.game, r = g.runs;
    if (this.isBowling || !g.input.right.buttons.squeeze.pressed) return 0;
    if (r && (r.running || r.diving)) return 0;
    return this.state === 'review' ? 0 : 1;
  }

  // Down low yourself (headset): your real eyes below LOW.on x your standing
  // eye height, held LOW.hold s, with the middle of the bat low (below LOW.bat
  // x standing) and either lying across the line or swinging round at the
  // ball (its HORIZONTAL speed over LOW.swing m/s) - that is a sweep, as if the
  // grip were held. Over when you come back up past LOW.off, or the middle of
  // the bat stays up above LOW.high x standing for LOW.highFor s. Never to a
  // short ball (its height at you over LOW.short x standing: that is a duck).
  // Not a sweep either: a batting crouch or a lunge (the head nowhere near that
  // low), a duck (the bat up or out of the way, or the hands dropping - that is
  // speed downward, not round), crouching to ground the bat (upright, still).
  readLowSweep(dt) {
    const g = this.game, S = this.lowS || (this.lowS = { on: false, t: 0, hi: 0 });
    if (!g.input.xr || !g.input.right.connected || !g.standEye) { S.on = false; S.t = 0; S.hi = 0; return false; }
    const stand = g.standEye, y = g.input.headRef.p.y, pose = g.playerBatProvider.curr.pose;
    if (_sweetY == null) _sweetY = new BatGeometry(CONFIG.bat).sweetY;
    pose.dirToWorld(_lever.set(0, 1, 0), _lever);
    const across = Math.abs(_lever.y) < 0.6;
    const midY = pose.p.y + _lever.y * _sweetY - (g.rig ? g.rig.position.y : 0);     // (its real height: the view drop moves the bat too)
    pose.dirToWorld(_lever.set(0, _sweetY, 0), _lever);
    pointVelocity(_bv, g.input.right.linVel, g.input.right.angVel, _lever);
    const round = Math.hypot(_bv.x, _bv.z);
    if (S.on) {
      S.hi = midY > stand * LOW.high ? S.hi + dt : 0;
      if (y > stand * LOW.off || S.hi >= LOW.highFor) { S.on = false; S.t = 0; S.hi = 0; }
      return S.on;
    }
    const bi = this.ballInfo, short = this.state === 'live' && !this.hit && bi && bi.y != null && bi.y > stand * LOW.short;
    const sweepy = !short && y < stand * LOW.on && midY < stand * LOW.bat && (across || round > LOW.swing);
    S.t = sweepy ? S.t + dt : 0;
    if (S.t >= LOW.hold) { S.on = true; S.hi = 0; }
    return S.on;
  }

  // Which way the middle of your bat is going across your stance (the stick turns it): its speed, and
  // the share of that toward the off side (+1) or the leg side (-1).
  sweepSide() {
    const g = this.game, R = g.input.right, pose = g.playerBatProvider.curr.pose;
    if (_sweetY == null) _sweetY = new BatGeometry(CONFIG.bat).sweetY;
    pose.dirToWorld(_lever.set(0, _sweetY, 0), _lever);
    pointVelocity(_bv, R.linVel, R.angVel, _lever);
    const th = g.input.xr ? g.lookYaw || 0 : 0, sp = _bv.length();
    return { speed: sp, off: sp > 1e-6 ? (_bv.x * Math.cos(th) - _bv.z * Math.sin(th)) / sp : 0 };
  }

  // The middle of your bat this frame (real velocity: the controller's plus its turning x the lever
  // down the blade) into the evidence of a shot played at the ball.
  trackOffer() {
    const g = this.game, R = g.input.right, pose = g.playerBatProvider.curr.pose;
    if (!R.connected) return;
    if (_sweetY == null) _sweetY = new BatGeometry(CONFIG.bat).sweetY;
    pose.dirToWorld(_lever.set(0, _sweetY, 0), _lever);
    _mid.copy(pose.p).add(_lever);
    pointVelocity(_bv, R.linVel, R.angVel, _lever);
    const head = g.input.xr ? g.input.headPose.p : this.body();
    this.offer.add(_bv, _mid, head, g.realDt || 1 / 72);
  }

  netsHitResult(b) {
    const h = this.hit;
    if (b.crossedBoundary) return { kind: 'boundary', runs: h.sixOnFull ? 6 : 4 };
    return { kind: 'hit', runs: 0 };
  }

  // Sweep / reverse sweep / slog sweep (the grip held at contact): the shot
  // your bat played - its power from the contact, its side from where it went
  // or the way you swept - helped gently into a sweeper's arc (sweepShot.js).
  applySweep(e) {
    const g = this.game, b = g.world.ball, R = g.input.right;
    const name = sweepShot(b.vel, e, { slog: R.buttons.trigger.pressed || this.advance > 0.4, reverse: this.sweepSide().off > 0.35 });
    if (!name) return false;
    e.vel.copy(b.vel); e.speedOut = b.vel.length();
    this.shotName = name;
    return true;
  }

  onEvent(e) {
    const g = this.game;
    if (this.state !== 'live' && this.state !== 'settle') return;
    if (e.type === 'bounce' && !e.batted && !this.firstBounce) this.firstBounce = e.pos.clone();
    if (e.type === 'bat' && e.batId === 'player' && !this.hit) {
      const b = g.world.ball;
      if (this.sweepHeld()) this.applySweep(e);
      const pred = predict(b, { maxTime: 9, h: 1 / 240 });
      const land = pred.bounces[0];
      const carry = land ? Math.hypot(land.pos.x - b.pos.x, land.pos.z - b.pos.z) : 0;
      const v = b.vel;
      const launch = launchAngle(v);
      this.hit = {
        t: e.t, quality: e.quality, edge: e.isEdge, exit: v.length(), batSpeed: e.bladeSpeed ?? e.batSpeed, load: e.load, launch, carry, dir: { x: v.x, y: v.y, z: v.z },
        sixOnFull: !!(pred.boundary && pred.boundary.onFull), pred, advanced: this.advance > 0.5,
      };
      if (e.isEdge) this.stats.edges++; else if (e.quality > 0.75) this.stats.middled++;
      const qual = e.isEdge ? 'EDGE' : e.quality > 0.85 ? 'MIDDLED' : e.quality > 0.5 ? 'good contact' : 'mistimed';
      g.ui.setHud({ big: this.shotName ? `${qual} · ${this.shotName}` : qual, bigColor: e.isEdge ? '#ff9f43' : e.quality > 0.85 ? '#7dff8a' : '#ffffff', detail: this.shotDetail() });
      g.say('hit', { shot: this.shotName.includes('sweep') ? 'sweep' : launch > 20 ? 'loft' : 'drive', edge: e.isEdge, top_edge: e.isEdge && launch > 35, speed: v.length(), vel: { x: v.x, y: v.y, z: v.z } });
      if (this.field) this.field.onHit(b, e.t, pred);
      if (!e.isEdge && e.quality > 0.8 && v.length() > 30) g.cheer(0.3);
      if (e.isEdge) g.crowdReact('edge');
      else if (launch > 22 && v.length() > 22) g.crowdReact('skied');
    } else if (e.type === 'bat' && e.batId === 'player' && this.hit && e.t - this.hit.t < 1) {
      // Struck again (the bat came round into it): the read-out is of the ball
      // as it finally left the bat, not of the first touch.
      const b = g.world.ball, v = b.vel, land = predict(b, { maxTime: 9, h: 1 / 240 }).bounces[0];
      Object.assign(this.hit, { exit: v.length(), launch: launchAngle(v), dir: { x: v.x, y: v.y, z: v.z }, carry: land ? Math.hypot(land.pos.x - b.pos.x, land.pos.z - b.pos.z) : 0, again: true });
    }
    // (a fielder's throw into the stumps is a run-out chance, never "bowled")
    if (e.type === 'wicket' && e.thrown) { if (this.field && this.state === 'live') this.field.onThrownWicket(e); }
    else if (e.type === 'wicket' && e.end === 'batting' && this.state === 'live') {
      if (!this.field || (!this.field.fielded && !this.hit)) this.finish({ kind: 'bowled', wicket: 'bowled' });
      else if (this.hit && !this.field.fielded && e.t - this.hit.t < 0.6) this.finish({ kind: 'bowled', wicket: 'bowled' });   // played on
    }
    if (e.type === 'boundary' && (e.batted || this.byes)) {
      g.cheer(e.onFull && e.batted ? 1 : 0.7);
      if (this.hit) this.hit.sixOnFull = e.onFull;
      if (this.field) this.field.onBoundary(e);
    }
  }

  shotDetail() {
    const h = this.hit;
    if (!h) return '';
    return shotReadout(h);
  }

  // Non-striker backs up while the ball is being bowled.
  backingUp() { return this.state === 'runup' || this.state === 'cue' || (this.state === 'live' && !this.game.world.ball.batted); }

  // What your body is doing, for the figure that stands in for you.
  // sweep: held (k 0..1), slog, reverse; ball: this delivery (id, live, arrival time and
  // height at the batter, length); hit: the contact once it happens (time, launch angle, shot).
  bodyState() {
    const b = this.game.world.ball, bi = this.ballInfo;
    return {
      sweep: this.sweepK > 0.01 ? { k: this.sweepK * this.sweepK * (3 - 2 * this.sweepK), slog: !!this.sweepSlog, reverse: !!this.sweepReverse, low: !!this.lowSweep } : null,
      ball: bi ? { id: bi.id, live: this.state === 'live' && b.active && !b.batted && !this.hit, arrive: bi.arrive, y: bi.y, length: bi.length } : null,
      hit: this.hit ? { t: this.hit.t, launch: this.hit.launch, name: this.shotName, dir: this.hit.dir } : null,
      // your real back foot (world z, headset only) and how far the figure's is held on it
      crease: this.footZ != null ? { z: this.footZ, pin: this.creasePin } : null,
    };
  }

  // How far (m) you are short of the popping crease (<= 0: in your ground),
  // judged on where you really are (src/game/crease.js): in the headset your
  // real back foot (planted where you took guard; your head moves it when you
  // step or charge) or the real bat grounded behind the line, whichever is
  // better; never the figure's animated feet, which play a captured shot's
  // stride. On a monitor, where your legs are (body()).
  ground() {
    const g = this.game, xr = !!g.input.xr;
    const bat = xr && g.input.right.connected ? g.batToe(_toe) : null;   // (the desktop bat doesn't come down the pitch with you)
    const r = creaseShort({ xr, headZ: xr ? g.input.headPose.p.z : 0, rigZ: g.rigOffset ? g.rigOffset.z : 0, foot: this.backFoot, legsZ: this.body().z, bat });
    this.footZ = r.footZ; this.groundBy = r.by;
    return r;
  }

  shortOfGround() { return this.ground().margin; }

  // Close run-outs go to the third umpire. Returns true if the result waits for the verdict.
  upstairs(res) {
    const g = this.game, lim = CONFIG.match.thirdUmpire;
    let margin = null;
    if (res.kind === 'runout' && res.margin < lim) margin = res.margin;
    else if (res.kind === 'runs' && res.closeCall != null && res.closeCall < lim * 0.8) {
      margin = -res.closeCall;
      const end = res.end || 'batting';
      if (this.field) this.field.breakStumps(end, g.simTime, 0.05);
    }
    if (margin == null) return false;
    this.pendingRes = res; this.reviewFlow = this.third; this.state = 'review';
    g.timeScaleTarget = 1;
    this.third.start({ kind: 'run_out', end: res.end || 'batting', margin, out: res.kind === 'runout' });
    return true;
  }

  // ------------------------------------------------------------- results
  // Judging the ball threw (a bug): it must never freeze play (the frame
  // would stop here every time, the keeper holding the ball for ever). The
  // ball is dead: whatever runs were completed, else nothing.
  deadOnError(e) {
    const g = this.game, b = g.world.ball;
    console.error(e);
    this.reviewFlow = null;
    if (this.lbw && this.lbw.active) { this.lbw.active = false; this.lbw.done = true; try { g.drs.hide(); g.ui.showHud(true); } catch { /* (as it is) */ } }
    try { this.finish(b.batted || this.byes ? (this.field ? { kind: 'runs', runs: g.runs.completed } : { kind: 'hit', runs: 0 }) : { kind: this.offer.offered ? 'beaten' : 'left' }); } catch (e2) { console.error(e2); this.state = 'settle'; this.timer = 3; g.timeScaleTarget = 1; }
  }

  finish(res) {
    const g = this.game;
    if (this.state === 'settle') return;
    if (this.field) this.field.endDelivery();
    this.state = 'settle';
    this.timer = this.kind === 'nets' ? CONFIG.machine.autoFeedDelay : 3.0;
    g.timeScaleTarget = 1;
    const d = this.delivery, s = this.settingsUsed;
    this.stats.balls++;
    const len = this.firstBounce ? -this.firstBounce.z : -1;
    const ballText = `${Math.round(d.paceKmh)} km/h${s.name ? ' · ' + s.name : ''} · ${lengthName(len)}${len > 0 ? ` (${len.toFixed(1)} m)` : ''} · ${lineName(d.line)}`;

    let big = '', color = '#ffffff';
    const outcome = { runs: 0, wide: false, wicket: null, boundary: 0 };
    const now = g.clock;
    switch (res.kind) {
      case 'bowled': big = 'BOWLED!'; color = '#ff5a5a'; outcome.wicket = 'bowled'; this.stats.bowled++; break;
      case 'caught': big = `CAUGHT${res.by ? ' — ' + res.by : ''}!`; color = '#ff5a5a'; outcome.wicket = 'caught'; break;
      case 'lbw': big = 'OUT — LBW'; color = '#ff5a5a'; outcome.wicket = 'lbw'; break;
      case 'stumped': big = 'STUMPED!'; color = '#ff5a5a'; outcome.wicket = 'stumped'; break;
      case 'runout': big = `RUN OUT! (${res.margin.toFixed(1)} m short)`; color = '#ff5a5a'; outcome.wicket = 'run out'; outcome.runs = res.runs; break;
      case 'boundary':
        if (res.overthrows) {           // overthrows to the rope: runs to you, not a four (Law 19.8)
          big = runsText(res) + '!'; color = '#4dd2ff'; outcome.runs = res.runs; outcome.overthrows = res.overthrows; g.umpires.signal('four', now);
          break;
        }
        big = res.runs === 6 ? 'SIX!' : 'FOUR!'; color = res.runs === 6 ? '#ff6bd6' : '#4dd2ff';
        outcome.runs = res.runs; outcome.boundary = res.runs;
        if (res.runs === 6) this.stats.sixes++; else this.stats.fours++;
        break;
      case 'runs':
        big = res.runs === 0 ? 'Dot ball' : runsText(res);
        if (res.overthrows) outcome.overthrows = res.overthrows;
        if (res.closeCall != null && res.closeCall < 0.9 && res.runs > 0) big += ' — just home!';
        outcome.runs = res.runs;
        break;
      case 'beaten': big = res.padded ? 'Not out' : res.backInTime ? 'NOT OUT — back in time!' : res.shyMissed ? 'Keeper misses the stumps!' : 'Beaten!'; color = '#ffb347'; break;
      case 'left': big = 'Left alone'; break;
      default: big = this.hit ? `Carried ${Math.round(this.hit.carry)} m` : 'Dot ball';
    }
    outcome.who = res.who; outcome.fielder = res.by;
    // A no-ball or a free hit: only a run-out counts.
    if (outcome.wicket && !Innings.canDismiss(outcome.wicket, { noBall: this.noBall, freeHit: this.freeHit })) {
      big = `NOT OUT — ${this.noBall ? 'no-ball' : 'free hit'}!`; color = '#7dff8a'; outcome.wicket = null;
    }
    // Everyone starts for where the next ball needs him (src/render/crew.js, Fielding.ballDead).
    if (this.field) this.field.ballDead({ wicket: outcome.wicket, who: res.who });
    this.waitField = 0;
    // Byes: runs off a ball that was not hit go down as extras, not to you.
    if (this.byes && !outcome.wicket) {
      outcome.byes = true; outcome.boundary = 0;
      big = res.kind === 'boundary' && !res.overthrows ? 'FOUR BYES!' : outcome.runs ? runsText({ ...res, runs: outcome.runs, byes: true }) : 'No run';
      color = '#ffd34d';
      if (outcome.runs) g.umpires.signal('bye', now);
    }
    if (this.noBall && this.innings) { outcome.noBall = true; if (!outcome.wicket && !outcome.boundary) big = `No-ball${outcome.runs ? ` + ${outcome.runs}` : ''}`; }
    else if (this.wide && !this.hit && !outcome.wicket && this.innings) { outcome.wide = true; big = outcome.runs ? `Wide + ${outcome.runs}` : 'Wide'; g.umpires.signal('wide', now); }

    // Umpires, crowd, commentary.
    if (outcome.boundary) {
      g.umpires.signal(outcome.boundary === 6 ? 'six' : 'four', now);
      g.crowdReact(outcome.boundary === 6 ? 'six' : 'four');
      g.say('boundary', { runs: outcome.boundary });
    } else if (outcome.wicket) {
      if (res.kind !== 'lbw') g.umpires.signal('out', now);
      g.crowdReact('wicketAgainst');
      if (res.kind === 'caught') g.say('catch', { keeper: res.by === 'Keeper' });
      else if (res.kind === 'runout') g.say('run_out');
      else if (res.kind === 'stumped') g.say('third_result', { what: 'stumping', out: true });
      g.say('wicket', { how: res.kind === 'runout' ? 'run_out' : res.kind });
    } else if (outcome.runs > 0) {
      g.sample('applause_polite', { gain: 0.7 });
      if (res.closeCall != null && res.closeCall < 0.9) g.crowdReact('close');
    } else if (res.kind === 'beaten' && !res.padded && !res.backInTime) g.crowdReact(this.offer.wild ? 'miss' : 'beaten');
    else if (res.backInTime || (res.kind === 'beaten' && res.padded)) g.crowdReact('close');
    else if (outcome.wide || outcome.noBall) { /* nothing */ } else g.crowdReact('dot');

    let overDone = false;
    if (this.innings) {
      const r = this.innings.record(outcome);
      overDone = r.overDone;
      if (overDone) big += '  · over';
      if (r.card) {
        for (const m of r.card.milestones) { g.ui.prompt(`${m.name} reaches ${m.runs}!`, 2.5, '#ffd34d'); g.crowdReact('milestone'); g.cheer(0.5); }
        if (r.card.newBatter && !this.innings.complete) this.newBatter = r.card.newBatter.name;
      }
      this.partnership = outcome.wicket ? 0 : this.partnership + outcome.runs;
      this.dots = outcome.runs || outcome.wide || outcome.noBall ? 0 : this.dots + 1;
      const inn = this.innings;
      g.commentary.situation = { runs: inn.runs, wickets: inn.wickets, balls: inn.legal, ballsLimit: inn.ballsLimit, target: inn.target, wicketsLimit: inn.wicketsLimit, partnershipRuns: this.partnership, dotsInRow: this.dots, battingIsPlayer: true };
      if (!this.hit && !outcome.wicket) g.say('swing', { result: res.kind === 'beaten' && !res.padded ? 'miss' : 'leave' });
      g.say('ball', { runs: outcome.runs, wide: outcome.wide, boundary: outcome.boundary, wicket: outcome.wicket, overDone });
    }
    if (this.hit && res.kind === 'hit' && this.hit.carry > this.stats.bestCarry) this.stats.bestCarry = this.hit.carry;
    const detail = this.shotDetail() || (res.kind === 'beaten' ? 'Played and missed' : '');
    g.ui.setHud({ big, bigColor: color, last: ballText, detail: this.newBatter ? `New batter in: ${this.newBatter}${detail ? '\n' + detail.split('\n')[0] : ''}` : detail });
    if (outcome.wicket || outcome.boundary) g.ui.prompt(big, 2.4, color);
    else if (outcome.noBall) g.ui.prompt(`NO BALL${this.noBallWhy ? ` — ${this.noBallWhy}` : ''} — free hit next`, 2.6, '#ffb347');
    else if (this.bouncerNote && this.innings) g.ui.prompt(this.bouncerNote, 2.2, '#ffd34d');
    this.updateHud();
  }

  updateHud() {
    const g = this.game;
    let score, sub;
    if (this.innings) {
      const inn = this.innings;
      score = `${inn.scoreText}  (${inn.overs})`;
      sub = inn.target != null ? `Need ${inn.runsNeeded} off ${inn.ballsLeft} · ${inn.wicketsLeft} wkts left` : `${inn.ballsLeft} balls left · ${inn.wicketsLeft} wkts in hand`;
      const card = inn.card;
      g.ui.setBoard([this.title.toUpperCase(), score, card ? card.pairText() : sub, card && card.bowler ? `${card.bowlerText()}   ·   ${inn.thisOver.join(' ') || '-'}` : `This over: ${inn.thisOver.join(' ') || '-'}`]);
      g.ui.setHud({ title: this.title, score, sub, footer: this.footer(), players: card ? `${card.pairText()}${inn.freeHit ? '   ·   FREE HIT' : ''}` : '' });
      g.ui.setHud({ drs: this.reviews.text() });       // reviews left (lbwFlow.js / reviews.js)
    } else {
      const s = this.stats;
      score = `${s.balls} balls`;
      const m = g.settings.machine;
      sub = `Machine: ${Math.round(m.paceKmh)} km/h · ${lengthName(m.length)} · ${lineName(m.line)}${m.swing ? (m.swing > 0 ? ' · out-swing' : ' · in-swing') : ''}${m.seam ? ' · seam' : ''}${m.spinType !== 'none' ? ` · ${m.spinType}-spin` : ''}`;
      g.ui.setBoard(['NETS', `${s.balls} balls · ${s.fours}×4 · ${s.sixes}×6`, `Middled ${s.middled} · edges ${s.edges} · bowled ${s.bowled}`, `Best carry ${Math.round(s.bestCarry)} m`]);
      g.ui.setHud({ title: this.title, score, sub, footer: this.footer(), drs: '' });
    }
  }

  onSettingsChanged() { this.updateHud(); }

  complete() {
    this.done = true;
    if (this.onDone) this.onDone(this.innings);
  }
}
