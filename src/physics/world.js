// Fixed-timestep physics world. Pure JS, independent of render rate.
//
// The game advances the world to the current (sim) frame time with
// world.advanceTo(t). Each substep integrates the ball, then sweeps it against
// every enabled bat using that bat's pose at the substep start and end
// (providers interpolate frame poses), then against the wickets, then checks
// the boundary. Everything that happens is pushed to `events`.

import { Vec3, Pose, makeRng } from './math.js';
import { BallState, aeroParams, integrateFlight } from './ball.js';
import { BatGeometry, resolveBatContact } from './bat.js';
import { Wicket } from './wicket.js';
import { PITCH, groundDistance } from './pitch.js';
import { CONFIG } from '../config.js';

// Bat provider that interpolates between the two most recent frame samples.
// Used for the player's controller-driven bat (and in tests).
export class InterpolatedBatProvider {
  constructor() {
    this.prev = makeSample();
    this.curr = makeSample();
    this.hasPrev = false;
  }
  // Push a new frame sample (world pose of the bat, its grip position and
  // controller velocities at time t).
  push(t, pose, gripPos, linVel, angVel) {
    const tmp = this.prev; this.prev = this.curr; this.curr = tmp;
    this.curr.t = t;
    this.curr.pose.copy(pose);
    this.curr.grip.copy(gripPos);
    this.curr.lin.copy(linVel);
    this.curr.ang.copy(angVel);
    if (!this.hasPrev) { this.prev.t = t - 1e-3; this.prev.pose.copy(pose); this.prev.grip.copy(gripPos); this.prev.lin.copy(linVel); this.prev.ang.copy(angVel); this.hasPrev = true; }
  }
  // Teleport (no swept motion from the previous pose), e.g. after recentering.
  snap(t, pose, gripPos) {
    this.hasPrev = false;
    this.push(t, pose, gripPos, _zero, _zero);
  }
  frac(t) {
    const span = this.curr.t - this.prev.t;
    if (span <= 1e-9) return 1;
    const f = (t - this.prev.t) / span;
    return f < 0 ? 0 : f > 1 ? 1 : f;
  }
  poseAt(t, out) { return out.lerpPoses(this.prev.pose, this.curr.pose, this.frac(t)); }
  velAt(t, outLin, outAng, outGrip) {
    const f = this.frac(t);
    outLin.lerpVectors(this.prev.lin, this.curr.lin, f);
    outAng.lerpVectors(this.prev.ang, this.curr.ang, f);
    outGrip.lerpVectors(this.prev.grip, this.curr.grip, f);
  }
}
const _zero = new Vec3();
function makeSample() {
  return { t: 0, pose: new Pose(), grip: new Vec3(), lin: new Vec3(), ang: new Vec3() };
}

const _pa = new Vec3(), _l0 = new Vec3(), _l1 = new Vec3(), _lc = new Vec3(),
  _lin = new Vec3(), _ang = new Vec3(), _grip = new Vec3();
const _pose0 = new Pose(), _pose1 = new Pose(), _poseC = new Pose();

export class PhysicsWorld {
  constructor(cfg = CONFIG, seed = 12345) {
    this.cfg = cfg;
    this.rng = makeRng(seed);
    this.time = 0;
    this.ball = new BallState();
    this.bats = [];
    this.wickets = [new Wicket('batting', PITCH.battingStumpsZ), new Wicket('bowling', PITCH.bowlingStumpsZ)];
    this.events = [];
    this.substepCount = 0;
    this.refresh();
  }

  refresh() {
    this.P = aeroParams(this.cfg);
    this.h = 1 / this.cfg.physics.substepHz;
  }

  // speedScale: null = use CONFIG.bat.speedMultiplier (player); AI bats pass 1.
  addBat(id, provider, geom = new BatGeometry(this.cfg.bat), speedScale = null) {
    const bat = { id, provider, geom, enabled: true, cooldownUntil: -Infinity, speedScale, mods: null };
    this.bats.push(bat);
    return bat;
  }

  getBat(id) { return this.bats.find((b) => b.id === id); }

  emit(e) { this.events.push(e); }
  drainEvents() { const e = this.events; this.events = []; return e; }

  launch({ pos, vel, spin, swing = 0, seamDeg = 0, seamRandomScale = 1 }) {
    const b = this.ball;
    b.reset();
    b.pos.copy(pos); b.vel.copy(vel);
    if (spin) b.spin.copy(spin); else b.spin.set(0, 0, 0);
    b.swing = swing;
    b.seamDeg = seamDeg;
    b.seamRandomScale = seamRandomScale;
    b.active = true;
    b.launchTime = this.time;
    for (const bat of this.bats) bat.cooldownUntil = -Infinity;
    this.emit({ type: 'launch', t: this.time, pos: b.pos.clone(), vel: b.vel.clone() });
  }

  removeBall() { this.ball.active = false; }

  resetWickets() { for (const w of this.wickets) w.broken = false; }

  // Advance the simulation up to time t (in fixed substeps).
  advanceTo(t) {
    let n = 0;
    const h = this.h;
    while (this.time + h <= t + 1e-9) {
      this.substep(this.time, this.time + h);
      this.time += h;
      n++;
    }
    this.substepCount += n;
    return n;
  }

  substep(t0, t1) {
    const b = this.ball;
    if (!b.active || b.stopped) return;
    const h = t1 - t0;
    const R = this.P.r;
    _pa.copy(b.pos);

    integrateFlight(b, h, this.P, this.rng, (info, pos) => {
      this.emit({ type: 'bounce', t: t1, ...info, pos: pos.clone(), batted: b.batted, index: b.bounces });
    });

    // Bat contact (swept).
    for (const bat of this.bats) {
      if (!bat.enabled || t0 < bat.cooldownUntil) continue;
      bat.provider.poseAt(t0, _pose0);
      bat.provider.poseAt(t1, _pose1);
      _pose0.toLocal(_l0, _pa);
      _pose1.toLocal(_l1, b.pos);
      const s = bat.geom.sweep(_l0, _l1, R);
      if (s < 0) continue;
      const tc = t0 + s * h;
      _poseC.lerpPoses(_pose0, _pose1, s);
      _lc.lerpVectors(_l0, _l1, s);
      _poseC.toWorld(b.pos, _lc);
      bat.provider.velAt(tc, _lin, _ang, _grip);
      const res = resolveBatContact(bat.geom, b, _poseC, _lc, _lin, _ang, _grip, R, this.cfg, bat.speedScale ?? this.cfg.bat.speedMultiplier, bat.mods || null);
      if (res) {
        bat.cooldownUntil = tc + this.cfg.bat.cooldown;
        b.batted = true;
        b.bouncesSinceBat = 0;
        b.lastBatTime = tc;
        b.rolling = false;
        b.stopped = false;
        b.maxHeightSinceBat = b.pos.y;
        this.emit({ type: 'bat', t: tc, batId: bat.id, ...res, vel: b.vel.clone(), pos: b.pos.clone() });
      }
      b.pos.addScaled(b.vel, (1 - s) * h);
      if (b.pos.y < R) b.pos.y = R;
      break;
    }

    // Wickets.
    for (const w of this.wickets) {
      if (!w.enabled || w.broken) continue;
      const s = w.sweep(_pa, b.pos, R);
      if (s < 0) continue;
      const speed = b.vel.length();
      b.pos.lerpVectors(_pa, b.pos, s);
      const towardZ = Math.sign(w.z - _pa.z);
      if (Math.sign(b.vel.z) === towardZ) b.vel.z *= -0.25;
      b.vel.x *= 0.6; b.vel.y *= 0.5;
      b.pos.z = w.z - towardZ * (w.half.z + R + 0.003);
      w.broken = true;
      b.hitWicket = true;
      this.emit({ type: 'wicket', t: t0 + s * h, end: w.end, speed, pos: b.pos.clone(), batted: b.batted, stump: w.stumpIndexAt(b.pos.x) });
    }

    // Boundary.
    if (!b.crossedBoundary && groundDistance(b.pos.x, b.pos.z) > this.cfg.field.boundaryRadius) {
      b.crossedBoundary = true;
      this.emit({ type: 'boundary', t: t1, onFull: b.batted && b.bouncesSinceBat === 0, batted: b.batted, pos: b.pos.clone() });
    }

    if (b.stopped) this.emit({ type: 'stopped', t: t1, pos: b.pos.clone() });
  }
}
