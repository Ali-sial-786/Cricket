// Scripted players: synthetic head / bat / off-hand tracks for the shots a
// player makes in the headset, in the format the game logs them for replays
// (PlayerBodyView.log entries): { t, dt, bp, bq, head: { p, q }, off, extra }.
// Used by the unit tests (tests/shotSense.test.js, tests/playerBody.test.js)
// and by the headless harness, so the live solver and the replay re-solve
// are driven the same way. Pure JS (no three.js).
//
// World frame: the bowler is toward -Z, a right-hander faces +X (the off
// side); the bat's +Y runs up the handle, its +Z is the face.
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
// Quaternion of the rotation whose columns are x, y, z.
function quatOfBasis(x, y, z) {
  const m00 = x[0], m10 = x[1], m20 = x[2], m01 = y[0], m11 = y[1], m21 = y[2], m02 = z[0], m12 = z[1], m22 = z[2];
  const tr = m00 + m11 + m22;
  let qx, qy, qz, qw;
  if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); qw = 0.25 / s; qx = (m21 - m12) * s; qy = (m02 - m20) * s; qz = (m10 - m01) * s; }
  else if (m00 > m11 && m00 > m22) { const s = 2 * Math.sqrt(1 + m00 - m11 - m22); qw = (m21 - m12) / s; qx = 0.25 * s; qy = (m01 + m10) / s; qz = (m02 + m20) / s; }
  else if (m11 > m22) { const s = 2 * Math.sqrt(1 + m11 - m00 - m22); qw = (m02 - m20) / s; qx = (m01 + m10) / s; qy = 0.25 * s; qz = (m12 + m21) / s; }
  else { const s = 2 * Math.sqrt(1 + m22 - m00 - m11); qw = (m10 - m01) / s; qx = (m02 + m20) / s; qy = (m12 + m21) / s; qz = 0.25 * s; }
  return { x: qx, y: qy, z: qz, w: qw };
}
// The bat's orientation from where its toe points (from the hands) and roughly where its face looks.
export function batQuat(toe, face) {
  const y = norm([-toe[0], -toe[1], -toe[2]]);
  let z = [face[0], face[1], face[2]];
  const d = z[0] * y[0] + z[1] * y[1] + z[2] * y[2];
  z = [z[0] - d * y[0], z[1] - d * y[1], z[2] - d * y[2]];
  if (Math.hypot(z[0], z[1], z[2]) < 1e-3) z = cross(y, [1, 0, 0]);
  z = norm(z);
  return quatOfBasis(cross(y, z), y, z);
}
// The headset's orientation: yaw (rad, + = turned to the leg side... about +Y) and pitch (+ = up); 0, 0 looks down the pitch at the bowler (-Z).
export function headQuat(yaw, pitch) {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  return { x: cy * sp, y: sy * cp, z: -sy * sp, w: cy * cp };
}

// Non-uniform Catmull-Rom through keyed vectors (a held key = two keys with the same value: no overshoot).
function spline(keys, field, t) {
  const n = keys.length;
  if (t <= keys[0].t) return keys[0][field].slice();
  if (t >= keys[n - 1].t) return keys[n - 1][field].slice();
  let i = 0;
  while (i < n - 2 && t > keys[i + 1].t) i++;
  const k0 = keys[Math.max(0, i - 1)], k1 = keys[i], k2 = keys[i + 1], k3 = keys[Math.min(n - 1, i + 2)];
  const h = k2.t - k1.t, u = (t - k1.t) / h, out = [];
  for (let c = 0; c < k1[field].length; c++) {
    const p1 = k1[field][c], p2 = k2[field][c];
    let m1 = k1 === k0 ? 0 : (p2 - k0[field][c]) / (k2.t - k0.t), m2 = k3 === k2 ? 0 : (k3[field][c] - p1) / (k3.t - k1.t);
    if (k0 !== k1 && (p1 - k0[field][c]) * (p2 - p1) <= 0) m1 = 0;       // a turning point or a hold: come to rest
    if (k3 !== k2 && (p2 - p1) * (k3[field][c] - p2) <= 0) m2 = 0;
    const u2 = u * u, u3 = u2 * u;
    out.push((2 * u3 - 3 * u2 + 1) * p1 + (u3 - 2 * u2 + u) * h * m1 + (-2 * u3 + 3 * u2) * p2 + (u3 - u2) * h * m2);
  }
  return out;
}

// A small deterministic tracking jitter (mm / mrad), so nothing depends on perfectly clean input.
function jitter(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
}

// keys: [{ t, head: [x, y, z], look: [yaw, pitch], hand: [x, y, z] (the bottom hand = the controller),
//          toe: [..] (hands -> toe), face: [..], off: 'on' | [x, y, z] (the other controller) }]
// Missing fields carry over from the key before. Returns log entries at `hz`.
export function buildTrack(keys, { hz = 72, t0 = 100, noise = 1, extra = null, seed = 7 } = {}) {
  const K = [];
  let prev = { head: [-0.25, 1.56, -1.05], look: [0, -0.05], hand: [0.02, 0.8, -0.98], toe: [0.1, -0.95, 0.28], face: [0, 0, -1], off: 'on', offP: [0, 0, 0] };
  for (const k of keys) {
    const e = { ...prev, ...k };
    e.toe = norm(e.toe);
    e.onK = [e.off === 'on' ? 1 : 0];
    if (e.off !== 'on') e.offP = e.off;
    K.push(e); prev = e;
  }
  const rnd = jitter(seed), dt = 1 / hz, T = K[K.length - 1].t, out = [];
  for (let i = 0; i * dt <= T + 1e-9; i++) {
    const t = i * dt;
    const head = spline(K, 'head', t), look = spline(K, 'look', t), hand = spline(K, 'hand', t);
    const toe = norm(spline(K, 'toe', t)), face = spline(K, 'face', t);
    for (let c = 0; c < 3; c++) { head[c] += rnd() * 0.001 * noise; hand[c] += rnd() * 0.0015 * noise; toe[c] += rnd() * 0.004 * noise; }
    const bq = batQuat(toe, face);
    // the other hand: on the handle (a hand's width above the bottom hand) or where the key puts it
    const on = clamp(spline(K, 'onK', t)[0], 0, 1), offP = spline(K, 'offP', t);
    const ax = norm([-toe[0], -toe[1], -toe[2]]);
    const off = { x: (hand[0] + ax[0] * 0.105) * on + offP[0] * (1 - on) + rnd() * 0.0015 * noise, y: (hand[1] + ax[1] * 0.105) * on + offP[1] * (1 - on), z: (hand[2] + ax[2] * 0.105) * on + offP[2] * (1 - on) };
    out.push({ t: t0 + t, dt, bp: { x: hand[0], y: hand[1], z: hand[2] }, bq, head: { p: { x: head[0], y: head[1], z: head[2] }, q: headQuat(look[0], look[1]) }, off, ball: null, extra: typeof extra === 'function' ? extra(t) : extra });
  }
  return out;
}

// ---------------------------------------------------------------- the shots
// A player 1.73 m tall (eyes 1.62 m standing), taking guard astride the
// popping crease, head a little flexed in the stance.
const S = { head: [-0.25, 1.56, -1.05], look: [0, -0.05], hand: [0.02, 0.8, -0.98], toe: [0.1, -0.95, 0.28], face: [0, 0, -1] };
const stance = (t, o = {}) => ({ t, ...S, ...o });
const SIDE = [-0.45, 0.95, -1.0];            // the other controller down by the front hip (not on the handle)

export const SHOTS = {
  forward_defence: {
    want: ['forward_defence'], marks: [0.3, 0.95, 1.2, 1.42, 1.8, 2.8],
    keys: [stance(0), stance(0.6),
      { t: 0.95, head: [-0.24, 1.53, -1.15], hand: [0.03, 0.98, -0.86], toe: [0.2, 0.05, 0.98] },
      { t: 1.42, head: [-0.22, 1.44, -1.4], look: [0, -0.35], hand: [-0.02, 0.74, -1.6], toe: [0.02, -0.95, 0.3], face: [0, -0.3, -0.95] },
      { t: 2.1, head: [-0.22, 1.44, -1.4], look: [0, -0.35], hand: [-0.02, 0.74, -1.6], toe: [0.02, -0.95, 0.3], face: [0, -0.3, -0.95] },
      stance(2.8), stance(3.4)],
  },
  cover_drive: {
    want: ['cover_drive'], marks: [0.3, 1.0, 1.1, 1.2, 1.36, 1.55, 2.0, 3.0],
    keys: [stance(0), stance(0.6),
      { t: 1.0, head: [-0.24, 1.54, -1.12], hand: [0.05, 1.08, -0.8], toe: [0.3, 0.45, 0.84] },
      { t: 1.1, head: [-0.2, 1.5, -1.25], hand: [0.1, 1.0, -1.1], toe: [0.25, -0.35, 0.9] },
      { t: 1.2, head: [-0.16, 1.46, -1.36], look: [-0.2, -0.3], hand: [0.14, 0.8, -1.55], toe: [0.12, -0.98, -0.1], face: [0.3, 0, -0.95] },
      { t: 1.36, head: [-0.15, 1.47, -1.4], hand: [0.34, 1.2, -1.74], toe: [0.52, 0.45, -0.73], face: [0.3, 0.7, 0.6] },
      { t: 1.55, head: [-0.15, 1.5, -1.4], look: [-0.25, 0], hand: [0.24, 1.5, -1.6], toe: [0.3, 0.9, -0.3], face: [0.2, 0.3, 0.9] },
      { t: 2.2, head: [-0.15, 1.5, -1.4], look: [-0.25, 0], hand: [0.24, 1.5, -1.6], toe: [0.3, 0.9, -0.3], face: [0.2, 0.3, 0.9] },
      { t: 2.6, head: [-0.2, 1.53, -1.22], hand: [0.15, 1.05, -1.35], toe: [0.1, -0.2, -0.97], face: [0, 0.9, -0.3] },
      stance(3.0), stance(3.6)],
  },
  straight_drive: {
    want: ['straight_drive', 'lofted_drive'], marks: [0.3, 1.0, 1.1, 1.2, 1.36, 1.55, 2.0, 3.0],
    keys: [stance(0), stance(0.6),
      { t: 1.0, head: [-0.25, 1.54, -1.12], hand: [0.03, 1.08, -0.8], toe: [0.2, 0.45, 0.87] },
      { t: 1.1, head: [-0.25, 1.5, -1.25], hand: [0.0, 1.0, -1.1], toe: [0.12, -0.35, 0.93] },
      { t: 1.2, head: [-0.25, 1.46, -1.38], look: [0, -0.3], hand: [-0.06, 0.8, -1.55], toe: [0.02, -0.99, -0.1] },
      { t: 1.36, head: [-0.25, 1.47, -1.42], hand: [-0.1, 1.25, -1.85], toe: [0, 0.5, -0.86], face: [0, 0.8, 0.6] },
      { t: 1.55, head: [-0.25, 1.5, -1.42], look: [0, 0], hand: [-0.14, 1.5, -1.7], toe: [0, 0.94, -0.3], face: [0, 0.3, 0.95] },
      { t: 2.2, head: [-0.25, 1.5, -1.42], look: [0, 0], hand: [-0.14, 1.5, -1.7], toe: [0, 0.94, -0.3], face: [0, 0.3, 0.95] },
      { t: 2.6, head: [-0.25, 1.53, -1.22], hand: [-0.03, 1.05, -1.38], toe: [0.03, -0.2, -0.98], face: [0, 0.9, -0.3] },
      stance(3.0), stance(3.6)],
  },
  on_drive: {
    want: ['flick', 'straight_drive'], marks: [0.3, 1.0, 1.1, 1.2, 1.36, 1.55, 2.0, 3.0],
    keys: [stance(0), stance(0.6),
      { t: 1.0, head: [-0.25, 1.54, -1.12], hand: [0.03, 1.08, -0.8], toe: [0.2, 0.45, 0.87] },
      { t: 1.1, head: [-0.27, 1.5, -1.25], hand: [-0.05, 1.0, -1.1], toe: [0.1, -0.35, 0.93] },
      { t: 1.2, head: [-0.3, 1.47, -1.36], look: [0.2, -0.3], hand: [-0.22, 0.8, -1.52], toe: [-0.1, -0.98, -0.15], face: [-0.35, 0, -0.93] },
      { t: 1.36, head: [-0.31, 1.48, -1.4], hand: [-0.5, 1.2, -1.72], toe: [-0.45, 0.45, -0.77], face: [-0.5, 0.6, 0.6] },
      { t: 1.55, head: [-0.31, 1.5, -1.4], look: [0.3, 0], hand: [-0.52, 1.48, -1.5], toe: [-0.4, 0.9, -0.15], face: [-0.4, 0.2, 0.9] },
      { t: 2.2, head: [-0.31, 1.5, -1.4], look: [0.3, 0], hand: [-0.52, 1.48, -1.5], toe: [-0.4, 0.9, -0.15], face: [-0.4, 0.2, 0.9] },
      { t: 2.6, head: [-0.28, 1.53, -1.22], hand: [-0.2, 1.05, -1.3], toe: [-0.1, -0.2, -0.97], face: [0, 0.9, -0.3] },
      stance(3.0), stance(3.6)],
  },
  cut: {
    want: ['square_cut', 'late_cut'], marks: [0.3, 1.0, 1.1, 1.2, 1.32, 1.5, 2.0, 3.0],
    keys: [stance(0, { off: SIDE }), stance(0.6, { off: SIDE }),
      { t: 1.0, head: [-0.24, 1.58, -0.95], hand: [0.1, 1.3, -0.78], toe: [0.3, 0.6, 0.75], face: [0.3, 0.6, -0.7] },
      { t: 1.1, head: [-0.2, 1.57, -0.9], hand: [0.25, 1.2, -0.85], toe: [0.75, 0.2, 0.63], face: [0, 0.9, -0.3] },
      { t: 1.2, head: [-0.16, 1.55, -0.88], look: [-0.5, -0.15], hand: [0.36, 1.05, -1.0], toe: [0.97, -0.15, 0.1], face: [0, 0.5, -0.86] },
      { t: 1.32, head: [-0.16, 1.55, -0.88], hand: [0.28, 1.08, -1.25], toe: [0.55, -0.05, -0.83], face: [0.8, 0.3, 0.5] },
      { t: 1.5, head: [-0.17, 1.57, -0.9], look: [-0.7, 0], hand: [-0.02, 1.3, -1.32], toe: [-0.3, 0.45, -0.84], face: [0.9, 0.2, -0.3] },
      { t: 2.1, head: [-0.17, 1.57, -0.9], look: [-0.7, 0], hand: [-0.02, 1.3, -1.32], toe: [-0.3, 0.45, -0.84], face: [0.9, 0.2, -0.3] },
      { t: 2.55, head: [-0.2, 1.57, -0.97], hand: [0.0, 1.05, -1.15], toe: [0, -0.5, -0.86], face: [0, 0.86, -0.5] },
      stance(3.0, { off: SIDE }), stance(3.6, { off: SIDE })],
  },
  pull: {
    want: ['pull', 'hook'], marks: [0.3, 1.0, 1.1, 1.2, 1.32, 1.5, 2.0, 3.0],
    keys: [stance(0), stance(0.6),
      { t: 1.0, head: [-0.27, 1.58, -0.93], hand: [0.08, 1.28, -0.78], toe: [0.35, 0.5, 0.8], face: [0.3, 0.6, -0.7] },
      { t: 1.1, head: [-0.3, 1.57, -0.9], hand: [0.0, 1.25, -1.05], toe: [0.8, 0.25, 0.55], face: [0.2, 0.3, -0.93] },
      { t: 1.2, head: [-0.33, 1.56, -0.88], look: [0.2, -0.1], hand: [-0.2, 1.2, -1.42], toe: [0.93, 0.0, -0.36], face: [-0.35, 0.1, -0.93] },
      { t: 1.32, head: [-0.35, 1.56, -0.88], hand: [-0.58, 1.24, -1.25], toe: [-0.05, 0.1, -1.0], face: [-0.98, 0, 0.1] },
      { t: 1.5, head: [-0.36, 1.58, -0.9], look: [0.9, 0], hand: [-0.62, 1.38, -0.92], toe: [-0.85, 0.35, 0.4], face: [-0.4, 0, 0.92] },
      { t: 2.1, head: [-0.36, 1.58, -0.9], look: [0.9, 0], hand: [-0.62, 1.38, -0.92], toe: [-0.85, 0.35, 0.4], face: [-0.4, 0, 0.92] },
      stance(3.0), stance(3.6)],
  },
  hook: {
    want: ['hook', 'pull'], marks: [0.3, 1.0, 1.1, 1.2, 1.32, 1.5, 2.0, 3.0],
    keys: [stance(0), stance(0.6),
      { t: 1.0, head: [-0.27, 1.6, -0.9], hand: [0.1, 1.5, -0.72], toe: [0.35, 0.55, 0.76], face: [0.3, 0.6, -0.7] },
      { t: 1.1, head: [-0.32, 1.6, -0.86], hand: [0.02, 1.52, -1.0], toe: [0.8, 0.3, 0.5], face: [0.2, 0.3, -0.93] },
      { t: 1.2, head: [-0.37, 1.6, -0.84], look: [0.2, 0.15], hand: [-0.18, 1.55, -1.36], toe: [0.92, 0.2, -0.33], face: [-0.35, 0.1, -0.93] },
      { t: 1.32, head: [-0.4, 1.6, -0.84], hand: [-0.6, 1.58, -1.18], toe: [-0.05, 0.25, -0.97], face: [-0.98, 0, 0.1] },
      { t: 1.5, head: [-0.4, 1.61, -0.86], look: [1.1, 0.1], hand: [-0.66, 1.62, -0.85], toe: [-0.8, 0.4, 0.45], face: [-0.4, 0, 0.92] },
      { t: 2.1, head: [-0.4, 1.61, -0.86], look: [1.1, 0.1], hand: [-0.66, 1.62, -0.85], toe: [-0.8, 0.4, 0.45], face: [-0.4, 0, 0.92] },
      stance(3.0), stance(3.6)],
  },
  sweep: {
    want: ['sweep', 'slog_sweep'], marks: [0.3, 1.0, 1.25, 1.4, 1.52, 1.7, 2.2, 3.4],
    keys: [stance(0), stance(0.6),
      { t: 1.0, head: [-0.24, 1.42, -1.25], hand: [0.12, 1.0, -1.05], toe: [0.55, 0.45, 0.7], face: [0.3, 0.6, -0.7] },
      { t: 1.25, head: [-0.22, 1.14, -1.5], look: [0, -0.3], hand: [0.2, 0.75, -1.4], toe: [0.85, 0.1, 0.5], face: [0.2, 0.3, -0.93] },
      { t: 1.4, head: [-0.22, 1.1, -1.55], look: [0.1, -0.35], hand: [-0.02, 0.5, -1.8], toe: [0.8, -0.3, -0.52], face: [-0.5, 0, -0.86] },
      { t: 1.52, head: [-0.23, 1.1, -1.55], hand: [-0.42, 0.62, -1.68], toe: [-0.3, -0.1, -0.95], face: [-0.95, 0, 0.3] },
      { t: 1.7, head: [-0.24, 1.12, -1.53], look: [0.9, -0.1], hand: [-0.55, 0.95, -1.32], toe: [-0.85, 0.35, 0.4], face: [-0.4, 0, 0.9] },
      { t: 2.3, head: [-0.24, 1.12, -1.53], look: [0.9, -0.1], hand: [-0.55, 0.95, -1.32], toe: [-0.85, 0.35, 0.4], face: [-0.4, 0, 0.9] },
      stance(3.4), stance(4.0)],
  },
  back_foot_punch: {
    want: ['back_foot_punch', 'back_defence'], marks: [0.3, 1.0, 1.1, 1.2, 1.34, 1.9, 2.8],
    keys: [stance(0, { off: SIDE }), stance(0.6, { off: SIDE }),
      { t: 1.0, head: [-0.26, 1.6, -0.88], hand: [0.03, 1.12, -0.72], toe: [0.2, 0.3, 0.93] },
      { t: 1.1, head: [-0.26, 1.61, -0.85], hand: [0.0, 1.1, -0.9], toe: [0.1, -0.5, 0.86] },
      { t: 1.2, head: [-0.26, 1.61, -0.85], look: [0, -0.25], hand: [-0.03, 0.98, -1.12], toe: [0.02, -0.99, 0.1] },
      { t: 1.34, head: [-0.26, 1.61, -0.87], hand: [-0.04, 1.15, -1.38], toe: [0, -0.35, -0.94], face: [0, 0.94, -0.35] },
      { t: 2.0, head: [-0.26, 1.61, -0.87], hand: [-0.04, 1.15, -1.38], toe: [0, -0.35, -0.94], face: [0, 0.94, -0.35] },
      stance(2.8, { off: SIDE }), stance(3.4, { off: SIDE })],
  },
  leave: {
    want: [], marks: [0.3, 0.9, 1.2, 1.8, 2.8],
    keys: [stance(0), stance(0.6),
      { t: 0.85, head: [-0.23, 1.55, -1.12], hand: [0.02, 1.05, -0.9], toe: [0.2, 0.0, 0.98], face: [0.2, 0.6, -0.75] },
      { t: 1.1, head: [-0.2, 1.55, -1.22], look: [-0.3, -0.1], hand: [0.02, 1.32, -0.85], toe: [0.15, 0.9, 0.4], face: [0.3, 0.3, -0.9] },
      { t: 1.9, head: [-0.2, 1.55, -1.22], look: [-0.6, -0.2], hand: [0.02, 1.32, -0.85], toe: [0.15, 0.9, 0.4], face: [0.3, 0.3, -0.9] },
      { t: 2.35, head: [-0.23, 1.55, -1.12], look: [-0.2, -0.1], hand: [0.02, 1.05, -0.9], toe: [0.2, 0.0, 0.98], face: [0.2, 0.6, -0.75] },
      stance(2.8), stance(3.4)],
  },
  advance_drive: {
    want: ['straight_drive', 'lofted_drive', 'cover_drive'], marks: [0.3, 0.9, 1.2, 1.5, 1.72, 1.82, 2.0, 2.2, 2.8, 4.4],
    keys: [stance(0), stance(0.6),
      { t: 0.9, head: [-0.25, 1.57, -1.3], hand: [0.03, 1.0, -1.1], toe: [0.2, 0.2, 0.96] },
      { t: 1.2, head: [-0.25, 1.59, -1.85], hand: [0.03, 1.08, -1.6], toe: [0.2, 0.45, 0.87] },
      { t: 1.5, head: [-0.25, 1.57, -2.4], hand: [0.03, 1.1, -2.15], toe: [0.2, 0.5, 0.84] },
      { t: 1.72, head: [-0.25, 1.52, -2.62], hand: [0.03, 1.08, -2.36], toe: [0.2, 0.45, 0.87] },
      { t: 1.82, head: [-0.25, 1.49, -2.7], hand: [0.0, 1.0, -2.62], toe: [0.12, -0.35, 0.93] },
      { t: 1.92, head: [-0.25, 1.47, -2.76], look: [0, -0.3], hand: [-0.06, 0.8, -3.02], toe: [0.02, -0.99, -0.1] },
      { t: 2.08, head: [-0.25, 1.48, -2.78], hand: [-0.1, 1.25, -3.3], toe: [0, 0.5, -0.86], face: [0, 0.8, 0.6] },
      { t: 2.27, head: [-0.25, 1.5, -2.78], look: [0, 0.1], hand: [-0.14, 1.5, -3.15], toe: [0, 0.94, -0.3], face: [0, 0.3, 0.95] },
      { t: 2.9, head: [-0.25, 1.5, -2.78], look: [0, 0.1], hand: [-0.14, 1.5, -3.15], toe: [0, 0.94, -0.3], face: [0, 0.3, 0.95] },
      { t: 3.15, head: [-0.25, 1.55, -2.62], look: [0, 0], hand: [-0.05, 1.12, -2.8], toe: [0.05, -0.15, -0.99], face: [0, 0.9, -0.3] },
      { t: 3.4, head: [-0.25, 1.58, -2.4], look: [0, -0.1], hand: [0.05, 0.85, -2.3], toe: [0.1, -0.9, 0.4], face: [0, 0, -1] },
      { t: 4.4, head: [-0.25, 1.58, -1.15], hand: [0.03, 0.82, -1.05], toe: [0.1, -0.93, 0.33] },
      stance(4.8), stance(5.4)],
  },
  wild_slog: {
    want: ['slog_sweep', 'pull', 'hook', 'lofted_drive', 'flick'], marks: [0.3, 0.95, 1.03, 1.1, 1.18, 1.3, 1.8, 2.8],
    keys: [stance(0, { off: SIDE }), stance(0.6, { off: SIDE }),
      { t: 0.95, head: [-0.3, 1.6, -0.98], hand: [0.2, 1.62, -0.72], toe: [-0.1, 0.25, 0.96], face: [0.2, 0.9, -0.3] },
      { t: 1.03, head: [-0.3, 1.58, -1.05], hand: [0.15, 1.45, -1.0], toe: [0.75, 0.15, 0.65], face: [0.2, 0.6, -0.75] },
      { t: 1.1, head: [-0.32, 1.55, -1.12], look: [0.3, -0.2], hand: [-0.1, 0.98, -1.5], toe: [0.72, -0.62, -0.3], face: [-0.5, -0.2, -0.85] },
      { t: 1.18, head: [-0.38, 1.56, -1.12], hand: [-0.55, 1.15, -1.45], toe: [-0.35, 0.2, -0.92], face: [-0.9, 0.2, 0.35] },
      { t: 1.3, head: [-0.42, 1.6, -1.05], look: [1.2, 0.2], hand: [-0.62, 1.55, -0.98], toe: [-0.72, 0.5, 0.48], face: [-0.3, 0.2, 0.93] },
      { t: 1.9, head: [-0.42, 1.6, -1.05], look: [1.2, 0.2], hand: [-0.62, 1.55, -0.98], toe: [-0.72, 0.5, 0.48], face: [-0.3, 0.2, 0.93] },
      stance(2.8, { off: SIDE }), stance(3.4, { off: SIDE })],
  },
  // Between balls: tapping the bat, shuffling weight, looking round, a twirl, the bat up on the shoulder.
  waggle: {
    want: [], idle: true, marks: [0.3, 1.0, 1.9, 2.8, 3.6, 4.5, 5.4, 6.2],
    keys: [stance(0),
      { t: 0.5, head: [-0.23, 1.57, -1.02], hand: [0.03, 0.9, -0.95], toe: [0.15, -0.8, 0.58] },
      { t: 0.8, head: [-0.26, 1.56, -1.06], hand: [0.02, 0.8, -0.98], toe: [0.1, -0.95, 0.28] },
      { t: 1.1, head: [-0.24, 1.57, -1.03], hand: [0.03, 0.92, -0.94], toe: [0.15, -0.75, 0.64] },
      { t: 1.4, head: [-0.27, 1.56, -1.07], look: [0.5, -0.1], hand: [0.02, 0.8, -0.98], toe: [0.1, -0.95, 0.28] },
      { t: 2.0, head: [-0.3, 1.6, -1.0], look: [-0.8, 0.05], hand: [0.0, 1.0, -0.9], toe: [0.4, -0.6, 0.69], off: SIDE },
      { t: 2.6, head: [-0.2, 1.6, -1.12], look: [-0.3, -0.5], hand: [0.1, 1.2, -1.0], toe: [0.5, 0.8, 0.3], off: SIDE },
      { t: 3.2, head: [-0.22, 1.61, -1.1], look: [0.2, 0.0], hand: [-0.1, 1.35, -0.95], toe: [-0.3, 0.75, 0.59], off: [-0.5, 1.0, -1.1] },
      { t: 3.55, head: [-0.25, 1.6, -1.05], look: [0.1, -0.4], hand: [0.0, 1.05, -1.0], toe: [0.5, -0.1, 0.85], off: [-0.5, 0.95, -1.05] },
      { t: 3.9, head: [-0.27, 1.6, -1.0], look: [0, -0.7], hand: [0.05, 0.75, -1.1], toe: [0.3, -0.9, -0.3], off: [-0.5, 0.9, -1.0] },
      { t: 4.5, head: [-0.33, 1.58, -0.92], look: [0, -0.1], hand: [0.0, 0.85, -0.9], toe: [0.1, -0.9, 0.4], off: 'on' },
      { t: 5.2, head: [-0.2, 1.57, -1.12], hand: [0.03, 0.95, -1.0], toe: [0.2, -0.7, 0.68] },
      { t: 5.6, head: [-0.24, 1.56, -1.06], hand: [0.02, 0.8, -0.98], toe: [0.1, -0.95, 0.28] },
      { t: 5.9, head: [-0.25, 1.56, -1.05], hand: [0.03, 0.9, -0.95], toe: [0.15, -0.8, 0.58] },
      stance(6.2), stance(6.8)],
  },
  // Deep in the crease: standing almost on the stumps and going back to defend (the pads must stay out of them).
  deep_back: {
    want: ['back_defence', 'back_foot_punch'], stumps: true, marks: [0.3, 1.0, 1.25, 1.6, 2.6],
    keys: [stance(0, { head: [-0.12, 1.56, -0.45], hand: [0.12, 0.8, -0.38] }), stance(0.6, { head: [-0.12, 1.56, -0.45], hand: [0.12, 0.8, -0.38] }),
      { t: 1.0, head: [-0.1, 1.6, -0.22], hand: [0.12, 1.05, -0.2], toe: [0.2, 0.2, 0.96] },
      { t: 1.25, head: [-0.08, 1.6, -0.15], look: [0, -0.3], hand: [0.1, 0.95, -0.45], toe: [0.02, -0.97, 0.22], face: [0, -0.2, -0.97] },
      { t: 1.8, head: [-0.08, 1.6, -0.15], look: [0, -0.3], hand: [0.1, 0.95, -0.45], toe: [0.02, -0.97, 0.22], face: [0, -0.2, -0.97] },
      stance(2.6, { head: [-0.12, 1.56, -0.45], hand: [0.12, 0.8, -0.38] }), stance(3.2, { head: [-0.12, 1.56, -0.45], hand: [0.12, 0.8, -0.38] })],
  },
};

export function shotTrack(name, opts = {}) {
  const s = SHOTS[name];
  if (!s) throw new Error('no scripted shot ' + name);
  return buildTrack(s.keys, opts);
}
