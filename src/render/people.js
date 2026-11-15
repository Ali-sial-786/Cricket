// Scene-level people: wires the animated actors to game state.
import * as THREE from 'three';
import { Pose } from '../physics/math.js';
import { FielderActor, BowlerActor, BatterActor } from './actors.js';
import { ShotReader } from './playerShot.js';
import { toV3, toQ } from './util.js';
import { sstep, clamp } from './anim.js';
import { CONFIG } from '../config.js';

// While the runner in your kit is this close to your head he is not drawn
// (you are looking out through his eyes as he sets off / comes home).
const RUNNER_HIDE = 1.5;
// An AI batter standing about keeps this far from your head.
const STAND_CLEAR = 1.4;

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _look = new THREE.Vector3(), _hf = new THREE.Vector3(), _ax = new THREE.Vector3(), _sw = new THREE.Vector3();

// AI striker: posed around the AIBatter's analytic bat; runs when runs are taken.
export class BatterView {
  constructor(scene, ai) {
    this.ai = ai;
    this.actor = new BatterActor(scene, { team: 'away', seed: 11 });
    this.pose = new Pose();
    this.show(false);
    this.running = null;   // {x, z, speed, heading} supplied by RunningController
    this.avoid = null;     // the player's head (world), when someone has set it
  }
  show(v) { this.shown = v; this.actor.visible = v; }
  setTeam(team) { this.actor.h.setTeam(team); }
  update(t, dt = 1 / 72, ball = null) {
    if (!this.shown) return;
    const a = this.actor;
    if (this.running) {
      a.pos.set(this.running.x, 0, this.running.z);
      // Your own runner is not drawn round your head.
      if (this.runnerOnly) a.visible = !(this.avoid && Math.hypot(a.pos.x - this.avoid.x, a.pos.z - this.avoid.z) < RUNNER_HIDE);
      if (!a.visible) return;
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
    this.keepBodiesApart(ctx.others);
  }
  // The logic keeps everyone's feet apart, but a pose can carry a body off its
  // spot (a dive's lunge, a stumping lunge): if that would put any part of the
  // posed body into someone else (taken as a standing trunk round the hips),
  // the lunge is shortened until it doesn't.
  keepBodiesApart(others = []) {
    const B = _bodies; B.length = 0;
    this.actors.forEach((a, i) => B.push(a.visible ? a.h.bones.hips.getWorldPosition(_hipsW[i] || (_hipsW[i] = new THREE.Vector3())) : _far));
    for (const o of others) B.push(o);
    this.actors.forEach((a, i) => {
      if (!a.visible) return;
      const r = a.h.root.position, ox = r.x - a.pos.x, oz = r.z - a.pos.z;
      if (ox * ox + oz * oz < 1e-4) return;
      a.h.update();
      const pts = BODY_PTS.map((n, j) => a.h.worldPos(n, _pts[j]));
      let k = 1;
      for (; k > 0; k -= 0.1) {
        const dx = ox * (k - 1), dz = oz * (k - 1);
        let hit = false;
        for (let j = 0; j < B.length && !hit; j++) {
          if (j === i && j < this.actors.length) continue;
          const b = B[j];
          for (const p of pts) if (p.y < 1.9 && Math.hypot(p.x + dx - b.x, p.z + dz - b.z) < BODY_GAP) { hit = true; break; }
        }
        if (!hit) break;
      }
      if (k < 1) {
        k = Math.max(0, k);
        r.x = a.pos.x + ox * k; r.z = a.pos.z + oz * k;
        a.h.root.updateMatrixWorld(true);
        a.h.syncShadow();
      }
    });
  }
  handPos(i, out) { return this.actors[i].handPos(out, 'R'); }
  // Where a ball held in the right hand sits (in the palm / in the glove).
  ballHandPos(i, out) {
    const a = this.actors[i];
    a.handPos(out, 'R');
    if (a.keeper) out.y -= 0.02;
    return out;
  }
  handsApart(i) {
    const a = this.actors[i];
    a.h.update();
    return a.h.worldPos('handL', _p).distanceTo(a.h.worldPos('handR', _hf));
  }
  glovesPos(i, out) {
    const a = this.actors[i];
    a.h.update();
    a.h.worldPos('handL', out);
    a.h.worldPos('handR', _p);
    return out.add(_p).multiplyScalar(0.5);
  }
}

const BODY_PTS = ['hips', 'chest', 'head', 'kneeL', 'kneeR', 'ankleL', 'ankleR', 'handL', 'handR'];
const _pts = BODY_PTS.map(() => new THREE.Vector3()), _bodies = [], _hipsW = [], _far = new THREE.Vector3(1e4, 0, 1e4);
const BODY_GAP = 0.32;       // any joint of a lunging body to another's trunk axis (trunk ~0.17 + limb ~0.1 + a little)

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
    this.avoid = null;                       // the player's head (world), when someone has set it
    this.side = new THREE.Vector3();         // stepped aside out of the player's way
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
    // Out of the player's way: if you are where he would stand he steps aside
    // (walking, not popping) to the edge of your space, and back when you go.
    const { x: ox, z: oz } = this.clearOffset();
    const sx = ox - this.side.x, sz = oz - this.side.z, sd = Math.hypot(sx, sz), step = 2.0 * dt;
    if (sd > step) { this.side.x += sx / sd * step; this.side.z += sz / sd * step; } else this.side.set(ox, 0, oz);
    const px = this.home.x + this.side.x, pz = this.home.z + this.backing + this.side.z;
    const dz = Math.hypot(px - a.pos.x, pz - a.pos.z);
    a.speed = dz > 0.02 ? Math.min(2.0, dz / Math.max(dt, 1e-3)) : 0;
    a.pos.set(px, 0, pz);
    a.turnToward(0, dt, 4);
    if (a.speed > 0.3) a.updateMoving(dt, t, ball);
    else a.updateLeaning(dt, t, ball || _look.set(0, 1.0, -1));
  }
  reset() {
    this.running = null; this.backing = 0;
    const o = this.clearOffset();
    this.side.set(o.x, 0, o.z);
    this.actor.place(this.home.x + o.x, this.home.z + o.z, 0);
  }
  // Offset from his mark that keeps him out of the player's space.
  clearOffset() {
    const hp = this.avoid, gx = this.home.x, gz = this.home.z + this.backing;
    if (!hp) return { x: 0, z: 0 };
    const dx = gx - hp.x, dz = gz - hp.z, d = Math.hypot(dx, dz);
    if (d >= STAND_CLEAR) return { x: 0, z: 0 };
    const ux = d > 1e-3 ? dx / d : (this.home.x >= hp.x ? 1 : -1), uz = d > 1e-3 ? dz / d : 0;
    return { x: hp.x + ux * STAND_CLEAR - gx, z: hp.z + uz * STAND_CLEAR - gz };
  }
  // Stand on the far side from the bowler's run-up (+1: bowler over the wicket on +X).
  setSide(side) { this.home.x = -1.35 * side; if (!this.running) { const o = this.clearOffset(); this.side.set(o.x, 0, o.z); this.actor.place(this.home.x + o.x, this.home.z + this.backing + o.z, 0); } }
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
    this.actor.stretchArms = true;      // your gloves are on your bat, always
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
    const job = this.resolveBegin(t0, t1);
    if (!job) return false;
    this.resolveStep(job, Infinity, write);
    this.resolveEnd(job);
    return true;
  }
  // The same in slices, so a replay can spread the work over its first frames
  // instead of stopping the picture for it: resolveBegin -> resolveStep (until
  // it returns true) -> resolveEnd. Between begin and end the figure is the
  // replay's, not the live one: only while play is frozen. job.t: the time of
  // the last pose made.
  resolveBegin(t0, t1) {
    const fin = this.reader.cur || this.reader.last;
    if (!fin || !fin.locked || fin.Tc < t0 - 0.5 || fin.t0 > t1) return null;
    const A = this.actor, h = A.h;
    const saved = { snap: h.snapshot(), pos: A.pos.clone(), heading: A.heading, footL: A.footL.clone(), footR: A.footR.clone(),
      step: A.step ? { L: A.step.L.clone(), R: A.step.R.clone(), ax: A.step.ax, open: A.step.open, init: A.step.init, mL: A.step.mL && { ...A.step.mL, from: A.step.mL.from.clone() }, mR: A.step.mR && { ...A.step.mR, from: A.step.mR.from.clone() } } : null, handX: A.handX, ps: A._ps, root: h.root.position.clone(), rq: h.root.quaternion.clone() };
    // The shot as it turned out, from the start of the swing (a shot only read
    // at the hit starts at the top of the backlift here, not where live joined it).
    const c = { ...fin, locked: true, t0: fin.late ? Math.max(fin.tTop, fin.Tc - 0.3) : Math.min(fin.t0, fin.Tc - 0.12) };
    // A stumping was judged in this clip: your back foot stays where it really was throughout.
    const pinned = this.log.some((e) => e.t >= t0 && e.t <= t1 && e.extra && e.extra.crease && e.extra.crease.pin > 0);
    A._ps = null;
    let i = 0;
    while (i < this.log.length && this.log[i].t < t0 - 2) i++;
    return { t0, t1, c, pinned, saved, i, t: -Infinity, done: false };
  }
  // Make up to `count` more poses; write(t, h) stores each one from t0 on. True when all are made.
  resolveStep(job, count, write) {
    const A = this.actor, h = A.h, c = job.c, L = this.log;
    for (let n = 0; n < count && !job.done; n++) {
      const e = L[job.i++];
      if (!e || e.t > job.t1) { job.done = true; break; }
      const shot = e.t >= c.t0 - 0.05 && e.t <= c.Tc + 2.5 ? c : null;
      let hf = null;
      if (e.head) { _q.set(e.head.q.x, e.head.q.y, e.head.q.z, e.head.q.w); hf = _hf.set(0, 0, -1).applyQuaternion(_q); hf.y = 0; if (hf.lengthSq() < 1e-6) hf = null; else hf.normalize(); }
      const cr = e.extra && e.extra.crease;
      const crease = cr && cr.z != null ? { z: cr.z, pin: job.pinned ? 1 : cr.pin } : null;
      A.updateBatting(e.dt, e.bp, e.bq, { t: e.t, plan: null, ball: e.ball, head: e.head ? e.head.p : null, headFwd: hf, sweep: e.extra && e.extra.sweep, crease, shot });
      job.t = e.t;
      if (e.t >= job.t0) write(e.t, h);
    }
    return job.done;
  }
  // Put the live figure back as it was.
  resolveEnd(job) {
    const A = this.actor, h = A.h, saved = job.saved;
    job.done = true;
    if (saved.step) { const S = A.step; S.L.copy(saved.step.L); S.R.copy(saved.step.R); S.ax = saved.step.ax; S.open = saved.step.open; S.init = saved.step.init; S.mL = saved.step.mL; S.mR = saved.step.mR; }
    A.pos.copy(saved.pos); A.heading = saved.heading; A.footL.copy(saved.footL); A.footR.copy(saved.footR); A.handX = saved.handX; A._ps = saved.ps;
    h.root.position.copy(saved.root); h.root.quaternion.copy(saved.rq);
    h.blendFrom(saved.snap, 0);
    h.update();
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
