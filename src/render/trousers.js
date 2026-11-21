// Cricket trousers built at load, replacing the source's: its were tennis
// shorts lengthened into trousers, with a crotch hanging to the knees, a
// balloon of a seat and no taper. These are cut like modern playing
// trousers: a fitted seat, the thigh tapering to a straight lower leg, a
// little room at the knee, a clean break over the boot.
//
// Each leg is one tube of horizontal rings (bind space, the model faces +Z)
// round a centre that starts on the body's midline at the waist and moves
// out onto the leg's line below the crotch. Above the crotch each ring is
// wider than its half of the body and its inner part is pressed flat onto
// the midline plane (hidden inside), so the two tubes together make the
// seat and fork with no special joint. Skinned to the hips, thighs, shins
// and a little foot at the hem; the two tubes' midline points carry the same
// weights so the seam never opens. colour.g carries the angle round the leg
// (0 inner, 0.25 front, 0.5 outer side, 0.75 back) and colour.b the ring's
// radius, for the side stripe the shader draws.
import * as THREE from 'three';

const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
// piecewise-linear table lookup: rows [[y, v...], ...] sorted by y descending
function tab(rows, y, k) {
  if (y >= rows[0][0]) return rows[0][k];
  for (let i = 1; i < rows.length; i++) {
    if (y >= rows[i][0]) { const [y0] = rows[i - 1], [y1] = rows[i], t = (y - y0) / (y1 - y0), u = t * t * (3 - 2 * t) * 0.5 + t * 0.5; return mix(rows[i - 1][k], rows[i][k], u); }
  }
  return rows[rows.length - 1][k];
}

const Y_TOP = 1.1, Y_CROTCH = 0.835;
// Above the crotch: outer half-width, front z, back z (the seat).
const PELVIS = [[1.1, 0.15, 0.155, -0.052], [1.0, 0.165, 0.161, -0.074], [0.94, 0.172, 0.162, -0.092], [0.88, 0.177, 0.162, -0.1], [Y_CROTCH, 0.184, 0.165, -0.09]];
// Below: radius to the side, to the front, to the back (calf), and the centre's z offset from the leg line.
const LEG = [[Y_CROTCH, 0.096, 0.1275, 0.1275, 0.03], [0.78, 0.09, 0.108, 0.106, 0.022], [0.7, 0.082, 0.09, 0.087, 0.012], [0.6, 0.073, 0.077, 0.071, 0.006],
  [0.52, 0.068, 0.074, 0.064, 0.004], [0.44, 0.065, 0.068, 0.068, 0.003], [0.32, 0.063, 0.066, 0.066, 0.001], [0.2, 0.063, 0.071, 0.064, -0.004], [0.14, 0.065, 0.086, 0.066, -0.008]];
const HEM_BACK = 0.085, HEM_FRONT = 0.14;

export function buildTrousers(J, bones, lod) {
  const bi = (n) => bones.indexOf(n);
  const rows = lod ? [1.1, 1.0, 0.92, 0.855, 0.8, 0.7, 0.6, 0.52, 0.44, 0.32, 0.2, -1]
    : [1.1, 1.07, 1.03, 0.99, 0.95, 0.91, 0.88, 0.857, 0.838, 0.815, 0.785, 0.75, 0.71, 0.67, 0.63, 0.595, 0.565, 0.54, 0.515, 0.49, 0.46, 0.42, 0.37, 0.32, 0.27, 0.22, 0.18, -1];
  const n = lod ? 8 : 24;
  const pos = [], nrm = [], col = [], kit = [], si = [], sw = [], idx = [];
  const yC = Y_CROTCH;
  for (const s of [1, -1]) {
    const S = s > 0 ? 'L' : 'R', O = s > 0 ? 'R' : 'L';
    const hip = J['hip' + S], knee = J['knee' + S], ank = J['ankle' + S];
    const axis = (y) => (y >= knee.y ? hip.clone().lerp(knee, (hip.y - y) / (hip.y - knee.y)) : knee.clone().lerp(ank, (knee.y - y) / (knee.y - ank.y)));
    const axC = axis(yC);
    const ring0 = pos.length / 3;
    rows.forEach((yr, j) => {
      const hem = yr < 0;
      for (let i = 0; i <= n; i++) {
        const u = i / n, a = 1.5 * Math.PI + 2 * Math.PI * u, ca = Math.cos(a), sa = Math.sin(a);
        const y = hem ? mix(HEM_BACK, HEM_FRONT, (ca + 1) / 2) + 0.006 * Math.max(0, ca) * Math.max(0, ca) : yr;
        let cx, cz, rx, rzF, rzB;
        if (y >= yC) {
          const X = tab(PELVIS, y, 1), zF = tab(PELVIS, y, 2), zB = tab(PELVIS, y, 3);
          const cxa = 0.09 * sstep(1.02, yC, y);
          cx = s * cxa; rx = X - cxa; cz = (zF + zB) / 2; rzF = zF - cz; rzB = cz - zB;
        } else {
          const ax = axis(y), k = sstep(yC, yC - 0.13, y);
          cx = s * mix(0.09, Math.abs(ax.x), k);
          cz = mix((0.165 - 0.09) / 2, ax.z + tab(LEG, y, 4), sstep(yC, 0.6, y));
          rx = tab(LEG, y, 1); rzF = tab(LEG, y, 2); rzB = tab(LEG, y, 3);
          if (y < 0.3) { const ah = ank.x + s * 0.004; cx = s * mix(Math.abs(ah), Math.abs(cx), sstep(0.12, 0.3, y)); }
        }
        let x = cx + s * rx * sa, z = cz + (ca > 0 ? rzF : rzB) * ca;
        if (y > yC - 0.005 && s * x < 0) x = 0;                 // (inside: pressed onto the midline)
        pos.push(x, y, z);
        const nx = s * sa / rx, nz = ca / (ca > 0 ? rzF : rzB), nl = Math.hypot(nx, nz) || 1;
        nrm.push(nx / nl, 0, nz / nl);
        col.push(1, u, rx);
        // ambient occlusion: the fork, the seat crease, behind the knee, under the shirt's hem
        const inner = 1 - sstep(0.0, 0.05, s * x);
        let ao = 0.95 - 0.4 * inner * Math.exp(-Math.pow((y - yC - 0.01) / 0.06, 2));
        ao *= 1 - 0.15 * Math.max(0, -ca) * Math.exp(-Math.pow((y - yC) / 0.025, 2));
        ao *= 1 - 0.2 * Math.max(0, -ca) * Math.exp(-Math.pow((y - knee.y) / 0.04, 2));
        ao *= 1 - 0.3 * sstep(1.04, 1.09, y);
        kit.push(4, ao);
        // weights
        const t = sstep(hip.y + 0.06, yC - 0.03, y), mid = sstep(0, 0.06, s * x);
        let own = t * (0.5 + 0.5 * mid), other = t * 0.5 * (1 - mid);
        const keepOther = sstep(yC - 0.05, yC + 0.01, y);
        own += other * (1 - keepOther); other *= keepOther;
        const hipsW = 1 - t, kn = sstep(knee.y + 0.07, knee.y - 0.08, y), ft = 0.25 * sstep(0.2, 0.1, y) * kn;
        const W = [[bi('hips'), hipsW], [bi('hip' + S), own * (1 - kn)], [bi('hip' + O), other], [bi('knee' + S), own * kn - ft], [bi('ankle' + S), ft]]
          .filter((e) => e[1] > 1e-4).sort((p, q) => q[1] - p[1]).slice(0, 4);
        const sum = W.reduce((m, e) => m + e[1], 0) || 1;
        for (let k = 0; k < 4; k++) { si.push(W[k] ? W[k][0] : 0); sw.push(W[k] ? W[k][1] / sum : 0); }
      }
      if (j > 0) {
        const A = ring0 + (j - 1) * (n + 1), B = ring0 + j * (n + 1);
        for (let i = 0; i < n; i++) idx.push(A + i, B + i, A + i + 1, A + i + 1, B + i, B + i + 1);
      }
    });
    // the hem's turn-up: a short lining inside, so the opening has depth
    const H = ring0 + (rows.length - 1) * (n + 1), L0 = pos.length / 3;
    for (const [up, inset] of [[0.001, 0.003], [0.035, 0.005]]) {
      for (let i = 0; i <= n; i++) {
        const v = H + i, px = pos[v * 3], py = pos[v * 3 + 1], pz = pos[v * 3 + 2], cx = s * (Math.abs(ank.x) + 0.004), cz = ank.z;
        const dx = px - cx, dz = pz - cz, dl = Math.hypot(dx, dz) || 1;
        pos.push(px - dx / dl * inset, py + up, pz - dz / dl * inset); nrm.push(-dx / dl, 0, -dz / dl); col.push(1, 0, 0.06); kit.push(4, 0.45);
        for (let k = 0; k < 4; k++) { si.push(si[v * 4 + k]); sw.push(sw[v * 4 + k]); }
      }
    }
    for (let i = 0; i < n; i++) {
      idx.push(H + i, L0 + i, H + i + 1, H + i + 1, L0 + i, L0 + i + 1);
      idx.push(L0 + i, L0 + n + 1 + i, L0 + i + 1, L0 + i + 1, L0 + n + 1 + i, L0 + n + 2 + i);
    }
  }
  // wind every triangle to face along its vertices' normals
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const mx = nrm[a] + nrm[b] + nrm[c], my = nrm[a + 1] + nrm[b + 1] + nrm[c + 1], mz = nrm[a + 2] + nrm[b + 2] + nrm[c + 2];
    if (fx * mx + fy * my + fz * mz < 0) { const q = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = q; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('kit', new THREE.Float32BufferAttribute(kit, 2));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(si), 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  g.setIndex(idx);
  return g;
}
