// Animated cricketers built on Humanoid + the procedural animation library.
//   FielderActor  — walk-in, ready crouch, run (stride synced to speed),
//                   pick-up + throw, catch (incl. dives), celebrate, keeper takes
//   BowlerActor   — accelerating run-up, bound, side-on delivery stride, IK'd
//                   bowling arm that passes exactly through the release point,
//                   follow-through, walk back
//   BatterActor   — stance, trigger movement, front/back-foot footwork, torso
//                   rotation with the bat, hands IK'd to the bat handle, head
//                   tracking the ball, running between the wickets with the bat
import * as THREE from 'three';
import { Humanoid } from './humanoid.js';
import { buildBatMesh } from './objects.js';
import {
  poseIdle, poseLocomotion, plantFeet, poseReady, poseThrow, poseDive, posePickup,
  poseCelebrate, strideFor, keys, sstep, clamp, mix,
} from './anim.js';

const TAU = Math.PI * 2;
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _fwd = new THREE.Vector3(), _left = new THREE.Vector3();

function angDiff(a, b) { let d = b - a; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; }

export class Actor {
  constructor(scene, opts) {
    this.h = new Humanoid(opts);
    scene.add(this.h.root);
    this.pos = new THREE.Vector3();
    this.heading = 0;
    this.speed = 0;
    this.phase = Math.random() * TAU;
    this.visible = true;
  }
  set visible(v) { this._vis = v; if (this.h) this.h.visible = v; }
  get visible() { return this._vis; }
  place(x, z, heading = this.heading) { this.pos.set(x, 0, z); this.heading = heading; this.apply(); }
  turnToward(target, dt, rate = 8) {
    const d = angDiff(this.heading, target);
    this.heading += clamp(d, -rate * dt, rate * dt);
  }
  gait(dt) { this.phase = (this.phase + dt * TAU * this.speed / strideFor(this.speed)) % TAU; }
  apply(offX = 0, offZ = 0) {
    this.h.root.position.set(this.pos.x + offX, 0, this.pos.z + offZ);
    this.h.root.rotation.set(0, this.heading, 0);
  }
  // Local stance foot positions in world space (x = sideways, z = forward).
  footWorld(out, lx, lz) {
    const s = Math.sin(this.heading), c = Math.cos(this.heading);
    return out.set(this.h.root.position.x + lx * c + lz * s, 0, this.h.root.position.z - lx * s + lz * c);
  }
  forward(out) { return out.set(Math.sin(this.heading), 0, Math.cos(this.heading)); }
  handPos(out, side = 'R') {
    this.h.update();
    this.h.worldPos('hand' + side, out);
    return out.add(_d.set(0, -0.06 * this.h.root.scale.y, 0).applyQuaternion(this.h.bones['hand' + side].getWorldQuaternion(_q)));
  }
}

// ---------------------------------------------------------------- fielders
export class FielderActor extends Actor {
  constructor(scene, opts) {
    super(scene, opts);
    this.keeper = !!opts.keeper;
    this.ready = 0;
  }
  // s = logic state {x, z, face, speed, state, action, crouch, armsUp}; ctx = {t, ball, delivering}
  update(dt, s, ctx) {
    const h = this.h, t = ctx.t;
    this.pos.set(s.x, 0, s.z);
    this.speed = s.speed;
    this.turnToward(s.face, dt, this.speed > 1 ? 10 : 5);
    this.gait(dt);
    const wantReady = (s.state === 'set' || s.state === 'walkin' || s.state === 'ready') && ctx.delivering ? 1 : 0;
    this.ready += clamp(wantReady - this.ready, -dt * 3, dt * 4);
    let offX = 0, offZ = 0;
    h.reset();
    const act = s.action;
    const ta = act ? t - act.t0 : 0;
    if (act && act.type === 'catch' && act.dive && ta < 1.1) {
      const k = ta / 0.95;
      poseDive(h, k, act.side);
      const lunge = act.lunge * sstep(0, 0.32, k);
      offX = act.dir.x * lunge; offZ = act.dir.z * lunge;
      this.apply(offX, offZ);
      if (k < 0.45 && act.target) this.reachBoth(act.target, 0.6);
    } else if (act && act.type === 'pickup' && ta < act.dur + 0.05) {
      poseIdle(h, t, 1);
      posePickup(h, ta / act.dur);
      this.apply();
      this.plant(0.16, true);
      if (act.ball && ta < act.dur * 0.6) { h.update(); h.ikArm('R', act.ball, h.worldPos('shoulderR', _a).add(_b.set(0, -0.2, 0)).add(this.forward(_c).multiplyScalar(-0.3))); }
    } else if (act && act.type === 'throw' && ta < 0.9) {
      poseIdle(h, t, 1);
      poseThrow(h, ta / 0.75);
      this.apply();
    } else if (s.state === 'celebrate' || (act && act.type === 'catch' && act.success && ta > 0.45)) {
      if (this.speed > 0.3) poseLocomotion(h, this.phase, this.speed);
      poseCelebrate(h, t, sstep(0.3, 0.7, act ? ta : 1));
      this.apply();
    } else if (act && act.type === 'catch' && ta < 0.6) {
      poseIdle(h, t, 1);
      if (this.speed > 0.3) poseLocomotion(h, this.phase, this.speed);
      this.apply();
      if (act.target) this.reachBoth(act.target, 1);
      else if (ta > 0.15) this.handsToChest();
    } else if (act && act.type === 'keep' && ta < 1.2) {
      poseReady(h, this.keeper ? 0.6 * (1 - sstep(0.3, 1.0, ta)) : 0, true);
      this.apply();
      this.plant(0.24, true);
      if (act.target && ta < 0.4) this.reachBoth(act.target, 1);
      else this.handsToChest();
    } else if (this.speed > 0.25) {
      poseLocomotion(h, this.phase, this.speed, this.keeper ? 0.05 : 0);
      this.apply();
    } else {
      poseIdle(h, t, 1);
      if (this.ready > 0.01) poseReady(h, this.ready, this.keeper);
      this.apply();
      this.plant(this.keeper ? 0.24 : 0.15, true);
    }
    // Eyes on the ball while it is live (skipped for distant fielders).
    if (ctx.ball && !this.far) h.lookAt(ctx.ball, 0.9);
    h.syncShadow();
  }
  plant(halfWidth, flat) {
    if (this.far) return;                       // animation LOD: no foot IK far away
    this.footWorld(_a, halfWidth, 0.03);
    this.footWorld(_b, -halfWidth, -0.01);
    plantFeet(this.h, _a, _b, this.forward(_c).multiplyScalar(0.6));
    void flat;
  }
  reachBoth(target, amt) {
    const h = this.h;
    h.update();
    this.forward(_fwd);
    _left.set(_fwd.z, 0, -_fwd.x);                    // figure's left (+X local)
    const pole = h.worldPos('chest', _c).addScaledVector(_fwd, -0.4).add(_d.set(0, -0.6, 0));
    _a.copy(target).addScaledVector(_left, 0.045 * amt);
    h.ikArm('L', _a, _b.copy(pole).addScaledVector(_left, 0.6));
    _a.copy(target).addScaledVector(_left, -0.045 * amt);
    h.ikArm('R', _a, _b.copy(pole).addScaledVector(_left, -0.6));
  }
  handsToChest() {
    const h = this.h;
    h.update();
    const target = h.worldPos('chest', _c).addScaledVector(this.forward(_fwd), 0.28).add(_d.set(0, -0.05, 0));
    this.reachBoth(target, 0.6);
  }
}

// ---------------------------------------------------------------- bowler
export class BowlerActor extends Actor {
  constructor(scene, opts) {
    super(scene, { headgear: 'bare', ...opts });
    this.home = new THREE.Vector3(0.75, 0, -31);
    this.place(this.home.x, this.home.z, 0);
    this.run = null;
    this.snap = null;
    this.state = 'idle';
  }

  // Plan the run-up so the bowling hand passes through `releasePos` at
  // `t + duration`.
  startRunup(t, releasePos, kind = 'long') {
    const h = this.h;
    const dur = { long: 2.7, medium: 2.3, short: 1.6 }[kind] || 2.7;
    const vTop = { long: 6.4, medium: 5.2, short: 3.2 }[kind] || 6.4;
    const tr = t + dur;
    const L = 0.98;               // fraction of arm reach used (straight arm)
    const psiR = 0.22;            // release angle past vertical (rad)
    // Measure the shoulder at the release pose with the root at the origin.
    h.root.scale.setScalar(h.baseScale);
    this.heading = 0;
    this.pos.set(0, 0, 0);
    this.poseDelivery(0, null);
    this.apply();
    h.update();
    const S = h.worldPos('shoulderR', new THREE.Vector3());
    const E = h.worldPos('elbowR', new THREE.Vector3());
    const H = h.worldPos('handR', new THREE.Vector3());
    let arm = (S.distanceTo(E) + E.distanceTo(H) + 0.07) * L;
    const reachY = S.y + arm * Math.cos(psiR);
    const scale = clamp(releasePos.y / reachY, 0.94, 1.16);
    h.root.scale.setScalar(h.baseScale * scale);
    S.multiplyScalar(scale);
    arm *= scale;
    const rootR = new THREE.Vector3(releasePos.x - S.x, 0, releasePos.z - (S.z + arm * Math.sin(psiR)));
    // Speed profile → position table.
    const N = 240, prof = [];
    const vAt = (u) => {                       // u = time relative to release
      const tt = u + dur;
      if (u < -0.62) return vTop * sstep(0, Math.min(1.3, dur * 0.5), tt) + 0.6;
      if (u < 0) return mix(vTop, vTop * 0.53, sstep(-0.62, 0, u));
      return vTop * 0.53 * (1 - sstep(0, 0.9, u));
    };
    let z = 0;
    for (let i = 0; i <= N; i++) {
      const u = -dur + (i / N) * (dur + 1.2);
      prof.push({ u, z });
      z += vAt(u) * ((dur + 1.2) / N);
    }
    const zAtRelease = prof.find((p) => p.u >= 0).z;
    for (const p of prof) p.z += rootR.z - zAtRelease;
    this.run = { t0: t, tr, dur, prof, rootX: rootR.x, arm, psiR, released: false, vAt };
    this.pos.set(rootR.x, 0, prof[0].z);
    this.home.set(rootR.x, 0, prof[0].z);
    this.heading = 0;
    this.state = 'runup';
  }

  zAt(u) {
    const p = this.run.prof;
    const f = clamp((u + this.run.dur) / (this.run.dur + 1.2), 0, 1) * (p.length - 1);
    const i = Math.floor(f), k = f - i;
    return p[i].z + (p[Math.min(i + 1, p.length - 1)].z - p[i].z) * k;
  }

  // Delivery-stride pose (u = time relative to release, −0.62 … +0.9).
  poseDelivery(u, tgt) {
    const h = this.h;
    h.reset();
    h.bones.hips.position.y = h.hipsRest.y + keys([[-0.62, -0.04], [-0.5, 0.13], [-0.38, -0.02], [-0.2, -0.07], [0.1, -0.13], [0.5, -0.06], [0.9, 0]], u);
    h.rot('hips', 0, keys([[-0.62, 0], [-0.45, -0.95], [-0.2, -1.05], [0, -0.25], [0.3, 0.3], [0.9, 0]], u), 0);
    h.rot('spine', keys([[-0.62, 0.1], [-0.38, -0.14], [-0.15, -0.06], [0, 0.42], [0.25, 0.85], [0.6, 0.4], [0.9, 0.06]], u), 0, 0);
    h.rot('chest', 0, keys([[-0.62, 0], [-0.45, -0.45], [-0.2, -0.4], [0, 0.35], [0.3, 0.45], [0.9, 0]], u), 0);
    h.rot('hipL', keys([[-0.62, -0.3], [-0.5, -0.95], [-0.38, -1.15], [-0.2, -0.55], [0, -0.6], [0.25, -0.3], [0.6, 0.25], [0.9, 0]], u), 0, 0.05);
    h.rot('kneeL', keys([[-0.62, 0.6], [-0.5, 1.25], [-0.38, 0.7], [-0.2, 0.06], [0.1, 0.12], [0.4, 0.5], [0.9, 0.05]], u), 0, 0);
    h.rot('ankleL', keys([[-0.62, -0.2], [-0.38, 0.3], [-0.2, 0.45], [0.2, 0.4], [0.9, 0]], u), 0, 0);
    h.rot('hipR', keys([[-0.62, 0.45], [-0.5, -0.45], [-0.38, 0.12], [-0.2, 0.5], [0, 0.7], [0.25, 0.1], [0.5, -0.65], [0.9, 0]], u), 0, -0.05);
    h.rot('kneeR', keys([[-0.62, 0.9], [-0.5, 1.15], [-0.38, 0.35], [-0.2, 0.6], [0.1, 1.35], [0.4, 0.6], [0.9, 0.05]], u), 0, 0);
    h.rot('ankleR', keys([[-0.62, -0.2], [-0.38, 0.0], [0.1, -0.6], [0.9, 0]], u), 0, 0);
    h.rot('shoulderL', keys([[-0.62, -0.3], [-0.45, -2.6], [-0.2, -2.95], [0, -0.7], [0.3, 0.25], [0.9, 0.05]], u), 0,
      keys([[-0.62, 0.1], [-0.2, 0.18], [0.05, 0.65], [0.4, 0.3], [0.9, 0.08]], u));
    h.rot('elbowL', keys([[-0.62, -0.5], [-0.45, -0.2], [0, -0.9], [0.9, -0.2]], u), 0, 0);
    // Bowling arm (FK outside the IK window).
    h.rot('shoulderR', keys([[-0.62, -0.4], [-0.45, -0.7], [-0.3, 0.2], [-0.2, 0.64], [0.08, 4.45], [0.3, 5.6], [0.9, 6.15]], u), 0,
      keys([[-0.62, -0.1], [0.08, -0.05], [0.3, 0.45], [0.9, -0.05]], u));
    h.rot('elbowR', keys([[-0.62, -1.4], [-0.45, -1.8], [-0.3, -0.7], [-0.2, -0.05], [0.3, -0.15], [0.9, -0.2]], u), 0, 0);
    h.rot('neck', 0, keys([[-0.62, 0], [-0.45, 0.9], [-0.2, 1.0], [0, 0.2], [0.4, -0.2], [0.9, 0]], u) * 0.5, 0);
    h.rot('head', 0.05, keys([[-0.62, 0], [-0.45, 0.9], [-0.2, 1.0], [0, 0.2], [0.4, -0.2], [0.9, 0]], u) * 0.5, 0);
    void tgt;
  }

  bowlingArmIK(u) {
    const r = this.run, h = this.h;
    if (u < -0.2 || u > 0.08) return;
    const psi = u <= 0
      ? -2.5 + (r.psiR + 2.5) * sstep(-0.2, 0, u) * 0.6 + (r.psiR + 2.5) * 0.4 * ((u + 0.2) / 0.2)
      : r.psiR + (1.3 - r.psiR) * (u / 0.08);
    h.update();
    const S = h.worldPos('shoulderR', _a);
    const target = _b.set(S.x, S.y + r.arm * Math.cos(psi), S.z + r.arm * Math.sin(psi));
    const pole = _c.copy(S).add(_d.set(-0.6, -0.2, -0.3));
    h.ikArm('R', target, pole);
  }

  // Returns true on the frame of release.
  update(dt, t) {
    const h = this.h;
    if (this.state === 'runup' && this.run) {
      const r = this.run;
      let u = t - r.tr;
      let released = false;
      if (!r.released && u >= 0) { r.released = true; released = true; u = 0; }
      this.pos.set(r.rootX, 0, this.zAt(u));
      this.speed = r.vAt(u);
      this.heading = 0;
      this.gait(dt);
      if (u < -0.56) {
        h.reset();
        poseLocomotion(h, this.phase, this.speed);
        h.rot('elbowR', -1.6, 0, 0);                     // ball carried near the chest
        h.rot('shoulderR', -0.5 + 0.3 * Math.sin(this.phase), 0, -0.15);
        if (u > -0.68) {
          this.snap = h.snapshot(this.snap || undefined);
          this.poseDelivery(u, null);
          h.blendFrom(this.snap, sstep(-0.68, -0.56, u));
        }
        this.apply();
      } else {
        this.poseDelivery(u, null);
        this.apply();
        this.bowlingArmIK(u);
      }
      if (u > 0.9) { this.state = 'walkback'; }
      h.syncShadow();
      return released;
    }
    // Walk back to the top of the mark (or idle there).
    const dx = this.home.x - this.pos.x, dz = this.home.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    h.reset();
    if (this.state === 'walkback' && dist > 0.3) {
      this.speed = Math.min(2.4, this.speed + dt * 2);
      this.turnToward(Math.atan2(dx, dz), dt, 3);
      this.pos.x += (dx / dist) * this.speed * dt;
      this.pos.z += (dz / dist) * this.speed * dt;
      this.gait(dt);
      poseLocomotion(h, this.phase, this.speed);
    } else {
      this.state = 'idle';
      this.speed = 0;
      this.turnToward(0, dt, 3);
      poseIdle(h, t, 1);
    }
    this.apply();
    if (this.state === 'idle') {
      this.footWorld(_a, 0.13, 0.03); this.footWorld(_b, -0.13, 0);
      plantFeet(h, _a, _b, this.forward(_c).multiplyScalar(0.6));
    }
    h.syncShadow();
    return false;
  }

  holdingBall() { return this.state === 'runup' && this.run && !this.run.released; }
}

// ---------------------------------------------------------------- batters
const STANCE = { footL: [-0.31, -1.43], footR: [-0.35, -0.95] };

export class BatterActor extends Actor {
  constructor(scene, opts = {}) {
    super(scene, { headgear: 'helmet', pads: true, gloves: true, ...opts });
    this.bat = buildBatMesh();
    scene.add(this.bat);
    this.batPose = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
    this.footL = new THREE.Vector3(); this.footR = new THREE.Vector3();
    this.mode = 'bat';        // 'bat' (driven by a bat pose) | 'run' | 'idle'
    this.carryBat = false;
  }
  set visible(v) { this._vis = v; if (this.h) this.h.visible = v; if (this.bat) this.bat.visible = v; }
  get visible() { return this._vis; }

  // Batting: pose the body around a bat pose. opts: {plan, t, ball, crouch}
  updateBatting(dt, batPos, batQuat, opts) {
    const h = this.h, t = opts.t;
    this.mode = 'bat';
    this.bat.position.copy(batPos);
    this.bat.quaternion.copy(batQuat);
    // Footwork.
    const fl = _a.set(STANCE.footL[0], 0, STANCE.footL[1]);
    const fr = _b.set(STANCE.footR[0], 0, STANCE.footR[1]);
    let hipsDrop = 0.08, lean = 0.22;
    const p = opts.plan;
    if (p && t >= p.t0) {
      const trig = sstep(p.t0 + 0.05, p.t0 + 0.25, t);
      fr.x += 0.06 * trig; fr.z += 0.04 * trig;       // trigger: back and across
      const type = p.shot.type;
      if (p.C && type !== 'leave') {
        const k = sstep(p.tCommit, (p.Tc ?? p.tCommit + 0.3) - 0.05, t);
        if (p.foot === 'front') {
          fl.x = mix(fl.x, clamp(p.C.x - 0.17, -0.55, 0.45), k);
          fl.z = mix(fl.z, clamp(p.C.z + 0.38, -2.15, -1.35), k);
          fr.z = mix(fr.z, fr.z - 0.08, k);
          lean += 0.18 * k; hipsDrop += 0.06 * k;
        } else {
          fr.x = mix(fr.x, fr.x + 0.24, k);
          fr.z = mix(fr.z, -0.72, k);
          fl.x = mix(fl.x, fl.x + 0.12, k);
          fl.z = mix(fl.z, -1.2, k);
          lean -= 0.08 * k;
        }
      } else if (p.shot.duck) {
        const k = sstep(p.tCommit, p.tCommit + 0.2, t);
        hipsDrop += 0.38 * k; lean += 0.55 * k;
      }
    }
    this.footL.copy(fl); this.footR.copy(fr);
    this.pos.set((fl.x + fr.x) / 2, 0, (fl.z + fr.z) / 2);
    this.heading = Math.PI / 2;
    h.reset();
    h.bones.hips.position.y = h.hipsRest.y - hipsDrop;
    this.apply();
    // Rotate the torso toward where the hands are.
    h.update();
    const hipsW = h.worldPos('chest', _c);
    const dxw = batPos.x - hipsW.x, dzw = batPos.z - hipsW.z;
    const s = Math.sin(this.heading), c = Math.cos(this.heading);
    const lx = dxw * c - dzw * s, lz = dxw * s + dzw * c;      // into root local
    const yaw = clamp(Math.atan2(lx, Math.max(0.05, lz)), -1.2, 1.4);
    h.rot('hips', 0, yaw * 0.35, 0);
    h.rot('spine', lean, yaw * 0.25, 0);
    h.rot('chest', 0.08 + 0.018 * Math.sin(t * 1.6), yaw * 0.45, 0);
    plantFeet(h, this.footL, this.footR, this.forward(_d).multiplyScalar(0.7));
    this.gripBat(batPos, batQuat);
    if (opts.ball) h.lookAt(opts.ball, 1, 1.7);
    else h.lookAt(_c.set(0.4, 1.9, -18.8), 1, 1.7);
    h.syncShadow();
  }

  gripBat(batPos, batQuat) {
    const h = this.h;
    h.update();
    const up = _a.set(0, 1, 0).applyQuaternion(batQuat);
    const face = _b.set(0, 0, 1).applyQuaternion(batQuat);
    const bottom = _c.copy(batPos);
    const top = _d.copy(batPos).addScaledVector(up, 0.105);
    this.forward(_fwd);
    _left.set(_fwd.z, 0, -_fwd.x);
    const poleR = h.worldPos('shoulderR', new THREE.Vector3()).addScaledVector(_fwd, -0.35).add(new THREE.Vector3(0, -0.55, 0)).addScaledVector(face, -0.2);
    const poleL = h.worldPos('shoulderL', new THREE.Vector3()).addScaledVector(_left, 0.5).add(new THREE.Vector3(0, -0.45, 0));
    h.ikArm('R', bottom, poleR);
    h.ikArm('L', top, poleL);
    // Fists wrapped around the handle.
    _q.copy(batQuat).multiply(_gripRot);
    h.setWorldQuat('handR', _q);
    h.setWorldQuat('handL', _q);
  }

  // Generic locomotion (running between the wickets / walking), carrying the bat.
  updateMoving(dt, t, look = null, diving = false) {
    const h = this.h;
    this.mode = 'run';
    this.gait(dt);
    h.reset();
    if (this.speed > 0.2) poseLocomotion(h, this.phase, this.speed);
    else poseIdle(h, t, 1);
    this.apply();
    if (this.speed <= 0.2) {
      this.footWorld(_a, 0.14, 0.04); this.footWorld(_b, -0.14, 0);
      plantFeet(h, _a, _b, this.forward(_c).multiplyScalar(0.6));
    }
    if (diving) {                                  // full-length dive for the crease, bat stretched out
      h.bones.hips.position.y = h.hipsRest.y * 0.42;
      h.rot('spine', 1.15, 0, 0); h.rot('chest', 0.2, 0, 0); h.rot('neck', -0.7, 0, 0);
      h.rot('shoulderR', -2.7, 0, -0.1); h.rot('elbowR', -0.05, 0, 0); h.rot('shoulderL', -2.2, 0, 0.3);
      h.rot('hipL', 0.5, 0, 0.1); h.rot('hipR', 0.9, 0, -0.1); h.rot('kneeL', 0.3, 0, 0); h.rot('kneeR', 0.5, 0, 0);
      this.apply();
    }
    if (look && !diving) h.lookAt(look, 0.8);
    this.carry();
    h.syncShadow();
  }

  // Bat held in the right hand while running / standing.
  carry() {
    const h = this.h;
    h.update();
    const hand = h.bones.handR;
    hand.getWorldPosition(_a);
    hand.getWorldQuaternion(_q);
    this.bat.quaternion.copy(_q).multiply(_carryRot);
    this.bat.position.copy(_a).add(_b.set(0, -0.07, 0.02).applyQuaternion(_q));
  }

  // Non-striker style: bat grounded in front, leaning on it.
  updateLeaning(dt, t, look) {
    const h = this.h;
    this.mode = 'idle';
    h.reset();
    poseIdle(h, t, 1);
    this.apply();
    this.footWorld(_a, 0.13, 0.03); this.footWorld(_b, -0.13, -0.02);
    plantFeet(h, _a, _b, this.forward(_c).multiplyScalar(0.6));
    // Bat: toe grounded ~45 cm ahead to the right, handle up toward the hand.
    this.forward(_fwd);
    _left.set(_fwd.z, 0, -_fwd.x);
    const toe = _c.copy(this.h.root.position).addScaledVector(_fwd, 0.42).addScaledVector(_left, -0.18);
    toe.y = 0.0;
    const handle = _d.copy(toe).addScaledVector(_fwd, -0.18).add(_e.set(0, 0.72, 0));
    const dir = _e.subVectors(handle, toe).normalize();
    _q.setFromUnitVectors(_up, dir);
    this.bat.quaternion.copy(_q);
    // bat origin (grip point) sits 0.72 above the toe along the bat axis
    this.bat.position.copy(toe).addScaledVector(dir, 0.72);
    h.update();
    const poleR = h.worldPos('shoulderR', new THREE.Vector3()).add(new THREE.Vector3(0, -0.5, 0)).addScaledVector(_left, -0.4);
    h.ikArm('R', this.bat.position, poleR);
    if (look) h.lookAt(look, 0.8);
    h.syncShadow();
  }
}
const _e = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const _gripRot = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
const _carryRot = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2 + 0.3, 0, 0));
