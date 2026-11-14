// The bowlers you can be. Pure JS.
//
// A bowler only bowls their own kind of delivery; the action decides which one:
//
//  FAST / MEDIUM-FAST
//    seam position   set before you bowl (turn the wrist, or A / B):
//                    seam to the slips = moves AWAY (swings out in the air and
//                    nips away off the pitch), to fine leg = moves IN; upright
//                    = SEAM-UP (a little natural movement either way).
//                    Fast bowlers mostly swing it, medium-pacers mostly seam it.
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
//
// That is the "by feel" mode (Settings). Normally you PICK the delivery with
// A / B from each bowler's `deliveryList` (first = stock ball); the wrist roll
// then only adds a little extra spin / cut. Effects are for a right-handed batter.

export const PLAYER_BOWLERS = {
  fast: {
    key: 'fast', label: 'Fast', spinner: false, pace: [118, 152], paceScale: 1.0, swing: 1.0, seam: 0.75, releaseHeight: 2.2, maxLength: 12.0,
    deliveries: 'seam-up · out-swinger · in-swinger · off-cutter · leg-cutter · slower ball',
    deliveryList: [
      { key: 'stock', label: 'Seam-up', effect: 'Upright seam: straight, nips a little either way' },
      { key: 'outswinger', label: 'Out-swinger', effect: 'Swings away from the batter, to the slips' },
      { key: 'inswinger', label: 'In-swinger', effect: 'Swings in toward the pads and stumps' },
      { key: 'offcutter', label: 'Off-cutter', effect: 'Cuts back in off the pitch, a bit slower' },
      { key: 'legcutter', label: 'Leg-cutter', effect: 'Cuts away off the pitch, a bit slower' },
      { key: 'slower', label: 'Slower ball', effect: 'Much slower: the batter plays too early' },
    ],
  },
  medium: {
    key: 'medium', label: 'Medium-fast', spinner: false, pace: [100, 132], paceScale: 0.86, swing: 0.6, seam: 1.4, releaseHeight: 2.1, maxLength: 11.5,
    deliveries: 'seam-up · away-seamer · in-seamer · off-cutter · leg-cutter · slower ball',
    deliveryList: [
      { key: 'stock', label: 'Seam-up', effect: 'Upright seam: hits the deck, nips either way' },
      { key: 'awayseamer', label: 'Away-seamer', effect: 'Seams away off the pitch, swings a little' },
      { key: 'inseamer', label: 'In-seamer', effect: 'Seams back in off the pitch, toward the pads' },
      { key: 'offcutter', label: 'Off-cutter', effect: 'Cuts back in off the pitch, a bit slower' },
      { key: 'legcutter', label: 'Leg-cutter', effect: 'Cuts away off the pitch, a bit slower' },
      { key: 'slower', label: 'Slower ball', effect: 'Much slower: the batter plays too early' },
    ],
  },
  offspin: {
    key: 'offspin', label: 'Off-spin', spinner: true, action: 'off', pace: [62, 98], paceScale: 0.62, releaseHeight: 1.95, maxLength: 10.5,
    deliveries: 'off-break · arm ball · doosra',
    deliveryList: [
      { key: 'offbreak', label: 'Off-break', effect: 'Turns in from off stump toward the pads' },
      { key: 'armball', label: 'Arm ball', effect: 'Quicker, no turn: drifts on with the arm' },
      { key: 'doosra', label: 'Doosra', effect: 'Off-spin action, turns AWAY from the bat' },
    ],
  },
  legspin: {
    key: 'legspin', label: 'Leg-spin', spinner: true, action: 'leg', pace: [60, 96], paceScale: 0.6, releaseHeight: 1.9, maxLength: 10.5,
    deliveries: 'leg-break · googly · top-spinner · slider',
    deliveryList: [
      { key: 'legbreak', label: 'Leg-break', effect: 'Turns away from the bat, to the off side' },
      { key: 'googly', label: 'Googly', effect: "Leg-spin action, turns IN: the wrong 'un" },
      { key: 'topspinner', label: 'Top-spinner', effect: 'No turn: dips late and bounces higher' },
      { key: 'slider', label: 'Slider', effect: 'Quicker, skids straight on, stays low' },
    ],
  },
};

export const PLAYER_BOWLER_ORDER = ['fast', 'medium', 'offspin', 'legspin'];

export function playerBowler(key) { return PLAYER_BOWLERS[key] || PLAYER_BOWLERS.fast; }

// The picked delivery `dir` steps along the bowler's list (wraps round).
export function stepDelivery(bowler, key, dir = 1) {
  const L = bowler.deliveryList, n = L.length;
  const i = L.findIndex((d) => d.key === key);
  return L[((i < 0 ? 0 : i) + dir + n) % n].key;
}
export function deliveryInfo(bowler, key) { return bowler.deliveryList.find((d) => d.key === key) || bowler.deliveryList[0]; }

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
