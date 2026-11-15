// Throws in the field, as a fielder makes them. Pure JS (no three.js).
//   - decideThrow(): where the ball goes once he has it -- a shy at the stumps
//     when a run-out is really on, a throw over the stumps into a teammate's
//     gloves when one is there (or will be by the time the ball is), a safe
//     return (on one bounce from the deep) when nothing is on, or he waits /
//     runs it in until someone is at the stumps;
//   - how accurate it is (throwScatter: distance, a hurried or stretched throw,
//     the fielder's skill) and whether a shy hits the wicket (hitsStumps, with
//     the same wicket box the ball physics uses);
//   - the flight (throwPoint) and the velocity it carries on with if nobody
//     takes it (continuation): the session hands it back to the ball physics,
//     so a missed throw runs on (overthrows) instead of stopping dead;
//   - overthrow scoring by the Laws (overthrowRuns, boundaryOverthrowRuns).
import { Vec3, clamp } from '../physics/math.js';
import { PITCH } from '../physics/pitch.js';
import { Wicket } from '../physics/wicket.js';
import { CONFIG } from '../config.js';

export const STUMPS_Z = { batting: PITCH.battingStumpsZ, bowling: PITCH.bowlingStumpsZ };
export const ENDS = ['batting', 'bowling'];
export const CREASE_TO_CREASE = PITCH.length - 2 * PITCH.poppingOffset;   // 17.68 m
const R = CONFIG.ball.radius;

export const THROW = {
  windup: 0.47,          // s of the throw before the ball leaves the hand (the figure's THROW_LEAD)
  takeBreak: 0.22,       // s from a take over the stumps to the bails coming off
  reach: 1.0,            // m to either side a fielder over the stumps takes a throw (a step and a stretch)
  keeperReach: 1.25,     // ... the keeper (gloves, and quick feet)
  runnerReach: 1.0,      // m the bat reaches ahead of a running batter (no dive)
  chance: 0.3,           // m: a batter this far short when the ball gets there is a run-out chance
  sure: 1.2,             // m: ... and this far short, a good one (a shy is worth it with nobody backing up)
  directMax: 32,         // m: nobody shies at the stumps from further than this
  minHit: 0.1,           // chance of hitting below which nobody shies
  aloneHit: 0.35,        // ... and with nobody at or behind the stumps to stop a miss (he would rather wait for a teammate)
  bounceFrom: 38,        // m: a safe return from further than this comes in on one bounce
  holdRunning: 1.4,      // s at most he holds the ball for a teammate while the batters are running
  holdStill: 4.0,        // ... while they are standing in their ground
  runInFrom: 24,         // m: holding it further out than this, he runs the ball in
  fumble: 0.03,          // chance a clean take over the stumps goes down (skill 1)
  backDist: 14,          // m behind the stumps a man backing up stands, in line with the throw
  carry: 0.82,           // of a throw's speed left when it passes the stumps (drag)
  carryBounce: 0.62,     // ... of one that came in on the bounce (the turf takes more)
};

const WICKETS = { batting: new Wicket('batting', STUMPS_Z.batting), bowling: new Wicket('bowling', STUMPS_Z.bowling) };

// Error function (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7).
export function erf(x) {
  const s = x < 0 ? -1 : 1, a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
}
function gauss(rng) {
  const u = Math.max(1e-9, rng()), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// The point a man over the stumps takes a throw at (just behind them, at the chest).
export function glovesPoint(end, out = new Vec3()) {
  return out.set(0, 1.0, end === 'batting' ? STUMPS_Z.batting + 0.4 : STUMPS_Z.bowling - 0.4);
}
// The middle of the stumps (where a shy is aimed).
export function stumpsAim(end, out = new Vec3()) { return out.set(0, 0.36, STUMPS_Z[end]); }

// How hard a throw is (m/s) over `dist` m: a shy is flat out, a throw to
// the gloves with a run-out on nearly so, a safe return from close in only
// a firm lob (nobody fires a ball at a teammate from 5 m).
export function throwSpeedFor(dist, kind = 'return', top = CONFIG.field.throwSpeed) {
  if (kind === 'direct') return Math.min(top, 18 + 0.45 * dist);
  if (kind === 'gloves') return Math.min(top, 12 + 0.6 * dist);
  return Math.min(top - 1, 8 + 0.55 * dist);
}

// Spread (1 sigma, m) of where a throw arrives, across its line and up/down.
// A shy is a flat, hard throw at a target 23 cm wide; a throw to the gloves a
// little looser. Longer, hurried (on the run, after a dive) and less skilled
// throws are wider.
export function throwScatter(dist, { kind = 'gloves', hurried = false, skill = 1 } = {}) {
  const k = (hurried ? 1.3 : 1) / Math.max(0.4, skill);
  return {
    lat: (kind === 'direct' ? 0.07 + 0.0125 * dist : 0.07 + 0.012 * dist) * k,
    ver: (kind === 'direct' ? 0.04 + 0.009 * dist : 0.06 + 0.008 * dist) * k,
  };
}

// The chance a shy from `from` {x, z} at the stumps at `end` hits them: the
// wicket is as wide as it looks along the throw (23 cm square on to the
// pitch, one stump's width side on) and as tall as the stumps.
export function directHitChance(from, end, sig) {
  const dx = -from.x, dz = STUMPS_Z[end] - from.z, d = Math.hypot(dx, dz) || 1;
  const across = Math.abs(dz / d) * (PITCH.wicketHalfWidth - PITCH.stumpRadius) + PITCH.stumpRadius + R;
  const halfH = (PITCH.stumpHeight + PITCH.bailRise + 2 * R) / 2;
  return erf(across / (sig.lat * Math.SQRT2)) * erf(halfH / (sig.ver * Math.SQRT2));
}

// Does a ball arriving at `to` along the horizontal direction (ux, uz) hit the
// wicket at `end`? Returns the contact point (Vec3) or null. The same box the
// ball physics sweeps (src/physics/wicket.js).
const _a = new Vec3(), _b = new Vec3();
export function hitsStumps(to, ux, uz, end, slope = 0) {
  _a.set(to.x - ux * 1.5, to.y - slope * 1.5, to.z - uz * 1.5);
  _b.set(to.x + ux * 1.5, to.y + slope * 1.5, to.z + uz * 1.5);
  const s = WICKETS[end].sweep(_a, _b, R);
  return s < 0 ? null : new Vec3(_a.x + (_b.x - _a.x) * s, _a.y + (_b.y - _a.y) * s, _a.z + (_b.z - _a.z) * s);
}

// Where a throw goes, decided as a fielder would. All times in s from now.
//   from      {x, z} where he throws from
//   release   s until the ball can leave his hand (the pick-up / wind-up still to do)
//   runner    null (the batters are in their ground) or { remaining: m to the
//             ground for each of them, v: m/s they run at, back: turning back }
//   ends      { batting, bowling }: { readyIn: s until a teammate is over those
//             stumps (0: there now; Infinity: nobody coming), backed: someone
//             backing up behind them, self: the thrower is at them himself }
//   forced    an end the player has chosen (the throw goes there)
//   held      s he has already held the ball waiting
// Returns { end, kind: 'direct' | 'gloves' | 'return', wait (s more to hold: >
// 0 means not yet), bounce (a one-bounce return), short (m the batter would be
// short), pHit, dist, why }.
export function decideThrow({ from, release = 0, runner = null, ends, speed = CONFIG.field.throwSpeed, skill = 1, hurried = false, forced = null, held = 0 } = {}) {
  const T = THROW, opt = {};
  for (const E of ENDS) {
    const e = ends[E] || { readyIn: Infinity };
    const d = Math.hypot(from.x, from.z - STUMPS_Z[E]);
    const arrive = release + d / throwSpeedFor(d, 'return', speed);      // a safe return
    const arriveD = release + d / throwSpeedFor(d, 'direct', speed);     // a shy
    const arriveG = release + d / throwSpeedFor(d, 'gloves', speed);     // hard, into the gloves
    const ready = !!e.self || e.readyIn <= arriveG - 0.05;
    const short = (dt) => (runner ? runner.remaining - runner.v * dt - T.runnerReach : -Infinity);
    const sig = throwScatter(d, { kind: 'direct', hurried, skill });
    const pHit = d <= T.directMax && !e.self ? directHitChance(from, E, sig) : 0;
    opt[E] = { E, d, arrive, ready, readyR: !!e.self || e.readyIn <= arrive - 0.05, readyIn: e.self ? 0 : e.readyIn, backed: !!e.backed, self: !!e.self,
      shortDirect: short(arriveD), shortGloves: short(arriveG + T.takeBreak), pHit,
      near: e.self || e.readyIn <= arriveD + 0.35 };       // someone at the stumps (or nearly) to stop a miss
  }
  const pack = (o, kind, why, wait = 0) => ({
    end: o.E, kind, wait: Math.max(0, wait), why, dist: o.d, pHit: o.pHit,
    short: kind === 'direct' ? o.shortDirect : o.shortGloves,
    bounce: kind === 'return' && o.d > T.bounceFrom,
  });
  const directOk = (o) => o.pHit >= T.minHit && o.shortDirect > T.chance
    && (o.backed || o.near || o.pHit >= T.aloneHit || o.shortDirect > T.sure);
  // The player chose the end: the ball goes there, into the gloves if someone
  // is there to take it, else at the stumps.
  if (forced && opt[forced]) {
    const o = opt[forced];
    if (o.ready) return pack(o, o.shortGloves > T.chance ? 'gloves' : 'return', 'chosen');
    if (directOk(o) || !(o.readyIn < Infinity) || held >= T.holdRunning) return pack(o, 'direct', 'chosen, nobody there');
    return pack(o, 'return', 'chosen, waiting for him', o.readyIn - (o.arrive - 0.05));
  }
  const both = [opt.batting, opt.bowling];
  // (a) a teammate over the stumps and the batter short: into his gloves, he breaks the wicket
  const gl = both.filter((o) => o.ready && o.shortGloves > T.chance).sort((a, b) => b.shortGloves - a.shortGloves)[0];
  // (b) a real chance only a direct hit takes (nobody there in time, or the take would be too slow)
  const di = both.filter(directOk).sort((a, b) => b.pHit * Math.min(1.5, b.shortDirect) - a.pHit * Math.min(1.5, a.shortDirect))[0];
  if (gl && !(di && di.shortDirect > T.sure && gl.shortGloves < T.chance + 0.3 && di.pHit > 0.4)) return pack(gl, 'gloves', 'run-out on: to the gloves');
  if (di) return pack(di, 'direct', di.near || di.backed ? 'shy: run-out on' : 'shy: run-out on, nobody backing up');
  // (c) nothing on: a safe return to whoever is at the stumps (to stop the next run)
  const ready = both.filter((o) => o.readyR);
  if (ready.length) {
    let o;
    if (runner) o = ready.sort((a, b) => a.arrive - b.arrive)[0];           // the quicker end
    else o = ready.length === 2 && opt.bowling.arrive < 0.6 * opt.batting.arrive ? opt.bowling : (ready.find((x) => x.E === 'batting') || ready[0]);
    return pack(o, 'return', 'safe return');
  }
  // Nobody there yet: hold it (or run it in) until someone will be, timed so
  // the ball and the teammate get there together; not for long while the batters run.
  const next = both.filter((o) => o.readyIn < Infinity).sort((a, b) => (a.readyIn - a.arrive) - (b.readyIn - b.arrive))[0];
  const cap = runner ? T.holdRunning : T.holdStill;
  if (next) {
    const wait = next.readyIn - (next.arrive - 0.05);
    if (held < cap || !(next.backed || next.near)) return pack(next, 'return', 'waiting for a teammate at the stumps', held < cap + 2 ? wait : 0);
    return pack(next, 'return', 'held long enough: to the stumps', 0);
  }
  // nobody coming at all (should not happen): to the nearer end
  const o = opt.batting.d <= opt.bowling.d ? opt.batting : opt.bowling;
  return pack(o, 'return', 'nobody coming');
}

// Where a throw is k (0..1) of the way along (out: Vec3): a line from th.from
// to th.to lifted by an arc; on one bounce (th.bounce = the fraction of the
// way it comes down) it skids up off the turf for the last part.
export function throwPoint(th, k, out = new Vec3()) {
  const a = th.from, b = th.to;
  out.x = a.x + (b.x - a.x) * k;
  out.z = a.z + (b.z - a.z) * k;
  if (th.bounce) {
    const kb = th.bounce;
    if (k < kb) { const u = k / kb; out.y = a.y + (R - a.y) * u + Math.sin(Math.PI * u) * th.arc; }
    else { const u = (k - kb) / (1 - kb); out.y = R + (b.y - R) * Math.sin(u * Math.PI / 2) + 0.12 * Math.sin(Math.PI * u); }
  } else out.y = a.y + (b.y - a.y) * k + Math.sin(Math.PI * k) * th.arc;
  return out;
}
// How high a throw of `dist` m arcs (flat and hard at the stumps).
export function throwArc(dist, kind, bounce) {
  if (bounce) return Math.min(3.0, dist * bounce * 0.06);
  return Math.min(6, dist * (kind === 'direct' ? 0.045 : 0.08));
}

// The velocity a throw carries on with past its end point (m/s, Vec3): the
// path's own direction at the end, a little slower (THROW.carry).
const _p0 = new Vec3(), _p1 = new Vec3();
export function continuation(th, out = new Vec3()) {
  const T = Math.max(1e-3, th.tArrive - th.tStart), e = 0.02;
  throwPoint(th, 1 - e, _p0); throwPoint(th, 1, _p1);
  out.set((_p1.x - _p0.x) / (e * T), (_p1.y - _p0.y) / (e * T), (_p1.z - _p0.z) / (e * T));
  return out.scale(th.bounce ? THROW.carryBounce : THROW.carry);
}

// Off the stumps (the response the ball physics gives a ball hitting the
// wicket box, src/physics/world.js): most of the pace along the pitch is
// lost, some across it kept.
export function deflectOffStumps(vel, end, fromZ, out = new Vec3()) {
  out.copy(vel);
  const toward = Math.sign(STUMPS_Z[end] - fromZ);
  if (Math.sign(out.z) === toward) out.z *= -0.25;
  out.x *= 0.6; out.y = Math.abs(out.y) * 0.5;
  return out;
}

// Make a throw's actual flight: aim + scatter, and what happens at the end of
// it. th: { from, end, kind, bounce }; rng; opts: { skill, hurried,
// receiver: { pos {x, z}, there (he will be over the stumps when it arrives),
// reach (m to either side he can take it) } | null }. A throw that arrives
// low he takes on the bounce.
// Sets th.to, th.arc, th.result ('take' | 'hit' | 'miss' | 'fumble'), th.contact (a hit).
export function aimThrow(th, rng, { skill = 1, hurried = false, receiver = null, speed = CONFIG.field.throwSpeed } = {}) {
  const T = THROW;
  const aim = th.kind === 'direct' ? stumpsAim(th.end) : glovesPoint(th.end);
  const dx = aim.x - th.from.x, dz = aim.z - th.from.z, d = Math.hypot(dx, dz) || 1, ux = dx / d, uz = dz / d;
  const sig = throwScatter(d, { kind: th.kind === 'direct' ? 'direct' : 'gloves', hurried, skill });
  const el = gauss(rng) * sig.lat, ev = gauss(rng) * sig.ver;
  th.to = new Vec3(aim.x - uz * el, Math.max(R, aim.y + ev), aim.z + ux * el);
  th.err = { lat: el, ver: ev };
  th.dist = d;
  th.bounce = th.bounce ? clamp(1 - 9 / d, 0.6, 0.85) : 0;
  th.arc = throwArc(d, th.kind, th.bounce);
  th.flight = d / throwSpeedFor(d, th.kind, speed);
  if (th.kind === 'direct') {
    const c = hitsStumps(th.to, ux, uz, th.end, (th.to.y - th.from.y) / d - Math.PI * th.arc / d);
    if (c) { th.to.copy(c); th.result = 'hit'; th.contact = c; return th; }
    // missed: a man at the stumps takes it as it goes past him, if it passes within reach
    if (receiver && receiver.there) {
      const px = receiver.pos.x - th.to.x, pz = receiver.pos.z - th.to.z;
      const along = px * ux + pz * uz, across = Math.abs(px * uz - pz * ux);
      if (along > -0.4 && along < 2.5 && across < (receiver.reach || T.reach) && th.to.y < 2.0) {
        th.to.set(receiver.pos.x - ux * 0.25, clamp(th.to.y + 0.25, 0.4, 1.6), receiver.pos.z - uz * 0.25);
        th.result = 'take'; return th;
      }
    }
    th.result = 'miss';
    return th;
  }
  // into the gloves: taken if he is there and it comes within his reach
  const inReach = Math.abs(el) < (receiver ? receiver.reach || T.reach : T.reach) && th.to.y < 2.3;
  if (receiver && receiver.there && inReach) th.result = rng() < T.fumble / Math.max(0.5, skill) ? 'fumble' : 'take';
  else th.result = 'miss';
  return th;
}

// ---- scoring (Law 19) ----
// Runs off a ball on which a throw went for overthrows: the runs they
// completed in all; those run after the throw got past the stumps (beyond the
// run in progress then) are the overthrows.
export function overthrowRuns(total, base) {
  const b = Math.min(total, Math.max(0, base));
  return { runs: total, base: b, overthrows: Math.max(0, total - b) };
}
// Overthrows to the boundary (Law 19.8): the boundary allowance + the runs
// completed + the run in progress if the batters had crossed at the instant
// of the throw.
export function boundaryOverthrowRuns({ completed = 0, crossed = false } = {}, allowance = 4) {
  const ran = completed + (crossed ? 1 : 0);
  return { runs: allowance + ran, ran, overthrows: allowance };
}
// Had the batters crossed on the run in progress (passed each other half-way)?
export function crossedNow(runs) {
  if (!runs || !runs.running || runs.goingBack) return false;
  return runs.p - Math.floor(runs.p + 1e-6) >= 0.5;
}
