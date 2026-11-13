// Leg before wicket (MCC Law 36), ball tracking, the DRS review rules and the
// on-field umpire's error model. Pure JS (no three.js), unit tested in node.
//
// Law 36.1: the striker is out LBW when the ball (not a no-ball) does not
// pitch outside the line of leg stump, hits the striker's person without
// having touched the bat first, the impact is between wicket and wicket (or
// outside the line of off stump if no genuine shot was offered) and, but for
// the interception, the ball would have hit the wicket.
//
// Frame (config.js): batting stumps at the origin, the ball travels +Z toward
// them, a right-hander's OFF side is +X and LEG side is -X.
//
// Zones and DRS margins (ICC playing conditions; wicket zone raised to the top
// of the bails in 2021). "Between wicket and wicket" is between the outer
// edges of the stumps, |x| <= wicketHalfWidth:
//   pitching  'outside_leg' when the ball's centre pitched beyond the line of
//             leg stump (x < -half), 'outside_off' likewise beyond off stump,
//             else 'in_line'. No umpire's call. A full toss is 'in_line' with
//             fullToss: true (the pitching rule does not apply).
//   impact    'in_line' with the centre inside the lines; 'umpires_call' with
//             the centre outside but part of the ball inside; otherwise
//             'outside_off' / 'outside_leg'.
//   wickets   zone = outer edges of the stumps, ground to the top of the
//             bails: 'hitting' with the centre inside, 'umpires_call' with
//             only part of the ball inside, else 'missing'. A 'hitting' is
//             downgraded to 'umpires_call' when the impact was 3 m or more
//             from the stumps, or 2.5 m or more with 40 cm or less between
//             pitching and impact (too far to predict with confidence).

import { predict, crossingAtZ } from '../physics/trajectory.js';
import { PITCH } from '../physics/pitch.js';
import { CONFIG } from '../config.js';

export const LBW = {
  far: 3.0,              // m from the stumps: 'hitting' becomes umpire's call
  farShort: 2.5,         // …or this far with…
  farShortPitch: 0.4,    // …this little travel between pitching and impact
  pathSamples: 20,       // points in the projected path
  marginalError: 2.6,    // umpire error multiplier on a close call
  clearError: 0.12,      // …and on a clear one
};

const zoneHalf = () => PITCH.wicketHalfWidth;
const zoneHeight = () => PITCH.stumpHeight + PITCH.bailRise;
const plain = (v) => (v ? { x: v.x, y: v.y, z: v.z } : null);

// Which side of the stump lines a centre at x is (margin widens the lines).
function side(x, margin) {
  const half = zoneHalf();
  if (x < -half - margin) return 'outside_leg';
  if (x > half + margin) return 'outside_off';
  return 'in_line';
}

// Ball (circle of radius r, centre x,y in the plane of the stumps) against the
// wicket rectangle. A plain expanded rectangle would wrongly call a ball that
// misses diagonally past the top corner "clipping".
export function wicketZone(x, y, r = CONFIG.ball.radius) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 'missing';
  const dx = Math.max(0, Math.abs(x) - zoneHalf());
  const dy = Math.max(0, -y, y - zoneHeight());
  if (dx === 0 && dy === 0) return 'hitting';
  return Math.hypot(dx, dy) <= r ? 'umpires_call' : 'missing';
}

// Share (0..1) of the ball's cross-section that lies inside the wicket zone.
export function fractionHitting(x, y, r = CONFIG.ball.radius) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || r <= 0) return 0;
  const half = zoneHalf(), top = zoneHeight();
  const N = 96;
  let area = 0;
  for (let i = 0; i < N; i++) {
    const u = -r + (i + 0.5) * (2 * r / N);
    const px = x + u;
    if (px < -half || px > half) continue;
    const h = Math.sqrt(r * r - u * u);
    const lo = Math.max(y - h, 0), hi = Math.min(y + h, top);
    if (hi > lo) area += (hi - lo) * (2 * r / N);
  }
  return Math.min(1, area / (Math.PI * r * r));
}

// Is this pad strike worth judging at all? `ball` is the BallState at the
// moment of the strike. (A no-ball or an edge first still gets tracked for
// the pictures; decisions take those as flags.)
export function isLbwCandidate(ball, { batFirst = false, noBall = false } = {}) {
  if (!ball || batFirst || noBall || ball.batted) return false;
  return ball.vel.z > 0.5 && ball.pos.z < PITCH.battingStumpsZ && ball.pos.z > PITCH.battingStumpsZ - 6;
}

// Ball tracking. impactState: BallState at the moment the ball struck the pad
// (pos = impact point; vel / spin as they were just BEFORE the deflection;
// bounces / firstBounce intact). pitchPos: where the delivery pitched, if the
// caller recorded it (default: impactState.firstBounce). The flight carries on
// with the real physics as if the batter were not there (swing, spin and any
// later bounce included, no random seam) to the plane of the stumps.
export function trackLbw({ impactState, pitchPos = null, cfg = CONFIG } = {}) {
  const r = cfg.ball.radius;
  const stumpsZ = PITCH.battingStumpsZ;
  const impactPos = plain(impactState.pos);

  let pitch = pitchPos || (impactState.bounces > 0 ? impactState.firstBounce : null);
  // Pitched level with or beyond the impact = it hit the batter on the full.
  const fullToss = !pitch || pitch.z > impactPos.z + 1e-6;
  pitch = fullToss ? null : { x: pitch.x, y: pitch.y ?? r, z: pitch.z };

  // Project on to the stumps.
  const state = impactState.clone();
  state.active = true;
  state.stopped = false;
  state.batted = false;
  state.hitWicket = false;
  let stumps = null;
  const path = [];
  if (impactPos.z >= stumpsZ) {
    stumps = { ...impactPos, t: 0 };
    path.push({ ...impactPos });
  } else {
    const pred = predict(state, {
      cfg, rng: null, maxTime: 4, sampleEvery: 0,
      stop: (b) => b.pos.z >= stumpsZ,
    });
    stumps = crossingAtZ(pred, stumpsZ);
    const s = pred.samples;
    const tEnd = stumps ? stumps.t : s[s.length - 1].t;
    // ~pathSamples points evenly in time, plus the exact bounce points.
    const n = LBW.pathSamples;
    const bounces = pred.bounces.filter((b) => b.t < tEnd);
    let bi = 0, j = 1;
    for (let k = 0; k < n; k++) {
      const t = tEnd * k / (n - 1);
      while (bi < bounces.length && bounces[bi].t <= t) path.push(plain(bounces[bi++].pos));
      while (j < s.length - 1 && s[j].t < t) j++;
      const a = s[j - 1], b = s[Math.min(j, s.length - 1)];
      const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
      path.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f });
    }
    path[0] = { ...impactPos };
    if (stumps) path[path.length - 1] = { x: stumps.x, y: stumps.y, z: stumpsZ };
  }

  const projectionValid = !!stumps;
  const stumpsPos = stumps ? { x: stumps.x, y: stumps.y } : { x: NaN, y: NaN };

  const pitching = fullToss ? 'in_line' : side(pitch.x, 0);
  const ax = Math.abs(impactPos.x), half = zoneHalf();
  const impact = ax <= half ? 'in_line' : ax <= half + r ? 'umpires_call' : side(impactPos.x, r);

  let wickets = wicketZone(stumpsPos.x, stumpsPos.y, r);
  // A long way from the stumps: the prediction is too uncertain to overturn.
  const distance = stumpsZ - impactPos.z;
  const pitchToImpact = fullToss ? Infinity : Math.hypot(pitch.x - impactPos.x, pitch.z - impactPos.z);
  if (wickets === 'hitting' && (distance >= LBW.far || (distance >= LBW.farShort && pitchToImpact <= LBW.farShortPitch))) {
    wickets = 'umpires_call';
  }

  return {
    pitching, fullToss, impact, wickets,
    pitchPos: pitch, impactPos, stumpsPos, path,
    fractionOfBallHitting: fractionHitting(stumpsPos.x, stumpsPos.y, r),
    distance, pitchToImpact, projectionValid,
  };
}

// The verdict rows the board shows: { label, text, colour }. green = the
// condition for OUT is met, red = it is not, amber = umpire's call.
export function verdictRows(track, { shotOffered = true, batFirst = false, noBall = false } = {}) {
  const rows = [];
  if (noBall) rows.push({ label: 'NO BALL', text: 'OVERSTEPPED', colour: 'red' });
  if (batFirst) rows.push({ label: 'BAT', text: 'BAT FIRST', colour: 'red' });

  if (track.fullToss) rows.push({ label: 'PITCHING', text: 'FULL TOSS', colour: 'green' });
  else {
    const text = { in_line: 'IN LINE', outside_off: 'OUTSIDE OFF', outside_leg: 'OUTSIDE LEG' }[track.pitching] || 'IN LINE';
    rows.push({ label: 'PITCHING', text, colour: track.pitching === 'outside_leg' ? 'red' : 'green' });
  }

  let colour = 'green', text = 'IN LINE';
  const offSide = (track.impactPos ? track.impactPos.x : 0) >= 0;
  if (track.impact === 'umpires_call') {
    // Clipping the off-side line with no shot offered still counts (Law 36).
    if (!shotOffered && offSide) text = 'OUTSIDE · NO SHOT';
    else { colour = 'amber'; text = "UMPIRE'S CALL"; }
  } else if (track.impact === 'outside_leg') {
    colour = 'red'; text = 'OUTSIDE LEG';
  } else if (track.impact === 'outside_off') {
    colour = shotOffered ? 'red' : 'green';
    text = shotOffered ? 'OUTSIDE OFF' : 'OUTSIDE · NO SHOT';
  }
  rows.push({ label: 'IMPACT', text, colour });

  const w = track.projectionValid === false ? 'missing' : track.wickets;
  rows.push({
    label: 'WICKETS',
    text: { hitting: 'HITTING', umpires_call: "UMPIRE'S CALL" }[w] || 'MISSING',
    colour: { hitting: 'green', umpires_call: 'amber' }[w] || 'red',
  });
  return rows;
}

// What ball tracking says on its own: 'out' | 'not_out' | 'umpires_call'
// (the on-field call stands).
export function lbwDecision(track, { shotOffered = true, batFirst = false, noBall = false } = {}) {
  if (!track) return 'not_out';
  const rows = verdictRows(track, { shotOffered, batFirst, noBall });
  if (rows.some((r) => r.colour === 'red')) return 'not_out';
  if (rows.some((r) => r.colour === 'amber')) return 'umpires_call';
  return 'out';
}

// The Law's own answer (a ball clipping the zone counts): the on-field
// umpire's yardstick before any error.
export function lawOut(track, opts = {}) {
  return lbwDecision(track, opts) !== 'not_out';
}

const REASONS = {
  'NO BALL': 'no-ball',
  BAT: 'bat first',
  PITCHING: 'pitched outside leg',
  WICKETS: 'missing the stumps',
};

// The review, by the ICC's rules: a decisive verdict against OUT (pitched
// outside leg, impact outside the line with a shot offered, missing, bat
// first, no-ball) is NOT OUT; otherwise any umpire's-call verdict leaves the
// on-field decision standing and the review is kept; otherwise OUT. The
// review is also kept when it overturned the decision, and lost otherwise.
export function reviewOutcome(track, { onFieldOut, shotOffered = true, batFirst = false, noBall = false } = {}) {
  const rows = verdictRows(track, { shotOffered, batFirst, noBall });
  const red = rows.filter((r) => r.colour === 'red');
  const amber = rows.filter((r) => r.colour === 'amber');
  let out, umpiresCall = false, reason;
  if (red.length) {
    out = false;
    reason = red.map((r) => (r.label === 'IMPACT'
      ? (track.impact === 'outside_leg' ? 'impact outside leg' : 'impact outside off, shot offered')
      : REASONS[r.label])).join(', ');
  } else if (amber.length) {
    out = !!onFieldOut;
    umpiresCall = true;
    reason = `umpire's call on ${amber.map((r) => r.label.toLowerCase()).join(' and ')}: on-field decision stands`;
  } else {
    out = true;
    reason = `${track.fullToss ? 'full toss' : 'pitching in line'}, ${shotOffered || track.impact === 'in_line' ? 'impact in line' : 'no shot offered'}, hitting the stumps`;
  }
  const overturned = out !== !!onFieldOut;
  return { out, umpiresCall, reviewKept: overturned || umpiresCall, overturned, reason, rows };
}

// A close one: any verdict in the umpire's-call zone, a ball pitching right on
// the line of leg stump, or one passing within a whisker of the zone's edges.
export function isMarginal(track) {
  if (!track) return false;
  if (track.impact === 'umpires_call' || track.wickets === 'umpires_call') return true;
  const half = zoneHalf();
  const p = track.pitchPos;
  if (p && Math.abs(p.x + half) < 0.06) return true;
  const s = track.stumpsPos;
  if (s && Number.isFinite(s.x) && (Math.abs(Math.abs(s.x) - half) < 0.05 || Math.abs(s.y - PITCH.stumpHeight) < 0.05)) return true;
  return false;
}

// The on-field umpire's answer to an appeal: true = OUT. The Law's answer
// (lawOut), wrong (1 - accuracy) x 2.6 of the time on a marginal call and
// x 0.12 on a clear one; an edge first is heard most of the time. rng: a
// function returning [0, 1). Optional givenRate (courtside's "lbw_given",
// 0.6 there): when set, a ball that IS out is given exactly that often
// instead, leaving good shouts for the bowling side to review.
export function umpireDecision(track, { shotOffered = true, batFirst = false, noBall = false, rng = Math.random, accuracy = 0.85, givenRate = null } = {}) {
  if (noBall) return false;
  const truth = lawOut(track, { shotOffered, batFirst, noBall });
  if (truth && givenRate != null) return rng() < Math.min(1, Math.max(0, givenRate));
  const base = 1 - Math.min(1, Math.max(0, accuracy));
  let wrong = base * (isMarginal(track) ? LBW.marginalError : LBW.clearError);
  if (batFirst) wrong *= 0.5;
  return rng() >= Math.min(0.95, Math.max(0, wrong)) ? truth : !truth;
}
