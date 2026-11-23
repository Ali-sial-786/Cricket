// The bat you hold (and the AI striker's): one lofted mesh, one material, one
// texture. Built in the physics bat frame (origin = grip point, +Y to the handle
// top, +Z = hitting face, +X across) and inside the physics shape: the face is
// the rounded box's face (corners at CONFIG.bat.edgeRadius), the back is a real
// English-willow profile (40 mm edges, a spine as deep as the box at the
// middle, thinner at the shoulders and the toe), the toe rounded as the box is.
// Above the blade: rounded shoulders blending into the cane, a short bound
// splice, a ribbed rubber grip and its cap. Ball marks ('cherries') are drawn
// by the material from a few contact points (addBatMark), no texture upload.
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { BatGeometry } from '../physics/bat.js';

// Texture layout (u around the section, v along the bat, toe = 0):
//   left edge [0, .1) | face [.1, .5) | right edge [.5, .6) | back [.6, 1]
// The u seam sits where the back meets the left edge.
const U = { left: [0, 0.1], face: [0.1, 0.5], right: [0.5, 0.6], back: [0.6, 1] };
const TEX_W = 512, TEX_H = 1024;
const MARKS = 8;

// ---------------------------------------------------------------- section
// One cross-section as four region polylines (left edge, face, right edge,
// back), each walked in the same direction round the bat. p: {W, F, Bk, Ek, rc, re}
// = half width, face z, back z at the spine, back z at the edges, face-corner
// and back-corner radii.
function arc(out, cx, cz, r, a0, a1, n) {
  for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]); }
}
function sectionRegions({ W, F, Bk, Ek, rc, re }) {
  const H = Math.PI / 2;
  const left = [], face = [], right = [], back = [];
  arc(left, -(W - re), Ek + re, re, -H, -Math.PI, 8);             // back-left corner, up the side…
  arc(left, -(W - rc), F - rc, rc, Math.PI, H, 8);                 // …round the face corner
  for (let i = 0; i <= 8; i++) face.push([-(W - rc) + 2 * (W - rc) * i / 8, F]);
  arc(right, W - rc, F - rc, rc, H, 0, 8);
  arc(right, W - re, Ek + re, re, 0, -H, 8);
  const xb = W - re;
  for (let i = 0; i <= 16; i++) {                                  // the spine: flat-topped hump, level at the corners
    const x = xb - 2 * xb * i / 16, u = x / xb;
    back.push([x, Ek + (Bk - Ek) * Math.pow(Math.max(0, 1 - u * u), 1.3)]);
  }
  return [left, face, right, back];
}
// A circle split into the same four regions (the handle), at the angles the
// regions have on the blade so the loft morphs without twisting.
function circleRegions(R, angles) {
  const out = [];
  for (let k = 0; k < 4; k++) {
    const pts = [], a0 = angles[k], a1 = angles[k + 1];
    for (let i = 0; i <= 12; i++) { const a = a0 + (a1 - a0) * i / 12; pts.push([Math.cos(a) * R, Math.sin(a) * R]); }
    out.push(pts);
  }
  return out;
}
function polyLen(p) { const L = [0]; for (let i = 1; i < p.length; i++) L.push(L[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1])); return L; }
function atFrac(p, L, f) {
  const total = L[L.length - 1], s = f * total;
  if (total < 1e-9) return p[0];
  let i = 1; while (i < L.length - 1 && L[i] < s) i++;
  const a = L[i - 1], b = L[i], k = b - a > 1e-12 ? (s - a) / (b - a) : 0;
  return [p[i - 1][0] + (p[i][0] - p[i - 1][0]) * k, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * k];
}

// ---------------------------------------------------------------- geometry
const _geoCache = new Map();
export function batGeometry(cfg = CONFIG.bat) {
  const key = [cfg.bladeLength, cfg.bladeWidth, cfg.bladeThickness, cfg.edgeRadius, cfg.handleLength, cfg.handleRadius, cfg.gripFromHandleTop].join();
  if (_geoCache.has(key)) return _geoCache.get(key);
  const G = new BatGeometry(cfg);
  const bl = cfg.bladeLength, W = cfg.bladeWidth / 2, half = cfg.bladeThickness / 2, hr = cfg.handleRadius;
  const rc = G.edgeRadius, re = 0.014;
  const toeY = G.toeY, shY = G.shoulderY, topY = G.handleTopY, L = topY - toeY;
  // Along the blade (t: 0 toe .. 1 shoulder): spine depth, edge thickness, a 1.5 mm bow in the face.
  const lerpTab = (tab, t) => { let i = 1; while (i < tab.length - 1 && tab[i][0] < t) i++; const [t0, a] = tab[i - 1], [t1, b] = tab[i]; const k = Math.min(1, Math.max(0, (t - t0) / (t1 - t0))); const s = k * k * (3 - 2 * k); return a + (b - a) * s; };
  const SPINE = [[0, 0.038], [0.07, 0.047], [0.2, 0.054], [0.32, 0.056], [0.44, 0.0555], [0.62, 0.052], [0.8, 0.047], [0.94, 0.044], [1, 0.043]];
  const EDGE = [[0, 0.034], [0.12, 0.039], [0.5, 0.040], [0.85, 0.037], [1, 0.034]];
  const bladeParams = (t) => {
    const F = half - 0.0015 * Math.sin(Math.PI * Math.min(1, Math.max(0, t)));
    const S = Math.min(lerpTab(SPINE, t), F + half);
    return { W, F, Bk: F - S, Ek: F - lerpTab(EDGE, t), rc, re };
  };
  // Samples per region, denser round the corners (by arc length plus turning).
  const COUNTS = [8, 8, 8, 10];
  const ref = sectionRegions(bladeParams(0.4));
  const fracs = ref.map((poly, k) => {
    const n = COUNTS[k], w = [0];
    for (let i = 1; i < poly.length; i++) {
      const ds = Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
      let turn = 0;
      if (i > 1) { const a0 = Math.atan2(poly[i - 1][1] - poly[i - 2][1], poly[i - 1][0] - poly[i - 2][0]), a1 = Math.atan2(poly[i][1] - poly[i - 1][1], poly[i][0] - poly[i - 1][0]); turn = Math.abs(Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0))); }
      w.push(w[i - 1] + ds + (k === 1 || k === 3 ? 0 : turn * 0.01));
    }
    const len = polyLen(poly), total = w[w.length - 1], out = [];
    for (let j = 0; j < n; j++) {                       // region start included, end excluded (it is the next region's start)
      const s = total * j / n;
      let i = 1; while (i < w.length - 1 && w[i] < s) i++;
      const k2 = w[i] - w[i - 1] > 1e-12 ? (s - w[i - 1]) / (w[i] - w[i - 1]) : 0;
      out.push((len[i - 1] + (len[i] - len[i - 1]) * k2) / len[len.length - 1]);
    }
    return out;
  });
  const N = COUNTS.reduce((a, b) => a + b, 0);
  const uOf = [];
  const spans = [U.left, U.face, U.right, U.back];
  fracs.forEach((fs, k) => fs.forEach((f) => uOf.push(spans[k][0] + (spans[k][1] - spans[k][0]) * f)));
  // The region boundaries' angles on the blade, for the handle's circle.
  const ang = (p) => Math.atan2(p[1], p[0]);
  let a0 = ang(ref[0][0]);
  const angles = [a0];
  for (let k = 0; k < 4; k++) {
    let a = ang(ref[k][ref[k].length - 1]);
    while (a > angles[k]) a -= Math.PI * 2;                 // walking clockwise: each boundary below the last
    angles.push(a);
  }
  angles[4] = a0 - Math.PI * 2;
  const sample = (regions) => {
    const pts = [];
    regions.forEach((poly, k) => { const len = polyLen(poly); for (const f of fracs[k]) pts.push(atFrac(poly, len, f)); });
    return pts;
  };
  // Rings bottom to top: [y, points[N]].
  const rings = [];
  const ringAt = (y, pts) => rings.push({ y, pts });
  // Toe: the rounded box's bottom edge (radius rc), inset in every direction.
  for (const h of [0, 0.0016, 0.0045, 0.0085]) {
    const p = bladeParams(0), d = rc - Math.sqrt(Math.max(0, rc * rc - (rc - h) * (rc - h)));
    ringAt(toeY + h, sample(sectionRegions({ W: p.W - d, F: p.F - d, Bk: p.Bk + d, Ek: p.Ek + d * 0.5, rc: Math.max(0.002, rc - d), re: Math.max(0.002, re - d) })));
  }
  for (const t of [rc / bl, 0.03, 0.07, 0.13, 0.21, 0.3, 0.4, 0.5, 0.6, 0.7, 0.79, 0.87, 0.93]) ringAt(toeY + t * bl, sample(sectionRegions(bladeParams(t))));
  // Shoulders: from 3 cm below the top of the blade into the cane 3 cm above it,
  // a quarter-ellipse in face view (the blade's edges turn in, the spine runs out).
  const ys0 = shY - 0.03, ys1 = shY + 0.03, hs = hr * 0.9;
  const topSec = sample(sectionRegions(bladeParams((ys0 - toeY) / bl)));
  const circ = sample(circleRegions(hs, angles));
  for (const s of [0, 0.3, 0.55, 0.75, 0.9, 1]) {
    const m = 1 - Math.sqrt(Math.max(0, 1 - s * s));
    ringAt(ys0 + (ys1 - ys0) * s, topSec.map((p, i) => [p[0] + (circ[i][0] - p[0]) * m, p[1] + (circ[i][1] - p[1]) * m]));
  }
  // Cane with its twine binding, then the grip: rubber over the handle, ribbed.
  const gripY0 = ys1 + 0.02, gripY1 = topY - 0.006;
  ringAt(gripY0, sample(circleRegions(hs, angles)));
  ringAt(gripY0 + 0.0025, sample(circleRegions(hr, angles)));
  const RIBS = 5;
  for (let i = 0; i < RIBS; i++) {
    const y = gripY0 + 0.0025 + (gripY1 - gripY0 - 0.0025) * (i + 0.5) / RIBS;
    const dy = (gripY1 - gripY0) / RIBS * 0.22;
    ringAt(y - dy, sample(circleRegions(hr * 0.975, angles)));
    ringAt(y + dy, sample(circleRegions(hr, angles)));
  }
  ringAt(gripY1, sample(circleRegions(hr, angles)));
  ringAt(topY - 0.001, sample(circleRegions(hr * 0.86, angles)));
  ringAt(topY + 0.003, sample(circleRegions(hr * 0.5, angles)));
  // Vertices: N + 1 per ring (the seam duplicated, u = 1), plus the two cap centres.
  const R = rings.length, V = N + 1;
  const pos = new Float32Array((R * V + 2) * 3), uv = new Float32Array((R * V + 2) * 2);
  rings.forEach((r, j) => {
    const v = Math.min(1, (r.y - toeY) / L);
    for (let i = 0; i <= N; i++) {
      const p = r.pts[i % N], o = j * V + i;
      pos[o * 3] = p[0]; pos[o * 3 + 1] = r.y; pos[o * 3 + 2] = p[1];
      uv[o * 2] = i === N ? 1 : uOf[i]; uv[o * 2 + 1] = v;
    }
  });
  const cBot = R * V, cTop = R * V + 1;
  const centre = (r) => { let x = 0, z = 0; for (const p of r.pts) { x += p[0]; z += p[1]; } return [x / N, z / N]; };
  const cb = centre(rings[0]), ct = centre(rings[R - 1]);
  pos.set([cb[0], toeY, cb[1]], cBot * 3); uv.set([0.3, 0], cBot * 2);
  pos.set([ct[0], topY + 0.005, ct[1]], cTop * 3); uv.set([0.3, 1], cTop * 2);
  const idx = [];
  // (the regions run left edge -> face -> right edge -> back: each quad wound to face out)
  for (let j = 0; j < R - 1; j++) for (let i = 0; i < N; i++) {
    const a = j * V + i, b = a + 1, c = a + V, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  for (let i = 0; i < N; i++) { idx.push(cBot, i + 1, i); idx.push(cTop, (R - 1) * V + i, (R - 1) * V + i + 1); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // (the seam's two copies share one normal)
  const nrm = geo.attributes.normal.array;
  for (let j = 0; j < R; j++) {
    const a = (j * V) * 3, b = (j * V + N) * 3;
    for (let k = 0; k < 3; k++) { const m = (nrm[a + k] + nrm[b + k]) / 2; nrm[a + k] = nrm[b + k] = m; }
    const l = Math.hypot(nrm[a], nrm[a + 1], nrm[a + 2]) || 1;
    for (let k = 0; k < 3; k++) { nrm[a + k] /= l; nrm[b + k] = nrm[a + k]; }
  }
  geo.computeBoundingSphere();
  geo.userData = { toeY, shY, topY, L, W, faceZ: half, gripY0, ys0, ys1 };
  _geoCache.set(key, geo);
  return geo;
}

// ---------------------------------------------------------------- texture
// Willow (grain down the face), toe guard, splice, the stickers of an invented
// maker (HALCYON: navy, gold, a crimson flash), the bound cane and the grip.
let _tex = null;
function batTexture(geo) {
  if (_tex) return _tex;
  const { toeY, shY, L, W, gripY0, ys1 } = geo.userData;
  const c = document.createElement('canvas');
  c.width = TEX_W; c.height = TEX_H;
  const g = c.getContext('2d');
  const X = (u) => u * TEX_W, Y = (y) => (1 - (y - toeY) / L) * TEX_H;
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const yBladeTop = Y(shY + 0.03);
  // Willow: pale cream, a touch warmer toward the edges.
  const base = g.createLinearGradient(0, 0, TEX_W, 0);
  base.addColorStop(0, '#d9bd88'); base.addColorStop(0.1, '#e3c995'); base.addColorStop(0.3, '#ead3a2'); base.addColorStop(0.5, '#e3c995');
  base.addColorStop(0.55, '#d9bd88'); base.addColorStop(0.6, '#e1c692'); base.addColorStop(0.8, '#e8d09e'); base.addColorStop(1, '#d9bd88');
  g.fillStyle = base; g.fillRect(0, 0, TEX_W, TEX_H);
  // Grain: straight, slightly wandering lines down the bat, a few strong ones and many fine fibres.
  for (let i = 0; i < 260; i++) {
    const x0 = rnd() * TEX_W, strong = i < 46;
    g.strokeStyle = strong ? `rgba(160,118,62,${0.16 + rnd() * 0.16})` : `rgba(150,112,60,${0.05 + rnd() * 0.07})`;
    g.lineWidth = strong ? 1 + rnd() * 1.4 : 0.6 + rnd() * 0.6;
    g.beginPath();
    let x = x0; g.moveTo(x, TEX_H);
    for (let y = TEX_H; y > yBladeTop - 30; y -= 48) { x += (rnd() - 0.5) * 1.6; g.lineTo(x, y); }
    g.stroke();
  }
  // Soft broad bands (the growth rings seen on the face) and a couple of pin knots.
  for (let i = 0; i < 9; i++) { g.fillStyle = `rgba(190,150,90,${0.04 + rnd() * 0.05})`; g.fillRect(rnd() * TEX_W, yBladeTop, 6 + rnd() * 14, TEX_H); }
  for (let i = 0; i < 3; i++) { const x = X(0.15 + rnd() * 0.3), y = Y(toeY + 0.15 + rnd() * 0.4); g.fillStyle = 'rgba(120,80,40,0.35)'; g.beginPath(); g.ellipse(x, y, 1.4, 3.2, 0, 0, Math.PI * 2); g.fill(); }
  // Face region helpers (u ↔ x across the flat face).
  const faceX = (x) => X(U.face[0] + (x / (2 * (W - 0.012)) + 0.5) * (U.face[1] - U.face[0]));
  const backX = (x) => X(U.back[0] + (0.5 - x / (2 * (W - 0.014))) * (U.back[1] - U.back[0]));     // (the back runs right to left)
  const pxPerM = (TEX_H / L);
  // Splice: the handle's V running into the blade, on the face and the back.
  const spliceV = (cx, halfW) => {
    const yT = Y(shY + 0.03), yB = Y(shY - 0.15);
    g.fillStyle = 'rgba(196,150,86,0.55)';
    g.beginPath(); g.moveTo(cx - halfW, yT); g.lineTo(cx, yB); g.lineTo(cx + halfW, yT); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(110,74,34,0.75)'; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(cx - halfW, yT); g.lineTo(cx, yB); g.lineTo(cx + halfW, yT); g.stroke();
  };
  spliceV(faceX(0), 0.018 / (2 * (W - 0.012)) * (U.face[1] - U.face[0]) * TEX_W);
  spliceV(backX(0), 0.02 / (2 * (W - 0.014)) * (U.back[1] - U.back[0]) * TEX_W);
  // Toe guard: black rubber over the bottom 18 mm (with a raised lip).
  const yToe = Y(toeY + 0.018);
  g.fillStyle = '#1b1c1f'; g.fillRect(0, yToe, TEX_W, TEX_H - yToe);
  g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(0, yToe, TEX_W, 2);
  g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, yToe - 2, TEX_W, 2);
  // ---- stickers (drawn rotated: text runs along the bat, read from the toe up)
  const NAVY = '#14234f', GOLD = '#d4a52c', CRIMSON = '#b3202a';
  const along = (cx, cy, fn) => { g.save(); g.translate(cx, cy); g.rotate(-Math.PI / 2); fn(); g.restore(); };
  const fontFit = (text, weight, maxW, maxH) => { let s = maxH; g.font = `${weight} ${s}px system-ui, Arial, sans-serif`; const w = g.measureText(text).width; if (w > maxW) s *= maxW / w; return `${weight} ${Math.floor(s)}px system-ui, Arial, sans-serif`; };
  // Face: the maker's name big down the upper face, a crimson flash, the model near the toe.
  const fw = (U.face[1] - U.face[0]) * TEX_W;           // face width in px
  const fcx = faceX(0);
  {
    const y0 = Y(shY - 0.07), y1 = Y(shY - 0.40), cy = (y0 + y1) / 2, len = y1 - y0;
    // flash: two crimson/gold slashes behind the lettering
    g.save(); g.translate(fcx, cy);
    g.fillStyle = CRIMSON; g.beginPath(); g.moveTo(-fw * 0.42, len * 0.48); g.lineTo(-fw * 0.2, len * 0.5); g.lineTo(fw * 0.42, -len * 0.42); g.lineTo(fw * 0.26, -len * 0.44); g.closePath(); g.fill();
    g.fillStyle = GOLD; g.beginPath(); g.moveTo(-fw * 0.16, len * 0.5); g.lineTo(-fw * 0.08, len * 0.5); g.lineTo(fw * 0.42, -len * 0.3); g.lineTo(fw * 0.42, -len * 0.38); g.closePath(); g.fill();
    g.restore();
    along(fcx, cy, () => {
      g.font = fontFit('HALCYON', 900, len * 0.96, fw * 0.6); g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineJoin = 'round'; g.lineWidth = 7; g.strokeStyle = GOLD; g.strokeText('HALCYON', 0, 2);
      g.lineWidth = 3; g.strokeStyle = '#fff6dc'; g.strokeText('HALCYON', 0, 2);
      g.fillStyle = NAVY; g.fillText('HALCYON', 0, 2);
    });
    // emblem at the top of the face sticker: a gold chevron (the kingfisher's dive) in a navy shield
    const ex = fcx, ey = Y(shY - 0.045), es = fw * 0.16;
    g.fillStyle = NAVY; g.beginPath(); g.moveTo(ex - es, ey - es * 0.9); g.lineTo(ex + es, ey - es * 0.9); g.lineTo(ex + es, ey + es * 0.2); g.lineTo(ex, ey + es); g.lineTo(ex - es, ey + es * 0.2); g.closePath(); g.fill();
    g.strokeStyle = GOLD; g.lineWidth = 2; g.stroke();
    g.fillStyle = GOLD; g.beginPath(); g.moveTo(ex - es * 0.62, ey - es * 0.45); g.lineTo(ex, ey + es * 0.45); g.lineTo(ex + es * 0.62, ey - es * 0.45); g.lineTo(ex + es * 0.36, ey - es * 0.45); g.lineTo(ex, ey + 0.02 * es); g.lineTo(ex - es * 0.36, ey - es * 0.45); g.closePath(); g.fill();
    // model name and grade near the toe
    const ty = Y(toeY + 0.11);
    g.fillStyle = NAVY; g.fillRect(fcx - fw * 0.36, ty - 13, fw * 0.72, 26);
    g.fillStyle = GOLD; g.fillRect(fcx - fw * 0.36, ty + 13, fw * 0.72, 3);
    g.fillStyle = '#ffffff'; g.font = fontFit('CREASE PRO 900', 800, fw * 0.66, 17); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('CREASE PRO 900', fcx, ty + 1);
    g.fillStyle = 'rgba(20,35,79,0.8)'; g.font = fontFit('GRADE 1 ENGLISH WILLOW', 700, fw * 0.7, 10); g.fillText('GRADE 1 ENGLISH WILLOW', fcx, ty + 26);
  }
  // Back: a big sticker over the spine (shield, name along the bat) and colour bands.
  const bw = (U.back[1] - U.back[0]) * TEX_W, bcx = backX(0);
  {
    const y0 = Y(shY - 0.16), y1 = Y(toeY + 0.2), cy = (y0 + y1) / 2, len = y1 - y0;
    const pw = bw * 0.62;
    const gr = g.createLinearGradient(bcx - pw / 2, 0, bcx + pw / 2, 0);
    gr.addColorStop(0, '#0e1a3d'); gr.addColorStop(0.5, '#1d3270'); gr.addColorStop(1, '#0e1a3d');
    g.fillStyle = gr;
    g.beginPath(); g.moveTo(bcx - pw / 2, y0 + 30); g.lineTo(bcx, y0); g.lineTo(bcx + pw / 2, y0 + 30); g.lineTo(bcx + pw / 2, y1 - 30); g.lineTo(bcx, y1); g.lineTo(bcx - pw / 2, y1 - 30); g.closePath(); g.fill();
    g.strokeStyle = GOLD; g.lineWidth = 3; g.stroke();
    g.fillStyle = CRIMSON; g.fillRect(bcx - pw / 2, y0 + len * 0.2, pw, 8); g.fillRect(bcx - pw / 2, y1 - len * 0.2 - 8, pw, 8);
    along(bcx, cy, () => {
      g.font = fontFit('HALCYON', 900, len * 0.5, pw * 0.5); g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#ffffff'; g.fillText('HALCYON', 0, 0);
    });
    g.fillStyle = GOLD; g.font = fontFit('EST. 1898', 700, pw * 0.8, 13); g.textAlign = 'center'; g.fillText('EST. 1898', bcx, y0 + len * 0.13);
    g.fillText('HAND MADE', bcx, y1 - len * 0.13);
  }
  // Edges: the name along both edges, small.
  for (const [u0, u1] of [U.left, U.right]) {
    const cx = X((u0 + u1) / 2), ew = (u1 - u0) * TEX_W, cy = Y(toeY + 0.36);
    along(cx, cy, () => {
      g.font = fontFit('HALCYON', 900, 0.16 * pxPerM, ew * 0.5); g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = NAVY; g.fillText('HALCYON', 0, 0);
    });
    g.fillStyle = CRIMSON; g.fillRect(cx - ew * 0.3, cy - 0.09 * pxPerM, ew * 0.6, 3); g.fillRect(cx - ew * 0.3, cy + 0.09 * pxPerM, ew * 0.6, 3);
  }
  // Cane above the shoulders, bound with twine.
  const yc0 = Y(ys1 - 0.004), yc1 = Y(gripY0 + 0.003);
  g.fillStyle = '#c49a5c'; g.fillRect(0, yc1, TEX_W, yc0 - yc1);
  for (let y = yc1; y < yc0; y += 2.2) { g.fillStyle = `rgba(70,45,20,${0.35 + rnd() * 0.2})`; g.fillRect(0, y, TEX_W, 0.9); }
  // Grip: dark rubber wound in a spiral (the stripes meet across the seam), a fine
  // pebbled surface and one gold tracer stripe.
  const yg = Y(gripY0 + 0.0025);
  g.fillStyle = '#1e2126'; g.fillRect(0, 0, TEX_W, yg);
  const pitch = 34, rise = pitch * 3;                    // 3 stripes per turn: the wrap closes on itself
  g.save(); g.beginPath(); g.rect(0, 0, TEX_W, yg); g.clip();
  for (let y = -rise; y < yg + rise; y += pitch) {
    g.fillStyle = '#2b2f36'; g.beginPath(); g.moveTo(0, y); g.lineTo(TEX_W, y - rise); g.lineTo(TEX_W, y - rise + pitch * 0.55); g.lineTo(0, y + pitch * 0.55); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, y + pitch * 0.55); g.lineTo(TEX_W, y - rise + pitch * 0.55); g.stroke();
  }
  for (let y = -rise * 2; y < yg + rise; y += rise) { g.strokeStyle = 'rgba(212,165,44,0.85)'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(0, y + pitch * 0.2); g.lineTo(TEX_W, y - rise + pitch * 0.2); g.stroke(); }
  for (let i = 0; i < 2200; i++) { g.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.05)'; g.fillRect(rnd() * TEX_W, rnd() * yg, 1.5, 1.5); }
  g.restore();
  g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(0, yg - 3, TEX_W, 3);
  _tex = new THREE.CanvasTexture(c);
  _tex.colorSpace = THREE.SRGBColorSpace;
  _tex.anisotropy = 4;
  return _tex;
}

// ---------------------------------------------------------------- material
// Soft-sheen Phong (oiled willow, matt rubber via the texture's darkness), and
// up to MARKS cherries: faint round scuffs where the ball met the face.
function batMaterial(tex) {
  const marks = Array.from({ length: MARKS }, () => new THREE.Vector4(0, 0, 0, 0));
  const m = new THREE.MeshPhongMaterial({ map: tex, color: 0xffffff, specular: 0x302a22, shininess: 16, fog: false });   // (no fog: a bat is never 140 m from a camera)
  m.userData.marks = marks;
  m.userData.next = 0;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uMarks = { value: marks };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBatLocal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBatLocal = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vBatLocal;\nuniform vec4 uMarks[${MARKS}];`)
      .replace('#include <map_fragment>', `#include <map_fragment>
      {
        float ck = 0.0;
        for (int i = 0; i < ${MARKS}; i++) {
          vec4 mk = uMarks[i];
          vec2 d = (vBatLocal.xy - mk.xy) * vec2(1.0, 0.85);
          float r = length(d) / 0.019;
          ck = max(ck, mk.w * (1.0 - smoothstep(0.55, 1.0, r)) * (0.7 + 0.3 * smoothstep(0.4, 0.8, r)));
        }
        ck *= step(mk_faceZ, vBatLocal.z);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.55, 0.42, 0.36), ck * 0.55);
      }`.replace('mk_faceZ', (CONFIG.bat.bladeThickness / 2 - 0.006).toFixed(4)));
  };
  m.customProgramCacheKey = () => 'bat-cherries';
  return m;
}

export function buildBatMesh(cfg = CONFIG.bat) {
  const geo = batGeometry(cfg);
  const mesh = new THREE.Mesh(geo, batMaterial(batTexture(geo)));
  mesh.name = 'bat';
  // Drawn after the other opaque things, every bat together (opaque draws go in material order, and
  // a bat made with a figure would split the figures' run: two program switches an eye). Opaque:
  // the order changes no pixel.
  mesh.renderOrder = 0.5;
  return mesh;
}

// A ball mark on the face where the ball met it. local: the ball centre in the
// bat frame at contact (physics `local`); strength 0..1. Old marks are reused
// round-robin (the oldest fades first). Off the face (edges, back): no mark.
export function addBatMark(mesh, local, strength = 1) {
  const m = mesh && mesh.material, u = m && m.userData;
  if (!u || !u.marks || !local) return;
  const G = mesh.geometry.userData;
  if (local.z < G.faceZ || Math.abs(local.x) > G.W - 0.01 || local.y < G.toeY + 0.02 || local.y > G.shY) return;
  const mk = u.marks[u.next];
  mk.set(local.x, local.y, 0, Math.min(1, 0.35 + 0.65 * strength));
  u.next = (u.next + 1) % MARKS;
}
