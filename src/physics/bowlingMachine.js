// Bowling machine: turns (pace, line, length, swing, seam, spin) settings into
// a launch state by solving for the release direction with the real physics
// (drag, swing, Magnus included), so "good length" really pitches where you
// asked. The same solver is used for the AI bowler and for player deliveries.
// Pure JS.

import { Vec3, clamp, kmhToMs, msToKmh } from './math.js';
import { BallState, aeroParams } from './ball.js';
import { firstBounce } from './trajectory.js';
import { PITCH } from './pitch.js';
import { CONFIG } from '../config.js';

const _zero = new Vec3();

// Solve the launch direction so the ball's first bounce lands on `target`
// ({x, z}). Returns { vel, error, bounce, iterations }.
export function solveLaunch({ releasePos, speed, target, spin = _zero, swing = 0, cfg = CONFIG, tol = 0.005, maxIter = 16 }) {
  const P = aeroParams(cfg);
  const st = new BallState();
  const dir = new Vec3();
  const evalDir = (el, az) => {
    st.reset();
    st.pos.copy(releasePos);
    dir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
    st.vel.copy(dir).scale(speed);
    st.spin.copy(spin);
    st.swing = swing;
    const hit = firstBounce(st, cfg, P, 5);
    return hit ? hit.pos : null;
  };

  const dx = target.x - releasePos.x, dz = target.z - releasePos.z;
  const dist = Math.hypot(dx, dz);
  let az = Math.atan2(dx, dz);
  const T = dist / Math.max(speed, 1);
  let el = Math.atan2(cfg.ball.radius - releasePos.y, dist) + 0.5 * cfg.physics.gravity * T / Math.max(speed, 1);
  el = clamp(el, -1.2, 0.9);

  let p = evalDir(el, az);
  let iterations = 0, err = Infinity;
  for (; iterations < maxIter; iterations++) {
    if (!p) { el -= 0.05; p = evalDir(el, az); continue; }
    const ex = target.x - p.x, ez = target.z - p.z;
    err = Math.hypot(ex, ez);
    if (err < tol) break;
    const de = 1e-3, da = 1e-3;
    const pe = evalDir(el + de, az);
    const pa = evalDir(el, az + da);
    if (!pe || !pa) { el -= 0.02; p = evalDir(el, az); continue; }
    const j00 = (pe.x - p.x) / de, j01 = (pa.x - p.x) / da;
    const j10 = (pe.z - p.z) / de, j11 = (pa.z - p.z) / da;
    const det = j00 * j11 - j01 * j10;
    if (Math.abs(det) < 1e-9) break;
    let dEl = (j11 * ex - j01 * ez) / det;
    let dAz = (-j10 * ex + j00 * ez) / det;
    dEl = clamp(dEl, -0.08, 0.08);
    dAz = clamp(dAz, -0.08, 0.08);
    el += dEl; az += dAz;
    p = evalDir(el, az);
  }
  if (p) err = Math.hypot(target.x - p.x, target.z - p.z);
  const vel = new Vec3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).scale(speed);
  return { vel, error: err, bounce: p ? p.clone() : null, iterations, elevation: el, azimuth: az };
}

// Spin vector (rad/s) for a delivery travelling along horizontal unit `travel`.
//  'none' = seamer (backspin), 'off' = off-break (turns into a RH batter),
//  'leg' = leg-break (turns away from a RH batter).
export function spinVector(type, amount, travel, cfg = CONFIG) {
  const top = new Vec3(travel.z, 0, -travel.x); // up x travel = topspin axis
  if (type === 'off' || type === 'leg') {
    const sgn = type === 'off' ? 1 : -1;
    const rate = clamp(amount, 0, 1) * cfg.machine.spinMaxRps * 2 * Math.PI;
    const w = new Vec3(travel.x * 0.8 * sgn, 0.15 * sgn, travel.z * 0.8 * sgn).addScaled(top, 0.5);
    return w.normalize().scale(rate);
  }
  return top.scale(-cfg.machine.seamerBackspinRps * 2 * Math.PI);
}

export const DEFAULT_MACHINE = {
  paceKmh: 130,
  line: 0.06,          // x at the batter's stumps (m): 0 = middle, +0.11 = off stump
  length: 6.5,         // bounce distance from the batter's stumps (m)
  swing: 0,            // -1 inswing … +1 outswing (RH batter)
  seam: 0,             // -1 nip back … +1 away off the seam
  spinType: 'none',    // 'none' | 'off' | 'leg'
  spinAmount: 0.7,
  release: 'over',     // 'over' | 'around'
  variation: 0,        // 0..1 random spread in pace/line/length
};

export const LENGTH_PRESETS = [
  { name: 'Yorker', length: 0.6 },
  { name: 'Full', length: 3.5 },
  { name: 'Good', length: 6.5 },
  { name: 'Back of length', length: 9.0 },
  { name: 'Short', length: 11.0 },
  { name: 'Bouncer', length: 12.5 },
];

export const LINE_PRESETS = [
  { name: 'Down leg', line: -0.32 },
  { name: 'Leg stump', line: -0.11 },
  { name: 'Middle', line: 0.0 },
  { name: 'Off stump', line: 0.11 },
  { name: '4th stump', line: 0.24 },
  { name: 'Wide of off', line: 0.45 },
];

// Pitch point on the straight line from the release point to the line
// target at the batter's stumps.
export function pitchPointFor(releasePos, line, length) {
  const zP = PITCH.battingStumpsZ - length;
  const xP = releasePos.x + (line - releasePos.x) * (zP - releasePos.z) / (PITCH.battingStumpsZ - releasePos.z);
  return { x: xP, z: zP };
}

// Full delivery from machine settings. `releasePos` optional override.
export function machineDelivery(settings, rng = null, cfg = CONFIG, releasePos = null) {
  const s = { ...DEFAULT_MACHINE, ...settings };
  const m = cfg.machine;
  const side = s.release === 'around' ? -1 : 1;
  const rel = releasePos ? releasePos.clone() : new Vec3(m.releaseX * side, m.releaseHeight, m.releaseZ);
  const v = rng ? clamp(s.variation, 0, 1) : 0;
  const pace = clamp(s.paceKmh + (v ? rng.gauss() * 4 * v : 0), 30, 165);
  const length = clamp(s.length + (v ? rng.gauss() * 1.0 * v : 0), 0.0, 14);
  const line = s.line + (v ? rng.gauss() * 0.08 * v : 0);
  const target = pitchPointFor(rel, line, length);
  const travel = new Vec3(target.x - rel.x, 0, target.z - rel.z).normalize();
  const spin = spinVector(s.spinType, s.spinAmount, travel, cfg);
  const swing = clamp(s.swing, -1, 1);
  const sol = solveLaunch({ releasePos: rel, speed: kmhToMs(pace), target, spin, swing, cfg });
  return {
    releasePos: rel,
    vel: sol.vel,
    spin,
    swing,
    seamDeg: clamp(s.seam, -1, 1) * cfg.surfaces.seamMaxDeg,
    paceKmh: msToKmh(sol.vel.length()),
    target,
    length,
    line,
    solverError: sol.error,
    spinType: s.spinType,
  };
}
