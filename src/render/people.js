// Scene-level people: wires the animated actors to game state.
import * as THREE from 'three';
import { Pose } from '../physics/math.js';
import { FielderActor, BowlerActor, BatterActor } from './actors.js';
import { toV3, toQ } from './util.js';
import { sstep, clamp } from './anim.js';
import { CONFIG } from '../config.js';
import { walkTask, stepWalk, fadeNearHead } from './crew.js';
import { live, lastCrowd } from './gestures.js';

// The runner in your kit is not drawn close to your head (you are looking out
// through his eyes as he sets off / comes home): he fades in as he leaves you
// and out as he comes back (crew.js FADE_NEAR / FADE_FAR), never in one frame.
// An AI batter standing about keeps this far from your head.
const STAND_CLEAR = 1.4;
const NO_OBS = [];

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _look = new THREE.Vector3(), _hf = new THREE.Vector3(), _ax = new THREE.Vector3(), _sw = new THREE.Vector3();

// AI striker: posed around the AIBatter's analytic bat; runs when runs are taken.
// When you bat (runnerOnly) the same view is the runner in your kit.
export class BatterView {
  constructor(scene, ai) {
    this.ai = ai;
    this.actor = new BatterActor(scene, { team: 'away', seed: 11 });
    this.pose = new Pose();
    this.show(false);
    this.running = null;   // {x, z, speed, heading} supplied by the running logic
    this.avoid = null;     // the player's head (world), when someone has set it
    this.crew = null;      // BatterCrew (who walks where between balls)
    this.blend = null;     // walking in -> taking guard
    this.wasBat = false;
  }
  // (your runner starts out not drawn: he fades in as he leaves you)
  show(v) { if (v && !this.shown && this.runnerOnly) this.actor.h.setFade(0); this.shown = v; this.actor.visible = v; if (!v) this.actor.h.replayVisible = false; }
  setTeam(team) { this.actor.h.setTeam(team); }
  obstacles(a) { return this.crew ? this.crew.obstacles(a) : NO_OBS; }
  update(t, dt = 1 / 72, ball = null) {
    if (!this.shown) return;
    const a = this.actor;
    // Walking somewhere between balls (crew.js): to take guard, or into you.
    if (a.task) {
      const k = a.task;
      // (from his stance into the walk: cross-faded from the pose he was in, bat and all)
      if (this.wasBat) { a.handover(); this.wasBat = false; a.rebase(a.h.root.position.x, a.h.root.position.z); }
      if (k.kind === 'merge' && this.avoid) k.to = this.avoid;
      const there = stepWalk(a, dt, this.obstacles(a));
      let fade = 1;
      if (k.kind === 'merge') {
        // (he may already be close to you when he turns into "you": the fade still takes its time)
        fade = Math.max(fadeNearHead(Math.hypot(a.pos.x - k.to.x, a.pos.z - k.to.z)), (a.h.fade ?? 1) - 2.5 * dt);
        if (fade <= 0.01) { a.task = null; a.h.setFade(0); this.show(false); return; }
      } else if (k.kind === 'in') fade = sstep(0, 0.9, k.age);
      a.h.setFade(fade);
      a.h.replayVisible = fade > 0.5;
      a.updateMoving(dt, t, ball);
      this.wasBat = false;
      if (there) { this.justIn = k.kind === 'in'; a.task = null; a.h.setFade(1); if (!this.runnerOnly) this.blend = { snap: a.h.snapshot(), p: a.bat.position.clone(), q: a.bat.quaternion.clone(), t: 0 }; }
      return;
    }
    if (this.running) {
      // (from the shot into the run: cross-faded from the pose he was in, bat and all)
      let rx = null, rz = null;
      if (this.wasBat) { a.handover(); this.wasBat = false; rx = a.h.root.position.x; rz = a.h.root.position.z; }
      this.blend = null;
      a.pos.set(this.running.x, 0, this.running.z);
      if (rx != null) a.rebase(rx, rz);          // (the run starts under his pelvis: the body stays where the shot left it)
      // Your own runner is not drawn round your head: he fades as he leaves / rejoins you.
      let fade = this.runnerOnly && this.avoid ? fadeNearHead(Math.hypot(a.pos.x - this.avoid.x, a.pos.z - this.avoid.z)) : 1;
      const was = a.h.fade ?? 1;
      fade = clamp(fade, was - 4 * dt, was + 4 * dt);
      a.h.setFade(fade);
      a.h.replayVisible = fade > 0.5;
      a.speed = this.running.speed;
      a.turnToward(this.running.heading, dt, this.running.moving ? 7 : 4.5);
      if (this.running.dive) a.updateDive(dt, t, this.running.dive); else a.updateMoving(dt, t, ball, false);
      return;
    }
    if (this.runnerOnly) { a.h.setFade(0); return; }       // (your runner with nowhere to go: not drawn)
    a.h.setFade(1);
    a.h.replayVisible = true;
    // Between balls he does not stand frozen in his stance: he straightens up,
    // half turns toward the bowler's end, leans on his bat, taps the pitch with
    // it now and then and looks round the field; he settles back into his
    // stance (cross-faded, bat and all) when the next ball is coming.
    if (this.between) {
      if (!this.relaxed) {
        // (out of the stance, or in from his walk to the crease: cross-faded, taking its time)
        a.handover(); a.slowNext = 0.6; if (a._batFrom) a._batFrom.dur = 0.7;
        this.wasBat = false; this.relaxT = 0;
        // what he does first: a new man takes guard; after a play-and-miss a look back and a practice
        // shot; after a boundary a twirl of the bat (and a fist pump, actors.js)
        const recent = t - lastCrowd.t < 4;
        this.routine = this.justIn ? 'guard' : recent && (lastCrowd.kind === 'beaten' || lastCrowd.kind === 'miss') ? 'beaten'
          : recent && (lastCrowd.kind === 'boundaryAgainst' || lastCrowd.kind === 'four' || lastCrowd.kind === 'six') ? 'boundary' : null;
        this.justIn = false;
      }
      this.blend = null;
      this.relaxT = (this.relaxT || 0) + dt;
      a.speed = 0;
      const R = this.routine, T0 = this.relaxT, O = _ro;
      O.upright = 0; O.shadow = 0; O.shadowW = 0; O.twirl = 0;
      let tap = 0, look = null;
      a.turnToward(R === 'guard' ? Math.PI / 2 + 1.2 : RELAX_FACE, dt, 0.9);
      if (R === 'guard' && T0 < ROUTINE_END) {
        // bat held up straight to the umpire for his guard, then scratching his mark on the crease
        O.upright = sstep(0.2, 0.7, T0) * (1 - sstep(1.6, 2.0, T0));
        look = T0 < 1.8 ? _look.set(-0.9, 1.6, -22) : _look.set(-0.3, 0, -1.25);
        tap = T0 > 1.9 ? Math.abs(Math.sin(T0 * 9)) * sstep(1.9, 2.1, T0) * (1 - sstep(3.0, 3.3, T0)) : 0;
      } else if (R === 'beaten' && T0 < ROUTINE_END) {
        // a rueful look back at the keeper, then the shot he should have played
        look = T0 < 1.3 ? _look.set(0.2, 1.0, 3) : _look.set(0.3, 0.2, -3);
        O.shadowW = sstep(1.1, 1.5, T0) * (1 - sstep(2.8, 3.2, T0));
        O.shadow = 0.5 - 0.5 * Math.cos(Math.max(0, T0 - 1.1) * Math.PI * 1.6);
      } else if (R === 'boundary' && T0 < ROUTINE_END) {
        O.twirl = TAU2 * 2 * sstep(0.3, 1.3, T0);
        look = _look.set(...LOOKS[0]);
      }
      const T = (R && T0 < ROUTINE_END ? 0 : T0 - (R ? ROUTINE_END : 0)) + 1.3, slot = Math.floor(T / 2.6) % LOOKS.length;
      if (!look) { look = _look.set(...LOOKS[slot]); tap = slot === 3 ? Math.max(0, Math.sin(T * 7.5)) * sstep(0, 0.3, T % 2.6) * (1 - sstep(2.2, 2.6, T % 2.6)) : 0; }
      a.updateLeaning(dt, t, look, tap, O);
      this.relaxed = true;
      return;
    }
    if (this.relaxed) {
      // back into his stance from the way he was standing
      this.relaxed = false;
      this.blend = { snap: a.h.snapshot(), p: a.bat.position.clone(), q: a.bat.quaternion.clone(), t: 0 };
    }
    this.ai.poseAt(t, this.pose);
    toV3(_p, this.pose.p);
    toQ(_q, this.pose.q);
    const plan = this.ai.plan;
    if (plan) { this._plan = this._plan || {}; Object.assign(this._plan, plan); this._plan.Tc = plan.TcTo ?? plan.Tc; }
    // He has just walked in: the bat comes round from where he carried it and
    // the body settles into the stance over a few tenths.
    const B = this.blend;
    let w = 1;
    if (B) { B.t += dt; w = sstep(0, 0.45, B.t); _p.lerpVectors(B.p, _p, w); _q.copy(B.q).slerp(toQ(_bq, this.pose.q), w); }
    a.updateBatting(dt, _p, _q, { t, plan: plan ? this._plan : null, adv: this.ai.advanceAt(t), ball });
    if (B) {
      if (w >= 1) this.blend = null;
      else { a.h.blendFrom(B.snap, w); a.h.update(); a.h.clearFoot('L'); a.h.clearFoot('R'); a.h.syncShadow(); }
    }
    this.wasBat = true;
  }
}
const _bq = new THREE.Quaternion();
// The striker relaxing between balls: half turned toward the bowler's end; where he looks
// (the bowler walking back, square leg, the off side, the pitch in front of him while he taps it).
const RELAX_FACE = Math.PI / 2 + 0.55;
const ROUTINE_END = 3.4, TAU2 = Math.PI * 2;
const _ro = { upright: 0, shadow: 0, shadowW: 0, twirl: 0 };
const LOOKS = [[0.5, 1.5, -26], [-22, 1.2, -1], [20, 1.2, -6], [-0.2, 0, -2.2]];

// AI bowler wrapper (keeps the session API).
export class BowlerView {
  constructor(scene) {
    this.actor = new BowlerActor(scene, { team: 'away', seed: 5, headgear: 'bare' });
    this.actor.h.lodNear = 21;         // (the man you face: full detail through his bound and delivery)
    this.fig = this.actor.h.root;      // for visibility toggling elsewhere
    this.show(false);
  }
  show(v) { this.actor.visible = v; }
  setTeam(team) { this.actor.h.setTeam(team); }
  startRunup(t, releasePos, kind) { this.actor.startRunup(t, releasePos, kind); }
  // The next ball's run-up: he walks to the top of it and turns; atMark(): he is there.
  setMark(releasePos, kind) { this.actor.setMark(releasePos, kind); }
  atMark() { return !this.actor.visible || this.actor.atMark(); }
  hurry() { this.actor.hurry = true; }
  placeAtMark() { this.actor.placeAtMark(); }
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
      vary: !f.keeper && !f.bowler,          // (heights differ; not the keeper's or the bowler's, whose figures are matched elsewhere)
    }));
    for (let i = 0; i < field.length; i++) this.actors[i].place(field[i].x, field[i].z, Math.atan2(-field[i].x, -1 - field[i].z));
    this.show(false);
  }
  show(v) { this.visible = v; for (const a of this.actors) a.visible = v; }
  setTeam(team) { for (const a of this.actors) a.h.setTeam(team); }
  // states from Fielding.states(); ctx = {t, ball (THREE.Vector3|null), delivering}
  update(dt, states, ctx) {
    live.ball = ctx.ball || null;                // (the AI bowler watches it too)
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
  // Everyone stood where the logic has him now, standing still (a skip to the next ball, in the dark).
  placeAll(states) {
    for (let i = 0; i < this.actors.length && i < states.length; i++) {
      const a = this.actors[i], s = states[i];
      a.cut(); a.speed = 0; a.ready = 0;
      a.place(s.x, s.z, s.face);
      if (this.visible) a.visible = !s.hidden;
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

// Non-striker at the bowler's end: stands side-on at his crease leaning on
// the bat and watching the bowler, backs up as the ball is bowled, runs when
// runs are taken. He is never put anywhere: whenever he is away from where he
// should stand (after running, the bowler changing sides of the wicket, you
// standing on his spot) he walks there, and the next ball waits for him.
const NS_Z = -19.0;          // just behind the popping crease (bat grounded in his ground)
const NS_BACKUP = 1.5;       // m he walks down the pitch as the ball is bowled
export class NonStrikerView {
  constructor(scene) {
    this.actor = new BatterActor(scene, { team: 'home', seed: 23 });
    this.home = new THREE.Vector3(-1.35, 0, NS_Z);
    this.actor.place(this.home.x, this.home.z, this.restFace());
    this.running = null;
    this.backing = 0;
    this.visible = false;
    this.moving = false;                     // on his way somewhere (not yet settled for the next ball)
    this.avoid = null;                       // the player's head (world), when someone has set it
    this.side = new THREE.Vector3();         // stepped aside out of the player's way
    this.crew = null;
    this.goal = { x: this.home.x, z: this.home.z };
    this.show(false);
  }
  show(v) { this.visible = v; this.actor.visible = v; if (!v) this.actor.h.replayVisible = false; }
  setTeam(team) { this.actor.h.setTeam(team); }
  // Side-on, chest toward the pitch and opened a little down it; his head turns to the bowler.
  restFace() { return (this.home.x <= 0 ? 1 : -1) * (Math.PI / 2 - 0.5); }
  obstacles(a) { return this.crew ? this.crew.obstacles(a) : NO_OBS; }
  update(dt, t, opts = {}) {
    if (!this.visible) return;
    const a = this.actor;
    const ball = opts.ball || null;
    if (this.running) {
      a.task = null;
      a.h.setFade(1); a.h.replayVisible = true;
      a.pos.set(this.running.x, 0, this.running.z);
      a.speed = this.running.speed;
      a.turnToward(this.running.heading, dt, this.running.moving ? 7 : 4.5);
      if (this.running.dive) a.updateDive(dt, t, this.running.dive); else a.updateMoving(dt, t, ball, false);
      this.moving = true;
      return;
    }
    // Backing up: a few steps down the pitch as the ball is bowled.
    const backing = !!opts.backingUp && !a.task;
    if (backing) this.backing = Math.min(NS_BACKUP, this.backing + dt * 1.5);
    else this.backing = 0;
    // Out of the player's way: if you are where he would stand he stands at the edge of your space.
    const o = this.clearOffset();
    this.side.set(o.x, 0, o.z);
    const G = this.goal;
    G.x = this.home.x + o.x; G.z = this.home.z + o.z;
    const look = ball || opts.watch || _look.set(0.5, 1.3, -30);
    if (backing) {
      // facing down the pitch, walking forward
      const pz = this.home.z + o.z + this.backing, dz = pz - a.pos.z;
      a.speed = Math.abs(dz) > 0.005 ? Math.min(1.6, Math.abs(dz) / Math.max(dt, 1e-3)) : 0;
      a.pos.z += clamp(dz, -1.6 * dt, 1.6 * dt);
      a.pos.x += clamp(G.x - a.pos.x, -1.0 * dt, 1.0 * dt);
      a.turnToward(0, dt, 4);
      a.h.setFade(1); a.h.replayVisible = true;
      if (a.speed > 0.3) a.updateMoving(dt, t, ball); else a.updateLeaning(dt, t, look);
      this.moving = false;
      return;
    }
    const d = Math.hypot(G.x - a.pos.x, G.z - a.pos.z);
    if (!a.task && d > 0.12) a.task = walkTask(G, this.restFace(), { speed: d > 6 ? 3.4 : 1.7 });
    if (a.task) {
      const k = a.task;
      k.to = G; k.face = this.restFace();
      const there = stepWalk(a, dt, this.obstacles(a));
      const fade = k.kind === 'in' ? sstep(0, 0.9, k.age) : 1;
      a.h.setFade(fade); a.h.replayVisible = fade > 0.5;
      a.updateMoving(dt, t, ball);
      if (there) { a.task = null; a.h.setFade(1); }
      this.moving = !there;
      return;
    }
    a.speed = 0;
    a.turnToward(this.restFace(), dt, 3);
    a.h.setFade(1); a.h.replayVisible = true;
    a.updateLeaning(dt, t, look);
    this.moving = false;
  }
  // He walks to his mark (task: one he already has, e.g. coming in from the gate).
  walkHome(task = null) {
    const a = this.actor, o = this.clearOffset();
    this.running = null; this.backing = 0;
    this.goal.x = this.home.x + o.x; this.goal.z = this.home.z + o.z;
    if (task) { task.to = this.goal; task.face = this.restFace(); a.task = task; }
    else if (Math.hypot(this.goal.x - a.pos.x, this.goal.z - a.pos.z) > 0.12) a.task = walkTask(this.goal, this.restFace(), { speed: Math.hypot(this.goal.x - a.pos.x, this.goal.z - a.pos.z) > 6 ? 3.4 : 1.7 });
    this.moving = !!a.task;
  }
  // Stood on his mark at once: only when nobody can see it (a session starting or ending, a skip to the next ball).
  reset() {
    this.running = null; this.backing = 0; this.moving = false;
    const o = this.clearOffset();
    this.side.set(o.x, 0, o.z);
    this.actor.task = null;
    this.actor.h.setFade(1);
    this.actor.cut();
    this.actor.speed = 0;
    this.actor.place(this.home.x + o.x, this.home.z + o.z, this.restFace());
  }
  // Offset from his mark that keeps him out of the player's space.
  clearOffset() {
    const hp = this.avoid, gx = this.home.x, gz = this.home.z;
    if (!hp) return { x: 0, z: 0 };
    const dx = gx - hp.x, dz = gz - hp.z, d = Math.hypot(dx, dz);
    if (d >= STAND_CLEAR) return { x: 0, z: 0 };
    const ux = d > 1e-3 ? dx / d : (this.home.x >= hp.x ? 1 : -1), uz = d > 1e-3 ? dz / d : 0;
    return { x: hp.x + ux * STAND_CLEAR - gx, z: hp.z + uz * STAND_CLEAR - gz };
  }
  // Stand on the far side from the bowler's run-up (+1: bowler over the wicket on +X): he walks across.
  setSide(side) { this.home.x = -Math.abs(this.home.x) * side; }
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

// Your own body when you bat lives in playerBody.js.
export { PlayerBodyView } from './playerBody.js';
