// Replay camera (no three.js, so it can be tested in node).
//
// 1. The path. One camera, one move: it stands high behind the bowler's arm,
//    looking down the pitch, through the run-up, the release and the ball's
//    flight; from the moment the ball reaches the batter it follows the ball,
//    turning (yaw only) to keep it ahead and gliding in to about CAM.near
//    metres of it (never nearer than CAM.short to the batter's crease along
//    the pitch, not under a ball going up high, not toward one coming at it). It
//    never cuts, never changes height, never rolls or pitches, and its speed,
//    acceleration, turn rate and turn acceleration are bounded (planCamera).
//    The whole path is laid out before the replay starts, from the recorded
//    ball, so it can look a little ahead of the ball instead of lagging it,
//    side-step a ball driven back at it early, and start a turn it cannot make
//    in time (a ball whipping past) before the ball gets there.
//    clipFor / replayAt: which stretch of the tape a ball's replay shows, and
//    when it plays (every ball that was bowled gets one, once).
// 2. Clearance. keepClear / nearestOnBody: the camera is never nearer than
//    CLEAR to anybody. A body is { a: top of the head, b: hips, c: the ground
//    under the hips }, points as { x, y, z }; the two segments a–b and b–c
//    stand in for the person.

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
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);

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

// ---------------------------------------------------------------- the path
const D2R = Math.PI / 180;
export const CAM = {
  back: 7.5,          // m behind the bowler's stumps
  height: 3.5,        // m: over the umpire and the bowler's arm; more than CLEAR above anybody's head
  x: 0,               // on the line of the stumps
  near: 15,           // m: after the shot it closes in on the ball (the catch, the pick-up, the throw) to about this far, horizontally
  short: 7,           // m: it never comes nearer than this to the batter's popping crease along the pitch (a ball behind him is watched over his head)
  aside: 2.5,         // m: …and from this far to the other side of the stumps from him, so he does not hide the keeper
  high: 38 * D2R,     // a ball going up is kept within this of level (it does not close in under a skied ball)…
  highT: 1.5,         // …looking this far ahead
  lookAhead: 0.3,     // s: it turns toward where the ball will be this much later
  lead: 0.1,          // s the eased turn follows its plan ahead by (its own lag)
  share: 0.4,         // of a turn too quick to make (a ball whipping past), the part made before the ball gets there
  cone: 32 * D2R,     // the comfortable forward view: the ball should stay inside it
  rim: 58,            // m from the middle: the ball's stand-in never goes further (the camera stays inside the rope)
  dodge: 7.0,         // m: a ball coming this close within dodgeT s is side-stepped (it then passes to one side)
  dodgeT: 2.0,
  dodgeGain: 1.5,
  // headset: gentle; monitor: brisker
  xr:   { vMax: 6,  aMax: 4, wMax: 75 * D2R,  wAcc: 220 * D2R },
  desk: { vMax: 12, aMax: 9, wMax: 120 * D2R, wAcc: 420 * D2R },
};
const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

// Where the camera stands for the delivery. z0: the bowler's stumps; dir: +1
// when the batter is toward +z from them.
export function cameraBase(bowlingStumpsZ, dir = 1) {
  return { x: CAM.x, y: CAM.height, z: bowlingStumpsZ - dir * CAM.back };
}

// Lay out the camera for a clip.
//   n, dt        samples and their spacing (s)
//   ball(i, o)   the ball at sample i, written into o {x, y, z}; returns false while there is no ball to follow
//   key          the first sample at which the ball has reached the batter (n if it never does)
//   base         where the camera starts {x, y, z}
//   face         the point it faces until then {x, z} (the batter's end of the pitch)
//   dead         the sample at which the ball was dead (n if never): the framing holds there
//                (a ball lobbed back, overthrows running on, are not chased); the
//                side-step still watches the ball (a throw coming back at the camera)
//   strikerX     where the striker stands across the pitch (his side of the stumps):
//                a ball behind him is watched from the other side, so he does not hide the keeper
//   centerZ      the middle of the ground (for the rim)
//   lim          CAM.xr or CAM.desk
// Returns { n, dt, x, y, z, yaw } (Float32Array each; yaw: atan2(x, z) of the way it faces).
export function planCamera({ n, dt, ball, key, base, face, dead = n, strikerX = -0.4, centerZ = -10.06, lim = CAM.xr }) {
  const X = new Float32Array(n), Y = new Float32Array(n), Z = new Float32Array(n), W = new Float32Array(n);
  // The subject on the ground: the batter's end, then the ball (held where it
  // was last seen, and from the moment it is dead); r*: the ball itself.
  const sx = new Float32Array(n), sy = new Float32Array(n), sz = new Float32Array(n);
  const rx = new Float32Array(n), ry = new Float32Array(n), rz = new Float32Array(n);
  const o = { x: 0, y: 0, z: 0 };
  let lx = face.x, ly = 0, lz = face.z, hx = lx, hy = ly, hz = lz;
  for (let i = 0; i < n; i++) {
    if (i >= key && ball(i, o)) {
      lx = o.x; ly = o.y; lz = o.z;
      const r = Math.hypot(lx, lz - centerZ);
      if (r > CAM.rim) { lx *= CAM.rim / r; lz = centerZ + (lz - centerZ) * CAM.rim / r; }
    }
    rx[i] = lx; ry[i] = ly; rz[i] = lz;
    if (i <= dead) { hx = lx; hy = ly; hz = lz; }
    sx[i] = hx; sy[i] = hy; sz[i] = hz;
  }
  // 1. Where it stands: still until the ball reaches the batter, then it
  //    closes in on the ball to about CAM.near (whatever happens to it: the
  //    keeper taking it, the fielder picking it up, his throw, the catch),
  //    never nearer than CAM.short to the batter's crease along the pitch.
  //    A ball that is going up high is not closed in on (it would go out of
  //    the top of the view): the distance kept is at least what puts the
  //    highest it gets in the next CAM.highT s within CAM.high of level.
  //    A ball behind the striker is watched from the far side of the stumps
  //    from him (CAM.aside), so he is not in the way of the keeper's take.
  const dirZ = Math.sign(face.z - base.z) || 1, zStop = face.z - dirZ * CAM.short, side = strikerX <= base.x ? 1 : -1;
  const dodgeN = Math.round(CAM.dodgeT / dt), hiN = Math.round(CAM.highT / dt), tanHigh = Math.tan(CAM.high);
  // (behind[i]: the ball is behind the striker now or within the next second: the side-step starts at the shot)
  const behind = new Uint8Array(n), aheadN = Math.round(1.0 / dt);
  for (let i = n - 1, last = -1; i >= 0; i--) {
    if ((sz[i] - face.z) * dirZ > 0.5) last = i;
    behind[i] = last >= 0 && last - i <= aheadN ? 1 : 0;
  }
  let px = base.x, pz = base.z, vx = 0, vz = 0;
  for (let i = 0; i < n; i++) {
    let gx = 0, gz = 0;
    if (i >= key) {
      let top = sy[i];
      for (let j = i + 1, je = Math.min(n, i + hiN); j < je; j++) if (sy[j] > top) top = sy[j];
      const dx = sx[i] - px, dz = sz[i] - pz;
      const L = Math.hypot(dx, dz), over = L - Math.max(CAM.near, (top - base.y) / tanHigh);
      if (over > 0 && L > 1e-6) {
        const sp = Math.min(lim.vMax, 1.5 * over, Math.sqrt(1.6 * lim.aMax * over));
        gx = dx / L * sp; gz = dz / L * sp;
      }
      if (behind[i]) gx += clamp((base.x + side * CAM.aside - px) * 1.5, -lim.vMax, lim.vMax);
    }
    // --- side-step a ball that is coming at the camera (so it passes to one side)
    if (i >= key) {
      let best = CAM.dodge * CAM.dodge, bj = -1;
      for (let j = i, je = Math.min(n, i + dodgeN); j < je; j++) {
        const ex = rx[j] - px, ey = ry[j] - base.y, ez = rz[j] - pz, d2 = ex * ex + ey * ey + ez * ez;
        if (d2 < best) { best = d2; bj = j; }
      }
      if (bj >= 0) {
        best = Math.sqrt(best);
        // away from the ball's line: across the way it is travelling
        const j0 = Math.max(0, bj - 1), j1 = Math.min(n - 1, bj + 1);
        let tx = rx[j1] - rx[j0], tz = rz[j1] - rz[j0];
        const tl = Math.hypot(tx, tz);
        let ax = px - rx[bj], az = pz - rz[bj];
        if (tl > 1e-6) { tx /= tl; tz /= tl; const along = ax * tx + az * tz; ax -= along * tx; az -= along * tz; }
        let al = Math.hypot(ax, az);
        if (al < 0.05) { ax = tl > 1e-6 ? -tz : 1; az = tl > 1e-6 ? tx : 0; al = 1; }
        const k = lim.vMax * Math.min(1, CAM.dodgeGain * (1 - best / CAM.dodge));
        gx = ax / al * k; gz = az / al * k;              // (no closing in on a ball that is coming at it)
      }
    }
    // (toward the batter's end only as fast as it can still stop short of zStop)
    const room = (zStop - pz) * dirZ, vCap = room > 0 ? Math.sqrt(1.6 * lim.aMax * room) : 0;
    if (gz * dirZ > vCap) gz = dirZ * vCap;
    const gl = Math.hypot(gx, gz);
    if (gl > lim.vMax) { gx *= lim.vMax / gl; gz *= lim.vMax / gl; }
    let ax = (gx - vx) / dt, az = (gz - vz) / dt;
    const al = Math.hypot(ax, az);
    if (al > lim.aMax) { ax *= lim.aMax / al; az *= lim.aMax / al; }
    vx += ax * dt; vz += az * dt;
    px += vx * dt; pz += vz * dt;
    X[i] = px; Y[i] = base.y; Z[i] = pz;
  }
  // 2. Which way it faces. The bearing to where the ball will be a moment
  //    later (unwrapped: it turns the short way round, the side the ball passes).
  const la = Math.max(0, Math.round(CAM.lookAhead / dt));
  const b = new Float64Array(n);
  let prev = Math.atan2(face.x - base.x, face.z - base.z);
  for (let i = 0; i < n; i++) {
    const k = i < key ? i : Math.min(n - 1, i + la), dx = sx[k] - X[i], dz = sz[k] - Z[i];   // (no peeking past the shot)
    if (Math.hypot(dx, dz) > 2) prev += wrap(Math.atan2(dx, dz) - prev);
    b[i] = prev;
  }
  //    A turn quicker than it can make (a ball whipping past) is spread round
  //    the moment: `share` of it before (from the shot on, never before it),
  //    the rest after. f: the bearing rate-limited forward in time (late),
  //    g: backward (early); the plan is their mix.
  const r = 2 * 0.9 * lim.wMax * dt, f = new Float64Array(n), g = new Float64Array(n);
  f[0] = b[0];
  for (let i = 1; i < n; i++) f[i] = f[i - 1] + clamp(b[i] - f[i - 1], -r, r);
  g[n - 1] = b[n - 1];
  for (let i = n - 2; i >= 0; i--) g[i] = i < key ? b[i] : g[i + 1] + clamp(b[i] - g[i + 1], -r, r);
  //    The turn itself: eased toward the plan, its rate and its acceleration bounded.
  const lead = Math.max(0, Math.round(CAM.lead / dt));
  let yaw = b[0], w = 0;
  for (let i = 0; i < n; i++) {
    const k = i < key ? i : Math.min(n - 1, i + lead), e = (1 - CAM.share) * f[k] + CAM.share * g[k] - yaw;
    const ws = Math.sign(e) * Math.min(lim.wMax, 4 * Math.abs(e), Math.sqrt(1.6 * lim.wAcc * Math.abs(e)));
    w += clamp(ws - w, -lim.wAcc * dt, lim.wAcc * dt);
    yaw += w * dt;
    W[i] = yaw;
  }
  return { n, dt, x: X, y: Y, z: Z, yaw: W };
}

// The path at time u (s from its first sample): { x, y, z, yaw } written into out.
export function cameraAt(path, u, out = {}) {
  const f = Math.max(0, Math.min(path.n - 1, u / path.dt)), i = Math.min(path.n - 2, Math.floor(f)), k = path.n > 1 ? f - i : 0;
  if (path.n < 2) { out.x = path.x[0]; out.y = path.y[0]; out.z = path.z[0]; out.yaw = path.yaw[0]; return out; }
  out.x = path.x[i] + (path.x[i + 1] - path.x[i]) * k;
  out.y = path.y[i] + (path.y[i + 1] - path.y[i]) * k;
  out.z = path.z[i] + (path.z[i + 1] - path.z[i]) * k;
  out.yaw = path.yaw[i] + (path.yaw[i + 1] - path.yaw[i]) * k;
  return out;
}

// What a path (or a recorded run of camera poses) did, for tests and the
// harness: frames = [{ t, x, y, z, yaw, bx, by, bz, ball (in play and drawn) }].
// cuts: frames where the camera jumped (more than `jump` m, or `turn` rad, in one step).
export function pathStats(frames, { jump = 0.5, turn = 0.2, cone = CAM.cone } = {}) {
  const s = { frames: frames.length, maxStep: 0, maxSpeed: 0, maxAccel: 0, maxYawRate: 0, maxYawAccel: 0, cuts: 0, maxRise: 0, minBall: Infinity, inCone: 1, worstOff: 0 };
  let pv = null, pw = null, seen = 0, inside = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (i > 0) {
      const p = frames[i - 1], dt = Math.max(1e-6, f.t - p.t);
      const step = Math.hypot(f.x - p.x, f.y - p.y, f.z - p.z), dy = Math.abs(wrap(f.yaw - p.yaw));
      const v = step / dt, wr = dy / dt;
      s.maxStep = Math.max(s.maxStep, step); s.maxSpeed = Math.max(s.maxSpeed, v); s.maxYawRate = Math.max(s.maxYawRate, wr);
      s.maxRise = Math.max(s.maxRise, Math.abs(f.y - p.y));
      if (step > jump || dy > turn) s.cuts++;
      const vel = [(f.x - p.x) / dt, (f.z - p.z) / dt], wv = wrap(f.yaw - p.yaw) / dt;
      if (pv) s.maxAccel = Math.max(s.maxAccel, Math.hypot(vel[0] - pv[0], vel[1] - pv[1]) / dt);
      if (pw != null) s.maxYawAccel = Math.max(s.maxYawAccel, Math.abs(wv - pw) / dt);
      pv = vel; pw = wv;
    }
    if (f.ball) {
      const dx = f.bx - f.x, dz = f.bz - f.z;
      s.minBall = Math.min(s.minBall, Math.hypot(dx, f.by - f.y, dz));
      const off = Math.hypot(dx, dz) > 0.5 ? Math.abs(wrap(Math.atan2(dx, dz) - f.yaw)) : 0;
      seen++; if (off <= cone) inside++;
      s.worstOff = Math.max(s.worstOff, off);
    }
  }
  s.inCone = seen ? inside / seen : 1;
  return s;
}

// ---------------------------------------------------------------- the clip
export const PRE = 1.5;     // s of the run-up shown before the release
export const TAIL = 1.0;    // s shown after the ball is dead…
export const TAIL_OUT = 2.0;   // …after a catch, or the stumps broken by a fielder (stumped, run out, or a near thing)
export const tailFor = (m) => (m && (m.caught != null || m.break != null) ? TAIL_OUT : TAIL);

// The stretch of the tape a ball's replay shows: { start, end, release, key,
// dead, playerBatting } (game s), or null (no ball bowled, already replayed,
// or the release no longer on the tape). It runs to tailFor(m) s after the
// ball was dead (TAIL_OUT after a catch or the stumps broken).
//   m            the ball's marks: { release, hit, pad, dead, played, playerBatting }
//   first, last  the oldest and the newest moment on the tape
//   arrive       when the ball got to the batter's end (null: it never did)
// key: the ball reaches the batter (bat, pad, or the crease, whichever is
// first): the camera follows the ball from then on.
export function clipFor(m, first, last, arrive = null) {
  if (!m || m.release == null || m.played || !(last >= first)) return null;
  if (m.release < first) return null;
  const start = Math.max(first, m.release - PRE);
  const end = Math.min((m.dead ?? last) + tailFor(m), last);
  if (end - start < 0.5) return null;
  let key = Infinity;
  for (const t of [m.hit, m.pad, arrive]) if (t != null && t > m.release && t < key) key = t;
  return { start, end, release: m.release, key: Math.min(key, end), dead: m.dead != null ? Math.min(m.dead, end) : null, playerBatting: !!m.playerBatting };
}

// When the replay of a ball whose result went up at t plays (game s): once
// TAIL s of its aftermath are on the tape; after a review (the result came
// well after the ball was dead), a moment after the verdict.
export function replayAt(m, t) {
  const dead = m.dead ?? t;
  return Math.max(dead + tailFor(m) + 0.05, t + (t - dead > 0.5 ? 1.0 : 0));
}
