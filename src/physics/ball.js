// Ball state, aerodynamics and ground contact. Pure JS (no three.js).
//
// Forces: gravity, quadratic drag, conventional swing (lateral, horizontal,
// before the first bounce only), Magnus lift from spin.
// Bounce: impulse model of a sphere on a plane with restitution + Coulomb
// friction (spin couples into the contact), plus seam deflection and an
// energy-neutral spin-turn exaggeration for game feel.

import { Vec3, smoothstep } from './math.js';
import { CONFIG } from '../config.js';
import { surfaceAt } from './pitch.js';

export class BallState {
  constructor() {
    this.pos = new Vec3();
    this.vel = new Vec3();
    this.spin = new Vec3();     // angular velocity, rad/s (world)
    this.swing = 0;             // -1..1; + pushes toward (up x v): outswing to a RH batter
    this.seamDeg = 0;           // deflection applied at the first bounce on the pitch
    this.reset();
  }
  reset() {
    this.active = false;
    this.rolling = false;
    this.stopped = false;
    this.time = 0;
    this.bounces = 0;
    this.pitchBouncesBeforeBat = 0;
    this.batted = false;
    this.bouncesSinceBat = 0;
    this.lastBatTime = -1;
    this.firstBounce = null;
    this.crossedBoundary = false;
    this.hitWicket = false;
    this.maxHeightSinceBat = 0;
    this.seamRandomScale = 1;   // scales CONFIG.surfaces.seamRandomDeg for this ball
    this.padded = false;        // struck the batter's pad (dead for bat / keeper logic)
    return this;
  }
  copyFrom(o) {
    this.pos.copy(o.pos); this.vel.copy(o.vel); this.spin.copy(o.spin);
    this.swing = o.swing; this.seamDeg = o.seamDeg;
    this.active = o.active; this.rolling = o.rolling; this.stopped = o.stopped;
    this.time = o.time; this.bounces = o.bounces;
    this.pitchBouncesBeforeBat = o.pitchBouncesBeforeBat;
    this.batted = o.batted; this.bouncesSinceBat = o.bouncesSinceBat;
    this.lastBatTime = o.lastBatTime;
    this.firstBounce = o.firstBounce ? o.firstBounce.clone() : null;
    this.crossedBoundary = o.crossedBoundary; this.hitWicket = o.hitWicket;
    this.maxHeightSinceBat = o.maxHeightSinceBat;
    this.seamRandomScale = o.seamRandomScale;
    return this;
  }
  clone() { return new BallState().copyFrom(this); }
}

// Derived aerodynamic constants (per unit mass).
export function aeroParams(cfg = CONFIG) {
  const b = cfg.ball;
  const A = Math.PI * b.radius * b.radius;
  const rho = cfg.physics.airDensity;
  return {
    g: cfg.physics.gravity,
    r: b.radius,
    kDrag: 0.5 * rho * b.dragCoeff * A / b.mass,
    kSwing: 0.5 * rho * b.swingCoeff * A / b.mass,
    kLift: 0.5 * rho * A / b.mass,
    magnusSlope: b.magnusSlope,
    magnusMaxCL: b.magnusMaxCL,
    swingLow: b.swingSpeedLow,
    swingHigh: b.swingSpeedHigh,
    spinDecay: b.spinDecayPerSec,
    inertiaK: b.inertiaFactor,
    cfg,
  };
}

// out = acceleration for a ball with velocity v, spin w, swing s.
export function acceleration(out, v, w, swing, P) {
  out.set(0, -P.g, 0);
  const speed = v.length();
  if (speed < 1e-6) return out;

  // Quadratic drag.
  out.addScaled(v, -P.kDrag * speed);

  // Conventional swing: horizontal force perpendicular to velocity.
  if (swing !== 0) {
    const hl = Math.hypot(v.x, v.z);
    if (hl > 1e-6) {
      const f = P.kSwing * swing * smoothstep(P.swingLow, P.swingHigh, speed) * speed * speed;
      // up x v_hat = (vz, 0, -vx) / |v_h|
      out.x += f * v.z / hl;
      out.z -= f * v.x / hl;
    }
  }

  // Magnus: F = 0.5 rho A CL v^2 along (w x v); CL = slope * r w_perp / v, capped.
  const cx = w.y * v.z - w.z * v.y;
  const cy = w.z * v.x - w.x * v.z;
  const cz = w.x * v.y - w.y * v.x;
  const cl = Math.sqrt(cx * cx + cy * cy + cz * cz); // = |w_perp| * speed
  if (cl > 1e-9) {
    const wPerp = cl / speed;
    let CL = P.magnusSlope * P.r * wPerp / speed;
    if (CL > P.magnusMaxCL) CL = P.magnusMaxCL;
    const mag = P.kLift * CL * speed * speed / cl;
    out.x += cx * mag; out.y += cy * mag; out.z += cz * mag;
  }
  return out;
}

const _a1 = new Vec3(), _a2 = new Vec3(), _vm = new Vec3(), _p0 = new Vec3(), _v0 = new Vec3(), _contact = new Vec3();

// Apply a bounce to `ball` whose velocity is the contact velocity. Mutates
// ball.vel / ball.spin. Returns bounce info.
export function applyBounce(ball, surfaceName, P, rng) {
  const cfg = P.cfg;
  const s = cfg.surfaces[surfaceName] || cfg.surfaces.outfield;
  const e = s.restitution, mu = s.friction;
  const v = ball.vel, w = ball.spin, R = P.r, k = P.inertiaK;
  const speedIn = v.length();
  const vn = v.y;                       // < 0 when moving into the ground
  const angIn = Math.atan2(v.x, v.z);
  const hIn = Math.hypot(v.x, v.z);

  // Contact point velocity: v + w x (-R n), n = +Y  =>  (vx + wz R, 0, vz - wx R)
  const cx = v.x + w.z * R;
  const cz = v.z - w.x * R;
  const ct = Math.hypot(cx, cz);
  const Jn = (1 + e) * Math.max(0, -vn);
  if (ct > 1e-6) {
    const rollLimit = (k / (1 + k)) * ct;           // impulse that reaches pure rolling
    const dvMag = Math.min(mu * Jn, rollLimit);
    const dvx = -dvMag * cx / ct, dvz = -dvMag * cz / ct;
    v.x += dvx; v.z += dvz;
    // dw = -(1/(k R)) (n x dv), n x dv = (dvz, 0, -dvx)
    w.x += -dvz / (k * R);
    w.z += dvx / (k * R);
  }
  let vyOut = -e * vn;
  let rolled = false;
  if (vyOut < cfg.surfaces.rollVerticalSpeed) { vyOut = 0; rolled = true; }
  v.y = vyOut;

  // Deviation off the pitch for deliveries (before the bat).
  let deviationDeg = 0;
  if (surfaceName === 'pitch' && !ball.batted && hIn > 1) {
    const angPhys = Math.atan2(v.x, v.z);
    let dPhys = angPhys - angIn;
    if (dPhys > Math.PI) dPhys -= 2 * Math.PI;
    if (dPhys < -Math.PI) dPhys += 2 * Math.PI;
    let extra = (cfg.surfaces.spinTurnScale - 1) * dPhys;
    if (ball.pitchBouncesBeforeBat === 0) {
      extra += ball.seamDeg * Math.PI / 180;
      if (rng && cfg.surfaces.seamRandomDeg > 0) extra += rng.gauss() * cfg.surfaces.seamRandomDeg * Math.PI / 180 * ball.seamRandomScale;
    }
    if (extra !== 0) {
      // Rotate horizontal velocity by `extra` about +Y (energy neutral).
      const c = Math.cos(extra), sn = Math.sin(extra);
      const x = v.x, z = v.z;
      v.x = x * c + z * sn;
      v.z = -x * sn + z * c;
    }
    let d = Math.atan2(v.x, v.z) - angIn;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    deviationDeg = d * 180 / Math.PI;
  }

  return { surface: surfaceName, speedIn, speedOut: v.length(), rolled, deviationDeg };
}

// Advance a free ball by dt (one fixed substep). Handles ground contact and
// rolling. Calls onBounce(info, pos) when it bounces.
export function integrateFlight(ball, dt, P, rng, onBounce) {
  if (!ball.active || ball.stopped) return;
  const R = P.r;
  ball.time += dt;

  if (ball.rolling) {
    const surf = surfaceAt(ball.pos.x, ball.pos.z);
    const decel = (surf === 'pitch' ? P.cfg.surfaces.outfield.rollingDecel * 1.2 : P.cfg.surfaces.outfield.rollingDecel);
    const sp = Math.hypot(ball.vel.x, ball.vel.z);
    const dv = (decel + P.kDrag * sp * sp) * dt;
    if (sp <= dv || sp < 0.05) {
      ball.vel.set(0, 0, 0);
      ball.stopped = true;
    } else {
      const f = (sp - dv) / sp;
      ball.vel.x *= f; ball.vel.z *= f; ball.vel.y = 0;
    }
    ball.pos.x += ball.vel.x * dt;
    ball.pos.z += ball.vel.z * dt;
    ball.pos.y = R;
    // Rolling spin (purely visual consistency).
    ball.spin.set(ball.vel.z / R, 0, -ball.vel.x / R);
    return;
  }

  _p0.copy(ball.pos); _v0.copy(ball.vel);
  // Midpoint (RK2) integration.
  acceleration(_a1, ball.vel, ball.spin, ball.bounces === 0 ? ball.swing : 0, P);
  _vm.copy(ball.vel).addScaled(_a1, dt * 0.5);
  acceleration(_a2, _vm, ball.spin, ball.bounces === 0 ? ball.swing : 0, P);
  ball.pos.addScaled(_vm, dt);
  ball.vel.addScaled(_a2, dt);
  if (P.spinDecay > 0) ball.spin.scale(1 - P.spinDecay * dt);

  if (ball.pos.y < R && ball.vel.y < 0) {
    // Find the contact fraction within this step.
    let f = 1;
    if (_p0.y > R) f = (_p0.y - R) / (_p0.y - ball.pos.y);
    else f = 0;
    const cxp = _p0.x + (ball.pos.x - _p0.x) * f;
    const czp = _p0.z + (ball.pos.z - _p0.z) * f;
    ball.vel.lerpVectors(_v0, ball.vel, f);
    if (ball.vel.y >= 0) ball.vel.y = -1e-3;
    ball.pos.set(cxp, R, czp);
    _contact.copy(ball.pos);
    const surface = surfaceAt(cxp, czp);
    const info = applyBounce(ball, surface, P, rng);
    if (!ball.batted && surface === 'pitch') ball.pitchBouncesBeforeBat++;
    if (!ball.firstBounce) ball.firstBounce = ball.pos.clone();
    ball.bounces++;
    if (ball.batted) ball.bouncesSinceBat++;
    if (info.rolled) ball.rolling = true;
    const rem = (1 - f) * dt;
    ball.pos.x += ball.vel.x * rem;
    ball.pos.y = R + Math.max(0, ball.vel.y * rem);
    ball.pos.z += ball.vel.z * rem;
    if (onBounce) onBounce(info, _contact);
  } else if (ball.pos.y < R) {
    ball.pos.y = R;
  }
  if (ball.batted && ball.pos.y > ball.maxHeightSinceBat) ball.maxHeightSinceBat = ball.pos.y;
}
