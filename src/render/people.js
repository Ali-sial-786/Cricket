// Scene-level people: wires the animated actors to game state.
import * as THREE from 'three';
import { Pose } from '../physics/math.js';
import { FielderActor, BowlerActor, BatterActor } from './actors.js';
import { ShotReader } from './playerShot.js';
import { toV3, toQ } from './util.js';
import { sstep, clamp } from './anim.js';
import { CONFIG } from '../config.js';

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _look = new THREE.Vector3(), _hf = new THREE.Vector3(), _ax = new THREE.Vector3(), _sw = new THREE.Vector3();

// AI striker: posed around the AIBatter's analytic bat; runs when runs are taken.
export class BatterView {
  constructor(scene, ai) {
    this.ai = ai;
    this.actor = new BatterActor(scene, { team: 'away', seed: 11 });
    this.pose = new Pose();
    this.show(false);
    this.running = null;   // {x, z, speed, heading} supplied by RunningController
  }
  show(v) { this.shown = v; this.actor.visible = v; }
  setTeam(team) { this.actor.h.setTeam(team); }
  update(t, dt = 1 / 72, ball = null) {
    if (!this.actor.visible) return;
    const a = this.actor;
    if (this.running) {
      a.pos.set(this.running.x, 0, this.running.z);
      a.speed = this.running.speed;
      a.turnToward(this.running.heading, dt, 9);
      if (this.running.dive) a.updateDive(dt, t, this.running.dive); else a.updateMoving(dt, t, ball, false);
      return;
    }
    this.ai.poseAt(t, this.pose);
    toV3(_p, this.pose.p);
    toQ(_q, this.pose.q);
    const plan = this.ai.plan;
    if (plan) { this._plan = this._plan || {}; Object.assign(this._plan, plan); this._plan.Tc = plan.TcTo ?? plan.Tc; }
    a.updateBatting(dt, _p, _q, { t, plan: plan ? this._plan : null, adv: this.ai.advanceAt(t), ball });
  }
}

// AI bowler wrapper (keeps the session API).
export class BowlerView {
  constructor(scene) {
    this.actor = new BowlerActor(scene, { team: 'away', seed: 5, headgear: 'bare' });
    this.fig = this.actor.h.root;      // for visibility toggling elsewhere
    this.show(false);
  }
  show(v) { this.actor.visible = v; }
  setTeam(team) { this.actor.h.setTeam(team); }
  startRunup(t, releasePos, kind) { this.actor.startRunup(t, releasePos, kind); }
  update(dt, t) { return this.actor.visible ? this.actor.update(dt, t) : false; }
  holdingBall() { return this.actor.visible && this.actor.holdingBall(); }
  handPos(out) { return this.actor.handPos(out, 'R'); }
}

// Fielders (+ keeper + bowler-fielder).
export class FieldView {
  constructor(scene, field) {
    this.actors = field.map((f, i) => new FielderActor(scene, {
      team: 'away', seed: 100 + i * 7, keeper: !!f.keeper,
      headgear: f.keeper ? 'cap' : f.bowler ? 'bare' : (i % 3 === 0 ? 'hat' : 'cap'),
      pads: !!f.keeper, gloves: !!f.keeper,
    }));
    for (let i = 0; i < field.length; i++) this.actors[i].place(field[i].x, field[i].z, Math.atan2(-field[i].x, -1 - field[i].z));
    this.show(false);
  }
  show(v) { this.visible = v; for (const a of this.actors) a.visible = v; }
  setTeam(team) { for (const a of this.actors) a.h.setTeam(team); }
  // states from Fielding.states(); ctx = {t, ball (THREE.Vector3|null), delivering}
  update(dt, states, ctx) {
    if (!this.visible) return;
    for (let i = 0; i < this.actors.length && i < states.length; i++) {
      const a = this.actors[i], s = states[i];
      a.far = ctx.cam ? Math.hypot(s.x - ctx.cam.x, s.z - ctx.cam.z) > CONFIG.render.animLodDistance && !s.action : false;
      a.visible = !s.hidden;
      if (!a.visible) { a.place(s.x, s.z, s.face); continue; }
      a.update(dt, s, ctx);
    }
  }
  handPos(i, out) { return this.actors[i].handPos(out, 'R'); }
  // Where a ball held in the right hand sits (in the palm / in the glove).
  ballHandPos(i, out) {
    const a = this.actors[i];
    a.handPos(out, 'R');
    if (a.keeper) out.y -= 0.02;
    return out;
  }
  glovesPos(i, out) {
    const a = this.actors[i];
    a.h.update();
    a.h.worldPos('handL', out);
    a.h.worldPos('handR', _p);
    return out.add(_p).multiplyScalar(0.5);
  }
}

// Non-striker at the bowler's end: leans on the bat, backs up as the ball is
// bowled, runs when runs are taken.
export class NonStrikerView {
  constructor(scene) {
    this.actor = new BatterActor(scene, { team: 'home', seed: 23 });
    this.home = new THREE.Vector3(-1.35, 0, -18.75);
    this.actor.place(this.home.x, this.home.z, 0);
    this.running = null;
    this.backing = 0;
    this.visible = false;
    this.show(false);
  }
  show(v) { this.visible = v; this.actor.visible = v; }
  setTeam(team) { this.actor.h.setTeam(team); }
  update(dt, t, opts = {}) {
    if (!this.visible) return;
    const a = this.actor;
    const ball = opts.ball || null;
    if (this.running) {
      a.pos.set(this.running.x, 0, this.running.z);
      a.speed = this.running.speed;
      a.turnToward(this.running.heading, dt, 9);
      if (this.running.dive) a.updateDive(dt, t, this.running.dive); else a.updateMoving(dt, t, ball, false);
      return;
    }
    // Back up during the run-up, drift back afterwards.
    const target = opts.backingUp ? 1.6 : 0;
    this.backing += clamp(target - this.backing, -dt * 1.2, dt * 1.3);
    const dz = this.home.z + this.backing - a.pos.z;
    a.speed = Math.abs(dz) > 0.02 ? Math.min(1.5, Math.abs(dz) / Math.max(dt, 1e-3)) : 0;
    a.pos.set(this.home.x, 0, this.home.z + this.backing);
    a.turnToward(0, dt, 4);
    if (a.speed > 0.3) a.updateMoving(dt, t, ball);
    else a.updateLeaning(dt, t, ball || _look.set(0, 1.0, -1));
  }
  reset() { this.running = null; this.backing = 0; this.actor.place(this.home.x, this.home.z, 0); }
  // Stand on the far side from the bowler's run-up (+1: bowler over the wicket on +X).
  setSide(side) { this.home.x = -1.35 * side; if (!this.running) this.actor.place(this.home.x, this.home.z + this.backing, 0); }
}

// Both batters running between the wickets. Progress p counts runs (1.0 =
// one completed run); the striker runs batting end → bowling end on even runs.
export class RunningController {
  constructor() { this.active = false; }
  start(hitT, strikerStart, nonStrikerStart) {
    const F = CONFIG.field;
    this.active = true;
    this.hitT = hitT;
    this.final = null;          // runs they will complete (once known)
    this.stopped = false;       // caught / boundary: they ease up
    this.p = 0;
    this.tStart = hitT + 0.35;
    this.firstDur = F.runFirst - 0.35;
    this.nextDur = F.runNext;
    this.sStart = strikerStart.clone();
    this.nStart = nonStrikerStart.clone();
    this.zBat = -0.85; this.zBowl = -19.25;
  }
  setFinal(runs) { if (this.final == null) this.final = runs; }
  stop() { this.stopped = true; }
  update(dt, t) {
    if (!this.active) return;
    let target;
    const el = t - this.tStart;
    if (el <= 0) target = 0;
    else if (el < this.firstDur) target = el / this.firstDur;
    else target = 1 + (el - this.firstDur) / this.nextDur;
    if (this.final != null) target = Math.min(target, this.final);
    if (this.stopped) target = (this.p % 1) >= 0.5 ? Math.ceil(this.p) : Math.floor(this.p);
    const prevP = this.p;
    // Turning back from an aborted run happens at running speed.
    const maxRate = 1 / this.nextDur;
    this.p += clamp(target - this.p, -maxRate * dt, maxRate * 1.25 * dt);
    this.rate = (this.p - prevP) / Math.max(dt, 1e-4);
  }
  // Position/heading for one batter. striker: started at the batting end.
  state(striker) {
    const p = Math.max(0, this.p);
    const leg = Math.floor(p), f = p - leg;
    const fromBat = striker ? leg % 2 === 0 : leg % 2 === 1;
    const z0 = fromBat ? this.zBat : this.zBowl, z1 = fromBat ? this.zBowl : this.zBat;
    const x = striker ? -0.85 : 0.85;
    const start = striker ? this.sStart : this.nStart;
    // First run starts from where they stood.
    let z = z0 + (z1 - z0) * sstep(0, 1, f) * 0.15 + (z1 - z0) * f * 0.85;
    let xx = x;
    if (leg === 0) { xx = start.x + (x - start.x) * sstep(0, 0.2, f); z = start.z + (z1 - start.z) * (sstep(0, 1, f) * 0.15 + f * 0.85); }
    const dirZ = Math.sign(z1 - z0) * Math.sign(this.rate || 1);
    const speed = Math.abs(this.rate || 0) * 18.4;
    return { x: xx, z, speed, heading: dirZ >= 0 ? 0 : Math.PI };
  }
  get settled() { return !this.active || (Math.abs(this.rate || 0) < 1e-3 && (this.final != null || this.stopped)); }
}

// The player's own body in desktop third-person views (hidden in VR).
export class PlayerBodyView {
  constructor(scene) {
    this.actor = new BatterActor(scene, { team: 'home', seed: 3 });
    this.actor.bat.visible = false;     // the real player bat mesh is drawn by the game
    this.reader = new ShotReader();
    this.log = [];
    this.visible = false;
    this.actor.visible = false;
  }
  // Re-pose the figure over [t0, t1] for a replay, now that the shot is known:
  // the same inputs (your head, your bat, the ball) as live, but the shot's
  // final type and the real contact time from the start of the swing, so the
  // replay shows one clean shot instead of the live first guess. write(t, h)
  // stores each pose. The live figure is put back as it was. Returns false if
  // there was no shot to re-play.
  resolve(t0, t1, write) {
    const fin = this.reader.cur;
    if (!fin || !fin.locked) return false;
    const A = this.actor, h = A.h;
    const saved = { snap: h.snapshot(), pos: A.pos.clone(), heading: A.heading, footL: A.footL.clone(), footR: A.footR.clone(),
      step: A.step ? { L: A.step.L.clone(), R: A.step.R.clone(), ax: A.step.ax, open: A.step.open, init: A.step.init, mL: A.step.mL && { ...A.step.mL, from: A.step.mL.from.clone() }, mR: A.step.mR && { ...A.step.mR, from: A.step.mR.from.clone() } } : null, handX: A.handX, ps: A._ps, root: h.root.position.clone(), rq: h.root.quaternion.clone() };
    const rd = new ShotReader();
    let any = false;
    // A stumping was judged in this clip: your back foot stays where it really was throughout.
    const pinned = this.log.some((e) => e.t >= t0 && e.t <= t1 && e.extra && e.extra.crease && e.extra.crease.pin > 0);
    for (const e of this.log) {
      if (e.t < t0 - 2 || e.t > t1) continue;
      _ax.set(0, 1, 0).applyQuaternion(e.bq);
      _sw.copy(e.bp).addScaledVector(_ax, -0.55);
      const c = rd.update(e.t, _sw, _ax, e.head ? e.head.p : null, e.extra);
      if (c && Math.abs(c.t0 - fin.t0) < 0.4) { c.cls = fin.cls; c.Tc = fin.Tc; c.hitT = fin.hitT; c.locked = true; any = true; }
      let hf = null;
      if (e.head) { _q.set(e.head.q.x, e.head.q.y, e.head.q.z, e.head.q.w); hf = _hf.set(0, 0, -1).applyQuaternion(_q); hf.y = 0; if (hf.lengthSq() < 1e-6) hf = null; else hf.normalize(); }
      const cr = e.extra && e.extra.crease;
      const crease = cr && cr.z != null ? { z: cr.z, pin: pinned ? 1 : cr.pin } : null;
      A.updateBatting(e.dt, e.bp, e.bq, { t: e.t, plan: null, ball: e.ball, head: e.head ? e.head.p : null, headFwd: hf, sweep: e.extra && e.extra.sweep, crease, shot: c });
      if (e.t >= t0) write(e.t, h);
    }
    // put the live figure back
    if (saved.step) { const S = A.step; S.L.copy(saved.step.L); S.R.copy(saved.step.R); S.ax = saved.step.ax; S.open = saved.step.open; S.init = saved.step.init; S.mL = saved.step.mL; S.mR = saved.step.mR; }
    A.pos.copy(saved.pos); A.heading = saved.heading; A.footL.copy(saved.footL); A.footR.copy(saved.footR); A.handX = saved.handX; A._ps = saved.ps;
    h.root.position.copy(saved.root); h.root.quaternion.copy(saved.rq);
    h.blendFrom(saved.snap, 0);
    h.update();
    return any;
  }

  show(v) { this.visible = v; this.actor.visible = v; this.actor.bat.visible = false; }
  // head: your headset pose {p, q} (VR), or null on a monitor. extra: { sweep }.
  update(dt, t, batPos, batQuat, ball, head = null, extra = null) {
    let hf = null;
    if (head) {
      _q.set(head.q.x, head.q.y, head.q.z, head.q.w);
      hf = _hf.set(0, 0, -1).applyQuaternion(_q); hf.y = 0;
      if (hf.lengthSq() < 1e-6) hf = null; else hf.normalize();
    }
    // your shot, read from the bat, your head and the delivery (src/render/playerShot.js)
    _ax.set(0, 1, 0).applyQuaternion(batQuat);
    _sw.copy(batPos).addScaledVector(_ax, -0.55);                 // the sweet spot
    const shot = this.reader.update(t, _sw, _ax, head ? head.p : null, extra);
    this.actor.updateBatting(dt, batPos, batQuat, { t, plan: null, ball, head: head ? head.p : null, headFwd: hf, sweep: extra && extra.sweep, crease: extra && extra.crease, shot });
    // what went in, for re-playing the shot in a replay once it is known
    const L = this.log;
    if (L.length && t < L[L.length - 1].t) L.length = 0;
    L.push({ t, dt, bp: batPos.clone(), bq: batQuat.clone(), head: head ? { p: { x: head.p.x, y: head.p.y, z: head.p.z }, q: { x: head.q.x, y: head.q.y, z: head.q.z, w: head.q.w } } : null, ball: ball ? ball.clone() : null, extra });
    while (L.length > 1200 || (L.length && t - L[0].t > 16)) L.shift();
    this.actor.bat.visible = false;
  }
}
