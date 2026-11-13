// Player bowling: turn the arm action at trigger release into a delivery.
// Pure JS. Nothing is picked from a menu — the motion decides:
//
//  pace    how fast the hand comes over (peak hand speed x paceMultiplier, capped)
//  line    the direction of the hand at release
//  length  WHEN you let go: early in the arc the hand is still travelling up
//          and forward -> full (very early = full toss); late it is coming
//          down -> short (very late = bouncer)
//  spin    wrist roll about the line of flight at release, and which way the
//          hand faces:
//            clockwise roll, palm to the batter        -> OFF-BREAK  (turns in to a RH batter)
//            clockwise roll, back of hand to the batter -> DOOSRA    (off-spin action, turns away)
//            anticlockwise roll, palm to the batter     -> LEG-BREAK (turns away)
//            anticlockwise roll, back of the hand       -> GOOGLY    (leg-spin action, turns in)
//          at seam-bowling pace the same actions give off- and leg-cutters
//  swing   chosen with the A / B buttons for seam-up deliveries
// The resulting pitch point goes to the same launch solver as the machine, so
// every ball obeys the real physics.

import { Vec3, clamp, kmhToMs, msToKmh, DEG } from '../physics/math.js';
import { PITCH, bowlingPoppingZ } from '../physics/pitch.js';
import { pitchPointFor, spinVector, solveLaunch, solveThrough } from '../physics/bowlingMachine.js';
import { CONFIG } from '../config.js';

export function clampReleasePos(p) {
  return new Vec3(
    clamp(p.x, -1.25, 1.25),
    clamp(p.y, 1.0, 2.7),
    clamp(p.z, PITCH.bowlingStumpsZ - 0.6, bowlingPoppingZ + 0.35),
  );
}

// Inputs: releasePos, handVel, handAngVel (world), palmDir (world unit vector
// out of the palm, optional), swingChoice (-1 in, 0, +1 out), aim ({x,z} or
// null), assist, neutralElevDeg (optional), rng (optional).
export function mapRelease({ releasePos, handVel, handAngVel, palmDir = null, swingChoice = 0, aim = null, assist = true, neutralElevDeg = null, rng = null, cfg = CONFIG }) {
  const B = cfg.bowling;
  const rel = clampReleasePos(releasePos);
  const handSpeed = handVel.length();
  let kmh = clamp(handSpeed * B.paceMultiplier * 3.6, B.paceFloorKmh, B.paceCapKmh);

  const d = handVel.clone().normalize();
  const elevDeg = Math.asin(clamp(d.y, -1, 1)) / DEG;
  const azDeg = Math.atan2(d.x, d.z) / DEG;      // 0 = straight down the pitch (+Z)
  const neutral = neutralElevDeg ?? B.neutralElevationDeg;
  const dElev = elevDeg - neutral;

  let target, length, line;
  const toStumps = PITCH.battingStumpsZ - rel.z;
  if (assist && aim) {
    const scale = 1 - clamp(B.assistStrength, 0, 1);
    const azAim = Math.atan2(aim.x - rel.x, aim.z - rel.z) / DEG;
    const dist = Math.hypot(aim.x - rel.x, aim.z - rel.z);
    const lat = Math.tan((azDeg - azAim) * B.lineGain * DEG) * dist * scale;
    const lenErr = -dElev * B.lengthPerDeg * scale;
    const aimLen = PITCH.battingStumpsZ - aim.z;
    length = clamp(aimLen + lenErr, B.lengthRange[0], B.lengthRange[1]);
    const tz = PITCH.battingStumpsZ - Math.max(0.3, length);
    target = { x: aim.x + lat, z: tz };
    line = rel.x + (target.x - rel.x) * toStumps / (target.z - rel.z);
  } else {
    const azMid = Math.atan2(0 - rel.x, toStumps) / DEG;
    const az = azMid + (azDeg - azMid) * B.lineGain;
    line = rel.x + Math.tan(az * DEG) * toStumps;
    length = clamp(B.neutralLength - dElev * B.lengthPerDeg, B.lengthRange[0], B.lengthRange[1]);
    target = pitchPointFor(rel, line, Math.max(0.3, length));
  }
  // Released very early: a full toss, higher the earlier it was let go.
  let fullToss = null;
  if (length < 0.3) {
    const k = clamp((0.3 - length) / (0.3 - B.lengthRange[0]), 0, 1);
    const z = PITCH.battingStumpsZ - PITCH.poppingOffset;
    fullToss = { x: rel.x + (line - rel.x) * (z - rel.z) / toStumps, y: B.fullTossHeight[0] + (B.fullTossHeight[1] - B.fullTossHeight[0]) * k, z };
  }

  // Wrist action -> spin.
  const travel = new Vec3(target.x - rel.x, 0, target.z - rel.z).normalize();
  const roll = handAngVel ? handAngVel.dot(travel) : 0;
  const palm = palmDir ? palmDir.dot(travel) : 1;
  const backOfHand = palm < -B.palmDot;
  let spinType = 'none', spinAmount = 0, action = 'seam', name = 'seam-up', seamDeg = rng ? rng.gauss() * B.naturalSeamDeg : 0;
  if (Math.abs(roll) > B.spinDeadzone) {
    const maxRate = cfg.machine.spinMaxRps * 2 * Math.PI;
    spinAmount = clamp((Math.abs(roll) - B.spinDeadzone) * B.spinMultiplier / maxRate, 0, 1);
    if (spinAmount >= 0.08) {
      action = roll > 0 ? 'off' : 'leg';                       // the action: finger spin / wrist spin
      const turnsLike = backOfHand ? (action === 'off' ? 'leg' : 'off') : action;
      spinType = turnsLike;
      if (kmh < B.spinnerPaceKmh) {
        name = action === 'off' ? (backOfHand ? 'doosra' : 'off-break') : (backOfHand ? 'googly' : 'leg-break');
        if (backOfHand) spinAmount *= 0.85;                    // the wrong'un turns a little less
      } else {
        name = turnsLike === 'off' ? 'off-cutter' : 'leg-cutter';
        seamDeg += (turnsLike === 'off' ? -1 : 1) * (0.8 + 1.6 * spinAmount);
        spinAmount *= 0.35;
        kmh *= 0.93;                                           // cutters come out a bit slower
      }
    } else spinAmount = 0;
  }
  const speed = kmhToMs(kmh);
  const spin = spinVector(spinType, spinAmount, travel, cfg);
  const swing = action === 'seam' ? clamp(swingChoice, -1, 1) * B.swingAmount : 0;
  if (action === 'seam' && swing) name = swing > 0 ? 'outswinger' : 'inswinger';
  if (fullToss) name = `${name === 'seam-up' ? '' : name + ' '}full toss`.trim();
  else if (action === 'seam' || name.endsWith('cutter')) {
    if (length < 2) name = `${name === 'seam-up' ? '' : name + ' '}yorker`.trim();
    else if (length > 11) name = `${name === 'seam-up' ? '' : name + ' '}bouncer`.trim();
  }

  return { releasePos: rel, speed, paceKmh: kmh, target, length, line, fullToss, spin, spinType, spinAmount, action, backOfHand, name, swing, seamDeg, handSpeed, elevDeg, azDeg, roll, palm };
}

// Full delivery (launch velocity solved with physics).
export function playerDelivery(args) {
  const m = mapRelease(args);
  const cfg = args.cfg || CONFIG;
  const sol = m.fullToss
    ? solveThrough({ releasePos: m.releasePos, speed: m.speed, at: m.fullToss, spin: m.spin, swing: m.swing, cfg })
    : solveLaunch({ releasePos: m.releasePos, speed: m.speed, target: m.target, spin: m.spin, swing: m.swing, cfg });
  return { ...m, vel: sol.vel, solverError: sol.error, paceKmh: msToKmh(sol.vel.length()) };
}
