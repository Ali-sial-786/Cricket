// How much the swing that reached the ball was "loaded": how far back and
// high the bat was taken and how far it travelled to the ball. Read from the
// bat's own track (poses only), so it is the same live and in any re-run of
// the physics, and does not depend on the body drawn for you.
//
//   lift     the blade's angle from hanging straight down at the top of the
//            backlift (0 hanging, pi/2 level behind you, pi straight up)
//   travel   how far the middle of the bat went from the top of the
//            backlift to the ball (m), against your head (walking or
//            charging down the pitch moves both)
//   load     = (liftScore + travelScore) / 2, each 0..1:
//              liftScore   = (lift - 0.45) / (2.0 - 0.45)  ~26 deg .. ~115 deg
//              travelScore = (travel - 0.3) / (2.2 - 0.3)    30 cm .. 2.2 m
//            a block or a push ~0, half a backlift ~0.6, a full one 1.
//
// The top of the backlift is where the downswing that met the ball began:
// walking back from contact, the first moment the middle of the bat was
// (nearly) still or turned back the other way, at most LOAD.window real
// seconds before contact. A bat held high and lowered before a push is a
// push.
//
// Pure JS (no three.js). Tested in tests/power.test.js.
export const LOAD = {
  sweet: -0.62,                 // the middle of the bat along its +Y from your hand (m)
  lift: [0.45, 2.0],            // rad: the blade's angle from hanging down at the top: no load .. full
  travel: [0.3, 2.2],           // m the middle of the bat travelled to the ball: no load .. full
  window: 0.8,                  // real s before contact the top is looked for, at most
  still: 0.6,                   // m/s: slower than this the bat is at the top (turning round)
  keep: 1.0,                    // real s of track kept
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function loadOf(lift, travel) {
  const a = clamp01((lift - LOAD.lift[0]) / (LOAD.lift[1] - LOAD.lift[0]));
  const b = clamp01((travel - LOAD.travel[0]) / (LOAD.travel[1] - LOAD.travel[0]));
  return (a + b) / 2;
}

export class SwingLoad {
  constructor(sweetY = LOAD.sweet) { this.sweetY = sweetY; this.reset(); }
  reset() { this.h = []; }

  // t: game (physics) time of the pose; rt: the real clock (your movements' own time); pose: the bat
  // {p, q} (world; p = your hand, the bat's +Y up the handle); ref: your head {x, z} or null.
  push(t, rt, pose, ref = null) {
    const H = this.h, q = pose.q, y = this.sweetY;
    // the bat's +Y in the world, and the middle of the bat
    const ax = 2 * (q.x * q.y - q.w * q.z), ay = 1 - 2 * (q.x * q.x + q.z * q.z), az = 2 * (q.y * q.z + q.w * q.x);
    const last = H[H.length - 1];
    if (last && (rt < last.rt || t < last.t || rt - last.rt > LOAD.window)) H.length = 0;      // (a gap or time going back: start again)
    H.push({ t, rt, x: pose.p.x + ax * y - (ref ? ref.x : 0), y: pose.p.y + ay * y, z: pose.p.z + az * y - (ref ? ref.z : 0), lift: Math.acos(ay > 1 ? 1 : ay < -1 ? -1 : ay) });
    while (H.length > 2 && rt - H[0].rt > LOAD.keep) H.shift();
  }

  // The swing that reached the ball at game time tc: { load, lift, travel, top (real s before contact) }.
  read(tc) {
    const H = this.h;
    let i = H.length - 1;
    while (i >= 0 && H[i].t > tc + 1e-9) i--;
    if (i < 1) return { load: 0, lift: i >= 0 ? H[i].lift : 0, travel: 0, top: 0 };
    const rc = H[i].rt;
    let lift = H[i].lift, travel = 0, k = i, pdx = 0, pdy = 0, pdz = 0, pl = 0;
    for (; k > 0; k--) {
      const a = H[k - 1], b = H[k];
      if (rc - a.rt > LOAD.window) break;
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, l = Math.hypot(dx, dy, dz), dt = Math.max(1e-4, b.rt - a.rt);
      // (turned back the other way: that was the pick-up; at rest: that was the top)
      if (pl > 0 && dx * pdx + dy * pdy + dz * pdz < -0.2 * l * pl) break;
      travel += l; lift = Math.max(lift, a.lift);
      if (l / dt < LOAD.still && travel > 0.03) break;
      pdx = dx; pdy = dy; pdz = dz; pl = l;
    }
    return { load: loadOf(lift, travel), lift, travel, top: rc - H[Math.max(0, k - 1)].rt };
  }
}
