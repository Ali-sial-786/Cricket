// Player bowling: turn the hand motion at trigger release into a delivery.
// Pure JS.
//
//  pace   = peak hand speed × paceMultiplier (capped)
//  line   = release azimuth (compressed by lineGain around "straight at the stumps")
//  length = release elevation relative to a neutral angle (lengthPerDeg)
//  assist = with the aim marker on, errors are scaled by (1 - assistStrength)
//           around the marker instead of around a good-length/middle default
//  spin   = wrist roll (controller angular velocity about the travel direction)
//  swing  = chosen with buttons (seamers only)
// The resulting pitch point is fed to the same launch solver as the machine,
// so the ball always obeys the real physics.

import { Vec3, clamp, kmhToMs, msToKmh, DEG } from '../physics/math.js';
import { PITCH, bowlingPoppingZ } from '../physics/pitch.js';
import { pitchPointFor, spinVector, solveLaunch } from '../physics/bowlingMachine.js';
import { CONFIG } from '../config.js';

export function clampReleasePos(p) {
  return new Vec3(
    clamp(p.x, -1.25, 1.25),
    clamp(p.y, 1.0, 2.7),
    clamp(p.z, PITCH.bowlingStumpsZ - 0.6, bowlingPoppingZ + 0.35),
  );
}

// Inputs: releasePos (world Vec3), handVel (world Vec3, m/s), handAngVel
// (world Vec3, rad/s), swingChoice (-1 in, 0 none, +1 out), aim ({x,z} or
// null), assist (bool), neutralElevDeg (optional override), rng (optional).
export function mapRelease({ releasePos, handVel, handAngVel, swingChoice = 0, aim = null, assist = true, neutralElevDeg = null, rng = null, cfg = CONFIG }) {
  const B = cfg.bowling;
  const rel = clampReleasePos(releasePos);
  const handSpeed = handVel.length();
  const kmh = clamp(handSpeed * B.paceMultiplier * 3.6, B.paceFloorKmh, B.paceCapKmh);
  const speed = kmhToMs(kmh);

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
    target = { x: aim.x + lat, z: PITCH.battingStumpsZ - length };
    line = rel.x + (target.x - rel.x) * toStumps / (target.z - rel.z);
  } else {
    const azMid = Math.atan2(0 - rel.x, toStumps) / DEG;
    const az = azMid + (azDeg - azMid) * B.lineGain;
    line = rel.x + Math.tan(az * DEG) * toStumps;
    length = clamp(B.neutralLength - dElev * B.lengthPerDeg, B.lengthRange[0], B.lengthRange[1]);
    target = pitchPointFor(rel, line, length);
  }

  // Wrist roll → spin.
  const travel = new Vec3(target.x - rel.x, 0, target.z - rel.z).normalize();
  const roll = handAngVel ? handAngVel.dot(travel) : 0;
  let spinType = 'none', spinAmount = 0;
  if (Math.abs(roll) > B.spinDeadzone) {
    const maxRate = cfg.machine.spinMaxRps * 2 * Math.PI;
    spinAmount = clamp((Math.abs(roll) - B.spinDeadzone) * B.spinMultiplier / maxRate, 0, 1);
    spinType = roll > 0 ? 'off' : 'leg';
    if (spinAmount < 0.08) { spinType = 'none'; spinAmount = 0; }
  }
  const spin = spinVector(spinType, spinAmount, travel, cfg);
  const swing = spinType === 'none' ? clamp(swingChoice, -1, 1) * B.swingAmount : 0;
  const seamDeg = rng ? rng.gauss() * B.naturalSeamDeg : 0;

  return { releasePos: rel, speed, paceKmh: kmh, target, length, line, spin, spinType, spinAmount, swing, seamDeg, handSpeed, elevDeg, azDeg, roll };
}

// Full delivery (launch velocity solved with physics).
export function playerDelivery(args) {
  const m = mapRelease(args);
  const sol = solveLaunch({ releasePos: m.releasePos, speed: m.speed, target: m.target, spin: m.spin, swing: m.swing, cfg: args.cfg || CONFIG });
  return { ...m, vel: sol.vel, solverError: sol.error, paceKmh: msToKmh(sol.vel.length()) };
}
