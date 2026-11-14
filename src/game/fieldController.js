// Ball-in-play controller: glue between the pure Fielding / Runs logic, the
// physics world, the animated figures and the player.
//   - batters run only when called (player: buttons; AI: its own judgement),
//     can be sent back and can dive; a throw that beats them is a run out
//   - when the player's side is fielding: catching chances are taken by the
//     player in slow motion (reach a hand to the ball), and the player picks
//     the end a fielder throws to
import * as THREE from 'three';
import { Fielding } from './fielding.js';
import { planRuns } from './running.js';
import { Vec3 } from '../physics/math.js';
import { PITCH } from '../physics/pitch.js';
import { CONFIG } from '../config.js';
import { HINTS } from '../ui/controllerHint.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3();

export class FieldController {
  constructor(game, { spinner = false, bowlerFields = true, playerBatting = true } = {}) {
    this.game = game;
    const skill = CONFIG.ai[game.settings.difficulty] || CONFIG.ai.medium;
    this.logic = new Fielding({ rng: game.rng, catchSkill: skill.catchSkill, spinner, bowlerFields });
    this.logic.autoRuns = false;
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
    g.fieldView.update(0, this.logic.states(), { t: g.simTime, ball: null, delivering: false });
    this.clearRunners(false);
  }
  exit() {
    const g = this.game;
    g.fieldView.show(false);
    g.ballOverride = null;
    this.endCatchView(true);
    this.clearRunners(false);
  }

  // Next ball: fielders jog back, batters regroup (swapping ends after odd runs).
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
    this.pred = null;
    this.throwPrompted = false;
    this.clearRunners(true);
  }
  clearRunners(allowSwap) {
    const g = this.game, r = this.runs;
    if (allowSwap && r.active && r.crossed && !this.playerBatting) g.swapBatters();
    r.reset();
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
    L.onHit(ball, t, pred, opts);
    this.pred = pred;
    this.delivering = false;
    // When you bat, a runner in your kit sets off from where you are standing.
    const hp = g.input.headPose.p;
    const striker = g.batterView.runnerOnly
      ? (g.input.xr ? new Vec3(hp.x, 0, hp.z) : new Vec3(-0.4, 0, -1.1))
      : new Vec3(g.batterView.actor.pos.x, 0, g.batterView.actor.pos.z);
    if (g.batterView.runnerOnly) g.batterView.show(true);
    this.runs.begin(t, striker, g.nonStrikerView.visible ? g.nonStrikerView.actor.pos : null);
    if (!this.playerBatting) {
      const est = L.estimateReturn();
      const bold = 0.25 + 0.5 * (g.aiBatter.aggression || 0.4);
      this.aiRunsLeft = est === 0 ? 0 : est === Infinity ? 3 : planRuns(est, bold, g.rng);
    }
    // A catch for the player to take?
    if (this.playerFielding && L.plan && L.plan.airborne) this.planCatch(t);
  }

  onBoundary(e) {
    this.logic.onBoundary(e);
    if (this.logic.outcome && !this.outcome) { this.outcome = this.logic.outcome; this.runs.close(); }
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
    let best = null;
    for (const s of this.pred.samples) {
      if (s.bouncesSinceBat > 0) break;
      if (s.t < p.t - 0.1 || s.t > p.t + 0.5) continue;
      const score = Math.abs(s.y - 1.25);
      if (!best || score < best.score) best = { s, score };
    }
    const s = best ? best.s : { x: p.x, y: p.y, z: p.z, vx: 0, vz: 1, t: p.t };
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
      c.f.speed = 0;
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
    else if (holder && end === 'batting' && holder.keeper) L.keeperBreak(t, t + delay);
    this.pendingBreak = { end, t: t + delay };
  }

  // The wicket at `end` is broken this instant (the replay cuts to that crease).
  breakNow(end, t) {
    const g = this.game;
    if (g.stumps[end].broken) return;
    g.stumps[end].break({ x: 0, y: 0, z: end === 'batting' ? -8 : 8 }, 1);
    g.sample('stumps') || g.sfx.stumps();
    g.sample('bails', { gain: 0.6 });
    g.replay.mark('break', t);
    g.replay.marks.breakEnd = end;
  }

  // ------------------------------------------------------------- per frame
  update(dt, t) {
    const g = this.game, w = g.world, L = this.logic, b = w.ball, r = this.runs;
    L.obstacles = g.umpires.visible ? g.umpires.spots() : null;
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
    // His throw at the stumps arrives.
    if (L.shy && !L.shy.done && t >= L.shy.at) {
      L.shy.done = true;
      if (L.shy.hit) this.breakNow('batting', t);
    }

    // ---- running ----
    if (r.active && !this.outcome) {
      if (!this.playerBatting) {
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
      r.update(dt);
      if (r.running && Math.floor(t * 4.5) !== Math.floor((t - dt) * 4.5)) g.sample('footstep', { gain: 0.5 });
    }
    if (r.active) {
      g.batterView.running = r.state(true);
      g.nonStrikerView.running = g.nonStrikerView.visible ? r.state(false) : null;
    }

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
        this.outcome = L.outcome;
        r.close();
      } else if (L.throwArrived) {
        const end = L.throwArrived.end;
        const short = r.running ? r.shortBy() : -1;
        if (r.running && short > 0) {
          this.outcome = { kind: 'runout', runs: r.completed, end, margin: short, who: r.headingTo(end) };
          this.breakStumps(end, t, 0.12);
        } else {
          if (r.running) r.p = r.target;                // made their ground
          this.outcome = { kind: 'runs', runs: r.completed, closeCall: r.rate !== 0 && short > -1.2 ? -short : null, end };
          g.sample('gloves', { gain: 0.7 });
        }
        r.close();
      }
    }

    const ballPos = b.active ? _v.set(b.pos.x, b.pos.y, b.pos.z) : (g.ballOverride ? _v.copy(g.ballOverride.pos) : null);
    const states = L.states();
    if (this.catch && this.catch.state === 'live') states[this.catch.fi].hidden = true;
    g.fieldView.update(dt, states, { t, ball: ballPos, delivering: this.delivering, cam: g.input.headPose.p });

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
        const both = a && (a.type === 'keep' || a.type === 'take' || a.type === 'catch') && t - a.t0 < 0.3;
        if (both) g.fieldView.glovesPos(o.holder, _w); else g.fieldView.ballHandPos(o.holder, _w);
      } else if (L.throw && t < L.throw.tStart) {
        const i = L.fielders.indexOf(L.throw.f);
        const a = L.throw.f.action;
        const picked = !a || a.type !== 'pickup' || t - a.t0 > a.dur * 0.5;
        if (picked) g.fieldView.handPos(i, _w); else _w.copy(o.pos).setY(0.04);
      } else _w.copy(o.pos);
      g.ballOverride = { pos: { x: _w.x, y: _w.y, z: _w.z } };
      g.ballView.setVisible(true);
    } else if (!b.active) {
      g.ballOverride = null;
    }

    // The AI bowler figure hands over to the fielding bowler once it moves.
    const bf = states[states.length - 1];
    if (L.bowlerFields && g.figures.bowler.actor.visible === !bf.hidden && L.hitT != null) g.figures.bowler.show(bf.hidden);
  }
}

void PITCH;
