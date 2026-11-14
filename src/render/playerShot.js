// Your shot, read from what you are doing, so that the figure that stands in
// for you (seen looking down, from behind, on a monitor and in replays) plays
// a real batter's shot (src/render/shots.js) instead of a made-up body.
//
// Fed every frame with the bat (the sweet spot's world position and the bat's
// orientation), your head (headset, or null), and what the batting session
// knows (bodyState(): when the ball will reach you, its height and length,
// the sweep button, the hit once it happens). It watches for a swing: the bat
// speeding up on its way down after it has been picked up; the backlift top is where the bat
// was highest in the second before; contact is when the ball reaches you (or
// the real contact once the ball is hit). The shot type comes from:
//   the sweep button (+ slog / reverse)             -> sweep, slog sweep, reverse sweep
//   the bat's plane through the swing               -> straight bat or cross bat
//   head forward / back since the stance (or the ball's length when the head hardly moves)
//                                                   -> front foot or back foot
//   the bat's peak speed                            -> defence or attacking stroke
//   which way the bat goes (off / leg / up / fine)  -> cover / straight / lofted drive, flick,
//                                                      back-foot punch, pull / hook (ball at
//                                                      the head), square / late cut
// The class is chosen when the swing starts and settled at contact (the real
// bat direction and the real contact time), then held: the figure does not
// change its mind mid-shot. classify() is pure (tested in tests/playerShot.test.js).
//
// World frame: the bowler is toward -Z, a right-hander faces +X (the off side).

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// feat: { sweep: {slog, reverse} | null, cross (0..1: share of the swing with the bat across the line),
//   peak (m/s), vx, vy, vz (bat direction at its fastest: +x off side, +z toward the keeper, +y up),
//   front (-1 back foot .. +1 front foot), ballY (ball height at the batter, m) }
//   dir (optional, once the ball is hit): the ball's way off the bat {x, y, z} (world)
//   - where the ball really went is the surest sign of the shot played.
export function classify(feat) {
  const f = feat;
  if (f.sweep) return f.sweep.reverse ? 'reverse' : f.sweep.slog ? 'slog' : 'sweep';
  if (f.dir && Math.hypot(f.dir.x, f.dir.z) > 1e-3) return byDirection(f);
  const v = Math.hypot(f.vx, f.vy, f.vz) || 1;
  const side = f.vx / v, up = f.vy / v, fine = f.vz / v;
  const front = f.front > 0.15 ? 1 : f.front < -0.15 ? -1 : 0;
  if (f.peak < 5.5) return front >= 0 ? 'defend' : 'backdef';
  if (f.cross > 0.5) {
    if (side < -0.15) return f.ballY > 1.25 ? 'hook' : 'pull';
    if (fine > 0.45) return 'latecut';
    if (side > 0.15) return 'cut';
    return f.ballY > 1.25 ? 'hook' : 'pull';
  }
  if (front < 0) return side < -0.35 ? 'flick' : 'punch';
  if (side < -0.35) return 'flick';
  if (up > 0.55 || f.lofted) return 'lofted';
  return side > 0.3 ? 'cover' : 'straight';
}

// The shot from where the ball went off the bat: its bearing (0 straight back
// past the bowler, +90 square on the off side, -90 square on the leg side,
// beyond +-110 behind square), the bat across the line or upright at contact,
// front or back foot, how hard it was swung and how high the ball was hit.
function byDirection(f) {
  const az = Math.atan2(f.dir.x, -f.dir.z) * 180 / Math.PI;
  const front = f.front > 0.15 ? 1 : f.front < -0.15 ? -1 : 0;
  const soft = f.peak < 5.5;
  const high = f.ballY > 1.25;
  if (az > 110) return 'latecut';
  if (az < -110) return soft ? 'backdef' : high ? 'hook' : 'flick';     // a glance fine / a top-edged hook
  const cross = f.cross > 0.5;
  if (cross || (front < 0 && Math.abs(az) > 60 && !soft)) {
    if (az < -15) return high ? 'hook' : 'pull';
    if (az > 35) return 'cut';
    return high ? 'hook' : 'pull';
  }
  if (soft) return front < 0 ? 'backdef' : 'defend';
  if (az < -22) return 'flick';
  if (f.lofted && az < 45) return 'lofted';
  if (front < 0) return 'punch';
  return az > 20 ? 'cover' : 'straight';
}

// Game type + capture choice for a class (shots.js shotFor's `want`).
export function shotOf(cls) {
  switch (cls) {
    case 'cover': return { type: 'drive', want: { ang: 0.5, loft: 0 } };
    case 'straight': return { type: 'drive', want: { ang: 0, loft: 0 } };
    case 'lofted': return { type: 'drive', want: { ang: 0, loft: 0.4 } };
    case 'hook': return { type: 'hook', want: {} };
    case 'latecut': return { type: 'latecut', want: {} };
    default: return { type: cls, want: {} };
  }
}

const N = 90;               // frames of history (~1.5 s at 60 Hz)

export class ShotReader {
  constructor() { this.reset(); }
  reset() {
    this.hist = [];           // { t, x, y, z, ax, ay, az } sweet spot + bat long axis
    this.cur = null;          // the shot being played
    this.last = null;         // the last shot played (kept for its replay once cur is over)
    this.stance = null;       // head and feet when settled
    this.lastBall = null;
  }

  // t: game time; bat: {x,y,z}; axis: the bat's long axis (handle up), world;
  // head: {x,y,z} or null; info: bodyState() of the session (may be null).
  update(t, bat, axis, head, info) {
    const H = this.hist;
    if (H.length && t < H[H.length - 1].t) this.reset();
    H.push({ t, x: bat.x, y: bat.y, z: bat.z, ax: axis.x, ay: axis.y, az: axis.z, hx: head ? head.x : 0, hz: head ? head.z : 0 });
    if (H.length > N) H.shift();
    const n = H.length;
    if (n < 4) return this.cur;
    const a = H[n - 1], b = H[n - 4], dt = a.t - b.t || 1e-3;
    const speed = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) / dt;
    const ball = info && info.ball;
    if (ball && ball.id !== (this.lastBall && this.lastBall.id)) { this.lastBall = ball; this.end(); }
    // the stance: the head where it is while the bat is still
    if (!this.cur && speed < 1.2 && head) this.stance = { hx: head.x, hz: head.z, t };
    const sweep = info && info.sweep && info.sweep.k > 0.3 ? info.sweep : null;
    const live = ball && ball.live;
    const hitT = info && info.hit ? info.hit.t : null;
    if (this.cur) {
      const c = this.cur;
      // contact: the real one once the ball is hit; else when the ball arrives
      if (hitT != null && !c.hitT && hitT > c.t0 - 0.3) { c.hitT = hitT; c.Tc = hitT; c.locked = false; }
      // the backlift goes on rising (a waggle read as the start of the swing): its top is later
      if (!c.locked && t < c.Tc - 0.06 && a.y > c.topY) { c.topY = a.y; c.tTop = t; }
      // settle the class at contact from the swing as it really went
      if (!c.locked && t >= c.Tc) {
        const feat = this.features(c, info, sweep || c.sweep);
        c.cls = classify(feat); c.feat = feat; c.locked = true;
      }
      if (t > c.Tc + 2.5) this.end();
      return this.cur;
    }
    // The ball was hit with no swing read (a short, quick stroke; a swing begun
    // before the ball was let go): the shot is the one that hit it, joined
    // where it is now (the figure blends into it from here).
    if (hitT != null && t - hitT < 0.5 && t >= hitT && !(this.last && this.last.hitT === hitT)) {
      let top = n - 1;
      for (let i = n - 1; i >= 0 && H[i].t > hitT - 1.0; i--) if (H[i].t <= hitT && H[i].y > H[top].y) top = i;
      const c = { t0: t, tTop: Math.min(H[top].t, hitT - 0.1), topY: H[top].y, Tc: hitT, hitT, sweep, locked: true, late: true };
      const feat = this.features(c, info, sweep);
      c.cls = classify(feat); c.feat = feat;
      this.cur = c;
      return c;
    }
    // a swing: the bat moving fast, while a ball is coming (or in the nets with no ball, any time)
    const arrive = ball && ball.arrive != null ? ball.arrive : null;
    const coming = live ? arrive == null || t < arrive + 0.15 : !ball;
    // (the downswing: the bat coming down or through toward the bowler, not the pick-up)
    const down = (a.y - b.y) / dt < -1.0 || (a.z - b.z) / dt < -1.5;
    if (speed > 3.2 && down && coming) {
      // backlift top: the sweet spot highest in the last second
      let top = n - 1;
      for (let i = n - 1; i >= 0 && H[i].t > t - 1.0; i--) if (H[i].y > H[top].y) top = i;
      const Tc = arrive != null && arrive > t + 0.05 ? arrive : t + 0.18;
      const c = { t0: t, tTop: Math.min(H[top].t, t - 0.05), topY: H[top].y, Tc, hitT: null, sweep, locked: false };
      const feat = this.features(c, info, sweep);
      c.cls = classify(feat); c.feat = feat;
      this.cur = c;
    }
    return this.cur;
  }

  end() { if (this.cur) this.last = this.cur; this.cur = null; }

  // Features of the swing so far (from its top to now). Near contact (the
  // last 0.12 s before it) counts most: how the bat came through the ball.
  features(c, info, sweep) {
    const H = this.hist, n = H.length;
    let peak = 0, vx = 0, vy = 0, vz = 0, cross = 0, wsum = 0, cx = 0, cy = 0, cz = 0, cc = 0, cw = 0;
    const near0 = Math.min(c.Tc, H[n - 1].t) - 0.12, near1 = Math.min(c.Tc, H[n - 1].t) + 0.02;
    for (let i = 3; i < n; i++) {
      const a = H[i], b = H[i - 3];
      if (a.t < c.tTop - 0.02) continue;
      const dt = a.t - b.t || 1e-3;
      const ux = (a.x - b.x) / dt, uy = (a.y - b.y) / dt, uz = (a.z - b.z) / dt, s = Math.hypot(ux, uy, uz);
      if (s > peak) { peak = s; vx = ux; vy = uy; vz = uz; }
      // the bat across the line: its long axis nearer horizontal than vertical, weighted by speed
      const x = Math.abs(a.ay) < 0.5 ? 1 : 0;
      cross += x * s; wsum += s;
      if (a.t >= near0 && a.t <= near1) { cx += ux; cy += uy; cz += uz; cc += x * (s + 0.5); cw += s + 0.5; }
    }
    cross = wsum > 0 ? cross / wsum : 0;
    if (cw > 0) {
      cross = 0.3 * cross + 0.7 * cc / cw;
      const l = Math.hypot(cx, cy, cz);
      if (l > 1e-6 && peak > 0) { const k = peak / l; vx = cx * k; vy = cy * k; vz = cz * k; }    // (the way through the ball, at the swing's speed)
    }
    // front / back foot: the head's travel along the pitch since the stance (toward the bowler = -z)
    const last = H[n - 1];
    let front = 0;
    if (this.stance && (last.hx || last.hz)) front = clamp((this.stance.hz - last.hz) / 0.25, -1, 1);
    const ball = info && info.ball;
    if (Math.abs(front) < 0.15 && ball && ball.length != null) front = ball.length < 5.5 ? 0.5 : ball.length > 7.5 ? -0.5 : front;
    const ballY = ball && ball.y != null ? ball.y : 0.8;
    const hit = info && info.hit;
    const lofted = hit && hit.launch > 20;
    const dir = hit && hit.dir && hit.t != null && Math.abs(hit.t - c.Tc) < 0.05 ? hit.dir : null;
    return { sweep: sweep ? { slog: !!sweep.slog, reverse: !!sweep.reverse } : null, cross, peak, vx, vy, vz, front, ballY, lofted, dir };
  }
}
