// The ball: leather hemispheres joined by a raised seam of six stitched rows,
// the quarter seams, the maker's gold stamp (an invented maker), lacquer that
// shines on one half and a scuffed, duller other half (setWear: an old ball).
// The seam lies in the mesh's local XZ plane (normal +Y) - where the physics
// and the bowling code (bowling.js seam quaternion) put it.
import * as THREE from 'three';

// Latitudes (deg), dense across the seam so its ridge is real geometry.
const LATS = [-90, -72, -56, -41, -28, -17, -9, -4.4, -2.2, 0, 2.2, 4.4, 9, 17, 28, 41, 56, 72, 90];
const LONS = 32;
// Seam profile: the two stitched ridges stand ~0.6 mm proud, the join between them a little lower.
const bulge = (lat) => { const a = Math.abs(lat); return a < 1 ? 0.00042 : a < 3 ? 0.0006 : a < 5 ? 0.00018 : 0; };

export function ballGeometry(r) {
  const pos = [], nrm = [], uv = [], idx = [];
  for (let j = 0; j < LATS.length; j++) {
    const la = LATS[j] * Math.PI / 180, rr = r + bulge(LATS[j]);
    for (let i = 0; i <= LONS; i++) {
      const lo = (i / LONS) * Math.PI * 2;
      const x = Math.cos(la) * Math.cos(lo), y = Math.sin(la), z = -Math.cos(la) * Math.sin(lo);
      pos.push(x * rr, y * rr, z * rr); nrm.push(x, y, z);
      uv.push(i / LONS, (LATS[j] + 90) / 180);
    }
  }
  const V = LONS + 1;
  for (let j = 0; j < LATS.length - 1; j++) for (let i = 0; i < LONS; i++) {
    const a = j * V + i, b = a + 1, c = a + V, d = c + 1;
    if (j > 0) idx.push(a, b, d);
    if (j < LATS.length - 2) idx.push(a, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();                 // (the ridge shades as a ridge)
  // the u seam's two copies share a normal; the poles point straight out
  const n = g.attributes.normal;
  for (let j = 0; j < LATS.length; j++) {
    const a = j * V, b = a + LONS;
    if (j === 0 || j === LATS.length - 1) { for (let i = 0; i <= LONS; i++) n.setXYZ(a + i, 0, j === 0 ? -1 : 1, 0); continue; }
    const x = n.getX(a) + n.getX(b), y = n.getY(a) + n.getY(b), z = n.getZ(a) + n.getZ(b), l = Math.hypot(x, y, z) || 1;
    n.setXYZ(a, x / l, y / l, z / l); n.setXYZ(b, x / l, y / l, z / l);
  }
  return g;
}

// Colour (1024 x 512, equirectangular: v = 0.5 is the seam) and a small
// relief/wear map (R: stitch relief for the bump, G: the scuffed half).
const KINDS = {
  white: { leather: '#f3efe4', shade: 'rgba(120,108,88,', stitch: '#2c3036', stitchHi: 'rgba(160,170,180,0.55)', quarter: 'rgba(150,140,120,0.5)', seamBed: '#e2dccd', scuff: [0.74, 0.70, 0.62] },
  red: { leather: '#8f1d18', shade: 'rgba(40,6,4,', stitch: '#efe6d2', stitchHi: 'rgba(255,255,255,0.6)', quarter: 'rgba(60,10,8,0.6)', seamBed: '#7a1612', scuff: [0.55, 0.30, 0.26] },
};
const _maps = {};
function ballMaps(kind) {
  if (_maps[kind]) return _maps[kind];
  const K = KINDS[kind] || KINDS.white;
  const Wc = 1024, Hc = 512;
  const c = document.createElement('canvas'); c.width = Wc; c.height = Hc;
  const g = c.getContext('2d');
  const b = document.createElement('canvas'); b.width = 512; b.height = 256;
  const h = b.getContext('2d');
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const V = (lat) => (1 - (lat + 90) / 180) * Hc;     // canvas y of a latitude (north = top)
  g.fillStyle = K.leather; g.fillRect(0, 0, Wc, Hc);
  // Leather grain: soft mottling and pores.
  for (let i = 0; i < 1800; i++) { g.fillStyle = K.shade + (0.02 + rnd() * 0.05) + ')'; const s = 2 + rnd() * 5; g.fillRect(rnd() * Wc, rnd() * Hc, s, s * 0.7); }
  for (let i = 0; i < 6000; i++) { g.fillStyle = K.shade + (0.05 + rnd() * 0.08) + ')'; g.fillRect(rnd() * Wc, rnd() * Hc, 1, 1); }
  // Quarter seams: north half on u = .25/.75, south half on u = 0/.5 (a four-piece ball).
  const quarter = (x, y0, y1) => {
    g.strokeStyle = K.quarter; g.lineWidth = 1.6; g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y1); g.stroke();
    g.fillStyle = K.quarter;
    for (let y = Math.min(y0, y1); y < Math.max(y0, y1); y += 7) { g.fillRect(x - 4, y, 1.6, 1.6); g.fillRect(x + 2.6, y + 3.5, 1.6, 1.6); }
  };
  const yN = V(6), yS = V(-6);
  for (const x of [0.25, 0.75]) quarter(x * Wc, yN, 0);
  for (const x of [0, 0.5, 1]) quarter(x * Wc, yS, Hc);
  // The seam: a bed of slightly darker leather, the join line, three rows of stitches each side.
  g.fillStyle = K.seamBed; g.fillRect(0, V(5.4), Wc, V(-5.4) - V(5.4));
  g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, V(0) - 1, Wc, 2);
  const ROWS = [1.5, 2.9, 4.3], STEP = 12;
  h.fillStyle = '#000'; h.fillRect(0, 0, 512, 256);
  for (const side of [1, -1]) for (let k = 0; k < 3; k++) {
    const y = V(side * ROWS[k]), off = (k % 2) * STEP / 2;
    for (let x = off; x < Wc + STEP; x += STEP) {
      // each stitch: a slanted thread with a highlight on top and a hole at each end
      const x0 = x, x1 = x + STEP * 0.62, y0 = y - side * 1.6, y1 = y + side * 1.6;
      g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 3.4; g.beginPath(); g.moveTo(x0, y0 + 0.8); g.lineTo(x1, y1 + 0.8); g.stroke();
      g.strokeStyle = K.stitch; g.lineWidth = 2.4; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      g.strokeStyle = K.stitchHi; g.lineWidth = 0.8; g.beginPath(); g.moveTo(x0 + 0.5, y0 - 0.6); g.lineTo(x1 - 0.5, y1 - 0.6); g.stroke();
      h.strokeStyle = '#fff'; h.lineWidth = 1.4; h.beginPath(); h.moveTo(x0 / 2, y0 / 2); h.lineTo(x1 / 2, y1 / 2); h.stroke();
    }
  }
  // The maker's stamp (gold foil, a bit worn) on the north half, between the
  // quarter seams; a smaller one on the south half. Stretched 1/cos(lat) so it
  // reads round on the ball.
  const stamp = (u, lat, big) => {
    const cx = u * Wc, cy = V(lat), sx = 1 / Math.cos(lat * Math.PI / 180);
    g.save(); g.translate(cx, cy); g.scale(sx, 1);
    const GOLD = '#c99a2e', R = big ? 34 : 24;
    g.strokeStyle = GOLD; g.lineWidth = 2.2; g.beginPath(); g.ellipse(0, 0, R * 1.7, R, 0, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 1; g.beginPath(); g.ellipse(0, 0, R * 1.55, R * 0.86, 0, 0, Math.PI * 2); g.stroke();
    g.fillStyle = GOLD; g.textAlign = 'center'; g.textBaseline = 'middle';
    if (big) {
      g.font = '900 19px system-ui, Arial, sans-serif'; g.fillText('HALCYON', 0, -2);
      g.font = '700 9px system-ui, Arial, sans-serif'; g.fillText('★ PRO 156 g ★', 0, 15);
      // little chevron crest above the name
      g.beginPath(); g.moveTo(-8, -22); g.lineTo(0, -14); g.lineTo(8, -22); g.lineTo(5, -22); g.lineTo(0, -17.5); g.lineTo(-5, -22); g.closePath(); g.fill();
    } else {
      g.font = '800 11px system-ui, Arial, sans-serif'; g.fillText('LIMITED OVERS', 0, -3);
      g.font = '700 8px system-ui, Arial, sans-serif'; g.fillText('CREASE · 4 PIECE', 0, 9);
    }
    g.restore();
    // foil worn through in flecks
    for (let i = 0; i < 70; i++) { g.fillStyle = K.leather; g.fillRect(cx + (rnd() - 0.5) * R * 3.6 * sx, cy + (rnd() - 0.5) * R * 2, 1.5, 1.5); }
  };
  stamp(0.5, 38, true);
  stamp(0.25, -36, false);
  // Relief map: G = the scuffed half (south), patchy.
  const img = h.getImageData(0, 0, 512, 256), d = img.data;
  for (let y = 0; y < 256; y++) for (let x = 0; x < 512; x++) {
    const lat = 90 - (y + 0.5) * 180 / 256;
    const half = Math.min(1, Math.max(0, (-lat + 8) / 20));
    const T = Math.PI * 2 / 512;                // (periodic across the u seam)
    const n = 0.55 + 0.45 * Math.sin(x * T * 9 + Math.sin(y * 0.07) * 3) * Math.sin(y * 0.13 + Math.cos(x * T * 4) * 2);
    d[(y * 512 + x) * 4 + 1] = Math.round(255 * half * Math.min(1, Math.max(0, n + (rnd() - 0.5) * 0.4)));
  }
  h.putImageData(img, 0, 0);
  const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4;
  const relief = new THREE.CanvasTexture(b); relief.anisotropy = 2;
  return (_maps[kind] = { map, relief, scuff: K.scuff });
}

// Phong with the relief as a bump map; the scuffed half (relief G) loses its
// shine and greys toward worn leather as `wear` goes up.
export function ballMaterial(kind = 'white') {
  const M = ballMaps(kind);
  const wear = { value: 0.3 };
  const m = new THREE.MeshPhongMaterial({ map: M.map, bumpMap: M.relief, bumpScale: 1.6, color: 0xffffff, emissive: 0x1c1c1c, shininess: 60, specular: 0x6a6a6a });
  m.userData.wear = wear;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uWear = wear;
    sh.uniforms.uScuff = { value: new THREE.Color().setRGB(...M.scuff) };
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uWear;\nuniform vec3 uScuff;\nfloat ballRough = 0.0;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        ballRough = texture2D( bumpMap, vBumpMapUv ).g * uWear;
        diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * uScuff, ballRough );`)
      .replace('#include <specularmap_fragment>', `#include <specularmap_fragment>
        specularStrength *= 1.0 - 0.85 * clamp( ballRough * 1.6, 0.0, 1.0 );`);
  };
  m.customProgramCacheKey = () => 'ball-wear';
  return m;
}
