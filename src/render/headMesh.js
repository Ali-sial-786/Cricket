// A new adult head for the athlete, generated at load: the source's head (a round cartoon one:
// a wide flat face, big eyes far apart, a low round cranium, a neck as wide as the jaw, ears that
// are barely there) is cut away above the collar and this one takes its place.
//
// The head is the zero set of a field built from a handful of smooth shapes (a cranium longer
// than wide with flatter temples, the midface and muzzle, the mandible from chin to angle and up
// the ramus, a brow ridge, the nose from nasion to tip with its wings, cheekbones, lips, the chin,
// the neck with the sternomastoids), with eye sockets and lids round the eyeballs. It is meshed by
// casting rays from a point inside it: rings round a vertical axis, crowded where the face is and
// at the front; normals are the field's gradient, so the surface is smooth with no seams. Each
// ear is its own small mesh (concha, antihelix, a helix rim that rolls forward, a lobe). Adult
// proportions: the eyes at mid-height, 63 mm apart, the face in thirds (brow, nose base, chin),
// the mouth a third of the way from the nose to the chin, a head 19 cm long and 15.5 cm wide.
// Skinned to the head and neck bones (and the chest where it goes into the collar); kit slot 5
// (skin): the hair is the skin's (humanoid.js, the per-player hairline in the skin branch).
import * as THREE from 'three';

const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
// signed distances (iq): an ellipsoid (approximate), a round cone / capsule, smooth min / max
function ell(px, py, pz, c, r) {
  const x = (px - c[0]) / r[0], y = (py - c[1]) / r[1], z = (pz - c[2]) / r[2];
  const k0 = Math.sqrt(x * x + y * y + z * z), k1 = Math.sqrt((x / r[0]) ** 2 + (y / r[1]) ** 2 + (z / r[2]) ** 2);
  return k1 > 1e-9 ? k0 * (k0 - 1) / k1 : -Math.min(r[0], r[1], r[2]);
}
function cone(px, py, pz, a, b, ra, rb) {
  const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2], qx = px - a[0], qy = py - a[1], qz = pz - a[2];
  const h = Math.min(1, Math.max(0, (qx * bx + qy * by + qz * bz) / (bx * bx + by * by + bz * bz)));
  const ux = qx - bx * h, uy = qy - by * h, uz = qz - bz * h;
  return Math.sqrt(ux * ux + uy * uy + uz * uz) - mix(ra, rb, h);
}
const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
const smax = (a, b, k) => -smin(-a, -b, k);

// L: landmarks (bind metres): E eye line, C chin, ex eye half-spacing, zE eyeball centre z, re eyeball radius.
export function headLandmarks(L) {
  const { E, C, zE, re } = L;
  const brow = E + 0.024, nose = (brow + C) / 2, mouth = nose - (nose - C) * 0.36;
  const zF = zE + re;                                // the front of the eyes
  const zfore = zF + 0.006, zback = zfore - 0.19;
  return { ...L, brow, nose, mouth, zF, top: E + 0.123, cran: { c: [0, E + 0.02, (zfore + zback) / 2], r: [0.0765, 0.103, (zfore - zback) / 2] } };
}

// The field: < 0 inside. eyes: carve the sockets and lids (only where there are eyeballs: the near model).
export function headField(H, eyes = true) {
  const { E, C, ex, zE, re, brow, nose, mouth, zF, cran } = H;
  const czN = zE - 0.1;                              // the neck's axis
  return (x, y, z) => {
    const ax = Math.abs(x);
    // cranium: temples flatter toward the front
    const tw = 1 - 0.1 * sstep(cran.c[2], cran.c[2] + cran.r[2], z) * sstep(E + 0.07, E + 0.0, y);
    let d = ell(ax / tw, y, z, cran.c, cran.r);
    // midface, muzzle, the soft tissue under the jaw
    d = smin(d, ell(ax, y, z, [0, E - 0.03, zE - 0.052], [0.056, 0.05, 0.065]), 0.02);
    d = smin(d, ell(ax, y, z, [0, mouth + 0.003, zE - 0.041], [0.044, 0.034, 0.045]), 0.024);   // (broad and flat: no snout, no creases at its sides)
    // full cheeks: a smooth convex surface from the cheekbone down to the jaw
    d = smin(d, ell(ax, y, z, [0.034, mouth + 0.012, zE - 0.03], [0.023, 0.032, 0.03]), 0.024);
    d = smin(d, ell(ax, y, z, [0, C + 0.013, zE - 0.045], [0.044, 0.014, 0.05]), 0.016);
    // the mandible: chin to angle, angle up the ramus
    const go = [0.048, C + 0.034, zE - 0.088];
    d = smin(d, cone(ax, y, z, [0.015, C + 0.012, zF - 0.02], go, 0.012, 0.013), 0.018);
    d = smin(d, cone(ax, y, z, go, [0.05, E - 0.028, zE - 0.098], 0.013, 0.011), 0.012);
    d = smin(d, ell(ax, y, z, [0, C + 0.014, zF - 0.021], [0.028, 0.017, 0.013]), 0.02);   // the chin
    // neck (to below the collar), the sternomastoids
    const nx = ax / 0.053, nz = (z - czN) / 0.056;
    let n = Math.sqrt(nx * nx + nz * nz) * 0.053 - 0.053;
    n = smax(n, y - (E - 0.01), 0.03);
    d = smin(d, n, 0.03);
    d = smin(d, cone(ax, y, z, [0.044, E - 0.045, zE - 0.128], [0.013, 1.45, zE - 0.058], 0.011, 0.012), 0.012);
    if (z < zE - 0.045 || y > brow + 0.03 || y < C - 0.01) return d;   // (the features below are all on the face)
    // brow ridge, cheekbones
    d = smin(d, ell(ax, y, z, [0, brow - 0.002, zF - 0.009], [0.052, 0.0095, 0.012]), 0.018);
    d = smin(d, ell(ax, y, z, [0.047, E - 0.024, zE - 0.017], [0.022, 0.014, 0.017]), 0.026);
    // nose: nasion to tip, the base, the wings
    d = smin(d, cone(ax, y, z, [0, E + 0.004, zF - 0.003], [0, nose + 0.01, zF + 0.0155], 0.0062, 0.0102), 0.009);
    d = smin(d, ell(ax, y, z, [0, nose + 0.0045, zF + 0.009], [0.0085, 0.0062, 0.0085]), 0.008);
    d = smin(d, ell(ax, y, z, [0.0115, nose + 0.0045, zF + 0.001], [0.0078, 0.0072, 0.008]), 0.009);
    // lips, the line between them
    d = smin(d, ell(ax, y, z, [0, mouth + 0.005, zF - 0.008], [0.022, 0.005, 0.0075]), 0.008);
    d = smin(d, ell(ax, y, z, [0, mouth - 0.0055, zF - 0.009], [0.02, 0.0056, 0.0075]), 0.008);
    d = smax(d, -ell(ax, y, z, [0, mouth - 0.0002, zF - 0.002], [0.024, 0.0009, 0.008]), 0.0025);
    if (eyes) {
      // sockets carved in front of each eyeball, lids over it with an almond opening
      d = smax(d, -ell(ax, y, z, [ex, E + 0.001, zE + 0.01], [0.017, 0.0115, 0.009]), 0.008);
      const dx = ax - ex, dy = y - E;
      const ox = dx / 0.0152, oy = (dy - 0.08 * dx) / (dy > 0 ? 0.0051 : 0.0058), open = Math.sqrt(ox * ox + oy * oy) - 1;   // < 0 in the almond
      let lid = Math.sqrt(dx * dx + dy * dy + (z - zE) * (z - zE)) - (re + 0.0017);
      if (open < 0 && z > zE - 0.002) lid = Math.max(lid, -open * 0.005);                         // (the opening)
      d = smin(d, lid, 0.003);
    }
    return d;
  };
}

// Mesh the field by rays from O: rings (theta from the top) of n points (phi round the vertical, 0 = front).
function rays(f, O, rows, n, thMax, dens) {
  const P = [];
  // rows crowded round the face (theta about 80..130 deg), columns crowded at the front
  const N = 400, cdf = [0];
  for (let i = 1; i <= N; i++) { const th = (i / N) * thMax; cdf.push(cdf[i - 1] + dens(th)); }
  const thAt = (u) => { const t = u * cdf[N]; let i = 1; while (i < N && cdf[i] < t) i++; return mix((i - 1) / N, i / N, (t - cdf[i - 1]) / (cdf[i] - cdf[i - 1])) * thMax; };
  // (bracketed round the last ray's distance first: neighbours are close, so few steps are needed)
  let tp = 0.1;
  const at = (dx, dy, dz, t) => f(O[0] + dx * t, O[1] + dy * t, O[2] + dz * t);
  const hit = (dx, dy, dz) => {
    let lo = tp * 0.8, hi = tp * 1.25, k = 15;
    if (!(at(dx, dy, dz, lo) < 0 && at(dx, dy, dz, hi) >= 0)) { lo = 0; hi = 0.32; k = 24; while (at(dx, dy, dz, hi) < 0 && hi < 1) hi *= 1.5; }
    for (; k > 0; k--) { const m = (lo + hi) / 2; if (at(dx, dy, dz, m) < 0) lo = m; else hi = m; }
    const t = tp = (lo + hi) / 2; P.push(O[0] + dx * t, O[1] + dy * t, O[2] + dz * t);
  };
  hit(0, 1, 0);
  for (let r = 1; r <= rows; r++) {
    const th = thAt(r / rows);
    for (let j = 0; j < n; j++) {
      const t = 2 * j / n - 1, ph = Math.PI * (0.42 * t + 0.58 * t * t * t);
      hit(Math.sin(th) * Math.sin(ph), Math.cos(th), Math.sin(th) * Math.cos(ph));
    }
  }
  const I = [];
  for (let j = 0; j < n; j++) I.push(0, 1 + j, 1 + (j + 1) % n);
  for (let r = 1; r < rows; r++) {
    const a = 1 + (r - 1) * n, b = 1 + r * n;
    for (let j = 0; j < n; j++) { const j1 = (j + 1) % n; I.push(a + j, b + j, a + j1, a + j1, b + j, b + j1); }
  }
  return { P, I };
}

// An ear (side s = +1 left / -1 right): rings from the concha out to the rim, the back joining the head.
function ear(H, s, lod, f) {
  const { E, brow, nose, zE } = H;
  const cy = (brow + nose) / 2 - 0.002, cz = zE - 0.103, a = 0.031, b = 0.0175;
  // the root: where the side of the head is at the ear's centre
  let lo = 0, hi = 0.12;
  for (let k = 0; k < 24; k++) { const m = (lo + hi) / 2; if (f(s * m, cy, cz) < 0) lo = m; else hi = m; }
  const rx = lo;
  const N = new THREE.Vector3(s, 0, -0.22).normalize();                 // out of the head, angled a little back
  const U = new THREE.Vector3(0, 1, 0.12).normalize(), V = new THREE.Vector3().crossVectors(N, U).multiplyScalar(s).normalize();   // up, back
  if (V.z > 0) V.negate();
  const A = new THREE.Vector3(s * (rx - 0.004), cy, cz);
  const na = lod ? 8 : 16, radial = lod ? [0.5, 1] : [0.25, 0.5, 0.72, 0.86, 0.95, 1];
  const pos = [], idx = [];
  const pt = (sr, al, h, shrink = 1) => {
    // outline: wider at the top, a lobe at the bottom
    const top = sstep(-0.2, 0.8, Math.cos(al)), lobe = sstep(0.4, 1, -Math.cos(al));
    const ra = a * (1 + 0.04 * top), rb = b * (1 + 0.12 * top - 0.25 * lobe);
    const p = A.clone().addScaledVector(U, Math.cos(al) * ra * sr * shrink - 0.004).addScaledVector(V, Math.sin(al) * rb * sr * shrink + 0.003);
    return p.addScaledVector(N, h).toArray();
  };
  // front: concha deep at the centre, the antihelix ridge, the helix rim rolled forward
  const hF = (sr) => 0.003 + 0.007 * sstep(0.35, 0.72, sr) - 0.002 * Math.exp(-(((sr - 0.86) / 0.06) ** 2)) + 0.003 * sstep(0.9, 1, sr);
  pos.push(pt(0, 0, hF(0)));
  for (const sr of radial) for (let k = 0; k < na; k++) pos.push(pt(sr, (k / na) * Math.PI * 2, hF(sr), sr > 0.97 ? 0.985 : 1));
  for (let k = 0; k < na; k++) idx.push(0, 1 + k, 1 + (k + 1) % na);
  for (let r = 1; r < radial.length; r++) { const p0 = 1 + (r - 1) * na, p1 = 1 + r * na; for (let k = 0; k < na; k++) { const k1 = (k + 1) % na; idx.push(p0 + k, p1 + k, p0 + k1, p0 + k1, p1 + k, p1 + k1); } }
  // back: from the rim (just behind it) into the head
  const rim = 1 + (radial.length - 1) * na, back = pos.length;
  for (let k = 0; k < na; k++) pos.push(pt(0.98, (k / na) * Math.PI * 2, 0.0005));
  const back2 = pos.length;
  for (let k = 0; k < na; k++) pos.push(pt(0.6, (k / na) * Math.PI * 2, -0.006));
  for (let k = 0; k < na; k++) { const k1 = (k + 1) % na; idx.push(rim + k, rim + k1, back + k, rim + k1, back + k1, back + k); idx.push(back + k, back + k1, back2 + k, back + k1, back2 + k1, back2 + k); }
  // wind every triangle outward from the ear's middle plane... front faces along +N, back along -N
  const P = pos.flat(), out = [];
  const c = A.clone().addScaledVector(N, 0.0035);
  for (let t = 0; t < idx.length; t += 3) {
    const [i0, i1, i2] = [idx[t], idx[t + 1], idx[t + 2]];
    const p0 = new THREE.Vector3().fromArray(P, i0 * 3), p1 = new THREE.Vector3().fromArray(P, i1 * 3), p2 = new THREE.Vector3().fromArray(P, i2 * 3);
    const nrm = new THREE.Vector3().crossVectors(p1.clone().sub(p0), p2.clone().sub(p0));
    const m = p0.clone().add(p1).add(p2).multiplyScalar(1 / 3);
    const isBack = i0 >= back || i1 >= back || i2 >= back;
    const want = isBack ? m.clone().sub(A).dot(N) < 0.001 ? -1 : 1 : 1;
    const side = nrm.dot(N) * want;
    if (isBack ? nrm.dot(m.clone().sub(c)) < 0 : side < 0) out.push(i0, i2, i1); else out.push(i0, i1, i2);
  }
  return { P, I: out };
}

// The head's geometry for a LOD: attributes as the model's parts (position, normal, colour, kit, skin).
// bones: { head, neck, chest } indices; neckY: the neck joint's height.
export function buildHead(H, lod, bones, neckY) {
  const f = headField(H, !lod);
  const O = [0, H.E - 0.01, H.zE - 0.07];
  const rows = lod ? 13 : 38, n = lod ? 22 : 64;
  const dens = (th) => 1 + 1.9 * Math.exp(-(((th - 1.85) / 0.42) ** 2)) + 0.6 * Math.exp(-(((th - 1.45) / 0.2) ** 2));
  const G = rays(f, O, rows, n, 2.86, dens);
  const parts = [{ P: G.P, I: G.I, ear: 0 }];
  for (const s of [1, -1]) { const e = ear(H, s, lod, f); parts.push({ P: e.P, I: e.I, ear: 1 }); }
  const pos = [], nrm = [], col = [], kit = [], si = [], sw = [], idx = [];
  const e = 1e-4;
  for (const p of parts) {
    const base = pos.length / 3, nv = p.P.length / 3;
    for (let v = 0; v < nv; v++) {
      const x = p.P[v * 3], y = p.P[v * 3 + 1], z = p.P[v * 3 + 2];
      pos.push(x, y, z);
      if (!p.ear) {
        const gx = f(x + e, y, z) - f(x - e, y, z), gy = f(x, y + e, z) - f(x, y - e, z), gz = f(x, y, z + e) - f(x, y, z - e), l = Math.hypot(gx, gy, gz) || 1;
        nrm.push(gx / l, gy / l, gz / l);
      } else nrm.push(0, 0, 0);
      col.push(1, p.ear, 1);                                       // (colour.g: an ear, no hair on it)
      // baked occlusion: the sockets, under the nose and the jaw, the ear's hollow, the neck under the chin
      const ax = Math.abs(x);
      let ao = 1 - 0.08 * Math.exp(-(((ax - H.ex) / 0.016) ** 2) - (((y - H.E) / 0.011) ** 2)) * sstep(H.zE - 0.01, H.zE + 0.01, z)
        - 0.25 * Math.exp(-((ax / 0.016) ** 2) - (((y - H.nose) / 0.004) ** 2)) * sstep(H.zF, H.zF + 0.012, z)
        - 0.3 * sstep(H.C + 0.006, H.C - 0.012, y) * sstep(H.zE - 0.07, H.zE - 0.02, z);
      if (p.ear) ao = 0.75 + 0.25 * sstep(0.003, 0.008, Math.abs(x) - 0.06);
      kit.push(5, Math.max(0.45, ao));
      // skin: the head down to the neck joint's band, the neck, the chest where it goes into the collar
      const th = sstep(neckY - 0.02, neckY + 0.05, y), cw = sstep(1.475, 1.445, y);
      const W = [[bones.head, th * (1 - cw)], [bones.neck, (1 - th) * (1 - cw)], [bones.chest, cw], [bones.head, 0]].sort((q, r) => r[1] - q[1]);
      for (let k = 0; k < 4; k++) { si.push(W[k][0]); sw.push(W[k][1]); }
    }
    for (const i of p.I) idx.push(base + i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('kit', new THREE.Float32BufferAttribute(kit, 2));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(si), 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  g.setIndex(idx);
  // the ears' normals from their own triangles (the head's are the field's gradient)
  { const N = g.attributes.normal, P = g.attributes.position, I = g.index.array, acc = new Float32Array(P.count * 3);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let t = 0; t < I.length; t += 3) {
      if (col[I[t] * 3 + 1] < 0.5) continue;
      a.fromBufferAttribute(P, I[t]); b.fromBufferAttribute(P, I[t + 1]); c.fromBufferAttribute(P, I[t + 2]);
      const nn = c.sub(b).cross(a.sub(b));
      for (let j = 0; j < 3; j++) { acc[I[t + j] * 3] += nn.x; acc[I[t + j] * 3 + 1] += nn.y; acc[I[t + j] * 3 + 2] += nn.z; }
    }
    for (let v = 0; v < P.count; v++) if (col[v * 3 + 1] > 0.5) { const l = Math.hypot(acc[v * 3], acc[v * 3 + 1], acc[v * 3 + 2]) || 1; N.setXYZ(v, acc[v * 3] / l, acc[v * 3 + 1] / l, acc[v * 3 + 2] / l); }
  }
  return g;
}

// Put the head in: eyes and mouth moved and sized for it, the source's head, hair cap and brows
// dropped, the new head added to every LOD; returns the landmarks (meta.skull set for the headgear).
export function replaceHead(lods, J, meta) {
  const B = meta.bones, bones = { head: B.indexOf('head'), neck: B.indexOf('neck'), chest: B.indexOf('chest') };
  const E = meta.eyeY, C = meta.chinY, re = 0.0118, ex = 0.0315;
  // the eyeballs: each side's present centre and size, to the new place and an adult size
  const eyes = lods[0].filter((p) => p.name === 'Details_Sclera' || p.name === 'Details_Iris' || p.name === 'Details_Pupil');
  const sc = eyes.find((p) => p.name === 'Details_Sclera');
  const box = (p, side) => { const P = p.geo.attributes.position, b = [9, 9, 9, -9, -9, -9]; for (let v = 0; v < P.count; v++) { if (Math.sign(P.getX(v)) !== side) continue; for (let c = 0; c < 3; c++) { const q = c ? c > 1 ? P.getZ(v) : P.getY(v) : P.getX(v); b[c] = Math.min(b[c], q); b[c + 3] = Math.max(b[c + 3], q); } } return b; };
  const zFront = box(sc, 1)[5], zE = zFront - re;
  const H = headLandmarks({ E, C, ex, zE, re });
  for (const side of [1, -1]) {
    const b = box(sc, side), r0 = (b[3] - b[0]) / 2, c0 = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, b[5] - r0], k = re / r0;
    const ib = box(eyes.find((p) => p.name === 'Details_Iris'), side), ic = [(ib[0] + ib[3]) / 2, (ib[1] + ib[4]) / 2];
    const ik = 0.0058 / ((ib[4] - ib[1]) / 2 * k);                   // (and the iris to an adult's 11.6 mm)
    for (const p of eyes) {
      const P = p.geo.attributes.position;
      for (let v = 0; v < P.count; v++) {
        if (Math.sign(P.getX(v)) !== side) continue;
        let x = P.getX(v), y = P.getY(v), z = P.getZ(v);
        if (p.name !== 'Details_Sclera') { x = ic[0] + (x - ic[0]) * ik; y = ic[1] + (y - ic[1]) * ik; }
        P.setXYZ(v, side * ex + (x - c0[0]) * k, E + (y - c0[1]) * k, zE + (z - c0[2]) * k);
      }
    }
  }
  // the mouth's inside, behind the new lips
  for (const L of lods) for (const p of L) {
    if (p.name !== 'Details_Mouth') continue;
    const P = p.geo.attributes.position; let y0 = 0, z1 = -9, x1 = 0;
    for (let v = 0; v < P.count; v++) { y0 += P.getY(v); z1 = Math.max(z1, P.getZ(v)); x1 = Math.max(x1, Math.abs(P.getX(v))); }
    y0 /= P.count;
    // (small and well back: the lips are closed, it only darkens the line between them)
    for (let v = 0; v < P.count; v++) P.setXYZ(v, P.getX(v) * 0.013 / x1, H.mouth + (P.getY(v) - y0) * 0.4, H.zF - 0.0155 + (P.getZ(v) - z1) * 0.5);
  }
  // drop the source's head: every triangle of the body above the collar on the head / neck bones
  for (const L of lods) for (const p of L) {
    if (p.name === 'HairCap' || p.name === 'Details_Hair') { p.optional = true; continue; }
    if (p.name !== 'Athlete_Body') continue;
    const g = p.geo, P = g.attributes.position, SI = g.attributes.skinIndex, SW = g.attributes.skinWeight, I = g.index.array, keep = [];
    const up = (v) => { if (P.getY(v) < 1.458) return false; let w = 0; for (let k = 0; k < 4; k++) { const b = SI.getComponent(v, k); if (b === bones.head || b === bones.neck) w += SW.getComponent(v, k); } return w > 0.3; };
    for (let t = 0; t < I.length; t += 3) if (!(up(I[t]) && up(I[t + 1]) && up(I[t + 2]))) keep.push(I[t], I[t + 1], I[t + 2]);
    g.setIndex(keep);
  }
  lods.forEach((L, lod) => L.push({ name: 'Head', optional: false, geo: buildHead(H, lod, bones, J.neck.y) }));
  // the skull the headgear fits round: the cranium, with the hair on it
  meta.skull = { c: H.cran.c.slice(), r: [H.cran.r[0] + 0.004, H.cran.r[1] + 0.003, H.cran.r[2] + 0.004] };
  meta.headTop = H.top;
  return H;
}
