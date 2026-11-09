// Glue between the pure Fielding logic, the physics world, the animated
// fielders, the keeper, and the batters running between the wickets.
import * as THREE from 'three';
import { Fielding } from './fielding.js';
import { CONFIG } from '../config.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3();

export class FieldController {
  constructor(game, { spinner = false, bowlerFields = true } = {}) {
    this.game = game;
    const skill = CONFIG.ai[game.settings.difficulty] || CONFIG.ai.medium;
    this.logic = new Fielding({ rng: game.rng, catchSkill: skill.catchSkill, spinner, bowlerFields });
    this.delivering = false;
    this.runsStarted = false;
    this.keeperTold = false;
  }
  get runners() { return this.game.runners; }

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
    this.clearRunners(false);
  }

  // Next ball: fielders jog back, batters regroup (swapping ends after odd runs).
  reset() {
    this.logic.newBall();
    this.game.ballOverride = null;
    this.delivering = false;
    this.keeperTold = false;
    this.clearRunners(true);
  }
  clearRunners(allowSwap) {
    const g = this.game, r = this.runners;
    if (allowSwap && r.active && r.final != null && r.final % 2 === 1) g.swapBatters();
    r.active = false;
    this.runsStarted = false;
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
  onHit(ball, t, pred) { this.logic.onHit(ball, t, pred); this.delivering = false; }
  onBoundary(e) { this.logic.onBoundary(e); }
  keeperTakes(ball) { this.logic.keeperTakes(ball); }
  get fielded() { return this.logic.fielded; }
  get message() { return this.logic.message; }
  result() { return this.logic.outcome; }
  runsSoFar(t) { return this.logic.runsSoFar(t); }

  update(dt, t) {
    const g = this.game, w = g.world, L = this.logic, b = w.ball;
    L.update(dt, t, b.active ? b : null, w);

    // Keeper gathers deliveries that beat (or are left by) the batter.
    if (b.active && !b.batted && !L.outcome && !L.keeperHold && b.pos.z > -0.5 && b.vel.z > 0) {
      const k = L.fielders[0];
      if (!this.keeperTold) { L.keeperTakes(b); this.keeperTold = true; }
      if (b.pos.z >= k.pos.z - 0.35 && Math.abs(b.pos.x - k.pos.x) < 1.5 && b.pos.y < 2.3) {
        L.keeperCollect(b, t);
        w.removeBall();
        g.sfx.catchThud();
      }
    }

    const ballPos = b.active ? _v.set(b.pos.x, b.pos.y, b.pos.z) : (g.ballOverride ? _v.copy(g.ballOverride.pos) : null);
    g.fieldView.update(dt, L.states(), { t, ball: ballPos, delivering: this.delivering, cam: g.input.headPose.p });

    // Ball in a fielder's hands.
    if (L.ballOverride) {
      const o = L.ballOverride;
      if (L.keeperHold) g.fieldView.glovesPos(0, _w);
      else if (L.caught) {
        const i = L.fielders.findIndex((f) => f.action && f.action.type === 'catch' && f.action.success);
        g.fieldView.glovesPos(Math.max(0, i), _w);
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

    // Batters running between the wickets.
    const r = this.runners;
    if (L.hitT != null && !this.runsStarted) {
      this.runsStarted = true;
      const striker = g.batterView.actor.pos.clone();
      if (g.batterView.runnerOnly) { striker.set(-0.4, 0, -1.1); g.batterView.show(true); }
      r.start(L.hitT, striker, g.nonStrikerView.actor.pos.clone());
    }
    if (r.active) {
      if (L.outcome) {
        if (L.outcome.kind === 'runs') r.setFinal(L.outcome.runs);
        else r.stop();
      }
      r.update(dt, t);
      g.batterView.running = r.state(true);
      g.nonStrikerView.running = g.nonStrikerView.visible ? r.state(false) : null;
    }

    // The AI bowler figure hands over to the fielding bowler once it moves.
    const st = L.states();
    const bf = st[st.length - 1];
    if (L.bowlerFields && g.figures.bowler.actor.visible === !bf.hidden && L.hitT != null) g.figures.bowler.show(bf.hidden);
  }
}
