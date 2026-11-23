// Where your feet are. Nothing tracks them, so they are worked out from what
// is tracked: they stay planted under you while your head moves within what
// a body can reach (lean, sway, a small crouch never shuffle them), and step,
// one at a time, picked up and put down, never slid, when it goes further:
//   head forward of the front foot     the front foot strides (the back foot stays)
//   further than a lunge reaches       the back foot comes up, then the front again: real steps down the pitch
//   head back over the back foot       the back foot goes back, the front foot follows
//   across                             both follow, the nearer one first
//   right down (a sweep)               a long stride with the back knee to go down behind it
// and during a stroke the feet do what the AI batter's do for that shot
// (pattern: its captured feet at contact against its stance, from
// src/render/playerBody.js), as far as your head allows.
// Standing still for a while brings them back to a stance under you.
//
// Pure JS (no three.js), deterministic; its state is plain data (save / load).
// Tested in tests/footwork.test.js. World frame: the bowler is toward -Z, a
// right-hander faces +X, so the front (left) foot is the one nearer -Z.
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, k) => a + (b - a) * k;
const hyp = (x, y) => Math.sqrt(x * x + y * y);      // (Math.hypot makes garbage in V8)
const angDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };

export const FEET = {
  back: 0.26, front: 0.1,        // m: back foot behind the head, front foot ahead of it, in the stance (crease.js CREASE.footBack; the front
                                 // foot close under you, so the bat you swing meets the ball before the pad: batting.js PLAYER_PAD)
  lunge: 0.45,                   // the front foot goes this much further for every metre the head leads the back foot
  reach: 0.9,                    // m: the head this far ahead of the back foot is a full lunge (crease.js CREASE.reach)
  backMin: 0.12,                 // m: the head nearer than this to the back foot (or behind it): the back foot goes back
  frontMin: -0.05, frontSlack: 0.27,  // m: the front foot at least this far ahead of the head (-: the head out over it); at most its place + this
  xLo: 0.0, xHi: 0.42,           // m: the head this far to the off side of the ankles is fine (it is out over the toes)
  maxStride: 1.0,                // m between the feet at most
  minApart: 0.24,                // m between the feet at least
  stepMin: 0.15, stepMax: 0.32,  // s a step takes (longer for a longer one)
  lift: 0.04, liftMore: 0.06,    // m a stepping foot is picked up (more for a long step)
  settleAfter: 0.8,              // s still (and upright) before the feet come back to a stance under you
  retarget: 3,                   // m/s: how fast the landing spot of a foot in the air may be moved
  teleport: 1.6,                 // m: further than this in one go is not a step (the rig was moved): the feet are just put there
  stumpX: 0.3, stumpZ: 0.27,     // the feet stay out of this box round the stumps (m, from the middle stump)
  kneelBack: 0.46, kneelSide: 0.2, kneelFront: 0.2,
  turnStep: 0.45,                // rad: turned this far (the stick) past the way a planted foot points, it steps round
  turnJump: 0.5,                 // rad in one frame: not a turn but the rig put back: the feet go with it
  yawMaxL: 1.0, yawMaxR: 1.45,   // rad: the feet turned toward the bowler at most (front, back)
};

// (update's working frame: your head and the stance's turn; its own scratch points)
const _f = { hx: 0, hz: 0, cs: 1, sn: 0 };
const _pL = { x: 0, z: 0 }, _pR = { x: 0, z: 0 }, _tL = { x: 0, z: 0 }, _tR = { x: 0, z: 0 }, _q = { x: 0, z: 0 }, _pa = { x: 0, z: 0 }, _pb = { x: 0, z: 0 };
const xz = (o, x, z) => { o.x = x; o.z = z; return o; };
function toS(x, z, o) { const dx = x - _f.hx, dz = z - _f.hz; o.x = _f.hx + dx * _f.cs - dz * _f.sn; o.z = _f.hz + dx * _f.sn + dz * _f.cs; return o; }
function toW(o) { const dx = o.x - _f.hx, dz = o.z - _f.hz; o.x = _f.hx + dx * _f.cs + dz * _f.sn; o.z = _f.hz - dx * _f.sn + dz * _f.cs; return o; }
function rot(o, kx, kz, hx, hz, c2, s2) { const dx = o[kx] - hx, dz = o[kz] - hz; o[kx] = hx + dx * c2 + dz * s2; o[kz] = hz - dx * s2 + dz * c2; }
const lungeOf = (rz, hz) => clamp(rz - FEET.back - hz, 0, 0.7);
const busy = (f, hurry) => f.m && f.m.k < (hurry ? 0.6 : 1);
const turnWant = (f, E, th) => (!f.m && E < 0.12 && Math.abs(angDiff(f.th0 ?? th, th)) > FEET.turnStep ? 1.01 + Math.abs(angDiff(f.th0 ?? th, th)) : 0);
function ease(k) { return k * k * k * (10 - 15 * k + 6 * k * k); }           // (no speed and no acceleration at either end)
function hop(k) { const a = k * (1 - k); return 16 * a * a; }

export class Footwork {
  constructor() { this.reset(); }
  reset() {
    const foot = () => ({ x: 0, y: 0, z: 0, yaw: 0, m: null });
    this.s = { init: false, L: foot(), R: foot(), hx: 0, hz: 0, vx: 0, vz: 0, cool: 0, anchor: null, steps: 0 };
  }
  save() { return structuredClone(this.s); }
  load(s) { this.s = structuredClone(s); }

  // i: { hx, hz    your head along the ground (m)
  //      crouch    how far it is below standing (m)         quiet   s you and the bat have been still
  //      engage    0..1 a stroke is being played            pat     its feet: { Lx, Lz, Rx, Rz, yawL, yawR } against the stance, or null
  //      turn      rad the stroke has opened the hips (the feet pivot after them)
//      heading   rad the stick has turned you from side-on (your stance turns with it; your feet step round)
//      kneel     0..1 right down                          pin     { z, k }: your real back foot while a stumping is judged, or null
  //      stumpsZ   the wicket's z (your feet stay out of it), or null
  //      maxStride m between the feet at most (legs only reach so far with the head where it is) }
  // The planner works in the frame of your stance (side-on, turned by `heading` about your head);
  // the feet themselves stay where they are planted in the world, so turning makes them step.
  // Returns { L, R }: { x, y (m off the turf), z, yaw (rad from side-on, world: + = toes turned toward the bowler), moving }.
  // out: an object to write the answer into (reused frame to frame), or a new one.
  update(dt, i, out = null) {
    const S = this.s, F = FEET, hx = i.hx, hz = i.hz;
    const ax = clamp(0.1 + 0.8 * (i.crouch || 0), 0.1, 0.3);
    // your stance's frame: side-on, turned by the stick about your head (toS: world -> stance, toW: back)
    const th = i.heading || 0, cs = Math.cos(th), sn = Math.sin(th);
    _f.hx = hx; _f.hz = hz; _f.cs = cs; _f.sn = sn;
    if (!S.init) { this.place(ax, th); S.hx = hx; S.hz = hz; S.vx = S.vz = 0; S.init = true; S.th = th; }
    // (a jump in the turn is the rig being put back, not a turn: the feet go round with it)
    const jump = angDiff(S.th ?? th, th);
    if (Math.abs(jump) > F.turnJump) {
      const c2 = Math.cos(jump), s2 = Math.sin(jump);
      for (let n = 0; n < 2; n++) {
        const f = n ? S.R : S.L;
        rot(f, 'x', 'z', hx, hz, c2, s2); f.yaw += jump; f.th0 = (f.th0 ?? 0) + jump;
        if (f.m) { rot(f.m, 'fx', 'fz', hx, hz, c2, s2); rot(f.m, 'tx', 'tz', hx, hz, c2, s2); f.m.yaw0 += jump; }
      }
    }
    S.th = th;
    // how fast you are going (smoothed), to lead a foot to where you will be when it lands
    if (dt > 0) {
      const k = Math.min(1, dt / 0.08);
      S.vx += ((hx - S.hx) / dt - S.vx) * k; S.vz += ((hz - S.hz) / dt - S.vz) * k;
    }
    S.hx = hx; S.hz = hz;
    // (walking: going somewhere standing up; a lunge goes down as it goes forward)
    const sp = hyp(S.vx, S.vz), hurry = sp > 0.9 && (i.crouch || 0) < 0.16;
    const L = S.L, R = S.R;
    const E = i.engage || 0, kneel = i.kneel || 0, maxStride = kneel > 0.5 ? F.maxStride : clamp(i.maxStride ?? F.maxStride, 0.4, F.maxStride);
    // where the feet are (or are landing), in the stance's frame; how fast your head goes in it
    const pL = toS(L.m ? L.m.tx : L.x, L.m ? L.m.tz : L.z, _pL), pR = toS(R.m ? R.m.tx : R.x, R.m ? R.m.tz : R.z, _pR);
    const vx = S.vx * cs - S.vz * sn, vz = S.vx * sn + S.vz * cs;
    // the stroke's footwork is measured from where the feet were when it began
    if (E > 0.12 && i.pat) { if (!S.anchor) S.anchor = { Lx: pL.x, Lz: pL.z, Rx: pR.x, Rz: pR.z, pL: null, pR: null }; }
    else if (E < 0.06) S.anchor = null;

    // ---- where each foot ought to be (its own place if that is still fine)
    // (tL, tR: this call's own two objects, set in place: no garbage a frame)
    const Rz0 = pR.z, Lz0 = pL.z, Rx0 = pR.x, Lx0 = pL.x;
    const lead = 0.12;
    const tL = xz(_tL, Lx0, Lz0), tR = xz(_tR, Rx0, Rz0);
    let thrL = 0.05, thrR = 0.05;
    if (kneel > 0.5) {
      // right down: the back leg trails (its knee goes down), the front foot a stride ahead of it
      xz(tR, hx - F.kneelSide, hz + F.kneelBack); xz(tL, hx - F.kneelSide + 0.1, hz - F.kneelFront);
      const kb = Rz0 - hz, kx = hx - Rx0;
      if (kb > 0.3 && kb < 0.85 && kx > 0 && kx < 0.45) xz(tR, Rx0, Rz0);
      if (hyp(tL.x - Lx0, tL.z - Lz0) < 0.15) xz(tL, Lx0, Lz0);
    } else {
      const settle = i.quiet > F.settleAfter && E < 0.05 && (i.crouch || 0) < 0.14;
      // back foot: fine anywhere from just behind the head to a full lunge behind it
      // (on the move the back foot keeps up; standing tall the legs do not reach a lunge)
      const b = Rz0 - hz, bLo = settle ? 0.19 : F.backMin, bHi = Math.max(F.back + 0.1, Math.min(settle ? 0.42 : hurry ? 0.62 : F.reach, maxStride - 0.08));
      const offR = hx - Rx0, offL = hx - Lx0;
      const xLo = settle ? ax - 0.1 : F.xLo, xHi = settle ? ax + 0.1 : F.xHi;
      if (b < bLo || b > bHi || offR < xLo || offR > xHi) xz(tR, hx - ax + vx * lead, hz + F.back + vz * lead);
      // front foot: ahead of the head, further the more the head leads the back foot
      const want = F.front + F.lunge * lungeOf(tR.z, hz), a = hz - Lz0;
      const aLo = settle ? F.front - 0.08 : F.frontMin, aHi = settle ? want + 0.1 : want + F.frontSlack;
      if (a < aLo || a > aHi || offL < xLo - 0.03 || offL > xHi + 0.03) xz(tL, hx - ax + 0.03 + vx * lead, hz - want + vz * lead);
      // a stroke: the feet the shot has, from where they were, as far as the head allows.
      // Each foot goes there once (again only if the shot turned out to be another one):
      // after that it stays planted until your head moves it.
      if (S.anchor && i.pat && E > 0.12) {
        const A = S.anchor, p = i.pat, pin = i.pin && i.pin.k > 0;
        const pl = hyp(p.Lx, p.Lz), pr = hyp(p.Rx, p.Rz);
        if (pr > 0.05 && !pin && b >= bLo && b <= bHi) {
          const z = clamp(A.Rz + p.Rz, hz + 0.08, hz + bHi), x = clamp(A.Rx + p.Rx, hx - F.xHi, hx - F.xLo + 0.05);
          if (!A.pR || hyp(x - A.pR.x, z - A.pR.z) > 0.2) { A.pR = { x, z }; xz(tR, x, z); thrR = 0.06; }
        }
        if (pl > 0.05 && a >= aLo) {
          const ahead = F.front + 0.16 + F.lunge * lungeOf(tR.z, hz);
          const z = clamp(A.Lz + p.Lz, hz - ahead, hz - F.frontMin), x = clamp(A.Lx + p.Lx, hx - F.xHi - 0.1, hx - F.xLo + 0.2);
          if (!A.pL || hyp(x - A.pL.x, z - A.pL.z) > 0.2) { A.pL = { x, z }; xz(tL, x, Math.min(z, tL.z)); thrL = 0.06; }
        }
      }
    }
    // never crossed, never on top of each other, never further apart than a stride
    if (tL.z > tR.z - 0.15) { if (tL.z !== Lz0) tL.z = tR.z - 0.3; else tR.z = tL.z + 0.3; }
    const st = hyp(tL.x - tR.x, tL.z - tR.z);
    if (st > maxStride) { tL.x = tR.x + (tL.x - tR.x) * maxStride / st; tL.z = tR.z + (tL.z - tR.z) * maxStride / st; }
    // (back in the world)
    toW(tL); toW(tR);
    // while a stumping is judged the back foot is where yours really is
    if (i.pin && i.pin.k > 0 && i.pin.z != null) { tR.z = mix(tR.z, i.pin.z, Math.min(1, i.pin.k)); thrR = 0.03; }
    // the wicket: a foot is never in it, and never behind it unless you have walked round there yourself
    if (i.stumpsZ != null) for (let n = 0; n < 2; n++) {
      const t = n ? tR : tL;
      if (Math.abs(t.x) >= F.stumpX) continue;
      const front = i.stumpsZ - F.stumpZ;
      if (hz < i.stumpsZ + 0.3) t.z = Math.min(t.z, t === tL ? front - 0.3 : front);
      else if (Math.abs(t.z - i.stumpsZ) < F.stumpZ) t.z = i.stumpsZ + F.stumpZ;
    }
    const eL = hyp(tL.x - L.x, tL.z - L.z), eR = hyp(tR.x - R.x, tR.z - R.z);
    // the rig was moved: no step covers that
    if (Math.max(eL, eR) > F.teleport) {
      this.place(ax, th); L.y = R.y = 0; L.m = R.m = null; S.anchor = null; S.cool = 0;
      return this.out(out);
    }
    // ---- start a step: one foot at a time (the other may go once this one is most of the way, when you are moving)
    S.cool = Math.max(0, S.cool - dt);
    if (!busy(L, hurry) && !busy(R, hurry) && S.cool <= 0) {
      // (turned well past the way a planted foot points: it steps round, it does not spin on the spot)
      const nL = !L.m && eL > thrL ? eL / thrL : turnWant(L, E, th), nR = !R.m && eR > thrR ? eR / thrR : turnWant(R, E, th);
      if (nL > 0 || nR > 0) {
        // (both: going forward the front foot leads, going back the back foot, else the one further out;
        // turning round, one and then the other)
        const along = (toS(tL.x, tL.z, _q).z - pL.z) + (toS(tR.x, tR.z, _q).z - pR.z);
        const turning = Math.abs(angDiff(L.th0 ?? th, th)) > 0.2 || Math.abs(angDiff(R.th0 ?? th, th)) > 0.2;
        const front = nR <= 0 || (nL > 0 && (turning ? S.last !== 'L' : along < -0.05 || (along <= 0.05 && nL >= nR)));
        if (front) this.start(L, tL, eL, hurry); else this.start(R, tR, eR, hurry);
      }
    }
    // ---- move the stepping feet; planted feet do not move
    // (and as the stroke opens the hips, the back foot pivots round on its toe and the front foot opens)
    const open = Math.max(0, i.turn || 0);
    const yawL = Math.min(F.yawMaxL, 0.3 + 0.55 * Math.max(0, pR.z - pL.z - 0.45) + (S.anchor && i.pat ? i.pat.yawL * E : 0) + Math.min(0.7, open * 0.45));
    const yawR = Math.min(F.yawMaxR, -0.04 + (S.anchor && i.pat ? i.pat.yawR * E : 0) + Math.min(1.4, open * 0.85));
    // (yaws from side-on in the stance; in the world, a stepping foot turns to the way you are turned, a planted
    // one keeps the way it landed: it only pivots for the stroke)
    for (let n = 0; n < 2; n++) {
      const f = n ? R : L, t = n ? tR : tL, yawS = n ? yawR : yawL, rate = n ? 5 : 1.5;
      const yawT = yawS + (f.m ? th : f.th0 ?? th);
      const m = f.m;
      if (m) {
        // the landing spot follows where the foot ought to be (you are still moving), while the foot
        // is up: less and less as it comes down, so it lands where it is going instead of sliding there
        const dx = t.x - m.tx, dz = t.z - m.tz, d = hyp(dx, dz), mv = Math.min(d, F.retarget * dt) * (1 - ease(m.k));
        if (d > 1e-6) { m.tx += dx / d * mv; m.tz += dz / d * mv; }
        m.k = Math.min(1, m.k + dt / m.dur);
        const e = ease(m.k);
        f.x = mix(m.fx, m.tx, e); f.z = mix(m.fz, m.tz, e); f.y = m.lift * hop(m.k);
        f.yaw = mix(m.yaw0, yawT, e);
        if (m.k >= 1) { f.m = null; f.y = 0; f.th0 = th; S.cool = hurry ? 0 : 0.05; }      // (it points the way you are turned as it lands)
      } else f.yaw += clamp(yawT - f.yaw, -rate * dt, rate * dt);
    }
    return this.out(out);
  }
  // (a stance under you, as it is turned)
  place(ax, th) {
    const S = this.s, F = FEET, hx = _f.hx, hz = _f.hz;
    const a = toW(xz(_pa, hx - ax + 0.03, hz - F.front)), b = toW(xz(_pb, hx - ax, hz + F.back));
    S.L.x = a.x; S.L.z = a.z; S.R.x = b.x; S.R.z = b.z; S.L.yaw = 0.3 + th; S.R.yaw = -0.04 + th; S.L.th0 = S.R.th0 = th;
  }
  start(f, t, e, hurry) {
    const S = this.s, F = FEET;
    const dur = clamp(0.13 + 0.25 * e, F.stepMin, F.stepMax) * (hurry ? 0.85 : 1);
    f.m = { fx: f.x, fz: f.z, tx: t.x, tz: t.z, k: 0, dur, lift: F.lift + F.liftMore * Math.min(1, e / 0.5), yaw0: f.yaw };
    S.steps++; S.last = f === S.L ? 'L' : 'R';
  }

  out(o = null) {
    const S = this.s;
    if (!o) return (this._out = { L: { x: S.L.x, y: S.L.y, z: S.L.z, yaw: S.L.yaw, moving: !!S.L.m }, R: { x: S.R.x, y: S.R.y, z: S.R.z, yaw: S.R.yaw, moving: !!S.R.m }, steps: S.steps });
    for (let n = 0; n < 2; n++) { const f = n ? S.R : S.L, d = n ? o.R : o.L; d.x = f.x; d.y = f.y; d.z = f.z; d.yaw = f.yaw; d.moving = !!f.m; }
    o.steps = S.steps;
    return (this._out = o);
  }
  // An object update() can write its answer into, frame after frame.
  static outObject() { return { L: { x: 0, y: 0, z: 0, yaw: 0, moving: false }, R: { x: 0, y: 0, z: 0, yaw: 0, moving: false }, steps: 0 }; }
}
