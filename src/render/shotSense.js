// What you are doing with the bat, read continuously from the three things
// that are tracked: your head, your bat (the dominant controller) and your
// other hand. Nothing is chosen ahead of time and nothing is played on a
// clock: every frame this turns the live tracks into
//
//   features   where your head is against where you took guard (forward,
//              back, across, down the pitch, how low), the bat's swing plane
//              (upright .. across the line), which way it is going (off ..
//              leg, up), how fast, how high, how far it is lifted, whether
//              the other hand is on the handle
//   phase      where the bat is in a stroke, from its own angle and speed:
//              0 stance .. 1 top of the backlift .. 2 contact .. 3 finish
//   weights    soft weights over the shots the AI batter has captures for
//              (src/render/shots.js), with hysteresis, settled at contact
//   engage     0 (no stroke: the body just follows your head and hands)
//              .. 1 (a stroke is being played)
//
// The body (src/render/playerBody.js) is posed from the weighted captures at
// the phase the bat is really in. Pure JS: no three.js, deterministic, its
// whole state is plain data (save() / load() for replays). Tested in
// tests/shotSense.test.js.
//
// World frame: the bowler is toward -Z, a right-hander faces +X (the off side).

export const FAMILIES = ['forward_defence', 'back_defence', 'straight_drive', 'cover_drive', 'lofted_drive', 'back_foot_punch', 'flick',
  'square_cut', 'late_cut', 'pull', 'hook', 'sweep', 'slog_sweep', 'reverse_sweep'];
const IX = Object.fromEntries(FAMILIES.map((n, i) => [n, i]));
const NF = FAMILIES.length;
const GAP = 0.2;     // s: a longer gap between frames and the velocity history starts again

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const mix = (a, b, k) => a + (b - a) * k;

export const SENSE = {
  sweet: 0.6,          // m from the bottom hand down the blade to the middle of the bat
  liftFull: 2.0,       // rad: the blade this far round from hanging down is a full backlift
  vOn: 2.6,            // m/s at the middle of the bat: faster than this (and into the ball) is a stroke
  vFull: [4, 7.5],     // m/s: a swing this fast takes the body with it (slower: only a block does)
  vIdle: [6.5, 9.5],   // m/s: the same between balls (no delivery on its way): only a real shadow stroke, not a twirl
  vQuiet: 1.0,         // m/s: slower than this the bat is still
  followFull: 1.9,     // rad the blade turns past contact in a full follow-through
  rise: 16, fall: 6.5, // 1/s: how fast the body is taken into a stroke and let out of it (critically damped)
  wTau: 0.07,          // s: smoothing of the shot weights
  stay: 1.3,           // the leading shot's score counts this much more (hysteresis)
  uRate: 2.2,          // the body moves through a capture at most this many times its real speed
  homeAfter: 1.0, homeTau: 0.5,   // s: where you took guard follows your head once you have been still this long
  offOn: 0.24,         // m: the other controller this near the top of the handle is "on the handle"
  flatFrom: [0.1, 0.4],  // stroke progress over which the blade's lie (upright / flat) comes to count for the swing plane
  faceDir: 1.1,        // how much the bat's face (opened to the off side / closed to the leg side) says about the way it goes
};

// Scores (0..1) for every shot from the features of the swing. Pure.
//   cross   0 upright bat .. 1 across the line           power  0 push .. 1 full swing
//   front   -1 back foot .. +1 front foot                dirX   which way the bat goes through: +1 off .. -1 leg
//   up      how much of the bat's way through is upward  fine   .. toward the keeper
//   handX   the hands across the pitch from the head (m, + off side)
//   handY   the hands below (-) / above (+) the head (m)
//   low     0 standing .. 1 right down (kneeling)        lowBat 0 .. 1 the bat down by the turf
//   sense   +1 the usual way round (off to leg) .. -1 the other way (a reverse)
//   sweep   { k, slog, reverse } the sweep button, if held: then the stroke is a sweep (slog / reverse as held)
export function scoreShots(f, out = new Array(NF)) {
  const V = 1 - f.cross, C = f.cross;
  const pw = f.power, fr = sstep(-0.3, 0.3, f.front);
  const off = sstep(0.18, 0.5, f.dirX), leg = sstep(0.18, 0.5, -f.dirX), mid = 1 - Math.max(off, leg);
  const up = sstep(0.25, 0.6, f.up);
  const lowS = Math.max(f.low, f.lowBat * sstep(0.08, 0.25, f.low + f.lowBat * 0.2));
  const offSide = sstep(0.14, 0.38, f.handX), hi = sstep(-0.3, -0.12, f.handY);
  const sw = f.sweep ? sstep(0.05, 0.4, f.sweep.k) : 0, rev = Math.max(sstep(0.3, 0.7, -f.sense), sw && f.sweep.reverse ? 1 : 0);
  // (the sweep button held: the stroke is a sweep, whether you are down yourself or not - your figure goes down)
  const stand = (1 - lowS) * (1 - sw);
  out[IX.forward_defence] = V * (1 - pw) * fr * stand;
  out[IX.back_defence] = V * (1 - pw) * (1 - fr) * stand;
  out[IX.straight_drive] = V * pw * fr * mid * (1 - up) * stand;
  out[IX.cover_drive] = V * pw * fr * off * stand;
  out[IX.lofted_drive] = V * pw * fr * (1 - leg * 0.6) * up * stand;
  out[IX.flick] = V * pw * leg * (0.45 + 0.55 * fr) * stand;
  out[IX.back_foot_punch] = V * pw * (1 - fr) * (1 - leg) * stand;
  const fine = sstep(0.2, 0.55, f.fine);
  out[IX.square_cut] = C * offSide * stand * (1 - fine * 0.8) * (1 - rev);
  out[IX.late_cut] = C * offSide * stand * fine * (1 - rev);
  out[IX.pull] = C * (1 - offSide) * stand * (1 - hi) * (1 - rev);
  out[IX.hook] = C * (1 - offSide) * stand * hi * (1 - rev);
  const sg = lowS * (1 + 2 * sw);
  const slog = Math.max(pw * up, sw && f.sweep.slog ? 1 : 0);
  out[IX.sweep] = Math.min(1, C * sg * (1 - slog) * (1 - rev) + sw * (1 - slog) * (1 - rev));
  out[IX.slog_sweep] = Math.min(1, C * sg * slog * (1 - rev) + sw * slog * (1 - rev));
  out[IX.reverse_sweep] = Math.min(1, C * sg * rev + sw * rev);
  return out;
}

// Soft weights from scores: sharpened, the current leader favoured (hysteresis). Returns the new leader (or -1).
export function weighShots(scores, leader, out = new Array(NF)) {
  let sum = 0, best = -1, bv = 0;
  for (let i = 0; i < NF; i++) {
    const s = scores[i] * (i === leader ? SENSE.stay : 1), v = s * s;
    out[i] = v; sum += v;
    if (s > bv) { bv = s; best = i; }
  }
  if (sum < 1e-6) { out.fill(0); return -1; }
  for (let i = 0; i < NF; i++) out[i] /= sum;
  return best;
}

export class ShotSense {
  constructor() { this.reset(); }

  reset() {
    this.s = {
      t: null, n: 0,
      // the bat a few frames ago (for velocities over >= 30 ms)
      hist: [],                 // [t, sx, sy, sz, dx, dy, dz, gx, gy, gz, hx, hy, hz]
      speed: 0,                 // smoothed speed of the middle of the bat
      quiet: 0, headQuiet: 0,   // s the bat / the head has been still
      home: null,               // where you took guard: the head { x, y, z } when settled
      stand: 0,                 // your standing head height (the highest seen, slowly forgotten)
      state: 'ready', tState: 0,
      lift: 0, phase: 0, phaseS: 0,
      E: 0, Ev: 0, target: 0,
      w: new Array(NF).fill(0), g: new Array(NF).fill(0), leader: -1, locked: false, switches: 0,
      sw: null,                 // the swing in progress (see begin())
      offOn: 1,
      feat: null,
    };
  }
  save() { return structuredClone(this.s); }
  load(s) { this.s = structuredClone(s); }

  get state() { return this.s.state; }
  get engage() { return this.s.E; }
  get phase() { return this.s.phaseS; }
  get weights() { return this.s.w; }
  get leader() { return this.s.leader >= 0 && this.s.E > 0.02 ? FAMILIES[this.s.leader] : null; }
  get home() { return this.s.home; }

  // t (s), dt: the REAL motion clock (your movements' own time, not the slowed
  // game clock: speeds are physical m/s at every difficulty); head {x, y, z}
  // (the eyes); grip {x, y, z} (the bottom hand on the handle); axis: the
  // bat's +Y (up the handle), unit; off: the other controller {x, y, z} or
  // null; ctx: { sweep: {k, slog, reverse} | null, hitT: game time the ball
  // was hit | null, simT: the game time now (hitT is compared with it),
  // face: the bat's face direction (its +Z) {x, y, z} | null, live: a delivery is on its way (true / false, or
  // null when not known: between balls a slow block is only waggling, not a stroke) }.
  update(t, dt, head, grip, axis, off = null, ctx = null) {
    const S = this.s;
    if (S.t != null && (t < S.t || t - S.t > 1.5)) {
      // (a long gap - a replay, another session - starts afresh; how tall you stand and where you took guard are kept)
      const keep = t >= S.t ? { stand: S.stand, home: S.home } : null;
      this.reset();
      if (keep) Object.assign(this.s, keep);
      return this.update(t, dt, head, grip, axis, off, ctx);
    }
    // (a shorter gap: no velocity is read across it)
    if (S.t != null && t - S.t > GAP) S.hist.length = 0;
    S.t = t; S.n++;
    const dx = -axis.x, dy = -axis.y, dz = -axis.z;                         // the blade, from the hands to the toe
    const sx = grip.x + dx * SENSE.sweet, sy = grip.y + dy * SENSE.sweet, sz = grip.z + dz * SENSE.sweet;
    const H = S.hist;
    H.push([t, sx, sy, sz, dx, dy, dz, grip.x, grip.y, grip.z, head.x, head.y, head.z]);
    while (H.length > 2 && t - H[1][0] >= 0.03) H.shift();
    if (H.length > 12) H.shift();
    const p = H[0], lag = Math.max(1e-3, t - p[0]);
    // velocities over the lag: the middle of the bat, the hands, the head; the blade's turning (rad/s, a vector)
    // (the bat's and the hands' are taken against your head: walking down the pitch is not a swing)
    let vx = 0, vy = 0, vz = 0, wx = 0, wy = 0, wz = 0, gvx = 0, hv = 0, dDown = 0;
    if (H.length > 1) {
      const hvx = (head.x - p[10]) / lag, hvz = (head.z - p[12]) / lag;
      vx = (sx - p[1]) / lag - hvx; vy = (sy - p[2]) / lag; vz = (sz - p[3]) / lag - hvz;
      const cx = p[5] * dz - p[6] * dy, cy = p[6] * dx - p[4] * dz, cz = p[4] * dy - p[5] * dx;
      const sl = Math.hypot(cx, cy, cz), ang = Math.atan2(sl, p[4] * dx + p[5] * dy + p[6] * dz), k = sl > 1e-9 ? ang / sl / lag : 0;
      wx = cx * k; wy = cy * k; wz = cz * k;
      gvx = (grip.x - p[7]) / lag - hvx;
      hv = Math.hypot(hvx, hvz);
      dDown = (Math.acos(clamp(-dy, -1, 1)) - Math.acos(clamp(-p[5], -1, 1))) / lag;       // the blade coming down (-) or going up (+), rad/s
    }
    const speed = Math.hypot(vx, vy, vz), wmag = Math.hypot(wx, wy, wz);
    S.speed += (speed - S.speed) * Math.min(1, dt / 0.03);
    S.quiet = S.speed < SENSE.vQuiet ? S.quiet + dt : 0;
    S.headQuiet = hv < 0.25 ? S.headQuiet + dt : 0;
    // standing height and where you took guard
    S.stand = Math.max(S.stand - dt * 0.002, head.y);
    if (!S.home) S.home = { x: head.x, y: head.y, z: head.z };
    else if (S.state === 'ready' && S.quiet > SENSE.homeAfter && S.headQuiet > SENSE.homeAfter) {
      const k = Math.min(1, dt / SENSE.homeTau);
      S.home.x += (head.x - S.home.x) * k; S.home.y += (head.y - S.home.y) * k; S.home.z += (head.z - S.home.z) * k;
    }
    // the other hand on the handle?
    if (off) {
      const d = Math.hypot(off.x - (grip.x + axis.x * 0.105), off.y - (grip.y + axis.y * 0.105), off.z - (grip.z + axis.z * 0.105));
      S.offOn += ((d < SENSE.offOn ? 1 : 0) - S.offOn) * Math.min(1, dt / 0.15);
    }
    // the backlift: how far round the blade is from hanging down, while it is behind / above the hands
    const fromDown = Math.acos(clamp(-dy, -1, 1));
    const behind = sstep(-0.5, 0.1, dz + 0.6 * Math.max(0, dy));
    const lift = clamp(fromDown / SENSE.liftFull, 0, 1) * behind;
    S.lift += (lift - S.lift) * Math.min(1, dt / 0.05);

    const sweepBtn = ctx && ctx.sweep && ctx.sweep.k > 0.05 ? ctx.sweep : null;
    const blockOK = !(ctx && ctx.live === false);
    // which way the face looks, along the ground (+ off side): a cover drive opens it, an on drive closes it
    const fc = ctx && ctx.face, fh = fc ? Math.hypot(fc.x, fc.z) : 0, faceX = fh > 0.3 ? fc.x / fh : 0;
    const simT = ctx && ctx.simT != null ? ctx.simT : t;
    const hitNow = ctx && ctx.hitT != null && ctx.hitT > simT - 0.1 && ctx.hitT <= simT + 1e-6;
    // into the ball: toward the bowler, downward, or across (not the pick-up: upward and back)
    // (and the blade coming down, or sweeping round: lifting the bat is not a stroke however fast)
    const into = speed > 1e-3 ? (-vz + 0.8 * Math.max(0, -vy) + 0.3 * Math.abs(vx)) / speed : 0;
    const unwinding = dDown < -2 || (Math.abs(wy) > 4 && Math.abs(wy) > 0.6 * wmag);
    const swinging = S.speed > SENSE.vOn && speed > SENSE.vOn && into > 0.2 && unwinding;

    S.tState += dt;
    if (S.state === 'ready' || ((S.state === 'follow' || S.state === 'recover') && S.sw && t - S.sw.tC > 0.5 && S.quietBefore > 0.12)) {
      if (swinging) this.begin(t, dx, dy, dz);
    }
    S.quietBefore = S.speed < SENSE.vOn * 0.6 ? (S.quietBefore || 0) + dt : 0;
    const sw = S.sw;
    if (S.state === 'down') {
      // the swing so far: how far the blade has turned, about what, how fast, which way, how high
      const a = Math.exp(-dt / 0.12);
      sw.th += wmag * dt;
      sw.nx += wx * dt; sw.ny += wy * dt; sw.nz += wz * dt;
      sw.peak = Math.max(sw.peak, S.speed);
      const wgt = speed * speed * dt;
      sw.vx = sw.vx * a + vx * wgt; sw.vy = sw.vy * a + vy * wgt; sw.vz = sw.vz * a + vz * wgt; sw.vw = sw.vw * a + speed * wgt;
      sw.sy = sw.sy * a + sy * wgt; sw.hx = sw.hx * a + (grip.x - head.x + 0.08 * clamp(gvx, -3, 3)) * wgt; sw.hy = sw.hy * a + (grip.y - head.y) * wgt;
      sw.ww = sw.ww * a + wgt; sw.fx = sw.fx * a + faceX * wgt;
      // (how upright the blade is, near contact only: at the top of a backlift every bat lies flat)
      const wa = wgt * sstep(SENSE.flatFrom[0], SENSE.flatFrom[1], sw.prog);
      sw.ay = sw.ay * a + Math.abs(dy) * wa; sw.aw = sw.aw * a + wa;
      const feat = this.features(head, sweepBtn);
      // contact: the blade pointing down (upright bat) or square out to the off side (bat across the line)
      const cx = mix(0, 0.97, feat.cross), cy = mix(-0.99, -0.05, feat.cross), cz = mix(-0.12, -0.24, feat.cross), cl = Math.hypot(cx, cy, cz);
      const rem = Math.acos(clamp((dx * cx + dy * cy + dz * cz) / cl, -1, 1));
      sw.remMin = Math.min(sw.remMin, rem);
      const prog = sw.prog = sw.th / (sw.th + rem + 1e-6);
      S.phase = Math.max(S.phase, 1 + clamp(prog, 0, 1));
      const vf = blockOK ? SENSE.vFull : SENSE.vIdle;
      S.target = clamp(Math.max(sstep(vf[0], vf[1], sw.peak), blockOK ? this.blockEvidence(head, grip.z, dy) : 0), 0, 1) * sstep(0.02, 0.15, Math.max(...feat.scores));
      // (no shot is named until the blade has turned enough to tell)
      if (sw.th > 0.6) this.weigh(feat, dt, false);
      const past = rem > sw.remMin + 0.12 && sw.th > 0.5;
      const died = S.speed < SENSE.vQuiet && S.tState > 0.08;
      if (past || (hitNow && prog > 0.3) || S.tState > 0.7 || (died && prog > 0.5)) {
        S.state = 'follow'; S.tState = 0; sw.tC = t; sw.past = past ? rem - sw.remMin : 0; S.phase = 2;
      } else if (died) { S.state = 'recover'; S.tState = 0; sw.tC = t; }
    } else if (S.state === 'follow') {
      if (S.speed > 0.8) sw.past += wmag * dt;
      S.phase = Math.max(S.phase, 2 + clamp(sw.past / SENSE.followFull, 0, 1));
      if (!S.locked) {
        // (the way through the ball still counts for a moment: lofted or along the ground, how hard)
        if (S.tState < 0.06) {
          const a = Math.exp(-dt / 0.12), wgt = speed * speed * dt;
          sw.peak = Math.max(sw.peak, S.speed);
          sw.vx = sw.vx * a + vx * wgt; sw.vy = sw.vy * a + vy * wgt; sw.vz = sw.vz * a + vz * wgt; sw.vw = sw.vw * a + speed * wgt;
          sw.fx = sw.fx * a + faceX * wgt; sw.ww = sw.ww * a + wgt;
          this.weigh(this.features(head, sweepBtn), dt, false);
        } else { S.locked = true; this.weigh(null, dt, true); }
      } else this.weigh(null, dt, true);
      const vf = blockOK ? SENSE.vFull : SENSE.vIdle;
      S.target = Math.max(S.target, sstep(vf[0], vf[1], sw.peak)) * (S.leader >= 0 ? 1 : 0);
      // Hold the finish for as long as the player does. Measure both the grip
      // and blade against the head so moving around with the bat held still
      // does not collapse the pose. A stroke without a pause can go straight
      // back to guard.
      const gx = grip.x - head.x, gy = grip.y - head.y, gz = grip.z - head.z;
      if (!sw.finish && S.tState > 0.15 && S.quiet > 0.12) {
        sw.finish = { gx, gy, gz, dx, dy, dz };
      }
      const f = sw.finish, scale = S.stand / 1.62;
      const leftFinish = f && (Math.hypot(gx - f.gx, gy - f.gy, gz - f.gz) > 0.085 * scale
        || dx * f.dx + dy * f.dy + dz * f.dz < Math.cos(0.35));
      const guard = dy < -0.75 && gy < -0.35 * scale && gz > -0.14 * scale;
      if (S.tState > 0.25 && (leftFinish || (guard && S.quiet > 0.12))) {
        S.state = 'recover'; S.tState = 0;
      }
    } else if (S.state === 'recover') {
      S.target = 0;
      this.weigh(null, dt, true);
      if (S.E < 0.02) { S.state = 'ready'; S.tState = 0; S.phase = S.lift; S.phaseS = S.lift; S.locked = false; S.leader = -1; S.w.fill(0); S.g.fill(0); }
    }
    if (S.state === 'ready') { S.phase = S.lift; S.target = 0; S.feat = null; }

    // engagement: critically damped toward its target (quick in, gentle out)
    const om = S.target > S.E ? SENSE.rise : SENSE.fall;
    const acc = om * om * (S.target - S.E) - 2 * om * S.Ev;
    S.Ev += acc * dt; S.E = clamp(S.E + S.Ev * dt, 0, 1);
    if (S.E <= 0 && S.Ev < 0) S.Ev = 0;
    if (S.E >= 1 && S.Ev > 0) S.Ev = 0;
    // the phase the body is shown at: follows the bat's, never faster than a body moves
    const dph = S.phase - S.phaseS;
    S.phaseS += S.state === 'ready' ? dph * Math.min(1, dt / 0.05) : clamp(dph * Math.min(1, dt / 0.035), -12 * dt, 12 * dt);
    return this.out();
  }

  begin(t, dx, dy, dz) {
    const S = this.s;
    S.state = 'down'; S.tState = 0; S.phase = 1; S.locked = false;
    if (S.E < 0.05) { S.phaseS = 1; S.leader = -1; S.w.fill(0); S.g.fill(0); }
    S.sw = { t0: t, tC: t, th: 0, nx: 0, ny: 0, nz: 0, peak: 0, vx: 0, vy: 0, vz: 0, vw: 0, sy: 0, hx: 0, hy: 0, ay: 0, aw: 0, prog: 0, ww: 0, fx: 0, remMin: 9, past: 0, lift0: S.lift };
  }

  // A slow, upright bat brought down in front of you (a block): a stroke too, though it is not swung.
  // (the hands out in front of the head, the blade hanging under them, after a pick-up)
  blockEvidence(head, gz, dy) {
    const S = this.s;
    return sstep(0.04, 0.22, head.z - gz) * sstep(0.6, 0.9, -dy) * sstep(0.25, 0.6, S.sw.lift0 + S.sw.th * 0.4);
  }

  // The features of the swing so far and the scores they give.
  features(head, sweepBtn) {
    const S = this.s, sw = S.sw, k = S.stand / 1.62, home = S.home;
    const nl = Math.hypot(sw.nx, sw.ny, sw.nz) || 1, vl = Math.hypot(sw.vx, sw.vy, sw.vz) || 1, hl = Math.hypot(sw.vx, sw.vz) || 1;
    const ww = sw.ww || 1;
    // the swing plane: the blade turning about the vertical is a bat across the line; near contact the bat lying flat says so too
    const turn = Math.abs(sw.ny) / nl, flat = sw.aw > 1e-6 ? (1 - sw.ay / sw.aw) * sstep(0, 0.3, sw.aw / ww) : 0;
    const cross = clamp(0.55 * sstep(0.35, 0.8, turn) + 0.45 * sstep(0.35, 0.75, flat), 0, 1);
    const fwd = home.z - head.z, down = S.stand - head.y;
    const sy = sw.sy / ww;
    const f = {
      cross, power: sstep(5, 11, sw.peak), peak: sw.peak,
      // front or back foot: the head forward of / behind where you took guard; hardly moved: a low bat is forward, a high one back
      front: clamp(fwd / 0.22, -1, 1) + sstep(0.75 * k, 0.4 * k, sy) * 0.35 - sstep(0.7 * k, 1.0 * k, sy) * 0.35,
      dirX: clamp(sw.vx / hl * sstep(0.15, 0.4, hl / vl) + (sw.hx / ww - 0.27) * 1.2 + SENSE.faceDir * sw.fx / ww, -1, 1), up: sw.vy / vl, fine: sw.vz / vl,
      faceX: sw.fx / ww,
      handX: sw.hx / ww, handY: sw.hy / ww,
      low: sstep(0.25 * k, 0.42 * k, down), lowBat: sstep(0.5 * k, 0.28 * k, sy),
      sense: sw.ny / nl, sweep: sweepBtn,
      fwd, back: -fwd, lat: head.x - home.x, down, advance: sstep(0.55, 0.9, fwd), offOn: S.offOn, lift: S.lift, batY: sy,
    };
    f.scores = scoreShots(f, (S.feat && S.feat.scores) || new Array(NF));
    S.feat = f;
    return f;
  }

  // Shot weights toward the scores' (smoothed); once locked they only settle.
  weigh(feat, dt, locked) {
    const S = this.s;
    if (feat && !locked) {
      const lead = weighShots(feat.scores, S.leader, S.g);
      if (lead !== S.leader && lead >= 0) { if (S.leader >= 0) S.switches++; S.leader = lead; }
    }
    const fresh = S.E < 0.05 && !locked;
    const k = fresh ? 1 : Math.min(1, dt / SENSE.wTau);
    let sum = 0;
    for (let i = 0; i < NF; i++) { S.w[i] += (S.g[i] - S.w[i]) * k; sum += S.w[i]; }
    if (sum > 1e-6) for (let i = 0; i < NF; i++) S.w[i] /= sum;
  }

  out() {
    const S = this.s;
    return this._out = { state: S.state, phase: S.phaseS, engage: S.E, weights: S.w, leader: this.leader, lift: S.lift, feat: S.feat, home: S.home, stand: S.stand, offOn: S.offOn, quiet: Math.min(S.quiet, S.headQuiet) };
  }
}

// Capture time (s from its stance) for a phase: 1 -> the top of its backlift, 2 -> contact, 3 -> its finish.
export function captureTime(phase, ev) {
  if (phase <= 1) return ev.top * clamp(phase, 0, 1);
  if (phase <= 2) return ev.top + (ev.contact - ev.top) * (phase - 1);
  return ev.contact + (ev.finish - ev.contact) * Math.min(1, phase - 2);
}
