import { hypot3 } from '../physics/math.js';
// Did you play at the ball? Read from the middle of your bat while the ball
// comes to you, not from the controller alone: a wristy swing turns the
// blade with hardly any movement of your hand, and lifting the bat out of the
// way is quick but is no shot.
//
//   into speed   the speed of the middle of the bat (controller velocity +
//                its turning x the lever arm down the blade, real m/s) with
//                the parts going UP and BACK toward the keeper taken out
//                (and nothing while it goes mostly upward): what is left
//                goes at the ball (down, forward, across)
//   reach        how far the middle of the bat came at the ball over the
//                delivery, against your head (walking or charging down the
//                pitch moves both): forward and across in full, down by half
//                (a tap of the bat is not a block)
//
//   offered      into speed >= OFFER.fast (smoothed over a few frames: a
//                stroke, not a twitch), or a reach >= OFFER.reach at
//                >= OFFER.slow: a block. The LBW "shot offered", and
//                "Beaten" rather than "Left alone" for a miss
//   wild         into speed >= OFFER.wild: a big swing and a miss (the crowd)
//
// Pure JS (no three.js); tested in tests/shotOffered.test.js.
export const OFFER = {
  fast: 2.5,     // m/s at the middle of the bat, at the ball: a stroke
  slow: 0.8,     // m/s: a block must at least move this fast...
  reach: 0.1,    // ...and bring the middle of the bat this far (m) at the ball
  wild: 9,       // m/s: a full swing
  tau: 0.03,     // s: the into speed is smoothed over about this long
};

// Speed of a blade velocity v {x, y, z} at the ball: up and back toward the keeper (+Z) do not count,
// and a bat going mostly upward (picked up, lifted out of the way: as it comes over the top it also
// goes forward) counts for nothing.
export function intoSpeed(v) {
  const sp = hypot3(v.x, v.y, v.z);
  if (sp < 1e-9) return 0;
  const u = (v.y / sp - 0.3) / 0.4, gate = u <= 0 ? 1 : u >= 1 ? 0 : 1 - u * u * (3 - 2 * u);
  return hypot3(v.x, Math.min(0, v.y), Math.min(0, v.z)) * gate;
}

// Velocity (world) of a point on the bat: the controller's linear velocity
// plus its angular velocity x the lever arm (point - grip). Writes out.
export function pointVelocity(out, lin, ang, lever) {
  out.x = lin.x + ang.y * lever.z - ang.z * lever.y;
  out.y = lin.y + ang.z * lever.x - ang.x * lever.z;
  out.z = lin.z + ang.x * lever.y - ang.y * lever.x;
  return out;
}

export class ShotEvidence {
  constructor() { this.reset(); }
  reset() { this.s = { p0: null, peak: 0, sm: 0, reach: 0 }; }
  // v: velocity of the middle of the bat (world, m/s, real time); p: where it is; head: your head
  // (x, z used); dt: real seconds since the last call.
  add(v, p, head, dt) {
    const S = this.s, sp = intoSpeed(v);
    S.sm += (sp - S.sm) * Math.min(1, dt / OFFER.tau);
    S.peak = Math.max(S.peak, S.sm);
    const rx = p.x - head.x, rz = p.z - head.z;
    if (!S.p0) S.p0 = { x: rx, y: p.y, z: rz };
    // (forward and across count in full, down by half: tapping the bat up and down is no block)
    S.reach = Math.max(S.reach, hypot3(rx - S.p0.x, Math.min(0, rz - S.p0.z), 0.5 * Math.min(0, p.y - S.p0.y)));
  }
  get peak() { return this.s.peak; }
  get offered() { const S = this.s; return S.peak >= OFFER.fast || (S.reach >= OFFER.reach && S.peak >= OFFER.slow); }
  get wild() { return this.s.peak >= OFFER.wild; }
}
