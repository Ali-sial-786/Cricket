// Ball-in-play controller: glue between the pure Fielding / Runs logic, the
// physics world, the animated figures and the player.
//   - batters run only when called (player: buttons; AI: its own judgement),
//     can be sent back and can dive; a throw that beats them is a run out
//   - when the player's side is fielding: catching chances are taken by the
//     player in slow motion (reach a hand to the ball), and the player picks
//     the end a fielder throws to
import * as THREE from 'three';
import { Fielding, PLAYER_CLEAR, STUMP_CLEAR } from './fielding.js';
import { planRuns, planMoreRuns, RUNNER_CLEAR } from './running.js';
import { overthrowRuns } from './throwing.js';
import { Vec3, clamp, smoothstep as sstep } from '../physics/math.js';
import { PITCH } from '../physics/pitch.js';
import { CONFIG } from '../config.js';
import { HINTS } from '../ui/controllerHint.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _g = new THREE.Vector3();

// The player's space: no fielder, keeper or umpire's feet within PLAYER_CLEAR
// of your head (on the ground), no runner within RUNNER_CLEAR.
// Fielders do not walk through the batters either.
const BATTER_CLEAR = 0.95;     // (a batter's stance / lean on the bat reaches forward)
const UMPIRE_CLEAR = 0.9;      // (his signals reach out)
const BOWLER_CLEAR = 0.8;
const PLAYER_PATH = 2.1;       // anyone running or walking past you gives you this much room
const LANE_CLEAR = 1.5;        // half-width of your run-up lane kept empty between balls
const BOWL_CREASE_Z = PITCH.bowlingStumpsZ + PITCH.poppingOffset;
const KEEPER_BREAK_REACH = 1.6;  // m from the stumps: the keeper can lunge in and take the bails off

export class FieldController {
  constructor(game, { spinner = false, bowlerFields = true, playerBatting = true } = {}) {
    this.game = game;
    const skill = CONFIG.ai[game.settings.difficulty] || CONFIG.ai.medium;
    // (throwing: easy 0.85, medium 1, hard 1.15 -- the spread of a throw is divided by it)
    const throwSkill = 0.85 + (skill.catchSkill - 0.55) / (0.88 - 0.55) * 0.3;
    this.logic = new Fielding({ rng: game.rng, catchSkill: skill.catchSkill, throwSkill, spinner, bowlerFields });
    this.logic.autoRuns = false;
    this.logic.runs = game.runs;           // (where to throw depends on how the batters are running)
    this.playerBatting = playerBatting;
    this.playerFielding = !playerBatting;
    this.delivering = false;
    this.keeperTold = false;
    this.outcome = null;
    this.catch = null;
    this.aiRunsLeft = 0;
    this.pred = null;
    this.restoreViewAt = 0;
  }
  get runs() { return this.game.runs; }

  enter() {
    const g = this.game;
    g.fieldView.show(true);
    this.logic.reset();
    this.logic.runs = g.runs;
    g.fieldView.update(0, this.logic.states(), { t: g.simTime, ball: null, delivering: false });
    this.clearRunners();
  }
  exit() {
    const g = this.game;
    g.fieldView.show(false);
    g.ballOverride = null;
    this.endCatchView(true);
    this.clearRunners();
  }

  // The ball is dead (the session has its result): everyone starts for where
  // he belongs for the next ball now -- fielders back to their marks, the
  // batters to their ends (changed after an odd number of runs), a batter who
  // is out off to the pavilion and the next one in. info: { wicket, who }.
  ballDead(info = {}) {
    this.logic.ballDead();
    if (this.game.crew) this.game.crew.ballDead(info);
    this.deadT = 0;
  }
  // Is everyone where he should be, standing still, for the bowler to run in?
  settled() {
    const g = this.game;
    return this.logic.settled() && (!g.crew || g.crew.settled()) && (!g.umpires.settled || g.umpires.settled());
  }
  // The bowler is waiting: `secs` left before the ball is bowled regardless. Whoever is not back yet runs.
  hurry(secs) { this.logic.hurry = Math.max(0.01, secs); }

  // Next ball: whoever is still away from his place keeps going there (nobody is put anywhere).
  reset() {
    this.logic.newBall();
    this.pendingBreak = null;
    this.droppedTold = false;
    this.game.ballOverride = null;
    this.delivering = false;
    this.keeperTold = false;
    this.outcome = null;
    this.catch = null;
    this.aiRunsLeft = 0;
    this.ropeWatch = false;
    this.pred = null;
    this.throwPrompted = false;
    this.turnedBack = false;
    // (a ball that ended without a result, e.g. a dead ball: the batters still sort themselves out on foot)
    const g = this.game;
    if (g.crew) {
      if (this.runs.active && !g.crew.pending) g.crew.ballDead({});
      if (g.crew.pending) { const p = g.crew.pending; g.crew.pending = null; g.crew.resolve(p); }
    } else this.clearRunners();
  }
  // Everyone stood where he starts (a session beginning or ending: nobody is watching).
  clearRunners() {
    const g = this.game, r = this.runs;
    r.reset();
    if (g.crew) g.crew.reset();
    g.batterView.running = null;
    g.nonStrikerView.running = null;
    g.nonStrikerView.reset();
    if (g.batterView.runnerOnly) g.batterView.show(false);
  }

  inPosition() { return this.logic.inPosition(); }
  beginDelivery() { this.delivering = true; this.logic.walkIn(); }
  released() { this.logic.onRelease(); }
  endDelivery() { this.delivering = false; }
  setSpinner(on) { this.logic.setSpinner(on); }
  // The keeper goes for the wicket (bails off, or a throw at the stumps from
  // where he stands back). Returns when it will be broken (or the throw gets there).
  keeperAttack(t) { return this.logic.keeperAttack(t, this.game.rng, CONFIG.keeper.shyHit[this.game.settings.difficulty] ?? 0.5); }
  get attack() { return this.logic.attack; }
  get keeperMissed() { return this.logic.keeperMissed; }
  get keeperUp() { return this.logic.keeperUp; }
  get fielded() { return this.logic.fielded; }
  get message() { return this.logic.message; }
  get keeperHold() { return this.logic.keeperHold; }
  result() { return this.outcome; }

  // ------------------------------------------------------------- the hit
  onHit(ball, t, pred, opts = undefined) {
    const g = this.game, L = this.logic;
    // The bowler fields as himself: from where his follow-through has taken him, at the pace he is going.
    if (L.bowlerFields) {
      const A = g.figures.bowler.actor, f = L.fielders[L.fielders.length - 1];
      if (A.visible && f.state === 'set') { f.pos.set(A.pos.x, 0, A.pos.z); f.face = f.yaw = A.heading; f.speed = A.speed; f.vel.set(Math.sin(A.heading) * A.speed, 0, Math.cos(A.heading) * A.speed); }
    }
    L.onHit(ball, t, pred, opts);
    this.pred = pred;
    this.delivering = false;
    // When you bat, a runner in your kit sets off from where you are standing.
    const hp = g.input.headPose.p;
    const striker = g.batterView.runnerOnly
      ? (g.input.xr ? new Vec3(hp.x, 0, hp.z) : new Vec3(-0.4, 0, -1.1))
      : new Vec3(g.batterView.actor.pos.x, 0, g.batterView.actor.pos.z);
    this.runs.begin(t, striker, g.nonStrikerView.visible ? g.nonStrikerView.actor.pos : null);
    if (!this.playerBatting) {
      // Going to the rope: they watch it go (and run only if it is stopped).
      const est = L.estimateReturn();
      const bold = 0.25 + 0.5 * (g.aiBatter.aggression || 0.4);
      this.ropeWatch = L.boundaryAhead();
      this.aiRunsLeft = this.ropeWatch || est === 0 ? 0 : est === Infinity ? 3 : planRuns(est, bold, g.rng);
    }
    // A catch for the player to take?
    if (this.playerFielding && L.plan && L.plan.airborne) this.planCatch(t);
  }

  onBoundary(e) {
    this.logic.onBoundary(e);
    if (this.logic.outcome && !this.outcome) this.takeLogicOutcome();
  }
  // A boundary or a catch: the ball is dead. Overthrows to the rope: a run in
  // progress that they had crossed on when the throw was made counts, and is finished.
  takeLogicOutcome() {
    const o = this.outcome = this.logic.outcome;
    this.runs.close({ boundary: o.kind === 'boundary', to: o.overthrows && o.crossed ? o.ran : null });
  }

  // Player batting controls.
  callRun() { if (!this.playerBatting || this.outcome) return false; const ok = this.runs.call(); if (ok) this.game.sample('footstep'); return ok; }
  turnBack() { return this.playerBatting && !this.outcome && this.runs.turnBack(); }
  dive(t) { return this.playerBatting && !this.outcome && this.runs.dive(t); }
  // The end a throw is on its way to (null: none in the air).
  throwEnd() { const th = this.logic.throw; return th && th.released && !this.logic.throwArrived ? th.end : null; }

  // ------------------------------------------------------------- catching (player)
  planCatch(t) {
    const L = this.logic, p = L.plan, C = CONFIG.catching;
    // Where you take it: the ball nearest chest height in the moments the
    // fielder could get there. Not a point the ball reaches almost at once
    // (C.minTime after the bat: no time to see it), nor one right behind the
    // striker (within C.minGap: his body would fill your view) — an edge to a
    // keeper is taken a little further back along its flight instead. With no
    // such point (it bounces first), the fielder there takes it himself.
    const bat = this.game.batterView && this.game.batterView.actor ? this.game.batterView.actor.pos : null;
    const fit = (s) => {
      if (s.t < C.minTime) return false;
      if (!bat) return true;
      const hv = Math.hypot(s.vx, s.vz) || 1;
      return Math.hypot(s.x + s.vx / hv * C.standOff - bat.x, s.z + s.vz / hv * C.standOff - bat.z) >= C.minGap;
    };
    let best = null, first = null;
    for (const s of this.pred.samples) {
      if (s.bouncesSinceBat > 0) break;
      if (s.t < p.t - 0.1 || s.t > p.t + 0.5) continue;
      const score = Math.abs(s.y - 1.25);
      if (!best || score < best.score) best = { s, score };
      if (first == null && fit(s)) first = s.t;
    }
    if (best && !fit(best.s)) {
      // (moved: the first usable moments of its flight, near chest height)
      best = null;
      for (const s of this.pred.samples) {
        if (s.bouncesSinceBat > 0 || first == null || s.t > p.t + 0.5) break;
        if (s.t < first || !fit(s)) continue;
        const score = Math.abs(s.y - 1.25) + 2 * (s.t - first);
        if (!best || score < best.score) best = { s, score };
      }
      if (!best) return;
    }
    const s = best ? best.s : { x: p.x, y: p.y, z: p.z, vx: 0, vz: 1, t: p.t };
    if (!fit(s)) return;
    const hv = Math.hypot(s.vx, s.vz) || 1;
    const dir = { x: s.vx / hv, z: s.vz / hv };
    this.catch = {
      f: L.fielders[p.fi], fi: p.fi, state: 'pending',
      point: new Vec3(s.x, Math.min(2.0, Math.max(0.35, s.y)), s.z), tArrive: L.hitT + s.t, dir,
      stand: { x: s.x + dir.x * C.standOff, z: s.z + dir.z * C.standOff },
      tStart: Math.max(t, L.hitT + s.t - C.leadTime),
    };
    this.catch.f.playerControlled = true;
  }

  updateCatch(t) {
    const g = this.game, c = this.catch, b = g.world.ball, C = CONFIG.catching;
    if (!c || c.state === 'done') return;
    if (c.state === 'pending') {
      if (t < c.tStart) return;
      c.state = 'live';
      c.f.pos.set(c.stand.x, 0, c.stand.z);
      c.f.speed = 0; c.f.vel.set(0, 0, 0);
      g.beginViewOverride(c.stand.x, c.stand.z, -c.dir.x, -c.dir.z);
      g.timeScaleTarget = C.slowMo;
      g.ui.prompt('CATCH IT!  Get a hand to the ball', 8, '#ffd34d');
      g.catchMarker.position.set(c.point.x, c.point.y, c.point.z);
      g.catchMarker.visible = true;
      g.say('catch_chance', { time: c.tArrive - this.logic.hitT });
    }
    if (c.state !== 'live') return;
    if (b.active) {
      for (const h of g.playerHands()) {
        if (Math.hypot(h.x - b.pos.x, h.y - b.pos.y, h.z - b.pos.z) < C.handRadius) {
          g.world.removeBall();
          this.logic.playerCaught(c.f);
          this.logic.ballOverride = { pos: new Vec3(h.x, h.y, h.z), hand: h };
          g.input.left.pulse(0.9, 70); g.input.right.pulse(0.9, 70);
          g.sample('catch') || g.sfx.catchThud();
          this.finishCatch(true, t);
          return;
        }
      }
    }
    if (!b.active || b.bouncesSinceBat > 0 || t > c.tArrive + 0.3) {
      if (b.active) this.logic.playerDropped(c.f, b); else c.f.playerControlled = false;
      this.finishCatch(false, t);
    }
  }

  finishCatch(success) {
    const g = this.game, c = this.catch;
    c.state = 'done';
    c.success = success;
    g.timeScaleTarget = 1;
    g.catchMarker.visible = false;
    g.ui.prompt(success ? 'CAUGHT!' : 'Dropped…', 1.6, success ? '#7dff8a' : '#ff9f43');
    this.restoreViewAt = (g.clock || 0) + (success ? 1.6 : 0.7);
    if (!success) g.say('drop');
  }

  endCatchView(force = false) {
    const g = this.game;
    if (g.viewOverride && (force || (this.restoreViewAt && (g.clock || 0) >= this.restoreViewAt))) {
      this.restoreViewAt = 0;
      g.endViewOverride();
      g.timeScaleTarget = 1;
      g.catchMarker.visible = false;
    }
  }

  // Break the stumps at `end` `delay` s from now, with whoever holds the ball
  // there sweeping a glove into them (run-outs, stumpings, close calls).
  breakStumps(end, t, delay = 0.12) {
    const L = this.logic;
    const holder = L.ballOverride && L.ballOverride.holder != null ? L.fielders[L.ballOverride.holder] : (end === 'batting' ? L.fielders[0] : L.receiverAt(end));
    const a = holder && holder.action;
    if (a && a.type === 'take') a.breakAt = t + delay;
    else if (a && a.type === 'break') { if (a.at < t) a.at = t + delay; }
    // (the keeper sweeps the bails off only if he is at the stumps: off chasing
    // the ball, a throw that runs a batter out has hit them on its own)
    else if (holder && end === 'batting' && holder.keeper && Math.hypot(holder.pos.x, holder.pos.z - PITCH.battingStumpsZ) < KEEPER_BREAK_REACH) L.keeperBreak(t, t + delay);
    this.pendingBreak = { end, t: t + delay };
  }

  // The wicket at `end` is broken this instant (the replay cuts to that crease).
  breakNow(end, t) {
    const g = this.game;
    const w = g.world && g.world.wickets ? g.world.wickets.find((x) => x.end === end) : null;
    if (w) w.broken = true;                    // (a ball rolling into them later does not break them again)
    if (g.stumps[end].broken) return;
    g.stumps[end].break({ x: 0, y: 0, z: end === 'batting' ? -8 : 8 }, 1);
    g.sample('stumps') || g.sfx.stumps();
    g.sample('bails', { gain: 0.6 });
    g.replay.mark('break', t);
    g.replay.marks.breakEnd = end;
  }

  // A throw has hit the stumps, got past everyone (overthrows) or been put down.
  onThrowEvent(e, t) {
    const g = this.game, L = this.logic, r = this.runs;
    if (e.type === 'stumps') { this.breakNow(e.end, t); return; }
    if (this.outcome || L.dead) return;
    if (e.type === 'overthrow') {
      g.ui.prompt(this.playerBatting ? 'OVERTHROW!  Run?' : 'Overthrow!', 1.6, this.playerBatting ? '#7dff8a' : '#ffb347');
      g.crowdReact('close');
      // The AI batters: more runs if the ball is well away and nobody is backing up.
      if (!this.playerBatting && r.active && !r.closed) {
        const bold = 0.25 + 0.5 * (g.aiBatter.aggression || 0.4);
        this.ropeWatch = false;
        this.turnedBack = false;
        this.aiRunsLeft = planMoreRuns(L.estimateBack(t), r, bold, g.rng);
      }
    }
  }

  // ------------------------------------------------------------- per frame
  // The player's head, the umpires and the batters, for everyone to keep clear of.
  // Where the player is: your head in the headset; on a monitor (whose camera
  // may be anywhere) where your batter / bowler stands.
  playerSpot() {
    const g = this.game, s = g.session;
    if (!g.input) return null;
    if (g.input.xr || !s) return g.input.headPose ? g.input.headPose.p : null;
    if (s.isBowling && g.bowlerHead) return g.bowlerHead().p;
    if (s.body) return s.body();
    return g.input.headPose ? g.input.headPose.p : null;
  }

  keepClear(dt) {
    const g = this.game, L = this.logic, r = this.runs;
    const hp = this.playerSpot();
    // (nobody stands within PLAYER_CLEAR of you; anyone on the move passes PLAYER_PATH wide)
    L.keepOut = hp ? { x: hp.x, z: hp.z, r: PLAYER_CLEAR, path: PLAYER_PATH } : null;
    r.keepOut = hp ? { x: hp.x, z: hp.z, r: RUNNER_CLEAR, striker: this.playerBatting } : null;
    g.nonStrikerView.avoid = hp;
    g.batterView.avoid = hp;
    if (g.umpires.keepClear) g.umpires.keepClear(g.umpires.visible ? hp : null, dt, PLAYER_CLEAR);
    const obs = g.umpires.visible ? g.umpires.spots().map((u) => ({ x: u.x, z: u.z, r: UMPIRE_CLEAR })) : [];
    const bv = g.batterView, ns = g.nonStrikerView;
    if (bv.shown && bv.actor.visible) obs.push({ x: bv.actor.pos.x, z: bv.actor.pos.z, r: BATTER_CLEAR });
    if (ns.visible) obs.push({ x: ns.actor.pos.x, z: ns.actor.pos.z, r: BATTER_CLEAR });
    // The AI bowler walking back (not running in: his line is his own) is in everyone's way too.
    const bw = g.figures && g.figures.bowler.actor;
    if (bw && bw.visible && bw.state !== 'runup') obs.push({ x: bw.pos.x, z: bw.pos.z, r: BOWLER_CLEAR });
    // Your run-up is yours: between balls and while you run in nobody walks
    // or stands in the lane from your mark to the crease.
    const ses = g.session;
    if (this.playerFielding && ses && ses.run && hp && (L.dead || ses.state === 'ready')) {
      const z1 = BOWL_CREASE_Z, z0 = Math.min(hp.z, z1 - (ses.run.spec ? ses.run.spec.length : 0));
      for (let z = z0 - 1; z <= z1 + 1.01; z += 1.5) obs.push({ x: hp.x, z, r: LANE_CLEAR, soft: true });     // (steered round; nobody is shoved out of it)
    }
    // a batter on his way off or in
    if (g.crew) for (const a of g.crew.leaving) obs.push({ x: a.pos.x, z: a.pos.z, r: BATTER_CLEAR });
    L.obstacles = obs;
    // (a walking umpire goes round the bowler and the batters)
    const uo = this._umpObs || (this._umpObs = []);
    uo.length = 0;
    if (g.figures && g.figures.bowler.actor.visible) uo.push({ x: g.figures.bowler.actor.pos.x, z: g.figures.bowler.actor.pos.z, r: 0.9 });
    if (bv.shown && bv.actor.visible) uo.push({ x: bv.actor.pos.x, z: bv.actor.pos.z, r: BATTER_CLEAR });
    if (ns.visible) uo.push({ x: ns.actor.pos.x, z: ns.actor.pos.z, r: BATTER_CLEAR });
    uo.push({ x: 0, z: PITCH.bowlingStumpsZ, r: STUMP_CLEAR + 0.2 });
    if (hp) uo.push({ x: hp.x, z: hp.z, r: PLAYER_CLEAR });
    g.umpires.obstacles = uo;
    // ... and he walks round the umpire, the batters and both sets of stumps.
    if (bw) {
      const bo = bw.obstacles || (bw.obstacles = []);
      bo.length = 0;
      if (g.umpires.visible) for (const u of g.umpires.spots()) bo.push({ x: u.x, z: u.z, r: UMPIRE_CLEAR });
      if (bv.shown && bv.actor.visible) bo.push({ x: bv.actor.pos.x, z: bv.actor.pos.z, r: BATTER_CLEAR });
      if (ns.visible) bo.push({ x: ns.actor.pos.x, z: ns.actor.pos.z, r: BATTER_CLEAR });
      bo.push({ x: 0, z: PITCH.bowlingStumpsZ, r: STUMP_CLEAR }, { x: 0, z: PITCH.battingStumpsZ, r: STUMP_CLEAR });
      if (hp) bo.push({ x: hp.x, z: hp.z, r: PLAYER_CLEAR });
    }
  }

  update(dt, t) {
    const g = this.game, w = g.world, L = this.logic, b = w.ball, r = this.runs;
    // The AI bowler is one man drawn by two figures: his own (run-up, delivery,
    // the walk back) and a fielder's (when he fields). Each takes over from
    // the other where he is, as he is: same place, facing, stride and pose.
    if (L.bowlerFields) {
      const i = L.fielders.length - 1, f = L.fielders[i], BA = g.figures.bowler.actor, FA = g.fieldView.actors[i];
      if (f.out && L.dead && !f.action && (f.state === 'return' || f.state === 'set') && g.fieldView.visible) {
        if (L.ballOverride && L.ballOverride.holder === i) L.ballOverride = null;   // (the ball goes with him, into his own figure)
        BA.takeOver(FA, f.speed);
        f.out = false; f.state = 'set'; f.target = null; f.speed = 0; f.vel.set(0, 0, 0);
        g.figures.bowler.show(true);
        FA.visible = false;
      } else if (!f.out && L.hitT != null && !L.dead && f.state !== 'set' && BA.visible) {
        f.out = true;
        FA.visible = true;
        FA.takeOver(BA);
        g.figures.bowler.show(false);
      }
    }
    this.keepClear(dt);
    // A broken wicket is put back up once the ball is dead and its replay has
    // played (the view comes back in from dark then); with no replay, before the next ball.
    if (L.dead && g.replay && g.replay.marks && g.replay.marks.played && !g.replay.active && (g.stumps.batting.broken || g.stumps.bowling.broken)) {
      g.stumps.batting.reset(); g.stumps.bowling.reset(); w.resetWickets();
    }
    L.update(dt, t, b.active ? b : null, w);
    this.updateCatch(t);
    this.endCatchView();

    // The keeper moves with the line of a ball that has not been hit, and
    // takes it only if he can physically reach it. If he can't, it runs away
    // behind him and the session treats it as byes.
    if (b.active && !b.batted && !b.padded && !L.outcome && !L.keeperHold && !L.keeperMissed && L.hitT == null) {
      L.keeperTrack(b, t);
      const got = L.keeperTry(b, t);
      if (got === 'take') { w.removeBall(); g.sample('gloves') || g.sfx.catchThud(); g.replay.mark('held', t); }
      else if (got === 'miss') g.crowdReact('close');
    }
    // His throw at the stumps arrives: it breaks them, or it misses and runs on (byes).
    if (L.shy && !L.shy.done && t >= L.shy.at) {
      L.shy.done = true;
      if (L.shy.hit) this.breakNow('batting', t);
      else L.shyMissed(w, t);
    }
    // What the throws did this frame: the stumps hit, a throw got away (overthrows).
    for (const e of L.events.splice(0)) this.onThrowEvent(e, t);

    // ---- running ----
    if (r.active && !this.outcome) {
      if (!this.playerBatting) {
        // A ball they watched heading for the rope has been stopped: run if there is time.
        if (this.ropeWatch && L.throw && !L.throw.released && r.completed === 0 && !r.running) {
          this.ropeWatch = false;
          const bold = 0.25 + 0.5 * (g.aiBatter.aggression || 0.4);
          this.aiRunsLeft = planRuns(L.throw.tArrive - t, bold, g.rng);
        }
        if (this.aiRunsLeft > 0 && !r.running && r.call()) this.aiRunsLeft--;
        const th = L.throw;
        if (th && r.running) {
          // Will they make it? If clearly not (and still early in the run), turn back; near the line, dive.
          const F = CONFIG.field;
          const need = r.remaining * F.runNext;
          if (!r.goingBack && r.remaining > 0.62 && t + need > th.tArrive + 0.1 && !this.turnedBack && g.rng() < 0.75) { r.turnBack(); this.turnedBack = true; this.aiRunsLeft = 0; }
          // Touch and go at the end the throw is coming to: dive for it.
          if (th.released && t + r.remaining * F.runNext > th.tArrive - 0.3) { r.diveEnd = th.end; r.dive(t); }
        }
      }
    }
    if (r.active) {
      // When you bat, your runner only exists while there is running to do: he
      // appears when a run is called…
      if (g.batterView.runnerOnly && !g.batterView.shown && (r.running || r.completed > 0)) g.batterView.show(true);
      // The batters keep moving after the ball is dead (finishing a run,
      // trotting back, getting up from a dive): nobody is left frozen mid-stride.
      r.stay = !!(g.session && g.session.state === 'review');     // a diver stays down while the third umpire looks at it
      r.update(dt);
      if (r.running && !r.closed && Math.floor(t * 4.5) !== Math.floor((t - dt) * 4.5)) g.sample('footstep', { gain: 0.5 });
      // The AI striker stays in his shot until he actually sets off (the run,
      // if there is one, starts from wherever the shot has left him).
      const started = r.p > 1e-6 || r.running || r.down > 0;
      if (!started && !g.batterView.runnerOnly) {
        const a = g.batterView.actor;
        r.sStart = { x: a.pos.x, z: a.pos.z };
        g.batterView.running = null;
      } else g.batterView.running = r.state(true);
      g.nonStrikerView.running = g.nonStrikerView.visible ? r.state(false) : null;
    }
    // …and once the ball is dead and everyone has stopped, the batters walk to
    // their places for the next ball (crew.js).
    if (g.crew) g.crew.update(dt, t);

    // ---- the player picks the end to throw to ----
    const th = L.throw;
    if (this.playerFielding && th && !th.released && !this.outcome) {
      g.hint([HINTS.toKeeper, HINTS.toBowler], 0.4);       // up until the throw is away
      const R = g.input.right;
      if (R.buttons.a.down && L.setThrowEnd('batting')) g.ui.prompt('To the keeper!', 1.2);
      if (R.buttons.b.down && L.setThrowEnd('bowling')) g.ui.prompt("Bowler's end!", 1.2);
    }

    // ---- outcomes ----
    if (!this.outcome) {
      if (L.dropped && !this.droppedTold) { this.droppedTold = true; g.crowdReact(this.playerBatting ? 'close' : 'dropped'); }
      if (L.outcome) {                                   // boundary or catch
        this.takeLogicOutcome();
      } else if (L.throwArrived) {
        const ta = L.throwArrived, end = ta.end;
        const short = r.running ? r.shortBy() : -1;
        const ot = L.overthrow ? overthrowRuns : null;
        if (r.running && short > 0) {
          this.outcome = { kind: 'runout', runs: r.completed, end, margin: short, who: r.headingTo(end), direct: !!ta.direct };
          if (ta.direct) this.breakNow(end, t);          // (the ball has broken them itself)
          else this.breakStumps(end, t, 0.12);
          r.close({ stop: !r.diving, short });
        } else if (ta.direct && !(r.rate !== 0 && short > -0.45)) {
          // A direct hit with the batters home: the ball comes off the stumps
          // and is still in play (they may run again on it).
          L.throwArrived = null;
        } else {
          // Made their ground: the run counts, and they finish it as they were going
          // (running through, or sliding in on the chest) instead of being put on the line.
          const close = r.rate !== 0 && short > -1.2 ? -short : null;
          const runs = r.makeGround();
          this.outcome = { kind: 'runs', runs, closeCall: close, end, overthrows: ot ? ot(runs, L.overthrow.base).overthrows : 0 };
          if (!ta.direct) g.sample('gloves', { gain: 0.7 });
          r.close();
        }
      }
    }

    const ballPos = b.active ? _v.set(b.pos.x, b.pos.y, b.pos.z) : (g.ballOverride ? _v.copy(g.ballOverride.pos) : null);
    const states = L.states();
    // (the fielder you are catching as: not drawn until your view goes back, so he never appears round your head)
    if (this.catch && (this.catch.state === 'live' || (this.catch.state === 'done' && g.viewOverride))) states[this.catch.fi].hidden = true;
    // (everyone else whose body a lunging fielder must not go into)
    const others = this._others || (this._others = []);
    others.length = 0;
    if (g.umpires.visible) for (const u of g.umpires.spots()) others.push(u);
    for (const a of [g.batterView.shown && g.batterView.actor, g.nonStrikerView.visible && g.nonStrikerView.actor, g.figures.bowler.actor]) if (a && a.visible) others.push(a.h.root.position);
    const hp = this.playerSpot();
    if (hp) others.push(hp);                             // (nor into you)
    // (ready and crouched while the ball is on its way: not once the keeper has taken it or it has beaten him)
    const ready = this.delivering && !L.keeperHold && !L.keeperMissed;
    g.fieldView.update(dt, states, { t, ball: ballPos, delivering: ready, cam: g.input.headPose.p, others });

    // Stumps broken by a glove: they fly when the hand gets there.
    if (this.pendingBreak && t >= this.pendingBreak.t) {
      const end = this.pendingBreak.end;
      this.pendingBreak = null;
      this.breakNow(end, t);
    }

    // Ball in a fielder's hands: both hands at the moment of the catch, then
    // held in the right hand (never floating between them).
    if (L.ballOverride) {
      const o = L.ballOverride;
      if (o.hand) _w.set(o.hand.x, o.hand.y, o.hand.z);
      else if (o.holder != null && o.holder >= 0) {
        const a = L.fielders[o.holder].action;
        // (between both hands only while they are together round it: half-way between two
        // hands still on their way in would be in the chest)
        const both = a && (a.type === 'keep' || a.type === 'take' || a.type === 'catch') && t - a.t0 < 0.3 && g.fieldView.handsApart(o.holder) < 0.22;
        if (both) g.fieldView.glovesPos(o.holder, _w); else g.fieldView.ballHandPos(o.holder, _w);
      } else if (L.throw && t < L.throw.tStart) {
        const i = L.fielders.indexOf(L.throw.f);
        const a = L.throw.f.action;
        const picked = !a || a.type !== 'pickup' || t - a.t0 > a.dur * 0.5;
        if (picked) g.fieldView.handPos(i, _w); else _w.copy(o.pos).setY(0.04);
      } else if (L.lob && L.lob.released && L.lobFrom) {
        // The ball tossed back: from his hand, the difference fading out along the lob.
        const lb = L.lob, i = L.fielders.indexOf(L.lobFrom);
        if (!lb.handFrom) { lb.handFrom = new THREE.Vector3(); g.fieldView.handPos(i, lb.handFrom); }
        const k = 1 - clamp((t - lb.tStart) / Math.max(1e-3, lb.tArrive - lb.tStart), 0, 1);
        _w.copy(o.pos);
        _w.x += (lb.handFrom.x - lb.from.x) * k; _w.y += (lb.handFrom.y - lb.from.y) * k; _w.z += (lb.handFrom.z - lb.from.z) * k;
      } else {
        _w.copy(o.pos);
        // A throw leaves from the thrower's hand (where it was drawn a frame
        // ago), not from the logic's point in his chest: the difference fades out along the flight.
        const th = L.throw;
        if (th && th.released && t < th.tArrive) {
          if (!th.handFrom) { th.handFrom = new THREE.Vector3(); g.fieldView.handPos(L.fielders.indexOf(th.f), th.handFrom); }
          const k = 1 - clamp((t - th.tStart) / Math.max(1e-3, th.tArrive - th.tStart), 0, 1);
          _w.x += (th.handFrom.x - th.from.x) * k; _w.y += (th.handFrom.y - th.from.y) * k; _w.z += (th.handFrom.z - th.from.z) * k;
          // ... and arrives in the receiver's gloves wherever he has got to (not at a
          // fixed point he may still be running to, through his arm or chest).
          const ri = th.receiver ? L.fielders.indexOf(th.receiver) : -1;
          if (ri >= 0 && g.fieldView.actors[ri].visible) {
            const e = sstep(0.4, 1, 1 - k);
            g.fieldView.glovesPos(ri, _g);
            _w.x += (_g.x - th.to.x) * e; _w.y += (_g.y - th.to.y) * e; _w.z += (_g.z - th.to.z) * e;
          }
        }
      }
      g.ballOverride = { pos: { x: _w.x, y: _w.y, z: _w.z } };
      g.ballView.setVisible(true);
    } else if (!b.active) {
      g.ballOverride = null;
    }

  }
}

void PITCH;
