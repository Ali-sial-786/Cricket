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
import { swingAt } from './swingProfile.js';
import { GRIP_BETA } from './gear.js';
import {
  poseIdle, poseLocomotion, plantFeet, heelFor, poseReady, poseThrow, poseDive, posePickup,
  poseCelebrate, strideFor, keys, sstep, clamp, mix,
} from './anim.js';
import { clipsReady, applyClip, applyLocomotion, strideAt, clipInfo, settle, MASK_ALL, MASK_LEGS } from './clips.js';
import { shotFor, poseShot } from './shots.js';
import { shotOf } from './playerShot.js';
import { CONFIG } from '../config.js';
import { BatGeometry } from '../physics/bat.js';
import { PITCH } from '../physics/pitch.js';
import { steerAmong } from '../game/fielding.js';

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
    this.idleOff = Math.random() * 40;         // each figure's idle runs on its own clock
    this.foldArms = 0;                         // chance of standing with the arms folded (idle clip variant)
    this.poseKey = '';                         // which kind of pose: a change cross-fades (see smooth())
    this.visible = true;
  }
  set visible(v) { this._vis = v; if (this.h) this.h.visible = v; }
  get visible() { return this._vis; }
  place(x, z, heading = this.heading) { this.pos.set(x, 0, z); this.heading = heading; this.apply(); }
  turnToward(target, dt, rate = 8) {
    const d = angDiff(this.heading, target);
    this.heading += clamp(d, -rate * dt, rate * dt);
  }
  // Stride phase from distance travelled: with the clips the stride is the
  // one the blended walk / jog / sprint covers per cycle, so planted feet stay put.
  gait(dt) {
    const stride = clipsReady() ? strideAt(this.h, this.speed) : strideFor(this.speed);
    this.phase = (this.phase + dt * TAU * this.speed / stride) % TAU;
  }
  // Standing about: the idle clip on this figure's own clock, now and then
  // with the arms folded (procedural sway without the clips).
  idle(t) {
    const h = this.h;
    if (!clipsReady()) { poseIdle(h, t + this.idleOff, 1); return; }
    const T = t + this.idleOff, slot = Math.floor(T / 9), u = T / 9 - slot;
    const fold = (n) => this.foldArms > 0 && ((Math.sin(n * 91.7 + this.idleOff * 13.1) * 43758.5) % 1 + 1) % 1 < this.foldArms;
    const a = fold(slot), b = fold(slot + 1);
    applyClip(h, a ? 'idle_fold_arms' : 'idle', T);
    if (a !== b && u > 0.88) applyClip(h, b ? 'idle_fold_arms' : 'idle', T, sstep(0.88, 1, u));
  }
  // Walk / jog / sprint for the current speed and stride phase (lean: extra
  // forward lean of the trunk). Falls back to the procedural cycle.
  locomote(t, lean = 0) {
    const h = this.h;
    if (!clipsReady()) { poseLocomotion(h, this.phase, this.speed, lean); return; }
    if (this.speed < 0.75) applyClip(h, 'idle', t + this.idleOff);     // the walk fades in over the idle
    applyLocomotion(h, this.phase, this.speed);
    if (lean) h.addRot('spine', lean, 0, 0);
  }
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
  // A change of `poseKey` (e.g. clip -> procedural, run -> throw) always cross-fades.
  smooth(dt, dur = 0.18, allow = true) {
    const h = this.h;
    const raw = this._raw;
    const switched = this.poseKey !== this._key;
    this._key = this.poseKey;
    if (!allow) this._from = null;
    else if (raw && dt > 0) {
      let jump = 0;
      h.boneList.forEach((b, i) => { const d = b.quaternion.angleTo(raw.q[i]); if (d > jump) jump = d; });
      if (jump > Math.max(0.7, 25 * dt) || (switched && jump > 0.02)) { this._from = copySnap(this._shown || raw, this._from || undefined); this._bt = 0; }
    }
    this._raw = h.snapshot(this._raw);
    if (this._from) {
      this._bt += dt;
      const w = sstep(0, 1, this._bt / dur);
      // (A cross-fade between two grounded poses can put a foot under the
      // turf half-way, e.g. legs straightening before the hips rise: re-land it.)
      if (w >= 1) this._from = null; else { h.blendFrom(this._from, w); h.update(); settle(h); h.update(); }
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
    this.foldArms = this.keeper ? 0 : 0.25;
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
    const clips = clipsReady();
    this.poseKey = act ? act.type : s.state;
    // The keeper going for a ball that is high or wide: timed so that he is
    // at full stretch as it reaches him (whether or not he gets there).
    const lp = this.keeper && s.leap && s.leap.how !== 'take' ? s.leap : null;
    const lu = lp ? t - lp.t : 9;                       // s relative to the ball arriving
    if (lp && lp.how === 'leap' && lu > -0.36 && lu < 0.52 && !(act && (act.type === 'break' || act.type === 'throw'))) {
      const air = Math.max(0, 1 - (lu / 0.3) * (lu / 0.3));
      const bend = sstep(-0.36, -0.28, lu) * (1 - sstep(-0.28, -0.14, lu)) + sstep(0.26, 0.33, lu) * (1 - sstep(0.33, 0.52, lu));
      poseIdle(h, t, 1);
      h.bones.hips.position.y = h.hipsRest.y - 0.24 * bend;
      h.rot('spine', 0.3 * bend - 0.22 * air, 0, 0);
      h.rot('chest', -0.12 * air, 0, 0);
      h.rot('hipL', -0.5 * bend + 0.12 * air, 0, 0.04); h.rot('hipR', -0.5 * bend + 0.2 * air, 0, -0.04);
      h.rot('kneeL', 0.95 * bend + 0.35 * air, 0, 0); h.rot('kneeR', 0.95 * bend + 0.55 * air, 0, 0);
      h.rot('ankleL', -0.45 * bend + 0.7 * air, 0, 0); h.rot('ankleR', -0.45 * bend + 0.7 * air, 0, 0);
      h.rot('neck', -0.35 * air, 0, 0); h.rot('head', -0.3 * air, 0, 0);
      this.apply();
      h.root.position.y = clamp(lp.y - 2.0, 0.1, 0.65) * air;
      if (air < 0.3) { h.update(); h.bones.hips.position.y += settle(h) * (1 - air / 0.3); }    // take-off / landing: on his feet, not through the turf
      if (lu > -0.26 && lu < (lp.missed ? 0.3 : 0.16)) this.reachBoth(_e.set(lp.x, lp.y + (lp.missed ? -0.12 : 0), this.pos.z - 0.1), 1);
      else if (!lp.missed && lu >= 0.16) this.handsToChest();
    } else if (lp && lp.how === 'dive' && lu > -0.3 && lu < 0.8 && !(act && (act.type === 'break' || act.type === 'throw'))) {
      const k = clamp((lu + 0.3) / 1.0, 0, 1);
      const sideLocal = lp.side * Math.cos(this.heading) >= 0 ? 1 : -1;      // which way that is for the figure
      poseDive(h, k, sideLocal);
      const lunge = Math.max(0.3, lp.reach || 0.8) * sstep(0, 0.3, k);
      this.apply(lp.side * lunge, 0);
      h.update(); settle(h);                       // down on the turf, not through it
      this.lieDown(k);
      if (k < 0.5) this.reachBoth(_e.set(lp.x, Math.max(0.12, lp.y), this.pos.z - 0.1), 0.6);
      else if (!lp.missed) this.handsToChest();
    } else if (act && act.type === 'catch' && act.dive && ta < 1.1) {
      const k = ta / 0.95;
      poseDive(h, k, act.side);
      const lunge = act.lunge * sstep(0, 0.32, k);
      offX = act.dir.x * lunge; offZ = act.dir.z * lunge;
      this.apply(offX, offZ);
      h.update(); settle(h);
      this.lieDown(k);
      if (k < 0.45 && act.target) this.reachBoth(act.target, 0.6);
    } else if (act && act.type === 'pickup' && ta < act.dur + 0.05) {
      poseIdle(h, t, 1);
      posePickup(h, ta / act.dur);
      this.apply();
      this.plant(0.16, true);
      // The palm over the ball (the wrist a hand's length above it), not the wrist in it.
      if (act.ball && ta < act.dur * 0.6) { h.update(); h.ikArm('R', _f.copy(act.ball).setY(Math.max(act.ball.y, 0.036) + 0.07 * h.root.scale.y), h.worldPos('shoulderR', _a).add(_b.set(0, -0.2, 0)).add(this.forward(_c).multiplyScalar(-0.3))); }
    } else if (act && act.type === 'throw' && ta < (clips ? THROW_LEAD + this.throwTail() : 0.9) && (ta < THROW_LEAD + 0.15 || this.speed < 0.4)) {
      if (clips) {
        // The authored throw, time-warped so its release frame lands on the
        // logic's release (THROW_LEAD s after the action starts); the
        // follow-through then runs a little quicker than authored.
        const rel = clipInfo('throw').events.release;
        applyClip(h, 'throw', ta < THROW_LEAD ? ta * rel / THROW_LEAD : rel + (ta - THROW_LEAD) * THROW_FOLLOW);
      } else {
        poseIdle(h, t, 1);
        poseThrow(h, ta / 0.75);
      }
      this.apply();
    } else if (s.state === 'celebrate' || (act && act.type === 'catch' && act.success && ta > 0.45)) {
      const k = sstep(0.3, 0.7, act ? ta : 1);
      if (clips) {
        // Both arms up and pumping, over whatever the legs are doing (so the
        // feet don't shuffle into the clip's stance). Hands on the ball first.
        this.poseKey = 'celebrate';
        if (this.speed > 0.3) this.locomote(t); else applyClip(h, 'idle', t + this.idleOff);
        applyClip(h, 'cheer', t + this.idleOff, k, MASK_ALL & ~MASK_LEGS);
        if (act && act.type === 'catch' && act.target && ta < 0.3 && !this.far) { this.apply(); this.reachBoth(act.target, 1); }
      } else {
        if (this.speed > 0.3) poseLocomotion(h, this.phase, this.speed);
        poseCelebrate(h, t, k);
      }
      this.apply();
    } else if (clips && act && act.type === 'catch' && !act.success && !act.dive && ta > 0.7 && ta < 3.2 && this.speed < 0.3) {
      // Put it down: head goes down.
      applyClip(h, 'idle', t + this.idleOff);
      applyClip(h, 'sad', ta - 0.7, sstep(0.7, 1.1, ta) * (1 - sstep(2.7, 3.2, ta)), MASK_ALL & ~MASK_LEGS);
      this.apply();
    } else if (act && act.type === 'catch' && ta < 0.6) {
      if (this.speed > 0.3) this.locomote(t); else this.idle(t);
      this.apply();
      if (act.target) this.reachBoth(act.target, 1);
      else if (ta > 0.15) this.handsToChest();
    } else if (act && act.type === 'break') {
      // Stumping: lunge in and sweep the gloves (ball in the right) into the bails.
      const at = act.at, k = sstep(at - 0.3, at - 0.06, t), back = sstep(at + 0.25, at + 0.8, t);
      poseReady(h, 0.65 * (1 - back * 0.7), true);
      const sx = act.stumps.x - this.pos.x, sz = act.stumps.z - this.pos.z, sd = Math.max(1e-3, Math.hypot(sx, sz));
      const lunge = Math.max(0, sd - 0.62) * k * (1 - back);          // hips (and the front pad) stop short of the stumps, the gloves do the rest
      this.heading = Math.atan2(sx, sz);
      this.apply(sx / sd * lunge, sz / sd * lunge);
      this.plant(0.26, true);
      const reach = k * (1 - back);
      if (reach > 0.02) { _e.copy(act.stumps); _e.y += BAILS_SWEEP; this.reachBoth(_e, 1); }
      else this.handsToChest();
    } else if (act && act.type === 'take') {
      // Taking a throw over the stumps (keeper or the bowler's-end fielder),
      // then the bails off if it's a run-out chance.
      poseReady(h, this.keeper ? 0.35 : 0.2, this.keeper);
      this.apply();
      this.plant(0.22, true);
      const b = act.breakAt;
      const sweep = b != null ? sstep(b - 0.14, b, t) * (1 - sstep(b + 0.2, b + 0.6, t)) : 0;
      if (sweep > 0.02) { _e.copy(act.stumps); _e.y += BAILS_SWEEP; this.reachBoth(_e, 1); }
      else if (ta < 0.4 && act.target) this.reachBoth(act.target, 1);
      else this.handsToChest();
    } else if (act && act.type === 'keep' && (act.hold || ta < 1.2)) {
      // Gathered: up out of the crouch, ball held in the gloves at the chest.
      poseReady(h, this.keeper ? 0.6 * (1 - sstep(0.3, 1.0, ta)) : 0, true);
      this.apply();
      this.plant(0.24, true);
      if (act.target && ta < 0.4) this.reachBoth(act.target, 1);
      else this.handsToChest();
    } else if (this.keeper && s.state === 'gather') {
      // Moving across with the line of the ball: low, on his toes, gloves ready.
      poseIdle(h, t, 1);
      poseReady(h, 0.75, true);
      this.apply();
      this.plant(0.26 + 0.05 * Math.sin(this.phase), true);
      if (s.leap && t > s.leap.t - 0.22) this.reachBoth(_e.set(s.leap.x, clamp(s.leap.y, 0.15, 2.0), this.pos.z - 0.25), 1);
    } else if (this.speed > 0.25) {
      this.poseKey = 'move';
      this.locomote(t, this.keeper ? 0.05 : 0);
      this.apply();
    } else if (clips && !this.keeper) {
      // Standing at his mark; as the bowler runs in, down into a low, wide set.
      this.poseKey = 'stand';
      this.idle(t);
      if (this.ready > 0.01) {
        const k = sstep(0, 1, this.ready);
        applyClip(h, 'set', t + this.idleOff, k, MASK_LEGS);
        for (const [b, x, z] of READY_TOP) { _e2.set(x, 0, z); _q.setFromEuler(_e2); h.bones[b].quaternion.slerp(_q, k); }
      }
      this.apply();
    } else {
      this.poseKey = 'stand';
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
  // Full length in a dive (k as poseDive): the trunk down on the turf, not
  // propped up on the lower leg; the legs bend to stay out of the ground.
  lieDown(k) {
    const h = this.h, w = sstep(0.3, 0.42, k) * (1 - sstep(0.62, 0.78, k));
    if (w < 0.01) return;
    h.update();
    const trunk = h.lowest(h._trunkIdx || (h._trunkIdx = ['hips', 'spine', 'chest'].map((n) => h.boneList.indexOf(h.bones[n]))));
    if (trunk <= 0.02) return;
    h.bones.hips.position.y -= (trunk - 0.02) / h.root.scale.y * w;
    h.update(); h.clearFoot('L'); h.clearFoot('R');
    h.update(); h.clearHand('L'); h.clearHand('R');
  }

  // Seconds of the authored throw after the release (at the follow-through rate).
  throwTail() { const c = clipInfo('throw'); return (c.dur - c.events.release) / THROW_FOLLOW; }
  // (Also far away: without the IK a crouch would put the feet through the turf.)
  plant(halfWidth, flat) {
    this.footWorld(_a, halfWidth, 0.03);
    this.footWorld(_b, -halfWidth, -0.01);
    plantFeet(this.h, _a, _b, this.forward(_c).multiplyScalar(0.6), heelFor(this.h));
    void flat;
  }
  reachBoth(target, amt) {
    const h = this.h;
    target = _reach.copy(target);
    target.y = Math.max(target.y, WRIST_MIN * h.root.scale.y);    // (a ball at the turf: the hand on it, not in it)
    // Gloves never inside a set of stumps (gathering beside them): out to this side of them.
    for (const sz of STUMP_ZS) {
      if (Math.abs(target.x) < 0.2 && Math.abs(target.z - sz) < 0.12 && target.y < PITCH.stumpHeight + 0.05) target.z = sz + (this.pos.z >= sz ? 0.12 : -0.12);
    }
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

// The gloves sweep the bails off from above: wrists this far over the top of
// the stumps, so the ball in the glove (a hand's length below the wrist) clips the bails, not the stumps.
const BAILS_SWEEP = 0.15;
const WRIST_MIN = 0.1;               // wrist above the turf when a hand reaches down (the glove is under it)
const THROW_LEAD = 0.47;            // the logic starts the throw this long before the ball leaves the hand
const THROW_FOLLOW = 1.3;           // follow-through playback rate
// Over the clip's low, wide legs: leaning in, eyes up, hands out in front
// ready to move either way (local x / z rotations, slerped in).
const READY_TOP = [['spine', 0.36, 0], ['chest', 0.12, 0], ['neck', -0.22, 0], ['head', -0.18, 0],
  ['shoulderL', -0.62, 0.2], ['shoulderR', -0.62, -0.2], ['elbowL', -0.75, 0], ['elbowR', -0.75, 0], ['handL', 0, 0], ['handR', 0, 0]];
const _e2 = new THREE.Euler();

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
    kneeL: [[-0.62, 0.6], [-0.5, 1.25], [-0.38, 0.7], [-0.2, 0.06], [0.1, 0.1], [0.3, 0.35], [0.4, 0.85], [0.65, 0.9], [0.9, 0.3]],
    hipR: [[-0.62, 0.45], [-0.5, -0.45], [-0.38, 0.12], [-0.2, 0.5], [0, 0.7], [0.2, 0.1], [0.37, -0.55], [0.9, 0]],
    kneeR: [[-0.62, 0.9], [-0.5, 1.15], [-0.38, 0.35], [-0.2, 0.6], [0.1, 1.35], [0.3, 1.2], [0.37, 0.25], [0.9, 0.2]],
    shL: [[-0.62, -0.3], [-0.45, -2.6], [-0.2, -2.95], [0, -0.75], [0.3, 0.3], [0.9, 0.1]],
    shLz: [[-0.62, 0.1], [-0.2, 0.18], [0.05, 0.22], [0.4, 0.12], [0.9, 0.1]],
    elL: [[-0.62, -0.5], [-0.45, -0.2], [-0.15, -0.3], [0.05, -1.5], [0.4, -1.3], [0.9, -0.6]],
    shR: [[-0.62, -0.4], [-0.5, -0.7], [-0.38, 0.0], [-0.3, 0.6], [-0.2, 0.9], [0.08, 4.45], [0.16, 4.75], [0.3, 5.6], [0.9, 6.25]],
    shRz: [[-0.62, -0.1], [0.08, -0.05], [0.3, 0.45], [0.9, 0.05]],
    elR: [[-0.62, -1.4], [-0.5, -1.8], [-0.38, -0.9], [-0.3, -0.15], [0.3, -0.15], [0.9, -0.4]],
    // Straight-arm circle round the shoulder (psi from vertical, + toward the batter).
    arm: { u0: -0.34, u1: 0.16, psi0: -2.75, pw: 1.5, w: 13, wd: 25, psiR: 0.22 },
    feet: [['R', -0.38, -0.13, -0.04, 0.02, -1.4], ['L', -0.14, 0.33, -0.1, 0.42, -0.15], ['R', 0.37, 0.72, 0.0, 0.32, 0.15]],
    ft: 0.9, post: 0.45, gaitAt: 0.55, decel: 1.1,
  },
  spin: {
    hipsY: [[-0.62, -0.03], [-0.48, 0.07], [-0.36, -0.03], [-0.16, -0.06], [0, 0.0], [0.18, -0.05], [0.4, -0.08], [0.75, -0.03]],
    hipsYaw: [[-0.62, 0], [-0.45, -0.75], [-0.2, -0.85], [0, -0.15], [0.25, 0.5], [0.5, 0.75], [0.75, 0.4]],
    spine: [[-0.62, 0.08], [-0.36, -0.05], [-0.15, 0.0], [0, 0.14], [0.22, 0.5], [0.5, 0.35], [0.75, 0.1]],
    roll: [[-0.62, 0], [-0.3, 0.04], [-0.1, -0.1], [0, -0.22], [0.25, -0.05], [0.5, 0]],
    chest: [[-0.62, 0], [-0.45, -0.35], [-0.2, -0.3], [0, 0.25], [0.3, 0.45], [0.75, 0.15]],
    hipL: [[-0.62, -0.3], [-0.5, -0.75], [-0.36, -0.85], [-0.2, -0.45], [0, -0.3], [0.3, 0.1], [0.75, 0]],
    kneeL: [[-0.62, 0.5], [-0.5, 0.95], [-0.36, 0.5], [-0.2, 0.12], [0.1, 0.12], [0.35, 0.35], [0.45, 0.8], [0.75, 0.3]],
    hipR: [[-0.62, 0.35], [-0.5, -0.3], [-0.36, 0.1], [-0.2, 0.35], [0, 0.5], [0.18, 0.0], [0.38, -0.5], [0.75, 0]],
    kneeR: [[-0.62, 0.8], [-0.5, 0.9], [-0.36, 0.3], [-0.2, 0.45], [0.1, 1.05], [0.28, 1.05], [0.4, 0.2], [0.75, 0.1]],
    shL: [[-0.62, -0.55], [-0.45, -2.3], [-0.2, -2.65], [0, -1.0], [0.3, 0.05], [0.75, 0.1]],
    shLz: [[-0.62, -0.15], [-0.45, 0.1], [-0.2, 0.15], [0.05, 0.2], [0.4, 0.1], [0.75, 0.1]],
    elL: [[-0.62, -1.6], [-0.45, -0.4], [-0.15, -0.3], [0.05, -1.4], [0.4, -1.1], [0.75, -0.5]],
    shR: [[-0.62, -0.55], [-0.48, -0.9], [-0.38, -0.2], [-0.3, 0.5], [-0.2, 0.8], [0.08, 4.35], [0.18, 4.8], [0.35, 5.5], [0.75, 6.2]],
    shRz: [[-0.62, 0.15], [-0.48, 0.0], [0.08, -0.05], [0.35, 0.65], [0.75, 0.1]],
    elR: [[-0.62, -1.7], [-0.48, -1.9], [-0.38, -1.0], [-0.3, -0.2], [0.3, -0.35], [0.75, -0.4]],
    arm: { u0: -0.36, u1: 0.18, psi0: -2.6, pw: 1.4, w: 10.5, wd: 15, psiR: 0.12 },
    feet: [['R', -0.36, -0.15, -0.03, 0.02, -1.05], ['L', -0.16, 0.4, -0.08, 0.32, -0.25], ['R', 0.4, 0.75, 0.05, 0.28, 0.3]],
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
    this.run.wide = 0; this.run.wide2 = 0;
    this.run.wide = this.stumpClearance(-0.62, -0.1, wideAt, 0.4);
    this.run.wide2 = this.stumpClearance(-0.14, 0.2, wide2At, 0.08);
    this.pos.set(rootX, 0, prof[0].z);
    this.home.set(rootX, 0, prof[0].z);
    this.heading = 0;
    this.state = 'runup';
    // (Until the first update he stands at his mark, not where the release
    // pose was measured: that was at the origin, the batter's stumps.)
    h.reset();
    this.idle(t);
    this.apply();
    h.syncShadow();
  }

  // Past the stumps in the bound the leading leg swings across the body: on a
  // line close to the stumps (over the wicket with the release near the
  // middle) it would go through them. Rehearse the bound once and find how far
  // the body must swing wide (m, signed away from the stumps; WIDE_BUMP shapes
  // it over time, back on the line well before the arm comes over).
  // (A second, smaller swing around the release, wide2, for the back leg
  // coming through: small, because there the bowling arm has to reach the
  // release point from the moved shoulder.)
  stumpClearance(u0, u1, prof, cap) {
    const r = this.run, h = this.h, out = Math.sign(r.rootX) || this.side;
    let A = 0;
    for (let u = u0; u <= u1; u += 0.03) {
      this.pos.set(r.rootX, 0, this.zAt(u));
      this.poseDelivery(u);
      this.apply(this.wideOff(u), 0);
      this.plantSteps(u);
      h.update();
      for (const b of STUMP_CHECK) {
        const p = h.worldPos(b, _a);
        if (Math.abs(p.z - PITCH.bowlingStumpsZ) > 0.35) continue;
        const need = (STUMP_GAP - out * p.x) / Math.max(0.25, prof(u));
        if (need > A) A = need;
      }
    }
    return out * Math.min(cap, A);
  }
  wideOff(u) { const r = this.run; return (r.wide || 0) * wideAt(u) + (r.wide2 || 0) * wide2At(u); }

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

  // How firmly some foot is planted at u (0 = none: between steps).
  plantWeight(u) {
    let m = 0;
    for (const [, land, lift] of this.style.feet) m = Math.max(m, sstep(land - 0.06, land, u) * (1 - sstep(lift, lift + 0.08, u)));
    return m;
  }

  // Feet planted where they land (leg IK), blended in and out of the FK legs.
  plantSteps(u) {
    const h = this.h, r = this.run;
    for (const [side, land, lift, fx, fz, yaw] of this.style.feet) {
      const w = sstep(land - 0.06, land, u) * (1 - sstep(lift, lift + 0.08, u));
      if (w < 0.002) continue;
      h.update();
      const ank = h.worldPos('ankle' + side, _a);
      _pl.set(r.rootX + fx + this.wideOff(land), h.ankleHeight * h.root.scale.y, this.zAt(land) + fz);
      _pl.sub(ank).multiplyScalar(w).add(ank);
      _pl.y = Math.max(_pl.y, h.ankleHeight * h.root.scale.y);     // landing / lifting: never through the turf
      const pole = h.worldPos('knee' + side, _c).add(_d.set(Math.sin(yaw * 0.6) * 0.6, 0, Math.cos(yaw * 0.6) * 0.6));
      h.ikLeg(side, _pl, pole);
      h.bones['ankle' + side].getWorldQuaternion(_q);
      _q2.setFromAxisAngle(_up, yaw);
      _q.slerp(_q2, w);
      h.setWorldQuat('ankle' + side, _q);
      // Out of the leg's reach (up on the toes to reach the release): the heel
      // comes up and the ball of the foot stays on the turf.
      const up = h.worldPos('ankle' + side, _a).y - _pl.y;
      if (up > 0.004 && w > 0.5) h.addRot('ankle' + side, Math.asin(Math.min(0.95, up / (h.toeLength * h.root.scale.y))) * w, 0, 0);
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
    _T.set(S.x - this.wideOff(u), S.y + r.reach * Math.cos(psi), S.z + r.reach * Math.sin(psi));   // (the circle stays on the run-up line when the body swings wide of the stumps)
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
        this.poseKey = 'runup';
        this.pos.set(r.rootX, 0, this.zAt(u));
        this.speed = r.vAt(u);
        this.heading = 0;
        if (u < -0.56) {
          this.gait(dt);
          h.reset();
          // (Taller through the trunk than a sprinter: a bowler's approach is upright.)
          this.locomote(t, 0.08 * (1 - sstep(-1.2, -0.7, u)) - (clipsReady() ? 0.16 : 0));
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
          if (r.wide) this.apply(this.wideOff(u), 0);
          if (u > -0.7) { h.update(); h.clearFoot('L'); h.clearFoot('R'); }      // stride into the bound
        } else {
          this.poseDelivery(u);
          if (u >= st.gaitAt) {                      // the run-off strides take over
            if (!r.gait) { r.gait = true; this.phase = 0; }
            this.gait(dt);
            this.snap = h.snapshot(this.snap || undefined);
            h.reset();
            const v = this.speed;
            this.speed = Math.max(v, 1.2);
            this.locomote(t);
            this.speed = v;
            h.blendFrom(this.snap, sstep(st.gaitAt, st.ft, u));
          }
          this.apply(this.wideOff(u), 0);
          // Between planted steps (the swing-through after release, the run-off
          // hand-over) the FK legs set the height: land the lower foot on the turf.
          const free = 1 - this.plantWeight(u);
          if (free > 0.002) { h.update(); h.bones.hips.position.y += settle(h) * free; }
          this.plantSteps(u);
          this.h.update(); this.h.clearFoot('L'); this.h.clearFoot('R');      // the landing / trailing / swinging leg
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
    // Who / what to walk round (umpire, batters, stumps; set by the game each frame).
    const obs = this.obstacles || NO_OBS;
    if (this.state === 'runoff') {
      const ahead = steerAmong(this.pos.x, this.pos.z, this.pos.x + Math.sin(this.side * 0.5) * 6, this.pos.z + Math.cos(this.side * 0.5) * 6, obs, _st);
      this.turnToward(Math.atan2(ahead.x, ahead.z), dt, 0.9);
      this.speed = Math.max(0, this.speed - dt * this.style.decel);
      if (this.speed < 0.9) this.state = 'walkback';
    }
    if (this.state === 'walkback') {
      if (dist > 0.35) {
        const u = steerAmong(this.pos.x, this.pos.z, this.home.x, this.home.z, obs, _st);
        const want = Math.atan2(u.x, u.z);
        const err = Math.abs(angDiff(this.heading, want));
        this.turnToward(want, dt, 2.2);
        const vt = Math.min(2.1, 0.3 + dist * 1.2) * clamp(0.45 + 0.7 * Math.cos(err), 0.45, 1);
        this.speed += clamp(vt - this.speed, -dt * 1.5, dt * 1.2);
      } else this.state = 'idle';
    }
    if (this.state === 'runoff' || this.state === 'walkback') {
      this.pos.x += Math.sin(this.heading) * this.speed * dt;
      this.pos.z += Math.cos(this.heading) * this.speed * dt;
      for (const o of obs) {                     // (never inside one, whatever the turn rate allowed)
        const ox = this.pos.x - o.x, oz = this.pos.z - o.z, d = Math.hypot(ox, oz);
        if (d < o.r && d > 1e-4) { this.pos.x = o.x + ox / d * o.r; this.pos.z = o.z + oz / d * o.r; }
      }
      this.gait(dt);
      this.locomote(t);
    } else {
      this.state = 'idle';
      this.speed = 0;
      this.turnToward(0, dt, 2.5);
      this.idle(t);
    }
    this.poseKey = this.state === 'idle' ? 'idle' : 'move';
    this.apply();
    if (this.state === 'idle' && !clipsReady()) {
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
// Swinging wide of the stumps in the bound (see stumpClearance): in by the
// bound, back on the run-up line before the arm IK takes the ball to the release point.
const wideAt = (u) => sstep(-0.85, -0.55, u) * (1 - sstep(-0.3, -0.14, u));
const wide2At = (u) => sstep(-0.3, -0.14, u) * (1 - sstep(0.2, 0.45, u));
const STUMP_CHECK = ['ankleL', 'ankleR', 'kneeL', 'kneeR'];
const STUMP_ZS = [PITCH.battingStumpsZ, PITCH.bowlingStumpsZ];
const STUMP_GAP = PITCH.wicketHalfWidth + 0.2;    // ankle / knee joint to the middle stump's line, at least (m)
const NO_OBS = [], _st = { x: 0, z: 0 };

// ---------------------------------------------------------------- batters
// While a stumping is judged (and in its replay) your figure's back foot (R)
// is put where your real back foot is (src/game/crease.js BackFoot), so the
// stride a captured shot plays cannot show it over the line when you were in.
// crease: { z (world), pin 0..1 } from BattingSession.bodyState(), or null.
function pinBack(foot, crease) {
  if (!crease || crease.z == null || !(crease.pin > 0)) return;
  foot.z = mix(foot.z, crease.z, Math.min(1, crease.pin));
}
const STANCE = { footL: [-0.31, -1.43], footR: [-0.35, -0.95] };
const STANCE_MID = [(STANCE.footL[0] + STANCE.footR[0]) / 2, (STANCE.footL[1] + STANCE.footR[1]) / 2];
const _mi = new THREE.Matrix4(), _yq = new THREE.Vector3(), _zAxis = new THREE.Vector3(0, 0, 1);
// Heading of a rotation's +Z about the vertical.
function yawOfQ(q) { _yq.set(0, 0, 1).applyQuaternion(q); return Math.atan2(_yq.x, _yq.z); }
// How much of a full (baseball-style) body turn each cricket shot uses.
const SWING_AMP = { pull: 0.85, hook: 0.85, slog: 0.9, cut: 0.5, drive: 0.5, flick: 0.45, defend: 0.12, leave: 0 };
const _sw = {};
const ARM_STRETCH = 1;                 // (the arms are adult length in the asset now)
const PALM = 0.075;                 // wrist to the middle of the palm (where a handle sits)
const HAND_GAP = 0.105;
// The batting stance (a crouch with the head out over the toes, cf. the classic side-on stance).
const ELBOW_FWD = 0.2;               // elbows out in front of the shoulders, over the hands
const STANCE_LEAN = 0.52, STANCE_KNEES = 0.05, STANCE_DROP = 0.18, FRONT_OPEN = 0.3;
const FOOT_FRONT = 0.2, FOOT_BACK = 0.26;      // your feet: front foot ahead of your head, back foot behind it             // bottom hand to top hand, up the handle
const GRIP_ROLL = 0.8;              // how far a hand may roll round the handle from the textbook grip (rad)
const MAX_STRIDE = 1.0;             // feet apart at most in a lunge (m)
const KNEEL_PAD = 0.12;             // knee joint above the turf when kneeling: the pad's knee roll rests on it

export class BatterActor extends Actor {
  constructor(scene, opts = {}) {
    super(scene, { headgear: 'helmet', pads: true, gloves: true, ...opts });
    this.bat = buildBatMesh();
    scene.add(this.bat);
    this.h.extras = [this.bat];          // hidden with the figure when it is inside your head
    this.batPose = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
    this.footL = new THREE.Vector3(); this.footR = new THREE.Vector3();
    this.mode = 'bat';        // 'bat' (driven by a bat pose) | 'run' | 'idle'
    // The model's arms are short for holding a bat out in front: lengthen them a little.
    for (const b of ['elbowL', 'handL', 'elbowR', 'handR']) this.h.bones[b].position.multiplyScalar(ARM_STRETCH);
    this.armRest = Object.fromEntries(['elbowL', 'handL', 'elbowR', 'handR'].map((b) => [b, this.h.bones[b].position.clone()]));
    this.stretchArms = false;     // your figure: the arms may lengthen so the gloves are always on your bat (gripBat)
    this.h.update();
    this.armLen = this.h.worldPos('shoulderR', new THREE.Vector3()).distanceTo(this.h.worldPos('elbowR', new THREE.Vector3()))
      + this.h.worldPos('elbowR', new THREE.Vector3()).distanceTo(this.h.worldPos('handR', new THREE.Vector3()));
    this.armScale0 = this.h.root.scale.x;
    // Trunk measurements (model units): hips -> head joint, and the knee height when kneeling.
    const hp0 = this.h.worldPos('hips', new THREE.Vector3()), hd0 = this.h.worldPos('head', new THREE.Vector3());
    this.spineLen = hp0.distanceTo(hd0) / this.armScale0;
    this.headRestY = hd0.y / this.armScale0;
    this.spineRest = hd0.clone().sub(hp0).normalize();
    this.kneelHipY = (this.h.worldPos('hipR', new THREE.Vector3()).distanceTo(this.h.worldPos('kneeR', new THREE.Vector3())) * 0.93 + KNEEL_PAD) / this.armScale0;
    this.carryBat = false;
  }
  set visible(v) { this._vis = v; if (this.h) this.h.visible = v; if (this.bat) this.bat.visible = v; }
  get visible() { return this._vis; }

  // Batting: pose the body around a bat pose.
  // opts: { t, plan (AIBatter plan or null), adv (m down the pitch), ball }
  // The AI's shots are played with a real batter's body (motion capture,
  // src/render/shots.js) where there is one for the shot: its footwork, knees,
  // hips, trunk and head, time-warped onto the plan and fitted to the plan's
  // feet, with the hands on the physics bat. It takes over from the
  // procedural stance as the ball is released and hands back once the shot
  // has been held; anything else (and you) stays procedural.
  updateBatting(dt, batPos, batQuat, opts) {
    const p = opts.plan;
    this.poseKey = 'bat';
    if (!p && opts.shot !== undefined) { this.playerBatting(dt, batPos, batQuat, opts); return; }
    const use = !opts.head && p && p.feet && p.shot && !(p.adv > 0) && !(opts.adv > 0.001) ? this.mocapFor(p) : null;
    const w = use ? this.mocapWeight(opts.t, p) : 0;
    if (w < 1) this.batProcedural(dt, batPos, batQuat, opts);
    if (w <= 0) return;
    const h = this.h;
    let snap = null;
    if (w < 1) {
      // The procedural pose, re-expressed about the root the capture uses.
      snap = this._pSnap = h.snapshot(this._pSnap);
      const sc = h.root.scale.x, dx = this.pos.x - STANCE_MID[0], dz = this.pos.z - STANCE_MID[1];
      snap.hipsP.x += -dz / sc; snap.hipsP.z += dx / sc;
    }
    this.mocapBody(batPos, batQuat, opts, use);
    if (snap) {
      h.blendFrom(snap, w);
      h.update(); h.clearFoot('L'); h.clearFoot('R');          // (the blend of two grounded poses can dip a toe)
      this.gripBat(batPos, batQuat, this._elbowUp);
    }
    if (opts.ball) h.lookAt(opts.ball, 1, 1.7);
    else h.lookAt(_c.set(0.4, 1.9, -18.8), 1, 1.7);
    h.syncShadow();
  }

  // You (the figure that stands in for you): the procedural stance that
  // follows your head and steps its feet, and once you play a shot
  // (src/render/playerShot.js ShotReader, opts.shot) a real batter's shot of
  // that kind: its feet, stride, knees, hips, trunk turn and weight, timed to
  // your swing (your backlift top -> its top, the ball reaching you or the
  // real contact -> its contact), anchored where your feet were when you
  // started the swing; the pelvis and then the trunk take up the difference
  // between its head and yours so the head stays where your head really is;
  // the hands stay on your bat. Faded in over 0.15 s and out after the finish.
  playerBatting(dt, batPos, batQuat, opts) {
    const c = opts.shot, t = opts.t;
    this.batProcedural(dt, batPos, batQuat, opts);
    if (!c) { this._ps = null; return; }
    const P = this._ps && this._ps.c === c ? this._ps : (this._ps = { c, use: null, cls: null, prev: null, tSwitch: -9, O: new THREE.Vector3((this.footL.x + this.footR.x) / 2, 0, (this.footL.z + this.footR.z) / 2) });
    if (P.cls !== c.cls) {
      const o = shotOf(c.cls), u = shotFor(o.type, o.want);
      if (P.use && u && u.shot !== P.use.shot) { P.prev = P.use; P.tSwitch = t; }
      P.use = u || P.use; P.cls = c.cls;
    }
    if (!P.use) return;
    const s = P.use.shot, ev = s.events;
    const after = ev.finish - ev.contact;
    const w = sstep(c.t0 - 0.02, c.t0 + 0.15, t) * (1 - sstep(c.Tc + after + 0.35, c.Tc + after + 0.95, t));
    if (w <= 0) return;
    const h = this.h, sc = h.root.scale.x;
    // the procedural pose, about the shot's anchor
    const snap = this._pSnap = h.snapshot(this._pSnap);
    const pdx = this.pos.x - P.O.x, pdz = this.pos.z - P.O.z, fL = _pfL.copy(this.footL), fR = _pfR.copy(this.footR);
    snap.hipsP.x += -pdz / sc; snap.hipsP.z += pdx / sc;
    const timeOf = (sh) => {
      const e = sh.events, tTop = Math.min(c.tTop, c.Tc - 0.1);
      // (sweeping: you are already down on the knee, so the shot starts just before its contact)
      const uTop = c.sweep ? Math.max(e.top, e.contact - 0.3) : e.top;
      if (t < c.Tc) return clamp(uTop + (e.contact - uTop) * (t - tTop) / (c.Tc - tTop), 0, e.contact);
      return Math.min(sh.dur, e.contact + (t - c.Tc));
    };
    if (P.prev && t - P.tSwitch < 0.2) {
      this.playerShotBody(batPos, batQuat, opts, P.prev.shot, timeOf(P.prev.shot), P.O);
      const s2 = this._pSnap2 = h.snapshot(this._pSnap2);
      this.playerShotBody(batPos, batQuat, opts, s, timeOf(s), P.O);
      h.blendFrom(s2, 1 - sstep(P.tSwitch, P.tSwitch + 0.2, t));
    } else this.playerShotBody(batPos, batQuat, opts, s, timeOf(s), P.O);
    h.blendFrom(snap, w);
    h.update(); h.clearFoot('L'); h.clearFoot('R');
    this.gripBat(batPos, batQuat, 0);
    this.footL.lerpVectors(fL, this.footL, w); this.footR.lerpVectors(fR, this.footR, w);
    if (opts.ball) h.lookAt(opts.ball, 1, 1.7);
    h.syncShadow();
  }

  // The body from capture `s` at capture time u for you: anchored at O, the
  // head kept on your real head (opts.head, the headset) within a few cm.
  playerShotBody(batPos, batQuat, opts, s, u, O) {
    const h = this.h, sc = h.root.scale.x;
    this.heading = Math.PI / 2;
    this.pos.set(O.x, 0, O.z);
    h.reset();
    this.apply();
    poseShot(h, s, u);
    h.update();
    const M = this._pm || (this._pm = { L: new THREE.Vector3(), R: new THREE.Vector3(), kL: new THREE.Vector3(), kR: new THREE.Vector3(), qL: new THREE.Quaternion(), qR: new THREE.Quaternion(), H: new THREE.Vector3(), hd: new THREE.Vector3() });
    h.worldPos('ankleL', M.L); h.worldPos('ankleR', M.R); h.worldPos('hips', M.H); h.worldPos('head', M.hd);
    h.worldPos('kneeL', M.kL); h.worldPos('kneeR', M.kR);
    h.bones.ankleL.getWorldQuaternion(M.qL); h.bones.ankleR.getWorldQuaternion(M.qR);
    for (const sd of ['L', 'R']) {
      const k = M['k' + sd], hip = h.worldPos('hip' + sd, _a);
      _b.addVectors(hip, M[sd]).multiplyScalar(0.5);
      k.addScaledVector(_d.subVectors(k, _b), 1.0);
    }
    const ankleY = h.ankleHeight * sc;
    M.L.y = Math.max(M.L.y, ankleY * 0.95); M.R.y = Math.max(M.R.y, ankleY * 0.95);
    // a stumping being judged: the back foot where yours really is, not where the capture strides it
    const kz = M.R.z; pinBack(M.R, opts.crease); M.kR.z += M.R.z - kz;
    { // (and the front foot no further from it than a real stride)
      const st = Math.hypot(M.L.x - M.R.x, M.L.z - M.R.z);
      if (st > MAX_STRIDE) { const k = MAX_STRIDE / st, lx = M.L.x, lz = M.L.z; M.L.x = M.R.x + (lx - M.R.x) * k; M.L.z = M.R.z + (lz - M.R.z) * k; M.kL.x += M.L.x - lx; M.kL.z += M.L.z - lz; }
    }
    // the pelvis takes up most of the difference between the capture's head and yours
    const Hg = _hp.copy(M.H);
    if (opts.head) {
      const dx = opts.head.x - M.hd.x, dz = opts.head.z - M.hd.z, dy = opts.head.y - 0.11 - M.hd.y;
      const dl = Math.hypot(dx, dz), k = dl > 0.3 ? 0.3 / dl : 1;
      Hg.x += dx * k * 0.85; Hg.z += dz * k * 0.85; Hg.y += clamp(dy, -0.3, 0.06) * 0.7;
    }
    const legLen = (h.bones.kneeL.position.length() + h.bones.ankleL.position.length()) * sc;
    for (let pass = 0; pass < 2; pass++) {
      let drop = 0;
      for (const sd of ['L', 'R']) {
        const hj = h.worldPos('hip' + sd, _a).add(_b.subVectors(Hg, M.H)), F = M[sd];
        const d = hj.distanceTo(F), over = d - legLen * 0.992;
        if (over > 0) drop = Math.max(drop, over * d / Math.max(0.3, hj.y - F.y));
      }
      if (drop <= 0) break;
      Hg.y -= drop;
    }
    Hg.y = Math.max(Hg.y, M.H.y - 0.15);           // never much lower than the capture (no collapsing)
    _d.subVectors(Hg, M.H);
    M.kL.add(_d); M.kR.add(_d);
    h.bones.hips.position.copy(h.bones.hips.parent.worldToLocal(_e.copy(Hg)));
    h.update();
    for (const sd of ['L', 'R']) {
      h.ikLeg(sd, M[sd], M['k' + sd]);
      h.setWorldQuat('ankle' + sd, M['q' + sd]);
    }
    h.update(); h.clearFoot('L'); h.clearFoot('R');          // (onto the toes, not into the turf)
    this.legsClearOfBat(batPos, batQuat);
    this.footL.set(M.L.x, M.L.y - ankleY, M.L.z); this.footR.set(M.R.x, M.R.y - ankleY, M.R.z);
    // the trunk leans the rest of the way to your head (up to ~30 deg)
    if (opts.head) {
      h.update();
      const sp = h.worldPos('spine', _v1), hd = h.worldPos('head', _v2);
      _x.subVectors(hd, sp).normalize();
      _y.set(opts.head.x, opts.head.y - 0.11, opts.head.z).sub(sp).normalize();
      const ang = Math.acos(clamp(_x.dot(_y), -1, 1));
      if (ang > 1e-3) {
        _z.copy(_x).lerp(_y, Math.min(1, 0.55 / ang)).normalize();
        h.bones.spine.getWorldQuaternion(_ql);
        h.setWorldQuat('spine', _ql.premultiply(_q.setFromUnitVectors(_x, _z)));
      }
    }
    // shoulders turned toward the hands where the capture's are turned away
    h.update();
    const ch = h.worldPos('chest', _ch);
    h.bones.chest.getWorldQuaternion(_ql);
    _f.set(0, 0, 1).applyQuaternion(_ql);
    const want = Math.atan2(batPos.x - ch.x, batPos.z - ch.z), have = Math.atan2(_f.x, _f.z);
    const dyaw = clamp(angDiff(have, want), -1.2, 1.2) * 0.45;
    for (const [b, f] of [['spine', 0.45], ['chest', 0.55]]) {
      h.bones[b].getWorldQuaternion(_ql);
      h.setWorldQuat(b, _ql.premultiply(_q.setFromAxisAngle(_up, dyaw * f)));
    }
    this.gripBat(batPos, batQuat, 0);
  }

  // The capture for this plan (cached per plan), or null.
  mocapFor(p) {
    if (this._mPlan === p && this._mType === p.shot.type && this._mT0 === p.t0) return this._mUse;
    this._mPlan = p; this._mType = p.shot.type; this._mT0 = p.t0;
    const stride = Math.hypot(p.feet.L[0] - STANCE.footL[0], p.feet.L[1] - STANCE.footL[1]);
    this._mUse = shotFor(p.shot.type, { stride, loft: p.shot.loft, ang: p.shot.ang, yb: p.info && p.info.yb });
    return this._mUse;
  }

  // How much of the body the capture has: none in the stance, all from just
  // after the release, none again once the finish has been held.
  mocapWeight(t, p) {
    const Tc = p.Tc ?? p.tCommit + 0.3, tRel = Tc + (p.Tf || 0.2) + 0.55;
    return sstep(p.t0 - 0.02, p.t0 + 0.2, t) * (1 - sstep(tRel, tRel + 0.8, t));
  }

  // Capture time for game time t: stance at the release, the top of the
  // backlift at the top of the bat's backswing, contact at contact, the finish
  // at the end of the bat's follow-through (piecewise linear).
  shotTime(t, p, use) {
    const s = use.shot, ev = s.events;
    const Tc = p.Tc ?? p.tCommit + 0.3, Tf = p.Tf || 0.2;
    const tTop = clamp(p.tSwingStart ?? Tc - 0.2, p.t0 + 0.12, Tc - 0.08);
    if (t <= p.t0) return 0;
    if (t < tTop) return ev.top * (t - p.t0) / (tTop - p.t0);
    if (t < Tc) return ev.top + (ev.contact - ev.top) * (t - tTop) / (Tc - tTop);
    if (use.hold) return ev.contact + 0.1 * sstep(0, 0.35, t - Tc);
    if (t < Tc + Tf) return ev.contact + (ev.finish - ev.contact) * (t - Tc) / Tf;
    return Math.min(s.dur, ev.finish + (t - Tc - Tf) * 0.8);
  }

  // Where the capture's ankles are in its stance and at contact (figure frame,
  // model units) and which way its pelvis faces in the stance.
  shotRef(s) {
    const R = (this._shotRef ||= {});
    if (R[s.name]) return R[s.name];
    const h = this.h, out = {};
    for (const [k, time] of [['s', 0], ['c', s.events.contact]]) {
      h.reset();
      poseShot(h, s, time);
      h.update();
      out[k + 'L'] = h.bones.ankleL.getWorldPosition(new THREE.Vector3()).applyMatrix4(_mi.copy(h.root.matrixWorld).invert());
      out[k + 'R'] = h.bones.ankleR.getWorldPosition(new THREE.Vector3()).applyMatrix4(_mi);
    }
    h.reset();
    poseShot(h, s, 0);
    out.yaw0 = yawOfQ(h.bones.hips.quaternion);
    h.reset();
    return (R[s.name] = out);
  }

  // The body from the capture: feet fitted to the plan, pelvis kept where the
  // capture has it between the feet (weight transfer), hips as low as it
  // crouches, trunk and head from the capture, turned a little more toward the
  // hands if they need it; hands on the bat.
  mocapBody(batPos, batQuat, opts, use) {
    const h = this.h, t = opts.t, p = opts.plan, s = use.shot, sc = h.root.scale.x;
    const Tc = p.Tc ?? p.tCommit + 0.3;
    const u = this.shotTime(t, p, use);
    const ref = this.shotRef(s);
    this.mode = 'bat';
    this.bat.position.copy(batPos);
    this.bat.quaternion.copy(batQuat);
    this.heading = Math.PI / 2;
    this.pos.set(STANCE_MID[0], 0, STANCE_MID[1]);
    h.reset();
    this.apply();
    poseShot(h, s, u);
    // A shot with less turn than the capture (a push): take some of the pelvis turn out.
    if (use.turn < 1) {
      const dy = angDiff(ref.yaw0, yawOfQ(h.bones.hips.quaternion));
      h.bones.hips.quaternion.premultiply(_q.setFromAxisAngle(_up, -(1 - use.turn) * dy));
    }
    h.update();
    // The capture's feet now, in its stance and at contact (world).
    const M = this._mw || (this._mw = { L: new THREE.Vector3(), R: new THREE.Vector3(), sL: new THREE.Vector3(), sR: new THREE.Vector3(), cL: new THREE.Vector3(), cR: new THREE.Vector3(), kL: new THREE.Vector3(), kR: new THREE.Vector3(), qL: new THREE.Quaternion(), qR: new THREE.Quaternion(), H: new THREE.Vector3(), FL: new THREE.Vector3(), FR: new THREE.Vector3() });
    h.worldPos('ankleL', M.L); h.worldPos('ankleR', M.R); h.worldPos('hips', M.H);
    h.worldPos('kneeL', M.kL); h.worldPos('kneeR', M.kR);
    h.bones.ankleL.getWorldQuaternion(M.qL); h.bones.ankleR.getWorldQuaternion(M.qR);
    M.sL.copy(ref.sL).applyMatrix4(h.root.matrixWorld); M.sR.copy(ref.sR).applyMatrix4(h.root.matrixWorld);
    M.cL.copy(ref.cL).applyMatrix4(h.root.matrixWorld); M.cR.copy(ref.cR).applyMatrix4(h.root.matrixWorld);
    // Knee poles: the way the capture bends them.
    for (const sd of ['L', 'R']) {
      const k = M['k' + sd], hip = h.worldPos('hip' + sd, _a);
      _b.addVectors(hip, M[sd]).multiplyScalar(0.5);
      k.addScaledVector(_d.subVectors(k, _b), 1.0);
    }
    // The plan's feet: from the stance to where it puts them at contact. Each
    // foot moves as the capture's does (its progress along its own step and
    // its lift); a foot the capture hardly moves follows the plan's timing.
    const front = p.foot === 'front';
    const tLand = Math.max(p.tCommit + 0.12, Tc - 0.06);
    const k1 = sstep(p.tCommit, front ? tLand : mix(p.tCommit, tLand, 0.62), t);
    const k2 = sstep(mix(p.tCommit, tLand, front ? 0.55 : 0.3), tLand + (front ? 0.12 : 0), t);
    const ankleY = h.ankleHeight * sc;
    for (const sd of ['L', 'R']) {
      const g0x = sd === 'L' ? STANCE.footL[0] : STANCE.footR[0], g0z = sd === 'L' ? STANCE.footL[1] : STANCE.footR[1];
      const gx = p.feet[sd][0] - g0x, gz = p.feet[sd][1] - g0z, gl = Math.hypot(gx, gz);
      const m = M[sd], m0 = M['s' + sd], mc = M['c' + sd];
      const Dx = mc.x - m0.x, Dz = mc.z - m0.z, Dl2 = Dx * Dx + Dz * Dz;
      const dx = m.x - m0.x, dz = m.z - m0.z;
      let k, rx, rz, lift = 0;
      if (Dl2 > 0.08 * 0.08) {
        k = clamp((dx * Dx + dz * Dz) / Dl2, -0.2, 1.4);
        rx = clamp((dx - k * Dx) * 0.5, -0.12, 0.12); rz = clamp((dz - k * Dz) * 0.5, -0.12, 0.12);
        if (gl * gl > Dl2 * 2.2) lift = 0.05 * Math.sin(Math.PI * clamp(k, 0, 1)) * Math.min(1, gl / 0.4);   // a longer step than the capture's: pick it up more
      } else {
        k = (sd === 'L') === front ? k1 : k2;
        rx = clamp(dx * 0.5, -0.12, 0.12); rz = clamp(dz * 0.5, -0.12, 0.12);
        lift = 0.085 * Math.sin(Math.PI * k) * Math.min(1, gl / 0.3);
      }
      const F = M['F' + sd];
      F.set(g0x + k * gx + rx, Math.max(ankleY * 0.95, m.y) + lift, g0z + k * gz + rz);
    }
    // Pelvis: where the capture has it between its feet (along and across the
    // line of the feet), and as high.
    const lx = M.L.x - M.R.x, lz = M.L.z - M.R.z, ll = Math.hypot(lx, lz);
    const Hg = _hp;
    if (ll > 0.12) {
      // (clamped: with the capture's feet close together a small sway would throw the pelvis far out)
      const a = clamp(((M.H.x - M.R.x) * lx + (M.H.z - M.R.z) * lz) / (ll * ll), -0.3, 1.3), b = clamp(((M.H.x - M.R.x) * -lz + (M.H.z - M.R.z) * lx) / ll, -0.3, 0.3);
      const gxl = M.FL.x - M.FR.x, gzl = M.FL.z - M.FR.z, gll = Math.hypot(gxl, gzl) || 1;
      Hg.set(M.FR.x + a * gxl + b * -gzl / gll, M.H.y, M.FR.z + a * gzl + b * gxl / gll);
    } else Hg.set(M.H.x + (M.FL.x + M.FR.x - M.L.x - M.R.x) / 2, M.H.y, M.H.z + (M.FL.z + M.FR.z - M.L.z - M.R.z) / 2);
    // Legs too short for the plan's (longer) stride: sit lower.
    const legLen = (h.bones.kneeL.position.length() + h.bones.ankleL.position.length()) * sc;
    for (let pass = 0; pass < 2; pass++) {
      const shiftX = Hg.x - M.H.x, shiftY = Hg.y - M.H.y, shiftZ = Hg.z - M.H.z;
      let drop = 0;
      for (const sd of ['L', 'R']) {
        const hj = h.worldPos('hip' + sd, _a).add(_b.set(shiftX, shiftY, shiftZ)), F = M['F' + sd];
        const d = hj.distanceTo(F), over = d - legLen * 0.992;
        if (over > 0) drop = Math.max(drop, over * d / Math.max(0.3, hj.y - F.y));
      }
      if (drop <= 0) break;
      Hg.y -= drop;
    }
    Hg.y = Math.max(Hg.y, M.H.y - 0.15);           // never much lower than the capture (no collapsing)
    // Move the pelvis (and the knee poles with it).
    _d.subVectors(Hg, M.H);
    M.kL.add(_d); M.kR.add(_d);
    h.bones.hips.position.copy(h.bones.hips.parent.worldToLocal(_e.copy(Hg)));
    h.update();
    for (const sd of ['L', 'R']) {
      h.ikLeg(sd, M['F' + sd], M['k' + sd]);
      h.setWorldQuat('ankle' + sd, M['q' + sd]);
    }
    // A deep stride (the pelvis sat lower to reach the plan's feet) can put the
    // front knee into the turf: up by that much, the feet staying where they are.
    h.update();
    const kneeLow = h.lowest(h._kneeIdx || (h._kneeIdx = [h.boneList.indexOf(h.bones.kneeL), h.boneList.indexOf(h.bones.kneeR)]));
    if (kneeLow < 0) {
      Hg.y -= kneeLow;
      h.bones.hips.position.copy(h.bones.hips.parent.worldToLocal(_e.copy(Hg)));
      h.update();
      for (const sd of ['L', 'R']) { h.ikLeg(sd, M['F' + sd], M['k' + sd]); h.setWorldQuat('ankle' + sd, M['q' + sd]); }
    }
    // (the capture's toes pointed down / rolled: up onto them, not into the turf)
    h.update(); h.clearFoot('L'); h.clearFoot('R');
    this.legsClearOfBat(batPos, batQuat);
    this.footL.set(M.FL.x, 0, M.FL.z); this.footR.set(M.FR.x, 0, M.FR.z);
    // Turn the shoulders toward the hands where the capture's are turned away.
    h.update();
    const ch = h.worldPos('chest', _ch);
    h.bones.chest.getWorldQuaternion(_ql);
    _f.set(0, 0, 1).applyQuaternion(_ql);
    const want = Math.atan2(batPos.x - ch.x, batPos.z - ch.z), have = Math.atan2(_f.x, _f.z);
    const dyaw = clamp(angDiff(have, want), -1.2, 1.2) * 0.45;
    for (const [b, f] of [['spine', 0.45], ['chest', 0.55]]) {
      h.bones[b].getWorldQuaternion(_ql);
      h.setWorldQuat(b, _ql.premultiply(_q.setFromAxisAngle(_up, dyaw * f)));
    }
    // The capture leans well out to the off side through the finish (seen
    // front-on, a batter falling over): keep the head within a little of the
    // feet across the pitch.
    h.update();
    const hd = h.worldPos('head', _v1), off = hd.x - Math.max(M.FL.x, M.FR.x) - 0.1;
    if (off > 0) {
      const T = hd.distanceTo(h.worldPos('spine', _v2));
      h.bones.spine.getWorldQuaternion(_ql);
      h.setWorldQuat('spine', _ql.premultiply(_q.setFromAxisAngle(_zAxis, Math.asin(clamp(off / T, 0, 0.6)))));
    }
    // Hands still out of reach: lean the trunk toward the bat.
    h.update();
    const top = _top.copy(batPos).addScaledVector(_e.set(0, 1, 0).applyQuaternion(batQuat), 0.105);
    const over = Math.max(h.worldPos('shoulderR', _a).distanceTo(batPos), h.worldPos('shoulderL', _b).distanceTo(top)) - (this.armLen * sc / this.armScale0 + PALM * 0.8) * 0.985;
    if (over > 0) {
      const hp = h.worldPos('spine', _v1), chp = h.worldPos('chest', _v2);
      _x.subVectors(chp, hp).normalize();
      _y.subVectors(batPos, hp).normalize();
      _z.copy(_x).lerp(_y, clamp(over / 0.45, 0, 0.6)).normalize();
      h.bones.spine.getWorldQuaternion(_ql);
      h.setWorldQuat('spine', _ql.premultiply(_q.setFromUnitVectors(_x, _z)));
    }
    // Front elbow up and leading through a straight-bat front-foot shot.
    const kf = sstep(Tc - 0.03, Tc + (p.Tf || 0.2), t);
    this._elbowUp = front && p.shot.type !== 'flick' ? sstep(p.tCommit, Tc - 0.05, t) * (1 - 0.6 * kf) : 0;
    this.gripBat(batPos, batQuat, this._elbowUp);
    // Where the batter is (for the runner taking over after the shot): under the pelvis.
    h.worldPos('hips', _a);
    this.pos.set(_a.x, 0, _a.z);
  }

  batProcedural(dt, batPos, batQuat, opts) {
    const h = this.h, t = opts.t;
    this.mode = 'bat';
    this.bat.position.copy(batPos);
    this.bat.quaternion.copy(batQuat);
    const fl = _a.set(STANCE.footL[0], 0, STANCE.footL[1]);
    const fr = _b.set(STANCE.footR[0], 0, STANCE.footR[1]);
    let hipsDrop = STANCE_KNEES, lean = STANCE_LEAN, weight = 0.5, heel = 0, elbowUp = 0, swing = null, open = FRONT_OPEN;
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
        lean = mix(lean, front ? 0.66 : type === 'cut' ? 0.4 : 0.22, kw) - (front ? 0.26 : 0.02) * kf * big;   // head over the front knee on the drive
        if (front) { heel = kf * big; elbowUp = sstep(p.tCommit, Tc - 0.05, t) * (1 - 0.6 * kf); open += 0.3 * kL; }
        // How a real hitter's body turns through a swing (measured from motion
        // capture): the hips coil, then lead the shoulders round; the back heel
        // comes up and the foot turns on its toe. Scaled to the shot.
        const amp = SWING_AMP[type] ?? 0.4;
        if (amp > 0) {
          swingAt(t - Tc, _sw);
          const fade = 1 - sstep(Tc + (p.Tf || 0.2) + 0.5, Tc + (p.Tf || 0.2) + 1.3, t);
          swing = { hips: _sw.pelvisYaw * amp * fade, chest: _sw.chestYaw * amp * fade, pivot: _sw.pivot * amp * fade };
          heel = Math.max(heel, clamp(_sw.heel * 2 * amp, 0, 1) * fade);
        }
        // Relax once the shot is played.
        const tRest = Tc + (p.Tf || 0.2) + 0.5;
        if (t > tRest) {
          const kr = sstep(tRest, tRest + 0.8, t);
          hipsDrop = mix(hipsDrop, 0.05, kr); lean = mix(lean, 0.16, kr); heel *= 1 - kr;
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
    if (adv > 0.001) {                               // skipping down the pitch (and scrambling back)
      const ph = adv / 0.55 * Math.PI * 2;
      fl.z -= adv + 0.1 * Math.max(0, Math.sin(ph)); fr.z -= adv - 0.1 * Math.max(0, Math.sin(ph));
      fl.y += 0.06 * Math.max(0, Math.sin(ph)); fr.y += 0.06 * Math.max(0, -Math.sin(ph));
    }
    let heading = Math.PI / 2;
    const H = _H, sc = h.root.scale.x;
    if (opts.head) {
      // You: side-on feet under where you stand (they step to keep up), and a
      // batter's stance however you are really standing: the head comes down
      // and forward over the toes (up to STANCE_DROP lower than you hold
      // yours), the knees bend and the hips go back. Crouch lower yourself and
      // the body follows you down.
      // Across the pitch the body lines up on the hands (shoulders out over
      // them, as in a real stance), wherever you hold them.
      const realY = opts.head.y - 0.11, stand = this.headRestY * sc;           // head joint: a little below the eyes
      const drop = clamp(realY - (stand - STANCE_DROP), 0, STANCE_DROP - 0.04);
      this.handX = this.handX == null ? batPos.x : this.handX + (batPos.x - this.handX) * Math.min(1, dt * 2.5);
      const hx = clamp(mix(opts.head.x + 0.05 + 0.6 * drop, this.handX + 0.14, 0.6), opts.head.x - 0.25, opts.head.x + 0.35);
      H.set(hx, realY - drop, opts.head.z);
      heading = this.stepFeet(dt, H, batPos, fl, fr, !!(opts.sweep && opts.sweep.k > 0.05));
      open = this.step.open;
      pinBack(fr, opts.crease);
      // (your back foot held where it really is while you lean far out: the front foot comes no further than a real stride)
      const st = Math.hypot(fl.x - fr.x, fl.z - fr.z);
      if (st > MAX_STRIDE) { fl.x = fr.x + (fl.x - fr.x) * MAX_STRIDE / st; fl.z = fr.z + (fl.z - fr.z) * MAX_STRIDE / st; }
      const wide = Math.hypot(fl.x - fr.x, fl.z - fr.z) || 1;
      weight = clamp(0.5 + ((H.x - (fl.x + fr.x) / 2) * (fl.x - fr.x) + (H.z - (fl.z + fr.z) / 2) * (fl.z - fr.z)) / (wide * wide) * 0.9, 0.2, 0.8);
    } else {
      // No headset (the AI, or you on a monitor): the head goes where the stance puts it.
      const sl = Math.sin(lean), px = mix(fr.x, fl.x, weight), pz = mix(fr.z, fl.z, weight);
      H.set(px + (0.1 + 0.42 * sl) + (batPos.x - px) * 0.12, this.headRestY * sc - hipsDrop - this.spineLen * sc * (1 - Math.cos(lean)) * 0.9, pz + (batPos.z - pz) * 0.12);
    }
    const sweep = opts.sweep && opts.sweep.k > 0.01 ? opts.sweep : null;
    if (sweep) {
      // Sweep: a long stride to the pitch of the ball, down on the back knee,
      // head over the front knee.
      const k = sweep.k, fx = Math.sin(heading), fz = Math.cos(heading), lx = fz, lz = -fx;
      fl.x = mix(fl.x, fr.x + lx * 0.66 + fx * 0.1, k); fl.z = mix(fl.z, fr.z + lz * 0.66 + fz * 0.1, k);
      weight = mix(weight, 0.36, k);
      const hy = (this.kneelHipY + this.spineLen * (sweep.slog ? 0.9 : 0.8)) * sc;
      H.x = mix(H.x, fr.x + lx * 0.46 + fx * 0.2, k); H.z = mix(H.z, fr.z + lz * 0.46 + fz * 0.2, k);
      H.y = Math.min(H.y, mix(H.y, hy, k));
    }
    this.footL.copy(fl); this.footR.copy(fr);
    this.solveBody({ heading, weight, head: H, batPos, batQuat, elbowUp, heel, sweep, swing, t, yawL: heading + open, yawR: heading - 0.04 });
    if (opts.ball) h.lookAt(opts.ball, 1, 1.7);
    else h.lookAt(_c.set(0.4, 1.9, -18.8), 1, 1.7);
    h.syncShadow();
  }

  // Your feet. A batter stands side-on (toes toward point, the front foot
  // opened a little toward the bowler), about shoulder width apart, whichever
  // way you happen to be looking. They are planted and step one at a time:
  // lean into a front-foot shot and the front foot strides out while the back
  // foot stays where it is; go back and the back foot moves first. Returns
  // the heading (side-on); the front foot's opening is left in this.step.open.
  stepFeet(dt, head, batPos, fl, fr, hold = false) {
    const S = this.step || (this.step = { L: new THREE.Vector3(), R: new THREE.Vector3(), mL: null, mR: null, init: false, ax: 0, open: FRONT_OPEN });
    const yaw = Math.PI / 2;
    // Across the pitch: the ankles a little behind the head (it is out over the toes).
    const ax = head.x - 0.3;
    S.ax = S.init ? S.ax + (ax - S.ax) * Math.min(1, dt * 2.5) : ax;
    // Along it: the front foot a little ahead of the head, further the more you
    // lean forward of your back foot; the back foot behind.
    const lunge = clamp(S.R.z - FOOT_BACK - head.z, 0, 0.7);
    _iL.set(S.ax + 0.03, 0, head.z - FOOT_FRONT - 0.45 * lunge);
    _iR.set(S.ax, 0, head.z + FOOT_BACK);
    if (!S.init || _iL.distanceTo(S.L) > 1.5 || _iR.distanceTo(S.R) > 1.5) { S.L.copy(_iL); S.R.copy(_iR); S.mL = S.mR = null; S.init = true; }
    if (!hold && !S.mL && !S.mR) {
      const eL = _iL.distanceTo(S.L) / 0.11, eR = _iR.distanceTo(S.R) / 0.24;
      const wide = Math.hypot(S.L.x - S.R.x, S.L.z - S.R.z);
      if (eL > 1 || eR > 1 || wide > 1.0 || wide < 0.22) {
        if (eL >= eR) S.mL = { from: S.L.clone(), k: 0, dur: 0.15 }; else S.mR = { from: S.R.clone(), k: 0, dur: 0.17 };
      }
    }
    for (const side of ['L', 'R']) {
      const ideal = side === 'L' ? _iL : _iR, foot = S[side], key = 'm' + side, m = S[key];
      if (!m) continue;
      m.k += dt / m.dur;
      const e = sstep(0, 1, m.k);
      foot.lerpVectors(m.from, ideal, e);
      foot.y = 0.07 * Math.sin(Math.PI * clamp(m.k, 0, 1));
      if (m.k >= 1) { foot.y = 0; S[key] = null; }
    }
    fl.copy(S.L); fr.copy(S.R);
    // The front foot turns toward the bowler as it strides.
    const stride = Math.max(0, S.R.z - S.L.z - 0.45);
    S.open = clamp(FRONT_OPEN + 0.55 * stride, FRONT_OPEN, 0.8);
    return yaw;
  }

  // Pose the whole body from where the feet are, where the head is and where
  // the bat is: hips back and down, trunk leaning to the head, shoulders
  // turned to the hands, then legs and arms by IK.
  solveBody(o) {
    const h = this.h, sc = h.root.scale.x, H = o.head, batPos = o.batPos, batQuat = o.batQuat;
    const fl = this.footL, fr = this.footR;
    const s = Math.sin(o.heading), c = Math.cos(o.heading);
    this.heading = o.heading;
    this.pos.set(mix(fr.x, fl.x, o.weight), 0, mix(fr.z, fl.z, o.weight));
    h.reset();
    this.apply();
    const T = this.spineLen * sc, hipTop = h.hipsRest.y * sc;
    const crouch = Math.max(0, this.headRestY * sc - H.y);
    // Pelvis: between the feet and the head, pushed well back as you bend (a
    // batter hinges at the hips with the knees only softly bent).
    const back = 0.04 + 0.95 * crouch;
    let px = this.pos.x + (H.x - this.pos.x) * 0.22 - s * back, pz = this.pos.z + (H.z - this.pos.z) * 0.22 - c * back;
    let d = Math.hypot(H.x - px, H.z - pz);
    if (d > 0.88 * T) { const k = 0.88 * T / d; px = H.x + (px - H.x) * k; pz = H.z + (pz - H.z) * k; d = 0.88 * T; }
    const sw = o.sweep ? o.sweep.k : 0;
    // (not a sweep: the pelvis never comes down to a kneel, however far your head goes)
    const hipMin = mix(this.kneelHipY * sc + 0.1, 0.28, sw);
    let py = clamp(H.y - Math.sqrt(T * T - d * d), hipMin, hipTop);
    const hipMax = mix(hipTop, this.kneelHipY * sc, sw);
    if (sw > 0) { py = Math.min(py, hipMax); px = mix(px, fr.x + (fl.x - fr.x) * 0.22, sw); pz = mix(pz, fr.z + (fl.z - fr.z) * 0.22, sw); }
    const setHips = () => {
      const dx = px - this.pos.x, dz = pz - this.pos.z;
      h.bones.hips.position.set((dx * c - dz * s) / sc, py / sc, (dx * s + dz * c) / sc);
    };
    setHips();
    // Lean the trunk so the head is where it should be.
    _v1.set(H.x - px, H.y - py, H.z - pz).normalize();
    _v2.set(_v1.x * c - _v1.z * s, _v1.y, _v1.x * s + _v1.z * c);          // into the root's frame
    _ql.setFromUnitVectors(this.spineRest, _v2);
    h.bones.hips.quaternion.identity().slerp(_ql, 0.3);
    h.bones.spine.quaternion.identity().slerp(_ql, 0.4);
    h.bones.chest.quaternion.identity().slerp(_ql, 0.3);
    // Turn the hips, trunk and shoulders to the hands (coil in the backlift,
    // open up through the ball).
    h.update();
    const chest = h.worldPos('chest', _c);
    const hx = batPos.x - chest.x, hz = batPos.z - chest.z;
    const yaw = clamp(Math.atan2(hx * c - hz * s, Math.max(0.05, hx * s + hz * c)), -1.3, 1.45);
    let yh = yaw * 0.2, ys = yaw * 0.3, yc = yaw * 0.44;
    if (o.swing) {
      // The hips turn as a real hitter's do (they lead); the shoulders settle
      // between that and where the hands are, so the arms still reach the bat.
      const total = clamp(mix(yaw * 0.94, o.swing.chest, 0.5), -1.4, 1.9);
      yh = clamp(o.swing.hips, -0.7, 1.5);
      ys = (total - yh) * 0.4; yc = (total - yh) * 0.6;
    }
    h.addRot('hips', 0, yh, 0);
    h.addRot('spine', 0, ys, 0);
    h.addRot('chest', 0.018 * Math.sin(o.t * 1.6), yc, 0);
    // Slide the pelvis so the head lands exactly on its target…
    h.update();
    h.worldPos('head', _d);
    if (sw < 1) { px += (H.x - _d.x) * (1 - sw); pz += (H.z - _d.z) * (1 - sw); }
    py = clamp(py + H.y - _d.y, hipMin, hipMax);
    setHips();
    // …and if the bat is still out of reach, go with it.
    h.update();
    const top = _top.copy(batPos).addScaledVector(_e.set(0, 1, 0).applyQuaternion(batQuat), 0.105);
    const over = Math.max(h.worldPos('shoulderR', _a).distanceTo(batPos), h.worldPos('shoulderL', _b).distanceTo(top)) - (this.armLen * sc / this.armScale0 + PALM * 0.8) * 0.985;   // the hands reach a palm past the wrist
    if (over > 0) {
      const sh = h.worldPos('chest', _c);
      _v1.set(batPos.x - sh.x, batPos.y - sh.y, batPos.z - sh.z).normalize().multiplyScalar(Math.min(0.35, over));
      px += _v1.x * (1 - sw); pz += _v1.z * (1 - sw); py = clamp(py + _v1.y, hipMin, hipMax);
      setHips();
    }
    this.forward(_fwd);
    _left.set(_fwd.z, 0, -_fwd.x);
    if (sw > 0.01) this.kneel(o.sweep, sw);
    else this.plantFeetYaw(fl, fr, o.yawL ?? o.heading, o.yawR ?? o.heading, o.heel > 0.01 ? 0.75 * o.heel : 0);
    if (o.swing && Math.abs(o.swing.pivot) > 0.01) h.addRot('ankleR', 0, clamp(o.swing.pivot, -0.3, 1.2), 0);   // the back foot turns on its toe
    if (sw <= 0.01) { h.update(); h.clearFoot('L'); h.clearFoot('R'); this.legsClearOfBat(batPos, batQuat); }
    this.gripBat(batPos, batQuat, o.elbowUp);
  }

  // Feet flat on the ground with their own toe directions, knees over the toes.
  // toeR: the back heel up by this angle (rad), pivoting on the ball of the
  // foot: the ankle rises with it (rotating the foot about the ankle instead
  // would push the toes into the turf).
  plantFeetYaw(fl, fr, yawL, yawR, toeR = 0) {
    const h = this.h;
    h.update();
    for (const [side, target, yaw] of [['L', fl, yawL], ['R', fr, yawR]]) {
      h.worldPos('knee' + side, _pole).add(_e.set(Math.sin(yaw) * 0.7, 0, Math.cos(yaw) * 0.7));
      _ft.copy(target); _ft.y += h.ankleHeight * h.root.scale.y;
      if (side === 'R' && toeR > 0) {
        const fx = Math.sin(yaw), fz = Math.cos(yaw), b = h.toeLength * h.root.scale.y;
        _ft.x += fx * b * (1 - Math.cos(toeR)); _ft.z += fz * b * (1 - Math.cos(toeR)); _ft.y += b * Math.sin(toeR);
      }
      h.ikLeg(side, _ft, _pole);
    }
    h.setWorldQuat('ankleL', _q.setFromAxisAngle(_up, yawL));
    h.setWorldQuat('ankleR', _q.setFromAxisAngle(_up, yawR));
    if (toeR > 0) h.addRot('ankleR', toeR, 0, 0);
  }

  // The captured sweep at its lowest (the finish, settled): legs relative to
  // the hips in the figure's own frame, hip height, feet orientations. Null
  // without the capture.
  sweepTemplate() {
    if (this._sweepT !== undefined) return this._sweepT;
    const use = shotFor('sweep');
    if (!use) return null;            // (asked again later: the shots may still be loading)
    const h = this.h, s = use.shot, T = {};
    const snap = h.snapshot();
    h.reset();
    poseShot(h, s, Math.min(s.dur, s.events.finish + 0.15));
    h.update();
    _mi.copy(h.root.matrixWorld).invert();
    h.root.getWorldQuaternion(_ql).invert();
    for (const n of ['hips', 'hipL', 'hipR', 'kneeL', 'kneeR', 'ankleL', 'ankleR']) T[n] = h.worldPos(n, new THREE.Vector3()).applyMatrix4(_mi);
    for (const n of ['ankleL', 'ankleR']) T['q' + n] = h.bones[n].getWorldQuaternion(new THREE.Quaternion()).premultiply(_ql);
    T.hipY = T.hips.y;
    h.blendFrom(snap, 0);          // put back whatever was posed
    h.update();
    return (this._sweepT = T);
  }

  // Sweep: down on the back knee, front leg bent out in front. With the
  // capture: its legs (the back leg trailing well behind on the toe, the
  // front knee up over the front foot) at its height.
  kneel(sweep, k) {
    const h = this.h, fl = this.footL, fr = this.footR, T = this.sweepTemplate();
    h.update();
    const sc = h.root.scale.y;
    // Front foot flat, knee over the ankle (pole: the capture's front knee).
    _ft.copy(fl); _ft.y += h.ankleHeight * sc;
    if (T) _pole.subVectors(T.kneeL, T.hipL).multiplyScalar(2).applyQuaternion(h.root.getWorldQuaternion(_q)).multiplyScalar(sc).add(h.worldPos('hipL', _a)).add(_b.set(0, 0.3, 0));
    else _pole.copy(h.worldPos('hipL', _a).lerp(_ft, 0.5).add(_b.set(0, 0.8, 0)).addScaledVector(_fwd, 0.5));
    h.ikLeg('L', _ft, _pole);
    // Back leg: knee down behind the hip, shin and foot trailing behind it.
    h.worldPos('hipR', _a);
    if (T) {
      // The capture is a half-kneel (its back knee stays a hand off the
      // floor), so the knee still goes right down under the hip; the back
      // foot trails where the capture's does, halfway, on its toe.
      h.root.getWorldQuaternion(_q);
      _c.subVectors(T.ankleR, T.hipR).applyQuaternion(_q).multiplyScalar(sc).add(_a);
      _d.set(_a.x - _left.x * 0.42 - _fwd.x * 0.05, 0, _a.z - _left.z * 0.42 - _fwd.z * 0.05);
      _c.set(mix(_d.x, _c.x, 0.5), 0.09, mix(_d.z, _c.z, 0.5));
      _ft.set(mix(fr.x, _c.x, k), mix(fr.y + h.ankleHeight * sc, _c.y, k), mix(fr.z, _c.z, k));
      _pole.set(_a.x - _left.x * 0.05, -0.6, _a.z - _left.z * 0.05);
      h.ikLeg('R', _ft, _pole);
      h.setWorldQuat('ankleL', _ql.copy(_q).multiply(T.qankleL).slerp(_q, 0.5));
      h.setWorldQuat('ankleR', _ql.copy(_q).multiply(T.qankleR));
      h.update(); h.clearFoot('L'); h.clearFoot('R');          // the trailing foot on its toe, not through the turf
      return;
    }
    _ft.set(mix(fr.x, _a.x - _left.x * 0.42 - _fwd.x * 0.05, k), mix(fr.y + h.ankleHeight * h.root.scale.y, 0.09, k), mix(fr.z, _a.z - _left.z * 0.42 - _fwd.z * 0.05, k));
    h.ikLeg('R', _ft, _b.set(_a.x - _left.x * 0.05, -0.6, _a.z - _left.z * 0.05));
    h.root.getWorldQuaternion(_q);
    h.setWorldQuat('ankleL', _q);
    h.setWorldQuat('ankleR', _q.multiply(_toeDown));
    h.update(); h.clearFoot('L'); h.clearFoot('R');
  }

  // Both hands on the handle the way a batter holds it: top (left) hand above
  // the bottom one, the back of the top hand toward the face of the bat (the
  // bowler), the bottom hand's palm behind the handle, both thumbs down the
  // handle toward the blade and the handle running diagonally across each palm
  // (GRIP_BETA). The hands are placed from the bat; the arms reach them by IK
  // (elbows bending on their hinge), each hand may roll a little round the
  // handle to keep its wrist from bending too far, and the forearm takes half
  // of the hand's turn so the wrist doesn't wring.
  //
  // The hands are always on the handle (for you a hard rule: your gloves are
  // drawn on your real bat every frame, whatever the body is doing): a bat out
  // of the arms' reach first leans the trunk toward it, and for your figure
  // (stretchArms) the arms then lengthen by what is still missing.
  gripBat(batPos, batQuat, elbowUp = 0) {
    const h = this.h;
    this.restArms();
    h.update();
    _bx.set(1, 0, 0).applyQuaternion(batQuat);
    _by.set(0, 1, 0).applyQuaternion(batQuat);
    _bz.set(0, 0, 1).applyQuaternion(batQuat);
    this.forward(_fwd);
    _left.set(_fwd.z, 0, -_fwd.x);
    this.reachLean(batPos, _top.copy(batPos).addScaledVector(_by, HAND_GAP));
    if (this.stretchArms) this.reachShift(batPos, _top.copy(batPos).addScaledVector(_by, HAND_GAP));
    h.worldPos('shoulderR', _sR); h.worldPos('shoulderL', _sL);
    h.worldPos('chest', _ch);
    const sb = Math.sin(GRIP_BETA), cb = Math.cos(GRIP_BETA);
    let err = 0;
    for (const side of ['R', 'L']) {
      const at = side === 'R' ? _c.copy(batPos) : _top.copy(batPos).addScaledVector(_by, HAND_GAP), sh = side === 'R' ? _sR : _sL;
      // Elbows: down and in, close to the ribs (only a little out along the
      // pitch); the front (top-hand) elbow rises and leads toward the bowler
      // through a straight-bat shot.
      const sign = side === 'R' ? -1 : 1, lift = side === 'R' ? 0 : 0.75 * elbowUp;
      _pole.copy(sh).addScaledVector(_fwd, ELBOW_FWD).addScaledVector(_left, sign * 0.1).add(_e.set(0, -0.6 + 1.0 * lift, 0))
        .addScaledVector(_left, sign * 0.3 * lift);
      this.steadyPole(side, sh, at, _pole);
      let roll = 0;
      for (let pass = 0; pass < 2; pass++) {
        // The grip frame, rolled `roll` round the handle.
        const cr = Math.cos(roll), sr = Math.sin(roll);
        _xr.copy(_bx).multiplyScalar(cr).addScaledVector(_bz, -sr);
        _gx.copy(_bz).multiplyScalar(cr).addScaledVector(_bx, sr);          // back of the hand (left) / palm (right)
        _gy.copy(_xr).multiplyScalar(-sb).addScaledVector(_by, cb);
        _gz.copy(_xr).multiplyScalar(-cb).addScaledVector(_by, -sb);
        _wr.copy(at).addScaledVector(_gy, PALM);                            // the wrist, a palm's length from the handle
        h.ikArm(side, _wr, _pole);
        if (pass) {
          if (this.stretchArms) this.stretchTo(side, _wr, _pole);
          break;
        }
        // Roll toward the forearm: the knuckles (-gy) as near its line as the grip allows.
        h.update();
        _f.subVectors(_wr, h.worldPos('elbow' + side, _el)).normalize();
        roll = clamp(Math.atan2(-_f.dot(_bz), _f.dot(_bx)), -GRIP_ROLL, GRIP_ROLL);
      }
      h.setWorldQuat('hand' + side, _q.setFromRotationMatrix(_m.makeBasis(_gx, _gy, _gz)));
      err = Math.max(err, h.worldPos('hand' + side, _el).distanceTo(_wr));
      // Share the hand's turn with the forearm.
      const fore = h.bones['elbow' + side];
      fore.getWorldQuaternion(_ql);
      _v1.set(1, 0, 0).applyQuaternion(_ql);                                 // forearm's X
      _v2.set(0, 1, 0).applyQuaternion(_ql);                                 // forearm's axis
      _x.copy(_gx).addScaledVector(_v2, -_gx.dot(_v2));
      if (_x.lengthSq() > 1e-6) {
        _x.normalize();
        let tw = Math.atan2(_y.crossVectors(_v1, _x).dot(_v2), _v1.dot(_x));
        // (continuous from the last frame: across +-180 deg half of it would flip the forearm over)
        const tws = this._tw || (this._tw = { L: 0, R: 0 }), prev = tws[side];
        if (tw - prev > Math.PI) tw -= TAU; else if (tw - prev < -Math.PI) tw += TAU;
        if (Math.abs(tw) > 1.4 * Math.PI) tw -= Math.sign(tw) * TAU;
        tws[side] = tw;
        fore.quaternion.multiply(_qt.setFromAxisAngle(_up, tw * 0.5));
        fore.updateMatrixWorld(true);
        h.setWorldQuat('hand' + side, _q);
      }
    }
    this.gripErr = err;
  }

  // The elbow's pole, kept continuous: when the hand passes through the line
  // from the shoulder to the pole (hands low in front: the stance, every
  // downswing) the bend plane is undefined and the elbow would flip to the
  // other side in one frame. The bend direction (the pole across the
  // shoulder-hand line) turns at most ~0.3 rad a frame.
  steadyPole(side, sh, at, pole) {
    const S = this._eb || (this._eb = { L: new THREE.Vector3(), R: new THREE.Vector3(), okL: false, okR: false });
    const D = _v1.subVectors(at, sh); if (D.lengthSq() < 1e-8) return; D.normalize();
    const n = _v2.subVectors(pole, sh), len = n.length();
    n.addScaledVector(D, -n.dot(D));
    const prev = S[side];
    let have = S['ok' + side];
    if (have) { prev.addScaledVector(D, -prev.dot(D)); have = prev.lengthSq() > 1e-6; if (have) prev.normalize(); }
    if (n.lengthSq() < 1e-6 * len * len) { if (!have) return; n.copy(prev); } else n.normalize();
    if (have) {
      const a = Math.acos(clamp(prev.dot(n), -1, 1));
      if (a > 0.3) {
        // turn prev toward n by 0.3 rad about D (n and prev are both across D)
        _x.crossVectors(prev, n); if (_x.lengthSq() < 1e-8) _x.copy(D); else _x.normalize();
        n.copy(prev).applyAxisAngle(_x, 0.3);
      }
    }
    prev.copy(n); S['ok' + side] = true;
    pole.copy(sh).addScaledVector(D, 0.3).addScaledVector(n, Math.max(0.3, len));
  }

  // Arm bones back to their own length (after stretchTo).
  restArms() {
    if (!this._stretched) return;
    for (const [b, p] of Object.entries(this.armRest)) this.h.bones[b].position.copy(p);
    this._stretched = false;
  }

  // The bat beyond the arms' reach: lean the trunk (spine and chest) toward it,
  // up to ~40 deg, so that both shoulders come within reach of their hand.
  reachLean(bot, top) {
    const h = this.h, sc = h.root.scale.x, reach = (this.armLen * sc / this.armScale0 + PALM * 0.8) * 0.97;
    for (let pass = 0; pass < 2; pass++) {
      h.update();
      const over = Math.max(h.worldPos('shoulderR', _a).distanceTo(bot), h.worldPos('shoulderL', _b).distanceTo(top)) - reach;
      if (over <= 0.002) return;
      const sp = h.worldPos('spine', _v1), shm = _v2.addVectors(_a, _b).multiplyScalar(0.5);
      _x.subVectors(shm, sp); const L = _x.length(); _x.normalize();
      _y.addVectors(bot, top).multiplyScalar(0.5).sub(sp).normalize();
      const full = Math.acos(clamp(_x.dot(_y), -1, 1));
      if (full < 1e-3) return;
      const ang = Math.min(full, over / Math.max(0.2, L) * 1.1, pass ? 0.35 : 0.4);
      _q.setFromUnitVectors(_x, _y);
      _ql.identity().slerp(_q, ang / full);
      for (const [b, f] of [['spine', 0.55], ['chest', 0.45]]) {
        h.bones[b].getWorldQuaternion(_qt);
        h.setWorldQuat(b, _qt.premultiply(_q.identity().slerp(_ql, f)));
      }
    }
  }

  // Still well out of reach after leaning (your figure down on its knee for a
  // sweep while you stand, a stride that left your hands behind): the pelvis
  // goes toward the bat (up to 0.45 m), the feet staying where they are.
  reachShift(bot, top) {
    const h = this.h, sc = h.root.scale.x, reach = (this.armLen * sc / this.armScale0 + PALM * 0.8) * 1.04;
    h.update();
    const over = Math.max(h.worldPos('shoulderR', _a).distanceTo(bot), h.worldPos('shoulderL', _b).distanceTo(top)) - reach;
    if (over <= 0) return;
    const S = this._rs || (this._rs = { aL: new THREE.Vector3(), aR: new THREE.Vector3(), kL: new THREE.Vector3(), kR: new THREE.Vector3(), qL: new THREE.Quaternion(), qR: new THREE.Quaternion(), d: new THREE.Vector3() });
    for (const sd of ['L', 'R']) { h.worldPos('ankle' + sd, S['a' + sd]); h.worldPos('knee' + sd, S['k' + sd]); h.bones['ankle' + sd].getWorldQuaternion(S['q' + sd]); }
    S.d.addVectors(bot, top).multiplyScalar(0.5).sub(_v1.addVectors(_a, _b).multiplyScalar(0.5)).normalize().multiplyScalar(Math.min(0.45, over));
    const hips = h.bones.hips;
    hips.getWorldPosition(_v1).add(S.d);
    hips.position.copy(hips.parent.worldToLocal(_v1));
    h.update();
    for (const sd of ['L', 'R']) {
      h.ikLeg(sd, S['a' + sd], S['k' + sd].add(S.d));
      h.setWorldQuat('ankle' + sd, S['q' + sd]);
    }
  }

  // Still out of reach after the IK: lengthen the upper arm and forearm (same
  // share each) until the wrist is on its target, at most by half again.
  stretchTo(side, target, pole) {
    const h = this.h;
    h.update();
    if (h.worldPos('hand' + side, _el).distanceTo(target) < 0.002) return;
    const sh = h.worldPos('shoulder' + side, _a), d = sh.distanceTo(target);
    const L = h.worldPos('elbow' + side, _b).distanceTo(sh) + _b.distanceTo(_el);
    if (d <= L * 0.999) return;                          // (in reach: nothing to stretch)
    const k = Math.min(1.5, d / L * 1.0005);
    h.bones['elbow' + side].position.copy(this.armRest['elbow' + side]).multiplyScalar(k);
    h.bones['hand' + side].position.copy(this.armRest['hand' + side]).multiplyScalar(k);
    this._stretched = true;
    h.ikArm(side, target, pole);
  }

  // Generic locomotion (running between the wickets / walking), carrying the bat.
  updateMoving(dt, t, look = null, diving = false) {
    const h = this.h;
    this.mode = 'run';
    this.gait(dt);
    h.reset();
    if (this.speed > 0.2) this.locomote(t);
    else this.idle(t);
    this.poseKey = diving ? 'dive' : this.speed > 0.2 ? 'move' : 'stand';
    this.apply();
    if (this.speed <= 0.2 && !clipsReady()) {
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

  // Full-length dive for the crease. dv = { t: s since the launch, down: s
  // since coming to rest (0 while still moving) }. Tip forward, go horizontal,
  // land on the chest and slide with the bat stretched out along the ground
  // in front; then push up again.
  updateDive(dt, t, dv) {
    const h = this.h, sc = h.root.scale.y;
    this.mode = 'run';
    this.poseKey = 'dive';
    const u = dv.t, up = dv.down > 0 ? sstep(0.3, 0.85, dv.down) : 0;
    const go = sstep(0, 0.2, u) * (1 - up);                 // committing: arms and bat thrown forward
    const flat = sstep(0.08, 0.36, u) * (1 - up);           // body horizontal
    const ground = sstep(0.26, 0.44, u);                    // chest on the turf
    h.reset();
    h.bones.hips.position.y = mix(mix(h.hipsRest.y * 0.9, 0.2 / sc, ground), h.hipsRest.y * 0.8, up);
    h.rot('hips', 1.46 * flat + 0.45 * go * (1 - flat) + 0.5 * up * (1 - up) * 2, 0, 0);
    h.rot('spine', -0.16 * flat * ground + 0.3 * go * (1 - flat), 0, 0);
    h.rot('chest', -0.14 * flat * ground, 0, 0);
    h.rot('neck', -0.5 * flat, 0, 0); h.rot('head', -0.45 * flat, 0, 0);             // eyes on the line
    h.rot('shoulderR', -2.95 * go, 0, -0.06); h.rot('elbowR', -0.04, 0, 0);          // bat arm at full stretch
    h.rot('shoulderL', -2.35 * go, 0, 0.4 * flat); h.rot('elbowL', -0.55 * flat - 0.2, 0, 0);
    h.rot('hipL', -0.75 * go * (1 - flat) + 0.06 * flat - 0.9 * up * (1 - up) * 2, 0, 0.1); h.rot('kneeL', 0.9 * go * (1 - flat) + 0.12 * flat + 1.2 * up * (1 - up) * 2, 0, 0);
    h.rot('hipR', 0.5 * go * (1 - flat) + 0.14 * flat, 0, -0.1); h.rot('kneeR', 0.3 * go * (1 - flat) + 0.32 * flat * (1 - ground * 0.5), 0, 0);
    h.rot('ankleL', 0.95 * flat, 0, 0); h.rot('ankleR', 0.95 * flat, 0, 0);          // toes pointed back
    this.apply();
    this.smooth(dt, 0.1);
    // The bat: out in front of the right hand, toe down on the ground, sliding in.
    h.update();
    h.bones.handR.getWorldPosition(_a);
    this.forward(_fwd);
    const drop = Math.asin(clamp((_a.y - 0.03) / 0.8, -0.2, 0.9));                  // enough tilt for the toe to touch
    _y.set(-_fwd.x * Math.cos(drop), Math.sin(drop), -_fwd.z * Math.cos(drop));      // bat +Y: from the toe back up the handle
    _x.set(_fwd.z, 0, -_fwd.x);
    _z.crossVectors(_x, _y);                                                        // face down
    _q.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
    h.bones.handR.getWorldQuaternion(_ql);
    _ql.multiply(_carryRot);
    this.bat.quaternion.copy(_ql).slerp(_q, clamp(go + flat, 0, 1));
    this.bat.position.copy(_a);
    h.syncShadow();
  }

  // Bat in the right hand while running or standing: it carries on the line
  // of the forearm, so it hangs toe-down by the leg when the arm hangs and
  // points ahead when the arm is pumping; the toe never goes into the ground.
  carry() {
    const h = this.h;
    h.update();
    h.bones.handR.getWorldPosition(_a);
    h.bones.elbowR.getWorldPosition(_el);
    this.forward(_fwd);
    _f.subVectors(_a, _el).normalize().multiplyScalar(0.7).add(_b.set(0, -0.45, 0)).addScaledVector(_fwd, 0.18).normalize();
    const toeY = _a.y + _f.y * 0.8;
    if (toeY < 0.03) { _f.y += (0.03 - toeY) / 0.8; _f.normalize(); }
    _y.copy(_f).negate();                                     // bat +Y: back up the handle
    _z.copy(_fwd).addScaledVector(_y, -_fwd.dot(_y));         // face forward
    if (_z.lengthSq() < 1e-4) _z.set(_fwd.z, 0, -_fwd.x);
    _z.normalize();
    _x.crossVectors(_y, _z);
    this.bat.quaternion.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
    this.bat.position.copy(_a).addScaledVector(_f, PALM);
    this.batClearOfLegs();
    _y.set(0, 1, 0).applyQuaternion(this.bat.quaternion);
    // The fist round the handle.
    _f.subVectors(_a, _el);
    _f.addScaledVector(_y, -_f.dot(_y));
    if (_f.lengthSq() > 1e-6) {
      _f.normalize();
      _v1.copy(_f).negate();
      _v2.copy(_y).negate();
      _x.crossVectors(_v1, _v2);
      h.setWorldQuat('handR', _q.setFromRotationMatrix(_m.makeBasis(_x, _v1, _v2)));
    }
  }

  // Turn the bat about the grip (the hand) until its blade is clear of the
  // legs and pads (a carried bat swinging past the thigh / shin on the run, a
  // bat hanging by the knee). Iterated on the worst point of the blade.
  batClearOfLegs() {
    const h = this.h, bat = this.bat, sc = h.root.scale.y, G = BAT_GEO;
    h.update();
    const segs = _legSegs;
    h.worldPos('hipL', segs[0]); h.worldPos('kneeL', segs[1]); h.worldPos('ankleL', segs[2]);
    h.worldPos('hipR', segs[3]); h.worldPos('kneeR', segs[4]); h.worldPos('ankleR', segs[5]);
    for (let it = 0; it < 4; it++) {
      bat.updateMatrixWorld(true);
      _mi.copy(bat.matrixWorld).invert();
      let worst = 0;
      for (const [a, b] of LEG_PAIRS) {
        const r = (b === 1 || b === 4 ? THIGH_R : PAD_R) * sc;
        for (let i = 0; i <= 5; i++) {
          _bx.lerpVectors(segs[a], segs[b], i / 5);
          _bz.copy(_bx).applyMatrix4(_mi);                       // into the bat's frame
          const gap = r - G.bladeSdf(_bz);
          if (gap <= worst) continue;
          worst = gap;
          // the nearest point of the blade (box clamp; inside: straight across the face)
          _gx.set(clamp(_bz.x, -G.bladeHalf.x, G.bladeHalf.x), clamp(_bz.y, G.toeY, G.shoulderY), clamp(_bz.z, -G.bladeHalf.z, G.bladeHalf.z));
          _xr.subVectors(_gx, _bz);
          if (_xr.lengthSq() < 1e-8) _xr.set(0, 0, _bz.z >= 0 ? -1 : 1);
          _gx.applyMatrix4(bat.matrixWorld);
          _xr.transformDirection(bat.matrixWorld);
        }
      }
      if (worst < 0.003) break;
      // turn the bat about the grip so that blade point moves out of the leg
      _gy.subVectors(_gx, bat.position);
      const L = _gy.length();
      _gz.crossVectors(_gy, _xr);
      if (L < 1e-3 || _gz.lengthSq() < 1e-8) break;
      _qt.setFromAxisAngle(_gz.normalize(), Math.min(0.5, (worst + 0.01) / L));
      bat.quaternion.premultiply(_qt);
    }
  }

  // The bat is where the bat is (physics / your hands): if a pad is in it,
  // swing that knee out of its way (the foot stays planted, the leg turns
  // about the hip-ankle line).
  legsClearOfBat(batPos, batQuat) {
    const h = this.h, sc = h.root.scale.y;
    _by.set(0, 1, 0).applyQuaternion(batQuat);
    for (const side of ['L', 'R']) {
      for (let it = 0; it < 2; it++) {
        h.update();
        const hip = h.worldPos('hip' + side, _legSegs[0]), knee = h.worldPos('knee' + side, _legSegs[1]), ank = h.worldPos('ankle' + side, _legSegs[2]);
        let worst = 0;
        for (let i = 0; i <= 6; i++) {
          _bx.copy(batPos).addScaledVector(_by, BLADE_TOP - (BLADE_TOP - BLADE_TOE) * i / 6);
          for (const [a, b] of [[hip, knee], [knee, ank]]) {
            const q = closestOnSeg(_bx, a, b, _bz), gap = LEG_CLEAR * sc - _bx.distanceTo(q);
            if (gap > worst) { worst = gap; _xr.subVectors(q, _bx).setY(0); }
          }
        }
        if (worst < 0.004 || _xr.lengthSq() < 1e-8) break;
        h.bones['ankle' + side].getWorldQuaternion(_qt);
        _gy.copy(ank);
        _gx.copy(knee).addScaledVector(_xr.normalize(), 0.5 + worst * 4);
        h.ikLeg(side, _gy, _gx);
        h.setWorldQuat('ankle' + side, _qt);
      }
    }
  }

  // Non-striker style: bat grounded in front, leaning on it.
  updateLeaning(dt, t, look) {
    const h = this.h;
    this.mode = 'idle';
    this.poseKey = 'lean';
    h.reset();
    this.idle(t);
    this.apply();
    if (!clipsReady()) {
      this.footWorld(_a, 0.13, 0.03); this.footWorld(_b, -0.13, -0.02);
      plantFeet(h, _a, _b, this.forward(_c).multiplyScalar(0.6));
    }
    // Bat: toe grounded ~45 cm ahead to the right, handle up toward the hand.
    this.forward(_fwd);
    _left.set(_fwd.z, 0, -_fwd.x);
    // (wide enough of the right pad that the blade stays out of it)
    const toe = _c.copy(this.h.root.position).addScaledVector(_fwd, 0.44).addScaledVector(_left, -0.33);
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
const _pfL = new THREE.Vector3(), _pfR = new THREE.Vector3();
const _H = new THREE.Vector3(), _iL = new THREE.Vector3(), _iR = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _top = new THREE.Vector3();
const _ql = new THREE.Quaternion(), _ft = new THREE.Vector3(), _sR = new THREE.Vector3(), _sL = new THREE.Vector3(), _ch = new THREE.Vector3(), _pole = new THREE.Vector3();
const _hp = new THREE.Vector3(), _el = new THREE.Vector3(), _f = new THREE.Vector3(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _m = new THREE.Matrix4();
const _wr = new THREE.Vector3(), _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3(), _xr = new THREE.Vector3(), _gx = new THREE.Vector3(), _gy = new THREE.Vector3(), _gz = new THREE.Vector3(), _qt = new THREE.Quaternion();
// Blade from the shoulder to the toe, along the bat's +Y from the grip point (m).
const BLADE_TOP = CONFIG.bat.gripFromHandleTop - CONFIG.bat.handleLength, BLADE_TOE = BLADE_TOP - CONFIG.bat.bladeLength;
const THIGH_R = 0.12, PAD_R = 0.17;   // thigh (and the pad's flap), padded shin and knee roll: axis to surface (m)
const BAT_GEO = new BatGeometry(CONFIG.bat);
const LEG_CLEAR = 0.19;          // (legsClearOfBat) leg axis to the blade's centre line: the pad (to ~0.15 at the front) + a little
const LEG_PAIRS = [[0, 1], [1, 2], [3, 4], [4, 5]];
const _legSegs = [0, 1, 2, 3, 4, 5].map(() => new THREE.Vector3());
function closestOnSeg(p, a, b, out) {
  out.subVectors(b, a);
  const l2 = out.lengthSq();
  const t = l2 > 1e-9 ? clamp(_hp.subVectors(p, a).dot(out) / l2, 0, 1) : 0;
  return out.multiplyScalar(t).add(a);
}
const _toeDown = new THREE.Quaternion().setFromEuler(new THREE.Euler(1.25, 0, 0));
const _carryRot = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2 + 0.3, 0, 0));
