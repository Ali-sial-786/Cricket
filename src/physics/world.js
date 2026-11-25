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
import { STAND, standHeightAt, roofUnderAt, frontWallAt, bearing } from './stands.js';
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
const NO_EVENTS = Object.freeze([]);
function makeSample() {
  return { t: 0, pose: new Pose(), grip: new Vec3(), lin: new Vec3(), ang: new Vec3() };
}

// Contact assist: move the (bat-local) ball centre toward the sweet spot by
// `k` and onto the bat surface (exactly one ball radius out), so a near miss
// is played as a real contact rather than a fresh-air shot or a feather edge.
const _mn = new Vec3(), _swept = new Vec3();
export function magnetize(geom, c, R, k) {
  if (c.y > geom.shoulderY + 0.02) return c;                       // the handle: no help
  const hx = geom.bladeHalf.x;
  c.x *= 1 - k;
  if (Math.abs(c.x) > hx + R * 0.8) c.x = Math.sign(c.x) * (hx + R * 0.8);
  c.y = geom.sweetY + (c.y - geom.sweetY) * (1 - k);
  c.y = Math.min(Math.max(c.y, geom.toeY + 0.012), geom.shoulderY);
  for (let i = 0; i < 3; i++) {
    const d = geom.sdf(c) - R;
    if (Math.abs(d) < 1e-4) break;
    geom.normalAt(_mn, c);
    c.addScaled(_mn, -d);
  }
  return c;
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
    // (made once: a closure made every substep was garbage seven times a frame)
    this._t1 = 0;
    this._onBounce = (info, pos) => { const b = this.ball; this.emit({ type: 'bounce', t: this._t1, ...info, pos: pos.clone(), batted: b.batted, index: b.bounces }); };
    this.refresh();
  }

  refresh() {
    this.P = aeroParams(this.cfg);
    this.h = 1 / this.cfg.physics.substepHz;
  }

  // speedScale: null = use CONFIG.bat.speedMultiplier (player); AI bats pass 1.
  addBat(id, provider, geom = new BatGeometry(this.cfg.bat), speedScale = null) {
    // assist: null, or { capture (m added to the ball radius when looking for
    // contact), magnet (0..1: how far the contact is pulled toward the sweet
    // spot) } — the player's bat only.
    // swing: a SwingLoad fed with the bat's poses (your bat): the shot's power reads its load at contact.
    const bat = { id, provider, geom, enabled: true, cooldownUntil: -Infinity, speedScale, mods: null, assist: null, swing: null };
    this.bats.push(bat);
    return bat;
  }

  getBat(id) { return this.bats.find((b) => b.id === id); }

  emit(e) { this.events.push(e); }
  // (nothing happened -- most frames: the one empty list, read only, not a new one a frame)
  drainEvents() { const e = this.events; if (!e.length) return NO_EVENTS; this.events = []; return e; }

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
    // No ball in play (most of the time): a step would do nothing (substep() and the contact
    // log's wrap of it return at once), so the clock just goes on, by the same steps.
    if (!this.ball.active) {
      while (this.time + h <= t + 1e-9) { this.time += h; n++; }
      this.substepCount += n;
      return n;
    }
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

    this._t1 = t1;
    integrateFlight(b, h, this.P, this.rng, this._onBounce);

    // Bat contact (swept). (Index loops here: every substep, no iterators.)
    for (let bi = 0; bi < this.bats.length; bi++) {
      const bat = this.bats[bi];
      if (b.thrown) break;                 // (a fielder's throw carrying on: no bat plays at it)
      if (!bat.enabled || t0 < bat.cooldownUntil) continue;
      bat.provider.poseAt(t0, _pose0);
      bat.provider.poseAt(t1, _pose1);
      _pose0.toLocal(_l0, _pa);
      _pose1.toLocal(_l1, b.pos);
      const A = bat.assist;
      const s = bat.geom.sweep(_l0, _l1, A ? R + A.capture : R);
      if (s < 0) continue;
      const tc = t0 + s * h;
      _poseC.lerpPoses(_pose0, _pose1, s);
      _lc.lerpVectors(_l0, _l1, s);
      _poseC.toWorld(_swept, _lc);
      if (A) magnetize(bat.geom, _lc, R, A.magnet);
      _poseC.toWorld(b.pos, _lc);
      bat.provider.velAt(tc, _lin, _ang, _grip);
      // (your bat: how loaded the swing that reached the ball was, from its own track - swingLoad.js)
      const sw = bat.swing && bat.mods ? bat.swing.read(tc) : null;
      if (sw) bat.mods.load = sw.load;
      const res = resolveBatContact(bat.geom, b, _poseC, _lc, _lin, _ang, _grip, R, this.cfg, bat.speedScale ?? this.cfg.bat.speedMultiplier, bat.mods || null);
      if (!res && A) b.pos.copy(_swept);           // no contact after all: the ball stays on its path
      if (res) {
        bat.cooldownUntil = tc + this.cfg.bat.cooldown;
        b.batted = true;
        b.bouncesSinceBat = 0;
        b.lastBatTime = tc;
        b.rolling = false;
        b.stopped = false;
        b.maxHeightSinceBat = b.pos.y;
        this.emit({ type: 'bat', t: tc, batId: bat.id, ...res, lift: sw ? sw.lift : null, travel: sw ? sw.travel : null, vel: b.vel.clone(), pos: b.pos.clone() });
      }
      b.pos.addScaled(b.vel, (1 - s) * h);
      if (b.pos.y < R) b.pos.y = R;
      break;
    }

    // Wickets.
    for (let wi = 0; wi < this.wickets.length; wi++) {
      const w = this.wickets[wi];
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
      this.emit({ type: 'wicket', t: t0 + s * h, end: w.end, speed, pos: b.pos.clone(), batted: b.batted, stump: w.stumpIndexAt(b.pos.x), thrown: !!b.thrown });
    }

    // The advertising boards: a ball along the ground (or below their top)
    // stops against them and drops back, instead of rolling on through. Only
    // from the field side: a ball that has carried over them (a six) is past
    // them, and comes down in the stand (below), not back onto the boards.
    const F = this.cfg.field, rB = F.boundaryRadius + (F.boardsOffset ?? 3.2) - R, gd = groundDistance(b.pos.x, b.pos.z);
    const top = F.boardsHeight ?? 0.975;
    if (gd > rB && b.pos.y < top && groundDistance(_pa.x, _pa.z) <= rB + BOARDS_T) {
      const nx = b.pos.x / gd, nz = (b.pos.z - PITCH.centerZ) / gd;
      b.pos.x = nx * rB; b.pos.z = PITCH.centerZ + nz * rB;
      const vr = b.vel.x * nx + b.vel.z * nz;
      if (vr > 0) { b.vel.x -= 1.3 * vr * nx; b.vel.z -= 1.3 * vr * nz; }     // (coefficient of restitution 0.3)
    } else if (gd > rB) this.beyondBoards(b, gd, rB + R + BOARDS_T + R, top, t1);
    if (!b.active) return;                        // (into the crowd)

    // Boundary.
    if (!b.crossedBoundary && groundDistance(b.pos.x, b.pos.z) > this.cfg.field.boundaryRadius) {
      b.crossedBoundary = true;
      this.emit({ type: 'boundary', t: t1, onFull: b.batted && b.bouncesSinceBat === 0, batted: b.batted, pos: b.pos.clone() });
    }

    if (b.stopped) this.emit({ type: 'stopped', t: t1, pos: b.pos.clone() });
  }

  // Past the boards (gd from the middle, > the boards' field face). A ball
  // behind them that comes back at them meets their back (rO: the ball's
  // centre against it); one that meets the stand's surface (the front wall,
  // the tiers, the bank, the pavilion) or a roof is in the crowd: it is gone
  // (no bounce back onto the field), and a 'stand' event says where.
  beyondBoards(b, gd, rO, top, t1) {
    const R = this.P.r, z = b.pos.z - PITCH.centerZ;
    if (gd < rO && b.pos.y < top && groundDistance(_pa.x, _pa.z) >= rO) {
      const nx = b.pos.x / gd, nz = z / gd;
      b.pos.x = nx * rO; b.pos.z = PITCH.centerZ + nz * rO;
      const vr = b.vel.x * nx + b.vel.z * nz;
      if (vr < 0) { b.vel.x -= 1.3 * vr * nx; b.vel.z -= 1.3 * vr * nz; }
      return;
    }
    const a = bearing(b.pos.x, z);
    // (the stand's front wall, from the grass behind the boards: a ball below its top comes back off it)
    const rW = STAND.wallR - R;
    if (gd > rW && b.pos.y < STAND.wallTop && groundDistance(_pa.x, _pa.z) <= rW && frontWallAt(a)) {
      const nx = b.pos.x / gd, nz = z / gd;
      b.pos.x = nx * rW; b.pos.z = PITCH.centerZ + nz * rW;
      const vr = b.vel.x * nx + b.vel.z * nz;
      if (vr > 0) { b.vel.x -= 1.3 * vr * nx; b.vel.z -= 1.3 * vr * nz; }
      return;
    }
    const h = standHeightAt(gd, a), ru = roofUnderAt(gd, a);
    const inStand = h >= 0 ? b.pos.y - R <= h : gd > STAND.outerR && b.pos.y <= R;     // (out of the ground altogether: wherever it comes down)
    const onRoof = ru >= 0 && b.pos.y + R >= ru && b.pos.y - R <= ru + STAND.roof.t;
    if (!inStand && !onRoof) return;
    const speed = b.vel.length();
    b.active = false;
    this.emit({ type: 'stand', t: t1, pos: b.pos.clone(), speed, onFull: b.batted && b.bouncesSinceBat === 0, batted: b.batted, roof: onRoof });
  }
}
const BOARDS_T = 0.08;            // m: the boards' thickness (their back is this far behind the face)
