// AI batter (when you bowl). Pure JS.
//
// It reads the delivery (imperfectly: seam/spin movement is only partly
// anticipated, plus timing/position noise by difficulty), chooses
// leave / defend / drive / pull / cut / flick, and generates an analytic bat
// swing that aims the sweet spot at the predicted ball position. It is also a
// bat-pose *provider* for the physics world, so contact is resolved by exactly
// the same swept collision as the player's bat: it can middle it, edge it,
// miss it or be bowled. After the bounce it gets one late, partial correction.

import { Vec3, Quat, Pose, clamp, smoothstep } from '../physics/math.js';
import { BatGeometry } from '../physics/bat.js';
import { predict, crossingAtZ } from '../physics/trajectory.js';
import { CONFIG } from '../config.js';

export const AI_HOME = { x: -0.42, z: -1.0 };       // body position in stance
const STANCE_HAND = new Vec3(0.0, 0.97, -1.2);
const Q_STANCE = new Quat(0, 1, 0, 0);              // vertical, face to bowler
const UP = new Vec3(0, 1, 0);

// Rotation whose +Y = y and +Z = z (orthonormalised, right-handed).
export function basisQuat(y, z) {
  const Y = y.clone().normalize();
  const Z = z.clone().addScaled(Y, -z.dot(Y)).normalize();
  const X = new Vec3().crossVectors(Y, Z).normalize();
  return new Quat().setFromBasis(X, Y, Z);
}

// Shot templates. zc = contact plane; hand = rough hands offset from the
// contact point (defines the bat angle); speed = sweet-spot speed (m/s).
export const SHOTS = {
  drive:   { zc: -1.95, hand: [0, 0.55, -0.16], speed: 14, th: [-1.9, 1.7], loft: 0.02, foot: 'front', handMove: 0.18 },
  defend:  { zc: -1.8, hand: [0, 0.55, -0.22], speed: 2.0, th: [-0.45, 0.25], loft: -0.1, foot: 'front', handMove: -2.0 },
  backdef: { zc: -1.2, hand: [0, 0.55, -0.18], speed: 2.0, th: [-0.4, 0.2], loft: -0.1, foot: 'back', handMove: -2.0 },
  pull:    { zc: -1.35, hand: [-0.38, 0.12, 0.36], speed: 15, th: [-1.9, 1.9], loft: 0.1, foot: 'back', handMove: 0.12 },
  cut:     { zc: -1.0, hand: [-0.25, 0.5, -0.1], speed: 13, th: [-1.7, 1.5], loft: -0.03, foot: 'back', handMove: 0.12 },
  flick:   { zc: -1.6, hand: [0.06, 0.5, -0.12], speed: 11, th: [-1.5, 1.4], loft: 0.05, foot: 'front', handMove: 0.12 },
};

// What the batter perceives about a delivery.
export function analyzeDelivery(state, readFactor = 1, cfg = CONFIG) {
  const s = state.clone();
  s.seamDeg *= readFactor;
  s.seamRandomScale = 0;
  s.spin.scale(readFactor);
  const pred = predict(s, { cfg, maxTime: 2.5, sampleEvery: 1 / 240, wicket: true, stop: (b) => b.pos.z > 1.2 || b.bounces > 1 });
  const b0 = pred.bounces[0];
  const length = b0 ? -b0.pos.z : -1;
  const at = crossingAtZ(pred, -1.2) || { x: 0, y: 0.5, t: 0.5 };
  return { pred, length, xb: at.x, yb: at.y, tb: at.t, hitsStumps: !!pred.wicketHit };
}

// Shot selection. info from analyzeDelivery; skill = CONFIG.ai[difficulty];
// aggression 0..1. Returns { type, ang, loft }.
export function chooseShot(info, skill, aggression, rng = Math.random) {
  const r = typeof rng === 'function' ? rng : Math.random;
  const { length: L, xb, yb, hitsStumps } = info;
  const attack = r() < aggression;
  const mistake = r() < skill.mistakeRate;
  let type;
  if (L < 0) type = 'drive';                                // full toss: hit it
  else if (yb > 1.3) {                                      // bouncer
    if (xb > 0.35 && attack) type = 'cut';
    else if (attack || (yb < 1.6 && r() < 0.5)) type = 'pull';
    else type = 'duck';
  } else if (L > 8.0 && yb > 0.75) {                        // short of a length
    if (xb > 0.3) type = attack || mistake ? 'cut' : 'leave';
    else if (xb < -0.12) type = attack ? 'pull' : 'backdef';
    else type = hitsStumps ? (attack && yb > 0.95 ? 'pull' : 'backdef') : (attack ? 'pull' : 'leave');
  } else if (L < 4.2) {                                     // full / half-volley / yorker
    if (xb > 0.55) type = attack || mistake ? 'drive' : 'leave';
    else if (xb < -0.25) type = 'flick';
    else type = L < 1.4 ? (attack ? 'drive' : 'defend') : 'drive';
  } else {                                                  // good length
    if (hitsStumps) type = attack && L < 6.2 ? 'drive' : 'defend';
    else if (xb > 0.22) type = mistake ? 'defend' : attack && xb > 0.45 && L < 6 ? 'drive' : 'leave';
    else if (xb < -0.2) type = 'flick';
    else type = attack ? 'drive' : 'defend';
  }
  if (type === 'duck') return { type: 'leave', duck: true, ang: 0, loft: 0 };
  if (type === 'leave') return { type: 'leave', ang: 0, loft: 0 };
  const t = SHOTS[type];
  let ang = 0;
  if (type === 'drive') ang = clamp(xb * 2.2, -0.55, 0.8);
  else if (type === 'defend' || type === 'backdef') ang = clamp(xb * 1.1, -0.3, 0.4);
  else if (type === 'pull') ang = -0.75 + (r() - 0.5) * 0.4;
  else if (type === 'cut') ang = 1.2 + (r() - 0.5) * 0.3;
  else if (type === 'flick') ang = -0.7 + (r() - 0.5) * 0.3;
  let loft = t.loft;
  if (type === 'drive' || type === 'pull') loft += aggression * 0.3 * r();
  return { type, ang, loft };
}

export class AIBatter {
  constructor(cfg = CONFIG) {
    this.cfg = cfg;
    this.geom = new BatGeometry(cfg.bat);
    this.R = cfg.ball.radius;
    this.plan = null;
    this.skill = cfg.ai.medium;
    this.aggression = 0.4;
    this.stancePose = new Pose(STANCE_HAND.clone(), Q_STANCE.clone());
    this._pose = new Pose();
    this._q = new Quat();
    this._v = new Vec3();
  }

  setDifficulty(d) { this.skill = this.cfg.ai[d] || this.cfg.ai.medium; }

  reset() { this.plan = null; }

  // Called at release with the live ball state (cloned) and the release time.
  planDelivery(state, t0, rng = Math.random) {
    const r = typeof rng === 'function' ? rng : Math.random;
    const gauss = () => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const info = analyzeDelivery(state, this.skill.readFactor, this.cfg);
    const shot = chooseShot(info, this.skill, this.aggression, r);
    const plan = { shot, info, t0, tCommit: t0 + this.cfg.ai.reactionTime };
    if (shot.type === 'leave') {
      plan.leavePose = shot.duck
        ? new Pose(new Vec3(-0.62, 0.92, -1.0), Q_STANCE.clone())
        : new Pose(new Vec3(-0.3, 1.45, -0.92), basisQuat(new Vec3(0.1, -0.55, -0.83), new Vec3(0, 0.83, -0.55)));
      plan.tSwingStart = plan.tCommit + 0.25;
      plan.tSwingEnd = plan.tSwingStart;
      this.plan = plan;
      return plan;
    }
    const T = SHOTS[shot.type];
    let zc = T.zc;
    if (shot.type === 'drive' && info.length >= 0 && info.length < 1.6) zc = -1.35; // dig out yorkers
    const c = crossingAtZ(info.pred, zc) || crossingAtZ(info.pred, -1.2);
    if (!c) { plan.shot = { type: 'leave', ang: 0, loft: 0 }; plan.leavePose = this.stancePose.clone(); plan.tSwingStart = plan.tSwingEnd = plan.tCommit; this.plan = plan; return plan; }
    const C = new Vec3(c.x + gauss() * this.skill.posSigma, Math.max(0.06, c.y + gauss() * this.skill.posSigma * 0.7), c.z);
    const Tc = t0 + c.t + gauss() * this.skill.timingSigma;
    this.buildSwing(plan, T, shot, C, Tc);
    this.plan = plan;
    return plan;
  }

  buildSwing(plan, T, shot, C, Tc) {
    const g = this.geom, R = this.R;
    const dir = new Vec3(Math.sin(shot.ang) * Math.cos(shot.loft), Math.sin(shot.loft), -Math.cos(shot.ang) * Math.cos(shot.loft)).normalize();
    const f = dir.clone();
    const u = new Vec3(...T.hand).normalize();
    u.addScaled(f, -u.dot(f));
    if (u.lengthSq() < 1e-6) u.copy(UP);
    u.normalize();
    const x = new Vec3().crossVectors(u, f).normalize();
    const qc = new Quat().setFromBasis(x, u, f);
    const Sl = new Vec3(0, g.sweetY, g.faceZ);
    const Sw = C.clone().addScaled(f, -R);
    const Hc = Sw.clone().sub(Sl.clone().applyQuat(qc));
    const r = Sw.clone().sub(Hc);
    const A = new Vec3().crossVectors(r, f).normalize();
    const speed = T.speed * (0.85 + 0.3 * this.aggression);
    const omega = speed / Math.max(0.2, r.length());
    plan.Tc = Tc; plan.TcFrom = Tc; plan.TcTo = Tc;
    plan.C = C.clone(); plan.Cfrom = C.clone(); plan.Cto = C.clone();
    plan.blendStart = -1; plan.blendDur = 0.08;
    plan.qc = qc; plan.Hc = Hc; plan.A = A; plan.omega = omega;
    plan.handVel = f.clone().scale(speed * T.handMove);
    plan.th = T.th;
    plan.tSwingStart = Tc + T.th[0] / omega;
    plan.tSwingEnd = Tc + T.th[1] / omega;
    plan.foot = T.foot;
  }

  // Late correction after the bounce, using the true ball state.
  // state = true ball state at time tState; the correction starts at tApply
  // (tState + reaction time).
  adjust(state, tState, tApply = tState + this.cfg.ai.bounceReaction) {
    const p = this.plan;
    const t = tApply;
    if (!p || p.shot.type === 'leave' || p.adjusted || t > p.Tc - 0.02) return;
    p.adjusted = true;
    const info = analyzeDelivery(state, 1, this.cfg);
    const c = crossingAtZ(info.pred, p.C.z);
    if (!c) return;
    const k = this.skill.adjust;
    const cur = this.currentC(t);
    p.Cfrom = cur.clone();
    p.Cto = cur.clone().lerp(new Vec3(c.x, Math.max(0.06, c.y), c.z), k);
    p.TcFrom = this.currentTc(t);
    p.TcTo = p.TcFrom + ((tState + c.t) - p.TcFrom) * k;
    p.blendStart = t;
  }

  blendK(t) {
    const p = this.plan;
    if (p.blendStart < 0) return 1;
    return smoothstep(p.blendStart, p.blendStart + p.blendDur, t);
  }
  currentC(t) { const p = this.plan; return this._cTmp = (this._cTmp || new Vec3()).lerpVectors(p.Cfrom, p.Cto, this.blendK(t)); }
  currentTc(t) { const p = this.plan; return p.TcFrom + (p.TcTo - p.TcFrom) * this.blendK(t); }

  // Pose at the swing angle θ (radians) for the current plan.
  swingPose(theta, t, out) {
    const p = this.plan;
    const C = this.currentC(t);
    this._q.setFromAxisAngle(p.A, theta);
    out.q.multiplyQuats(this._q, p.qc);
    out.p.copy(p.Hc).add(this._v.subVectors(C, p.C)).addScaled(p.handVel, theta / p.omega);
    return out;
  }

  // ---- bat provider interface (used by the physics world) ----
  poseAt(t, out) {
    const p = this.plan;
    if (!p || t < p.tCommit) return out.copy(this.stancePose);
    if (p.shot.type === 'leave') {
      const k = smoothstep(p.tCommit, p.tSwingStart, t);
      out.lerpPoses(this.stancePose, p.leavePose, k);
      return out;
    }
    const Tc = this.currentTc(t);
    const th = clamp(p.omega * (t - Tc), p.th[0], p.th[1]);
    const tStart = Tc + p.th[0] / p.omega;
    if (t < tStart) {
      // Pick-up: stance → top of backlift.
      this.swingPose(p.th[0], t, this._pose);
      const k = smoothstep(p.tCommit, tStart, t);
      return out.lerpPoses(this.stancePose, this._pose, k);
    }
    const tEnd = Tc + p.th[1] / p.omega;
    this.swingPose(th, t, out);
    if (t > tEnd + 0.7) {
      const k = smoothstep(tEnd + 0.7, tEnd + 1.3, t);
      this._pose.copy(out);
      out.lerpPoses(this._pose, this.stancePose, k);
    }
    return out;
  }

  velAt(t, lin, ang, grip) {
    const p = this.plan;
    lin.set(0, 0, 0); ang.set(0, 0, 0);
    this.poseAt(t, this._pose);
    grip.copy(this._pose.p);
    if (!p || p.shot.type === 'leave') return;
    const Tc = this.currentTc(t);
    const tStart = Tc + p.th[0] / p.omega, tEnd = Tc + p.th[1] / p.omega;
    if (t >= tStart && t <= tEnd) {
      lin.copy(p.handVel);
      ang.copy(p.A).scale(p.omega);
    }
  }

  // Body placement for rendering: where the feet/torso are.
  bodyAt(t) {
    const p = this.plan;
    const out = { x: AI_HOME.x, z: AI_HOME.z, lean: 0, shot: p ? p.shot.type : 'stance' };
    if (!p || t < p.tCommit) return out;
    const k = smoothstep(p.tCommit, p.tCommit + 0.25, t);
    if (p.shot.type === 'leave') { out.x = AI_HOME.x - 0.05 * k; return out; }
    const front = p.foot === 'front';
    out.z = AI_HOME.z + (front ? -0.45 : 0.15) * k;
    out.x = AI_HOME.x + clamp(p.C.x * 0.6, -0.25, 0.45) * k;
    out.lean = (front ? 0.25 : -0.05) * k;
    return out;
  }
}
