// The bowlers you can be. Pure JS.
//
// A bowler only bowls their own kind of delivery; the action decides which one:
//
//  FAST / MEDIUM-FAST
//    seam position   set before you bowl (turn the wrist, or A / B):
//                    seam to the slips = OUTSWINGER, to fine leg = INSWINGER,
//                    upright = SEAM-UP (a little natural movement off the pitch)
//    wrist roll      at release, clockwise     = OFF-CUTTER (seams IN to a right-hander)
//                                anticlockwise = LEG-CUTTER (seams AWAY)
//    back of hand    SLOWER BALL
//    Fast bowlers swing it more; medium-pacers get more off the seam.
//
//  OFF-SPIN          clockwise roll = OFF-BREAK; back of the hand = DOOSRA;
//                    no roll = ARM BALL (goes straight on, drifts away)
//  LEG-SPIN          anticlockwise roll = LEG-BREAK; back of the hand = GOOGLY;
//                    clockwise roll = TOP-SPINNER (dips and bounces, no turn);
//                    no roll = SLIDER (skids straight on)
//
// An off-spinner cannot bowl a leg-break and a leg-spinner cannot bowl an
// off-break or a doosra: the wrong roll just produces their straight one.

export const PLAYER_BOWLERS = {
  fast: {
    key: 'fast', label: 'Fast', spinner: false, pace: [118, 152], paceScale: 1.0, swing: 1.0, seam: 0.75,
    deliveries: 'seam-up · out-swinger · in-swinger · off-cutter · leg-cutter · slower ball',
  },
  medium: {
    key: 'medium', label: 'Medium-fast', spinner: false, pace: [100, 132], paceScale: 0.86, swing: 0.7, seam: 1.3,
    deliveries: 'seam-up · out-swinger · in-swinger · off-cutter · leg-cutter · slower ball',
  },
  offspin: {
    key: 'offspin', label: 'Off-spin', spinner: true, action: 'off', pace: [62, 98], paceScale: 0.62,
    deliveries: 'off-break · arm ball · doosra',
  },
  legspin: {
    key: 'legspin', label: 'Leg-spin', spinner: true, action: 'leg', pace: [60, 96], paceScale: 0.6,
    deliveries: 'leg-break · googly · top-spinner · slider',
  },
};

export const PLAYER_BOWLER_ORDER = ['fast', 'medium', 'offspin', 'legspin'];

export function playerBowler(key) { return PLAYER_BOWLERS[key] || PLAYER_BOWLERS.fast; }

export function nextBowler(key, dir = 1) {
  const i = PLAYER_BOWLER_ORDER.indexOf(key);
  const n = PLAYER_BOWLER_ORDER.length;
  return PLAYER_BOWLER_ORDER[((i < 0 ? 0 : i) + dir + n) % n];
}

// Seam position from how far the wrist has been turned (radians about the
// vertical, + = toward the slips for a right-handed batter): -1 (inswing) .. +1 (outswing).
export function seamFromWrist(yaw, { deadzone = 0.17, full = 0.55 } = {}) {
  const a = Math.abs(yaw);
  if (a <= deadzone) return 0;
  return Math.sign(yaw) * Math.min(1, (a - deadzone) / (full - deadzone));
}
