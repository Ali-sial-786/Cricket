// Scene-level people: wires the animated actors to game state.
import * as THREE from 'three';
import { Pose } from '../physics/math.js';
import { FielderActor, BowlerActor, BatterActor } from './actors.js';
import { poseEvery } from './humanoid.js';
import { toV3, toQ } from './util.js';
import { sstep, clamp, hyp } from './anim.js';
import { CONFIG } from '../config.js';
import { walkTask, stepWalk, fadeNearHead, bendAround, FIELD_CLEAR, MERGE_BACK } from './crew.js';
import { live, lastCrowd, joyAt } from './gestures.js';

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
  // The AI's swing is timed off his read of the ball. Misread badly, the bat
  // would still be at the top of the backlift as the ball hits the stumps, the
  // downswing coming afterwards. Drawn instead: the same swing slid in time so
  // that it comes through just early or late (SWING_LEFT) as the ball arrives
  // -- played and missed. Only the picture: the bat the physics sees is the
  // AI's own (a swing that far out cannot touch the ball either way), and once
  // the ball has hit anything (its run down the pitch reverses) the re-timing
  // goes. The arrival is read off the ball itself, frame by frame.
  swingTime(t, p, ball, dt) {
    const W = this._warp || (this._warp = { t0: null, z: 0, tz: 0, ok: false, tArr: null, S: 0, off: false, fade: 1 });
    if (W.t0 !== p.t0) { W.t0 = p.t0; W.ok = false; W.tArr = null; W.S = 0; W.off = false; W.fade = 1; }
    const Tc = p.TcTo ?? p.Tc, zc = p.C ? p.C.z : -1.6;
    if (ball && !W.off) {
      if (W.ok && t > W.tz + 1e-4) {
        const vz = (ball.z - W.z) / (t - W.tz);
        if (vz < -1 && W.tArr != null) W.off = true;                        // (off the bat or the pad)
        else if (vz > 5 && ball.z < zc && (W.tArr == null || t < W.tArr - 0.12)) W.tArr = t + (zc - ball.z) / vz;
      }
      W.z = ball.z; W.tz = t; W.ok = true;
    }
    let S = 0;
    if (W.tArr != null) { const E = Tc - W.tArr; if (Math.abs(E) > SWING_FAR) S = clamp(E - Math.sign(E) * SWING_LEFT, -0.4, 0.4); }
    W.S += clamp(S - W.S, -1.5 * dt, 1.5 * dt);
    if (W.off) W.fade = Math.max(0, W.fade - dt / 0.25);
    const tA = W.tArr ?? Tc, Tf = p.Tf || 0.2;
    const w = sstep(p.t0 + 0.04, Math.max(p.t0 + 0.2, tA - 0.15), t) * (1 - sstep(Tc + Tf + 0.4, Tc + Tf + 1.1, t)) * W.fade;
    return t + W.S * w;
  }
  update(t, dt = 1 / 72, ball = null) {
    if (!this.shown) return;
    const a = this.actor;
    // Walking somewhere between balls (crew.js): to take guard, or into you.
    if (a.task) {
      const k = a.task;
      // (from his stance into the walk: cross-faded from the pose he was in, bat and all)
      if (this.wasBat) { a.handover(); this.wasBat = false; a.rebase(a.h.root.position.x, a.h.root.position.z); }
      if (this._roff) { this._roff.x = this._roff.z = 0; this._roff.side = 0; }      // (his step aside is in his place now)
      if (this._bend) this._bend.on = false;
      if (k.kind === 'merge' && this.avoid) {
        // (not into you: out to your side -- the side he is on -- and a little back, where you are not
        // looking; chosen once, so he does not swap sides as you turn)
        const F = this.avoidFwd, fx = F ? F.x : 0, fz = F ? F.z : -1, M = this._mt || (this._mt = { x: 0, z: 0 });
        if (k.side == null) k.side = (-fz * (a.pos.x - this.avoid.x) + fx * (a.pos.z - this.avoid.z)) >= 0 ? 1 : -1;
        M.x = this.avoid.x - fz * k.side * MERGE_BACK - fx * 0.4; M.z = this.avoid.z + fx * k.side * MERGE_BACK - fz * 0.4;
        k.to = M; k.tol = 0.3;
      }
      const there = stepWalk(a, dt, this.obstacles(a));
      let fade = 1;
      if (k.kind === 'merge') {
        // There (behind you): gone in a quarter of a second. Nearer your head than he should be
        // (you stepped into him): the last-resort fade by distance, short.
        if (k.to && hyp(a.pos.x - k.to.x, a.pos.z - k.to.z) < 0.4) k.gone = true;
        const was = a.h.fade ?? 1;
        fade = Math.min(k.gone ? was - dt / 0.25 : Math.min(1, was + 4 * dt), this.avoid ? fadeNearHead(hyp(a.pos.x - this.avoid.x, a.pos.z - this.avoid.z)) : 1);
        if (fade <= 0.01) { a.task = null; a.h.setFade(0); this.show(false); return; }
      } else if (k.kind === 'in') fade = sstep(0, 0.9, k.age);
      a.h.setFade(fade);
      a.h.replayVisible = fade > 0.5;
      a.updateMoving(dt, t, ball);
      this.wasBat = false;
      if (there && k.kind !== 'merge') { this.justIn = k.kind === 'in'; a.task = null; a.h.setFade(1); if (!this.runnerOnly) this.blend = { snap: a.h.snapshot(), p: a.bat.position.clone(), q: a.bat.quaternion.clone(), t: 0 }; }
      return;
    }
    if (this.running) {
      // (from the shot into the run: cross-faded from the pose he was in, bat and all)
      let rx = null, rz = null;
      if (this.wasBat) { a.handover(); this.wasBat = false; rx = a.h.root.position.x; rz = a.h.root.position.z; }
      this.blend = null;
      a.pos.set(this.running.x, 0, this.running.z);
      // Your own runner leaves from you and comes back to you, but never through your head: his lane is
      // drawn bent round it (the run itself is the logic's), and pulled up at your end he walks on out to
      // your side -- the place he would go to to become you (crew.js: the 'merge' walk starts from there).
      runRound(this, a, dt, this.runnerOnly ? MERGE_BACK : NS_ASIDE, this.runnerOnly ? 0.4 : 0.5);
      if (rx != null) a.rebase(rx, rz);          // (the run starts under his pelvis: the body stays where the shot left it)
      // (he fades in as he leaves you; the fade by distance is only a last resort now)
      let fade = this.runnerOnly && this.avoid ? fadeNearHead(hyp(a.pos.x - this.avoid.x, a.pos.z - this.avoid.z)) : 1;
      const was = a.h.fade ?? 1;
      fade = clamp(fade, was - 4 * dt, was + 4 * dt);
      a.h.setFade(fade);
      a.h.replayVisible = fade > 0.5;
      a.speed = this.running.speed;
      a.turnToward(this.running.heading, dt, this.running.moving ? 7 : 4.5);
      if (this.running.dive) a.updateDive(dt, t, this.running.dive); else a.updateMoving(dt, t, ball, false, 0, joyAt(t));
      return;
    }
    if (this.runnerOnly) { a.h.setFade(0); return; }       // (your runner with nowhere to go: not drawn)
    // (a ceremony has him where he is -- the result's batters meeting: standing there, not back in his stance)
    if (this.hold) { a.h.setFade(1); a.h.replayVisible = true; a.speed = 0; a.updateMoving(dt, t, null, false, 0, joyAt(t)); this.wasBat = false; return; }
    a.h.setFade(1);
    a.h.replayVisible = true;
    // His side has won (the result): out of his stance, bat and arms up.
    const joy = joyAt(t);
    if (joy > 0.001) {
      if (this.wasBat) { a.handover(); a.slowNext = 0.35; this.wasBat = false; }
      this.blend = null; this.relaxed = true; a.speed = 0;
      a.updateMoving(dt, t, null, false, 0, joy);
      return;
    }
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
    const plan = this.ai.plan;
    // (a swing that is going to miss by a long way is drawn re-timed: see swingTime)
    const tr = plan && plan.shot.type !== 'leave' && plan.Tc != null && !(plan.adv > 0) ? this.swingTime(t, plan, ball, dt) : t;
    this.ai.poseAt(tr, this.pose);
    toV3(_p, this.pose.p);
    toQ(_q, this.pose.q);
    // Waiting for the bowler: not a statue. Now and then a few taps of the bat
    // behind his back foot (the bat turned about his hands), until the bowler
    // gathers to bowl and he picks it up (AIBatter.setReady). Drawn only: the
    // ball is nowhere near yet.
    const ready = this.ai.tReady;
    const wag = (!plan || t > plan.tPass + 1.5) ? 1 - (ready != null && t > ready - 0.4 ? sstep(ready - 0.4, ready - 0.1, t) : 0) : 0;
    if (wag > 0.001) {
      const T = t + 2.3, u = T % 3.4;
      const a = u < 1.3 ? 0.13 * Math.max(0, Math.sin(u * Math.PI * 2.3)) * sstep(0, 0.15, u) * (1 - sstep(1.1, 1.3, u)) : 0;
      if (a > 1e-4) { _ax.set(1, 0, 0); _q.premultiply(_wq.setFromAxisAngle(_ax, -a * wag)); }
    }
    if (plan) {
      this._plan = this._plan || {}; Object.assign(this._plan, plan); this._plan.Tc = plan.TcTo ?? plan.Tc;
      // how he leaves it (actors.js batProcedural): swaying out of a short one's way, a late
      // withdrawal from one close to off stump (now and then), or shouldering arms
      const I = plan.info, sh = plan.shot;
      this._plan.leaveKind = sh.type !== 'leave' || !I ? null : sh.duck ? (I.yb < 1.7 && (plan.t0 * 5.17) % 1 < 0.5 ? 'sway' : null) : I.yb > 1.15 ? 'sway'
        : I.xb > 0.05 && I.xb < 0.42 && (plan.t0 * 7.31) % 1 < 0.6 ? 'late' : 'shoulder';
      // the late one: the bat drawn as starting down toward the ball and pulled back up (only
      // in the picture, while the ball is still well short of him: the bat the physics sees is the AI's)
      // shouldering arms: the bat drawn higher and further back over his shoulder than the AI
      // holds it (only ever further from the ball's line), the shoulders turning after it
      const lk = this._plan.leaveKind;
      if (lk === 'shoulder' || lk === 'late') {
        const w = sstep(plan.tCommit + 0.05, plan.tCommit + 0.4, tr) * (1 - sstep(plan.tPass + 0.4, plan.tPass + 1.1, tr));
        if (w > 0.001) { _p.y += 0.16 * w; _p.z += 0.18 * w; _p.x -= 0.05 * w; _ax.set(1, 0, 0); _q.premultiply(_wq.setFromAxisAngle(_ax, -0.35 * w)); }
      }
      if (lk === 'late') {
        const u = tr - plan.tCommit, w = u > 0 && u < 0.45 ? 0.75 * Math.sin(Math.PI * u / 0.45) : 0;
        if (w > 0.001) { _p.y -= 0.3 * w; _p.x += 0.08 * w; _ax.set(0, 0, 1); _q.premultiply(_wq.setFromAxisAngle(_ax, -0.9 * w)); }
      }
    }
    // He has just walked in: the bat comes round from where he carried it and
    // the body settles into the stance over a few tenths.
    const B = this.blend;
    let w = 1;
    if (B) { B.t += dt; w = sstep(0, 0.45, B.t); _p.lerpVectors(B.p, _p, w); _q.copy(B.q).slerp(toQ(_bq, this.pose.q), w); }
    a.updateBatting(dt, _p, _q, { t: tr, plan: plan ? this._plan : null, adv: this.ai.advanceAt(tr), ball });
    if (B) {
      if (w >= 1) this.blend = null;
      else { a.h.blendFrom(B.snap, w); a.h.update(); a.h.clearFoot('L'); a.h.clearFoot('R'); a.h.syncShadow(); }
    }
    this.wasBat = true;
  }
}
const _bq = new THREE.Quaternion(), _look2 = new THREE.Vector3(), _wq = new THREE.Quaternion();
// Re-timing a swing that misses by a mile (BatterView.swingTime): only when the plan's contact
// is more than SWING_FAR s from when the ball really gets there; it is then drawn SWING_LEFT s early / late.
const SWING_FAR = 0.07, SWING_LEFT = 0.045;
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
      a.far = ctx.cam ? (s.x - ctx.cam.x) ** 2 + (s.z - ctx.cam.z) ** 2 > CONFIG.render.animLodDistance ** 2 && !s.action : false;
      a.visible = !s.hidden;
      if (!a.visible) { a.place(s.x, s.z, s.face); continue; }
      // (a far, calm man: his pose made every 2nd / 3rd frame, a frame or two ahead, and shown between; ANIM_LOD)
      const div = poseEvery(a.h.root.position, a.calm(s, ctx)), tk = a.lodNext(div, i, ctx.t, dt);
      if (div > 1) a.lodFrame(dt, s, ctx, tk, _lctx);
      else { a.move(dt, s, ctx); a.pose(a._lod.was ? Math.max(1e-4, ctx.t - a._poseT) : dt, s, ctx, dt); }
    }
    this.keepBodiesApart(ctx.others);
  }
  // The logic keeps everyone's feet apart, but a pose can carry a body off its
  // spot (a dive's lunge, a stumping lunge): if that would put any part of the
  // posed body into someone else (taken as a standing trunk round the hips),
  // the lunge is shortened until it doesn't.
  keepBodiesApart(others = NO_OBS) {
    const B = _bodies, A = this.actors; B.length = 0;
    for (let i = 0; i < A.length; i++) B.push(A[i].visible ? A[i].h.bones.hips.getWorldPosition(_hipsW[i] || (_hipsW[i] = new THREE.Vector3())) : _far);
    for (let j = 0; j < others.length; j++) B.push(others[j]);
    for (let i = 0; i < A.length; i++) {
      const a = A[i];
      if (!a.visible) continue;
      const r = a.h.root.position, ox = r.x - a.pos.x, oz = r.z - a.pos.z;
      if (ox * ox + oz * oz < 1e-4) continue;
      a.h.update();
      for (let j = 0; j < BODY_PTS.length; j++) a.h.worldPos(BODY_PTS[j], _pts[j]);
      let k = 1;
      for (; k > 0; k -= 0.1) {
        const dx = ox * (k - 1), dz = oz * (k - 1);
        let hit = false;
        for (let j = 0; j < B.length && !hit; j++) {
          if (j === i && j < A.length) continue;
          const b = B[j];
          for (let n = 0; n < _pts.length; n++) { const p = _pts[n]; if (p.y < 1.9 && hyp(p.x + dx - b.x, p.z + dz - b.z) < BODY_GAP) { hit = true; break; } }
        }
        if (!hit) break;
      }
      if (k < 1) {
        k = Math.max(0, k);
        r.x = a.pos.x + ox * k; r.z = a.pos.z + oz * k;
        a.h.root.updateMatrixWorld(true);
        a.h.syncShadow();
      }
    }
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

const _lctx = { t: 0, ball: null, delivering: false, cam: null, others: null };
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
// A batter pulled up near your head after a run (the run itself leaves him at the edge of
// your space): he walks on, at a walk, out to your side -- the side he is on, lat m across
// and back m behind you -- instead of standing in your face while the run is sorted out.
// v._roff: his kept offset from where the run has him; eased back off once he runs again.
// (v.running is the run's state for this frame, its own object: its speed and heading are
// set to the walk's for the drawing)
const STEP_NEAR = 3.0, NS_ASIDE = 2.15;
// A running batter's drawn place (v: his view, v.avoid your head): his run, its lane bent round you
// (crew.js bendAround), then, pulled up near you, his walk on out to your side; he faces the way the
// drawn path goes, so the bend is run, not slid. Nothing made per frame.
function runRound(v, a, dt, lat, back) {
  const r = v.running, e = v.avoid, B = v._bend || (v._bend = { x: 0, z: 0, px: 0, pz: 0, on: false });
  if (!e) { B.on = false; return; }
  const ux = Math.sin(r.heading), uz = Math.cos(r.heading), sx = a.pos.x >= e.x ? 1 : -1;
  bendAround(a.pos.x, a.pos.z, ux, uz, e, FIELD_CLEAR, B, -uz * sx >= 0 ? 1 : -1);
  a.pos.x = B.x; a.pos.z = B.z;
  if (!r.dive) stepAside(v, a, dt, lat, back);
  const dx = a.pos.x - B.px, dz = a.pos.z - B.pz, d = hyp(dx, dz);
  if (B.on && r.speed > 0.3 && d > 0.2 * r.speed * dt) r.heading = Math.atan2(dx, dz);
  B.px = a.pos.x; B.pz = a.pos.z; B.on = true;
}
function stepAside(v, a, dt, lat, back) {
  const O = v._roff || (v._roff = { x: 0, z: 0, side: 0 }), F = v.avoidFwd, fx = F ? F.x : 0, fz = F ? F.z : -1, hx = v.avoid.x, hz = v.avoid.z;
  if (v.running.speed < 0.4 && (O.side || hyp(a.pos.x - hx, a.pos.z - hz) < STEP_NEAR)) {
    if (!O.side) O.side = (-fz * (a.pos.x - hx) + fx * (a.pos.z - hz)) >= 0 ? 1 : -1;
    const tx = hx - fz * O.side * lat - fx * back - a.pos.x, tz = hz + fx * O.side * lat - fz * back - a.pos.z;
    const ex = tx - O.x, ez = tz - O.z, d = hyp(ex, ez), st = 1.5 * dt;
    if (d > st) { O.x += ex / d * st; O.z += ez / d * st; v.running.speed = 1.5; v.running.heading = Math.atan2(ex, ez); } else { O.x = tx; O.z = tz; }
  } else { O.side = 0; const d = hyp(O.x, O.z), st = 3 * dt; if (d > st) { O.x -= O.x / d * st; O.z -= O.z / d * st; } else O.x = O.z = 0; }
  a.pos.x += O.x; a.pos.z += O.z;
}

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
      // (his lane bent round your head; run in to your end and pulled up there: on out to your side)
      runRound(this, a, dt, NS_ASIDE, 0.5);
      a.speed = this.running.speed;
      a.turnToward(this.running.heading, dt, this.running.moving ? 7 : 4.5);
      if (this.running.dive) a.updateDive(dt, t, this.running.dive); else a.updateMoving(dt, t, ball, false, 0, joyAt(t));
      this.moving = true;
      return;
    }
    if (this._roff) this._roff.x = this._roff.z = this._roff.side = 0;      // (his step aside is in his place now)
    if (this._bend) this._bend.on = false;
    // Backing up: a few steps down the pitch as the ball is bowled.
    const backing = !!opts.backingUp && !a.task;
    if (backing) this.backing = Math.min(NS_BACKUP, this.backing + dt * 1.5);
    else this.backing = 0;
    // Out of the player's way: if you are where he would stand he stands at the edge of your space.
    const o = this.clearOffset();
    this.side.set(o.x, 0, o.z);
    const G = this.goal;
    G.x = this.home.x + o.x; G.z = this.home.z + o.z;
    let look = ball || opts.watch || _look.set(0.5, 1.3, -30);
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
    const d = hyp(G.x - a.pos.x, G.z - a.pos.z);
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
    a.turnToward(this.hold && this.holdFace != null ? this.holdFace : this.restFace(), dt, 3);
    a.h.setFade(1); a.h.replayVisible = true;
    // (with the ball dead: now and then a few taps of the bat at his crease, a look round instead of at the bowler)
    let tap = 0;
    if (!ball) {
      const T = t + 4.1, slot = Math.floor(T / 7), u = T - slot * 7, r = (Math.sin(slot * 12.9898) * 43758.5453) % 1;
      if (Math.abs(r) < 0.45 && u < 1.6) tap = Math.abs(Math.sin(u * 8)) * sstep(0, 0.2, u) * (1 - sstep(1.3, 1.6, u));
      else if (Math.abs(r) > 0.75 && u < 2.4) look = _look2.set(this.home.x * 12, 1.4, -8);
    }
    const joy = joyAt(t);
    if (joy > 0.001 || this.hold) a.updateMoving(dt, t, null, false, 0, joy);     // (his side has won: off his bat, arms and bat up; a ceremony: standing, bat carried)
    else a.updateLeaning(dt, t, look, tap);
    this.moving = false;
  }
  // He walks to his mark (task: one he already has, e.g. coming in from the gate).
  walkHome(task = null) {
    const a = this.actor, o = this.clearOffset();
    this.running = null; this.backing = 0;
    this.goal.x = this.home.x + o.x; this.goal.z = this.home.z + o.z;
    if (task) { task.to = this.goal; task.face = this.restFace(); a.task = task; }
    else if (hyp(this.goal.x - a.pos.x, this.goal.z - a.pos.z) > 0.12) a.task = walkTask(this.goal, this.restFace(), { speed: hyp(this.goal.x - a.pos.x, this.goal.z - a.pos.z) > 6 ? 3.4 : 1.7 });
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
    const dx = gx - hp.x, dz = gz - hp.z, d = hyp(dx, dz);
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
