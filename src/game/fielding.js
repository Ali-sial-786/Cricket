// Fielding AI + run calculation. Pure JS (no three.js); the session renders
// the fielder states it exposes.
//
// When the ball is hit we predict its whole path, find for every fielder the
// earliest moment they could reach it (reaction + run time vs. ball time), and
// send the best one. Airborne arrivals within reach become catch attempts
// (success chance from difficulty, ball speed and how stretched the fielder
// is); otherwise the ball is gathered and thrown in (src/game/throwing.js
// decides where: a shy, into a teammate's gloves over the stumps, a safe
// return, or he waits for someone to get there). While the ball is in play
// the keeper and the bowler (or whoever is free when they are busy) cover
// their stumps and a fielder backs up behind the end being thrown to; a
// throw nobody takes runs on as a live ball (overthrows).

import { Vec3, clamp, makeRng } from '../physics/math.js';
import { PITCH, groundDistance } from '../physics/pitch.js';
import { predict } from '../physics/trajectory.js';
import { CONFIG } from '../config.js';
import { THROW, ENDS, STUMPS_Z, CREASE_TO_CREASE, throwSpeedFor, decideThrow, aimThrow, throwPoint, continuation, deflectOffStumps, glovesPoint, stumpsAim, crossedNow, boundaryOverthrowRuns } from './throwing.js';

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
const BACKPEDAL = 3.0;       // m: closer to his mark than this, a fielder steps back to it still facing in
const FETCH_REACH = 0.85;     // m: a dead ball the keeper walks up to is picked up from this close
const FETCH_GIVEUP = 3.0;     // s: ...or this long after he set off for it (round the batter, the stumps)
const SELF_RUN = 3.2;
const LOOSE_SLOW = 1.0;      // m/s: a loose ball this slow is anyone's to pick up (the keeper's after byes; reached into your space)
const LOB_AFTER = 1.3;       // s after the ball is dead before it is tossed back (after the replay's tape ends: TAIL 1 s)        // m: a man with the ball this close to a set of stumps runs in and breaks them himself
const RELEASE_SET = 4;       // m: a fielder this close to his mark at the release stops and gets set
const BRAKE = 13;            // m/s^2 pulling up
function angDiff(a, b) { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }

export class Fielding {
  constructor({ cfg = CONFIG, rng = makeRng(99), catchSkill = 0.72, throwSkill = 1, spinner = false, bowlerFields = true } = {}) {
    this.cfg = cfg;
    this.bowlerFields = bowlerFields;
    this.autoRuns = true;        // legacy: score completed runs from timings; the match controller turns this off
    this.throwArrived = null;    // { end, t, direct } once a throw is taken at (or hits) the stumps
    this.rng = rng;
    this.catchSkill = catchSkill;
    this.throwSkill = throwSkill;
    // The batters' running (a Runs, src/game/running.js), read to decide where
    // to throw; null: they are taken as standing in their ground.
    this.runs = null;
    // Every throw (for measurement): counts by kind and what became of them.
    this.tally = { throws: 0, direct: 0, gloves: 0, return: 0, self: 0, oneBounce: 0, held: 0, runIn: 0, hits: 0, missed: 0, takes: 0, fumbles: 0, overthrows: 0, coverThere: 0, coverAway: 0 };
    this.throwLog = [];
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
    this.keeperHold = false; this.keeperMissed = null; this.keeperTookAt = null; this.shy = null; this.byes = false; this.fetchT0 = null;
    this.throwArrived = null;
    this.bowlEndReceiver = null;
    this.cover = { batting: null, bowling: null };   // who is covering each set of stumps
    this.backer = null;          // who is backing up behind the stumps being thrown to
    this.overthrow = null;       // { t, base, atThrow, count }: a throw has got away
    this.events = [];            // for the controller: { type: 'stumps' | 'overthrow' | 'fumble', end, t }
    this.lob = null;             // the ball tossed back once it is dead
    this.planT0 = null;          // the time the chase plan's sample times count from
    this.started = false;        // a ball has been bowled since the field was set
    this.dead = true;            // no ball in play (between balls)
    this.hurry = 0;              // s left for everyone to be back on his mark (0: no hurry)
    this.deadFor = 0;            // s since the ball went dead
    for (const f of this.fielders) {
      f.playerControlled = false;
      f.pos.copy(f.home); f.vel.set(0, 0, 0); f.state = 'set'; f.target = null; f.speed = 0; f.prevDist = Infinity;
      f.action = null; f.leap = null; f.out = false; f.runIn = null; f.coverEnd = null; f.backEnd = null; f.noGatherUntil = 0;
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
    this.keeperHold = false; this.keeperMissed = null; this.keeperTookAt = null; this.shy = null; this.byes = false; this.fetchT0 = null;
    this.throwArrived = null;
    this.cover = { batting: null, bowling: null }; this.backer = null; this.overthrow = null; this.events = []; this.planT0 = null; this.lob = null; this.hitPending = null;
    this.dead = true;
    for (const f of this.fielders) {
      f.playerControlled = false;
      f.prevDist = Infinity; f.action = null; f.leap = null; f.runIn = null; f.coverEnd = null; f.backEnd = null; f.noGatherUntil = 0;
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
      if (f.playerControlled || f.state === 'return') continue;
      // (standing still, nothing in hand: back to his mark if he is off it -- a ring fielder's walk-in, a man who pulled up where he was)
      if (f.state === 'set' && !f.action) {
        if (!(f.bowler && (!this.bowlerFields || !f.out)) && Math.hypot(f.pos.x - f.home.x, f.pos.z - f.home.z) > 0.4) { f.state = 'return'; f.target = null; }
        continue;
      }
      if (f.bowler && (!this.bowlerFields || !f.out)) continue;
      const a = f.action, th = this.throw;
      const busy = a && (
        (a.type === 'throw' && t < a.t0 + 1.0)
        || (a.type === 'pickup')
        || (a.type === 'take' && (t < a.t0 + 0.8 || (a.breakAt != null && t < a.breakAt + 0.7)))
        || (a.type === 'break' && t < a.at + 0.9)
        || ((a.type === 'catch' || a.type === 'keep' || a.type === 'kmiss') && (this.deadFor < 2.0 || t < a.t0 + 1.3)));
      if (busy || (th && th.f === f && !th.released) || (f.state === 'celebrate' && this.deadFor < 2.4)) continue;
      // Holding the ball: he lobs it back toward the bowler first (nobody walks
      // about with it, and it never hangs in the air at a hidden hand).
      if (this.ballOverride && this.ballOverride.holder === this.fielders.indexOf(f) && !this.lob && !(f.bowler && this.bowlerFields)) { if (this.deadFor >= LOB_AFTER) this.startLob(f, t); continue; }
      f.action = null; f.leap = null; f.runIn = null; f.coverEnd = null; f.backEnd = null;
      if (Math.hypot(f.pos.x - f.home.x, f.pos.z - f.home.z) > 0.4) { f.state = 'return'; f.target = null; }
      else { f.state = 'set'; f.target = null; }
    }
  }

  // The ball dead, the man holding it tosses it back: into the AI bowler's
  // hand (lobTarget, set by the controller: where his hand is), or, when you
  // bowl, rolled along the turf to just in front of your feet.
  startLob(f, t) {
    const lt = this.lobTarget;
    const roll = !lt || !!lt.roll;
    const to = lt ? new Vec3(lt.x, roll ? this.cfg.ball.radius : lt.y, lt.z) : new Vec3(0.9, this.cfg.ball.radius, PITCH.bowlingStumpsZ + 1.5);
    const from = new Vec3(f.pos.x, 1.1, f.pos.z), d = Math.hypot(to.x - from.x, to.z - from.z);
    this.lob = { from, to, roll, tStart: t + 0.35, tArrive: t + 0.35 + Math.max(0.5, d / (roll ? 11 : 13)), arc: roll ? Math.min(1.5, 0.3 + d * 0.04) : Math.min(5, 0.6 + d * 0.16), bounce: roll ? 0.3 : 0 };
    f.action = { type: 'throw', t0: t + 0.35 - THROW.windup, quick: true };
    f.face = Math.atan2(to.x - f.pos.x, to.z - f.pos.z);
    this.lobFrom = f;
  }
  updateLob(t) {
    const L = this.lob;
    if (!L || !this.ballOverride) { this.lob = null; return; }
    if (t < L.tStart) return;                         // (still in his hand)
    if (!L.released) { L.released = true; this.ballOverride.holder = null; L.from.set(this.lobFrom.pos.x, 1.1, this.lobFrom.pos.z); }
    const k = clamp((t - L.tStart) / (L.tArrive - L.tStart), 0, 1);
    throwPoint(L, k, this.ballOverride.pos);
    // (in his hand: gone into his own figure; rolled to you: it lies at your feet until the next ball)
    if (k >= 1) { if (!L.roll) this.ballOverride = null; this.lob = null; this.lobFrom = null; }
  }

  // Everyone within this distance of their mark? (the bowler's own figure
  // looks after itself while the fielding bowler is not out)
  inPosition(tol = 2.5) {
    return this.fielders.every((f) => (f.bowler && (!this.bowlerFields || !f.out)) || Math.hypot(f.pos.x - f.home.x, f.pos.z - f.home.z) < tol);
  }
  // …and standing still, facing the right way: ready for the bowler to run in.
  settled(tol = 0.6) {
    return this.fielders.every((f) => (f.bowler && (!this.bowlerFields || !f.out))
      || (Math.hypot(f.pos.x - f.home.x, f.pos.z - f.home.z) < tol && f.speed < 0.3 && !f.action && f.state === 'set' && Math.abs(angDiff(f.yaw, this.restFace(f))) < 0.1));
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
    if (byes) this.keeperHold = false;               // (his shy at the stumps has missed: the ball is loose)
    this.boundaryT = pred.boundary ? pred.boundary.t : null;
    const best = this.planChase(pred, t, { byes });
    // A backup fielder drifts toward the ball line.
    const samples = pred.samples;
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
    // A ball that has been hit never reaches the keeper: no leap or dive for it.
    const k = this.fielders[0];
    if (!byes && !this.keeperHold && !this.keeperMissed) { k.leap = null; if (k.state === 'gather') k.state = 'set'; }
    // The keeper and the bowler go to their stumps (from wherever they are),
    // or whoever is free if one of them is busy with the ball; someone backs
    // up behind the end the ball is likely to come to.
    this.cover = { batting: null, bowling: null };
    const side = (best ? best.x : end ? end.x : 1) < 0 ? -1 : 1;
    this.assignCovers(t, side);
    if (best && !best.airborne) this.assignBacker(this.nearerEnd(best.x, best.z), best.x, best.z, t);
  }

  // Send whoever gets to the ball first along the path `pred` (sample times
  // count from t0) after it; with nobody, the nearest man toward where it
  // crosses the rope. ground: the ball can no longer be caught (an
  // overthrow); exclude: a man who cannot go (he has just thrown it).
  planChase(pred, t0, { byes = false, ground = false, exclude = null, react: extra = 0 } = {}) {
    const F = this.cfg.field;
    let best = null;
    const samples = pred.samples;
    const boundaryT = pred.boundary ? pred.boundary.t : Infinity;
    for (let fi = 0; fi < this.fielders.length; fi++) {
      const f = this.fielders[fi];
      if (f.bowler && !this.bowlerFields) continue;
      if (byes && f.keeper && !ground) continue;
      if (f === exclude || f.playerControlled) continue;
      const react = (f.keeper || f.name === 'slip' ? F.keeperReaction : F.fielderReaction) + (byes && !ground ? 0.25 : 0) + (f.state === 'backstop' ? -0.15 : extra);
      for (const s of samples) {
        if (s.t > boundaryT) break;
        const airborne = !byes && !ground && s.bouncesSinceBat === 0;
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
    this.planT0 = t0;
    // (whoever was after the ball under an older plan leaves it to the new man)
    for (let fi = 0; fi < this.fielders.length; fi++) {
      const f = this.fielders[fi];
      if ((f.state === 'chase' || f.state === 'gather') && !(best && best.fi === fi) && this.hitT != null) { f.state = 'set'; f.target = null; }
    }
    if (best) {
      const f = this.fielders[best.fi];
      f.state = 'chase';
      f.target = new Vec3(best.x, 0, best.z);
      f.coverEnd = null; f.backEnd = null;
    } else if (pred.boundary) {
      const p = pred.boundary.pos;
      let n = null, nd = Infinity;
      for (const f of this.fielders) { if ((f.bowler && !this.bowlerFields) || f === exclude || f.playerControlled) continue; const d = Math.hypot(p.x - f.pos.x, p.z - f.pos.z); if (d < nd) { nd = d; n = f; } }
      if (n) { n.state = 'chase'; n.target = new Vec3(p.x, 0, p.z); n.coverEnd = null; n.backEnd = null; }
    }
    return best;
  }

  // A man running to his spot behind the stumps comes round behind them (or
  // round the side of them from in front), never across the face of the
  // wicket where the batter is coming in.
  coverWay(f, spot) {
    const sz = STUMPS_Z[f.coverEnd], back = f.coverEnd === 'batting' ? 1 : -1, side = spot.x < 0 ? -1 : 1;
    if (Math.hypot(f.pos.x - spot.x, f.pos.z - spot.z) < 0.9) return spot;
    const inFront = (f.pos.z - sz) * back < 0.2;
    const w = f._way || (f._way = new Vec3());
    if (inFront && Math.abs(f.pos.x) < 1.3) return w.set(side * 1.35, 0, sz + back * 0.3);
    // (does the straight line pass close by the stumps?)
    const dx = spot.x - f.pos.x, dz = spot.z - f.pos.z, L = Math.hypot(dx, dz) || 1;
    const u = clamp(((0 - f.pos.x) * dx + (sz - f.pos.z) * dz) / (L * L), 0, 1);
    const cx = f.pos.x + dx * u, cz = f.pos.z + dz * u;
    if (Math.hypot(cx, cz - sz) < 0.85) return w.set(side * 0.85, 0, sz + back * 1.05);
    return spot;
  }

  nearerEnd(x, z) { return Math.hypot(x, z - STUMPS_Z.batting) <= Math.hypot(x, z - STUMPS_Z.bowling) ? 'batting' : 'bowling'; }

  // Is he tied up with the ball (chasing it, holding it, throwing it, in a
  // catch or a dive he has not got up from)?
  busyWithBall(f, t) {
    if (!f || f.playerControlled || f.state === 'chase' || f.state === 'gather' || f.state === 'throwing' || f.state === 'celebrate') return true;
    if (this.throw && this.throw.f === f && !this.throw.released) return true;
    if (this.ballOverride && this.ballOverride.holder === this.fielders.indexOf(f)) return true;
    const a = f.action;
    if (a && ((a.type === 'catch' && t - a.t0 < 1.0) || (a.type === 'kmiss' && t - a.t0 < 0.9) || (a.type === 'keep' && this.keeperHold))) return true;
    return false;
  }

  // Who covers each set of stumps while the ball is in play: the keeper his
  // own, the AI bowler his, from wherever they are; if one of them is busy
  // with the ball, the nearest man who is free. They sprint there (round
  // everyone in the way) and wait just behind the stumps, facing the ball.
  // side: the side of the pitch the throw will come from (+1 / -1).
  assignCovers(t, side = null) {
    const F = this.fielders, k = F[0], bw = this.bowlerFields ? F[F.length - 1] : null;
    const busy = (f) => this.busyWithBall(f, t) && !(f && f.coverEnd && this.ballOverride && this.ballOverride.holder === F.indexOf(f));
    const th = this.throw;
    const pick = (end, pref, taken) => {
      // (a throw on its way to him: he stays the man at those stumps until it gets there)
      if (th && th.released && !th.done && th.end === end && th.receiverF && th.receiverF !== taken) return th.receiverF;
      const cur = this.cover[end];
      const curOk = cur && cur !== taken && !busy(cur);
      if (pref && !busy(pref) && pref !== taken) {
        // (the man over the stumps keeps them until the keeper / bowler would be there sooner)
        if (!curOk || cur === pref) return pref;
        const spot = receiverSpot(end, cur.coverSide || 1);
        return this.etaTo(pref, spot) <= this.etaTo(cur, spot) ? pref : cur;
      }
      if (curOk) return cur;                                    // (keeps whoever is on his way)
      const spot = receiverSpot(end, 1);
      let n = null, nd = Infinity;
      for (const f of F) {
        if (f === taken || f === pref || f.keeper || f.bowler || busy(f)) continue;
        const d = Math.hypot(f.pos.x - spot.x, f.pos.z - spot.z) + (f.state === 'backstop' ? 12 : 0);
        if (d < nd) { nd = d; n = f; }
      }
      return n;
    };
    const bat = pick('batting', k, null);
    // (when you bowl, those stumps are yours: nobody comes to stand by you -- DECISIONS V4;
    // a throw there is at the stumps, with a man backing up behind them)
    const bowl = this.bowlerFields ? pick('bowling', bw, bat) : null;
    const sideOf = (end) => {
      let s = side != null ? side : (this.cover[end] && this.cover[end].coverSide) || 1;
      // (never into the player's space: he may be standing at those stumps)
      const ko = this.keepOut;
      if (ko) {
        const dd = (q) => { const sp = receiverSpot(end, q); return Math.hypot(sp.x - ko.x, sp.z - ko.z); };
        if (dd(s) < ko.r + 0.15 && dd(-s) > dd(s) + 0.05) s = -s;
      }
      return s;
    };
    for (const [end, f] of [['batting', bat], ['bowling', bowl]]) {
      const old = this.cover[end];
      if (old && old !== f && old.coverEnd === end && old.state === 'stumps') { old.state = 'return'; old.target = null; old.coverEnd = null; }
      this.cover[end] = f;
      if (!f) continue;
      if (f.state === 'backstop' && this.backer === f) this.backer = null;
      const s = sideOf(end);
      const taking = f.action && (f.action.type === 'take' || f.action.type === 'break');
      if (taking) { f.coverEnd = end; continue; }
      if (f.state !== 'stumps' || f.coverEnd !== end || f.coverSide !== s) {
        f.state = 'stumps'; f.coverEnd = end; f.coverSide = s; f.backEnd = null;
        f.target = receiverSpot(end, s);
      }
    }
    // The keeper (or the AI bowler) free again but not the man over his stumps
    // (someone took them while he was busy): he comes back to them all the same,
    // to the other side, and takes them over once he is there.
    for (const [end, own] of [['batting', k], ['bowling', bw]]) {
      if (!own || this.cover[end] === own || own === bat || own === bowl || busy(own) || !this.cover[end]) continue;
      if (own.action && (own.action.type === 'take' || own.action.type === 'break')) continue;
      const s = -(this.cover[end].coverSide || 1);
      if (own.state !== 'stumps' || own.coverEnd !== end || own.coverSide !== s) { own.state = 'stumps'; own.coverEnd = end; own.coverSide = s; own.backEnd = null; own.target = receiverSpot(end, s); }
    }
    this.bowlEndReceiver = this.cover.bowling;
  }

  // One fielder backs up behind the stumps at `end`, in line with a throw
  // from (fx, fz), THROW.backDist beyond them (inside the rope), to stop a
  // throw that gets past.
  assignBacker(end, fx, fz, t) {
    const sz = STUMPS_Z[end];
    let ux = -fx, uz = sz - fz;
    const d = Math.hypot(ux, uz);
    if (d < 4) return;                              // (thrown from right by the stumps: nothing to back up)
    ux /= d; uz /= d;
    let bx = ux * THROW.backDist, bz = sz + uz * THROW.backDist;
    const lim = this.cfg.field.boundaryRadius - 6, gd = groundDistance(bx, bz);
    if (gd > lim) { const k = lim / gd; bx *= k; bz = PITCH.centerZ + (bz - PITCH.centerZ) * k; }
    const spot = new Vec3(bx, 0, bz);
    const cur = this.backer;
    const usable = (f) => f && !f.keeper && !f.bowler && !this.busyWithBall(f, t) && f !== this.cover.batting && f !== this.cover.bowling;
    let n = null, nd = Infinity;
    for (const f of this.fielders) {
      if (!usable(f)) continue;
      const dd = Math.hypot(f.pos.x - spot.x, f.pos.z - spot.z) - (f === cur ? 4 : 0);
      if (dd < nd) { nd = dd; n = f; }
    }
    if (cur && cur !== n && cur.state === 'backstop') { cur.state = 'return'; cur.target = null; cur.backEnd = null; }
    this.backer = n && nd < 40 ? n : null;
    if (this.backer) { n.state = 'backstop'; n.target = spot; n.backEnd = end; n.coverEnd = null; }
  }

  onBoundary(e) {
    if (this.fielded || this.outcome || (this.dead && this.started)) return;
    if (this.overthrow) {
      // Overthrows to the rope (Law 19.8): four, plus the runs completed and the
      // one in progress if the batters had crossed when the throw was made.
      const s = boundaryOverthrowRuns(this.overthrow.atThrow || {}, 4);
      this.boundary = 4;
      this.outcome = { kind: 'boundary', runs: s.runs, overthrows: s.overthrows, ran: s.ran, crossed: !!(this.overthrow.atThrow && this.overthrow.atThrow.crossed) };
      this.message = `${s.ran ? s.ran + ' + ' : ''}4 overthrows`;
      return;
    }
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

  // An unhit delivery that has died short of him (or beside him, out of the
  // way of his gloves): he walks up and picks it up, so the ball is dead in his
  // hands (and a batter out of his ground can still be stumped). Returns
  // 'take' once he has it, else null (on his way).
  keeperFetch(ball, t) {
    const k = this.fielders[0];
    if (this.keeperHold || this.keeperMissed) return null;
    const dx = ball.pos.x - k.pos.x, dz = ball.pos.z - k.pos.z;
    if (Math.hypot(dx, dz) <= FETCH_REACH || (this.fetchT0 != null && t - this.fetchT0 > FETCH_GIVEUP)) {
      const target = new Vec3(ball.pos.x, Math.max(ball.pos.y, 0.05), ball.pos.z);
      this.keeperHold = true;
      this.keeperTookAt = t;
      this.keeperHow = 'take';
      this.fetchT0 = null;
      k.leap = null;
      k.action = { type: 'keep', t0: t, target, hold: true, how: 'take', side: dx >= 0 ? 1 : -1 };
      k.state = 'set';
      k.vel.set(0, 0, 0); k.speed = 0;
      this.ballOverride = { pos: target.clone(), holder: 0 };
      return 'take';
    }
    if (this.fetchT0 == null) this.fetchT0 = t;
    // (stand just behind it, on the stumps' side)
    const back = ball.pos.z > PITCH.battingStumpsZ ? 0.35 : -0.35;
    k.state = 'gather'; k.leap = null;
    k.target = new Vec3(ball.pos.x, 0, ball.pos.z + (Math.abs(ball.pos.x) < 0.5 && Math.abs(ball.pos.z - PITCH.battingStumpsZ) < 0.6 ? back : 0.35));
    return null;
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

  // The keeper's shy has missed: the ball runs on past the stumps as a live
  // ball (byes, and overthrows), from where it got to.
  shyMissed(world, t) {
    const s = this.shy;
    if (!s || s.missed) return;
    s.missed = true;
    const T = Math.max(0.05, s.at - s.tStart);
    const vel = new Vec3((s.to.x - s.from.x) / T, -0.8, (s.to.z - s.from.z) / T).scale(THROW.carry);
    this.tally.throws++; this.tally.direct++; this.tally.missed++;
    const fake = { f: this.fielders[0], end: 'batting', atThrow: { completed: 0, crossed: false } };
    this.throw = fake;
    this.byes = true;                                // (the ball was not hit: whatever they run now is byes)
    this.relaunch(world, s.to, vel, t, 'miss');
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
    const f = this.cover[end] || (end === 'batting' ? this.fielders[0] : this.bowlEndReceiver);
    if (!f) return null;
    const sz = end === 'batting' ? PITCH.battingStumpsZ + 0.6 : PITCH.bowlingStumpsZ - 0.6;
    return Math.hypot(f.pos.x, f.pos.z - sz) < 2.5 ? f : null;
  }

  // Seconds for `f` to get to `spot` from where he is.
  etaTo(f, spot) {
    const d = Math.hypot(f.pos.x - spot.x, f.pos.z - spot.z);
    return d < 0.7 ? 0 : this.runTime(d - 0.5, f.speed > 2 ? 0 : 0.25);
  }

  // Seconds until the man covering `end` is over the stumps (0: there; Infinity: nobody).
  coverEta(end) {
    const f = this.cover[end];
    if (!f) return Infinity;
    const spot = this.clearGoal(f.target && f.coverEnd === end ? f.target : receiverSpot(end, 1), f, this.keepOut);
    const d = Math.hypot(f.pos.x - spot.x, f.pos.z - spot.z);
    if (d < 0.7) return 0;
    return this.runTime(d - 0.5, f.speed > 2 ? 0 : 0.25) * (f.speed > 2 ? 0.85 : 1);
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
      if (f.state === 'chase' || f.state === 'backup' || f.state === 'stumps' || f.state === 'gather' || f.state === 'walkin' || f.state === 'backstop') goal = f.target;
      else if (f.state === 'return') goal = f.home;
      else if (f.state === 'throwing' && f.runIn) goal = f.runIn;           // (running the ball in)
      if (f.state === 'backup') maxV *= 0.7;
      if (f.state === 'walkin') maxV = 1.6;
      if (f.keeper && f.state === 'gather' && this.fetchT0 != null) maxV = 3.5;       // (walking up to a dead ball: brisk, no sprint)
      if (f.state === 'throwing') maxV = 5.0;
      const urgent = f.state === 'chase' || f.state === 'gather' || f.state === 'backup' || f.state === 'stumps' || f.state === 'backstop';
      let want = 0, ux = 0, uz = 0, d = 0;
      if (goal && f.state === 'stumps' && f.coverEnd) goal = this.coverWay(f, goal);
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
          want = urgent && f.state !== 'stumps' && f.state !== 'backstop' ? maxV : Math.min(maxV, Math.sqrt(2 * BRAKE * Math.max(0, d - ARRIVE)) + 0.25);
          // Turn before he goes: facing well away from where he is heading
          // he only shuffles round, then sets off (no running backwards).
          const sidestep = (f.keeper && f.state === 'gather') || (f.state === 'return' && d < BACKPEDAL);
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
      else if (f.speed > 0.7 && !(f.keeper && f.state === 'gather') && !(f.state === 'return' && d < BACKPEDAL) && !taking && f.state !== 'throwing') f.face = Math.atan2(f.vel.x, f.vel.z);
      // setting off for somewhere well away: he turns to face where he is going first (else, slow, he would stay facing in and only shuffle)
      else if (want > 0 && f.speed <= 0.7 && !f.action && (f.state === 'return' || f.state === 'walkin') && d >= BACKPEDAL) f.face = Math.atan2(ux, uz);
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
    this.updateLob(t);
    // While the ball is in play, the stumps are covered.
    if (this.hitT != null && !this.dead && !this.outcome && !(this.throwArrived && !this.throwArrived.direct)) this.assignCovers(t);
    if (this.outcome || this.hitT == null || !ball || this.dead) return this.updateThrow(dt, t, world);
    if (this.fielded) return this.updateThrow(dt, t, world);

    // Interaction with the live ball.
    const p = this.plan;
    for (let i = 0; i < this.fielders.length; i++) {
      const f = this.fielders[i];
      if (f.bowler && !this.bowlerFields) continue;
      if (f.playerControlled) continue;                  // the player is taking this one
      if (f.state !== 'chase' && f.state !== 'backup' && f.state !== 'gather' && f.state !== 'set' && f.state !== 'stumps' && f.state !== 'walkin' && f.state !== 'return' && f.state !== 'backstop') continue;
      const dxz = Math.hypot(ball.pos.x - f.pos.x, ball.pos.z - f.pos.z);
      // A throw getting past him (an overthrow): he dives across to stop it.
      if (ball.thrown && this.tryStop(f, ball, dxz, t, world)) return;
      if (f.noGatherUntil > t) continue;                 // (it has just left his hands / gone past him)
      const airborne = ball.batted && ball.bouncesSinceBat === 0;
      // (it has already beaten him -- until it has all but stopped: then it is his to pick up like anyone's)
      if (this.byes && f.keeper && Math.hypot(ball.vel.x, ball.vel.z) > LOOSE_SLOW) continue;
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
      } else if (dxz < F.reach + this.reachIn(f, ball) && ball.pos.y < 1.0) {
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
      if (f.state === 'chase' && (t - (this.planT0 ?? this.hitT) > p.t || atTarget)) f.target = new Vec3(ball.pos.x + ball.vel.x * 0.3, 0, ball.pos.z + ball.vel.z * 0.3);
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

  // A ball all but stopped inside the player's space (a block dead at your
  // feet): nobody may walk in there, so the man at its edge reaches in for it
  // (m beyond his normal reach; 0 for any other ball).
  reachIn(f, ball) {
    const ko = this.keepOut;
    if (!ko || f.playerControlled || ball.pos.y > 0.3 || Math.hypot(ball.vel.x, ball.vel.z) > LOOSE_SLOW) return 0;
    const kr = ko.r + (f.keeper ? KEEPER_PADS : 0), d = Math.hypot(ball.pos.x - ko.x, ball.pos.z - ko.z);
    return d < kr ? kr - d + 0.15 : 0;
  }

  // A thrown ball going past within a dive (and below the knee): he goes
  // full length for it as it passes him. Returns true if he stops it.
  tryStop(f, ball, dxz, t, world) {
    const F = this.cfg.field;
    const prev = f.prevStop ?? Infinity;
    f.prevStop = dxz;
    if (f.stopTried || f === (this.lastThrower || null) || dxz >= F.diveReach || dxz < F.reach * 0.6 || ball.pos.y > 0.7) return false;
    const sp = Math.hypot(ball.vel.x, ball.vel.z);
    if (sp < 3 || dxz <= prev) return false;          // (still coming: he waits for it; slow: he walks to it)
    f.stopTried = true;
    const p = clamp(0.85 - 0.4 * (dxz - F.reach) / (F.diveReach - F.reach), 0.4, 0.85) * Math.min(1.1, this.throwSkill);
    const dx = ball.pos.x - f.pos.x, dz = ball.pos.z - f.pos.z, d = Math.max(1e-3, dxz);
    const lx = dx * Math.cos(f.yaw) - dz * Math.sin(f.yaw);
    const dive = { type: 'catch', t0: t, success: false, dive: true, side: lx >= 0 ? 1 : -1, dir: { x: dx / d, z: dz / d }, lunge: Math.max(0, dxz - 0.35), target: new Vec3(ball.pos.x, Math.max(0.1, ball.pos.y), ball.pos.z) };
    if (this.rng() >= p) {
      // (it beats the dive: he is on the ground, it goes on, and someone else goes after it)
      f.action = dive; f.state = 'set'; f.noGatherUntil = t + 1.0;
      if (world) this.planChase(predict(ball, { maxTime: 8, h: 1 / 240 }), t, { ground: true, exclude: f });
      this.events.push({ type: 'loose', t });
      return false;
    }
    this.tally.stops = (this.tally.stops || 0) + 1;
    this.gather(f, ball, t, world);
    f.action = dive;                                 // (down full length; up, then the throw)
    this.throw.tStart += 0.75; this.throw.tPick += 0.75; this.throw.hurried = true;
    return true;
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
    f.runIn = null; f.coverEnd = null; f.backEnd = null;
    if (this.cover.batting === f) this.cover.batting = null;
    if (this.cover.bowling === f) this.cover.bowling = null;
    if (this.backer === f) this.backer = null;
    const from = new Vec3(ball.pos.x, 1.0, ball.pos.z);
    const pl = this.plan;
    const stretched = pl && this.fielders[pl.fi] === f && pl.slack < 0.2;
    const tStart = t + F.pickupTime + (stretched ? F.stretchPickupExtra : 0);
    const end = this.nearerEnd(from.x, from.z);
    const to = glovesPoint(end);
    this.throw = { from, to, tStart, tPick: tStart, tArrive: tStart + from.distanceTo(to) / throwSpeedFor(from.distanceTo(to), 'return', F.throwSpeed), f, anim: false, end, kind: 'return', hurried: !!stretched || f.speed > 4, held: 0, forced: null };
    this.ballOverride = { pos: from.clone() };
    this.decide(t);
    const th = this.throw;
    // (legacy: runs completed before the ball gets back)
    const hitT = this.hitT;
    let runs = 0;
    while (runs < 3) {
      const tRun = hitT + F.runFirst + runs * F.runNext;
      if (tRun + F.runSafetyMargin <= th.tArrive) runs++;
      else break;
    }
    this.pendingRuns = runs;
    f.action = { type: 'pickup', t0: t, dur: Math.max(0.3, tStart - t - 0.47), ball: new Vec3(ball.pos.x, 0.04, ball.pos.z) };
    f.face = Math.atan2(th.to.x - f.pos.x, th.to.z - f.pos.z);
    if (world) world.removeBall();
  }

  // The batters as a thrower sees them: null (both in their ground), or how
  // far each still has to go and how fast he is going.
  runnerNow() {
    const r = this.runs;
    if (!r || !r.active || r.closed || !r.running) return null;
    const v = Math.abs(r.rate) > 0.05 ? Math.abs(r.rate) * CREASE_TO_CREASE : CREASE_TO_CREASE / this.cfg.field.runNext;
    return { remaining: r.remaining * CREASE_TO_CREASE, v: Math.max(4, v), back: r.goingBack };
  }

  // Decide (again) where the ball in his hand goes: until the throw starts he
  // keeps looking (a teammate getting to the stumps, the batters setting off
  // or turning back changes it).
  decide(t) {
    const th = this.throw, f = th.f, F = this.cfg.field;
    const ends = {};
    for (const E of ENDS) {
      const self = Math.hypot(f.pos.x, f.pos.z - STUMPS_Z[E]) < SELF_RUN && (E === 'batting' || this.bowlerFields);
      const b = this.backer;
      const backed = !!(b && b.backEnd === E && b.target && Math.hypot(b.pos.x - b.target.x, b.pos.z - b.target.z) < 4);
      ends[E] = { readyIn: this.cover[E] && this.cover[E] !== f ? this.coverEta(E) : Infinity, backed, self };
    }
    const d = decideThrow({ from: f.pos, release: Math.max(0, th.tStart - t), runner: this.runnerNow(), ends, speed: F.throwSpeed, skill: this.throwSkill, hurried: th.hurried, forced: th.forced, held: th.held });
    th.decision = d;
    th.self = ends[d.end].self;
    if (d.end !== th.end) { th.end = d.end; this.setReceiverSide(d.end, f.pos.x); }
    th.kind = d.kind; th.bounce = d.bounce; th.wait = d.wait;
    th.to = d.kind === 'direct' ? stumpsAim(d.end) : glovesPoint(d.end);
    const dd = Math.hypot(th.to.x - f.pos.x, th.to.z - f.pos.z);
    th.tArrive = th.tStart + dd / throwSpeedFor(dd, d.kind, F.throwSpeed);
    // (someone backs up behind the end it is going to, unless he is right there himself)
    if (!th.self && (!this.backer || this.backer.backEnd !== d.end)) this.assignBacker(d.end, f.pos.x, f.pos.z, t);
    return d;
  }

  // The ball leaves his hand: where it really goes (aim + error) and what
  // happens at the end of it is settled now.
  release(t) {
    const th = this.throw, f = th.f, F = this.cfg.field;
    th.released = true;
    th.from = new Vec3(f.pos.x, 1.2, f.pos.z);
    f.runIn = null;
    const c = this.cover[th.end];
    let receiver = null, rf = null;
    if (th.self) { rf = f; receiver = { pos: f.pos, there: true, reach: THROW.reach }; }
    else if (c) {
      const spot = this.clearGoal(c.target && c.coverEnd === th.end ? c.target : receiverSpot(th.end, 1), c, this.keepOut);
      const dist = Math.hypot(th.to.x - th.from.x, th.to.z - th.from.z);
      rf = c; receiver = { pos: new Vec3(spot.x, 0, spot.z), there: this.coverEta(th.end) <= dist / throwSpeedFor(dist, th.kind, F.throwSpeed) + 0.1, reach: c.keeper ? THROW.keeperReach : THROW.reach };
    }
    aimThrow(th, this.rng, { skill: this.throwSkill, hurried: th.hurried, receiver, speed: F.throwSpeed });
    if (th.self) { th.result = 'take'; th.to = glovesPoint(th.end); }
    th.tArrive = th.tStart + Math.max(0.12, th.flight);
    th.receiverF = th.result === 'take' || th.result === 'fumble' ? rf : null;
    th.missedBy = th.result === 'miss' && receiver && receiver.there ? rf : null;
    const r = this.runs;
    th.atThrow = { completed: r && r.active ? r.completed : 0, crossed: crossedNow(r), running: !!(r && r.running) };
    const T = this.tally;
    T.throws++; T[th.kind] = (T[th.kind] || 0) + 1;
    if (th.bounce) T.oneBounce++;
    if (th.held > 0.05) T.held++;
    this.throwLog.push({ t, end: th.end, kind: th.kind, why: th.decision && th.decision.why, dist: +th.dist.toFixed(1), result: th.result, pHit: th.decision ? +th.decision.pHit.toFixed(2) : 0, short: th.decision && isFinite(th.decision.short) ? +th.decision.short.toFixed(2) : null, held: +th.held.toFixed(2), thrower: f.name, receiver: rf ? rf.name : null, bounce: !!th.bounce });
    if (this.throwLog.length > 400) this.throwLog.shift();
    // (he has thrown it: free again, to cover or back up if he is needed)
    if (f.state === 'throwing') f.state = 'set';
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

  updateThrow(dt, t, world = null) {
    const th = this.throw;
    if (!th) return;
    const f = th.f;
    if (!th.released) {
      if (!th.anim) {
        th.held = Math.max(0, t - (th.tPick - THROW.windup));
        if (!this.dead || th.wait > 0) this.decide(t);
        if (this.dead) th.wait = 0;
        // Right by the stumps he is going for: no throw -- he runs in with the
        // ball (once he has picked it up) and takes the bails off himself.
        // Nobody running: it is settled in his hands where he is (dead ball).
        if (th.self && t >= th.tPick - THROW.windup) {
          const spot = receiverSpot(th.end, f.pos.x < 0 ? -1 : 1);
          if (Math.hypot(f.pos.x - spot.x, f.pos.z - spot.z) > 0.6 && th.held < 2 && this.runnerNow()) { f.runIn = spot; th.tStart = t + dt; this.ballOverride.pos.set(f.pos.x, 0.9, f.pos.z); return; }
          f.runIn = null; th.tStart = t; th.selfRun = true; th.kind = 'self';
          this.release(t);
        }
        // Waiting for a teammate to get to the stumps: he holds it (a long way
        // out, he runs it in meanwhile); then the throw.
        if (t >= th.tStart - THROW.windup) {
          if (th.wait > 1e-3) {
            th.tStart = t + THROW.windup + dt;
            const dz = STUMPS_Z[th.end];
            const far = Math.hypot(f.pos.x, f.pos.z - dz);
            if (far > THROW.runInFrom && (!f.action || f.action.type !== 'pickup' || t - f.action.t0 > f.action.dur)) {
              if (!f.runIn) this.tally.runIn++;
              const k = (far - THROW.runInFrom * 0.6) / far;
              f.runIn = new Vec3(f.pos.x * (1 - k), 0, f.pos.z + (dz - f.pos.z) * k);
            }
          } else {
            th.anim = true;
            f.runIn = null;
            f.action = { type: 'throw', t0: th.tStart - THROW.windup };
          }
        }
      }
      if (t < th.tStart) {
        this.ballOverride.pos.set(f.pos.x, 0.9, f.pos.z);
        return;
      }
      this.release(t);
    }
    if (th.done || !this.ballOverride) return;         // (taken: it is in his hands now)
    const k = clamp((t - th.tStart) / (th.tArrive - th.tStart), 0, 1);
    throwPoint(th, k, this.ballOverride.pos);
    // The receiver reaches for it just before it arrives…
    if (!th.takeSet && t >= th.tArrive - 0.28) {
      th.takeSet = true;
      th.receiver = th.receiverF;
      if (th.receiver) {
        const spot = th.receiver === f ? receiverSpot(th.end, th.from.x < 0 ? -1 : 1) : (th.receiver.target && th.receiver.coverEnd === th.end ? th.receiver.target : receiverSpot(th.end, th.from.x < 0 ? -1 : 1));
        // Not quite there: he keeps going to his spot beside the stumps
        // (never stops wherever he happens to be, e.g. in the stumps).
        if (Math.hypot(th.receiver.pos.x - spot.x, th.receiver.pos.z - spot.z) > 0.3) { th.receiver.state = 'stumps'; th.receiver.target = spot; }
        else { th.receiver.state = 'set'; }
        th.receiver.face = Math.atan2(th.from.x - th.receiver.pos.x, th.from.z - th.receiver.pos.z);
        th.receiver.action = { type: 'take', t0: t, target: th.to.clone(), stumps: new Vec3(0, 0.72, STUMPS_Z[th.end]), breakAt: null };
      }
    }
    if (k >= 1 && !th.done) {
      th.done = true;
      this.arrive(t, world);
    }
  }

  // The throw gets to the end of its flight.
  arrive(t, world) {
    const th = this.throw, T = this.tally;
    const c = this.cover[th.end];
    const there = th.self || (c && Math.hypot(c.pos.x, c.pos.z - STUMPS_Z[th.end]) < 1.6);
    if (there) T.coverThere++; else T.coverAway++;
    th.coverThere = !!there;
    if (th.result === 'take') {
      // …and holds it, over the stumps.
      T.takes++;
      this.throwArrived = { end: th.end, t: th.tArrive, by: th.receiver ? th.receiver.name : null };
      if (th.receiver) this.ballOverride.holder = this.fielders.indexOf(th.receiver);
      if (!this.outcome && this.autoRuns) {
        this.outcome = { kind: 'runs', runs: this.pendingRuns };
        this.message = this.pendingRuns ? `${this.pendingRuns} run${this.pendingRuns > 1 ? 's' : ''}` : 'Fielded';
        th.f.state = 'return';
        for (const f of this.fielders) if (f.state !== 'set' && f.state !== 'throwing') f.state = 'return';
      }
      return;
    }
    if (this.dead) {
      // (the ball is dead already: no more play -- it drops where it got to)
      this.ballOverride = { pos: new Vec3(th.to.x, this.cfg.ball.radius, th.to.z) };
      this.throw = null;
      return;
    }
    const v = continuation(th);
    if (th.result === 'hit') {
      // A direct hit: the wicket is broken (the controller judges the run-out)
      // and the ball comes off the stumps, still in play.
      T.hits++;
      this.events.push({ type: 'stumps', end: th.end, t });
      this.throwArrived = { end: th.end, t: th.tArrive, direct: true };
      this.relaunch(world, th.to, deflectOffStumps(v, th.end, th.from.z), t, 'hit');
      return;
    }
    if (th.result === 'fumble') {
      // Over the stumps, and it goes down: it drops at his feet and he has to pick it up.
      T.fumbles++;
      const a = this.rng() * Math.PI * 2, sp = 1 + this.rng() * 1.6;
      const rcv = th.receiver;
      if (rcv) { rcv.action = null; rcv.state = 'set'; rcv.noGatherUntil = t + 0.35; }
      this.relaunch(world, th.to, new Vec3(Math.sin(a) * sp, 0.6, Math.cos(a) * sp), t, 'fumble');
      return;
    }
    T.missed++;
    if (th.missedBy) th.missedBy.noGatherUntil = t + 0.3;
    this.relaunch(world, th.to, v, t, 'miss');
  }

  // A throw nobody took is a live ball again (from `pos` at `vel`): the ball
  // physics carries it on (bounce, roll, the boards, the rope) and whoever gets
  // to it first goes after it. kind: 'miss' | 'hit' (off the stumps) | 'fumble'.
  relaunch(world, pos, vel, t, kind) {
    const th = this.throw;
    this.throw = null;
    this.fielded = false;
    if (!world || !world.ball) {
      // (no ball physics to hand it to: it lies where it got to)
      this.ballOverride = { pos: new Vec3(pos.x, this.cfg.ball.radius, pos.z) };
      return;
    }
    this.ballOverride = null;
    const b = world.ball;
    b.reset();
    b.pos.set(pos.x, Math.max(this.cfg.ball.radius, pos.y), pos.z);
    b.vel.copy(vel);
    b.spin.set(0, 0, 0); b.swing = 0; b.seamDeg = 0;
    b.active = true;
    b.batted = !this.byes;
    b.bounces = 1; b.bouncesSinceBat = 1;            // (not a catch now, and no seam / swing)
    b.thrown = true;
    for (const f of this.fielders) { f.stopTried = false; f.prevStop = Infinity; }
    this.lastThrower = th ? th.f : null;
    const r = this.runs, base = r && r.active ? r.completed + (r.running && !r.goingBack ? 1 : 0) : 0;
    if (kind === 'miss') this.overthrowNow(t, base, th ? th.atThrow : null, th ? th.end : null);
    // (off the stumps: an overthrow only if the controller finds nobody out and the ball runs on -- directRunsOn)
    else if (kind === 'hit') this.hitPending = { t, base, atThrow: th ? th.atThrow : null, end: th ? th.end : null };
    else this.events.push({ type: 'fumble', end: th ? th.end : null, t });
    if (th) th.f.noGatherUntil = Math.max(th.f.noGatherUntil || 0, t + 0.4);
    const pred = predict(b, { maxTime: 8, h: 1 / 240 });
    this.boundaryT = pred.boundary ? t + pred.boundary.t - (this.hitT ?? t) : null;
    const best = this.planChase(pred, t, { ground: true, react: -0.1 });
    if (best) this.assignBacker(this.nearerEnd(best.x, best.z), best.x, best.z, t);
  }

  // A throw has got away: the overthrow is on the books, and the controller told.
  overthrowNow(t, base, atThrow, end) {
    if (!this.overthrow) this.overthrow = { t, base, count: 0, atThrow: null };
    this.overthrow.count++;
    if (atThrow) this.overthrow.atThrow = atThrow;
    this.tally.overthrows++;
    this.message = 'Overthrow!';
    this.events.push({ type: 'overthrow', end, t });
  }
  // A direct hit with the batters home: the ball off the stumps is still in play (overthrows).
  directRunsOn(t) {
    const h = this.hitPending;
    this.hitPending = null;
    if (h) this.overthrowNow(t, h.base, h.atThrow, h.end);
  }

  // Re-aim a throw that has not left the hand yet (the player chose the end).
  setThrowEnd(end) {
    const th = this.throw;
    if (!th || th.released || th.forced === end) return false;
    const changed = th.end !== end || th.forced !== end;
    th.forced = end;
    if (th.anim) {
      // (already winding up: it goes there, as it is)
      th.end = end;
      th.to = th.kind === 'direct' ? stumpsAim(end) : glovesPoint(end);
      const dd = Math.hypot(th.to.x - th.f.pos.x, th.to.z - th.f.pos.z);
      th.tArrive = th.tStart + dd / throwSpeedFor(dd, th.kind, this.cfg.field.throwSpeed);
      th.self = Math.hypot(th.f.pos.x, th.f.pos.z - STUMPS_Z[end]) < 2.2;
      this.setReceiverSide(end, th.f.pos.x);
    } else this.decide(this.hitT ?? 0);
    th.f.face = Math.atan2(th.to.x - th.f.pos.x, th.to.z - th.f.pos.z);
    return changed;
  }

  // Seconds from now until a ball that has got away (an overthrow) should be
  // back at a set of stumps (Infinity: nobody gets to it before the rope).
  estimateBack(t) {
    const p = this.plan, F = this.cfg.field;
    if (!p) return Infinity;
    const d = Math.min(Math.hypot(p.x, p.z), Math.hypot(p.x, p.z - PITCH.bowlingStumpsZ));
    return Math.max(0, (this.planT0 ?? t) + p.t - t) + F.pickupTime + d / F.throwSpeed;
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
    // The player's space wins over everything else (the keeper -- pads, gloves,
    // a wide crouch -- keeps a little further off).
    const ko = this.keepOut;
    if (ko) for (const f of F) if (!skip(f)) push(f, ko.x, ko.z, ko.r + (f.keeper ? KEEPER_PADS : 0));
    // (pushed out of your space toward the stumps: round the stumps along your space's edge, never into them -
    // unless he is the man breaking them, his 'take' action)
    if (ko) for (const s of STUMPS) for (const f of F) {
      if (skip(f) || (f.action && f.action.type === 'take')) continue;
      const dx = f.pos.x - s.x, dz = f.pos.z - s.z, d = Math.hypot(dx, dz);
      if (d >= STUMP_CLEAR) continue;
      push(f, s.x, s.z, STUMP_CLEAR);
      // (still in your space: slide him round your space's edge, away from the stumps, until he is out of both)
      const r = ko.r + (f.keeper ? KEEPER_PADS : 0);
      for (let i = 0; i < 8 && Math.hypot(f.pos.x - ko.x, f.pos.z - ko.z) < r; i++) {
        let ex = f.pos.x - ko.x, ez = f.pos.z - ko.z; const el = Math.hypot(ex, ez) || 1; ex /= el; ez /= el;
        f.pos.x = ko.x + ex * r; f.pos.z = ko.z + ez * r;
        if (Math.hypot(f.pos.x - s.x, f.pos.z - s.z) < STUMP_CLEAR) {
          const tx = -ez, tz = ex, sgn = (f.pos.x - s.x) * tx + (f.pos.z - s.z) * tz >= 0 ? 1 : -1;
          f.pos.x += tx * sgn * 0.1; f.pos.z += tz * sgn * 0.1;
        }
      }
    }
  }

  // A movement goal moved out of the player's space and out of the stumps.
  clearGoal(goal, f, ko) {
    let g = goal;
    for (const s of STUMPS) if (Math.hypot(g.x - s.x, g.z - s.z) < STUMP_CLEAR) { g = clampGoal(g.x, g.z, f.pos.x, f.pos.z, { x: s.x, z: s.z, r: STUMP_CLEAR }, _goal); }
    const kr = ko ? ko.r + (f.keeper ? KEEPER_PADS : 0) : 0;
    if (ko && Math.hypot(g.x - ko.x, g.z - ko.z) < kr) g = clampGoal(g.x, g.z, f.pos.x, f.pos.z, { x: ko.x, z: ko.z, r: kr }, _goal);
    return g;
  }

  // Back to positions after a ball.
  // Everyone on his mark at once, standing still, facing in, the ball out of
  // anyone's hands (a skip to the next ball: nobody can see it). The AI
  // bowler fielding for himself goes back into his own figure (out = false).
  settleAll() {
    this.throw = null; this.lob = null; this.lobFrom = null; this.ballOverride = null; this.shy = null;
    this.throwArrived = null; this.overthrow = null; this.events = [];
    this.dead = true; this.hurry = 0;
    for (const f of this.fielders) {
      f.playerControlled = false; f.out = false;
      f.pos.copy(f.home); f.vel.set(0, 0, 0); f.state = 'set'; f.target = null; f.speed = 0; f.prevDist = Infinity;
      f.action = null; f.leap = null; f.runIn = null; f.coverEnd = null; f.backEnd = null;
      f.face = f.yaw = this.restFace(f);
    }
  }
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
      // over the stumps, waiting for the throw: gloves up, a little crouched
      await: f.state === 'stumps' && !!f.target && Math.hypot(f.pos.x - f.target.x, f.pos.z - f.target.z) < 0.5 && !this.dead,
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


function airborne(ball) { return ball.batted && ball.bouncesSinceBat === 0; }

