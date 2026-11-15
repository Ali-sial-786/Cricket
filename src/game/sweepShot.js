// A sweep: the grip held as the bat meets the ball. The shot is the one your
// bat really played - its speed from the contact physics and the power model
// (how hard and how loaded the swing was, where on the bat it hit), its side
// from the way the ball came off your bat - helped gently into a sweeper's
// arc instead of being re-aimed at random:
//
//   sweep          kept down (launch at most FLAT), its bearing moved HELP of
//                  the way into the arc square of the wicket on the side it
//                  went (leg side: 50..150 deg from straight back past the
//                  bowler; reverse: the same on the off side)
//   slog sweep     (grip + trigger, or stepped out) lifted HELP of the way up
//                  into CONFIG.bat.sweepLift, in front of square (30..95 deg)
//   reverse        the off side: where the ball went if that is clear (more
//                  than 20 deg off straight), else the way your bat swept
//
// Edges and anything not off the face are left as they are. Deterministic
// (no dice). Pure JS; tested in tests/sweep.test.js. World frame: the bowler
// is toward -Z, the off side of a right-hander is +X.
import { CONFIG } from '../config.js';

export const SWEEP = {
  help: 0.5,                 // how far the bearing / launch are moved toward the sweeper's arc
  arc: [0.87, 2.62],         // rad from straight back: a sweep goes square, 50..150 deg
  slogArc: [0.52, 1.66],     // rad: a slog sweep in front of square, 30..95 deg
  flat: 0.17,                // rad: a sweep is launched no higher than this (~10 deg)
  clear: 0.35,               // rad off straight: the ball's own side is clear beyond this
};

// vel: the ball's velocity off the bat (mutated); ev: the contact ({ isEdge, face });
// slog: the slog sweep is held; reverse: your bat swept toward the off side.
// Returns the shot's name, or null when it is left as it came off the bat.
export function sweepShot(vel, ev, { slog = false, reverse = false } = {}, cfg = CONFIG) {
  if (!ev || ev.isEdge || ev.face !== 'front') return null;
  const sp = Math.hypot(vel.x, vel.y, vel.z);
  if (sp < 0.5) return null;
  const S = SWEEP, h = Math.hypot(vel.x, vel.z);
  let az = Math.atan2(vel.x, -vel.z), el = Math.atan2(vel.y, h);
  const off = Math.abs(az) > S.clear ? az > 0 : !!reverse, side = off ? 1 : -1;
  // the bearing: into the arc on its side, by HELP (from the wrong side: from the arc's near end)
  const arc = slog ? S.slogArc : S.arc, a = Math.abs(az) * (Math.sign(az) === side ? 1 : -1);
  const want = side * Math.min(arc[1], Math.max(arc[0], a));
  az += (want - az) * S.help;
  // the launch: a sweep along the ground; a slog sweep up into the air
  if (slog) { const L = cfg.bat.sweepLift; if (el < L[0]) el += (L[0] - el) * S.help; el = Math.min(el, L[1]); }
  else el = Math.min(el, S.flat);
  const ch = Math.cos(el);
  vel.x = Math.sin(az) * ch * sp; vel.y = Math.sin(el) * sp; vel.z = -Math.cos(az) * ch * sp;
  return slog ? 'slog sweep' : off ? 'reverse sweep' : 'sweep';
}
