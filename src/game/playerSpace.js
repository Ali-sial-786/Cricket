import { smoothstep as sstep } from '../physics/math.js';

// The player's space -- ONE rule for every figure, in play, between balls, in every ceremony and at the
// result: no walking, running, sliding or celebrating figure's path comes within EYE_CLEAR of your eye
// (the flat distance to your head, whichever way he faces). Paths are planned round it, never pushed out
// at the last moment (a push reads as a lunge):
//   - the field (fielding.js, its keepOut set by fieldController.keepClear) steers round you and never
//     stands, huddles or reaches inside FIELD_CLEAR: EYE_CLEAR and BODY_REACH, what a body in motion -- a
//     celebration, a pick-up, a high five -- carries past its feet;
//   - a runner, or a ceremony's walker, on a straight line has his lane bent out round you (bendAround);
//   - a walk task steers round you (render/crew.js stepWalk among its obstacles()), and the man about to
//     become you walks round to out to your side (crew.js MERGE_BACK) and fades there.
// Checked for every ceremony, the result's four outcomes and the wicket huddle in tests/playerSpace.test.js.
export const EYE_CLEAR = 1.5, BODY_REACH = 0.3, FIELD_CLEAR = EYE_CLEAR + BODY_REACH;
const BEND_IN = 3;          // m before he is level with you that a lane starts to bend out
// A straight path (heading ux, uz: unit) drawn bent round your eye e: where he is level with you his
// offset across the path is at least R, eased in from R + BEND_IN m out and back after -- a lane that
// curves round you, never nearer than R (along: |a| >= R, or across >= R where |a| < R/2, the ease
// keeps the sum outside R in between). out {x, z}: the drawn point; side (+1 / -1): which way round
// when he is on the line through you.
export function bendAround(x, z, ux, uz, e, R, out, side = 1) {
  out.x = x; out.z = z;
  if (!e) return out;
  const rx = x - e.x, rz = z - e.z, a = rx * ux + rz * uz, l = -rx * uz + rz * ux;
  const need = R * (1 - sstep(R * 0.5, R + BEND_IN, Math.abs(a)));
  if (Math.abs(l) >= need) return out;
  const dl = (l > 0.02 ? 1 : l < -0.02 ? -1 : side) * need - l;
  out.x -= uz * dl; out.z += ux * dl;
  return out;
}
