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
//  swing   the seam position you set before bowling (wrist turn or A / B)
// That is the "by feel" path. Normally a `choice` (a delivery key from the
// bowler's deliveryList, picked with A / B) decides the delivery outright and
// the wrist roll only scales the amount of spin / cut (never to nothing).
// With a `bowler` (see bowlerTypes.js) the pace is scaled into that bowler's
// range and only that bowler's deliveries come out. Without one the legacy
// rule applies: spin below spinnerPaceKmh, cutters above.
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
// paceScale: run-up momentum (1 = a full run, less from a standstill).
// choice: a delivery key picked from bowler.deliveryList (null = by feel).
// paceSpeed: the downswing hand speed that sets the pace (default: |handVel|).
// aimAzDeg: the direction you threw it (default: handVel's azimuth).
export function mapRelease({ releasePos, handVel, handAngVel, palmDir = null, swingChoice = 0, aim = null, assist = true, neutralElevDeg = null, rng = null, bowler = null, paceSpeed = null, aimAzDeg = null, choice = null, paceScale = 1, cfg = CONFIG }) {
  const B = cfg.bowling;
  const rel = clampReleasePos(releasePos);
  // Your hand is lower than a real bowler's arm at release: take most of the
  // height from the bowler type so short balls bounce like they should.
  if (bowler && bowler.releaseHeight) rel.y = rel.y + (bowler.releaseHeight - rel.y) * B.releaseBlend;
  const handSpeed = handVel.length();
  const effortSpeed = paceSpeed ?? handSpeed;
  let kmh;
  if (bowler) {
    // The quicker the downswing, the faster the ball, across the bowler's range.
    const v = effortSpeed * B.paceMultiplier / 2.6;
    const effort = clamp((v - B.effortHandSpeed[0]) / (B.effortHandSpeed[1] - B.effortHandSpeed[0]), 0, 1);
    kmh = bowler.pace[0] + (bowler.pace[1] - bowler.pace[0]) * Math.pow(effort, 0.85);
  } else kmh = clamp(handSpeed * B.paceMultiplier * 3.6, B.paceFloorKmh, B.paceCapKmh);

  const d = handVel.clone().normalize();
  const elevDeg = Math.asin(clamp(d.y, -1, 1)) / DEG;
  const azDeg = aimAzDeg ?? Math.atan2(d.x, d.z) / DEG;      // 0 = straight down the pitch (+Z)
  const maxLen = bowler && bowler.maxLength ? bowler.maxLength : B.lengthRange[1];
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
    length = clamp(aimLen + lenErr, B.lengthRange[0], maxLen);
    const tz = PITCH.battingStumpsZ - Math.max(0.3, length);
    target = { x: aim.x + lat, z: tz };
    line = rel.x + (target.x - rel.x) * toStumps / (target.z - rel.z);
  } else {
    const azMid = Math.atan2(0 - rel.x, toStumps) / DEG;
    const az = azMid + (azDeg - azMid) * B.lineGain;
    line = rel.x + Math.tan(az * DEG) * toStumps;
    length = clamp(B.neutralLength - dElev * B.lengthPerDeg, B.lengthRange[0], maxLen);
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
  let swing = 0, note = '';
  const maxRate = cfg.machine.spinMaxRps * 2 * Math.PI;
  const rolled = Math.abs(roll) > B.spinDeadzone ? clamp((Math.abs(roll) - B.spinDeadzone) * B.spinMultiplier / maxRate, 0, 1) : 0;
  const rollDir = rolled >= 0.08 ? (roll > 0 ? 'off' : 'leg') : null;     // clockwise = off-spin action
  const seamSet = clamp(swingChoice, -1, 1);
  if (bowler && choice) {
    // ---- a picked delivery: exactly that ball; the wrist only adds to it ----
    const amt = B.pickedSpinFloor + (1 - B.pickedSpinFloor) * rolled;
    const seamer = (set) => {                                           // swing / seam movement from a set seam
      swing = set * B.swingAmount * bowler.swing;
      seamDeg *= bowler.seam * (set ? 0.7 : 1.4);
      seamDeg += set * B.seamFromAngleDeg * bowler.seam * (rng ? 0.6 + 0.4 * rng() : 0.8);
    };
    switch (choice) {
      case 'offbreak': action = 'off'; spinType = 'off'; spinAmount = amt; name = 'off-break'; break;
      case 'doosra': action = 'off'; spinType = 'leg'; spinAmount = amt * 0.85; name = 'doosra'; break;
      case 'armball': action = 'off'; name = 'arm ball'; kmh = Math.min(bowler.pace[1], kmh * 1.06); swing = 0.3; break;
      case 'legbreak': action = 'leg'; spinType = 'leg'; spinAmount = amt; name = 'leg-break'; break;
      case 'googly': action = 'leg'; spinType = 'off'; spinAmount = amt * 0.85; name = 'googly'; break;
      case 'topspinner': action = 'leg'; spinType = 'top'; spinAmount = amt; name = 'top-spinner'; break;
      case 'slider': action = 'leg'; name = 'slider'; kmh = Math.min(bowler.pace[1], kmh * 1.05); break;
      case 'offcutter': case 'legcutter': {
        const dir = choice === 'offcutter' ? 'off' : 'leg';
        action = dir; spinType = dir; spinAmount = amt * 0.35;
        name = dir === 'off' ? 'off-cutter' : 'leg-cutter';
        seamDeg = seamDeg * bowler.seam + (dir === 'off' ? -1 : 1) * (0.8 + 1.7 * amt) * bowler.seam;
        kmh *= 0.93;
        break;
      }
      case 'slower': seamer(0); name = 'slower ball'; kmh *= 0.78; break;
      case 'outswinger': case 'awayseamer': seamer(1); name = choice === 'outswinger' ? 'outswinger' : 'away-seamer'; break;
      case 'inswinger': case 'inseamer': seamer(-1); name = choice === 'inswinger' ? 'inswinger' : 'in-seamer'; break;
      default: seamer(0); name = 'seam-up';                                // 'stock'
    }
    if (bowler.spinner) { seamDeg *= 0.5; action = bowler.action; }
    else kmh = clamp(kmh, bowler.pace[0] * 0.75, bowler.pace[1]);
  } else if (bowler && bowler.spinner) {
    // ---- a spinner: only this bowler's stock ball and variations ----
    action = bowler.action;
    const stock = bowler.action;                                         // 'off' | 'leg'
    if (backOfHand && rolled >= 0.08) {                                  // the wrong 'un
      spinType = stock === 'off' ? 'leg' : 'off';
      spinAmount = rolled * 0.85;
      name = stock === 'off' ? 'doosra' : 'googly';
    } else if (rollDir === stock) {
      spinType = stock; spinAmount = rolled;
      name = stock === 'off' ? 'off-break' : 'leg-break';
    } else if (stock === 'off') {                                        // no roll, or a leg-spinner's roll
      name = 'arm ball'; kmh = Math.min(bowler.pace[1], kmh * 1.06);
      swing = 0.3;                                                       // drifts on with the arm
      if (rollDir) note = 'An off-spinner cannot bowl a leg-break: arm ball';
    } else if (rollDir) {                                                // leg-spinner rolling it the off-spinner's way
      spinType = 'top'; spinAmount = rolled; name = 'top-spinner';
      note = 'A leg-spinner cannot bowl an off-break: top-spinner';
    } else {
      name = 'slider'; kmh = Math.min(bowler.pace[1], kmh * 1.05);
    }
    seamDeg *= 0.5;
  } else if (bowler) {
    // ---- a seamer: swing from the seam position, cutters from the wrist ----
    if (rollDir) {
      action = rollDir;
      spinType = rollDir; spinAmount = rolled * 0.35;
      name = rollDir === 'off' ? 'off-cutter' : 'leg-cutter';
      seamDeg = seamDeg * bowler.seam + (rollDir === 'off' ? -1 : 1) * (0.8 + 1.7 * rolled) * bowler.seam;
      kmh *= 0.93;
      swing = seamSet * B.swingAmount * bowler.swing * 0.3;
    } else {
      // The seam angle moves it both ways the same: swing in the air, and a nip
      // off the pitch when it lands on the seam.
      swing = seamSet * B.swingAmount * bowler.swing;
      seamDeg *= bowler.seam * (seamSet ? 0.7 : 1.4);                    // an upright seam wobbles about more
      seamDeg += seamSet * B.seamFromAngleDeg * bowler.seam * (rng ? 0.6 + 0.4 * rng() : 0.8);
      if (backOfHand) { name = 'slower ball'; kmh *= 0.78; swing *= 0.5; }
      else if (Math.abs(seamSet) > 0.1) name = bowler.swing >= bowler.seam ? (seamSet > 0 ? 'outswinger' : 'inswinger') : (seamSet > 0 ? 'away-seamer' : 'in-seamer');
    }
    kmh = clamp(kmh, bowler.pace[0] * 0.75, bowler.pace[1]);
  } else if (rollDir) {
    // ---- legacy: no bowler type ----
    spinAmount = rolled;
    action = rollDir;                                                    // the action: finger spin / wrist spin
    const turnsLike = backOfHand ? (action === 'off' ? 'leg' : 'off') : action;
    spinType = turnsLike;
    if (kmh < B.spinnerPaceKmh) {
      name = action === 'off' ? (backOfHand ? 'doosra' : 'off-break') : (backOfHand ? 'googly' : 'leg-break');
      if (backOfHand) spinAmount *= 0.85;                                // the wrong'un turns a little less
    } else {
      name = turnsLike === 'off' ? 'off-cutter' : 'leg-cutter';
      seamDeg += (turnsLike === 'off' ? -1 : 1) * (0.8 + 1.6 * spinAmount);
      spinAmount *= 0.35;
      kmh *= 0.93;                                                       // cutters come out a bit slower
    }
  } else {
    swing = seamSet * B.swingAmount;
    if (swing) name = swing > 0 ? 'outswinger' : 'inswinger';
  }
  kmh *= paceScale;
  const speed = kmhToMs(kmh);
  const spin = spinVector(spinType, spinAmount, travel, cfg);
  if (fullToss) name = `${name === 'seam-up' ? '' : name + ' '}full toss`.trim();
  else if (!(bowler && bowler.spinner) && (action === 'seam' || name.endsWith('cutter'))) {
    if (length < 2) name = `${name === 'seam-up' ? '' : name + ' '}yorker`.trim();
    else if (length > 11) name = `${name === 'seam-up' ? '' : name + ' '}bouncer`.trim();
  }

  return { releasePos: rel, speed, paceKmh: kmh, target, length, line, fullToss, spin, spinType, spinAmount, action, backOfHand: bowler && choice ? choice === 'doosra' || choice === 'googly' : backOfHand, name, choice: bowler ? choice : null, note, swing, seamDeg, handSpeed, elevDeg, azDeg, roll, palm };
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
