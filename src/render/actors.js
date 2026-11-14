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
const _reach = new THREE.Vector3();
const _fwd = new THREE.Vector3(), _left = new THREE.Vector3();

function copySnap(src, out = { q: [], hipsY: 0, hipsP: new THREE.Vector3() }) {
  src.q.forEach((q, i) => { (out.q[i] ||= new THREE.Quaternion()).copy(q); });
  out.hipsP.copy(src.hipsP);
  return out;
}

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
  // No snapping between poses: if any joint jumped further this frame than a
  // body can move, blend over 0.18 s from where it was. Call after posing.
  // allow = false only records the pose (e.g. while a hand must hit an exact point).
  smooth(dt, dur = 0.18, allow = true) {
    const h = this.h;
    const raw = this._raw;
    if (!allow) this._from = null;
    else if (raw && dt > 0) {
      let jump = 0;
      h.boneList.forEach((b, i) => { const d = b.quaternion.angleTo(raw.q[i]); if (d > jump) jump = d; });
      if (jump > Math.max(0.7, 25 * dt)) { this._from = copySnap(this._shown || raw, this._from || undefined); this._bt = 0; }
    }
    this._raw = h.snapshot(this._raw);
    if (this._from) {
      this._bt += dt;
      const w = sstep(0, 1, this._bt / dur);
      if (w >= 1) this._from = null; else { h.blendFrom(this._from, w); h.update(); }
    }
    this._shown = h.snapshot(this._shown);
  }

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
    } else if (act && act.type === 'break') {
      // Stumping: lunge in and sweep the gloves (ball in the right) into the bails.
      const at = act.at, k = sstep(at - 0.3, at - 0.06, t), back = sstep(at + 0.25, at + 0.8, t);
      poseReady(h, 0.65 * (1 - back * 0.7), true);
      const sx = act.stumps.x - this.pos.x, sz = act.stumps.z - this.pos.z, sd = Math.max(1e-3, Math.hypot(sx, sz));
      const lunge = Math.max(0, sd - 0.42) * k * (1 - back);
      this.heading = Math.atan2(sx, sz);
      this.apply(sx / sd * lunge, sz / sd * lunge);
      this.plant(0.26, true);
      const reach = k * (1 - back);
      if (reach > 0.02) { _e.copy(act.stumps); _e.y += 0.04; this.reachBoth(_e, 1); }
      else this.handsToChest();
    } else if (act && act.type === 'take') {
      // Taking a throw over the stumps (keeper or the bowler's-end fielder),
      // then the bails off if it's a run-out chance.
      poseReady(h, this.keeper ? 0.35 : 0.2, this.keeper);
      this.apply();
      this.plant(0.22, true);
      const b = act.breakAt;
      const sweep = b != null ? sstep(b - 0.14, b, t) * (1 - sstep(b + 0.2, b + 0.6, t)) : 0;
      if (sweep > 0.02) { _e.copy(act.stumps); _e.y += 0.04; this.reachBoth(_e, 1); }
      else if (ta < 0.4 && act.target) this.reachBoth(act.target, 1);
      else this.handsToChest();
    } else if (act && act.type === 'keep' && (act.hold || ta < 1.2)) {
      // Gathered: up out of the crouch, ball held in the gloves at the chest.
      poseReady(h, this.keeper ? 0.6 * (1 - sstep(0.3, 1.0, ta)) : 0, true);
      this.apply();
      this.plant(0.24, true);
      if (act.target && ta < 0.4) this.reachBoth(act.target, 1);
      else this.handsToChest();
    } else if (this.speed > 0.25) {
      poseLocomotion(h, this.phase, this.speed, this.keeper ? 0.05 : 0);
      this.apply();
    } else {
      poseIdle(h, t + this.phase * 3, 1);
      if (this.ready > 0.01) poseReady(h, this.ready, this.keeper);
      this.apply();
      this.plant(this.keeper ? 0.24 : 0.15, true);
    }
    // Eyes on the ball while it is live (skipped for distant fielders).
    if (ctx.ball && !this.far) h.lookAt(ctx.ball, 0.9);
    if (!this.far) this.smooth(dt);
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
    target = _reach.copy(target);
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
    // (Own vector: reachBoth() reuses the shared temporaries for the elbow pole.)
    const target = h.worldPos('chest', _hold).addScaledVector(this.forward(_fwd), 0.3).add(_d.set(0, -0.08, 0));
    this.reachBoth(target, 0.6);
  }
}

// ---------------------------------------------------------------- bowler
// Delivery actions keyed on u = time relative to release (s). Two styles:
//   pace — leaping bound, side-on back-foot landing, long stride onto a braced
//          front leg, front arm pulled down, the trunk flexing laterally (so the
//          bowling shoulder rides high) then forward through the ball, and a
//          long, decelerating run-off away from the pitch.
//   spin — a little hop, more open, a short stride onto the front foot, a tall,
//          slower arm, then a pivot over the front foot with the back leg coming
//          round, the arm finishing across the body and a couple of steps.
// feet: planted steps [side, land u, lift u, x, z (m, ahead of the root where it
// lands), toe yaw]; the legs are IK'd to them so nothing slides.
const BOWL = {
  pace: {
    hipsY: [[-0.62, -0.04], [-0.5, 0.12], [-0.38, -0.03], [-0.14, -0.08], [0, -0.01], [0.16, -0.06], [0.32, -0.12], [0.55, -0.07], [0.9, -0.04]],
    hipsYaw: [[-0.62, 0], [-0.45, -0.95], [-0.2, -1.05], [0, -0.25], [0.3, 0.35], [0.9, 0.05]],
    spine: [[-0.62, 0.1], [-0.38, -0.16], [-0.14, -0.04], [0, 0.22], [0.22, 0.8], [0.55, 0.45], [0.9, 0.14]],
    roll: [[-0.62, 0], [-0.3, 0.05], [-0.1, -0.12], [0, -0.3], [0.2, -0.1], [0.5, 0]],
    chest: [[-0.62, 0], [-0.45, -0.45], [-0.2, -0.4], [0, 0.35], [0.3, 0.45], [0.9, 0.05]],
    hipL: [[-0.62, -0.3], [-0.5, -0.95], [-0.38, -1.15], [-0.2, -0.6], [0, -0.35], [0.25, 0.1], [0.6, 0.3], [0.9, 0]],
    kneeL: [[-0.62, 0.6], [-0.5, 1.25], [-0.38, 0.7], [-0.2, 0.06], [0.1, 0.1], [0.4, 0.5], [0.9, 0.3]],
    hipR: [[-0.62, 0.45], [-0.5, -0.45], [-0.38, 0.12], [-0.2, 0.5], [0, 0.7], [0.2, 0.1], [0.42, -0.55], [0.9, 0]],
    kneeR: [[-0.62, 0.9], [-0.5, 1.15], [-0.38, 0.35], [-0.2, 0.6], [0.1, 1.35], [0.3, 0.9], [0.42, 0.25], [0.9, 0.2]],
    shL: [[-0.62, -0.3], [-0.45, -2.6], [-0.2, -2.95], [0, -0.75], [0.3, 0.3], [0.9, 0.1]],
    shLz: [[-0.62, 0.1], [-0.2, 0.18], [0.05, 0.22], [0.4, 0.12], [0.9, 0.1]],
    elL: [[-0.62, -0.5], [-0.45, -0.2], [-0.15, -0.3], [0.05, -1.5], [0.4, -1.3], [0.9, -0.6]],
    shR: [[-0.62, -0.4], [-0.5, -0.7], [-0.38, 0.0], [-0.3, 0.6], [-0.2, 0.9], [0.08, 4.45], [0.16, 4.75], [0.3, 5.6], [0.9, 6.25]],
    shRz: [[-0.62, -0.1], [0.08, -0.05], [0.3, 0.45], [0.9, 0.05]],
    elR: [[-0.62, -1.4], [-0.5, -1.8], [-0.38, -0.9], [-0.3, -0.15], [0.3, -0.15], [0.9, -0.4]],
    // Straight-arm circle round the shoulder (psi from vertical, + toward the batter).
    arm: { u0: -0.34, u1: 0.16, psi0: -2.75, pw: 1.5, w: 13, wd: 25, psiR: 0.22 },
    feet: [['R', -0.38, -0.13, -0.04, 0.02, -1.4], ['L', -0.14, 0.33, -0.1, 0.42, -0.15], ['R', 0.42, 0.72, 0.0, 0.32, 0.15]],
    ft: 0.9, post: 0.45, gaitAt: 0.55, decel: 1.1,
  },
  spin: {
    hipsY: [[-0.62, -0.03], [-0.48, 0.07], [-0.36, -0.03], [-0.16, -0.06], [0, 0.0], [0.18, -0.05], [0.4, -0.08], [0.75, -0.03]],
    hipsYaw: [[-0.62, 0], [-0.45, -0.75], [-0.2, -0.85], [0, -0.15], [0.25, 0.5], [0.5, 0.75], [0.75, 0.4]],
    spine: [[-0.62, 0.08], [-0.36, -0.05], [-0.15, 0.0], [0, 0.14], [0.22, 0.5], [0.5, 0.35], [0.75, 0.1]],
    roll: [[-0.62, 0], [-0.3, 0.04], [-0.1, -0.1], [0, -0.22], [0.25, -0.05], [0.5, 0]],
    chest: [[-0.62, 0], [-0.45, -0.35], [-0.2, -0.3], [0, 0.25], [0.3, 0.45], [0.75, 0.15]],
    hipL: [[-0.62, -0.3], [-0.5, -0.75], [-0.36, -0.85], [-0.2, -0.45], [0, -0.3], [0.3, 0.1], [0.75, 0]],
    kneeL: [[-0.62, 0.5], [-0.5, 0.95], [-0.36, 0.5], [-0.2, 0.12], [0.1, 0.12], [0.35, 0.3], [0.75, 0.1]],
    hipR: [[-0.62, 0.35], [-0.5, -0.3], [-0.36, 0.1], [-0.2, 0.35], [0, 0.5], [0.18, 0.0], [0.38, -0.5], [0.75, 0]],
    kneeR: [[-0.62, 0.8], [-0.5, 0.9], [-0.36, 0.3], [-0.2, 0.45], [0.1, 1.05], [0.28, 0.85], [0.4, 0.2], [0.75, 0.1]],
    shL: [[-0.62, -0.55], [-0.45, -2.3], [-0.2, -2.65], [0, -1.0], [0.3, 0.05], [0.75, 0.1]],
    shLz: [[-0.62, -0.15], [-0.45, 0.1], [-0.2, 0.15], [0.05, 0.2], [0.4, 0.1], [0.75, 0.1]],
    elL: [[-0.62, -1.6], [-0.45, -0.4], [-0.15, -0.3], [0.05, -1.4], [0.4, -1.1], [0.75, -0.5]],
    shR: [[-0.62, -0.55], [-0.48, -0.9], [-0.38, -0.2], [-0.3, 0.5], [-0.2, 0.8], [0.08, 4.35], [0.18, 4.8], [0.35, 5.5], [0.75, 6.2]],
    shRz: [[-0.62, 0.15], [-0.48, 0.0], [0.08, -0.05], [0.35, 0.65], [0.75, 0.1]],
    elR: [[-0.62, -1.7], [-0.48, -1.9], [-0.38, -1.0], [-0.3, -0.2], [0.3, -0.35], [0.75, -0.4]],
    arm: { u0: -0.36, u1: 0.18, psi0: -2.6, pw: 1.4, w: 10.5, wd: 15, psiR: 0.12 },
    feet: [['R', -0.36, -0.15, -0.03, 0.02, -1.05], ['L', -0.16, 0.36, -0.08, 0.32, -0.25], ['R', 0.4, 0.75, 0.05, 0.28, 0.3]],
    ft: 0.75, post: 0.6, gaitAt: 0.5, decel: 1.2,
  },
};
const BALL_OFF = 0.06;                  // ball centre beyond the wrist joint (model units; see Actor.handPos)
const _gaze = new THREE.Vector3(0, 0.7, 0);
const _T = new THREE.Vector3(), _W = new THREE.Vector3(), _pl = new THREE.Vector3(), _q2 = new THREE.Quaternion();

export class BowlerActor extends Actor {
  constructor(scene, opts) {
    super(scene, { headgear: 'bare', ...opts });
    this.home = new THREE.Vector3(0.75, 0, -31);
    this.place(this.home.x, this.home.z, 0);
    this.run = null;
    this.snap = null;
    this.style = BOWL.pace;
    this.side = 1;
    this.state = 'idle';
  }

  // Plan the run-up so the ball in the bowling hand passes through `releasePos`
  // at `t + duration`. kind: 'long' | 'medium' (seamers / quicks) | 'short' (spinners).
  startRunup(t, releasePos, kind = 'long') {
    const h = this.h;
    const st = this.style = kind === 'short' ? BOWL.spin : BOWL.pace;
    const dur = { long: 2.7, medium: 2.3, short: 1.7 }[kind] || 2.7;
    const vTop = { long: 6.4, medium: 5.2, short: 3.3 }[kind] || 6.4;
    const tr = t + dur;
    const psiR = st.arm.psiR;
    // Measure the shoulder at the release pose with the root at the origin.
    this.run = null;
    h.root.scale.setScalar(h.baseScale);
    this.heading = 0;
    this.pos.set(0, 0, 0);
    this.poseDelivery(0);
    this.apply();
    h.update();
    const S = h.worldPos('shoulderR', new THREE.Vector3());
    const E = h.worldPos('elbowR', new THREE.Vector3());
    const H = h.worldPos('handR', new THREE.Vector3());
    // Shoulder → ball with an (almost) straight arm, at the base scale.
    const reach1 = 0.985 * (S.distanceTo(E) + E.distanceTo(H)) + BALL_OFF * h.baseScale;
    const reachY = S.y + reach1 * Math.cos(psiR);
    const scale = clamp(releasePos.y / reachY, 0.92, 1.12);
    // Anything still out of reach: up onto the toes of the braced front leg.
    const lift = clamp(releasePos.y - reachY * scale, 0, 0.12);
    h.root.scale.setScalar(h.baseScale * scale);
    const reach = reach1 * scale;
    const rootX = releasePos.x - S.x * scale;
    const rootZ = releasePos.z - (S.z * scale + reach * Math.sin(psiR));
    // Speed profile → position table.
    const N = 240, prof = [];
    const vAt = (u) => {                       // u = time relative to release
      const tt = u + dur;
      if (u < -0.62) return vTop * sstep(0, Math.min(1.3, dur * 0.5), tt) + 0.6;
      if (u < 0) return mix(vTop, vTop * 0.53, sstep(-0.62, 0, u));
      return vTop * 0.53 * (1 - st.post * sstep(0, st.ft, u));
    };
    let z = 0;
    for (let i = 0; i <= N; i++) {
      const u = -dur + (i / N) * (dur + 1.2);
      prof.push({ u, z });
      z += vAt(u) * ((dur + 1.2) / N);
    }
    this.run = { t0: t, tr, dur, prof, rootX, reach, lift: lift / (h.baseScale * scale), released: false, vAt, gait: false };
    const z0 = this.zAt(0);
    for (const p of prof) p.z += rootZ - z0;
    this.side = releasePos.x < 0 ? -1 : 1;
    this.pos.set(rootX, 0, prof[0].z);
    this.home.set(rootX, 0, prof[0].z);
    this.heading = 0;
    this.state = 'runup';
  }

  zAt(u) {
    const p = this.run.prof;
    const f = clamp((u + this.run.dur) / (this.run.dur + 1.2), 0, 1) * (p.length - 1);
    const i = Math.floor(f), k = f - i;
    return p[i].z + (p[Math.min(i + 1, p.length - 1)].z - p[i].z) * k;
  }

  // Delivery-stride pose (u = time relative to release, −0.62 … ft).
  poseDelivery(u) {
    const h = this.h, B = this.style;
    h.reset();
    h.bones.hips.position.y = h.hipsRest.y + keys(B.hipsY, u) + (this.run ? this.run.lift * keys(LIFT, u) : 0);
    h.rot('hips', 0, keys(B.hipsYaw, u), 0);
    h.rot('spine', keys(B.spine, u), 0, keys(B.roll, u));
    h.rot('chest', 0, keys(B.chest, u), 0);
    h.rot('hipL', keys(B.hipL, u), 0, 0.05);
    h.rot('kneeL', keys(B.kneeL, u), 0, 0);
    h.rot('ankleL', keys([[-0.62, -0.2], [-0.38, 0.3], [-0.2, 0.45], [0.2, 0.4], [0.9, 0]], u), 0, 0);
    h.rot('hipR', keys(B.hipR, u), 0, -0.05);
    h.rot('kneeR', keys(B.kneeR, u), 0, 0);
    h.rot('ankleR', keys([[-0.62, -0.2], [-0.38, 0.0], [0.1, -0.6], [0.9, 0]], u), 0, 0);
    h.rot('shoulderL', keys(B.shL, u), 0, keys(B.shLz, u));
    h.rot('elbowL', keys(B.elL, u), 0, 0);
    // Bowling arm (FK outside the IK window).
    h.rot('shoulderR', keys(B.shR, u), 0, keys(B.shRz, u));
    h.rot('elbowR', keys(B.elR, u), 0, 0);
  }

  // Feet planted where they land (leg IK), blended in and out of the FK legs.
  plantSteps(u) {
    const h = this.h, r = this.run;
    for (const [side, land, lift, fx, fz, yaw] of this.style.feet) {
      const w = sstep(land - 0.06, land, u) * (1 - sstep(lift, lift + 0.08, u));
      if (w < 0.002) continue;
      h.update();
      const ank = h.worldPos('ankle' + side, _a);
      _pl.set(r.rootX + fx, h.ankleHeight * h.root.scale.y, this.zAt(land) + fz);
      _pl.sub(ank).multiplyScalar(w).add(ank);
      const pole = h.worldPos('knee' + side, _c).add(_d.set(Math.sin(yaw * 0.6) * 0.6, 0, Math.cos(yaw * 0.6) * 0.6));
      h.ikLeg(side, _pl, pole);
      h.bones['ankle' + side].getWorldQuaternion(_q);
      _q2.setFromAxisAngle(_up, yaw);
      _q.slerp(_q2, w);
      h.setWorldQuat('ankle' + side, _q);
    }
  }

  // Straight-arm circle in the vertical plane through the shoulder, accelerating
  // into release; the ball (not the wrist) is placed on it, so at u = 0 it sits
  // exactly on the release point. Blended from / back to the FK arm at the ends.
  bowlingArmIK(u) {
    const r = this.run, h = this.h, A = this.style.arm;
    if (u < A.u0 || u > A.u1) return;
    const psi = u <= 0 ? A.psiR - (A.psiR - A.psi0) * Math.pow(-u / -A.u0, A.pw) : A.psiR + A.w * u - A.wd * u * u;
    const w = u === 0 ? 1 : sstep(A.u0, A.u0 + 0.1, u) * (1 - sstep(A.u1 - 0.07, A.u1, u));
    h.update();
    const S = h.worldPos('shoulderR', _a);
    _T.set(S.x, S.y + r.reach * Math.cos(psi), S.z + r.reach * Math.sin(psi));
    if (w < 1) { this.handPos(_c); _T.sub(_c).multiplyScalar(w).add(_c); }
    const pole = _b.copy(S).add(_d.set(-0.6, -0.2, -0.3));
    _W.copy(_T);
    for (let i = 0; i < 3; i++) {             // solve for the wrist that puts the ball on target
      h.ikArm('R', _W, pole);
      this.handPos(_c);
      _W.add(_c.subVectors(_T, _c));
    }
  }

  // Returns true on the frame of release.
  update(dt, t) {
    const h = this.h;
    if (this.state === 'runup' && this.run) {
      const r = this.run, st = this.style;
      let u = t - r.tr;
      let released = false;
      if (!r.released && u >= 0) { r.released = true; released = true; u = 0; }
      if (u <= st.ft) {
        this.pos.set(r.rootX, 0, this.zAt(u));
        this.speed = r.vAt(u);
        this.heading = 0;
        if (u < -0.56) {
          this.gait(dt);
          h.reset();
          poseLocomotion(h, this.phase, this.speed, 0.08 * (1 - sstep(-1.2, -0.7, u)));
          if (st === BOWL.spin) {                    // ball cupped in both hands at the chest
            h.rot('shoulderR', -0.55 + 0.12 * Math.sin(this.phase), 0, 0.12); h.rot('elbowR', -1.75, 0, 0);
            h.rot('shoulderL', -0.5 - 0.12 * Math.sin(this.phase), 0, -0.12); h.rot('elbowL', -1.65, 0, 0);
          } else {                                   // ball carried by the chest, the other arm pumping
            h.rot('elbowR', -1.6, 0, 0);
            h.rot('shoulderR', -0.5 + 0.3 * Math.sin(this.phase), 0, -0.15);
          }
          if (u > -0.68) {
            this.snap = h.snapshot(this.snap || undefined);
            this.poseDelivery(u);
            h.blendFrom(this.snap, sstep(-0.68, -0.56, u));
          }
          this.apply();
        } else {
          this.poseDelivery(u);
          if (u >= st.gaitAt) {                      // the run-off strides take over
            if (!r.gait) { r.gait = true; this.phase = 0; }
            this.gait(dt);
            this.snap = h.snapshot(this.snap || undefined);
            h.reset();
            poseLocomotion(h, this.phase, Math.max(this.speed, 1.2));
            h.blendFrom(this.snap, sstep(st.gaitAt, st.ft, u));
          }
          this.apply();
          this.plantSteps(u);
          this.bowlingArmIK(u);
        }
        h.lookAt(_gaze, u < 0.3 ? 0.9 : 0.6);       // eyes on the target throughout
        this.smooth(dt, 0.18, u < -0.75 || u > 0.3);
        h.syncShadow();
        return released;
      }
      this.state = 'runoff';
      this.speed = r.vAt(st.ft);
    }
    // Run off the pitch, ease up, turn and walk back to the mark (moving along
    // the way he faces, so the turn is a curve, not a spin on the spot).
    const dx = this.home.x - this.pos.x, dz = this.home.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    h.reset();
    if (this.state === 'runoff') {
      this.turnToward(this.side * 0.5, dt, 0.9);
      this.speed = Math.max(0, this.speed - dt * this.style.decel);
      if (this.speed < 0.9) this.state = 'walkback';
    }
    if (this.state === 'walkback') {
      if (dist > 0.35) {
        const want = Math.atan2(dx, dz);
        const err = Math.abs(angDiff(this.heading, want));
        this.turnToward(want, dt, 2.2);
        const vt = Math.min(2.1, 0.3 + dist * 1.2) * clamp(0.45 + 0.7 * Math.cos(err), 0.45, 1);
        this.speed += clamp(vt - this.speed, -dt * 1.5, dt * 1.2);
      } else this.state = 'idle';
    }
    if (this.state === 'runoff' || this.state === 'walkback') {
      this.pos.x += Math.sin(this.heading) * this.speed * dt;
      this.pos.z += Math.cos(this.heading) * this.speed * dt;
      this.gait(dt);
      poseLocomotion(h, this.phase, this.speed);
    } else {
      this.state = 'idle';
      this.speed = 0;
      this.turnToward(0, dt, 2.5);
      poseIdle(h, t, 1);
    }
    this.apply();
    if (this.state === 'idle') {
      this.footWorld(_a, 0.13, 0.03); this.footWorld(_b, -0.13, 0);
      plantFeet(h, _a, _b, this.forward(_c).multiplyScalar(0.6));
    } else if (this.state === 'runoff') h.lookAt(_gaze, 0.6);
    this.smooth(dt);
    h.syncShadow();
    return false;
  }

  holdingBall() { return this.state === 'runup' && this.run && !this.run.released; }
}
const LIFT = [[-0.3, 0], [0, 1], [0.2, 0]];

// ---------------------------------------------------------------- batters
const STANCE = { footL: [-0.31, -1.43], footR: [-0.35, -0.95] };

export class BatterActor extends Actor {
  constructor(scene, opts = {}) {
    super(scene, { headgear: 'helmet', pads: true, gloves: true, ...opts });
    this.bat = buildBatMesh();
    scene.add(this.bat);
    this.h.extras = [this.bat];          // hidden with the figure when it is inside your head
    this.batPose = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
    this.footL = new THREE.Vector3(); this.footR = new THREE.Vector3();
    this.mode = 'bat';        // 'bat' (driven by a bat pose) | 'run' | 'idle'
    this.h.update();
    this.armLen = this.h.worldPos('shoulderR', new THREE.Vector3()).distanceTo(this.h.worldPos('elbowR', new THREE.Vector3()))
      + this.h.worldPos('elbowR', new THREE.Vector3()).distanceTo(this.h.worldPos('handR', new THREE.Vector3()));
    this.carryBat = false;
  }
  set visible(v) { this._vis = v; if (this.h) this.h.visible = v; if (this.bat) this.bat.visible = v; }
  get visible() { return this._vis; }

  // Batting: pose the body around a bat pose.
  // opts: { t, plan (AIBatter plan or null), adv (m down the pitch), ball }
  updateBatting(dt, batPos, batQuat, opts) {
    const h = this.h, t = opts.t;
    this.mode = 'bat';
    this.bat.position.copy(batPos);
    this.bat.quaternion.copy(batQuat);
    const fl = _a.set(STANCE.footL[0], 0, STANCE.footL[1]);
    const fr = _b.set(STANCE.footR[0], 0, STANCE.footR[1]);
    let hipsDrop = 0.09, lean = 0.24, weight = 0.5, heel = 0, elbowUp = 0;
    const p = opts.plan;
    const adv = opts.adv || 0;
    if (p && t >= p.t0) {
      const type = p.shot.type;
      const trig = sstep(p.t0 + 0.04, p.t0 + 0.2, t);
      fr.x += 0.06 * trig; fr.z += 0.04 * trig;       // trigger movement: back and across
      if (p.feet && type !== 'leave') {
        const Tc = p.Tc ?? p.tCommit + 0.3;
        const tLand = Math.max(p.tCommit + 0.12, Tc - 0.06);
        const front = p.foot === 'front';
        // The leading foot goes first; the other one follows.
        const k1 = sstep(p.tCommit, front ? tLand : mix(p.tCommit, tLand, 0.62), t);
        const k2 = sstep(mix(p.tCommit, tLand, front ? 0.55 : 0.3), tLand + (front ? 0.12 : 0), t);
        const kL = front ? k1 : k2, kR = front ? k2 : k1;
        const dL = Math.hypot(p.feet.L[0] - fl.x, p.feet.L[1] - fl.z), dR = Math.hypot(p.feet.R[0] - fr.x, p.feet.R[1] - fr.z);
        fl.x = mix(fl.x, p.feet.L[0], kL); fl.z = mix(fl.z, p.feet.L[1], kL);
        fr.x = mix(fr.x, p.feet.R[0], kR); fr.z = mix(fr.z, p.feet.R[1], kR);
        fl.y = 0.085 * Math.sin(Math.PI * kL) * Math.min(1, dL / 0.3);       // feet are picked up, not slid
        fr.y = 0.07 * Math.sin(Math.PI * kR) * Math.min(1, dR / 0.3);
        const kw = sstep(p.tCommit + 0.04, Tc, t);
        const kf = sstep(Tc - 0.03, Tc + (p.Tf || 0.2), t);                  // through the ball
        const big = p.th && p.th[1] > 1 ? 1 : 0;
        weight = mix(0.5, p.weight ?? 0.5, kw) + (front ? 0.07 : 0.06) * kf * big;
        hipsDrop = mix(hipsDrop, p.drop ?? 0.08, kw) - 0.05 * kf * big;
        lean = mix(lean, front ? 0.44 : type === 'cut' ? 0.34 : 0.1, kw) - (front ? 0.22 : 0.02) * kf * big;
        if (front) { heel = kf * big; elbowUp = sstep(p.tCommit, Tc - 0.05, t) * (1 - 0.6 * kf); }
        // Relax once the shot is played.
        const tRest = Tc + (p.Tf || 0.2) + 0.5;
        if (t > tRest) {
          const kr = sstep(tRest, tRest + 0.8, t);
          hipsDrop = mix(hipsDrop, 0.03, kr); lean = mix(lean, 0.08, kr); heel *= 1 - kr;
          weight = mix(weight, 0.5, kr);
        }
      } else if (p.shot.duck) {
        const k = sstep(p.tCommit, p.tCommit + 0.2, t);
        hipsDrop += 0.4 * k; lean += 0.55 * k;
      } else if (type === 'leave') {
        const k = sstep(p.tCommit, p.tCommit + 0.25, t);           // front pad across, bat out of the way
        fl.x += 0.05 * k; fl.z -= 0.14 * k; fl.y = 0.05 * Math.sin(Math.PI * k);
        hipsDrop -= 0.04 * k; lean -= 0.12 * k; weight = 0.5 + 0.08 * k;
      }
    }
    if (opts.shift) {                                // your body follows where you stand in the room
      fl.x += opts.shift.x; fl.z += opts.shift.z; fr.x += opts.shift.x; fr.z += opts.shift.z;
      hipsDrop += opts.shift.crouch || 0;
    }
    if (adv > 0.001) {                               // skipping down the pitch (and scrambling back)
      const ph = adv / 0.55 * Math.PI * 2;
      fl.z -= adv + 0.1 * Math.max(0, Math.sin(ph)); fr.z -= adv - 0.1 * Math.max(0, Math.sin(ph));
      fl.y += 0.06 * Math.max(0, Math.sin(ph)); fr.y += 0.06 * Math.max(0, -Math.sin(ph));
    }
    this.footL.copy(fl); this.footR.copy(fr);
    this.pos.set(mix(fr.x, fl.x, weight), 0, mix(fr.z, fl.z, weight));
    this.heading = Math.PI / 2;
    h.reset();
    h.bones.hips.position.y = h.hipsRest.y - hipsDrop;
    this.apply();
    // Turn the hips, trunk and shoulders with the hands (coil in the backlift,
    // open up through the ball).
    h.update();
    const s = Math.sin(this.heading), c = Math.cos(this.heading);
    const torso = (push) => {
      const chest = h.worldPos('chest', _c);
      const dxw = batPos.x - chest.x, dzw = batPos.z - chest.z;
      const lx = dxw * c - dzw * s, lz = dxw * s + dzw * c;      // into root local
      const yaw = clamp(Math.atan2(lx, Math.max(0.05, lz)), -1.25, 1.45);
      h.rot('hips', 0, yaw * 0.34, 0);
      h.rot('spine', lean + push, yaw * 0.27, 0);
      h.rot('chest', 0.08 + 0.018 * Math.sin(t * 1.6), yaw * 0.45, 0);
    };
    torso(0);
    // If the bat is out of reach, go with it: bend further and let the hips follow.
    h.update();
    const top = _d.copy(batPos).addScaledVector(_e.set(0, 1, 0).applyQuaternion(batQuat), 0.105);
    const reach = this.armLen * 0.97;
    const over = Math.max(h.worldPos('shoulderR', _fwd).distanceTo(batPos), h.worldPos('shoulderL', _left).distanceTo(top)) - reach;
    if (over > 0) {
      const sh = h.worldPos('chest', _c);
      const dx = batPos.x - sh.x, dz = batPos.z - sh.z, dh = Math.hypot(dx, dz) || 1;
      const low = batPos.y < sh.y - 0.25;
      const move = Math.min(0.3, over * 0.8);
      this.pos.x += dx / dh * move; this.pos.z += dz / dh * move;
      if (low) h.bones.hips.position.y -= Math.min(0.14, over * 0.6);
      this.apply();
      torso(low ? Math.min(0.35, over * 1.2) : 0);
    }
    plantFeet(h, this.footL, this.footR, this.forward(_d).multiplyScalar(0.7));
    if (heel > 0.01) h.addRot('ankleR', 0.75 * heel, 0, 0);       // up on the back toe
    this.gripBat(batPos, batQuat, elbowUp);
    if (opts.ball) h.lookAt(opts.ball, 1, 1.7);
    else h.lookAt(_c.set(0.4, 1.9, -18.8), 1, 1.7);
    h.syncShadow();
  }

  gripBat(batPos, batQuat, elbowUp = 0) {
    const h = this.h;
    h.update();
    const up = _a.set(0, 1, 0).applyQuaternion(batQuat);
    const face = _b.set(0, 0, 1).applyQuaternion(batQuat);
    const bottom = _c.copy(batPos);
    const top = _d.copy(batPos).addScaledVector(up, 0.105);
    this.forward(_fwd);
    _left.set(_fwd.z, 0, -_fwd.x);
    const poleR = h.worldPos('shoulderR', new THREE.Vector3()).addScaledVector(_fwd, -0.35).add(new THREE.Vector3(0, -0.55, 0)).addScaledVector(face, -0.2);
    // Front elbow: out toward the bowler, and high through a straight-bat shot.
    const poleL = h.worldPos('shoulderL', new THREE.Vector3()).addScaledVector(_left, 0.5).add(new THREE.Vector3(0, -0.45 + 0.6 * elbowUp, 0));
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
    this.smooth(dt);
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
    this.smooth(dt);
    h.syncShadow();
  }
}
const _e = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _hold = new THREE.Vector3();
const _gripRot = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
const _carryRot = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2 + 0.3, 0, 0));
