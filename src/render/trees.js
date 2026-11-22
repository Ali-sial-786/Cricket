// The trees on the grass banks (90-130 m): crowns of alpha-tested leaf-cluster cards over a
// dark core (stadium.js keeps the trunks and the cores in its merged mesh). One draw for all of
// them: one small leaf atlas (four cluster cards: ragged outlines, darker inside and below), the
// cards' normals pointing out from the crown's middle so the sun models it as a volume, a baked
// tint a vertex (darker low and inside, per-tree hue). Alpha to coverage under MSAA keeps the
// silhouettes soft instead of sparkling; the atlas is mipmapped.
import * as THREE from 'three';

function mulberry(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// 512 x 512: four 256 cells, each a cluster of leaves inside an irregular outline.
let _leafTex = null;
export function leafTexture() {
  if (_leafTex) return _leafTex;
  const S = 512, C = 256, r = mulberry(909);
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  for (let cell = 0; cell < 4; cell++) {
    const ox = (cell % 2) * C, oy = Math.floor(cell / 2) * C;
    // the outline: a union of lobes
    const lobes = [];
    for (let i = 0; i < 9 + Math.floor(r() * 6); i++) { const a = r() * Math.PI * 2, d = r() * 62; lobes.push([C / 2 + Math.cos(a) * d, C / 2 + Math.sin(a) * d * 0.85, 30 + r() * 36]); }
    const inside = (x, y) => { let best = -1; for (const [lx, ly, lr] of lobes) best = Math.max(best, 1 - Math.hypot(x - lx, y - ly) / lr); return best; };
    // a dark, dense heart so the cluster is never see-through in the middle
    for (const [lx, ly, lr] of lobes) { g.fillStyle = 'rgb(40,58,30)'; g.beginPath(); g.arc(ox + lx, oy + ly, lr * 0.62, 0, Math.PI * 2); g.fill(); }
    // leaves: darker deep inside and low, lighter toward the top and the rim
    for (let i = 0; i < 1300; i++) {
      const x = 8 + r() * (C - 16), y = 8 + r() * (C - 16), k = inside(x, y);
      if (k < 0 || (k < 0.18 && r() < 0.45)) continue;                    // (a ragged edge, not a circle)
      const up = 1 - y / C, l = 0.42 + 0.38 * up + 0.25 * (1 - k) + (r() - 0.5) * 0.22;
      const R = Math.round(70 * l + 10), G = Math.round(112 * l + 14), B = Math.round(48 * l + 8);
      g.fillStyle = `rgb(${R},${G},${B})`;
      g.beginPath(); g.ellipse(ox + x, oy + y, 3 + r() * 4, 1.6 + r() * 2.2, r() * Math.PI, 0, Math.PI * 2); g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 2;
  _leafTex = t;
  return t;
}

// specs: [{ x, y, z (in the parent's frame), h (height), crownR, kind: 'broad'|'poplar'|'conifer', tint: [r,g,b] linear, seed }]
export function buildFoliage(specs, sunDir) {
  const pos = [], nrm = [], uv = [], col = [], idx = [];
  const sun = new THREE.Vector3(sunDir.x, 0, sunDir.z).normalize();
  const v = new THREE.Vector3(), n = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  for (const T of specs) {
    const r = mulberry(T.seed);
    const broad = T.kind === 'broad', pop = T.kind === 'poplar', con = T.kind === 'conifer';
    // the crown: an ellipsoid round (cx, cy, cz) with radii (rx, ry, rx); a cone for the conifer
    const rx = T.crownR * (pop ? 0.62 : con ? 0.9 : 1.05), ry = pop ? T.h * 0.4 : con ? T.h * 0.42 : T.crownR * 0.82;
    const cx = T.x, cz = T.z, cy = T.y + (pop ? T.h * 0.58 : con ? T.h * 0.52 : T.h * 0.66);
    const N = broad ? 40 : con ? 44 : 34;
    for (let i = 0; i < N; i++) {
      // a point in the outer part of the crown (cards on the surface, a few inside); the conifer's
      // on a cone, in tiers that shrink toward the tip
      const a = r() * Math.PI * 2, d = 0.6 + 0.4 * Math.sqrt(r());
      let px, py, pz, taper = 1;
      if (con) {
        const hh = Math.pow(r(), 0.8), rr = rx * (1 - hh * 0.9);
        px = cx + Math.cos(a) * rr * d; pz = cz + Math.sin(a) * rr * d; py = cy - ry + hh * ry * 2; taper = 1 - hh * 0.6;
      } else {
        const e = Math.acos(1 - 2 * Math.pow(r(), 0.85));
        const ux = Math.sin(e) * Math.cos(a), uz = Math.sin(e) * Math.sin(a);
        let uy = Math.cos(e);
        if (broad && uy < -0.35) uy = -0.35 + (uy + 0.35) * 0.3;          // (a flatter underside)
        px = cx + ux * rx * d; py = cy + uy * ry * d * 0.92; pz = cz + uz * rx * d;
        taper = 1 - 0.45 * Math.max(0, uy) * (pop ? 1.3 : 1);             // (small at the crown's top: no flecks off the tip)
      }
      // the card stands nearly upright facing out from the middle (cards lying flat read as slivers
      // floating off the crown from the side), turned at random about that
      let hx = px - cx, hz = pz - cz;
      const hl = Math.hypot(hx, hz);
      if (hl < 0.15 * rx) { hx = Math.cos(a); hz = Math.sin(a); } else { hx /= hl; hz /= hl; }
      n.set(hx, 0.35 + 0.25 * (py - cy) / ry, hz).normalize();
      t1.crossVectors(up, n).normalize();
      t2.crossVectors(n, t1);
      const rot = r() * Math.PI * 2, cr = Math.cos(rot), sr = Math.sin(rot);
      const ax = t1.clone().multiplyScalar(cr).addScaledVector(t2, sr), ay = t1.clone().multiplyScalar(-sr).addScaledVector(t2, cr);
      const s = T.crownR * (pop ? 0.5 : con ? 0.55 : 0.66) * (0.75 + r() * 0.5) * taper;
      const cell = Math.floor(r() * 4), u0 = (cell % 2) * 0.5, v0 = 1 - Math.floor(cell / 2) * 0.5 - 0.5;
      // baked tint: darker low and deep, lighter up top and on the sun's side; a per-card wobble
      const hgt = Math.min(1, Math.max(0, (py - (cy - ry)) / (2 * ry))), depth = d, sunSide = 0.5 + 0.5 * (n.x * sun.x + n.z * sun.z);
      const f = (0.62 + 0.32 * hgt + 0.18 * (depth - 0.55) / 0.45) * (0.88 + 0.22 * sunSide) * (0.9 + r() * 0.2);
      const base = pos.length / 3;
      for (const [qx, qy, qu, qv] of [[-1, -1, 0, 0], [1, -1, 0.5, 0], [1, 1, 0.5, 0.5], [-1, 1, 0, 0.5]]) {
        v.set(px, py, pz).addScaledVector(ax, qx * s).addScaledVector(ay, qy * s);
        pos.push(v.x, v.y, v.z);
        // (each corner's normal leans out from the crown's middle: the card shades with the volume)
        const nn = new THREE.Vector3(v.x - cx, (v.y - cy) * 0.7 + 0.2 * ry, v.z - cz).normalize();
        nrm.push(nn.x, nn.y, nn.z);
        uv.push(u0 + qu, v0 + qv);
        col.push(T.tint[0] * f, T.tint[1] * f, T.tint[2] * f);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const mat = new THREE.MeshLambertMaterial({ map: leafTexture(), vertexColors: true, alphaTest: 0.5, alphaToCoverage: true, side: THREE.DoubleSide });
  // (both faces lit by the crown's outward normal: a card seen from behind is not a dark hole)
  mat.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n\tnormal = normalize( vNormal );'); };
  mat.customProgramCacheKey = () => 'foliage-v1';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'foliage';
  return mesh;
}
