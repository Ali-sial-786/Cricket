// Cricket gear for the athlete figure: helmet (shell, peak, steel grille, ear
// guards, chin strap), cap (six-panel crown, curved peak), wide-brim hat,
// batting pads (vertical canes, knee roll, thigh flap, straps), batting gloves
// (a closed fist of segmented finger rolls, thumb and palm round the handle,
// with a cuff that bends with the wrist) and keeping gloves.
//
// Every piece is authored in its bone's canonical local frame (rest pose =
// identity) and then placed in bind space by gearPart(), which also writes
// the kit slot, a cheap baked occlusion term and the skin (one bone, or a
// blend between two bones along the piece). Everything ends up merged into
// the figure's single SkinnedMesh.
//
// Frames: head — origin at the head bone, +Y up, +Z forward.
//         knee — origin at the knee, the shin along -Y, +Z forward.
//         hand — the wrist at the origin, the knuckles along -Y; a held bat
//         handle runs along Z through the palm at y = -PALM (thumb/index side
//         +Z, toward the blade). sx = +1 (left hand) / -1 (right) points to
//         the back of the hand.
import * as THREE from 'three';

export const KIT = { shirt: 1, trim: 2, headgear: 3, trousers: 4, skin: 5, hair: 6, panel: 7 };
const PALM = 0.075, HANDLE_R = 0.017;
const WHITE = 0xf4f4f0, PAD_WHITE = 0xf2f2ee, LEATHER = 0xd8d1c0, STEEL = 0xaeb6bf, STRAP = 0x24272c, TAN = 0xc9b48e;

// ------------------------------------------------------------------ mesh builder
// Vertices carry a reference point; every triangle is wound so that its
// normal points away from its vertices' references (a centre line, an axis,
// a point behind a surface), so shapes never come out inside-out.
class Builder {
  constructor() { this.p = []; this.r = []; this.i = []; }
  v(p, ref) { this.p.push(p[0], p[1], p[2]); this.r.push(ref[0], ref[1], ref[2]); return this.p.length / 3 - 1; }
  tri(a, b, c) { this.i.push(a, b, c); }
  quad(a, b, c, d) { this.i.push(a, b, d, a, d, c); }        // a b on one row, c d on the next
  grid(rows, closed = false) {                              // rows: arrays of vertex ids
    for (let j = 0; j + 1 < rows.length; j++) {
      const A = rows[j], B = rows[j + 1], n = closed ? A.length : A.length - 1;
      for (let k = 0; k < n; k++) this.quad(A[k], A[(k + 1) % A.length], B[k], B[(k + 1) % B.length]);
    }
  }
  geo() {
    const P = this.p, R = this.r, I = this.i;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const ox = (P[a] + P[b] + P[c] - R[a] - R[b] - R[c]), oy = (P[a + 1] + P[b + 1] + P[c + 1] - R[a + 1] - R[b + 1] - R[c + 1]), oz = (P[a + 2] + P[b + 2] + P[c + 2] - R[a + 2] - R[b + 2] - R[c + 2]);
      if (nx * ox + ny * oy + nz * oz < 0) { const x = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = x; }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setIndex(I);
    g.computeVertexNormals();
    return g;
  }
}
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const mix = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// A tube along a polyline with per-point radii, optionally capped with
// rounded ends. ratio squashes the section (along the first frame axis).
function tube(pts, radii, radial = 7, { caps = true, ratio = 1, up = null } = {}) {
  const B = new Builder(), n = pts.length, R = (k) => (Array.isArray(radii) ? radii[k] : radii);
  const T = pts.map((_, k) => norm(sub(pts[Math.min(n - 1, k + 1)], pts[Math.max(0, k - 1)])));
  let N = norm(cross(T[0], up || (Math.abs(T[0][1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])));
  if (up) N = norm(sub(up, mul(T[0], dot(up, T[0]))));
  const rings = [];
  const ring = (c, t, nn, r) => {
    const b = cross(t, nn), ids = [];
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      ids.push(B.v(add(c, add(mul(nn, Math.cos(a) * r * ratio), mul(b, Math.sin(a) * r))), c));
    }
    return ids;
  };
  const frames = [];
  for (let k = 0; k < n; k++) {
    if (k > 0) { N = norm(sub(N, mul(T[k], dot(N, T[k])))); }
    frames.push(N.slice());
  }
  if (caps) {
    const r0 = R(0);
    const pole = B.v(sub(pts[0], mul(T[0], r0 * 0.92)), pts[0]);
    const c1 = ring(sub(pts[0], mul(T[0], r0 * 0.62)), T[0], frames[0], r0 * 0.78);
    for (let k = 0; k < radial; k++) B.tri(pole, c1[k], c1[(k + 1) % radial]);
    rings.push(c1);
  }
  for (let k = 0; k < n; k++) rings.push(ring(pts[k], T[k], frames[k], R(k)));
  if (caps) {
    const r1 = R(n - 1), e = pts[n - 1], t = T[n - 1];
    const c2 = ring(add(e, mul(t, r1 * 0.62)), t, frames[n - 1], r1 * 0.78);
    rings.push(c2);
    const pole = B.v(add(e, mul(t, r1 * 0.92)), e);
    for (let k = 0; k < radial; k++) B.tri(pole, c2[k], c2[(k + 1) % radial]);
  }
  B.grid(rings, true);
  return B.geo();
}
// Points on a circle arc in the XY plane around (cx, cy) at depth z:
// angle b = 0 at +sx (the back of the hand), increasing toward -Y.
const arc = (sx, cx, cy, z, R, b0, b1, n) => Array.from({ length: n + 1 }, (_, k) => { const b = mix(b0, b1, k / n); return [cx + sx * Math.cos(b) * R, cy - Math.sin(b) * R, z]; });
// A rounded box / pillow: superellipsoid with half-sizes s and roundness e (1 = ellipsoid).
function pillow(s, e = 0.5, ws = 12, hs = 8) {
  const g = new THREE.SphereGeometry(1, ws, hs);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const f = (x) => Math.sign(x) * Math.pow(Math.abs(x), e);
    p.setXYZ(i, f(p.getX(i)) * s[0], f(p.getY(i)) * s[1], f(p.getZ(i)) * s[2]);
  }
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  return g;
}
// A shell over an ellipsoid (centre c, radii A) from the crown down to an
// edge height that varies round the head; optional inner surface + rim.
// rmod(phi, theta) scales the outer radius (seams, ridges).
function shell(c, A, edgeY, nu, nv, thick, rmod = null) {
  const B = new Builder();
  const pt = (phi, v, scale, out = true) => {
    const ye = edgeY(phi), ct = clamp((ye - c[1]) / A[1], -0.98, 0.98), te = Math.acos(ct);
    const th = v * te, m = (rmod && out ? rmod(phi, th) : 1) * scale;
    return [c[0] + A[0] * Math.sin(th) * Math.sin(phi) * m, c[1] + A[1] * Math.cos(th) * m, c[2] + A[2] * Math.sin(th) * Math.cos(phi) * m];
  };
  const outer = [], inner = [];
  for (let j = 0; j <= nv; j++) {
    const ro = [];
    for (let i = 0; i < nu; i++) ro.push(B.v(pt((i / nu) * Math.PI * 2, j / nv, 1), c));
    outer.push(ro);
  }
  B.grid(outer, true);
  if (thick > 0) {
    const si = 1 - thick / Math.min(A[0], A[2]), niv = Math.max(2, nv >> 1), niu = Math.max(8, nu >> 1);
    for (let j = 0; j <= niv; j++) {
      const ri = [];
      for (let i = 0; i < niu; i++) { const q = pt((i / niu) * Math.PI * 2, j / niv, si, false); ri.push(B.v(q, add(c, mul(sub(q, c), 2)))); }
      inner.push(ri);
    }
    B.grid(inner, true);
    // rim: outer edge -> inner edge (its own vertices so the edge stays crisp)
    const a = [], b = [];
    for (let i = 0; i < nu; i++) { const phi = (i / nu) * Math.PI * 2; const po = pt(phi, 1, 1), pi = pt(phi, 1, si, false); a.push(B.v(po, add(c, [0, A[1] * 2, 0]))); b.push(B.v(pi, add(c, [0, A[1] * 2, 0]))); }
    B.grid([a, b], true);
  }
  return B.geo();
}
// A thin curved slab (peaks, brims): mid-surface f(u, v) (u across, v out),
// its up-normal side, thickness h.
function slab(f, nu, nv, h, upRef) {
  const B = new Builder(), top = [], bot = [];
  for (let j = 0; j <= nv; j++) {
    const rt = [], rb = [];
    for (let i = 0; i <= nu; i++) {
      const p = f(i / nu, j / nv);
      rt.push(B.v(p, sub(p, mul(upRef, 1))));
      const q = sub(p, mul(upRef, h));
      rb.push(B.v(q, add(q, upRef)));
    }
    top.push(rt); bot.push(rb);
  }
  B.grid(top); B.grid(bot);
  // the outer lip (v = 1), facing away from the base row
  const la = [], lb = [];
  for (let i = 0; i <= nu; i++) {
    const r = B.p.slice(top[0][i] * 3, top[0][i] * 3 + 3);
    la.push(B.v(B.p.slice(top[nv][i] * 3, top[nv][i] * 3 + 3), r));
    lb.push(B.v(B.p.slice(bot[nv][i] * 3, bot[nv][i] * 3 + 3), r));
  }
  B.grid([la, lb]);
  return B.geo();
}

// ------------------------------------------------------------------ gear
// part(list, geom, bone, colour|slot, pos, rot, scale, { blend, ao })
export function buildGear(RIG, part, o, lod = 0) {
  const P = [];
  const q = lod ? 0.5 : 1, S = (n, m = 4) => Math.max(m, Math.round(n * q));
  const sk = RIG.skull || { c: [0, 1.675, 0.058], r: [0.095, 0.112, 0.122] };
  const hc = [sk.c[0] - RIG.J.head.x, sk.c[1] - RIG.J.head.y, sk.c[2] - RIG.J.head.z];   // skull centre, head-bone space
  const R = sk.r;
  if (o.headgear === 'helmet') helmet(P, part, hc, R, S, lod);
  else if (o.headgear === 'cap' || o.headgear === 'bare') cap(P, part, hc, R, S, lod);
  else if (o.headgear === 'hat') hat(P, part, hc, R, S, lod);
  if (o.gloves) for (const s of ['L', 'R']) (o.keeper ? keeperGlove : battingGlove)(P, part, s, S, lod);
  if (o.pads) for (const s of ['L', 'R']) pad(P, part, s, !!o.keeper, S, lod);
  return P;
}

function helmet(P, part, c, R, S, lod) {
  const A = [R[0] + 0.027, R[1] + 0.028, R[2] + 0.027], cc = [c[0], c[1] - 0.004, c[2] - 0.006];
  // edge: just above the brow at the front, over the ears at the sides, down to the nape
  const edgeY = (phi) => { const f = (1 - Math.cos(phi)) / 2; return c[1] + 0.012 - 0.115 * Math.pow(f, 0.85); };
  // two raised ridges front-to-back, like a vented shell
  const rmod = lod ? null : (phi, th) => 1 + 0.012 * (Math.exp(-Math.pow((Math.sin(phi) - 0.33) / 0.05, 2)) + Math.exp(-Math.pow((Math.sin(phi) + 0.33) / 0.05, 2))) * sstep(0.15, 0.6, th);
  part(P, shell(cc, A, edgeY, S(30, 12), S(10, 4), lod ? 0 : 0.011, rmod), 'head', KIT.headgear, [0, 0, 0], null, null, { ao: (x, y, z) => 0.8 + 0.2 * sstep(c[1] - 0.09, c[1] + 0.02, y) });
  // peak: from the front edge, out and a little down, drooping at the corners
  const y0 = edgeY(0);
  const peak = (u, v) => {
    const phi = (u * 2 - 1) * 0.47 * Math.PI, ct = clamp((edgeY(phi) - cc[1]) / A[1], -0.98, 0.98), st = Math.sqrt(1 - ct * ct);
    const base = [cc[0] + A[0] * st * Math.sin(phi), cc[1] + A[1] * ct - 0.002, cc[2] + A[2] * st * Math.cos(phi)];
    const L = 0.058 * Math.pow(Math.cos(phi * 0.98), 0.7) + 0.008;
    return [base[0] + Math.sin(phi) * L * v, base[1] - (0.012 * v + 0.01 * Math.pow(u * 2 - 1, 2) * v), base[2] + Math.cos(phi) * L * v];
  };
  part(P, slab(peak, S(16, 8), S(3, 2), 0.005, [0, 1, 0]), 'head', KIT.headgear, [0, 0, 0], null, null, { ao: 0.92 });
  // ear guards
  for (const sx of [-1, 1]) {
    part(P, pillow([0.017, 0.05, 0.044], 0.62, S(12, 6), S(8, 4)), 'head', KIT.headgear, [c[0] + sx * (R[0] + 0.021), c[1] - 0.058, c[2] + 0.012], [0.12, 0, 0], null, { ao: 0.9 });
    if (!lod) part(P, pillow([0.004, 0.012, 0.012], 0.8, 6, 4), 'head', KIT.trim, [c[0] + sx * (R[0] + 0.038), c[1] - 0.05, c[2] + 0.014]);
  }
  // steel grille: bars on a cylinder in front of the face, ends into the ear guards
  const Rg = R[2] + 0.04, zc = c[2] - 0.004;
  const bar = (dy, rIn = 0) => {
    const pts = [];
    const pm = 0.86;
    pts.push([c[0] - (R[0] + 0.014), c[1] + dy, c[2] + 0.045]);
    for (let k = 0; k <= 12; k++) { const phi = mix(-pm, pm, k / 12); pts.push([c[0] + Math.sin(phi) * (Rg - rIn) * 0.86, c[1] + dy, zc + Math.cos(phi) * (Rg - rIn)]); }
    pts.push([c[0] + (R[0] + 0.014), c[1] + dy, c[2] + 0.045]);
    return pts;
  };
  const bars = lod ? [-0.045, -0.12] : [-0.044, -0.077, -0.11, -0.143];
  bars.forEach((dy, i) => part(P, tube(bar(dy, i === bars.length - 1 ? 0.012 : 0), 0.0042, lod ? 4 : 6, { caps: false }), 'head', STEEL));
  if (!lod) {
    for (const phi of [-0.4, 0, 0.4]) {
      const pts = [];
      for (let k = 0; k <= 5; k++) { const dy = mix(-0.044, -0.143, k / 5), rin = k === 5 ? 0.012 : 0; pts.push([c[0] + Math.sin(phi) * (Rg - rin) * 0.86, c[1] + dy, zc + Math.cos(phi) * (Rg - rin)]); }
      part(P, tube(pts, 0.0038, 5, { caps: false }), 'head', STEEL);
    }
    // the grille's mounting under the peak
    part(P, tube(bar(-0.012), 0.0035, 5, { caps: false }), 'head', STEEL);
    // chin strap
    for (const sx of [-1, 1]) part(P, tube([[c[0] + sx * (R[0] + 0.004), c[1] - 0.09, c[2] + 0.0], [c[0] + sx * 0.06, c[1] - 0.15, c[2] + 0.06], [c[0], c[1] - 0.167, c[2] + 0.085]], 0.004, 4, { caps: false, ratio: 0.4 }), 'head', STRAP);
    // badge on the front of the shell
    part(P, pillow([0.026, 0.017, 0.004], 0.6, 10, 6), 'head', KIT.trim, [cc[0], cc[1] + A[1] * Math.cos(1.08), cc[2] + A[2] * Math.sin(1.08) + 0.0015], [-(Math.PI / 2 - 1.08), 0, 0]);
  }
}

function cap(P, part, c, R, S, lod) {
  const A = [R[0] + 0.014, R[1] + 0.012, R[2] + 0.017], cc = [c[0], c[1] - 0.002, c[2] + 0.002];
  const edgeY = (phi) => { const f = (1 - Math.cos(phi)) / 2; return c[1] + 0.03 - 0.065 * f; };
  // six panels: shallow seams
  const rmod = lod ? null : (phi, th) => { let m = 1; for (let k = 0; k < 6; k++) { const d = Math.atan2(Math.sin(phi - k * Math.PI / 3), Math.cos(phi - k * Math.PI / 3)); m -= 0.01 * Math.exp(-Math.pow(d / 0.035, 2)) * sstep(0.08, 0.3, th); } return m; };
  part(P, shell(cc, A, edgeY, S(36, 12), S(8, 4), lod ? 0 : 0.004, rmod), 'head', KIT.headgear, [0, 0, 0], null, null, { ao: (x, y, z) => 0.85 + 0.15 * sstep(c[1], c[1] + 0.06, y) });
  part(P, pillow([0.008, 0.005, 0.008], 0.8, 8, 4), 'head', KIT.headgear, [cc[0], cc[1] + A[1] + 0.002, cc[2]]);
  // curved peak
  const peak = (u, v) => {
    const s = u * 2 - 1, phi = s * 0.5 * Math.PI * 0.86, ct = clamp((edgeY(phi) - cc[1]) / A[1], -0.98, 0.98), st = Math.sqrt(1 - ct * ct);
    const base = [cc[0] + A[0] * st * Math.sin(phi), cc[1] + A[1] * ct - 0.001, cc[2] + A[2] * st * Math.cos(phi)];
    const L = 0.075 * Math.pow(Math.cos(phi * 0.92), 0.55);
    return [base[0] + Math.sin(phi) * L * v * 0.92, base[1] - L * v * 0.22 - 0.011 * s * s * v, base[2] + Math.cos(phi) * L * v];
  };
  part(P, slab(peak, S(16, 8), S(4, 2), 0.004, [0, 1, 0]), 'head', KIT.headgear, [0, 0, 0], null, null, { ao: 0.95 });
  if (!lod) part(P, pillow([0.016, 0.012, 0.003], 0.6, 10, 6), 'head', KIT.trim, [cc[0], cc[1] + A[1] * Math.cos(1.02), cc[2] + A[2] * Math.sin(1.02) + 0.0012], [-(Math.PI / 2 - 1.02), 0, 0]);
}

function hat(P, part, c, R, S, lod) {
  const base = c[1] + 0.028, rx = R[0] + 0.024, rz = R[2] + 0.022;
  const prof = [[1, 0], [0.99, 0.04], [0.97, 0.07], [0.92, 0.093], [0.75, 0.108], [0.45, 0.116], [0, 0.118]];
  const nu = S(32, 12);
  const B = new Builder(), rows = [];
  for (const [s, y] of prof) { const r = []; for (let i = 0; i < nu; i++) { const a = (i / nu) * Math.PI * 2; r.push(B.v([c[0] + Math.sin(a) * rx * s, base + y, c[2] + Math.cos(a) * rz * s], [c[0], base, c[2]])); } rows.push(r); }
  B.grid(rows, true);
  part(P, B.geo(), 'head', KIT.headgear, [0, 0, 0], null, null, { ao: (x, y, z) => 0.85 + 0.15 * sstep(base, base + 0.05, y) });
  // band
  const Bb = new Builder(), br = [];
  for (const [s, y] of [[1.012, 0.004], [1.01, 0.026]]) { const r = []; for (let i = 0; i < nu; i++) { const a = (i / nu) * Math.PI * 2; r.push(Bb.v([c[0] + Math.sin(a) * rx * s, base + y, c[2] + Math.cos(a) * rz * s], [c[0], base, c[2]])); } br.push(r); }
  Bb.grid(br, true);
  part(P, Bb.geo(), 'head', KIT.trim);
  // brim: out and down, a slight wave
  const W = 0.072;
  const brim = (u, v) => { const a = u * Math.PI * 2, e = v * W; return [c[0] + Math.sin(a) * (rx + e), base + 0.002 - 0.028 * Math.pow(v, 1.6), c[2] + Math.cos(a) * (rz + e)]; };
  const Bm = new Builder(), top = [], bot = [], nv = S(4, 2);
  for (let j = 0; j <= nv; j++) {
    const t = [], b = [];
    for (let i = 0; i < nu; i++) { const p = brim(i / nu, j / nv); t.push(Bm.v(p, [p[0], p[1] - 1, p[2]])); const pb = [p[0], p[1] - 0.004, p[2]]; b.push(Bm.v(pb, [p[0], p[1] + 1, p[2]])); }
    top.push(t); bot.push(b);
  }
  Bm.grid(top, true); Bm.grid(bot, true);
  const la = top[nv].map((id) => Bm.v(Bm.p.slice(id * 3, id * 3 + 3), [c[0], base, c[2]])), lb = bot[nv].map((id) => Bm.v(Bm.p.slice(id * 3, id * 3 + 3), [c[0], base, c[2]]));
  Bm.grid([la, lb], true);
  part(P, Bm.geo(), 'head', KIT.headgear, [0, 0, 0], null, null, { ao: (x, y, z) => (y < base - 0.003 ? 0.8 : 0.95) });
}

// Batting pad round the shin (knee frame). The front is a stack of vertical
// canes, the knee roll bulges over the knee, the thigh flap above it follows
// the thigh, side wings wrap round the leg; straps go round the back.
function pad(P, part, s, keeper, S, lod) {
  const knee = 'knee' + s, hip = 'hip' + s, sx = s === 'L' ? 1 : -1;
  const W = keeper ? 1.5 : 1.85;                        // wrap half-angle (rad)
  const yt = (a) => mix(keeper ? 0.1 : 0.215, keeper ? 0.04 : 0.07, sstep(0.55, 1.45, Math.abs(a)));
  const yb = (a) => mix(keeper ? -0.425 : -0.445, -0.385, sstep(0.25, 1.6, Math.abs(a)));
  const rin = (a, y) => { const k = 1 + (keeper ? 0 : 0.5 * sstep(0.06, 0.2, y)), w = sstep(0.6, 1.7, Math.abs(a)); return [mix(0.097, 0.088, w) * k, mix(0.1, 0.09, w) * k]; };
  const cz = 0.008;
  const canes = (a, y) => {
    const front = 1 - sstep(1.0, 1.25, Math.abs(a));
    const kneeZone = Math.exp(-Math.pow((y - 0.03) / 0.07, 2));
    const rib = (keeper ? 0.006 : 0.008) * Math.pow(0.5 + 0.5 * Math.cos(2 * Math.PI * a / (keeper ? 0.55 : 0.4)), 0.7);
    return rib * front * (1 - kneeZone);
  };
  const thick = (a, y) => {
    const front = 1 - sstep(0.95, 1.9, Math.abs(a));
    let t = 0.012 + (keeper ? 0.016 : 0.022) * front + canes(a, y);
    const kr = Math.exp(-Math.pow((y - 0.035) / (keeper ? 0.035 : 0.042), 2)) * Math.pow(Math.cos(clamp(a, -1.5, 1.5)), 2);
    t += (keeper ? 0.016 : 0.024) * kr;                                  // knee roll
    t -= 0.006 * Math.exp(-Math.pow((y + 0.03) / 0.012, 2)) * front;     // groove under it
    t -= 0.005 * Math.exp(-Math.pow((y - 0.105) / 0.012, 2)) * front * (keeper ? 0 : 1);
    return t;
  };
  const outer = (a, y) => {
    const [rx, rz] = rin(a, y), t = thick(a, y), inst = 0.022 * sstep(-0.37, -0.445, y) * Math.pow(Math.cos(clamp(a, -1.5, 1.5)), 2);
    return [Math.sin(a) * (rx + t), y, cz + Math.cos(a) * (rz + t) + inst];
  };
  const inner = (a, y) => { const [rx, rz] = rin(a, y), inst = 0.022 * sstep(-0.37, -0.445, y) * Math.pow(Math.cos(clamp(a, -1.5, 1.5)), 2); return [Math.sin(a) * rx, y, cz + Math.cos(a) * rz + inst]; };
  const nu = lod ? 10 : 24, nv = lod ? 10 : 24, B = new Builder();
  const at = (i, j, n, m) => { const a = mix(-W, W, i / n); return [a, mix(yb(a), yt(a), j / m)]; };
  const rowsO = [];
  for (let j = 0; j <= nv; j++) { const r = []; for (let i = 0; i <= nu; i++) { const [a, y] = at(i, j, nu, nv); r.push(B.v(outer(a, y), [0, y, cz])); } rowsO.push(r); }
  B.grid(rowsO);
  const ni = 10, nj = 8, rowsI = [];
  if (!lod) for (let j = 0; j <= nj; j++) { const r = []; for (let i = 0; i <= ni; i++) { const [a, y] = at(i, j, ni, nj); const p = inner(a, y); r.push(B.v(p, [Math.sin(a) * 0.5, y, cz + Math.cos(a) * 0.5])); } rowsI.push(r); }
  if (!lod) B.grid(rowsI);
  // rim all round: outer border -> inner surface at the same (a, y)
  const border = [];
  for (let i = 0; i <= nu; i++) border.push(at(i, 0, nu, nv));
  for (let j = 1; j <= nv; j++) border.push(at(nu, j, nu, nv));
  for (let i = nu - 1; i >= 0; i--) border.push(at(i, nv, nu, nv));
  for (let j = nv - 1; j >= 1; j--) border.push(at(0, j, nu, nv));
  const ra = [], rb = [];
  for (const [a, y] of border) { const po = outer(a, y), pi = inner(a, y), mid = [0, -0.18, cz]; ra.push(B.v(po, mid)); rb.push(B.v(pi, mid)); }
  B.grid([ra, rb], true);
  const geo = B.geo();
  const ao = (x, y, z) => {
    const a = Math.atan2(x, z - cz);
    const groove = 1 - canes(a, y) / (keeper ? 0.006 : 0.008);
    const r = Math.hypot(x, z - cz), rr = rin(a, y);
    const innerSide = r < Math.max(rr[0], rr[1]) + 0.004 ? 0.55 : 1;
    return innerSide * (1 - 0.22 * groove * (1 - sstep(1.0, 1.25, Math.abs(a))) * (1 - Math.exp(-Math.pow((y - 0.03) / 0.07, 2))))
      * (1 - 0.25 * Math.exp(-Math.pow((y + 0.03) / 0.015, 2)));
  };
  part(P, geo, knee, PAD_WHITE, [0, 0, 0], null, null, { blend: keeper ? null : { to: hip, y0: 0.07, y1: 0.15 }, ao });
  if (lod) return;
  // straps round the back of the leg, buckled on the outside
  const straps = keeper ? [-0.1, -0.31] : [0.15, -0.11, -0.32];
  for (const y of straps) {
    const bl = y > 0.1 ? { to: hip, y0: 0.07, y1: 0.15 } : null, th = y > 0.1 ? 0.03 : 0;
    const a0 = W * 0.84, pts = [];
    for (let k = 0; k <= 16; k++) {
      const a = mix(a0, 2 * Math.PI - a0, k / 16), back = Math.sin((k / 16) * Math.PI);
      const [rx, rz] = rin(a, y), t = thick(Math.atan2(Math.sin(a), Math.cos(a)), y);
      // from inside the wing, round the back of the trousers
      const rb = 0.108 + th + 0.008 * Math.exp(-Math.pow(y / 0.15, 2)), r = mix(rx + t * 0.6, rb, sstep(0, 0.35, back)), rzz = mix(rz + t * 0.6, rb, sstep(0, 0.35, back));
      pts.push([Math.sin(a) * r, y, cz + Math.cos(a) * rzz]);
    }
    part(P, tube(pts, 0.012, 4, { caps: false, ratio: 0.3, up: [0, 0, 1] }), knee, KIT.trim, [0, 0, 0], null, null, { blend: bl, ao: 0.85 });
    const ab = sx * W * 0.7, [rx, rz] = rin(ab, y), t = thick(ab, y);
    part(P, pillow([0.011, 0.013, 0.0035], 0.4, 6, 4), knee, 0xc8ccd2, [Math.sin(ab) * (rx + t + 0.002), y, cz + Math.cos(ab) * (rz + t + 0.002)], [0, ab, 0], null, { blend: bl });
  }
  // a team-coloured patch on the outside wing
  part(P, pillow([0.004, 0.035, 0.022], 0.5, 6, 4), knee, KIT.trim, [Math.sin(sx * 1.45) * 0.118, -0.12, cz + Math.cos(sx * 1.45) * 0.122], [0, sx * 1.45, 0]);
}

// Batting glove: a closed fist round the handle line (along Z at y = -PALM).
function battingGlove(P, part, s, S, lod) {
  const hand = 'hand' + s, sx = s === 'L' ? 1 : -1, G = PALM;
  const fingers = [[0.0332, 0.0119, 0.0296], [0.0112, 0.0124, 0.0302], [-0.0108, 0.0117, 0.0298], [-0.0318, 0.0103, 0.0282]];   // z, roll radius, wrap radius
  const aoF = (fz, rf) => (x, y, z) => {
    const d = Math.hypot(x, y + G), side = Math.min(1, Math.abs(z - fz) / rf);
    return clamp(0.62 + 0.38 * sstep(HANDLE_R + 0.004, 0.042, d), 0, 1) * (1 - 0.3 * side * side);
  };
  if (lod) {
    // distant: a padded fist + thumb
    part(P, pillow([0.034, 0.03, 0.046], 0.55, 8, 6), hand, WHITE, [0, -0.07, 0.001], null, null, { ao: 0.92 });
  } else {
    for (const [fz, rf, R] of fingers) {
      for (const [b0, b1] of [[-0.3, 1.18], [1.3, 2.42], [2.54, 3.85]]) {
        const pts = arc(sx, 0, -G, fz, R, b0, b1, 3);
        part(P, tube(pts, rf * (b0 > 2 ? 0.93 : 1), 6, { caps: true, up: [0, 0, 1] }), hand, WHITE, [0, 0, 0], null, null, { ao: aoF(fz, rf) });
      }
    }
    // padded back of the hand, palm, team stripe
    part(P, pillow([0.015, 0.043, 0.046], 0.45, 10, 6), hand, WHITE, [sx * 0.022, -0.037, 0.001], [0, 0, sx * 0.08], null, { ao: (x, y, z) => 0.85 + 0.15 * sstep(-0.07, -0.02, y) });
    part(P, pillow([0.013, 0.036, 0.043], 0.5, 8, 6), hand, LEATHER, [-sx * 0.017, -0.035, 0.0], null, null, { ao: 0.82 });
    // thumb: from the palm's index side round the palm side of the handle
    part(P, tube([[-sx * 0.014, -0.018, 0.038], [-sx * 0.028, -0.045, 0.05], [-sx * 0.031, -0.07, 0.056]], [0.0145, 0.014, 0.0132], 7), hand, WHITE, [0, 0, 0], null, null, { ao: 0.92 });
    part(P, tube([[-sx * 0.031, -0.074, 0.0565], [-sx * 0.026, -0.086, 0.058], [-sx * 0.016, -0.097, 0.058]], [0.0124, 0.012, 0.0112], 7), hand, WHITE);
  }
  // cuff: over the wrist and up the forearm, bending with the wrist
  const cuffN = S(16, 8), Bc = new Builder(), rows = [];
  const ys = [-0.014, 0.012, 0.04, 0.072];
  for (const y of ys) {
    const t = (y - ys[0]) / (ys[3] - ys[0]), rx = mix(0.034, 0.037, t), rz = mix(0.044, 0.046, t), r = [], ri = [];
    for (let i = 0; i < cuffN; i++) { const a = (i / cuffN) * Math.PI * 2; r.push(Bc.v([Math.cos(a) * rx, y, Math.sin(a) * rz], [0, y, 0])); }
    rows.push(r);
  }
  Bc.grid(rows, true);
  { const y = ys[3], r1 = [], r2 = [];
    for (let i = 0; i < cuffN; i++) { const a = (i / cuffN) * Math.PI * 2; r1.push(Bc.v([Math.cos(a) * 0.037, y, Math.sin(a) * 0.046], [0, y - 1, 0])); r2.push(Bc.v([Math.cos(a) * 0.031, y - 0.002, Math.sin(a) * 0.04], [0, y - 1, 0])); }
    Bc.grid([r1, r2], true);
    const r3 = []; for (let i = 0; i < cuffN; i++) { const a = (i / cuffN) * Math.PI * 2; r3.push(Bc.v([Math.cos(a) * 0.031, y - 0.02, Math.sin(a) * 0.04], [Math.cos(a), y, Math.sin(a)])); }
    const r2b = r2.map((id) => Bc.v(Bc.p.slice(id * 3, id * 3 + 3), [Bc.p[id * 3] * 2, y, Bc.p[id * 3 + 2] * 2]));
    Bc.grid([r2b, r3], true);
  }
  const blend = { to: 'elbow' + s, y0: -0.004, y1: 0.05 };
  part(P, Bc.geo(), hand, WHITE, [0, 0, 0], null, null, { blend, ao: (x, y, z) => 0.8 + 0.2 * sstep(-0.012, 0.01, y) });
  // velcro strap (team colour) with its tab on the back
  const Bs = new Builder(), sr = [];
  for (const y of [0.018, 0.034]) { const r = []; for (let i = 0; i < cuffN; i++) { const a = (i / cuffN) * Math.PI * 2; r.push(Bs.v([Math.cos(a) * 0.0388, y, Math.sin(a) * 0.0478], [0, y, 0])); } sr.push(r); }
  Bs.grid(sr, true);
  part(P, Bs.geo(), hand, KIT.trim, [0, 0, 0], null, null, { blend });
  if (!lod) part(P, pillow([0.0025, 0.0085, 0.012], 0.5, 8, 6), hand, KIT.trim, [sx * 0.039, 0.026, -0.016], null, null, { blend });
}

// Keeping glove: a big open padded mitt, webbed thumb, long cuff.
function keeperGlove(P, part, s, S, lod) {
  const hand = 'hand' + s, sx = s === 'L' ? 1 : -1;
  part(P, pillow([0.027, 0.088, 0.056], 0.62, S(14, 8), S(12, 6)), hand, WHITE, [0, -0.108, 0.004], null, null, { ao: (x, y, z) => 0.85 + 0.15 * sstep(-0.2, -0.1, y) });
  part(P, pillow([0.011, 0.072, 0.05], 0.55, S(10, 6), S(10, 5)), hand, TAN, [-sx * 0.02, -0.11, 0.004], null, null, { ao: 0.88 });
  for (const fz of [-0.036, -0.012, 0.012, 0.036]) {
    if (lod) continue;
    part(P, tube([[sx * 0.021, -0.062, fz], [sx * 0.021, -0.1, fz], [sx * 0.019, -0.128, fz]], 0.013, 7), hand, WHITE, [0, 0, 0], null, null, { ao: (x, y, z) => 1 - 0.3 * Math.pow(Math.min(1, Math.abs(z - fz) / 0.013), 2) });
    part(P, tube([[sx * 0.017, -0.14, fz], [sx * 0.01, -0.172, fz], [sx * 0.0, -0.19, fz]], 0.0122, 7), hand, WHITE, [0, 0, 0], null, null, { ao: (x, y, z) => 1 - 0.3 * Math.pow(Math.min(1, Math.abs(z - fz) / 0.013), 2) });
  }
  if (!lod) part(P, pillow([0.005, 0.04, 0.042], 0.5, 8, 6), hand, KIT.trim, [sx * 0.03, -0.05, 0.003]);
  const thumb = [[-sx * 0.008, -0.03, 0.052], [-sx * 0.016, -0.07, 0.074], [-sx * 0.02, -0.105, 0.088]];
  part(P, tube(thumb, [0.0175, 0.0165, 0.015], lod ? 5 : 8), hand, WHITE, [0, 0, 0], null, null, { ao: 0.92 });
  if (!lod) {
    // webbing between thumb and forefinger (both faces)
    const Bw = new Builder(), w1 = [], w2 = [];
    for (let k = 0; k <= 4; k++) { const t = k / 4; const a = [mix(-sx * 0.012, -sx * 0.018, t), mix(-0.05, -0.1, t), mix(0.06, 0.08, t)], b = [mix(0, 0, t), mix(-0.06, -0.15, t), 0.05]; w1.push(Bw.v(a, [a[0] + sx, a[1], a[2]])); w2.push(Bw.v(b, [b[0] + sx, b[1], b[2]])); }
    Bw.grid([w1, w2]);
    const v1 = [], v2 = [];
    for (let k = 0; k <= 4; k++) { const t = k / 4; const a = [mix(-sx * 0.012, -sx * 0.018, t), mix(-0.05, -0.1, t), mix(0.06, 0.08, t)], b = [0, mix(-0.06, -0.15, t), 0.05]; v1.push(Bw.v(a, [a[0] - sx, a[1], a[2]])); v2.push(Bw.v(b, [b[0] - sx, b[1], b[2]])); }
    Bw.grid([v1, v2]);
    part(P, Bw.geo(), hand, TAN);
  }
  // long cuff with a team band
  const cuffN = S(18, 8), Bc = new Builder(), rows = [];
  for (const [y, rx, rz] of [[-0.03, 0.04, 0.052], [0.02, 0.043, 0.054], [0.078, 0.046, 0.056]]) { const r = []; for (let i = 0; i < cuffN; i++) { const a = (i / cuffN) * Math.PI * 2; r.push(Bc.v([Math.cos(a) * rx, y, Math.sin(a) * rz], [0, y, 0])); } rows.push(r); }
  Bc.grid(rows, true);
  const blend = { to: 'elbow' + s, y0: -0.01, y1: 0.05 };
  part(P, Bc.geo(), hand, WHITE, [0, 0, 0], null, null, { blend, ao: 0.9 });
  const Bs = new Builder(), sr = [];
  for (const y of [0.04, 0.066]) { const r = []; for (let i = 0; i < cuffN; i++) { const a = (i / cuffN) * Math.PI * 2; r.push(Bs.v([Math.cos(a) * 0.0475, y, Math.sin(a) * 0.0575], [0, y, 0])); } sr.push(r); }
  Bs.grid(sr, true);
  part(P, Bs.geo(), hand, KIT.trim, [0, 0, 0], null, null, { blend });
}
