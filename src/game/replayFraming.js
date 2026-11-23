import { hypot2, hypot3 } from '../physics/math.js';
// Replay camera geometry and timing (no three.js, so it can be tested in node).
// The cut itself (angles, tempo, which balls) is src/game/replayDirector.js.
//
// 1. Clearance. keepClear / nearestOnBody: the camera is never nearer than
//    CLEAR to anybody. A body is { a: top of the head, b: hips, c: the ground
//    under the hips }, points as { x, y, z }; the two segments a–b and b–c
//    stand in for the person. blocksSight / badness: who is in the way.
// 2. pathStats: what a run of camera poses did (cuts, speeds, the ball in view).
// 3. When a replay plays (replayAt) and how much tape it needs after the ball
//    is dead (tailFor).

export const CLEAR = 1.0;     // m: the replay camera never comes closer than this to anybody's head or body
export const SIGHT = 0.42;    // m: a body this close to the line of sight to the batter blocks the view

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Where along a→b (0..1) is nearest p.
export function segParam(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const L = abx * abx + aby * aby + abz * abz;
  if (L < 1e-9) return 0;
  return clamp(((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / L, 0, 1);
}
function lerpP(a, b, u, out) { out.x = a.x + (b.x - a.x) * u; out.y = a.y + (b.y - a.y) * u; out.z = a.z + (b.z - a.z) * u; return out; }
const dist = (p, q) => hypot3(p.x - q.x, p.y - q.y, p.z - q.z);

// The nearest point of a body to p (written into out).
export function nearestOnBody(p, B, out = { x: 0, y: 0, z: 0 }) {
  lerpP(B.a, B.b, segParam(p, B.a, B.b), out);
  const t = lerpP(B.b, B.c, segParam(p, B.b, B.c), {});
  if (dist(p, t) < dist(p, out)) { out.x = t.x; out.y = t.y; out.z = t.z; }
  return out;
}

// Move p (in place) until it is at least r from every body, and above the grass.
export function keepClear(p, bodies, r = CLEAR) {
  const q = { x: 0, y: 0, z: 0 };
  for (let it = 0; it < 4; it++) {
    let moved = false;
    for (const B of bodies) {
      nearestOnBody(p, B, q);
      const d = dist(p, q);
      if (d >= r - 1e-6) continue;
      let nx = 0, ny = 1, nz = 0;
      if (d > 1e-4) { nx = (p.x - q.x) / d; ny = (p.y - q.y) / d; nz = (p.z - q.z) / d; }
      p.x = q.x + nx * r; p.y = q.y + ny * r; p.z = q.z + nz * r;
      moved = true;
    }
    if (p.y < 0.35) p.y = 0.35;
    if (!moved) break;
  }
  return p;
}

// Does this body stand in the line of sight from pos to at?
export function blocksSight(pos, at, B, sight = SIGHT) {
  const w = {}, x = {};
  for (let i = 0; i <= 4; i++) {
    lerpP(B.a, B.c, i / 4, w);                            // head … ground
    const u = segParam(w, pos, at);
    if (u < 0.04 || u > 0.93) continue;
    if (dist(lerpP(pos, at, u, x), w) < sight) return true;
  }
  return false;
}

// How badly a camera at pos looking at `at` is placed: 3 for each body too
// close, 1 for each body in the way.
export function badness(pos, at, bodies) {
  let bad = 0;
  for (const B of bodies) {
    if (dist(pos, nearestOnBody(pos, B)) < CLEAR) bad += 3;
    if (blocksSight(pos, at, B)) bad += 1;
  }
  return bad;
}

const D2R = Math.PI / 180;
const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

// What a path (or a recorded run of camera poses) did, for tests and the
// harness: frames = [{ t, x, y, z, yaw, bx, by, bz, ball (in play and drawn) }].
// cuts: frames where the camera jumped (more than `jump` m, or `turn` rad, in one step).
export function pathStats(frames, { jump = 0.5, turn = 0.2, cone = 20 * D2R } = {}) {
  const s = { frames: frames.length, maxStep: 0, maxSpeed: 0, maxAccel: 0, maxYawRate: 0, maxYawAccel: 0, cuts: 0, maxRise: 0, minBall: Infinity, inCone: 1, worstOff: 0 };
  let pv = null, pw = null, seen = 0, inside = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (i > 0) {
      const p = frames[i - 1], dt = Math.max(1e-6, f.t - p.t);
      const step = hypot3(f.x - p.x, f.y - p.y, f.z - p.z), dy = Math.abs(wrap(f.yaw - p.yaw));
      const v = step / dt, wr = dy / dt;
      s.maxStep = Math.max(s.maxStep, step); s.maxSpeed = Math.max(s.maxSpeed, v); s.maxYawRate = Math.max(s.maxYawRate, wr);
      s.maxRise = Math.max(s.maxRise, Math.abs(f.y - p.y));
      if (step > jump || dy > turn) s.cuts++;
      const vel = [(f.x - p.x) / dt, (f.z - p.z) / dt], wv = wrap(f.yaw - p.yaw) / dt;
      if (pv) s.maxAccel = Math.max(s.maxAccel, hypot2(vel[0] - pv[0], vel[1] - pv[1]) / dt);
      if (pw != null) s.maxYawAccel = Math.max(s.maxYawAccel, Math.abs(wv - pw) / dt);
      pv = vel; pw = wv;
    }
    if (f.ball) {
      const dx = f.bx - f.x, dz = f.bz - f.z;
      s.minBall = Math.min(s.minBall, hypot3(dx, f.by - f.y, dz));
      const off = hypot2(dx, dz) > 0.5 ? Math.abs(wrap(Math.atan2(dx, dz) - f.yaw)) : 0;
      seen++; if (off <= cone) inside++;
      s.worstOff = Math.max(s.worstOff, off);
    }
  }
  s.inCone = seen ? inside / seen : 1;
  return s;
}

// ---------------------------------------------------------------- the timing
export const TAIL = 1.0;    // s on the tape after the ball is dead before its replay starts…
export const TAIL_OUT = 2.0;   // …after a catch, or the stumps broken by a fielder (stumped, run out, or a near thing)
export const tailFor = (m) => (m && (m.caught != null || m.break != null) ? TAIL_OUT : TAIL);

// When the replay of a ball whose result went up at t plays (game s): once
// TAIL s of its aftermath are on the tape; after a review (the result came
// well after the ball was dead), a moment after the verdict.
export function replayAt(m, t) {
  const dead = m.dead ?? t;
  return Math.max(dead + tailFor(m) + 0.05, t + (t - dead > 0.5 ? 1.0 : 0));
}
