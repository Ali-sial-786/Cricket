// AI batter (when you bowl). Pure JS.
//
// It reads the delivery (imperfectly: seam/spin movement is only partly
// anticipated, plus timing/position noise by difficulty), chooses
// leave / defend / drive / pull / cut / flick, and generates an analytic bat
// swing that aims the sweet spot at the predicted ball position. It is also a
// bat-pose *provider* for the physics world, so contact is resolved by exactly
// the same swept collision as the player's bat: it can middle it, edge it,
// miss it or be bowled. After the bounce it gets one late, partial correction.

import { Vec3, Quat, Pose, clamp, smoothstep, angularVelocityFromQuats } from '../physics/math.js';
import { BatGeometry } from '../physics/bat.js';
import { predict, crossingAtZ } from '../physics/trajectory.js';
import { CONFIG } from '../config.js';

export const AI_HOME = { x: -0.42, z: -1.0 };       // body position in stance (pads / LBW)
// Where the feet are in the stance (x, z): front (left) and back (right) foot.
export const STANCE_FEET = { L: [-0.31, -1.43], R: [-0.35, -0.95] };
const BASE = { x: -0.33, z: -1.19 };                // between the feet
const UP = new Vec3(0, 1, 0);

// Rotation whose +Y = y and +Z = z (orthonormalised, right-handed).
export function basisQuat(y, z) {
  const Y = y.clone().normalize();
  const Z = z.clone().addScaled(Y, -z.dot(Y)).normalize();
  const X = new Vec3().crossVectors(Y, Z).normalize();
  return new Quat().setFromBasis(X, Y, Z);
}

// Stance: toe grounded by the back foot, hands by the front thigh.
const STANCE_POSE = new Pose(new Vec3(-0.05, 0.66, -1.2), basisQuat(new Vec3(-0.04, 0.71, -0.2), new Vec3(0, 0, -1)));
// Backlift as the bowler delivers: hands by the back hip, the toe of the bat
// lifted up toward second slip (about 45 degrees), face opened toward gully.
const READY_POSE = new Pose(new Vec3(0.02, 1.05, -1.0), basisQuat(new Vec3(-0.22, -0.7, -0.68), new Vec3(0.92, -0.15, -0.15)));
// Shouldering arms: bat lifted high inside the line.
const LEAVE_POSE = new Pose(new Vec3(-0.22, 1.42, -1.0), basisQuat(new Vec3(0.1, -0.55, -0.83), new Vec3(0, 0.83, -0.55)));
const DUCK_POSE = new Pose(new Vec3(-0.5, 0.62, -1.05), basisQuat(new Vec3(-0.25, 0.5, -0.83), new Vec3(0.3, 0.2, -0.93)));

// Shot templates.
//   zc     contact plane (z)          hand   hands relative to the contact point (sets the bat angle)
//   speed  sweet-spot speed (m/s)     th     swing angle at the top / at the finish (rad, contact = 0)
//   top    hands at the top of the backswing, relative to the body      topDir/topFace: bat there (optional)
//   fin    hands at the finish, relative to the contact point (C) or the contact hands (H)
//   roll   wrist roll about the handle at the top / finish (rad)
//   linW   how far (rad) the hands keep travelling with the bat either side of contact
export const SHOTS = {
  drive:   { zc: -1.95, hand: [0, 0.55, -0.16], speed: 14, th: [-2.6, 3.3], loft: 0.02, foot: 'front', handMove: 0.18, linW: 0.6,
             top: [0.31, 1.08, 0.2], fin: ['C', -0.1, 1.4, 0.34], roll: [0.45, -0.75], drop: 0.14, weight: 0.7 },
  defend:  { zc: -1.8, hand: [0, 0.55, -0.22], speed: 2.0, th: [-0.85, 0.1], loft: -0.1, foot: 'front', handMove: -2.0, linW: 0.1,
             top: [0.29, 0.98, 0.12], topDir: [0.15, 0.62, 0.77], topFace: [0.9, -0.25, -0.1], fin: null, roll: [0.25, 0], drop: 0.15, weight: 0.66 },
  backdef: { zc: -1.2, hand: [0, 0.55, -0.18], speed: 2.0, th: [-0.75, 0.1], loft: -0.1, foot: 'back', handMove: -2.0, linW: 0.1,
             top: [0.29, 1.06, 0.3], topDir: [0.15, 0.62, 0.77], topFace: [0.9, -0.25, -0.1], fin: null, roll: [0.2, 0], drop: 0.04, weight: 0.36 },
  pull:    { zc: -1.7, hand: [-0.4, 0.06, 0.37], speed: 15, th: [-2.0, 2.6], loft: 0.1, foot: 'back', handMove: 0.12, linW: 0.5,
             top: [0.2, 1.3, 0.34], topDir: [-0.2, 0.72, 0.66], topFace: [0.7, -0.4, -0.3], fin: ['H', -0.1, 1.42, 0.3], roll: [0, -0.7], drop: 0.09, weight: 0.45 },
  cut:     { zc: -1.05, hand: [-0.36, 0.2, -0.93], speed: 13, th: [-1.8, 2.5], loft: -0.03, foot: 'back', handMove: 0.12, linW: 0.5,
             top: [0.24, 1.26, 0.3], topDir: [-0.15, 0.75, 0.64], topFace: [0.75, -0.3, -0.3], fin: ['H', -0.08, 1.46, -0.36], roll: [0, -0.6], drop: 0.07, weight: 0.4 },
  flick:   { zc: -1.6, hand: [0.06, 0.5, -0.12], speed: 10, th: [-1.9, 2.3], loft: 0.05, foot: 'front', handMove: 0.12, linW: 0.5,
             top: [0.3, 1.04, 0.2], fin: ['C', -0.32, 1.36, 0.05], roll: [0.3, -1.0], drop: 0.1, weight: 0.64 },
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
  else if (type === 'flick') ang = -0.45 + (r() - 0.5) * 0.3;      // worked through midwicket, not swiped across the line
  let loft = t.loft;
  if (type === 'drive' || type === 'pull') loft += aggression * 0.3 * r();
  return { type, ang, loft };
}

const hermite = (p0, m0, p1, m1, s) => {
  const s2 = s * s, s3 = s2 * s;
  return p0 * (2 * s3 - 3 * s2 + 1) + m0 * (s3 - 2 * s2 + s) + p1 * (-2 * s3 + 3 * s2) + m1 * (s3 - s2);
};
const _Y = new Vec3(0, 1, 0);

export class AIBatter {
  constructor(cfg = CONFIG) {
    this.cfg = cfg;
    this.geom = new BatGeometry(cfg.bat);
    this.R = cfg.ball.radius;
    this.plan = null;
    this.skill = cfg.ai.medium;
    this.aggression = 0.4;
    this.tReady = null;               // when the backlift started (the bowler is about to deliver)
    this.stancePose = STANCE_POSE.clone();
    this._pose = new Pose(); this._pre = new Pose(); this._sw = new Pose();
    this._p1 = new Pose(); this._p2 = new Pose();
    this._q = new Quat(); this._q2 = new Quat();
    this._v = new Vec3(); this._cTmp = new Vec3();
  }

  setDifficulty(d) { this.skill = this.cfg.ai[d] || this.cfg.ai.medium; }

  // A particular batter: profile.sigma scales the timing / placement errors
  // of the difficulty's standard batter (1 = standard, more = worse).
  setProfile(d, profile = null) {
    const base = this.cfg.ai[d] || this.cfg.ai.medium;
    const k = profile ? profile.sigma : 1;
    this.skill = { ...base, timingSigma: base.timingSigma * k, posSigma: base.posSigma * k, mistakeRate: Math.min(0.5, base.mistakeRate * k) };
  }

  reset() { this.plan = null; this.tReady = null; }

  // The bowler is in the delivery stride: pick the bat up.
  setReady(t) { if (this.tReady == null) this.tReady = t; }

  // Called at release with the live ball state (cloned) and the release time.
  // opts.charge: 0..1 chance scale of coming down the pitch to a slow ball.
  planDelivery(state, t0, rng = Math.random, opts = {}) {
    const r = typeof rng === 'function' ? rng : Math.random;
    const gauss = () => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    if (this.tReady == null || this.tReady > t0 - 0.1) this.tReady = t0 - 0.1;
    const info = analyzeDelivery(state, this.skill.readFactor, this.cfg);
    const shot = chooseShot(info, this.skill, this.aggression, r);
    const plan = { shot, info, t0, tCommit: t0 + this.cfg.ai.reactionTime, adv: 0, tBack: Infinity, tPass: t0 + (info.tb || 0.5) };
    if (shot.type === 'leave') {
      plan.leavePose = shot.duck ? DUCK_POSE : LEAVE_POSE;
      plan.tSwingStart = plan.tCommit + 0.25;
      plan.tSwingEnd = plan.tSwingStart;
      this.plan = plan;
      return plan;
    }
    // Down the pitch to a slow, flighted ball (risk: beaten in the flight and stumped).
    const speed = Math.hypot(state.vel.x, state.vel.y, state.vel.z);
    const chance = (opts.charge ?? 0) * (0.25 + 0.75 * this.aggression);
    if (chance > 0 && speed < 27.5 && info.length > 2.6 && info.length < 8 && Math.abs(info.xb) < 0.45 && r() < chance) {
      plan.adv = clamp(info.length - 2.0, 0.6, 1.5);
      shot.type = 'drive';
      shot.ang = clamp(info.xb * 1.6, -0.5, 0.6);
      shot.loft = 0.12 + 0.3 * r();
      shot.charge = true;
    }
    const T = SHOTS[shot.type];
    let zc = T.zc - plan.adv;
    if (shot.type === 'drive' && !plan.adv && info.length >= 0 && info.length < 1.6) zc = -1.35; // dig out yorkers
    const c = crossingAtZ(info.pred, zc) || crossingAtZ(info.pred, -1.2);
    if (!c) { plan.shot = { type: 'leave', ang: 0, loft: 0 }; plan.adv = 0; plan.leavePose = LEAVE_POSE; plan.tSwingStart = plan.tSwingEnd = plan.tCommit; this.plan = plan; return plan; }
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
    const power = 0.85 + 0.3 * this.aggression;
    const speed = T.speed * power;
    const omega = speed / Math.max(0.2, r.length());
    const adv = plan.adv || 0;
    plan.Tc = Tc; plan.TcFrom = Tc; plan.TcTo = Tc;
    plan.C = C.clone(); plan.Cfrom = C.clone(); plan.Cto = C.clone();
    plan.blendStart = -1; plan.blendDur = 0.08;
    plan.qc = qc; plan.Hc = Hc; plan.A = A; plan.omega = omega;
    plan.handVel = f.clone().scale(speed * T.handMove);
    plan.lin = plan.handVel.clone().scale(1 / omega);          // hand travel per radian at contact
    plan.linW = T.linW;
    // Swing arc: a bigger backlift and a fuller finish when going hard.
    const full = T.speed > 5 ? 0.82 + 0.3 * this.aggression : 1;
    const th0 = T.th[0] * (T.speed > 5 ? 0.9 + 0.15 * this.aggression : 1);
    const th1 = T.th[1] * full;
    plan.th = [th0, th1];
    // Timing: the bat accelerates from rest at the top to full speed at contact
    // and decelerates through the finish (cubic Hermite, so both ends are smooth).
    plan.Td = clamp(2.3 * Math.abs(th0) / omega, 0.14, Math.min(0.26, 2.9 * Math.abs(th0) / omega));
    plan.Tf = clamp(2.2 * th1 / omega, 0.1, Math.min(0.42, 2.9 * th1 / omega));
    plan.tSwingStart = Tc - plan.Td;
    plan.tSwingEnd = Tc + plan.Tf;
    plan.foot = T.foot;
    // Hands at the top of the backswing and at the finish (relative to the contact hands).
    const bx = BASE.x, bz = BASE.z - adv;
    const top = new Vec3(bx + T.top[0], T.top[1], bz + T.top[2]);
    if (T.foot === 'front' && !adv) top.x += clamp(C.x * 0.35, -0.1, 0.18);
    plan.Dtop = top.sub(Hc).addScaled(plan.lin, -this.linTheta(th0, T.linW));
    if (T.fin) {
      const o = T.fin[0] === 'C' ? C : Hc;
      const fin = new Vec3(o.x + T.fin[1], T.fin[2], o.z + T.fin[3]);
      fin.y = Math.max(fin.y, Hc.y + 0.15);
      // A checked finish when not going hard.
      plan.Dfin = fin.sub(Hc).scale(0.55 + 0.45 * clamp(full, 0, 1)).addScaled(plan.lin, -this.linTheta(th1, T.linW));
    } else plan.Dfin = new Vec3();
    plan.roll = T.roll || [0, 0];
    // Bat orientation at the top where the arc alone would leave it wrong: cross-bat
  // shots (blade up behind the back shoulder) and the short-arc defensive shots
  // (toe still up toward the slips, not hanging down behind the hands).
    plan.qTopExtra = null;
    if (T.topDir) {
      const qTop = basisQuat(new Vec3(...T.topDir).scale(-1), new Vec3(...T.topFace));
      const qArc = new Quat().setFromAxisAngle(A, th0).multiply(qc);
      plan.qTopExtra = qArc.conjugate().multiply(qTop);
    }
    // Footwork (x, z of each foot at contact, before any advance down the
    // pitch is added) and where the weight goes.
    const feet = { L: [STANCE_FEET.L[0], STANCE_FEET.L[1]], R: [STANCE_FEET.R[0] + 0.06, STANCE_FEET.R[1] + 0.04] };
    const type = shot.type;
    const Cz = C.z + adv, Hz = Hc.z + adv;
    if (type === 'pull' || type === 'cut') {
      const cx = type === 'pull' ? clamp(Hc.x + 0.12, -0.75, -0.05) : clamp(Hc.x - 0.4, -0.5, 0.25);
      const cz = type === 'pull' ? clamp(Hz + 0.42, -1.25, -0.6) : clamp(Hz + 0.3, -1.2, -0.62);
      feet.R = [cx + 0.02, cz + 0.22];
      feet.L = type === 'pull' ? [cx - 0.2, cz - 0.36] : [cx + 0.06, cz - 0.34];
    } else if (T.foot === 'front') {
      const reach = type === 'defend' ? 0.12 : type === 'flick' ? 0.17 : 0.14;      // foot to the pitch of the ball
      const inside = type === 'flick' ? 0.02 : 0.2;
      feet.L = [clamp(C.x - inside, -0.6, 0.42), clamp(Cz + reach, -2.3, -1.4)];
      if (feet.L[1] - feet.R[1] < -1.05) feet.R[1] = feet.L[1] + 1.05;     // a long stride drags the back foot
    } else {
      feet.R = [clamp(C.x - 0.36, -0.5, 0.05), -0.68];
      feet.L = [feet.R[0] + 0.03, feet.R[1] - 0.44];
    }
    plan.feet = feet;
    plan.weight = T.weight ?? 0.5;
    plan.drop = T.drop ?? 0.08;
  }

  // The part of the hand travel that is tied to the bat's rotation saturates
  // away from contact (the hands "give" only around the ball).
  linTheta(theta, w) { return w * Math.tanh(theta / w); }

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

  // The ball has gone past: get back in the crease (after coming down the pitch).
  retreat(t) { const p = this.plan; if (p && p.adv > 0 && p.tBack === Infinity) p.tBack = t + 0.3; }

  // How far down the pitch the batter is (m) at time t.
  advanceAt(t) {
    const p = this.plan;
    if (!p || !p.adv) return 0;
    const out = p.adv * smoothstep(p.t0 + 0.06, Math.max(p.t0 + 0.3, p.Tc - 0.14), t);
    if (t <= p.tBack) return out;
    return Math.max(0, out - 3.0 * (t - p.tBack) * smoothstep(0, 0.25, t - p.tBack));
  }

  blendK(t) {
    const p = this.plan;
    if (p.blendStart < 0) return 1;
    return smoothstep(p.blendStart, p.blendStart + p.blendDur, t);
  }
  currentC(t) { const p = this.plan; return this._cTmp.lerpVectors(p.Cfrom, p.Cto, this.blendK(t)); }
  currentTc(t) { const p = this.plan; return p.TcFrom + (p.TcTo - p.TcFrom) * this.blendK(t); }

  // Swing angle at time t (0 at contact).
  thetaAt(t) {
    const p = this.plan;
    const d = t - this.currentTc(t);
    if (d <= -p.Td) return p.th[0];
    if (d < 0) return hermite(p.th[0], 0, 0, p.omega * p.Td, 1 + d / p.Td);
    if (d < p.Tf) return hermite(0, p.omega * p.Tf, p.th[1], 0, d / p.Tf);
    return p.th[1];
  }

  // Pose at the swing angle θ (radians) for the current plan.
  swingPose(theta, t, out) {
    const p = this.plan;
    const C = this.currentC(t);
    const back = theta < 0;
    const u = back ? theta / p.th[0] : theta / p.th[1];
    const u2 = u * u;
    this._q.setFromAxisAngle(p.A, theta);
    out.q.multiplyQuats(this._q, p.qc);
    if (back && p.qTopExtra) { this._q2.identity().slerp(p.qTopExtra, u2); out.q.multiply(this._q2); }
    const roll = (back ? p.roll[0] : p.roll[1]) * u2;
    if (roll) { this._q2.setFromAxisAngle(_Y, roll); out.q.multiply(this._q2); }
    out.p.copy(p.Hc).add(this._v.subVectors(C, p.C)).addScaled(p.lin, this.linTheta(theta, p.linW)).addScaled(back ? p.Dtop : p.Dfin, u2);
    return out;
  }

  // Stance (with a light tap of the bat) blending into the backlift.
  prePose(t, out) {
    const k = this.tReady == null ? 0 : smoothstep(this.tReady, this.tReady + 0.42, t);
    if (k >= 1) return out.copy(READY_POSE);
    const st = this._st || (this._st = new Pose());
    st.copy(STANCE_POSE);
    const tap = this.tReady == null ? Math.max(0, Math.sin(t * 7.2)) : 0;
    if (tap > 0) { st.p.y += 0.035 * tap; st.p.z += 0.01 * tap; }
    return k > 0 ? out.lerpPoses(st, READY_POSE, k) : out.copy(st);
  }

  // ---- bat provider interface (used by the physics world) ----
  poseAt(t, out) {
    const p = this.plan;
    if (!p || t < p.tCommit) return this.prePose(t, out);
    if (p.shot.type === 'leave') {
      this.prePose(t, this._pre);
      const k = smoothstep(p.tCommit, p.tSwingStart, t) * (1 - smoothstep(p.tPass + 0.55, p.tPass + 1.25, t));
      return out.lerpPoses(this._pre, p.leavePose, k);
    }
    const Tc = this.currentTc(t);
    this.swingPose(this.thetaAt(t), t, this._sw);
    // Pick-up: whatever the bat was doing blends into the top of the backswing.
    const tIn = Math.max(p.tCommit + 0.04, Math.min(Math.max(Tc - p.Td, p.tCommit + 0.1), Tc - 0.035));
    const kIn = smoothstep(p.tCommit, tIn, t);
    if (kIn < 1) { this.prePose(t, this._pre); out.lerpPoses(this._pre, this._sw, kIn); } else out.copy(this._sw);
    // Hold the finish, then relax.
    const tHold = Tc + p.Tf + (p.th[1] > 1 ? 0.45 : 0.3);
    if (t > tHold) out.lerpPoses(this._pose.copy(out), STANCE_POSE, smoothstep(tHold, tHold + 0.75, t));
    return out;
  }

  // Velocity of the bat at t (numerical derivative of the pose path).
  velAt(t, lin, ang, grip) {
    const h = 1 / 960;
    this.poseAt(t - h, this._p1);
    this.poseAt(t + h, this._p2);
    lin.subVectors(this._p2.p, this._p1.p).scale(1 / (2 * h));
    angularVelocityFromQuats(ang, this._p1.q, this._p2.q, 2 * h);
    this.poseAt(t, this._p1);
    grip.copy(this._p1.p);
  }

  // Body placement (pads / LBW / stumpings): where the batter is standing.
  bodyAt(t) {
    const p = this.plan;
    const out = { x: AI_HOME.x, z: AI_HOME.z, lean: 0, shot: p ? p.shot.type : 'stance', adv: 0 };
    if (!p || t < p.tCommit) return out;
    const k = smoothstep(p.tCommit, p.tCommit + 0.25, t);
    if (p.shot.type === 'leave') { out.x = AI_HOME.x - 0.05 * k; return out; }
    const front = p.foot === 'front';
    out.adv = this.advanceAt(t);
    out.z = AI_HOME.z + (front ? -0.45 : 0.15) * k - out.adv;
    out.x = AI_HOME.x + clamp(p.C.x * 0.6, -0.25, 0.45) * k;
    out.lean = (front ? 0.25 : -0.05) * k;
    return out;
  }

  // Out of the ground (for stumpings / run-outs at the batting end)?
  outOfGround(t) { return this.advanceAt(t) > 0.5; }
}
