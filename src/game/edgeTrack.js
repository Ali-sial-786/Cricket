// Edge truth for the DRS: what the ball really touched on this delivery and
// when (the "contact log"), the evidence the third umpire sees from it — Snicko
// (the stump microphone's trace) and Hot Spot (the thermal camera's marks) —
// and the umpire / fielder / review rules for edges. Pure JS (no three.js),
// unit tested in node (tests/edgeTrack.test.js).
//
// The log is fed by the physics world: attach(world) wraps world.substep, so
// it sees every 1/480 s step, and it resets itself on every launch. Events:
//   bat     a bat (or the glove on the handle, which counts as bat) touched the
//           ball: where on the bat (face / edge / toe / shoulder / back /
//           handle / glove), how thick (full / thick / thin / faint), how hard
//           (strength 0..1) and which edge (outside / inside / top / bottom)
//   pad     the ball hit the pads; 'body' above the knee roll (thigh)
//   ground  the toe of the bat came down into the turf: a noise on the stump
//           microphone that has nothing to do with the ball
// plus `frames`: the ball's place relative to the striker's bat every step it
// is within EDGE.near m of it (the camera frames the third umpire steps
// through, in the bat's own frame: x across the face, y up the bat, z out of
// the front face).
//
// Frame (config.js): batting stumps at the origin, the ball travels +Z, a
// right-hander's off side is +X.

import { makeRng, clamp, Pose, Vec3 } from '../physics/math.js';
import { BatGeometry } from '../physics/bat.js';
import { CONFIG } from '../config.js';

export const EDGE = {
  edgeAcross: 0.78,       // |x| / half-width beyond which a front-face contact is an edge (bat.js isEdge)
  faint: 0.22,            // overlap (share of the ball's width over the bat's outline) below this = faint…
  thin: 0.5,              // …below this thin, else thick
  kneeRoll: 0.6,          // m: a pad strike above this is the thigh ('body')
  near: 2.0,              // m: frames are kept while the ball is this close to the bat's grip
  maxFrames: 420,
  frameDt: 1 / 250,       // s between the camera frames Snicko is stepped through
  window: 0.044,          // s each side of the ball passing the bat on the trace
  maxWindow: 0.12,        // s: a noise this far from the pass is still put on the trace
  align: 0.006,           // s: a spike this close to the ball passing the bat lines up with it
  batPadGap: 0.15,        // s: bat and pad this close together = bat-pad
  ground: 0.006,          // m: the bat's toe this low is in the turf…
  groundSpeed: 0.4,       // …coming down at least this fast (m/s) makes a noise
  noiseGap: 0.035,        // s: a ground / pad noise this close to the pass can fool the umpire
  close: 0.05,            // m: a ball passing this close to the bat (no touch) is a "close" one
};

const R0 = () => CONFIG.ball.radius;
const THICK_BASE = { full: 1, thick: 0.78, thin: 0.52, faint: 0.3 };

// ---------------------------------------------------------------- the log

export class ContactLog {
  constructor(cfg = CONFIG) {
    this.cfg = cfg;
    this.visible = new BatGeometry(cfg.bat);       // the bat you see (no invisible toe) for ground strikes
    this.events = [];
    this.frames = [];
    this.launchT = null;
    this.batId = null;
    this.dims = null;                 // the striker's bat as the physics has it (for the pictures)
    this.lastBall = null;
    this._pose = new Pose();
    this._l = new Vec3();
    this._w = new Vec3();
    this._c = new Vec3();
    this._vin = new Vec3();
    this._vLast = new Vec3();
    this._toe = {};
    this._padSeen = false;
    this._closest = Infinity;
    this._closestT = null;
    this._frameStop = false;
  }

  reset(t = null) {
    this.events.length = 0;
    this.frames.length = 0;
    this.launchT = t;
    this.batId = null;
    this.dims = null;
    this.lastBall = null;
    this._toe = {};
    this._padSeen = false;
    this._closest = Infinity;
    this._closestT = null;
    this._frameStop = false;
  }

  // Wrap world.substep (once): the log sees the ball and the bats each step.
  attach(world) {
    if (world.__contactLog) return world.__contactLog;
    const orig = world.substep.bind(world), log = this;
    world.substep = function (t0, t1) {
      log.before(this, t0);
      const n = this.events.length;
      orig(t0, t1);
      log.after(this, t0, t1, n);
    };
    world.__contactLog = this;
    return this;
  }

  // (A fielder's throw carrying on — ball.thrown, fielding.js relaunch — is
  // not part of the delivery: it never resets, adds to or moves the log.)
  before(world, t0) {
    const b = world.ball;
    if (!b.active || b.thrown) return;
    if (b.launchTime !== this.launchT) this.reset(b.launchTime);
    this._vin.copy(b.vel);
    // A pad strike happens between steps (the session deflects the ball):
    // the velocity it came in with is the one the last step ended with.
    if (b.padded && !this._padSeen) {
      this._padSeen = true;
      this.addPad({ t: t0, pos: b.pos, vin: this._vLast, at: b.padAt || null });
    }
  }

  after(world, t0, t1, n) {
    const b = world.ball;
    if (b.thrown) return;
    for (let i = n; i < world.events.length; i++) {
      const e = world.events[i];
      if (e.type === 'bat') {
        const bat = world.getBat(e.batId);
        let edgeDir = null;
        if (bat && e.local) {
          bat.provider.poseAt(e.t, this._pose);
          edgeDir = this._pose.dirToWorld(this._w, this._c.set(Math.sign(e.local.x) || 1, 0, 0)).clone();
        }
        this.addBat(e, bat ? bat.geom : this.visible, this._vin, edgeDir);
      }
    }
    if (!b.active || this.launchT == null) return;
    this.lastBall = { x: b.pos.x, y: b.pos.y, z: b.pos.z, t: t1 };
    this._vLast.copy(b.vel);
    if (t1 - this.launchT > 5) return;
    const R = this.cfg.ball.radius;
    for (const bat of world.bats) {
      if (!bat.enabled) continue;
      bat.provider.poseAt(t1, this._pose);
      this.groundCheck(bat, t1);
      if (this._frameStop || this.frames.length >= EDGE.maxFrames) continue;
      const P = this._pose;
      const dc = Math.hypot(b.pos.x - P.p.x, b.pos.y - P.p.y, b.pos.z - P.p.z);
      if (dc > EDGE.near + 0.6) {
        // Gone past and away: the pictures are done.
        if (this._closestT != null && t1 - this._closestT > 0.05) this._frameStop = true;
        continue;
      }
      P.toLocal(this._l, b.pos);
      const d = bat.geom.sdf(this._l) - R;
      if (this.batId == null) this.batId = bat.id;
      if (bat.id !== this.batId) continue;
      if (!this.dims) this.dims = geomDims(bat.geom, R);
      this.frames.push({ t: t1, x: b.pos.x, y: b.pos.y, z: b.pos.z, lx: this._l.x, ly: this._l.y, lz: this._l.z, d,
        ax: this._w.copy(this._c.set(1, 0, 0)).applyQuat(P.q).x,
        // the bat as it was (the front-on camera draws it): grip position and orientation
        px: P.p.x, py: P.p.y, pz: P.p.z, qx: P.q.x, qy: P.q.y, qz: P.q.z, qw: P.q.w });
      if (d < this._closest) { this._closest = d; this._closestT = t1; }
      if (this._closestT != null && t1 - this._closestT > 0.3) this._frameStop = true;
    }
  }

  // The toe of the (visible) bat coming down into the turf.
  groundCheck(bat, t) {
    const G = this.visible, P = this._pose;
    let low = Infinity, lx = 0, lz = 0;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      P.toWorld(this._w, this._c.set(sx * G.bladeHalf.x, G.toeY, sz * G.bladeHalf.z));
      if (this._w.y < low) { low = this._w.y; lx = this._w.x; lz = this._w.z; }
    }
    const s = this._toe[bat.id] || (this._toe[bat.id] = { y: low, t, down: low <= EDGE.ground });
    const h = t - s.t;
    if (!s.down && low <= EDGE.ground && h > 0) {
      const speed = (s.y - low) / h;
      if (speed >= EDGE.groundSpeed) {
        // when it crossed the line, between the two steps
        const f = s.y > low ? clamp((s.y - EDGE.ground) / (s.y - low), 0, 1) : 1;
        this.events.push({ type: 'ground', t: s.t + f * h, batId: bat.id, pos: { x: lx, y: 0, z: lz }, speed });
      }
      s.down = true;
    } else if (s.down && low > EDGE.ground + 0.015) s.down = false;
    s.y = low; s.t = t;
  }

  addBat(e, geom, vin = null, edgeDir = null) {
    const c = classifyBat(e, geom, this.cfg.ball.radius, edgeDir);
    let deflection = 0;
    if (vin && e.vel) {
      const a = Math.hypot(vin.x, vin.y, vin.z), b = Math.hypot(e.vel.x, e.vel.y, e.vel.z);
      if (a > 1e-6 && b > 1e-6) deflection = Math.acos(clamp((vin.x * e.vel.x + vin.y * e.vel.y + vin.z * e.vel.z) / (a * b), -1, 1)) * 180 / Math.PI;
    }
    const ev = {
      type: 'bat', t: e.t, batId: e.batId || null, ...c,
      pos: e.point ? { x: e.point.x, y: e.point.y, z: e.point.z } : e.pos ? { x: e.pos.x, y: e.pos.y, z: e.pos.z } : null,
      local: e.local ? { x: e.local.x, y: e.local.y, z: e.local.z } : null,
      speedIn: e.speedIn || 0, speedOut: e.speedOut || 0, deflection,
    };
    this.events.push(ev);
    if (this.batId == null && e.batId) this.batId = e.batId;
    if (!this.dims && geom) this.dims = geomDims(geom, this.cfg.ball.radius);
    return ev;
  }

  // pos: where the ball struck; vin: its velocity just before; at: where the
  // batter stood ({ x, z, halfX } from padHit).
  addPad({ t, pos, vin = null, at = null }) {
    const speed = vin ? Math.hypot(vin.x, vin.y, vin.z) : 20;
    const halfX = at && at.halfX ? at.halfX : 0.2;
    const u = at ? clamp((pos.x - at.x) / halfX, -1.2, 1.2) : 0;
    const ev = {
      type: pos.y > EDGE.kneeRoll ? 'body' : 'pad', t, pos: { x: pos.x, y: pos.y, z: pos.z }, speed,
      u, v: pos.y, leg: u >= 0 ? 'front' : 'back',   // right-hander: the front (left) leg is on the off side
    };
    this.events.push(ev);
    return ev;
  }

  addGround({ t, pos = { x: 0, y: 0, z: -1.2 }, speed = 2, batId = null }) {
    const ev = { type: 'ground', t, batId, pos: { x: pos.x, y: 0, z: pos.z }, speed };
    this.events.push(ev);
    return ev;
  }

  // A copy that will not change with the next delivery (the review keeps it).
  snapshot() {
    const s = new ContactLog(this.cfg);
    s.events = this.events.map((e) => ({ ...e }));
    s.frames = this.frames.slice();
    s.launchT = this.launchT; s.batId = this.batId; s.dims = this.dims; s.lastBall = this.lastBall ? { ...this.lastBall } : null;
    return s;
  }
}

// A bat's measurements for the pictures (snicko.js / hotspot.js batDims()).
export function geomDims(geom, R = R0()) {
  return {
    hx: geom.bladeHalf.x, hz: geom.bladeHalf.z, toeY: geom.toeY, shoulderY: geom.shoulderY,
    handleTopY: geom.handleTopY, handleR: geom.handleRadius, R, bladeLength: geom.shoulderY - geom.toeY,
  };
}

// Where on the bat a world 'bat' event touched it, and how thick it was.
// e: the physics event (face, part, local, speedIn, batSpeed); geom: the
// BatGeometry the physics used; edgeDir: the touched edge's outward direction
// in the world (names it outside / inside / top / bottom), if known.
export function classifyBat(e, geom, R = R0(), edgeDir = null) {
  const L = e.local || { x: 0, y: geom.sweetY, z: geom.faceZ + R };
  const hx = geom.bladeHalf.x, ax = Math.abs(L.x);
  let where, thickness, overlap = 1;
  if (e.part === 'handle' || e.face === 'handle') {
    where = L.y > geom.shoulderY + 0.05 ? 'glove' : 'handle';
    thickness = 'thin';
  } else if (e.face === 'toe') { where = 'toe'; thickness = 'thick'; }
  else if (e.face === 'shoulder') { where = 'shoulder'; thickness = 'thick'; }
  else if (e.face === 'back') { where = 'back'; thickness = 'thick'; }
  else if (e.face === 'front' && ax <= hx * EDGE.edgeAcross) { where = 'face'; thickness = 'full'; }
  else {
    where = 'edge';
    overlap = clamp((hx + R - ax) / (2 * R), 0, 1);
    thickness = overlap < EDGE.faint ? 'faint' : overlap < EDGE.thin ? 'thin' : 'thick';
  }
  let edge = null;
  if (where === 'edge' && edgeDir) {
    edge = edgeDir.y > 0.6 ? 'top' : edgeDir.y < -0.6 ? 'bottom' : edgeDir.x >= 0 ? 'outside' : 'inside';
  }
  // A harder contact: a taller spike and a bigger mark (in its band).
  const band = THICK_BASE[thickness];
  const fine = where === 'edge' ? 0.85 + 0.3 * clamp((overlap - (thickness === 'faint' ? 0 : thickness === 'thin' ? EDGE.faint : EDGE.thin)) / 0.28, 0, 1) : 1;
  const pace = clamp(((e.speedIn || 25) + 0.5 * (e.batSpeed || 0)) / 30, 0.75, 1.12);
  const strength = clamp(band * fine * pace, 0.12, 1);
  const u = clamp(L.x / hx, -1.3, 1.3);                                  // across the face: ±1 = the edges
  const v = clamp((L.y - geom.toeY) / (geom.handleTopY - geom.toeY), 0, 1);   // 0 toe … 1 top of the handle
  const vBlade = clamp((L.y - geom.toeY) / (geom.shoulderY - geom.toeY), 0, 1.6); // 0 toe … 1 shoulder
  return { where, thickness, overlap, strength, u, v, vBlade, edge, side: Math.sign(L.x) || 1 };
}

// In words, for the board and the Hot Spot caption.
export function describeContact(e) {
  if (!e) return '';
  if (e.type === 'pad') return 'PAD';
  if (e.type === 'body') return 'THIGH PAD';
  if (e.type === 'ground') return 'BAT ON THE GROUND';
  switch (e.where) {
    case 'edge': return e.edge ? `${e.edge.toUpperCase()} EDGE` : 'EDGE';
    case 'glove': return 'GLOVE';
    case 'handle': return 'HANDLE';
    case 'toe': return 'TOE OF THE BAT';
    case 'shoulder': return 'SHOULDER OF THE BAT';
    case 'back': return 'BACK OF THE BAT';
    default: return 'MIDDLE OF THE BAT';
  }
}

// ---------------------------------------------------------------- the truth

// The moment the ball passed the bat: the contact itself, or the closest
// approach of the recorded frames ({ t, d (m, ball surface to bat), frame }).
export function passOf(log) {
  const bat = log.events.find((e) => e.type === 'bat');
  if (bat) return { t: bat.t, d: 0, contact: true };
  let best = null;
  for (const f of log.frames) if (!best || f.d < best.d) best = f;
  if (best) return { t: best.t, d: Math.max(0, best.d), frame: best, contact: false };
  const pad = log.events.find((e) => e.type === 'pad' || e.type === 'body');
  if (pad) return { t: pad.t, d: Infinity, contact: false };
  return null;
}

export function edgeTruth(log) {
  const ev = log.events;
  const bat = ev.find((e) => e.type === 'bat') || null;
  const pad = ev.find((e) => e.type === 'pad' || e.type === 'body') || null;
  const ground = ev.filter((e) => e.type === 'ground');
  const pass = passOf(log);
  const truth = {
    bat, pad, ground, pass,
    touched: !!bat,
    batFirst: !!bat && (!pad || bat.t <= pad.t + 1e-6),
    batPad: !!bat && !!pad && Math.abs(pad.t - bat.t) < EDGE.batPadGap,
    thickness: bat ? bat.thickness : null,
    where: bat ? bat.where : null,
  };
  truth.noise = noiseLevel(truth);
  return truth;
}

// What might make an umpire hear an edge that was not there: 'noise' (the
// bat thudding into the ground, or the pad, right as the ball goes past),
// 'close' (it just missed the bat), 'near' (within 15 cm), else 'clear'.
export function noiseLevel(truth) {
  const p = truth.pass;
  if (!p) return 'clear';
  const near = p.d < 0.15;
  if (near && truth.ground.some((g) => Math.abs(g.t - p.t) < EDGE.noiseGap)) return 'noise';
  if (near && truth.pad && Math.abs(truth.pad.t - p.t) < EDGE.noiseGap) return 'noise';
  if (p.d < EDGE.close) return 'close';
  return near ? 'near' : 'clear';
}

// ---------------------------------------------------------------- Snicko

// The stump-microphone trace around the ball passing the bat, deterministic
// for a seed: { t0, t1, tc (the pass), n, values (signed, -1..1), env (0..1),
// spikes: [{ t, kind: 'bat'|'pad'|'body'|'ground', amp, aligned }], frames:
// [frame times, one exactly at tc] }. A bat contact is a sharp spike exactly at
// the contact (taller for a thicker edge; a faint one is small but clear above
// the noise); the pad / body a broader, lower bump; the bat on the ground a
// spike that does not line up with the ball passing the bat.
export function snickoTrace(log, { seed = 1, n = 640, half = EDGE.window, frameDt = EDGE.frameDt } = {}) {
  const pass = passOf(log);
  const tc = pass ? pass.t : (log.events[0] ? log.events[0].t : 0);
  let t0 = tc - half, t1 = tc + half;
  for (const e of log.events) {
    if (Math.abs(e.t - tc) > EDGE.maxWindow) continue;
    t0 = Math.min(t0, e.t - 0.014);
    t1 = Math.max(t1, e.t + 0.022);
  }
  const spikes = [];
  for (const e of log.events) {
    if (e.t < t0 || e.t > t1) continue;
    if (e.type === 'bat') spikes.push({ t: e.t, kind: 'bat', amp: 0.16 + 0.82 * e.strength, w: 0.00055, ring: 0.0032, aligned: true });
    else if (e.type === 'pad' || e.type === 'body') spikes.push({ t: e.t, kind: e.type, amp: clamp(0.13 + (e.speed || 20) / 260, 0.14, 0.3), w: 0.0068, ring: 0.009, aligned: pass ? Math.abs(e.t - pass.t) <= EDGE.align : false });
    else if (e.type === 'ground') spikes.push({ t: e.t, kind: 'ground', amp: clamp(0.34 + (e.speed || 1) * 0.07, 0.34, 0.66), w: 0.0013, ring: 0.0065, aligned: pass ? Math.abs(e.t - pass.t) <= EDGE.align : false });
  }
  const rng = makeRng((seed >>> 0) || 1);
  const values = new Float32Array(n), env = new Float32Array(n);
  let floor = 0.045, sign = 1;
  for (let i = 0; i < n; i++) {
    const t = t0 + (t1 - t0) * (i / (n - 1));
    // a wandering noise floor (crowd, wind, the batter's feet)
    floor += (0.045 - floor) * 0.08 + (rng() - 0.5) * 0.012;
    floor = clamp(floor, 0.022, 0.075);
    let a = floor;
    for (const s of spikes) {
      const dt = t - s.t;
      let k = Math.exp(-(dt * dt) / (s.w * s.w));
      if (dt > 0) k = Math.max(k, 0.55 * Math.exp(-dt / s.ring));
      a += s.amp * k;
    }
    a = Math.min(1, a);
    env[i] = a;
    // An audio-like carrier: the sign flips most samples (a dense trace);
    // where a sound rises over the floor the swing is near full, so a spike
    // reaches its height, while the floor is a ragged hiss below it.
    const loud = a > floor * 2.2;
    sign = loud || rng() < 0.7 ? -sign : sign;
    values[i] = sign * a * (loud ? 0.82 + 0.18 * rng() : 0.3 + 0.7 * rng());
  }
  const frames = [];
  const k0 = Math.ceil((t0 - tc) / frameDt - 1e-9), k1 = Math.floor((t1 - tc) / frameDt + 1e-9);
  for (let k = k0; k <= k1; k++) frames.push(tc + k * frameDt);
  return { t0, t1, tc, n, values, env, spikes, frames, frameDt };
}

// The trace's envelope at time t (0..1).
export function traceAt(trace, t) {
  const f = (t - trace.t0) / (trace.t1 - trace.t0) * (trace.n - 1);
  const i = clamp(Math.round(f), 0, trace.n - 1);
  return trace.env[i];
}

// Where the ball was (world and bat-local) at time t, from the frames.
export function frameAt(log, t) {
  const F = log.frames;
  if (!F.length) return null;
  if (t <= F[0].t) return F[0];
  if (t >= F[F.length - 1].t) return F[F.length - 1];
  let i = 1;
  while (i < F.length - 1 && F[i].t < t) i++;
  const a = F[i - 1], b = F[i], f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  const L = (k) => a[k] + (b[k] - a[k]) * f;
  const out = { t, x: L('x'), y: L('y'), z: L('z'), lx: L('lx'), ly: L('ly'), lz: L('lz'), d: L('d'), ax: a.ax };
  if (a.qw != null && b.qw != null) {
    const s = a.qx * b.qx + a.qy * b.qy + a.qz * b.qz + a.qw * b.qw < 0 ? -1 : 1;
    let qx = a.qx + (s * b.qx - a.qx) * f, qy = a.qy + (s * b.qy - a.qy) * f, qz = a.qz + (s * b.qz - a.qz) * f, qw = a.qw + (s * b.qw - a.qw) * f;
    const n = Math.hypot(qx, qy, qz, qw) || 1;
    Object.assign(out, { px: L('px'), py: L('py'), pz: L('pz'), qx: qx / n, qy: qy / n, qz: qz / n, qw: qw / n });
  }
  return out;
}

// ---------------------------------------------------------------- Hot Spot

// The thermal marks: [{ on: 'bat'|'pad'|'body', where, edge, u, v, vBlade,
// size (0..1), heat (0..1), t }]. u: across (bat: ±1 = the edges; pad: ±1 =
// the sides of the batter's pad box, + off side), v: bat 0 toe … 1 handle top,
// pad: height in m. No contact, no mark.
export function hotspotMarks(log) {
  const marks = [];
  for (const e of log.events) {
    if (e.type === 'bat') {
      const f = frameAt(log, e.t);
      marks.push({ on: 'bat', where: e.where, edge: e.edge, u: e.u, v: e.v, vBlade: e.vBlade, side: e.side, ax: f ? f.ax : 1, size: 0.3 + 0.7 * e.strength, heat: 0.55 + 0.45 * e.strength, t: e.t, label: describeContact(e) });
    } else if (e.type === 'pad' || e.type === 'body') {
      const k = clamp((e.speed || 20) / 35, 0.3, 1);
      marks.push({ on: e.type, leg: e.leg, u: e.u, v: e.v, size: 0.55 + 0.45 * k, heat: 0.7 + 0.3 * k, t: e.t, label: describeContact(e) });
    }
  }
  return marks;
}

// ---------------------------------------------------------------- umpires

// How often the on-field umpire gets an edge wrong at the reference accuracy
// (medium, 0.86): `miss` = he does not hear an edge that was there, `phantom`
// = he gives one that was not, by what was going on. Scaled by
// (1 - accuracy) / 0.14 (easy 0.8 errs more, hard 0.92 less).
export const UMPIRE_EDGE = {
  miss: { faint: 0.38, thin: 0.12, thick: 0.02, full: 0.01 },
  phantom: { noise: 0.24, close: 0.08, near: 0.025, clear: 0.01 },
};
const errScale = (accuracy) => clamp((1 - accuracy) / 0.14, 0.2, 2.5);

// Caught (behind, bat-pad, any catch where the edge is the question): true =
// OUT. Only whether the bat touched it is in question (the catch itself is
// the fielding's).
export function umpireCaught(truth, { rng = Math.random, accuracy = 0.86 } = {}) {
  const k = errScale(accuracy);
  if (truth.touched) return rng() >= Math.min(0.9, UMPIRE_EDGE.miss[truth.thickness || 'thin'] * k);
  return rng() < Math.min(0.6, UMPIRE_EDGE.phantom[truth.noise || 'clear'] * k);
}

// LBW: does the umpire pick up the inside edge (bat first)? If not, he judges
// the shout as if it had not touched the bat.
export function umpireHearsEdge(truth, { rng = Math.random, accuracy = 0.86 } = {}) {
  if (!truth.batFirst) return false;
  return rng() >= Math.min(0.9, UMPIRE_EDGE.miss[truth.thickness || 'thin'] * errScale(accuracy));
}

// Do the (AI) fielders go up? catchTaken: a completed catch off the bat; else
// the keeper took a ball that may or may not have touched it.
export const APPEAL_EDGE = {
  caught: { faint: 0.7, thin: 0.95, thick: 1, full: 1 },
  behind: { noise: 0.6, close: 0.42, near: 0.12, clear: 0 },
};
export function fieldersAppeal(truth, { rng = Math.random, catchTaken = false } = {}) {
  if (catchTaken && truth.touched) return rng() < APPEAL_EDGE.caught[truth.thickness || 'thin'];
  return rng() < APPEAL_EDGE.behind[truth.noise || 'clear'];
}

// Worth an appeal from you (the bowler) when the fielders kept quiet: a catch
// off the bat, or a ball that went close to it / with a noise as it passed.
export function appealWorthy(truth) {
  return truth.touched || (truth.pass != null && truth.pass.d < 0.3);
}

// Is this catch a question of the edge (on-field decision, reviewable), or a
// clean catch off the middle that is out by itself? catchDist: m from the
// striker to where it was caught.
export function edgeQuestion(truth, { catchDist = 0 } = {}) {
  const b = truth.bat;
  if (!b) return false;
  if (truth.batPad) return true;
  if (b.where === 'face') return false;
  if (b.thickness === 'faint' || b.thickness === 'thin' || b.where === 'glove' || b.where === 'handle') return true;
  return catchDist < 30;          // a thick edge to the keeper / slips; one carried to the deep is plain to see
}

// The board's edge rows: { label, text, colour } with lbw.js's law colours
// (green = this condition for OUT is met, red = it is not). review: 'caught'
// (an edge is what makes it out) or 'lbw' (bat first makes it not out).
export function edgeRows(truth, { review = 'caught' } = {}) {
  const lbw = review === 'lbw';
  const b = truth.bat;
  const edgeCounts = !!b && (!lbw || truth.batFirst);
  const good = (counts) => (lbw ? (counts ? 'red' : 'green') : (counts ? 'green' : 'red'));
  let snicko;
  if (b && lbw && !truth.batFirst) snicko = 'PAD BEFORE BAT';
  else if (b) snicko = b.thickness === 'faint' ? 'FAINT SPIKE AT BAT' : 'SPIKE AT BAT';
  else if (truth.ground.length && truth.pass && truth.ground.some((g) => Math.abs(g.t - truth.pass.t) < EDGE.maxWindow)) snicko = 'SPIKE NOT AT BAT';
  else if (truth.pad) snicko = 'PAD, NO BAT';
  else snicko = 'NO SPIKE';
  let hot;
  if (b) hot = `MARK ON ${describeContact(b).replace(' OF THE BAT', '')}`;
  else if (truth.pad) hot = 'MARK ON PAD ONLY';
  else hot = 'NO MARK';
  const rows = [
    { label: 'SNICKO', text: snicko, colour: good(edgeCounts) },
    { label: 'HOT SPOT', text: hot, colour: good(edgeCounts) },
  ];
  return rows;
}

// A reviewed catch: OUT if and only if it touched the bat (or glove). No
// umpire's call; the review is kept only when the decision is overturned.
export function caughtReview(truth, { onFieldOut = false } = {}) {
  const out = !!truth.touched;
  const overturned = out !== !!onFieldOut;
  const what = truth.bat ? describeContact(truth.bat).toLowerCase() : null;
  const reason = out ? `${what}: out caught` : truth.noise === 'noise' ? 'the noise was not the bat: not out' : 'no edge: not out';
  return { out, umpiresCall: false, reviewKept: overturned, overturned, reason, rows: edgeRows(truth, { review: 'caught' }) };
}

// Does the AI side send it upstairs? kind: 'lbw' | 'caught'; aiBatting: the
// AI is the batting side (it was given out) else the fielding side (given not
// out); truthOut: what the truth is. Reviews when the call is wrong (it
// usually knows: a batter knows whether he hit it), and now and then wastes
// one on a correct decision.
export const AI_REVIEW = {
  lbw: { wrong: 0.7, right: 0.07 },
  caughtBatter: { wrong: 0.92, right: 0.06 },
  caughtField: { wrong: 0.6, right: 0.06 },
};
export function aiWillReview({ kind = 'lbw', aiBatting = true, onFieldOut, truthOut, left = 1, rng = Math.random } = {}) {
  if (left <= 0) return false;
  const P = kind === 'lbw' ? AI_REVIEW.lbw : aiBatting ? AI_REVIEW.caughtBatter : AI_REVIEW.caughtField;
  return rng() < (!!truthOut !== !!onFieldOut ? P.wrong : P.right);
}

// Everything the board needs for the edge part of a review.
export function edgeEvidence(log, { review = 'caught', seed = 1 } = {}) {
  const truth = edgeTruth(log);
  const trace = snickoTrace(log, { seed });
  return { truth, trace, marks: hotspotMarks(log), rows: edgeRows(truth, { review }), log, review };
}

// Show the edge checks in an LBW review? When the bat was involved at all:
// it touched the ball, or passed within 40 cm of it.
export function edgeInvolved(truth) {
  return !!truth && (truth.touched || (truth.pass != null && truth.pass.d < 0.4));
}
