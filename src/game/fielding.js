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
import { PITCH, groundDistance } from '../physics/pitch.js';
import { CONFIG } from '../config.js';

// Standard field for a right-handed batter (off side = +X). Keeper first.
export const FIELD = [
  { name: 'keeper', x: 0.0, z: CONFIG.keeper.standBack, keeper: true },
  { name: 'slip', x: 1.5, z: CONFIG.keeper.standBack + 1.1 },
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

// No fielder, keeper or umpire stands within this of the player's head (on the ground).
export const PLAYER_CLEAR = 1.3;
// Nobody stands in the stumps: feet stay at least this far from the middle stump.
export const STUMP_CLEAR = 0.55;
// Extra room round the keeper (pads, gloves, a wide crouch), on top of the usual gap.
export const KEEPER_PADS = 0.4;
const STUMPS = [{ x: 0, z: PITCH.battingStumpsZ }, { x: 0, z: PITCH.bowlingStumpsZ }];

// Where the man taking a throw at `end` stands: just behind the stumps on the
// side the throw comes from (side +1 / -1), close enough to sweep the bails
// off, never in them.
export function receiverSpot(end, side = 1) {
  const s = side < 0 ? -1 : 1;
  return end === 'batting'
    ? new Vec3(0.35 * s, 0, PITCH.battingStumpsZ + 0.6)
    : new Vec3(0.35 * s, 0, PITCH.bowlingStumpsZ - 0.6);
}

// A goal inside a no-go circle {x, z, r} is moved to its edge (on the side
// the mover is coming from), so nobody runs on the spot trying to reach it.
function clampGoal(gx, gz, px, pz, o, out) {
  let dx = gx - o.x, dz = gz - o.z, d = Math.hypot(dx, dz);
  if (d >= o.r) return out.set(gx, 0, gz);
  if (d < 1e-3) { dx = px - o.x; dz = pz - o.z; d = Math.hypot(dx, dz); if (d < 1e-3) { dx = 1; dz = 0; d = 1; } }
  return out.set(o.x + dx / d * o.r, 0, o.z + dz / d * o.r);
}

// Direction (unit {x, z}) from (px, pz) toward (gx, gz) that bends round the
// circle o = {x, z, r} when the straight line would cut through it: the
// tangent on the side nearer the goal.
export function steerAround(px, pz, gx, gz, o, out = { x: 0, z: 0 }) {
  let dx = gx - px, dz = gz - pz;
  const d = Math.hypot(dx, dz);
  if (d < 1e-6) { out.x = 0; out.z = 0; return out; }
  dx /= d; dz /= d;
  out.x = dx; out.z = dz;
  if (!o) return out;
  const cx = o.x - px, cz = o.z - pz, cd = Math.hypot(cx, cz);
  const R = o.r + 0.15;
  const along = cx * dx + cz * dz;
  if (along <= 0 || cd - R > d) return out;                       // behind him, or the goal comes first
  if (Math.abs(cx * dz - cz * dx) >= R) return out;               // the line clears it
  const tc = Math.atan2(cx, cz), tg = Math.atan2(dx, dz);
  const a = cd <= R ? Math.PI / 2 : Math.asin(R / cd);
  const diff = (u) => Math.abs(Math.atan2(Math.sin(u - tg), Math.cos(u - tg)));
  // (round another person on the move: keep to your right, as he does, so two
  // coming at each other don't both pick the same side and meet head-on)
  const t = o.keepRight ? tc - a : diff(tc + a) < diff(tc - a) ? tc + a : tc - a;
  out.x = Math.sin(t); out.z = Math.cos(t);
  return out;
}
const _goal = new Vec3(), _dir = { x: 0, z: 0 };

// Heading (unit {x, z}) from (px, pz) toward (gx, gz) among several circles
// {x, z, r} (null entries skipped): straight if that is clear, otherwise the
// clear tangent (of any circle in the way) closest to the goal's direction,
// looking a few metres ahead. A circle marked keepRight (another person on
// the move) is passed keeping to the right, as he does, so two people coming
// at each other don't both step the same way. Circles the mover is already
// inside, or that hold the goal, don't block (separate() / clearGoal() deal
// with those).
const LOOK = 3.0, _cand = [];
export function steerAmong(px, pz, gx, gz, obs, out = { x: 0, z: 0 }) {
  const dx = gx - px, dz = gz - pz, d = Math.hypot(dx, dz);
  out.x = 0; out.z = 0;
  if (d < 1e-6) return out;
  const ux = dx / d, uz = dz / d, reach = Math.min(d, LOOK);
  const live = (o) => o && Math.hypot(px - o.x, pz - o.z) > o.r && Math.hypot(gx - o.x, gz - o.z) >= o.r;
  // clearance of the path along (cx, cz) over the look-ahead (< 0: it cuts a circle)
  const clear = (cx, cz) => {
    let m = Infinity;
    for (const o of obs) {
      if (!live(o)) continue;
      const ox = o.x - px, oz = o.z - pz, t = Math.max(0, Math.min(reach, ox * cx + oz * cz));
      m = Math.min(m, Math.hypot(ox - cx * t, oz - cz * t) - (o.r + 0.12));
    }
    return m;
  };
  if (!obs || clear(ux, uz) >= 0) { out.x = ux; out.z = uz; return out; }
  _cand.length = 0;
  const tg = Math.atan2(ux, uz);
  for (const o of obs) {
    if (!live(o)) continue;
    const ox = o.x - px, oz = o.z - pz, cd = Math.hypot(ox, oz);
    if (cd - o.r > reach + 0.5) continue;
    const tc = Math.atan2(ox, oz), a = Math.asin(Math.min(1, (o.r + 0.15) / cd));
    _cand.push({ t: tc + a, right: !o.keepRight }, { t: tc - a, right: true });
  }
  let best = null, bestScore = Infinity, fall = null, fallClear = -Infinity;
  for (const c of _cand) {
    const cx = Math.sin(c.t), cz = Math.cos(c.t), cl = clear(cx, cz);
    const dev = Math.abs(Math.atan2(Math.sin(c.t - tg), Math.cos(c.t - tg)));
    if (cl >= -1e-3 && dev < Math.PI * 0.75) {
      const score = dev + (c.right ? 0 : 0.6);
      if (score < bestScore) { bestScore = score; best = c; }
    } else if (cl > fallClear) { fallClear = cl; fall = c; }
  }
  const c = best || fall;
  if (!c) { out.x = ux; out.z = uz; return out; }
  out.x = Math.sin(c.t); out.z = Math.cos(c.t);
  return out;
}
const _obs = [];
const ARRIVE = 0.05;         // m: there
const RELEASE_SET = 4;       // m: a fielder this close to his mark at the release stops and gets set
const BRAKE = 13;            // m/s^2 pulling up
function angDiff(a, b) { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }

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
      face: 0,                   // where he wants to face (rad)
      yaw: 0,                    // where he does face: turns toward `face` at a body's pace
      state: 'set',
      target: null,
      speed: 0,
    }));
    this.setSpinner(spinner);
    this.reset();
  }

  setSpinner(on) {
    const k = this.fielders[0], s = this.fielders[1];
    const back = this.cfg.keeper.standBack;
    k.home.set(0, 0, on ? 0.75 : back);
    s.home.set(on ? 0.9 : 1.5, 0, on ? 1.8 : back + 1.1);
    // Between balls they go to the new position (up to the stumps for spin,
    // back for pace) on their feet, like everyone else returning to his mark;
    // only before any ball has been bowled are they simply stood there.
    if (this.keeperUp !== !!on && this.hitT == null && !this.keeperHold) {
      for (const f of [k, s]) {
        if (!this.started) { f.pos.copy(f.home); f.state = 'set'; f.target = null; f.speed = 0; f.vel.set(0, 0, 0); }
        else if (f.state === 'set') { f.state = 'return'; f.target = null; }
      }
    }
    this.keeperUp = !!on;
  }

  reset() {
    this.hitT = null;
    this.boundaryT = null;
    this.plan = null;
    this.outcome = null;
    this.fielded = false;
    this.caught = false;
    this.boundary = null;
    this.throw = null;
    this.ballOverride = null;
    this.message = '';
    this.dropped = false;
    this.keeperHold = false; this.keeperMissed = null; this.keeperTookAt = null; this.shy = null; this.byes = false;
    this.throwArrived = null;
    this.bowlEndReceiver = null;
    this.started = false;        // a ball has been bowled since the field was set
    this.dead = true;            // no ball in play (between balls)
    this.hurry = 0;              // s left for everyone to be back on his mark (0: no hurry)
    this.deadFor = 0;            // s since the ball went dead
    for (const f of this.fielders) {
      f.playerControlled = false;
      f.pos.copy(f.home); f.vel.set(0, 0, 0); f.state = 'set'; f.target = null; f.speed = 0; f.prevDist = Infinity;
      f.action = null; f.leap = null; f.out = false;
      f.face = f.yaw = this.restFace(f);
    }
  }

  // Which way a fielder standing at his mark faces: the batter (the keeper:
  // the bowler, down the pitch).
  restFace(f) {
    if (f.keeper) return Math.atan2(-f.pos.x * 0.3, PITCH.bowlingStumpsZ - f.pos.z);
    return Math.atan2(0 - f.pos.x, -1.0 - f.pos.z);
  }

  // Next delivery: clear the ball's outcome but let fielders jog back to
  // their marks instead of teleporting.
  newBall() {
    this.hitT = null; this.boundaryT = null; this.plan = null; this.outcome = null; this.fielded = false; this.caught = false;
    this.boundary = null; this.throw = null; this.ballOverride = null; this.message = ''; this.dropped = false;
    this.keeperHold = false; this.keeperMissed = null; this.keeperTookAt = null; this.shy = null; this.byes = false;
    this.throwArrived = null;
    this.dead = true;
    for (const f of this.fielders) {
      f.playerControlled = false;
      f.prevDist = Infinity; f.action = null; f.leap = null;
      // Nobody is ever put back on his mark: whoever is away from it runs back
      // (flat out if it is a long way, see update()).
      // (the AI bowler, back in his own figure, is walking to his mark as himself)
      if (f.bowler && this.bowlerFields && !f.out) { f.state = 'set'; f.target = null; continue; }
      const far = Math.hypot(f.pos.x - f.home.x, f.pos.z - f.home.z);
      if (far > 0.4) { f.state = 'return'; f.target = null; }
      else { f.state = 'set'; f.target = null; }
    }
  }

  // The ball is dead: whoever is not doing anything with it goes back to his
  // mark now (not when the next ball is about to be bowled). A man holding
  // the ball or in the middle of a throw / take finishes that first (see update()).
  ballDead() {
    this.dead = true;
    this.deadFor = 0;
  }
  // (once a frame while the ball is dead) Whoever has finished what he was
  // doing with the ball -- the throw, the take at the stumps, the catch and a
  // moment's celebration -- sets off back to his mark.
  goHome(dt, t) {
    this.deadFor = (this.deadFor || 0) + dt;
    for (const f of this.fielders) {
      if (f.playerControlled || f.state === 'return' || (f.state === 'set' && !f.action)) continue;
      if (f.bowler && (!this.bowlerFields || !f.out)) continue;
      const a = f.action, th = this.throw;
      const busy = a && (
        (a.type === 'throw' && t < a.t0 + 1.0)
        || (a.type === 'pickup')
        || (a.type === 'take' && (t < a.t0 + 0.8 || (a.breakAt != null && t < a.breakAt + 0.7)))
        || (a.type === 'break' && t < a.at + 0.9)
        || ((a.type === 'catch' || a.type === 'keep' || a.type === 'kmiss') && (this.deadFor < 2.0 || t < a.t0 + 1.3)));
      if (busy || (th && th.f === f && !th.released) || (f.state === 'celebrate' && this.deadFor < 2.4)) continue;
      f.action = null; f.leap = null;
      if (Math.hypot(f.pos.x - f.home.x, f.pos.z - f.home.z) > 0.4) { f.state = 'return'; f.target = null; }
      else { f.state = 'set'; f.target = null; }
    }
  }

  // Everyone within this distance of their mark? (the bowler's own figure
  // looks after itself while the fielding bowler is not out)
  inPosition(tol = 2.5) {
    return this.fielders.every((f) => (f.bowler && (!this.bowlerFields || !f.out)) || Math.hypot(f.pos.x - f.home.x, f.pos.z - f.home.z) < tol);
  }
  // …and standing still, facing the right way: ready for the bowler to run in.
  settled(tol = 0.6) {
    return this.fielders.every((f) => (f.bowler && (!this.bowlerFields || !f.out))
      || (Math.hypot(f.pos.x - f.home.x, f.pos.z - f.home.z) < tol && f.speed < 0.3 && !f.action && f.state === 'set'));
  }

  // Ring fielders walk in a few paces as the bowler runs up.
  walkIn() {
    this.dead = false;           // the delivery has begun
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
    this.started = true; this.dead = false;
    for (const f of this.fielders) {
      if (f.state === 'walkin') f.state = 'set';
      // Still on his way back as the ball is bowled: he pulls up where he is
      // and gets set (only a man a long way from his mark keeps coming).
      else if (f.state === 'return' && !f.playerControlled && Math.hypot(f.pos.x - f.home.x, f.pos.z - f.home.z) < RELEASE_SET) { f.state = 'set'; f.target = null; }
    }
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
  // byes: the ball was not hit — it beat the batter and the keeper — so there
  // is nothing to catch, the keeper does not chase it, and it is fielded
  // like any ball along the ground.
  onHit(ball, t, pred, { byes = false } = {}) {
    this.hitT = t;
    this.started = true; this.dead = false;
    this.byes = byes;
    this.boundaryT = pred.boundary ? pred.boundary.t : null;
    const F = this.cfg.field;
    let best = null;
    const samples = pred.samples;
    const boundaryT = pred.boundary ? pred.boundary.t : Infinity;
    for (let fi = 0; fi < this.fielders.length; fi++) {
      const f = this.fielders[fi];
      if (f.bowler && !this.bowlerFields) continue;
      if (byes && f.keeper) continue;
      const react = (f.keeper || f.name === 'slip' ? F.keeperReaction : F.fielderReaction) + (byes ? 0.25 : 0);
      for (const s of samples) {
        if (s.t > boundaryT) break;
        const airborne = !byes && s.bouncesSinceBat === 0;
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
    const side = end && end.x < 0 ? -1 : 1;              // the throw will come from that side
    if (k.state === 'set' || (byes && k.state !== 'chase')) { k.state = 'stumps'; k.target = receiverSpot('batting', side); }
    // Someone backs up at the bowler's end: the bowler, or (when you bowl)
    // the nearest fielder who isn't chasing.
    // (When you bowl, those stumps are yours: you are standing by them. Nobody
    // comes to stand in your space; a throw to that end is at the stumps.)
    let r = null;
    if (this.bowlerFields) r = this.fielders[this.fielders.length - 1];
    if (r && r.state === 'set') { r.state = 'stumps'; r.target = receiverSpot('bowling', side); }
    this.bowlEndReceiver = r;
  }

  onBoundary(e) {
    if (this.fielded || this.outcome) return;
    this.boundary = e.onFull && !this.byes ? 6 : 4;
    this.outcome = { kind: 'boundary', runs: this.boundary };
    this.message = this.boundary === 6 ? 'SIX' : 'FOUR';
  }

  // ------------------------------------------------------------- the keeper
  // The keeper only ever has the ball if he physically gets a glove to it.
  // While a delivery is on its way he moves across with its line (keeperTrack);
  // as it reaches him keeperTry() decides, from where the ball and he actually
  // are, whether it is a regulation take, a leap, a dive — or out of reach, in
  // which case it carries on (byes).
  keeperTrack(ball, t) {
    const k = this.fielders[0];
    if (this.keeperHold || this.keeperMissed || ball.vel.z < 1) return;
    const dt = (k.pos.z - ball.pos.z) / ball.vel.z;
    if (dt < 0 || (ball.bounces === 0 && ball.pos.z < -6)) return;        // wait for it to pitch (or to be nearly on him)
    const x = ball.pos.x + ball.vel.x * dt;
    const y = Math.max(0.05, ball.pos.y + ball.vel.y * dt - 0.5 * this.cfg.physics.gravity * dt * dt);
    k.state = 'gather';
    k.target = new Vec3(clamp(x, -2.4, 2.4), 0, k.home.z);
    // What he will have to do when it gets there (the figure times its jump or dive from this).
    const K = this.cfg.keeper, adx = Math.max(0, Math.abs(x - k.pos.x) - this.cfg.field.fielderSpeed * 0.6 * dt);   // what is left after he has moved across
    const how = y > K.standHigh ? 'leap' : adx > K.reach ? 'dive' : 'take';
    k.leap = { t: t + dt, how, x, y, side: x >= k.pos.x ? 1 : -1, done: false };
  }

  // Returns 'take' | 'miss' | null (not there yet / already decided).
  keeperTry(ball, t) {
    const k = this.fielders[0], K = this.cfg.keeper;
    if (this.keeperHold || this.keeperMissed) return null;
    if (ball.pos.z < k.pos.z - 0.3) return null;
    const dx = ball.pos.x - k.pos.x, adx = Math.abs(dx), y = ball.pos.y;
    let how = null;
    if (adx <= K.reach && y <= K.standHigh) how = 'take';
    else if (adx <= K.reach + 0.2 && y <= K.jumpHigh) how = 'leap';
    else if (adx <= K.diveReach && y <= K.diveHigh) how = 'dive';
    const side = dx >= 0 ? 1 : -1;
    const target = new Vec3(ball.pos.x, ball.pos.y, ball.pos.z);
    if (how) {
      this.keeperHold = true;
      this.keeperTookAt = t;
      this.keeperHow = how;
      k.leap = { t, how, x: ball.pos.x, y, side, done: true, reach: Math.max(0, adx - 0.3) };
      k.action = { type: 'keep', t0: t, target, hold: true, how, side };
      k.state = 'set';
      this.ballOverride = { pos: target.clone(), holder: 0 };
      return 'take';
    }
    // Out of reach: he goes for it anyway and it beats him.
    const tried = y > K.standHigh ? 'leap' : 'dive';
    this.keeperMissed = { t, how: tried, x: ball.pos.x, y };
    k.leap = { t, how: tried, x: ball.pos.x, y: Math.min(y, K.jumpHigh), side, done: true, missed: true, reach: Math.min(K.diveReach, adx) - 0.3 };
    k.action = { type: 'kmiss', t0: t, target, how: tried, side };
    k.state = 'set';
    return 'miss';
  }

  // Legacy entry points (the keeper used to be handed the ball).
  keeperTakes(ball) { this.keeperTrack(ball, 0); }
  keeperCollect(ball, t) { return this.keeperTry(ball, t); }

  // With the ball in his gloves and the batter out of his ground, the keeper
  // goes for the wicket. Standing up he whips the bails off; standing back he
  // shies at the stumps (and can miss). Returns the time the wicket is broken
  // (or the throw arrives).
  keeperAttack(t, rng = this.rng, hitChance = 0.5) {
    const k = this.fielders[0], K = this.cfg.keeper;
    if (!this.keeperHold) return null;
    const dist = Math.hypot(k.pos.x, k.pos.z - PITCH.battingStumpsZ);
    const slow = this.keeperHow === 'take' ? 0 : K.diveRecover;
    const t0 = Math.max(t, (this.keeperTookAt ?? t) + slow);
    if (dist < 1.6) {
      const at = Math.max(t0, this.keeperTookAt + K.breakTime);
      this.keeperBreak(t, at);
      this.attack = { kind: 'break', at, hit: true };
    } else {
      const tStart = Math.max(t0, this.keeperTookAt + K.shyTime), at = tStart + dist / K.shySpeed;
      const hit = rng() < hitChance;
      const from = new Vec3(k.pos.x, 0.75, k.pos.z - 0.3);
      const to = hit ? new Vec3((rng() - 0.5) * 0.12, 0.3 + rng() * 0.3, PITCH.battingStumpsZ + 0.03) : new Vec3((rng() < 0.5 ? -1 : 1) * (0.22 + rng() * 0.35), 0.25, PITCH.battingStumpsZ - 0.6);
      this.shy = { from, to, tStart, at, hit };
      k.action = { type: 'throw', t0: tStart - 0.465, quick: true };
      k.face = Math.atan2(-k.pos.x, PITCH.battingStumpsZ - k.pos.z);
      this.attack = { kind: 'shy', at, hit };
    }
    return this.attack.at;
  }

  // Stumping: the keeper (ball in the gloves) takes the bails off at time `at`.
  keeperBreak(t, at) {
    const k = this.fielders[0];
    k.state = 'set';
    k.action = { type: 'break', t0: t, at, stumps: new Vec3(0, 0.72, PITCH.battingStumpsZ), from: k.pos.clone() };
    if (Math.hypot(k.pos.x, k.pos.z - PITCH.battingStumpsZ) > 0.05) k.face = Math.atan2(-k.pos.x, PITCH.battingStumpsZ - k.pos.z);
    if (this.ballOverride) this.ballOverride.holder = 0;
  }

  // The keeper's under-arm throw at the stumps, in flight.
  updateShy(t) {
    const s = this.shy;
    if (!s || !this.ballOverride || t < s.tStart) return;
    const k = clamp((t - s.tStart) / (s.at - s.tStart), 0, 1);
    this.ballOverride.holder = null;
    this.ballOverride.pos.set(s.from.x + (s.to.x - s.from.x) * k, s.from.y + (s.to.y - s.from.y) * k + Math.sin(Math.PI * k) * 0.18, s.from.z + (s.to.z - s.from.z) * k);
  }

  // Whoever is waiting at that end for the throw (null: nobody there).
  receiverAt(end) {
    const f = end === 'batting' ? this.fielders[0] : this.bowlEndReceiver;
    if (!f) return null;
    const sz = end === 'batting' ? PITCH.battingStumpsZ + 0.6 : PITCH.bowlingStumpsZ - 0.6;
    return Math.hypot(f.pos.x, f.pos.z - sz) < 2.5 ? f : null;
  }

  // Send whoever waits at `end` to the throw side of the stumps.
  setReceiverSide(end, fromX) {
    const f = this.receiverAt(end);
    if (!f || f.playerControlled || f.state === 'throwing' || (f.action && f.action.type === 'take')) return;
    f.state = 'stumps';
    f.target = receiverSpot(end, fromX < 0 ? -1 : 1);
  }

  result() { return this.outcome; }

  // dt step. ball = live BallState (physics), world provides removeBall().
  update(dt, t, ball = null, world = null) {
    const F = this.cfg.field;
    // Move fielders. Each has a velocity that is steered toward where he is
    // going (he speeds up, turns and pulls up at a body's pace: no instant
    // starts, stops or changes of direction), and a facing that turns toward
    // the way he is going, or, standing, toward what he is watching.
    if (this.hurry > 0) this.hurry = Math.max(0, this.hurry - dt);
    if (this.dead && this.started) this.goHome(dt, t);
    const watch = ball ? ball.pos : this.ballOverride ? this.ballOverride.pos : null;
    for (const f of this.fielders) {
      let goal = null, maxV = F.fielderSpeed;
      if (f.state === 'chase' || f.state === 'backup' || f.state === 'stumps' || f.state === 'gather' || f.state === 'walkin') goal = f.target;
      else if (f.state === 'return') goal = f.home;
      if (f.state === 'backup') maxV *= 0.7;
      if (f.state === 'walkin') maxV = 1.6;
      const urgent = f.state === 'chase' || f.state === 'gather' || f.state === 'backup' || f.state === 'stumps';
      let want = 0, ux = 0, uz = 0, d = 0;
      if (goal) {
        // Never aim into the player or the stumps; go round the player.
        const ko = this.keepOut && !(f.bowler && !this.bowlerFields) && !f.playerControlled ? this.keepOut : null;
        goal = this.clearGoal(goal, f, ko);
        const dx = goal.x - f.pos.x, dz = goal.z - f.pos.z;
        d = Math.hypot(dx, dz);
        if (f.state === 'return') {
          // Back to his mark: a jog; a run when it is a long way or the bowler is waiting.
          maxV = d > 14 ? F.fielderSpeed : d > 5 ? 4.6 : 3.4;
          if (this.hurry > 0) maxV = Math.max(maxV, Math.min(F.fielderSpeed, d / Math.max(0.4, this.hurry - 0.6)));
        }
        const react = f.keeper || f.name === 'slip' ? F.keeperReaction : F.fielderReaction;
        const moving = this.hitT == null || t - this.hitT > react || f.state === 'return' || f.state === 'gather';
        if (d > ARRIVE && moving) {
          // Round the player, the umpires, the batters, the stumps and the other fielders.
          _obs.length = 0;
          _obs.push(ko && { x: ko.x, z: ko.z, r: ko.path ?? ko.r });
          for (const o of this.obstacles || []) _obs.push({ x: o.x, z: o.z, r: o.r ?? 0.8 });
          for (const st of STUMPS) _obs.push({ x: st.x, z: st.z, r: STUMP_CLEAR });
          for (const o of this.fielders) if (o !== f && !(o.bowler && (!this.bowlerFields || !o.out)) && Math.hypot(o.pos.x - f.pos.x, o.pos.z - f.pos.z) < 4) _obs.push({ x: o.pos.x, z: o.pos.z, r: 0.65 + (o.keeper || f.keeper ? KEEPER_PADS : 0), keepRight: true });
          const u = steerAmong(f.pos.x, f.pos.z, goal.x, goal.z, _obs, _dir);
          ux = u.x; uz = u.z;
          // (pulling up as he gets there; a man after the ball runs through it)
          want = urgent && f.state !== 'stumps' ? maxV : Math.min(maxV, Math.sqrt(2 * BRAKE * Math.max(0, d - ARRIVE)) + 0.25);
          // Turn before he goes: facing well away from where he is heading
          // he only shuffles round, then sets off (no running backwards).
          const sidestep = f.keeper && f.state === 'gather';
          if (!sidestep) {
            const err = Math.abs(angDiff(f.yaw, Math.atan2(ux, uz)));
            if (f.speed < 2.5) want *= clamp(1.15 - err / 1.6, urgent ? 0.3 : 0.12, 1);
          }
        } else if (d <= ARRIVE && (f.state === 'return' || f.state === 'walkin') && f.speed < 0.4) {
          if (f.state === 'return') f.state = 'set';
        }
      }
      // steer the velocity
      const tvx = ux * want, tvz = uz * want;
      const dvx = tvx - f.vel.x, dvz = tvz - f.vel.z, dv = Math.hypot(dvx, dvz);
      const sp0 = Math.hypot(f.vel.x, f.vel.z);
      const acc = (!goal ? BRAKE * 1.5 : want < sp0 - 0.05 ? BRAKE : dv > sp0 * 0.6 && sp0 > 1.5 ? F.fielderAccel * 1.6 : F.fielderAccel) * dt;
      if (dv > acc) { f.vel.x += dvx / dv * acc; f.vel.z += dvz / dv * acc; } else { f.vel.x = tvx; f.vel.z = tvz; }
      let vx = f.vel.x, vz = f.vel.z;
      f.speed = Math.hypot(vx, vz);
      if (goal && d > 1e-6 && f.speed * dt > d) { vx *= d / (f.speed * dt); vz *= d / (f.speed * dt); }   // (never past where he is going)
      f.pos.x += vx * dt; f.pos.z += vz * dt;
      // which way he faces
      const taking = f.action && f.action.type === 'take';
      const aiming = this.throw && this.throw.f === f && !this.throw.released;
      if (aiming) f.face = Math.atan2(this.throw.to.x - f.pos.x, this.throw.to.z - f.pos.z);      // (picking up, turning to throw)
      else if (f.speed > 0.7 && !(f.keeper && f.state === 'gather') && !taking && f.state !== 'throwing') f.face = Math.atan2(f.vel.x, f.vel.z);
      else if (!f.action && f.state !== 'celebrate' && f.state !== 'throwing' && f.speed <= 0.7) {
        // standing: eyes on the ball while it is in play, else on the batter (the keeper: the bowler)
        const live = !this.dead && this.hitT != null && watch && Math.hypot(watch.x - f.pos.x, watch.z - f.pos.z) > 1.2;
        if (f.keeper && f.state === 'gather') f.face = Math.atan2(0, -1);
        else f.face = live ? Math.atan2(watch.x - f.pos.x, watch.z - f.pos.z) : this.restFace(f);
      }
      const turn = (f.speed > 3 ? 7.5 : urgent || f.action ? 6.5 : 4.2) * dt;
      f.yaw += clamp(angDiff(f.yaw, f.face), -turn, turn);
    }

    this.separate();
    this.updateShy(t);
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
      if (this.byes && f.keeper) continue;                // it has already beaten him
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
            this.ballOverride = { pos: new Vec3(f.pos.x, 1.2, f.pos.z), holder: i };
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
    f.state = 'throwing';          // (he pulls up over the ball: update() brakes him)
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
    this.setReceiverSide(end, from.x);
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
    // The receiver reaches for it just before it arrives…
    if (!th.takeSet && t >= th.tArrive - 0.28) {
      th.takeSet = true;
      // A fielder who gathered it right by those stumps takes them himself.
      const own = receiverSpot(th.end, th.from.x < 0 ? -1 : 1);
      th.receiver = Math.hypot(th.f.pos.x - own.x, th.f.pos.z - own.z) < 2.5 ? th.f : this.receiverAt(th.end);
      if (th.receiver) {
        const spot = receiverSpot(th.end, th.from.x < 0 ? -1 : 1);
        // Not quite there: he keeps going to his spot beside the stumps
        // (never stops wherever he happens to be, e.g. in the stumps).
        if (Math.hypot(th.receiver.pos.x - spot.x, th.receiver.pos.z - spot.z) > 0.3) { th.receiver.state = 'stumps'; th.receiver.target = spot; }
        else { th.receiver.state = 'set'; }
        th.receiver.face = Math.atan2(th.from.x - th.receiver.pos.x, th.from.z - th.receiver.pos.z);
        th.receiver.action = { type: 'take', t0: t, target: th.to.clone(), stumps: new Vec3(0, 0.72, th.end === 'batting' ? PITCH.battingStumpsZ : PITCH.bowlingStumpsZ), breakAt: null };
      }
    }
    // …and holds it; with nobody there the ball runs on past the stumps.
    if (k >= 1 && !this.throwArrived) {
      this.throwArrived = { end: th.end, t: th.tArrive };
      if (th.receiver) this.ballOverride.holder = this.fielders.indexOf(th.receiver);
      else { p.y = this.cfg.ball.radius; p.z += th.end === 'batting' ? 1.2 : -1.2; }
    }
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
    this.setReceiverSide(end, th.from.x);
    th.f.face = Math.atan2(th.to.x - th.f.pos.x, th.to.z - th.f.pos.z);
    return true;
  }

  // Seconds after the hit until the ball should be back at the stumps
  // (Infinity if it is going for a boundary / nobody gets there).
  estimateReturn() {
    const p = this.plan, F = this.cfg.field;
    if (!p) return Infinity;
    if (p.airborne && !this.byes) return 0;         // a catch is on: don't run
    const d = Math.min(Math.hypot(p.x, p.z), Math.hypot(p.x, p.z - PITCH.bowlingStumpsZ));
    return p.t + F.pickupTime + d / F.throwSpeed;
  }

  // Is the ball clearly on its way to the rope? (A boundary is predicted and
  // nobody cuts it off, or only just inside the rope at full stretch.)
  boundaryAhead() {
    if (this.boundaryT == null || this.byes) return false;
    const p = this.plan;
    if (!p) return true;
    if (p.airborne) return false;
    const R = this.cfg.field.boundaryRadius;
    return groundDistance(p.x, p.z) > 0.85 * R && p.slack < 0.35;
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

  // Two fielders never stand inside each other (nor inside an umpire).
  // Nor in the stumps, nor in a batter; and nobody comes near the player's
  // head (keepOut {x, z, r}, set by the controller every frame).
  separate(min = 0.85) {
    const F = this.fielders;
    const push = (f, ox, oz, r) => {
      let dx = f.pos.x - ox, dz = f.pos.z - oz, d = Math.hypot(dx, dz);
      if (d >= r) return;
      if (d < 1e-6) { dx = f.pos.x - f.home.x || 1; dz = f.pos.z - f.home.z; d = Math.hypot(dx, dz); }
      f.pos.x = ox + dx / d * r; f.pos.z = oz + dz / d * r;
    };
    const skip = (f) => f.playerControlled || (f.bowler && (!this.bowlerFields || !f.out));
    for (const o of this.obstacles || []) if (!o.soft) for (const f of F) if (!skip(f)) push(f, o.x, o.z, o.r ?? min);
    for (const s of STUMPS) for (const f of F) if (!skip(f)) push(f, s.x, s.z, STUMP_CLEAR);
    for (let i = 0; i < F.length; i++) {
      const a = F[i];
      if (a.bowler && (!this.bowlerFields || !a.out)) continue;
      for (let j = i + 1; j < F.length; j++) {
        const b = F[j];
        if (b.bowler && (!this.bowlerFields || !b.out)) continue;
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z, d = Math.hypot(dx, dz);
        const need = min + (a.keeper || b.keeper ? KEEPER_PADS : 0);       // (the keeper is wider: pads, gloves, a low wide crouch)
        if (d >= need || d < 1e-6) continue;
        // The one doing something (catching, holding the ball) stays put.
        const fixedA = a.playerControlled || !!a.action, fixedB = b.playerControlled || !!b.action;
        if (fixedA && fixedB) continue;
        const amt = (need - d) / (fixedA || fixedB ? 1 : 2);
        const ux = dx / d, uz = dz / d;
        if (!fixedA) { a.pos.x -= ux * amt; a.pos.z -= uz * amt; }
        if (!fixedB) { b.pos.x += ux * amt; b.pos.z += uz * amt; }
      }
    }
    // The player's space wins over everything else.
    const ko = this.keepOut;
    if (ko) for (const f of F) if (!skip(f)) push(f, ko.x, ko.z, ko.r);
  }

  // A movement goal moved out of the player's space and out of the stumps.
  clearGoal(goal, f, ko) {
    let g = goal;
    for (const s of STUMPS) if (Math.hypot(g.x - s.x, g.z - s.z) < STUMP_CLEAR) { g = clampGoal(g.x, g.z, f.pos.x, f.pos.z, { x: s.x, z: s.z, r: STUMP_CLEAR }, _goal); }
    if (ko && Math.hypot(g.x - ko.x, g.z - ko.z) < ko.r) g = clampGoal(g.x, g.z, f.pos.x, f.pos.z, ko, _goal);
    return g;
  }

  // Back to positions after a ball.
  returnAll() {
    for (const f of this.fielders) if (f.state !== 'set') f.state = 'return';
    this.ballOverride = null;
  }

  // For rendering.
  states() {
    return this.fielders.map((f) => ({
      x: f.pos.x, z: f.pos.z, face: f.yaw, speed: f.speed,
      hidden: f.bowler && (!this.bowlerFields || !f.out),      // (out: the fielding figure is standing in for the AI bowler's own)
      state: f.state, action: f.action, leap: f.leap,
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

