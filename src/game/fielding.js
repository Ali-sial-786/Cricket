// Fielding AI + run calculation. Pure JS (no three.js); the session renders
// the fielder states it exposes.
//
// When the ball is hit we predict its whole path, find for every fielder the
// earliest moment they could reach it (reaction + run time vs. ball time), and
// send the best one. Airborne arrivals within reach become catch attempts
// (success chance from difficulty, ball speed and how stretched the fielder
// is); otherwise the ball is gathered, thrown in, and runs are whatever the
// batters completed before the throw arrived.

import { Vec3, clamp, makeRng } from '../physics/math.js';
import { PITCH } from '../physics/pitch.js';
import { CONFIG } from '../config.js';

// Standard field for a right-handed batter (off side = +X). Keeper first.
export const FIELD = [
  { name: 'keeper', x: 0.0, z: 2.6, keeper: true },
  { name: 'slip', x: 1.3, z: 3.6 },
  { name: 'point', x: 22, z: -1.5 },
  { name: 'cover', x: 19, z: -15 },
  { name: 'mid-off', x: 9, z: -29 },
  { name: 'mid-on', x: -9, z: -29 },
  { name: 'midwicket', x: -23, z: -13 },
  { name: 'square leg', x: -25, z: -1 },
  { name: 'fine leg', x: -30, z: 38 },
  { name: 'third man', x: 30, z: 38 },
  { name: 'bowler', x: 0.6, z: -17.4, bowler: true },  // follow-through; only fields when the AI bowls
];

const pretty = (n) => n.replace(/\b\w/g, (c) => c.toUpperCase());

export class Fielding {
  constructor({ cfg = CONFIG, rng = makeRng(99), catchSkill = 0.72, spinner = false, bowlerFields = true } = {}) {
    this.cfg = cfg;
    this.bowlerFields = bowlerFields;
    this.autoRuns = true;        // legacy: score completed runs from timings; the match controller turns this off
    this.throwArrived = null;    // { end, t } once the throw reaches the stumps
    this.rng = rng;
    this.catchSkill = catchSkill;
    this.fielders = FIELD.map((f) => ({
      ...f,
      home: new Vec3(f.x, 0, f.z),
      pos: new Vec3(f.x, 0, f.z),
      vel: new Vec3(),
      face: 0,
      state: 'set',
      target: null,
      speed: 0,
    }));
    this.setSpinner(spinner);
    this.reset();
  }

  setSpinner(on) {
    const k = this.fielders[0], s = this.fielders[1];
    k.home.set(0, 0, on ? 0.75 : 2.6);
    s.home.set(on ? 0.9 : 1.3, 0, on ? 1.8 : 3.6);
  }

  reset() {
    this.hitT = null;
    this.plan = null;
    this.outcome = null;
    this.fielded = false;
    this.caught = false;
    this.boundary = null;
    this.throw = null;
    this.ballOverride = null;
    this.message = '';
    this.dropped = false;
    this.keeperHold = false;
    this.throwArrived = null;
    for (const f of this.fielders) {
      f.playerControlled = false;
      f.pos.copy(f.home); f.vel.set(0, 0, 0); f.state = 'set'; f.target = null; f.speed = 0; f.prevDist = Infinity;
      f.action = null;
      f.face = Math.atan2(0 - f.home.x, -1.0 - f.home.z); // look at the batter
    }
  }

  // Next delivery: clear the ball's outcome but let fielders jog back to
  // their marks instead of teleporting.
  newBall() {
    this.hitT = null; this.plan = null; this.outcome = null; this.fielded = false; this.caught = false;
    this.boundary = null; this.throw = null; this.ballOverride = null; this.message = ''; this.dropped = false;
    this.keeperHold = false;
    this.throwArrived = null;
    for (const f of this.fielders) {
      f.playerControlled = false;
      f.prevDist = Infinity; f.action = null;
      const far = Math.hypot(f.pos.x - f.home.x, f.pos.z - f.home.z);
      if (far > 40) { f.pos.copy(f.home); f.state = 'set'; f.speed = 0; }   // never visible marathon walks
      else if (far > 0.4) { f.state = 'return'; f.target = null; }
      else { f.state = 'set'; f.target = null; }
    }
  }

  // Everyone within this distance of their mark?
  inPosition(tol = 2.5) {
    return this.fielders.every((f) => Math.hypot(f.pos.x - f.home.x, f.pos.z - f.home.z) < tol);
  }

  // Ring fielders walk in a few paces as the bowler runs up.
  walkIn() {
    for (const f of this.fielders) {
      if (f.keeper || f.name === 'slip' || f.bowler || f.state !== 'set') continue;
      const dx = 0 - f.home.x, dz = -1.0 - f.home.z;
      const d = Math.hypot(dx, dz);
      const step = d > 45 ? 2.2 : 3.2;
      f.state = 'walkin';
      f.target = new Vec3(f.home.x + (dx / d) * step, 0, f.home.z + (dz / d) * step);
    }
  }
  onRelease() {
    for (const f of this.fielders) if (f.state === 'walkin') f.state = 'set';
  }

  // Time for a fielder to cover `dist` metres from standing (with accel).
  runTime(dist, reaction) {
    const v = this.cfg.field.fielderSpeed, a = this.cfg.field.fielderAccel;
    const dAcc = (v * v) / (2 * a);
    const t = dist <= dAcc ? Math.sqrt((2 * dist) / a) : v / a + (dist - dAcc) / v;
    return reaction + t;
  }

  // Called on the bat contact. ball = live BallState, pred = predict() result
  // from the contact (samples carry `t` relative to the hit).
  onHit(ball, t, pred) {
    this.hitT = t;
    const F = this.cfg.field;
    let best = null;
    const samples = pred.samples;
    const boundaryT = pred.boundary ? pred.boundary.t : Infinity;
    for (let fi = 0; fi < this.fielders.length; fi++) {
      const f = this.fielders[fi];
      if (f.bowler && !this.bowlerFields) continue;
      const react = f.keeper || f.name === 'slip' ? F.keeperReaction : F.fielderReaction;
      for (const s of samples) {
        if (s.t > boundaryT) break;
        const airborne = s.bouncesSinceBat === 0;
        const reachable = airborne ? s.y <= F.catchHeightMax && s.y >= 0.05 : s.y <= 1.2;
        if (!reachable) continue;
        const d = Math.hypot(s.x - f.pos.x, s.z - f.pos.z);
        const reach = airborne ? F.diveReach : F.reach;
        const need = this.runTime(Math.max(0, d - reach), react);
        if (need <= s.t) {
          const cand = { fi, t: s.t, x: s.x, y: s.y, z: s.z, airborne, slack: s.t - need, dist: d };
          if (!best || cand.t < best.t) best = cand;
          break;
        }
      }
    }
    this.plan = best;
    // Send the chaser (or the nearest fielder toward where it will cross the rope).
    if (best) {
      const f = this.fielders[best.fi];
      f.state = 'chase';
      f.target = new Vec3(best.x, 0, best.z);
    } else if (pred.boundary) {
      const p = pred.boundary.pos;
      let n = null, nd = Infinity;
      for (const f of this.fielders) { if (f.bowler && !this.bowlerFields) continue; const d = Math.hypot(p.x - f.home.x, p.z - f.home.z); if (d < nd) { nd = d; n = f; } }
      if (n) { n.state = 'chase'; n.target = new Vec3(p.x, 0, p.z); }
    }
    // A backup fielder drifts toward the ball line.
    const end = samples[samples.length - 1];
    if (end) {
      let n = null, nd = Infinity;
      for (const f of this.fielders) {
        if (f.state !== 'set' || f.keeper || (f.bowler && !this.bowlerFields)) continue;
        const d = Math.hypot(end.x - f.home.x, end.z - f.home.z);
        if (d < nd) { nd = d; n = f; }
      }
      if (n && nd < 40) { n.state = 'backup'; n.target = new Vec3(end.x, 0, end.z); }
    }
    // Keeper moves up to the stumps for the throw.
    const k = this.fielders[0];
    if (k.state === 'set') { k.state = 'stumps'; k.target = new Vec3(0, 0, 0.6); }
  }

  onBoundary(e) {
    if (this.fielded || this.outcome) return;
    this.boundary = e.onFull ? 6 : 4;
    this.outcome = { kind: 'boundary', runs: this.boundary };
    this.message = this.boundary === 6 ? 'SIX' : 'FOUR';
  }

  // Ball passed the batter untouched: keeper gathers it.
  keeperTakes(ball) {
    const k = this.fielders[0];
    k.target = new Vec3(clamp(ball.pos.x, -1.5, 1.5), 0, k.home.z);
    k.state = 'gather';
  }

  // Keeper gathers an unhit delivery (no runs; the ball is held).
  keeperCollect(ball, t) {
    const k = this.fielders[0];
    this.keeperHold = true;
    k.action = { type: 'keep', t0: t, target: new Vec3(ball.pos.x, ball.pos.y, ball.pos.z) };
    k.state = 'set';
    this.ballOverride = { pos: new Vec3(ball.pos.x, ball.pos.y, ball.pos.z), holder: 0 };
  }

  result() { return this.outcome; }

  // dt step. ball = live BallState (physics), world provides removeBall().
  update(dt, t, ball = null, world = null) {
    const F = this.cfg.field;
    // Move fielders.
    for (const f of this.fielders) {
      let goal = null, maxV = F.fielderSpeed;
      if (f.state === 'chase' || f.state === 'backup' || f.state === 'stumps' || f.state === 'gather' || f.state === 'walkin') goal = f.target;
      else if (f.state === 'return') goal = f.home;
      if (f.state === 'backup') maxV *= 0.7;
      if (f.state === 'return') maxV = 3.4;
      if (f.state === 'walkin') maxV = 1.6;
      if (goal) {
        const dx = goal.x - f.pos.x, dz = goal.z - f.pos.z;
        const d = Math.hypot(dx, dz);
        const react = f.keeper || f.name === 'slip' ? F.keeperReaction : F.fielderReaction;
        const moving = this.hitT == null || t - this.hitT > react || f.state === 'return' || f.state === 'gather';
        if (d > 0.05 && moving) {
          f.speed = Math.min(maxV, f.speed + F.fielderAccel * dt, d / Math.max(dt, 1e-3));
          f.pos.x += (dx / d) * f.speed * dt;
          f.pos.z += (dz / d) * f.speed * dt;
          f.face = Math.atan2(dx, dz);
        } else {
          f.speed = Math.max(0, f.speed - F.fielderAccel * 2 * dt);
          if ((f.state === 'return' || f.state === 'walkin') && d <= 0.05) {
            if (f.state === 'return') f.state = 'set';
            f.face += Math.atan2(Math.sin(Math.atan2(-f.pos.x, -1 - f.pos.z) - f.face), Math.cos(Math.atan2(-f.pos.x, -1 - f.pos.z) - f.face)) * 0.2;
          }
        }
      }
    }

    if (this.outcome || this.hitT == null || !ball) return this.updateThrow(dt, t);
    if (this.fielded) return this.updateThrow(dt, t);

    // Interaction with the live ball.
    const p = this.plan;
    for (let i = 0; i < this.fielders.length; i++) {
      const f = this.fielders[i];
      if (f.bowler && !this.bowlerFields) continue;
      if (f.playerControlled) continue;                  // the player is taking this one
      if (f.state !== 'chase' && f.state !== 'backup' && f.state !== 'gather' && f.state !== 'set' && f.state !== 'stumps' && f.state !== 'walkin' && f.state !== 'return') continue;
      const dxz = Math.hypot(ball.pos.x - f.pos.x, ball.pos.z - f.pos.z);
      const airborne = ball.batted && ball.bouncesSinceBat === 0;
      if (airborne) {
        const reach = f.state === 'chase' ? F.diveReach : F.reach;
        // Take the catch when the ball arrives (within normal reach), or dive
        // at the last moment when it is about to go past.
        const prev = f.prevDist ?? Infinity;
        f.prevDist = dxz;
        const arriving = dxz < F.reach || (dxz < reach && dxz > prev);
        if (arriving && ball.pos.y < F.catchHeightMax && ball.pos.y > 0.05) {
          const success = this.tryCatch(f, ball, dxz, p, t);
          f.action = this.catchAction(f, ball, dxz, t, success);
          if (success) {
            this.caught = true;
            this.fielded = true;
            this.outcome = { kind: 'caught', by: pretty(f.name) };
            this.message = `Caught by ${pretty(f.name)}`;
            this.ballOverride = { pos: new Vec3(f.pos.x, 1.2, f.pos.z) };
            f.state = 'celebrate';
            if (world) world.removeBall();
            return;
          }
          // Dropped / missed: the ball carries on; mark so we don't retry instantly.
          f.state = 'gather';
          f.target = new Vec3(ball.pos.x + ball.vel.x * 0.6, 0, ball.pos.z + ball.vel.z * 0.6);
          this.message = `Dropped by ${pretty(f.name)}!`;
          this.dropped = true;
          ball.vel.scale(0.35);
          ball.bouncesSinceBat = 1; // no longer catchable
          continue;
        }
      } else if (dxz < F.reach && ball.pos.y < 1.0) {
        this.gather(f, ball, t, world);
        return;
      }
    }
    // Ball stopped with nobody on it (or chaser re-targets a slow ball).
    if (ball.stopped || (this.dropped && ball.vel.length() < 8)) {
      let n = null, nd = Infinity;
      for (const f of this.fielders) { if (f.bowler && !this.bowlerFields) continue; const d = Math.hypot(ball.pos.x - f.pos.x, ball.pos.z - f.pos.z); if (d < nd) { nd = d; n = f; } }
      if (n) { n.state = 'gather'; n.target = new Vec3(ball.pos.x, 0, ball.pos.z); }
    }
    // Keep the chaser attacking a ball on the ground once they have cut off
    // its line (rather than waiting for it to roll up to them).
    if (p && !airborne(ball)) {
      const f = this.fielders[p.fi];
      const atTarget = f.target && Math.hypot(f.target.x - f.pos.x, f.target.z - f.pos.z) < 0.6;
      if (f.state === 'chase' && (t - this.hitT > p.t || atTarget)) f.target = new Vec3(ball.pos.x + ball.vel.x * 0.3, 0, ball.pos.z + ball.vel.z * 0.3);
    }
    // When the player is the bowler, a ball that dies near the bowler's end
    // is theirs to field.
    if (!this.bowlerFields && ball.pos.z < -12.5 && Math.abs(ball.pos.x) < 4 && Math.hypot(ball.vel.x, ball.vel.z) < 2.5 && ball.pos.y < 0.3) {
      const b = this.fielders[this.fielders.length - 1];
      b.pos.set(ball.pos.x, 0, ball.pos.z - 0.6);
      this.gather(b, ball, t, world);
      b.action = null;
      this.ballOverride = { pos: new Vec3(ball.pos.x, 0.04, ball.pos.z) };
      this.message = 'Fielded by you';
      return;
    }
  }

  tryCatch(f, ball, dist, plan, t) {
    const sp = ball.vel.length();
    let p = this.catchSkill;
    p *= 1 - 0.35 * clamp((sp - 18) / 25, 0, 1);         // hard-hit chances
    p *= dist > this.cfg.field.reach ? 0.65 : 1;           // diving
    if (f.keeper || f.name === 'slip') p = Math.min(0.97, p * 1.1);
    if (plan && plan.fi === this.fielders.indexOf(f) && plan.slack < 0.15 && dist > this.cfg.field.reach) p *= 0.85;
    return this.rng() < p;
  }

  gather(f, ball, t, world) {
    const F = this.cfg.field;
    this.fielded = true;
    f.state = 'throwing';
    f.speed = 0;
    const from = new Vec3(ball.pos.x, 1.0, ball.pos.z);
    // Throw to whichever end is nearer (the controller / player may change it).
    const toBat = Math.hypot(from.x, from.z - 0);
    const toBowl = Math.hypot(from.x, from.z - PITCH.bowlingStumpsZ);
    const end = toBat <= toBowl ? 'batting' : 'bowling';
    const to = endPoint(end);
    const dist = from.distanceTo(to);
    const pl = this.plan;
    const stretched = pl && this.fielders[pl.fi] === f && pl.slack < 0.2;
    const tStart = t + F.pickupTime + (stretched ? F.stretchPickupExtra : 0);
    const tArrive = tStart + dist / F.throwSpeed;
    // Runs completed before the ball gets back.
    const hitT = this.hitT;
    let runs = 0;
    while (runs < 3) {
      const tRun = hitT + F.runFirst + runs * F.runNext;
      if (tRun + F.runSafetyMargin <= tArrive) runs++;
      else break;
    }
    this.throw = { from, to, tStart, tArrive, f, anim: false, end };
    this.ballOverride = { pos: from.clone() };
    this.pendingRuns = runs;
    f.action = { type: 'pickup', t0: t, dur: Math.max(0.3, tStart - t - 0.47), ball: new Vec3(ball.pos.x, 0.04, ball.pos.z) };
    f.face = Math.atan2(to.x - f.pos.x, to.z - f.pos.z);
    if (world) world.removeBall();
  }

  catchAction(f, ball, dist, t, success) {
    const dx = ball.pos.x - f.pos.x, dz = ball.pos.z - f.pos.z;
    const lx = dx * Math.cos(f.face) - dz * Math.sin(f.face);
    const d = Math.max(1e-3, Math.hypot(dx, dz));
    return {
      type: 'catch', t0: t, success, dive: dist > this.cfg.field.reach,
      side: lx >= 0 ? 1 : -1, dir: { x: dx / d, z: dz / d }, lunge: Math.max(0, dist - 0.35),
      target: new Vec3(ball.pos.x, ball.pos.y, ball.pos.z),
    };
  }

  updateThrow(dt, t) {
    const th = this.throw;
    if (!th) return;
    if (t < th.tStart) {
      this.ballOverride.pos.set(th.f.pos.x, 0.9, th.f.pos.z);
      return;
    }
    if (!th.anim && t >= th.tStart - 0.47) { th.anim = true; th.f.action = { type: 'throw', t0: th.tStart - 0.47 }; }
    if (t >= th.tStart) th.released = true;
    const k = clamp((t - th.tStart) / (th.tArrive - th.tStart), 0, 1);
    const p = this.ballOverride.pos;
    p.x = th.from.x + (th.to.x - th.from.x) * k;
    p.z = th.from.z + (th.to.z - th.from.z) * k;
    const arc = Math.min(6, th.from.distanceTo(th.to) * 0.08);
    p.y = th.from.y + (th.to.y - th.from.y) * k + Math.sin(Math.PI * k) * arc;
    if (k >= 1 && !this.throwArrived) this.throwArrived = { end: th.end, t: th.tArrive };
    if (k >= 1 && !this.outcome && this.autoRuns) {
      this.outcome = { kind: 'runs', runs: this.pendingRuns };
      this.message = this.pendingRuns ? `${this.pendingRuns} run${this.pendingRuns > 1 ? 's' : ''}` : 'Fielded';
      th.f.state = 'return';
      for (const f of this.fielders) if (f.state !== 'set' && f.state !== 'throwing') f.state = 'return';
    }
  }

  // Re-aim a throw that has not left the hand yet.
  setThrowEnd(end) {
    const th = this.throw;
    if (!th || th.released || th.end === end) return false;
    th.end = end;
    th.to = endPoint(end);
    th.tArrive = th.tStart + th.from.distanceTo(th.to) / this.cfg.field.throwSpeed;
    th.f.face = Math.atan2(th.to.x - th.f.pos.x, th.to.z - th.f.pos.z);
    return true;
  }

  // Seconds after the hit until the ball should be back at the stumps
  // (Infinity if it is going for a boundary / nobody gets there).
  estimateReturn() {
    const p = this.plan, F = this.cfg.field;
    if (!p) return Infinity;
    if (p.airborne) return 0;                       // a catch is on: don't run
    const d = Math.min(Math.hypot(p.x, p.z), Math.hypot(p.x, p.z - PITCH.bowlingStumpsZ));
    return p.t + F.pickupTime + d / F.throwSpeed;
  }

  // The player (as a fielder) took / dropped the catch.
  playerCaught(f) {
    this.caught = true; this.fielded = true;
    this.outcome = { kind: 'caught', by: 'you' };
    this.message = 'Caught!';
    f.playerControlled = false;
    f.state = 'celebrate';
    f.action = { type: 'catch', t0: -10, success: true, dive: false, side: 1, dir: { x: 0, z: 1 }, lunge: 0, target: null };
  }
  playerDropped(f, ball) {
    f.playerControlled = false;
    f.state = 'gather';
    f.target = new Vec3(ball.pos.x + ball.vel.x * 0.6, 0, ball.pos.z + ball.vel.z * 0.6);
    this.message = 'Dropped!';
    this.dropped = true;
    ball.bouncesSinceBat = Math.max(1, ball.bouncesSinceBat);
  }

  // Back to positions after a ball.
  returnAll() {
    for (const f of this.fielders) if (f.state !== 'set') f.state = 'return';
    this.ballOverride = null;
  }

  // For rendering.
  states() {
    return this.fielders.map((f) => ({
      x: f.pos.x, z: f.pos.z, face: f.face, speed: f.speed,
      hidden: f.bowler && (!this.bowlerFields || f.state === 'set'),
      state: f.state, action: f.action,
      crouch: f.state === 'set' && (f.keeper || f.name === 'slip'),
      armsUp: f.state === 'celebrate',
    }));
  }

  // Runs completed so far (for a live readout while the ball is in play).
  runsSoFar(t) {
    if (this.hitT == null) return 0;
    const F = this.cfg.field;
    const el = t - this.hitT;
    if (el < F.runFirst) return 0;
    return Math.min(3, 1 + Math.floor((el - F.runFirst) / F.runNext));
  }
}

function endPoint(end) { return end === 'batting' ? new Vec3(0, 1.0, 0.4) : new Vec3(0, 1.0, PITCH.bowlingStumpsZ - 0.4); }

function airborne(ball) { return ball.batted && ball.bouncesSinceBat === 0; }

