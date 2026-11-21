// The playing surface, built for Quest 3S: the outfield (one big mesh), the
// pitch (with its crease markings drawn in its shader), the boundary cushion
// and the 30-yard discs (one mesh). Two texture fetches per pixel on both big
// surfaces, no loops or noise in the shaders.
//
//   turf: a 2048^2 macro map over the whole ground (colour variation, the
//     cross-cut, the square and its old strips, worn run-ups, the pale ring
//     inside the rope, sprinkler heads and slit drains, and the late-afternoon
//     shadow of the stands and floodlight towers as stadium.js builds them, baked) + one tiling
//     blade-detail texture. The mowing stripes are drawn by the shader (no
//     texture), filtered against the pixel's footprint, and shaded by view
//     direction as real ones are: light looking down the mower's line, dark
//     looking back up it, gone from side on.
//   pitch: a 512x2048 map (roll marks, cracks, footholes, scuffs, a green
//     tinge at the edges; its alpha is "how grassy") + the same detail
//     texture's clay channel; creases as analytic, box-filtered lines, crisp
//     at the batter's feet and steady (no shimmer) from the far end.
import * as THREE from 'three';
import { PITCH } from '../physics/pitch.js';
import { CONFIG } from '../config.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { flatIrradiance, shadeRatio, standShade, SHADOW_X, SHADOW_Z } from './lighting.js';
import { SUN_BLOCKERS } from './stadium.js';

const CZ = PITCH.centerZ;
const MACRO_N = 2048, MACRO_S = 172;                 // texels, metres (the square the macro map covers, centred on the pitch)
const DETAIL_N = 512, DETAIL_TILE = 0.8;            // the detail tile repeats every 0.8 m (~1.6 mm a texel)
const DETAIL_ROT = 0.33;                            // rad: the tile's grid does not line up with stripes or creases
const STRIP_W = 3.2;                                // the square's strips (= the live strip's width)
const SQ_HALF_W = PITCH.stripHalfWidth + 4 * STRIP_W, SQ_Z0 = PITCH.stripMinZ - 1.5, SQ_Z1 = PITCH.stripMaxZ + 1.5;
// The pitch mesh: the strip plus a band of square grass all round (the popping creases reach past the strip).
const PM_HALF_W = 1.95, PM_Z0 = PITCH.stripMinZ - 0.35, PM_Z1 = PITCH.stripMaxZ + 0.35;
const STRIPE_W = 3.2;                               // outfield mowing stripes (the pitch sits in the middle of one)

// Square grass round the live strip: the pitch map's border and the macro map
// under it are exactly this colour, so the two meshes meet without a seam.
const SQUARE = [122, 169, 85];

function mulberry(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

function canvas2d(w, h, read = false) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d', read ? { willReadFrequently: true } : undefined)];
}

function dataTexture(data, w, h, { srgb = true, repeat = false, aniso = 4 } = {}) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

// Soft blob in canvas units.
function blob(g, x, y, rx, ry, c, a, rot = 0) {
  g.save();
  g.translate(x, y); g.rotate(rot); g.scale(1, ry / rx);
  const gr = g.createRadialGradient(0, 0, 0, 0, 0, rx);
  gr.addColorStop(0, rgb(c, a)); gr.addColorStop(1, rgb(c, 0));
  g.fillStyle = gr;
  g.beginPath(); g.arc(0, 0, rx, 0, Math.PI * 2); g.fill();
  g.restore();
}

// ------------------------------------------------------------------ detail
// One 512^2 tile, linear data: R = grass blades (mean 0.5), G = clay grain and
// hairline crazing (mean ~0.5), B = whitewash coverage for the creases.
// Only fine features (< ~1.5 cm), so the 0.8 m repeat never shows as a grid.
// Splatted straight into typed arrays (a canvas would need every stroke drawn
// nine times to wrap): ~20 ms.
function detailTexture() {
  const N = DETAIL_N, M = N - 1, q = mulberry(5);
  const R = new Float32Array(N * N), G = new Float32Array(N * N), B = new Float32Array(N * N).fill(0.92);
  // Bilinear splat with wrap-around.
  const splat = (A, x, y, v) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const i0 = x0 & M, i1 = (x0 + 1) & M, j0 = (y0 & M) * N, j1 = ((y0 + 1) & M) * N;
    A[j0 + i0] += v * (1 - fx) * (1 - fy); A[j0 + i1] += v * fx * (1 - fy);
    A[j1 + i0] += v * (1 - fx) * fy; A[j1 + i1] += v * fx * fy;
  };
  const line = (A, x, y, a, l, v, w = 1) => {
    const dx = Math.cos(a) * 0.5, dy = Math.sin(a) * 0.5, px = -dy * 1.2, py = dx * 1.2;
    for (let t = 0; t < l; t += 0.5) {
      const fade = 1 - (t / l) * 0.5;
      splat(A, x, y, v * fade);
      if (w > 1.4) splat(A, x + px, y + py, v * fade * 0.6);
      x += dx; y += dy;
    }
  };
  // Blades: short strokes (top-down grass), light tips and dark gaps.
  for (let i = 0; i < 24000; i++) {
    const lt = q() < 0.5;
    line(R, q() * N, q() * N, q() * Math.PI * 2, 3 + q() * 9, (lt ? 1 : -1) * (0.12 + q() * 0.22), 0.8 + q() * 1.4);
  }
  // Clay: grain, small stones, a fine crazing of hairline cracks.
  for (let i = 0; i < 40000; i++) splat(G, q() * N, q() * N, (q() < 0.5 ? 1 : -1) * (0.2 + q() * 0.35));
  for (let i = 0; i < 260; i++) {
    const x = q() * N, y = q() * N, rr = 1 + q() * 2.5, v = 0.15 + q() * 0.25;
    for (let dy = -rr; dy <= rr; dy += 0.7) for (let dx = -rr; dx <= rr; dx += 0.7) if (dx * dx + dy * dy < rr * rr) splat(G, x + dx, y + dy, v * 0.4);
  }
  for (let i = 0; i < 70; i++) {
    let x = q() * N, y = q() * N, a = q() * Math.PI * 2;
    for (let s = 0; s < 8; s++) { a += (q() - 0.5) * 1.3; const l = 6 + q() * 10; line(G, x, y, a, l, -0.45); x += Math.cos(a) * l; y += Math.sin(a) * l; }
  }
  // Whitewash: mostly solid, thin in soft patches, grainy.
  for (let i = 0; i < 160; i++) {
    const cx = q() * N, cy = q() * N, rr = 8 + q() * 26, v = 0.28 * q();
    for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++) {
      const d = (dx * dx + dy * dy) / (rr * rr);
      if (d < 1) B[(((cy + dy) | 0) & M) * N + (((cx + dx) | 0) & M)] -= v * (1 - d) * (1 - d);
    }
  }
  for (let i = 0; i < 9000; i++) splat(B, q() * N, q() * N, -0.35 * q());
  const out = new Uint8Array(N * N * 4);
  const u8 = (v) => (v < 0 ? 0 : v > 1 ? 255 : v * 255) | 0;
  for (let i = 0; i < N * N; i++) { out[i * 4] = u8(0.5 + R[i]); out[i * 4 + 1] = u8(0.5 + G[i]); out[i * 4 + 2] = u8(B[i]); out[i * 4 + 3] = 255; }
  return dataTexture(out, N, N, { srgb: false, repeat: true, aniso: 4 });
}

// ------------------------------------------------------------------ turf macro map
// Canvas in metres: x right, z down (row = texture v: uploaded unflipped).
function macroTexture() {
  const N = MACRO_N, S = MACRO_S, k = N / S, r = mulberry(31);
  const R = CONFIG.field.boundaryRadius;
  const OUT = [94, 155, 70];
  // The soft, large features go on a quarter-size canvas (16x less to fill), scaled up after.
  const L = 512, kl = L / S, [lc, g0] = canvas2d(L, L);
  let g = g0;
  g.setTransform(kl, 0, 0, kl, (S / 2) * kl, (S / 2 - CZ) * kl);
  g.fillStyle = rgb(OUT); g.fillRect(-S, CZ - S, 2 * S, 2 * S);
  // Large-scale variation: lusher, drier and bluer patches tens of metres across.
  for (let i = 0; i < 80; i++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 84, rr = 6 + r() * 24;
    const col = [[135, 169, 81], [70, 136, 62], [84, 143, 96], [122, 164, 74]][i % 4];
    blob(g, Math.sin(a) * d, CZ + Math.cos(a) * d, rr, rr * (0.6 + r() * 0.6), col, 0.10 + r() * 0.08, r() * 3);
  }
  // Mid-scale mottling (0.5..3 m): what the eye reads between the blades and the patches.
  for (let i = 0; i < 2600; i++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 86, rr = 0.5 + r() * 2.5;
    blob(g, Math.sin(a) * d, CZ + Math.cos(a) * d, rr, rr * (0.5 + r() * 0.5), r() < 0.5 ? [130, 172, 81] : [65, 125, 59], 0.10 + r() * 0.08, r() * 3);
  }
  // The cross-cut: faint bands across the stripes (the mower's second pass), 4.8 m wide.
  for (let z = CZ - S / 2 - 2.4; z < CZ + S / 2; z += 9.6) {
    g.fillStyle = 'rgba(255,255,230,0.03)'; g.fillRect(-S, z, 2 * S, 4.8);
    g.fillStyle = 'rgba(0,20,0,0.035)'; g.fillRect(-S, z + 4.8, 2 * S, 4.8);
  }
  // The pale ring inside the rope (fielders' and stewards' traffic, drier).
  {
    const gr = g.createRadialGradient(0, CZ, R - 9, 0, CZ, R - 0.2);
    gr.addColorStop(0, rgb([140, 172, 90], 0)); gr.addColorStop(0.7, rgb([140, 172, 90], 0.28)); gr.addColorStop(1, rgb([146, 172, 93], 0.36));
    g.fillStyle = gr; g.beginPath(); g.arc(0, CZ, R - 0.2, 0, Math.PI * 2); g.fill();
    // Beyond the rope: a duller apron, and a dark contact line where the cushion sits.
    g.save(); g.beginPath(); g.arc(0, CZ, S, 0, Math.PI * 2); g.arc(0, CZ, R + 0.15, 0, Math.PI * 2, true); g.fillStyle = rgb([78, 131, 65], 0.55); g.fill('evenodd'); g.restore();
  }
  // Bowlers' run-ups beyond each end of the square: worn, sandier, wider near the crease.
  for (const [z0, dir] of [[SQ_Z1 - 0.5, 1], [SQ_Z0 + 0.5, -1]]) {
    for (let i = 0; i < 60; i++) {
      const t = r(), zz = z0 + dir * t * 24, w = 1.6 - t * 0.9;
      blob(g, (r() - 0.5) * w, zz, 0.6 + r() * 1.2, 0.8 + r() * 1.6, [173, 164, 112], (0.20 - t * 0.16) * (0.6 + r() * 0.6));
    }
    blob(g, 0, z0 + dir * 1.2, 2.4, 3.2, [167, 161, 108], 0.22);
  }
  // Keeper's and slips' standing spots behind the batting end.
  blob(g, 0.2, PITCH.battingStumpsZ + 4.0, 1.2, 1.0, [159, 164, 102], 0.20);
  for (let i = 0; i < 4; i++) blob(g, 2.6 + i * 1.3, PITCH.battingStumpsZ + 5.5 + i * 0.6, 0.8, 0.7, [151, 164, 99], 0.14);
  for (let i = 0; i < 80; i++) {                       // sprinklers' wetter, lusher circles
    const x = -64 + (i % 9) * 16 + 8, z = CZ - 64 + Math.floor(i / 9) * 16 + 4;
    if (Math.hypot(x, z - CZ) < R - 3 && !(Math.abs(x) < SQ_HALF_W + 2 && z > SQ_Z0 - 2 && z < SQ_Z1 + 2)) blob(g, x, z, 2.2, 2.2, [59, 128, 59], 0.22);
  }

  // Full size: the soft layer, then everything with an edge.
  const [c, gb] = canvas2d(N, N);
  gb.imageSmoothingEnabled = true; gb.imageSmoothingQuality = 'high';
  gb.drawImage(lc, 0, 0, N, N);
  g = gb;
  g.setTransform(k, 0, 0, k, (S / 2) * k, (S / 2 - CZ) * k);
  g.lineWidth = 0.55; g.strokeStyle = rgb([38, 64, 34], 0.55); g.beginPath(); g.arc(0, CZ, R - 0.02, 0, Math.PI * 2); g.stroke();
  // Slit drains: faint sandy lines on a diagonal every 6 m, and sprinkler heads
  // (a dark cap; their wet circles are in the soft layer) on a 16 m grid.
  g.save();
  g.beginPath(); g.arc(0, CZ, R - 1, 0, Math.PI * 2); g.clip();
  g.lineWidth = 0.09; g.strokeStyle = rgb([173, 179, 124], 0.10);
  for (let o = -130; o < 130; o += 6) { g.beginPath(); g.moveTo(o - 60, CZ - 90); g.lineTo(o + 60, CZ + 90); g.stroke(); }
  g.restore();
  for (let x = -64; x <= 64; x += 16) for (let z = -64; z <= 64; z += 16) {
    const sx = x + 8, sz = CZ + z + 4;
    if (Math.hypot(sx, sz - CZ) > R - 3 || (Math.abs(sx) < SQ_HALF_W + 2 && sz > SQ_Z0 - 2 && sz < SQ_Z1 + 2)) continue;
    g.fillStyle = rgb([84, 92, 87], 0.6); g.beginPath(); g.arc(sx, sz, 0.09, 0, Math.PI * 2); g.fill();
  }
  // The square: short, paler, yellower grass, a soft edge to the outfield.
  {
    g.save();
    g.shadowColor = rgb(SQUARE, 1); g.shadowBlur = 0.8 * k; g.fillStyle = rgb(SQUARE);
    g.fillRect(-SQ_HALF_W, SQ_Z0, SQ_HALF_W * 2, SQ_Z1 - SQ_Z0);
    g.restore();
    // Its old strips: each a little different (regrown, recently used and worn,
    // the next one being prepared), with ghost creases and repaired footholes.
    const looks = { '-4': [126, 172, 87], '-3': [116, 166, 81], '-2': [130, 172, 90], '-1': [135, 170, 93], '1': [115, 166, 81], '2': [128, 172, 88], '3': [119, 168, 84], '4': [127, 170, 88] };
    for (let s = -4; s <= 4; s++) {
      if (s === 0) continue;
      const x0 = s > 0 ? PITCH.stripHalfWidth + (s - 1) * STRIP_W : -PITCH.stripHalfWidth + (s + 1) * STRIP_W - STRIP_W, xm = x0 + STRIP_W / 2;
      // Keep the side next to the live strip plain near the pitch mesh's edge (no seam there).
      const col = Math.abs(s) === 1 ? SQUARE : looks[s];
      g.fillStyle = rgb(col); g.fillRect(x0 + (Math.abs(s) === 1 ? 0 : 0.03), PITCH.stripMinZ, STRIP_W - 0.06, PITCH.stripMaxZ - PITCH.stripMinZ);
      if (Math.abs(s) === 1) {
        // The neighbours: their far halves carry the wear.
        const far = xm + Math.sign(s) * 0.5;
        g.fillStyle = rgb(looks[s], 0.9); g.fillRect(far - 0.8, PITCH.stripMinZ, 1.6, PITCH.stripMaxZ - PITCH.stripMinZ);
      }
      g.strokeStyle = rgb([94, 133, 71], 0.25); g.lineWidth = 0.06;
      g.beginPath(); g.moveTo(x0, PITCH.stripMinZ); g.lineTo(x0, PITCH.stripMaxZ); g.stroke();
      const used = s === -1 || s === 2 || s === -3;
      if (used) {
        // Where the ball and the batters' feet went: a straw line down the middle, worn most at the ends.
        const ex = Math.abs(s) === 1 ? xm + Math.sign(s) * 0.5 : xm;
        g.fillStyle = rgb([165, 166, 108], s === -1 ? 0.45 : 0.25); g.fillRect(ex - 0.55, PITCH.stripMinZ + 0.5, 1.1, PITCH.stripMaxZ - PITCH.stripMinZ - 1);
      }
      for (const [sz, dir] of [[PITCH.battingStumpsZ, -1], [PITCH.bowlingStumpsZ, 1]]) {
        const ex = Math.abs(s) === 1 ? xm + Math.sign(s) * 0.5 : xm;
        if (used) {
          // Ghost creases and the repaired, re-seeded foot holes.
          g.strokeStyle = 'rgba(235,235,225,0.13)'; g.lineWidth = 0.05;
          g.beginPath(); g.moveTo(ex - 1.1, sz + dir * PITCH.poppingOffset); g.lineTo(ex + 1.1, sz + dir * PITCH.poppingOffset); g.stroke();
          for (const fx of [-0.45, 0.45]) blob(g, ex + fx, sz + dir * (PITCH.poppingOffset + 0.3), 0.32, 0.45, [162, 125, 96], 0.55);
          blob(g, ex, sz + dir * 0.6, 0.7, 0.9, [176, 161, 121], 0.3);
        } else blob(g, ex, sz + dir * 0.8, 0.6, 0.9, [162, 172, 108], 0.18);
      }
    }
    // Plain square grass all round the pitch mesh.
    g.fillStyle = rgb(SQUARE); g.fillRect(-PM_HALF_W - 0.4, PM_Z0 - 0.6, (PM_HALF_W + 0.4) * 2, PM_Z1 - PM_Z0 + 1.2);
  }
  // The stands' and towers' shadow: multiplied in by the cool shade colour (sky light only).
  const M = 256, mask = shadowMask(M), shade = shadeRatio();
  const [mc, mg] = canvas2d(M, M), img = mg.createImageData(M, M);
  const sr = Math.pow(shade.r, 1 / 2.2), sg = Math.pow(shade.g, 1 / 2.2), sb = Math.pow(shade.b, 1 / 2.2);
  for (let i = 0; i < M * M; i++) {
    const m = mask[i];
    img.data[i * 4] = 255 * (1 + (sr - 1) * m); img.data[i * 4 + 1] = 255 * (1 + (sg - 1) * m); img.data[i * 4 + 2] = 255 * (1 + (sb - 1) * m); img.data[i * 4 + 3] = 255;
  }
  mg.putImageData(img, 0, 0);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'multiply';
  g.drawImage(mc, 0, 0, N, N);
  g.globalCompositeOperation = 'source-over';
  // (No read-back: the canvas goes up as it is. The mowing stripes are drawn by the shader.)
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = false;
  t.anisotropy = 4;
  return t;
}

// The stands' and the floodlight towers' shadow over the macro map's square
// (M x M, 0..1), from the bowl as stadium.js builds it (SUN_BLOCKERS): the
// lattice masts as dappled tapering lines, their lamp heads as solid plates.
function shadowMask(M) {
  const S = MACRO_S, out = new Float32Array(M * M);
  const P = (p) => [p[0] + p[1] * SHADOW_X, CZ + p[2] + p[1] * SHADOW_Z];     // a local point -> its shadow on the turf (world)
  const towers = SUN_BLOCKERS.towers.map((tw) => {
    const [bx, bz] = P([tw.cx, tw.y0, tw.cz]), [tx, tz] = P([tw.cx, tw.H, tw.cz]);
    const quad = tw.head.map(P);
    const xs = [bx, tx, ...quad.map((q) => q[0])], zs = [bz, tz, ...quad.map((q) => q[1])];
    // Head edges as (point, inward normal): a convex quad, either winding.
    const area = quad.reduce((acc, q, k) => { const n = quad[(k + 1) % 4]; return acc + q[0] * n[1] - n[0] * q[1]; }, 0), w = area > 0 ? 1 : -1;
    const edges = quad.map((q, k) => { const n = quad[(k + 1) % 4], ex = n[0] - q[0], ez = n[1] - q[1], l = Math.hypot(ex, ez) || 1; return [q[0], q[1], (-ez / l) * w, (ex / l) * w]; });
    return { bx, bz, tx, tz, h0: tw.half0, h1: tw.half1, edges, x0: Math.min(...xs) - 4, x1: Math.max(...xs) + 4, z0: Math.min(...zs) - 4, z1: Math.max(...zs) + 4 };
  });
  for (let j = 0; j < M; j++) {
    const z = (j + 0.5) / M * S - S / 2 + CZ;
    for (let i = 0; i < M; i++) {
      const x = (i + 0.5) / M * S - S / 2;
      let s = standShade(x, z, CZ);
      for (const t of towers) {
        if (x < t.x0 || x > t.x1 || z < t.z0 || z > t.z1) continue;
        // Mast: light through the lattice, so a broken, half-dark band.
        const ex = t.tx - t.bx, ez = t.tz - t.bz, L2 = ex * ex + ez * ez;
        const h = Math.min(1, Math.max(0, ((x - t.bx) * ex + (z - t.bz) * ez) / L2));
        const d = Math.hypot(x - t.bx - ex * h, z - t.bz - ez * h), w = t.h0 + (t.h1 - t.h0) * h;
        s = Math.max(s, smooth(w + 0.3, w - 0.3, d) * (0.38 + 0.14 * Math.cos(h * 88)));
        // Lamp head: the backing plate, solid; ~75 m up, so a soft (penumbra) edge.
        let in_ = Infinity;
        for (const [qx, qz, nx, nz] of t.edges) in_ = Math.min(in_, (x - qx) * nx + (z - qz) * nz);
        s = Math.max(s, smooth(-0.9, 0.9, in_) * 0.72);
      }
      out[j * M + i] = s;
    }
  }
  return out;
}

// ------------------------------------------------------------------ pitch map
// Canvas in metres (x right, z down), 512 x 2048 over x +-1.95, z PM_Z0..PM_Z1.
function pitchTexture() {
  const W = 512, H = 2048, kx = W / (PM_HALF_W * 2), kz = H / (PM_Z1 - PM_Z0), r = mulberry(17);
  const [, g] = canvas2d(W, H, true), [, g2] = canvas2d(W, H, true);
  for (const q of [g, g2]) q.setTransform(kx, 0, 0, kz, PM_HALF_W * kx, -PM_Z0 * kz);
  const X0 = -PITCH.stripHalfWidth, X1 = PITCH.stripHalfWidth, Z0 = PITCH.stripMinZ, Z1 = PITCH.stripMaxZ;
  // Border: square grass. Strip: straw clay.
  g.fillStyle = rgb(SQUARE); g.fillRect(-3, PM_Z0 - 1, 6, PM_Z1 - PM_Z0 + 2);
  g2.fillStyle = '#fff'; g2.fillRect(-3, PM_Z0 - 1, 6, PM_Z1 - PM_Z0 + 2);
  const CLAY = [204, 184, 136];
  g.fillStyle = rgb(CLAY); g.fillRect(X0, Z0, X1 - X0, Z1 - Z0);
  g2.fillStyle = 'rgb(28,28,28)'; g2.fillRect(X0, Z0, X1 - X0, Z1 - Z0);
  g.save(); g.beginPath(); g.rect(X0, Z0, X1 - X0, Z1 - Z0); g.clip(); g2.save(); g2.beginPath(); g2.rect(X0, Z0, X1 - X0, Z1 - Z0); g2.clip();
  // A greener tinge toward the edges (more live grass left on).
  for (const s of [-1, 1]) {
    const gr = g.createLinearGradient(s * X1, 0, s * (X1 - 0.55), 0);
    gr.addColorStop(0, rgb([140, 164, 96], 0.85)); gr.addColorStop(0.35, rgb([162, 166, 108], 0.4)); gr.addColorStop(1, rgb([162, 166, 108], 0));
    g.fillStyle = gr; g.fillRect(s > 0 ? X1 - 0.55 : X0, Z0, 0.55, Z1 - Z0);
    const g2r = g2.createLinearGradient(s * X1, 0, s * (X1 - 0.55), 0);
    g2r.addColorStop(0, 'rgb(170,170,170)'); g2r.addColorStop(1, 'rgba(170,170,170,0)');
    g2.fillStyle = g2r; g2.fillRect(s > 0 ? X1 - 0.55 : X0, Z0, 0.55, Z1 - Z0);
  }
  // Roller passes: three lengthwise bands, and the mower's finer lines.
  for (let i = 0; i < 3; i++) { g.fillStyle = i % 2 ? 'rgba(255,250,235,0.07)' : 'rgba(70,55,30,0.05)'; g.fillRect(X0 + i * (X1 - X0) / 3, Z0, (X1 - X0) / 3, Z1 - Z0); }
  for (let i = 0; i < 12; i++) { g.fillStyle = i % 2 ? 'rgba(255,255,240,0.035)' : 'rgba(60,50,30,0.03)'; g.fillRect(X0 + i * (X1 - X0) / 12, Z0, (X1 - X0) / 12, Z1 - Z0); }
  // Patchy colour: drier and damper areas, sparse live and dead grass.
  for (let i = 0; i < 220; i++) blob(g, X0 + r() * (X1 - X0), Z0 + r() * (Z1 - Z0), 0.15 + r() * 0.5, 0.3 + r() * 1.2, r() < 0.5 ? [214, 196, 150] : [172, 150, 104], 0.18 + r() * 0.12);
  for (let i = 0; i < 9000; i++) {
    const x = X0 + r() * (X1 - X0), z = Z0 + r() * (Z1 - Z0), live = r() < 0.45;
    g.fillStyle = live ? rgb([128, 158, 80], 0.35 + r() * 0.3) : rgb([168, 156, 100], 0.4);
    g.fillRect(x, z, 0.006 + r() * 0.01, 0.01 + r() * 0.025);
    if (live) { g2.fillStyle = 'rgba(200,200,200,0.5)'; g2.fillRect(x, z, 0.012, 0.03); }
  }
  // Cracks: short, angular, joining into loose polygons; more in the middle
  // third where the pitch is driest; a lighter crumbled lip on one side.
  g.lineCap = 'round'; g.lineJoin = 'miter';
  for (let i = 0; i < 420; i++) {
    let x = X0 + 0.25 + r() * (X1 - X0 - 0.5), z = Z0 + 1 + r() * (Z1 - Z0 - 2);
    if (Math.abs(z - CZ) > 6 && r() < 0.55) continue;
    let a = r() * Math.PI * 2;
    const pts = [[x, z]], n = 2 + Math.floor(r() * 4);
    for (let s = 0; s < n; s++) { a += (r() - 0.5) * 1.4; const l = 0.03 + r() * 0.06; x += Math.cos(a) * l; z += Math.sin(a) * l; pts.push([x, z]); }
    const path = (dx, dz) => { g.beginPath(); g.moveTo(pts[0][0] + dx, pts[0][1] + dz); for (const p of pts) g.lineTo(p[0] + dx, p[1] + dz); };
    g.strokeStyle = rgb([226, 212, 176], 0.35); g.lineWidth = 0.004; path(0.003, 0.003); g.stroke();
    g.strokeStyle = rgb([96, 74, 48], 0.4 + r() * 0.3); g.lineWidth = 0.003 + r() * 0.003; path(0, 0); g.stroke();
  }
  // Ball marks on a good length at both ends, mostly in the off-stump channel.
  for (const [sz, dir] of [[PITCH.battingStumpsZ, -1], [PITCH.bowlingStumpsZ, 1]]) {
    for (let i = 0; i < 70; i++) {
      const x = -0.15 + r() * 0.65 + (r() - 0.5) * 0.3, z = sz + dir * (3.5 + r() * 5.5);
      g.fillStyle = rgb([128, 104, 70], 0.35 + r() * 0.3); g.beginPath(); g.ellipse(x, z, 0.012 + r() * 0.01, 0.02 + r() * 0.015, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = rgb([224, 210, 170], 0.25); g.beginPath(); g.ellipse(x + 0.006, z + dir * 0.02, 0.01, 0.012, 0, 0, Math.PI * 2); g.fill();
    }
  }
  // Each end: the batter's scuffed crease and guard mark, the bowlers' foot
  // holes beside the stumps and their follow-through down the sides, the
  // spinners' rough outside the off stump on a length, the run-on past the stumps.
  for (const [sz, dir] of [[PITCH.battingStumpsZ, -1], [PITCH.bowlingStumpsZ, 1]]) {
    const pop = sz + dir * PITCH.poppingOffset;
    // A scrape: a narrow darker gouge with the loosened dust kicked lighter beside it.
    const scuff = (x, z, rx, rz, a, dark = true) => {
      const rot = (r() - 0.5) * 0.9, w = Math.min(rx, rz) * 0.45, l = Math.max(rx, rz);
      blob(g, x, z, l, w, dark ? [146, 118, 80] : [222, 206, 164], a * 0.9, rot + Math.PI / 2);
      blob(g, x + 0.02, z + 0.015, l * 0.8, w * 0.9, [226, 212, 172], a * 0.5, rot + Math.PI / 2);
      if (dark) blob(g2, x, z, l, w, [0, 0, 0], a);
    };
    for (let i = 0; i < 90; i++) scuff((r() - 0.5) * 1.4, pop + dir * (r() - 0.3) * 1.2, 0.05 + r() * 0.12, 0.04 + r() * 0.1, 0.18 + r() * 0.2, r() < 0.8);
    for (let i = 0; i < 50; i++) scuff((r() - 0.5) * 0.9, sz + dir * r() * 1.1, 0.04 + r() * 0.1, 0.04 + r() * 0.08, 0.15 + r() * 0.15);
    g.strokeStyle = rgb([118, 92, 60], 0.6); g.lineWidth = 0.012;
    g.beginPath(); g.moveTo(-0.04, pop - dir * 0.05); g.lineTo(-0.04, pop - dir * 0.3); g.stroke();
    for (const sx of [-1, 1]) {
      // Foot holes: dug-out ovals with a dark floor and a lighter crumbled rim.
      const fx = sx * (0.42 + r() * 0.12), fz = pop + dir * 0.18;
      // (dug by many landings: a ragged cluster of gouges along the stride, loose dust round it)
      blob(g, fx, fz, 0.22, 0.36, [220, 204, 164], 0.4);
      for (let i = 0; i < 14; i++) {
        const gx = fx + (r() - 0.5) * 0.14, gz = fz + (r() - 0.5) * 0.26, w = 0.025 + r() * 0.04, l = 0.05 + r() * 0.08;
        g.fillStyle = rgb([156, 126, 88], 0.28 + r() * 0.25);
        g.beginPath(); g.ellipse(gx, gz, w, l, (r() - 0.5) * 0.8, 0, Math.PI * 2); g.fill();
      }
      blob(g, fx, fz + dir * 0.03, 0.05, 0.09, [126, 98, 66], 0.35);
      blob(g2, fx, fz, 0.18, 0.3, [0, 0, 0], 0.9);
      // Follow-through: scuffs angling down the side, away from the danger area.
      for (let i = 0; i < 26; i++) { const t = r(); scuff(sx * (0.7 + t * 0.55) + (r() - 0.5) * 0.25, pop + dir * (0.6 + t * 4.5), 0.06 + r() * 0.1, 0.08 + r() * 0.14, 0.18 + r() * 0.18); }
      // Run-on past the stumps (the bowler's last strides).
      for (let i = 0; i < 14; i++) scuff(sx * (0.35 + r() * 0.6), sz - dir * (0.3 + r() * 1.4), 0.06 + r() * 0.08, 0.08 + r() * 0.1, 0.18 + r() * 0.15);
    }
    // The rough outside off stump (x > 0) on a length.
    for (let i = 0; i < 36; i++) scuff(0.75 + r() * 0.55, sz + dir * (2.2 + r() * 2.6), 0.04 + r() * 0.1, 0.05 + r() * 0.12, 0.2 + r() * 0.2);
  }
  g.restore(); g2.restore();
  // The strip's cut edge: a hint of a darker line where the long grass starts.
  g.strokeStyle = rgb([113, 143, 78], 0.35); g.lineWidth = 0.02;
  g.strokeRect(X0 - 0.01, Z0 - 0.01, X1 - X0 + 0.02, Z1 - Z0 + 0.02);
  const a = g.getImageData(0, 0, W, H).data, b = g2.getImageData(0, 0, W, H).data;
  for (let i = 0; i < W * H; i++) a[i * 4 + 3] = b[i * 4];
  return dataTexture(new Uint8Array(a.buffer), W, H, { srgb: true, aniso: 4 });
}

// ------------------------------------------------------------------ rope + discs texture
// The boundary cushion's cover: invented marks on alternating panels (front
// face), a plain dark back, and a white corner the 30-yard discs sample.
function ropeTexture() {
  const [c, g] = canvas2d(1024, 128);
  g.fillStyle = '#1c2433'; g.fillRect(0, 0, 1024, 64);              // back (v 0.5..1)
  const panels = [['#f4f4f0', '#1a3d8f', 'CREASE'], ['#14285a', '#f2c12e', 'GOOD LENGTH'], ['#b3221c', '#ffffff', 'GULLY GRILL'], ['#f2c12e', '#14285a', 'NO BALL RADIO']];
  panels.forEach(([bg, fg, text], i) => {
    const x = i * 256;
    g.fillStyle = bg; g.fillRect(x, 64, 256, 64);
    g.fillStyle = fg; g.fillRect(x, 64, 256, 4);                    // piping along the crest
    g.font = '800 30px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, x + 128, 100, 236);
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(x, 64, 2, 64);       // panel seam
  });
  g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(0, 122, 1024, 6);     // grubby foot
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 8, 8);                   // the discs' white
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

// ------------------------------------------------------------------ shaders
function detailRot() {
  const c = Math.cos(DETAIL_ROT) / DETAIL_TILE, s = Math.sin(DETAIL_ROT) / DETAIL_TILE;
  return new THREE.Vector4(c, s, -s, c);
}

const SURFACE_VERT = /* glsl */`
  uniform vec4 uMapXf; uniform vec4 uDetRot;
  varying vec3 vWorld; varying vec2 vUv; varying vec2 vDUv;
  #include <common>
  #include <fog_pars_vertex>
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vUv = (wp.xz - uMapXf.xy) * uMapXf.zw;
    vDUv = mat2(uDetRot.xy, uDetRot.zw) * wp.xz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;

const SURFACE_FRAG_HEAD = /* glsl */`
  uniform sampler2D uMap; uniform sampler2D uDetail; uniform vec3 uIrr;
  varying vec3 vWorld; varying vec2 vUv; varying vec2 vDUv;
  #include <common>
  #include <fog_pars_fragment>
`;
const SURFACE_FRAG_TAIL = /* glsl */`
    gl_FragColor = vec4(alb * uIrr, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

function surfaceMaterial(map, detail, x0, z0, w, l, extraUniforms, fragBody) {
  const irr = flatIrradiance();
  return new THREE.ShaderMaterial({
    fog: true,
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uMap: { value: map }, uDetail: { value: detail },
      uMapXf: { value: new THREE.Vector4(x0, z0, 1 / w, 1 / l) },
      uDetRot: { value: detailRot() },
      uIrr: { value: new THREE.Vector3(irr.r, irr.g, irr.b) },
      ...extraUniforms,
    },
    vertexShader: SURFACE_VERT,
    fragmentShader: SURFACE_FRAG_HEAD + fragBody + SURFACE_FRAG_TAIL,
  });
}

// Turf: macro colour and blade detail; the mowing stripes are maths.
const TURF_FRAG = /* glsl */`
  uniform vec3 uStripe;   // contrast always, contrast looking along the mowing line, stripe width
  uniform vec4 uSq;       // square half width, z0, z1; boundary radius^2
  uniform float uCZ;
  void main() {
    vec3 m = texture2D(uMap, vUv).rgb;
    float d = texture2D(uDetail, vDUv).r - 0.5;
    vec3 vd = normalize(vWorld - cameraPosition);
    // Mowing stripes along the pitch, soft-edged, filtered against the pixel's
    // footprint (fading out where a pixel spans a stripe: no moire far away),
    // none on the square, fainter past the rope.
    float u = vWorld.x / uStripe.z + 0.5, fu = fwidth(u), f = fract(u), e = 0.06 + fu;
    float st = (mod(floor(u), 2.0) < 0.5 ? 1.0 : -1.0) * smoothstep(0.0, e, f) * smoothstep(0.0, e, 1.0 - f) * (1.0 - smoothstep(0.15, 0.45, fu));
    vec2 sq = vec2(abs(vWorld.x) - uSq.x, max(uSq.y - vWorld.z, vWorld.z - uSq.z));
    vec2 rc = vec2(vWorld.x, vWorld.z - uCZ);
    st *= smoothstep(-0.4, 0.8, max(sq.x, sq.y)) * (dot(rc, rc) > uSq.w ? 0.55 : 1.0);
    // Blades laid one way read light seen along their lean, dark looking back up it.
    vec3 alb = m * (1.0 + st * (uStripe.x + uStripe.y * vd.z));
    // Blades: light tips are yellower, the gaps between them darker.
    alb *= 1.0 + d * vec3(0.62, 0.52, 0.30);
    // Grazing sheen: far turf reads paler and less saturated.
    float gz = 1.0 - abs(vd.y); gz *= gz; gz *= gz;
    alb = mix(alb, vec3(dot(alb, vec3(0.3, 0.55, 0.15))) * vec3(1.04, 1.12, 0.9), gz * 0.3);
`;

// Pitch: clay map (alpha = grass) + the detail's clay or blade channel, and the
// creases: box-filtered against the pixel's footprint (fwidth), so a line
// thinner than a pixel fades to its true coverage instead of crawling.
const PITCH_FRAG = /* glsl */`
  uniform vec4 uCrease;   // batting stumps z, bowling stumps z, popping offset, half line width
  uniform vec4 uCreaseX;  // return crease x, popping half length, wide line x, pitch middle z
  float band(float c, float h, float f) { return clamp((c + h) / f + 0.5, 0.0, 1.0) - clamp((c - h) / f + 0.5, 0.0, 1.0); }
  void main() {
    vec4 m = texture2D(uMap, vUv);
    vec4 dt = texture2D(uDetail, vDUv);
    float d = mix(dt.g, dt.r, m.a) - 0.5;
    vec3 alb = m.rgb * (1.0 + d * mix(vec3(0.55, 0.58, 0.62), vec3(0.62, 0.52, 0.30), m.a));
    // Creases, in the end's own frame: s runs from the stumps toward the middle.
    vec2 p = vWorld.xz;
    bool bat = p.y > uCreaseX.w;
    float s = (p.y - (bat ? uCrease.x : uCrease.y)) * (bat ? -1.0 : 1.0);
    float ax = abs(p.x), hw = uCrease.w, pop = uCrease.z;
    vec2 fw = max(fwidth(p), vec2(1e-4));
    float ln = band(s, hw, fw.y) * band(ax, uCreaseX.x + hw, fw.x);                       // bowling crease
    ln = max(ln, band(s - pop, hw, fw.y) * band(ax, uCreaseX.y + hw, fw.x));               // popping crease
    ln = max(ln, band(ax - uCreaseX.x, hw, fw.x) * band(s, pop + hw, fw.y));               // return creases (to pop - 2.44)
    ln = max(ln, band(ax - uCreaseX.z, hw, fw.x) * band(s - pop + 0.3, 0.3 + hw, fw.y));   // wide guides
    alb = mix(alb, vec3(0.86, 0.86, 0.84) * (0.8 + 0.2 * dt.b), ln * (0.75 + 0.25 * dt.b));
`;

// ------------------------------------------------------------------ build
export function buildGround(stadium, pitchGroup) {
  const detail = detailTexture(), macro = macroTexture(), pitchMap = pitchTexture();     // (~40, ~70, ~90 ms in software GL)

  // Outfield: one disc out to under the stands.
  const turfGeo = new THREE.CircleGeometry(CONFIG.field.groundRadius + 12, 96);
  turfGeo.rotateX(-Math.PI / 2);
  turfGeo.deleteAttribute('uv'); turfGeo.deleteAttribute('normal');
  const turfMat = surfaceMaterial(macro, detail, -MACRO_S / 2, CZ - MACRO_S / 2, MACRO_S, MACRO_S,
    {
      uStripe: { value: new THREE.Vector3(0.012, 0.09, STRIPE_W) },
      uSq: { value: new THREE.Vector4(SQ_HALF_W, SQ_Z0, SQ_Z1, CONFIG.field.boundaryRadius ** 2) },
      uCZ: { value: CZ },
    }, TURF_FRAG);
  const ground = new THREE.Mesh(turfGeo, turfMat);
  ground.position.set(0, 0, CZ);
  ground.name = 'turf';
  stadium.add(ground);

  // Pitch (strip + square-grass border), a hair above the turf.
  const pGeo = new THREE.PlaneGeometry(PM_HALF_W * 2, PM_Z1 - PM_Z0, 1, 8);
  pGeo.rotateX(-Math.PI / 2);
  pGeo.deleteAttribute('uv'); pGeo.deleteAttribute('normal');
  const pitchMat = surfaceMaterial(pitchMap, detail, -PM_HALF_W, PM_Z0, PM_HALF_W * 2, PM_Z1 - PM_Z0, {
    uCrease: { value: new THREE.Vector4(PITCH.battingStumpsZ, PITCH.bowlingStumpsZ, PITCH.poppingOffset, 0.025) },
    uCreaseX: { value: new THREE.Vector4(PITCH.returnCreaseX, PITCH.poppingHalfLength, PITCH.wideLineX, CZ) },
  }, PITCH_FRAG);
  pitchMat.polygonOffset = true; pitchMat.polygonOffsetFactor = -1; pitchMat.polygonOffsetUnits = -2;
  const pitchMesh = new THREE.Mesh(pGeo, pitchMat);
  pitchMesh.position.set(0, 0.003, (PM_Z0 + PM_Z1) / 2);
  pitchMesh.name = 'pitchStrip';
  pitchGroup.add(pitchMesh);

  // Boundary cushion (a padded triangle, crest on the boundary line) + the
  // 30-yard discs: one mesh, one material.
  const R = CONFIG.field.boundaryRadius;
  const prof = [[R - 0.21, 0.004], [R - 0.12, 0.1], [R - 0.035, 0.175], [R + 0.03, 0.178], [R + 0.1, 0.11], [R + 0.16, 0.004]];
  const cushion = new THREE.LatheGeometry(prof.map(([x, y]) => new THREE.Vector2(x, y)), 360);
  {
    const uv = cushion.attributes.uv, laps = 30;
    // u: mirrored so the marks read from the field; v: front face + crest printed, back plain.
    const vOf = [0.02, 0.2, 0.42, 0.56, 0.78, 0.98];
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (1 - uv.getX(i)) * laps, vOf[i % prof.length]);
  }
  const parts = [cushion];
  const discGeo = new THREE.CylinderGeometry(0.2, 0.21, 0.022, 18, 1);
  for (let i = 0; i < discGeo.attributes.uv.count; i++) discGeo.attributes.uv.setXY(i, 0.003, 0.996);
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2, d = discGeo.clone();
    d.translate(Math.sin(a) * 27.4, 0.011, Math.cos(a) * 27.4);
    parts.push(d);
  }
  const rope = new THREE.Mesh(mergeGeos(parts), new THREE.MeshLambertMaterial({ map: ropeTexture(), side: THREE.DoubleSide }));
  rope.position.z = CZ;
  rope.name = 'boundary';
  stadium.add(rope);

  return { ground, pitchMesh, rope };
}

function mergeGeos(list) {
  // (LatheGeometry and CylinderGeometry are both indexed; keep only what the material uses.)
  for (const g of list) for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  return mergeGeometries(list, false);
}
