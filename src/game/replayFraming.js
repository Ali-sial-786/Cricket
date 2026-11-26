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

// ---------------------------------------------------------------- what a view shows
// What fills a view from cam (x, y, z) facing (yaw, pitch), as shares of an n x n
// grid of rays over hfov x vfov degrees: { turf, boards, screen, stand, sky } (the ground
// inside the boards; the advertising boards, BOARD_R m from the middle and
// BOARD_TOP m tall; a sightscreen; the stands and the crowd above / beyond them, up to 25° above
// level; the sky). For the tests, the harness and the director's choice of a
// boundary's last angle (at plan time, never per frame): its last picture must
// not be a board close-up or a sightscreen.
export const BOARD_R = 68.2, BOARD_TOP = 0.975;
// The sightscreens (render/ground.js SIGHTSCREEN): a dark face 26 m wide, 0.6-10.8 m up, 6 m behind the rope
// straight behind either end. A picture full of one is as bad as one full of boards.
export const SCREEN = { half: 13, bottom: 0.6, top: 10.8, dist: 71 };
export function viewShares(cam, yaw, pitch = 0, { hfov = 100, vfov = 90, n = 24, nv = n, cz = -10.06 } = {}) {
  const out = { turf: 0, boards: 0, screen: 0, stand: 0, sky: 0 };
  const cy = Math.cos(yaw), sy = Math.sin(yaw), tH = Math.tan(hfov / 2 * Math.PI / 180), tV = Math.tan(vfov / 2 * Math.PI / 180);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  for (let i = 0; i < n; i++) for (let j = 0; j < nv; j++) {
    const u = ((i + 0.5) / n * 2 - 1) * tH, v = ((j + 0.5) / nv * 2 - 1) * tV;
    // camera space: forward (0, 0, 1) as yaw 0 faces +z; right = -x... (yaw: atan2(x, z))
    const fy = sp + v * cp, fh = cp - v * sp;                       // pitched forward / up
    let dx = sy * fh + cy * u, dz = cy * fh - sy * u, dy = fy;
    const L = Math.sqrt(dx * dx + dy * dy + dz * dz); dx /= L; dy /= L; dz /= L;
    // the boards: |p - c| = BOARD_R in xz, BOARD_TOP >= y >= 0
    const ox = cam.x, oz = cam.z - cz, a = dx * dx + dz * dz, b = 2 * (ox * dx + oz * dz), c = ox * ox + oz * oz - BOARD_R * BOARD_R;
    let tb = Infinity;
    if (a > 1e-9) { const disc = b * b - 4 * a * c; if (disc >= 0) { const t = (-b + Math.sqrt(disc)) / (2 * a); if (t > 0) tb = t; } }
    const tg = dy < -1e-6 ? -cam.y / dy : Infinity;
    // a sightscreen: the plane z = cz ± SCREEN.dist, |x| <= half, bottom..top
    let ts = Infinity;
    for (let e = -1; e <= 1; e += 2) {
      if (Math.abs(dz) < 1e-9) continue;
      const t = (cz + e * SCREEN.dist - cam.z) / dz;
      if (t <= 0 || t >= ts) continue;
      const x = cam.x + dx * t, y = cam.y + dy * t;
      if (Math.abs(x) <= SCREEN.half && y >= SCREEN.bottom && y <= SCREEN.top) ts = t;
    }
    // (the boards stop a ray only where it meets them below their top; above, it goes on to the screen or the stand)
    const yb = cam.y + dy * tb, tbv = tb < Infinity && yb <= BOARD_TOP && yb >= 0 ? tb : Infinity;
    // (the ground beyond the boards is under the stands: a ray coming down there meets the crowd first)
    const tgv = tg < Infinity && (ox + dx * tg) ** 2 + (oz + dz * tg) ** 2 <= BOARD_R * BOARD_R ? tg : Infinity;
    if (ts < tgv && ts < tbv) out.screen++;
    else if (tgv < tbv) out.turf++;
    else if (tbv < Infinity) out.boards++;
    else if (Math.asin(dy) < 25 * Math.PI / 180) out.stand++;
    else out.sky++;
  }
  const N = n * nv;
  out.turf /= N; out.boards /= N; out.screen /= N; out.stand /= N; out.sky /= N;
  return out;
}
