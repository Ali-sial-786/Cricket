// The stadium bowl, built for Quest 3S: one Lambert material over one baked
// atlas for every static piece (tiers, seat rows, roof, pavilion, towers,
// screen frame, props), merged into eight sector meshes so the ones behind
// you are culled; the advertising boards and tier ribbons are one more mesh.
// Sun and sky visibility are baked per vertex (the roof's shadow, the dark
// under the roof and the upper tier, the back of the box level) and the
// shader scales the direct and the ambient light by them: shade without
// shadow maps. The same bake lights the crowd, which takes its seats from
// here (seatSpots).
//
//   ground plan (degrees round the ground from +z, the batting end, toward +x):
//     0 South End (behind the batter, sightscreen wedge ±10)   20-50 grass bank
//     80-100 the pavilion (members' terraces in front)          180 North End
//     (behind the bowler, sightscreen wedge)                   ~241 big screen
//     towers at 45, 135, 225, 315; roofs over the stands between them
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { KIND } from './crowd.js';

const D = Math.PI / 180;
function mulberry(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const angOf = (x, z) => { const a = Math.atan2(x, z) / D; return a < 0 ? a + 360 : a; };
const inArc = (a, a0, a1) => { a = ((a % 360) + 360) % 360; return a0 <= a1 ? a >= a0 && a < a1 : a >= a0 || a < a1; };

// ------------------------------------------------------------------ the plan
const R0 = CONFIG.field.groundRadius + 4;             // front wall (84 m)
export const BOWL = {
  wallR: R0 - 0.3, wallTop: 2.2,
  low: { r0: R0, y0: 1.32, rows: 15, depth: 0.82, rise: 0.42 },
  concourseR: 98.9, boxTop: 10.2, fasciaR: 97.4, fasciaTop: 12.2,
  up: { r0: 97.75, y0: 11.35, rows: 14, depth: 0.85, rise: 0.55 },
  backR: 109.65, top: 22.1, outerR: 110.85,
};
const L = BOWL.low, U = BOWL.up;
const lowEndR = L.r0 + L.rows * L.depth, lowEndY = L.y0 + (L.rows - 1) * L.rise;       // 96.3, 7.2
const upEndY = U.y0 + (U.rows - 1) * U.rise;                                              // 18.5
export const ROOF = { rF: 91.6, rB: 111.4, yB: 26.9, yF: 28.9, t: 0.6 };
const roofY = (r) => ROOF.yB + ((ROOF.rB - r) / (ROOF.rB - ROOF.rF)) * (ROOF.yF - ROOF.yB);
const ROOFS = [[322, 20], [50, 80], [100, 130], [140, 220], [252, 310]];
// Lookup tables by half degree: what stands where, which arcs are roofed.
const ROOFED = new Uint8Array(720).map((_, i) => (ROOFS.some(([a0, a1]) => inArc(i / 2 + 0.25, a0, a1)) ? 1 : 0));
const roofed = (a) => ROOFED[Math.floor(a * 2) % 720] === 1;
const BANK = [20, 50], PAV = [80, 100];
const WEDGES = [[350, 10], [170, 190]];                // behind the sightscreens: dark covers, nobody sits
const TOWERS = [45, 135, 225, 315];
const TV = [160, 200, 340, 270];                       // camera platforms on the upper tier front
const bayType = (b) => (b >= 2 && b <= 4 ? 'bank' : b >= 8 && b <= 9 ? 'pav' : 'stand');
const AISLE = 0.8;                                      // degrees

// ------------------------------------------------------------------ atlas
// Bands stacked down the texture (u repeats round the ground), multiplied by
// the vertex tint: seat backs and paint are drawn light grey and take the
// seat / paint colour; concrete, glass and banners keep their own (tint white).
const TEX = 1024;
const BAND = { SEATS: [0, 64], ROW: [72, 200], STEPS: [208, 336], PLAIN: [344, 408], CONC: [416, 544], GLASS: [552, 680], UNDER: [688, 752], PAV: [760, 888], GRASS: [896, 960], BANNER: [966, 1024] };
const vOf = (band, f) => 1 - (BAND[band][0] + f * (BAND[band][1] - BAND[band][0])) / TEX;   // f: 0 top of band .. 1 bottom
const TREAD = 84 / 128;                                 // ROW/STEPS: the tread is the top 84 px, the riser the rest
function stadiumAtlas() {
  const rand = mulberry(99);
  const cc = document.createElement('canvas'); cc.width = cc.height = TEX;
  const g = cc.getContext('2d');
  g.fillStyle = '#808080'; g.fillRect(0, 0, TEX, TEX);
  const band = (name, colour) => { const [y0, y1] = BAND[name]; g.fillStyle = colour; g.fillRect(0, y0, TEX, y1 - y0); };
  // Grain: one small tile of noise (written, not drawn speck by speck), laid over a band.
  const grain = document.createElement('canvas'); grain.width = grain.height = 128;
  {
    const gg = grain.getContext('2d'), im = gg.createImageData(128, 128);
    for (let i = 0; i < im.data.length; i += 4) { const v = rand() < 0.5 ? 255 : 0; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = Math.floor(rand() * rand() * 255); }
    gg.putImageData(im, 0, 0);
  }
  const grainPat = g.createPattern(grain, 'repeat');
  const noise = (y0, y1, n, a) => { g.save(); g.globalAlpha = Math.min(1, a * 3); g.fillStyle = grainPat; g.fillRect(0, y0, TEX, y1 - y0); g.restore(); void n; };
  const vgrad = (y0, y1, stops) => { const gr = g.createLinearGradient(0, y0, 0, y1); stops.forEach(([o, c]) => gr.addColorStop(o, c)); return gr; };
  const rr = (ctx, x, y, w, h, r) => { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); };

  // Seat backs: 16 to the width (0.5 m each), moulded plastic, lit from above.
  {
    const [y0, y1] = BAND.SEATS;
    band('SEATS', '#3a3c40');
    for (let i = 0; i < 16; i++) {
      const x = i * 64;
      g.fillStyle = vgrad(y0, y1, [[0, '#f4f4f4'], [0.12, '#e6e6e6'], [0.55, '#c4c4c4'], [1, '#8c8c8c']]);
      rr(g, x + 6, y0 + 5, 52, 56, 9); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(x + 10, y0 + 9, 44, 4);
      g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(x + 8, y0 + 40, 48, 3);
    }
  }
  // Seat rows (tread over riser), and the aisle steps.
  for (const name of ['ROW', 'STEPS']) {
    const [y0, y1] = BAND[name], yt = y0 + TREAD * 128;
    band(name, '#a19d95');
    g.fillStyle = vgrad(y0, yt, [[0, '#6f6c66'], [0.15, '#94918a'], [0.6, '#a6a29a'], [1, '#b4b0a8']]); g.fillRect(0, y0, TEX, yt - y0);
    g.fillStyle = vgrad(yt, y1, [[0, '#55534f'], [0.18, '#8a8780'], [1, '#97938b']]); g.fillRect(0, yt, TEX, y1 - yt);
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(0, yt - 4, TEX, 3);                         // nosing
    if (name === 'ROW') for (let i = 0; i < 16; i++) { g.fillStyle = 'rgba(30,30,30,0.5)'; g.fillRect(i * 64 + 14, y0 + 6, 6, 16); g.fillRect(i * 64 + 44, y0 + 6, 6, 16); }
    else {
      const mid = (y0 + yt) / 2;
      g.fillStyle = 'rgba(40,40,40,0.45)'; g.fillRect(0, mid, TEX, 5);
      g.fillStyle = '#d8b632'; g.fillRect(0, mid - 4, TEX, 4); g.fillRect(0, yt - 6, TEX, 5);
    }
    noise(y0, y1, 5000, 0.12);
  }
  band('PLAIN', '#eeeeee'); noise(...BAND.PLAIN, 1500, 0.05);
  // Concrete / painted panels: joints every 2 m, a little staining.
  {
    const [y0, y1] = BAND.CONC;
    band('CONC', '#cfccc6');
    for (let i = 0; i < 8; i++) { g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(i * 128, y0, 2, y1 - y0); }
    g.fillStyle = 'rgba(0,0,0,0.15)'; g.fillRect(0, y0 + 63, TEX, 2);
    for (let i = 0; i < 120; i++) { g.fillStyle = `rgba(0,0,0,${rand() * 0.06})`; g.fillRect(rand() * TEX, y0, 2 + rand() * 6, (y1 - y0) * (0.3 + rand() * 0.7)); }
    noise(y0, y1, 4000, 0.08);
  }
  // Glass of the boxes between the tiers: mullions every 1.5 m, sky in the top, warm rooms behind.
  {
    const [y0, y1] = BAND.GLASS;
    band('GLASS', '#26303a');
    g.fillStyle = vgrad(y0, y1, [[0, '#7f97ad'], [0.35, '#3b4a59'], [0.7, '#1f2830'], [1, '#2a333c']]); g.fillRect(0, y0, TEX, y1 - y0);
    for (let i = 0; i < 40; i++) { const x = rand() * TEX, w = 20 + rand() * 60; g.fillStyle = `rgba(255,214,150,${0.06 + rand() * 0.12})`; g.fillRect(x, y0 + 50 + rand() * 30, w, 18 + rand() * 25); }
    for (let i = 0; i < 60; i++) { const x = rand() * TEX; g.fillStyle = 'rgba(10,12,16,0.55)'; g.beginPath(); g.ellipse(x, y0 + 86, 5, 7, 0, 0, Math.PI * 2); g.fill(); g.fillRect(x - 7, y0 + 92, 14, 24); }
    for (let i = 0; i < 8; i++) { g.fillStyle = '#9aa1a8'; g.fillRect(i * 128, y0, 6, y1 - y0); g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(i * 128 + 1, y0, 2, y1 - y0); }
    g.fillStyle = '#8e959c'; g.fillRect(0, y0, TEX, 7); g.fillRect(0, y1 - 10, TEX, 10); g.fillRect(0, y0 + 40, TEX, 3);
    g.fillStyle = 'rgba(255,255,255,0.06)'; for (let i = 0; i < 30; i++) { const x = rand() * TEX; g.beginPath(); g.moveTo(x, y0); g.lineTo(x + 40, y0); g.lineTo(x - 30, y1); g.lineTo(x - 60, y1); g.fill(); }
  }
  // Roof deck seen from below: profiled sheet ribs running out to the edge, purlins across.
  {
    const [y0, y1] = BAND.UNDER;
    band('UNDER', '#c2c5ca');
    for (let x = 0; x < TEX; x += 16) { g.fillStyle = 'rgba(0,0,0,0.2)'; g.fillRect(x, y0, 4, y1 - y0); g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(x + 5, y0, 2, y1 - y0); }
    for (const f of [0.2, 0.5, 0.8]) { g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(0, y0 + f * 64 - 2, TEX, 4); }
    noise(y0, y1, 1500, 0.06);
  }
  // Pavilion storey: tall sash windows every 3 m in render, a string course below.
  {
    const [y0, y1] = BAND.PAV;
    band('PAV', '#f6f3ec');
    noise(y0, y1, 2500, 0.06);
    g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(0, y1 - 14, TEX, 3); g.fillStyle = 'rgba(255,255,255,0.4)'; g.fillRect(0, y1 - 11, TEX, 8);
    for (let i = 0; i < 8; i++) {
      const x = i * 128 + 32, w = 64, top = y0 + 18, h = 88;
      g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(x - 6, top - 6, w + 12, h + 14);
      g.fillStyle = '#f7f5ef'; g.fillRect(x - 4, top - 4, w + 8, h + 8);
      g.fillStyle = vgrad(top, top + h, [[0, '#5f7487'], [0.4, '#2c3946'], [1, '#1e262e']]); g.fillRect(x, top, w, h);
      g.fillStyle = '#f7f5ef'; g.fillRect(x + w / 2 - 2, top, 4, h); g.fillRect(x, top + h / 2 - 2, w, 4); g.fillRect(x, top + h / 4, w, 2); g.fillRect(x, top + (3 * h) / 4, w, 2);
      g.fillStyle = '#d9d2c2'; g.fillRect(x - 8, top + h + 4, w + 16, 6);
    }
  }
  band('GRASS', '#9c9c9c'); noise(...BAND.GRASS, 0, 0.3);
  // Fans' banners hung on the tier fronts (invented chants).
  {
    const [y0, y1] = BAND.BANNER;
    band('BANNER', '#202020');
    const items = [['COME ON BLUES', '#1f4fa8', '#fff'], ['HOWZAT!', '#f4f4f4', '#b3221c'], ['CREASE ARMY', '#14285a', '#f2c12e'], ['SIX & OUT', '#f2c12e', '#14285a'],
      ['BOWL HIM!', '#b3221c', '#fff'], ['BLUE TILL I DIE', '#f4f4f4', '#1f4fa8'], ['ROAR FOR THE BLUES', '#1f4fa8', '#f2c12e'], ['HI MUM!', '#2d8a57', '#fff']];
    let x = 0;
    for (const [txt, bg, fg] of items) {
      const w = 128;
      g.fillStyle = bg; g.fillRect(x + 3, y0 + 4, w - 6, y1 - y0 - 8);
      g.strokeStyle = fg; g.lineWidth = 3; g.strokeRect(x + 7, y0 + 8, w - 14, y1 - y0 - 16);
      g.fillStyle = fg; g.font = '900 20px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(txt, x + w / 2, (y0 + y1) / 2 + 1, w - 20);
      x += w;
    }
  }
  // Pad each band with its edge rows so mips do not bleed the neighbours in.
  const px = (ctx) => {
    for (const [y0, y1] of Object.values(BAND)) {
      if (y0 >= 4) ctx.drawImage(ctx.canvas, 0, y0, TEX, 1, 0, y0 - 4, TEX, 4);
      if (y1 <= TEX - 4) ctx.drawImage(ctx.canvas, 0, y1 - 1, TEX, 1, 0, y1, TEX, 4);
    }
  };
  px(g);
  const t = new THREE.CanvasTexture(cc);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  return t;
}

// The boards' and ribbons' LED face: invented brands, two sets (perimeter, ribbon).
function ledAtlas() {
  const W = 4096, H = 256, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const sets = [
    [['CREASE', '#0d1f4a', '#13306e', '#ffffff', 'stumps'], ['OVERARM ENERGY', '#c8e62a', '#a6c81a', '#111111', 'bolt'], ['SILLY POINT COLA', '#c0181c', '#8e0f12', '#ffffff', 'bubble'],
      ['LONG ON TRAVEL', '#0f7b7a', '#0a5554', '#ffffff', 'swoosh'], ['NIGHTWATCH INSURANCE', '#2b1650', '#170a33', '#f2c12e', 'moon'], ['GULLY GRILL', '#e8661c', '#b84a0f', '#ffffff', 'flame'],
      ['FOLLOW-ON FIBRE', '#1c64d8', '#0f3f99', '#ffffff', 'dots'], ['DEEP COVER BANK', '#0f4d34', '#083322', '#ffffff', 'shield']],
    [['NO BALL RADIO 101.4', '#111111', '#2a2a2a', '#ffd34d', 'dots'], ['GOOD LENGTH OUTFITTERS', '#f4f4f4', '#d8d8d8', '#14285a', 'swoosh'], ['MAIDEN OVER TEA', '#5b2a6e', '#3d1a4b', '#ffffff', 'bubble'],
      ['HOWZAT HOTELS', '#b3221c', '#7a1712', '#ffffff', 'shield'], ['THIRD MAN COFFEE', '#3b2416', '#22140c', '#f2d7a0', 'bubble'], ['WICKET WATER', '#18a0d8', '#0f74a0', '#ffffff', 'bolt'],
      ['CREASE VR', '#0d1f4a', '#1f4fa8', '#ffffff', 'stumps'], ['BOUNDARY BUILDERS', '#f2c12e', '#d9a514', '#111111', 'moon']],
  ];
  sets.forEach((set, si) => set.forEach(([txt, bg0, bg1, fg, icon], i) => {
    const x = i * 512, y = si * 128, h = 128;
    const gr = g.createLinearGradient(x, y, x + 512, y + h); gr.addColorStop(0, bg0); gr.addColorStop(1, bg1);
    g.fillStyle = gr; g.fillRect(x, y, 512, h);
    g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(x, y, 512, 10);
    // A simple mark at the left, then the name.
    g.save(); g.translate(x + 64, y + h / 2); g.fillStyle = fg; g.strokeStyle = fg; g.lineWidth = 7;
    if (icon === 'stumps') for (const sx of [-18, 0, 18]) g.fillRect(sx - 4, -34, 8, 68);
    if (icon === 'bolt') { g.beginPath(); g.moveTo(8, -40); g.lineTo(-20, 6); g.lineTo(0, 6); g.lineTo(-8, 40); g.lineTo(22, -8); g.lineTo(2, -8); g.closePath(); g.fill(); }
    if (icon === 'bubble') { g.beginPath(); g.arc(0, 0, 32, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.arc(-8, -8, 9, 0, Math.PI * 2); g.fill(); }
    if (icon === 'swoosh') { g.beginPath(); g.ellipse(0, 6, 40, 16, -0.4, Math.PI * 0.9, Math.PI * 2.1); g.stroke(); }
    if (icon === 'moon') { g.beginPath(); g.arc(0, 0, 30, 0, Math.PI * 2); g.fill(); g.fillStyle = bg0; g.beginPath(); g.arc(13, -9, 26, 0, Math.PI * 2); g.fill(); }
    if (icon === 'flame') { g.beginPath(); g.moveTo(0, -40); g.quadraticCurveTo(30, 0, 18, 30); g.quadraticCurveTo(0, 44, -18, 30); g.quadraticCurveTo(-30, 0, 0, -40); g.fill(); }
    if (icon === 'dots') for (let k = 0; k < 9; k++) { g.beginPath(); g.arc(((k % 3) - 1) * 22, (Math.floor(k / 3) - 1) * 22, 7, 0, Math.PI * 2); g.fill(); }
    if (icon === 'shield') { g.beginPath(); g.moveTo(-28, -32); g.lineTo(28, -32); g.lineTo(28, 4); g.quadraticCurveTo(0, 40, 0, 40); g.quadraticCurveTo(-28, 26, -28, 4); g.closePath(); g.fill(); }
    g.restore();
    g.fillStyle = fg; g.font = '800 58px system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText(txt, x + 120, y + h / 2 + 3, 372);
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(x + 510, y, 2, h);
  }));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

// ------------------------------------------------------------------ builder
// Quads into per-sector arrays: position, normal, uv, tint, shade (sun, sky, emit).
class Builder {
  constructor(sectors, shadeAt) { this.n = sectors; this.shadeAt = shadeAt; this.s = Array.from({ length: sectors }, () => ({ p: [], nr: [], uv: [], c: [], sh: [], idx: [] })); this.col = new THREE.Color(); }
  sector(x, z) { return Math.floor((angOf(x, z) / 360) * this.n) % this.n; }
  tint(hex) { this.col.set(hex); return [this.col.r, this.col.g, this.col.b]; }
  // pts: 4 corners [x,y,z]; nrm: one [x,y,z] or 4; uvs: 4 [u,v]; o: { tint, emit, sky, sun, sector }
  quad(pts, nrm, uvs, o = {}) {
    const ns = Array.isArray(nrm[0]) ? nrm : [nrm, nrm, nrm, nrm];
    // Wind so the face points along the intended normal.
    const [a, b, c] = pts;
    const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2], fx = c[0] - a[0], fy = c[1] - a[1], fz = c[2] - a[2];
    const gx = ey * fz - ez * fy, gy = ez * fx - ex * fz, gz = ex * fy - ey * fx;
    const n0 = ns[0], flip = gx * n0[0] + gy * n0[1] + gz * n0[2] < 0;
    const cx = (pts[0][0] + pts[2][0]) / 2, cz = (pts[0][2] + pts[2][2]) / 2;
    const S = this.s[o.sector ?? this.sector(cx, cz)];
    const base = S.p.length / 3, tint = o.tint ?? [1, 1, 1];
    for (let i = 0; i < 4; i++) {
      const p = pts[i], n = ns[i];
      S.p.push(p[0], p[1], p[2]); S.nr.push(n[0], n[1], n[2]); S.uv.push(uvs[i][0], uvs[i][1]); S.c.push(tint[0], tint[1], tint[2]);
      const sh = o.fixed ? o.fixed : this.shadeAt(p[0], p[1], p[2], n[0], n[1], n[2]);
      S.sh.push(sh[0] * (o.sun ?? 1), sh[1] * (o.skyv ? o.skyv[i] : o.sky ?? 1), o.emit ?? 0);
    }
    if (flip) S.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    else S.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  // A triangle-list geometry (any three geometry), transformed, uv squeezed into a band.
  geom(geo, matrix, o = {}) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    g.applyMatrix4(matrix);
    if (!g.attributes.normal) g.computeVertexNormals();
    const P = g.attributes.position, N = g.attributes.normal, UV = g.attributes.uv;
    const [u0, u1] = o.u ?? [0.02, 0.98], band = o.band ?? 'PLAIN';
    const v0 = vOf(band, 0.9), v1 = vOf(band, 0.1);
    for (let i = 0; i < P.count; i += 3) {
      const cx = (P.getX(i) + P.getX(i + 1) + P.getX(i + 2)) / 3, cz = (P.getZ(i) + P.getZ(i + 1) + P.getZ(i + 2)) / 3;
      const S = this.s[o.sector ?? this.sector(cx, cz)], base = S.p.length / 3, tint = o.tint ?? [1, 1, 1];
      for (let k = 0; k < 3; k++) {
        const j = i + k, x = P.getX(j), y = P.getY(j), z = P.getZ(j), nx = N.getX(j), ny = N.getY(j), nz = N.getZ(j);
        S.p.push(x, y, z); S.nr.push(nx, ny, nz);
        if (o.raw) S.uv.push(UV.getX(j), UV.getY(j));
        else S.uv.push(UV ? u0 + UV.getX(j) * (u1 - u0) : (u0 + u1) / 2, UV ? v0 + UV.getY(j) * (v1 - v0) : (v0 + v1) / 2);
        S.c.push(tint[0], tint[1], tint[2]);
        const sh = o.fixed ? o.fixed : this.shadeAt(x, y, z, nx, ny, nz);
        S.sh.push(sh[0] * (o.sun ?? 1), sh[1] * (o.sky ?? 1), o.emit ?? 0);
      }
      S.idx.push(base, base + 1, base + 2);
    }
  }
  // A square beam between two points (four sides, no ends).
  beam(p0, p1, w, o = {}) {
    const d = new THREE.Vector3(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]), len = d.length();
    d.divideScalar(len);
    const side = Math.abs(d.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(side, d).normalize();
    const h = (o.h ?? w) / 2, s = w / 2;
    const corners = [[-s, -h], [s, -h], [s, h], [-s, h]];
    for (let k = 0; k < 4; k++) {
      const [ax, ay] = corners[k], [bx, by] = corners[(k + 1) % 4];
      const P = (cx, cy, e) => [e[0] + side.x * cx + up.x * cy, e[1] + side.y * cx + up.y * cy, e[2] + side.z * cx + up.z * cy];
      const nx = (ax + bx) / 2, ny = (ay + by) / 2, nl = Math.hypot(nx, ny);
      const n = [(side.x * nx + up.x * ny) / nl, (side.y * nx + up.y * ny) / nl, (side.z * nx + up.z * ny) / nl];
      const v0 = vOf(o.band ?? 'PLAIN', 0.85), v1 = vOf(o.band ?? 'PLAIN', 0.15);
      this.quad([P(ax, ay, p0), P(bx, by, p0), P(bx, by, p1), P(ax, ay, p1)], n, [[0, v0], [0.05, v0], [0.05, v1], [0, v1]], o);
    }
  }
  box(center, size, o = {}) {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(...center), o.quat ?? new THREE.Quaternion().setFromEuler(new THREE.Euler(...(o.rot ?? [0, 0, 0]))), new THREE.Vector3(1, 1, 1));
    this.geom(new THREE.BoxGeometry(...size), m, o);
  }
  meshes(material) {
    return this.s.filter((S) => S.idx.length).map((S) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(S.p, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(S.nr, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(S.uv, 2));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(S.c, 3));
      geo.setAttribute('aShade', new THREE.Float32BufferAttribute(S.sh, 3));
      geo.setIndex(S.p.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(S.idx, 1) : new THREE.Uint16BufferAttribute(S.idx, 1));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, material);
      mesh.name = 'stadium-sector';
      return mesh;
    });
  }
}

function stadiumMaterial(map) {
  const mat = new THREE.MeshLambertMaterial({ map, vertexColors: true });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aShade;\nvarying vec3 vShade;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvShade = aShade;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vShade;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vShade.z;')
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.directDiffuse *= vShade.x;\nreflectedLight.indirectDiffuse *= vShade.y;');
  };
  mat.customProgramCacheKey = () => 'stadium-v1';
  return mat;
}

// ------------------------------------------------------------------ shade
// Is the sun visible from p (local frame, pitch centre at the origin)? The
// roof slabs analytically, then a short march through the stand profile
// (the back wall, the upper tier over the box level, the pavilion).
function profileTop(type, r) {
  if (type === 'bank') return r < 84 ? -1 : r < 101 ? 0.5 + (r - 84) * 0.41 : r < 108.5 ? 7.5 : r < 112 ? 7.5 - (r - 108.5) * 2 : -1;
  if (r < BOWL.wallR) return -1;
  if (r < L.r0) return BOWL.wallTop;
  if (r < lowEndR) return L.y0 + Math.floor((r - L.r0) / L.depth) * L.rise;
  if (type === 'pav') return r < 97 ? lowEndY : r < 111.4 ? 20.6 + Math.max(0, 5 - Math.abs(r - 104) * 0.7) : -1;
  if (r < BOWL.fasciaR) return lowEndY;
  if (r < U.r0) return BOWL.fasciaTop;
  if (r < BOWL.backR) return U.y0 + Math.floor((r - U.r0) / U.depth) * U.rise;
  if (r < BOWL.outerR) return BOWL.top;
  return -1;
}
const TYPES = Array.from({ length: 720 }, (_, i) => { const a = i / 2 + 0.25; return inArc(a, BANK[0], BANK[1]) ? 'bank' : inArc(a, PAV[0], PAV[1]) ? 'pav' : 'stand'; });
const typeAt = (a) => TYPES[Math.floor(a * 2) % 720];
function makeShade(sunDir) {
  const S = sunDir;
  const sunVis = (x, y, z) => {
    if (y < ROOF.yB - 0.2 && S.y > 0.05) {
      const t = (ROOF.yB + 1 - y) / S.y, qx = x + S.x * t, qz = z + S.z * t, qr = Math.hypot(qx, qz);
      if (qr > ROOF.rF && qr < ROOF.rB && roofed(angOf(qx, qz))) return 0;
    }
    // With the sun over the pitch side the stand cannot block it, except the
    // upper tier over the box level: march only where it can matter.
    const r0 = Math.hypot(x, z) || 1;
    if ((S.x * x + S.z * z) / r0 < -0.05 && !(r0 > lowEndR - 0.3 && r0 < BOWL.concourseR + 0.3 && y < BOWL.boxTop + 0.2)) return 1;
    for (let t = 0.5; t < 26; t += 1.5) {
      const qx = x + S.x * t, qy = y + S.y * t, qz = z + S.z * t;
      if (qy > 26) break;
      const r = Math.hypot(qx, qz);
      if (r < 83 || r > 112) continue;
      const type = typeAt(angOf(qx, qz)), top = profileTop(type, r);
      if (qy < top && !(type === 'stand' && r >= BOWL.fasciaR && r < BOWL.concourseR && qy > lowEndY && qy < BOWL.boxTop)) return 0;
    }
    return 1;
  };
  const skyVis = (x, y, z) => {
    const r = Math.hypot(x, z), a = angOf(x, z);
    let k = 1;
    if (r > ROOF.rF - 0.5 && y < ROOF.yB && roofed(a)) { const el = Math.atan2(roofY(ROOF.rF) - y, Math.max(0.1, r - ROOF.rF)); k = 0.36 + 0.64 * Math.sin(clamp(el, 0, Math.PI / 2)) * 0.85; }
    if (typeAt(a) === 'stand' && r > lowEndR - 0.1 && r < BOWL.concourseR + 0.1 && y > lowEndY - 0.1 && y < BOWL.boxTop + 0.05) k *= 0.6;
    return k;
  };
  const out = [1, 1];
  return (x, y, z, nx, ny, nz) => {
    out[0] = nx * S.x + ny * S.y + nz * S.z > 0 ? sunVis(x, y + 0.03, z) : 1;
    out[1] = skyVis(x, y + 0.03, z);
    return out;
  };
}

// ------------------------------------------------------------------ build
// root: the group to add to (positioned at the pitch centre).
// lights: { hemi, dirs: [{ dir: Vector3 toward the light, color }] }
export function buildStadium(root, lights) {
  const rand = mulberry(2024);
  const sunDir = lights.dirs[0] ? lights.dirs[0].dir.clone().normalize() : new THREE.Vector3(-0.45, 0.79, 0.34);
  const shadeAt = makeShade(sunDir);
  const B = new Builder(8, shadeAt);
  const spots = [], blocks = new Map();
  const lampHousing = new THREE.CylinderGeometry(0.66, 0.74, 0.6, 10, 1, true), lampFace = new THREE.CircleGeometry(0.6, 10);
  const LAMP_AXIS = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)), ONE = new THREE.Vector3(1, 1, 1);
  const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 4, 6, 1, true), crownGeo = new THREE.IcosahedronGeometry(1, 1);
  const T = (h) => B.tint(h);
  const C = {
    concrete: T(0xb9b5ad), wall: T(0x24333f), seatLow: T(0x2f5266), seatUp: T(0x3b6276), seatAlt: T(0xc9ced4), cover: T(0x272d36),
    members: T(0x2f5a3c), fascia: T(0x18222d), roofUnder: T(0xadb9d4), roofTop: T(0xdfe3e6), steel: T(0xe9ecee), dark: T(0x14181d),
    grass: T(0x5e8f3e), cream: T(0xece3cf), green: T(0x3f6b55), white: T(0xf4f2ec), tower: T(0xa8afb6),
  };

  // A profile edge swept from a0 to a1 (degrees): (r0,y0) -> (r1,y1), uv band slice [f0, f1].
  const sweep = (a0, a1, r0, y0, r1, y1, band, f0, f1, o = {}) => {
    const A0 = a0 * D, A1 = a1 * D;
    const dr = r1 - r0, dy = y1 - y0, nl = Math.hypot(dr, dy) || 1;
    const nr = -dy / nl, ny = dr / nl;
    const P = (r, y, a) => [Math.sin(a) * r, y, Math.cos(a) * r];
    const N = (a) => [Math.sin(a) * nr, ny, Math.cos(a) * nr];
    const us = o.uScale ?? 8, rm = (r0 + r1) / 2;
    const u0 = (A0 * rm) / us, u1 = (A1 * rm) / us;
    const va = vOf(band, f0), vb = vOf(band, f1);
    if (o.sky0 != null) o = { ...o, skyv: [o.sky0, o.sky0, o.sky1, o.sky1] };
    B.quad([P(r0, y0, A0), P(r0, y0, A1), P(r1, y1, A1), P(r1, y1, A0)], [N(A0), N(A1), N(A1), N(A0)], [[u0, va], [u1, va], [u1, vb], [u0, vb]], o);
  };
  // A flat polygon in the radial plane at angle a (degrees): end walls of stands and tunnels.
  const cap = (a, pts, facing, o = {}) => {
    const A = a * D, s = Math.sin(A), c = Math.cos(A);
    const n = [c * facing, 0, -s * facing];                       // tangent direction
    const tris = THREE.ShapeUtils.triangulateShape(pts.map(([r, y]) => new THREE.Vector2(r, y)), []);
    const pos = [], uv = [];
    const v0 = vOf(o.band ?? 'CONC', 0.95), v1 = vOf(o.band ?? 'CONC', 0.05);
    for (const t of tris) for (const k of t) { const [r, y] = pts[k]; pos.push(s * r, y, c * r); uv.push(r / 8, v0 + (y / 24) * (v1 - v0)); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    const nn = []; for (let i = 0; i < pos.length / 3; i++) nn.push(...n);
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nn, 3));
    // winding to match the normal
    const P = geo.attributes.position;
    for (let i = 0; i < P.count; i += 3) {
      const ax = P.getX(i), ay = P.getY(i), az = P.getZ(i);
      const ex = P.getX(i + 1) - ax, ey = P.getY(i + 1) - ay, ez = P.getZ(i + 1) - az, fx = P.getX(i + 2) - ax, fy = P.getY(i + 2) - ay, fz = P.getZ(i + 2) - az;
      if ((ey * fz - ez * fy) * n[0] + (ez * fx - ex * fz) * n[1] + (ex * fy - ey * fx) * n[2] < 0) {
        for (const attr of [geo.attributes.position, geo.attributes.uv]) { for (let k = 0; k < attr.itemSize; k++) { const t = attr.array[(i + 1) * attr.itemSize + k]; attr.array[(i + 1) * attr.itemSize + k] = attr.array[(i + 2) * attr.itemSize + k]; attr.array[(i + 2) * attr.itemSize + k] = t; } }
      }
    }
    B.geom(geo, new THREE.Matrix4(), { ...o, u: [0, 1], band: o.band ?? 'CONC', raw: true });
  };

  // ---------------------------------------------------------- the bowl
  const lowRowY = (i) => L.y0 + i * L.rise, lowRowR = (i) => L.r0 + i * L.depth;
  const upRowY = (j) => U.y0 + j * U.rise, upRowR = (j) => U.r0 + j * U.depth;
  const fullProfile = [[BOWL.wallR, 0], [BOWL.wallR, BOWL.wallTop], [L.r0, BOWL.wallTop], [L.r0, L.y0]];
  for (let i = 0; i < L.rows; i++) { fullProfile.push([lowRowR(i + 1), lowRowY(i)]); if (i < L.rows - 1) fullProfile.push([lowRowR(i + 1), lowRowY(i + 1)]); }
  fullProfile.push([BOWL.concourseR, lowEndY], [BOWL.concourseR, BOWL.boxTop], [BOWL.fasciaR, BOWL.boxTop], [BOWL.fasciaR, BOWL.fasciaTop], [U.r0, BOWL.fasciaTop], [U.r0, U.y0]);
  for (let j = 0; j < U.rows; j++) { fullProfile.push([upRowR(j + 1), upRowY(j)]); if (j < U.rows - 1) fullProfile.push([upRowR(j + 1), upRowY(j + 1)]); }
  fullProfile.push([BOWL.backR, BOWL.top], [BOWL.outerR, BOWL.top], [BOWL.outerR, 0]);

  const wedge = (a) => WEDGES.some(([a0, a1]) => inArc(a, a0, a1));
  const blockOf = (bay, tier) => bay * 3 + tier;
  for (let bay = 0; bay < 36; bay++) {
    const type = bayType(bay), b0 = bay * 10, b1 = b0 + 10;
    // Who fills this block.
    for (let tier = 0; tier < 3; tier++) {
      const away = bay >= 20 && bay <= 22, ultras = (bay === 14 || bay === 15) && tier === 0;
      const thin = tier === 1 && (bay === 26 || bay === 27 || bay === 31 || bay === 5);
      blocks.set(blockOf(bay, tier), {
        home: away ? 0.1 : ultras ? 0.88 : 0.26 + rand() * 0.2, away: away ? 0.72 : ultras ? 0.02 : 0.05 + rand() * 0.08, ultras,
        occ: tier === 2 ? 0.3 : type === 'bank' ? 0.5 : thin ? 0.55 : tier === 0 ? 0.86 + rand() * 0.1 : 0.74 + rand() * 0.16,
      });
    }
    if (type === 'bank') { bankBay(b0, b1, bay); continue; }
    // Angular pieces: the aisle, seats, a vomitory in every other lower-tier bay.
    const pieces = [[b0, b0 + AISLE, 'aisle']];
    const vom = bay % 2 === 1 && type === 'stand' && !wedge(b0 + 5);
    if (vom) { const c = b0 + 5.4, h = 0.75, m0 = (b0 + AISLE + c - h) / 2, m1 = (c + h + b1) / 2; pieces.push([b0 + AISLE, m0, 'seats'], [m0, c - h, 'seats'], [c - h, c + h, 'vom'], [c + h, m1, 'seats'], [m1, b1, 'seats']); }
    else { const n = 4, w = (b1 - b0 - AISLE) / n; for (let k = 0; k < n; k++) pieces.push([b0 + AISLE + k * w, b0 + AISLE + (k + 1) * w, 'seats']); }
    for (const [a0, a1, kindRaw] of pieces) {
      const mid = (a0 + a1) / 2, covered = wedge(mid), kind = covered ? 'covered' : kindRaw;
      const seatTintLow = type === 'pav' ? C.members : covered ? C.cover : (bay % 9 === 4 ? C.seatAlt : C.seatLow);
      const seatTintUp = covered ? C.cover : C.seatUp;
      // Front wall, its cap and its back.
      sweep(a0, a1, BOWL.wallR, 0, BOWL.wallR, BOWL.wallTop, 'CONC', 0.75, 0.05, { tint: type === 'pav' ? C.cream : C.wall });
      sweep(a0, a1, BOWL.wallR, BOWL.wallTop, L.r0, BOWL.wallTop, 'PLAIN', 0.5, 0.5, { tint: C.concrete });
      sweep(a0, a1, L.r0, BOWL.wallTop, L.r0, L.y0, 'CONC', 0.2, 0.6, { tint: C.concrete });
      // Lower tier.
      for (let i = 0; i < L.rows; i++) {
        const inVom = kind === 'vom' && i >= 3 && i <= 9;
        const yb = i ? lowRowY(i - 1) : L.y0 - 0.001, yt = lowRowY(i), r = lowRowR(i);
        if (inVom) {
          if (i === 3) sweep(a0, a1, r, yb, r, yt, 'ROW', TREAD, 1, {});
          continue;
        }
        const band = kind === 'aisle' ? 'STEPS' : covered ? 'PLAIN' : 'ROW', ct = covered ? { tint: C.cover } : {};
        if (i > 0) sweep(a0, a1, r, yb, r, yt, band, TREAD, 1, { sky: 0.85, ...ct });
        sweep(a0, a1, r, yt, r + L.depth, yt, band, TREAD, 0, ct);
        if (kind !== 'aisle') {
          const rs = r + L.depth - 0.14;
          sweep(a0, a1, rs, yt + 0.36, rs + 0.07, yt + 0.8, 'SEATS', 1, 0, { tint: seatTintLow });
          if (!covered && !(type === 'pav' && i > 11)) addSeats(a0, a1, r + L.depth - 0.36, yt, i, blockOf(bay, 0), type === 'pav' ? 'members' : 'seat', 0.5);
        }
      }
      if (kind === 'vom') vomitory(a0, a1);
      if (kind === 'aisle') { handrail(a0 + AISLE / 2, lowRowR(0) + 0.2, lowRowY(0), lowRowR(L.rows) - 0.3, lowEndY); aisleWalker(a0, a1, lowRowR, lowRowY, L, 0); }
      // Concourse, the box level, the upper tier's fascia (pavilion bays stop at the concourse).
      sweep(a0, a1, lowEndR, lowEndY, BOWL.concourseR, lowEndY, 'ROW', 0.3, 0.1, {});
      if (type === 'pav') continue;
      if (kind === 'seats') concourseStanders(a0, a1, blockOf(bay, 2));
      sweep(a0, a1, BOWL.concourseR, lowEndY, BOWL.concourseR, BOWL.boxTop, 'GLASS', 0.98, 0.02, { uScale: 12 });
      sweep(a0, a1, BOWL.concourseR, BOWL.boxTop, BOWL.fasciaR, BOWL.boxTop, 'CONC', 0.4, 0.6, { tint: C.dark });
      sweep(a0, a1, BOWL.fasciaR, BOWL.boxTop, BOWL.fasciaR, BOWL.fasciaTop, 'PLAIN', 0.5, 0.5, { tint: C.fascia });
      sweep(a0, a1, BOWL.fasciaR, BOWL.fasciaTop, U.r0, BOWL.fasciaTop, 'PLAIN', 0.5, 0.5, { tint: C.white });
      sweep(a0, a1, U.r0, BOWL.fasciaTop, U.r0, U.y0, 'CONC', 0.2, 0.6, { tint: C.concrete });
      // Upper tier.
      for (let j = 0; j < U.rows; j++) {
        const yb = j ? upRowY(j - 1) : U.y0 - 0.001, yt = upRowY(j), r = upRowR(j);
        const band = kind === 'aisle' ? 'STEPS' : covered ? 'PLAIN' : 'ROW', ct = covered ? { tint: C.cover } : {};
        if (j > 0) sweep(a0, a1, r, yb, r, yt, band, TREAD, 1, { sky: 0.85, ...ct });
        sweep(a0, a1, r, yt, r + U.depth, yt, band, TREAD, 0, ct);
        if (kind !== 'aisle') {
          const rs = r + U.depth - 0.14;
          sweep(a0, a1, rs, yt + 0.36, rs + 0.07, yt + 0.8, 'SEATS', 1, 0, { tint: seatTintUp });
          if (!covered) addSeats(a0, a1, r + U.depth - 0.36, yt, j, blockOf(bay, 1), 'seat', 0.5, j < 4);
        }
      }
      if (kind === 'aisle') { handrail(a0 + AISLE / 2, upRowR(0) + 0.2, upRowY(0), upRowR(U.rows) - 0.3, upEndY); aisleWalker(a0, a1, upRowR, upRowY, U, 1); }
      // Back wall, the top, the outside.
      sweep(a0, a1, BOWL.backR, upEndY, BOWL.backR, BOWL.top, 'CONC', 0.95, 0.4, { tint: C.concrete });
      sweep(a0, a1, BOWL.backR, BOWL.top, BOWL.outerR, BOWL.top, 'PLAIN', 0.5, 0.5, { tint: C.concrete });
      sweep(a0, a1, BOWL.outerR, BOWL.top, BOWL.outerR, 0, 'CONC', 0.05, 0.95, { tint: T(0x8d9298), uScale: 16 });
    }
    // End walls where the stand stops (bank, pavilion).
    const prevType = bayType((bay + 35) % 36), nextType = bayType((bay + 1) % 36);
    if (type === 'stand' && prevType !== 'stand') cap(b0, fullProfile, -1, { tint: C.concrete });
    if (type === 'stand' && nextType !== 'stand') cap(b1, fullProfile, 1, { tint: C.concrete });
  }

  function addSeats(a0, a1, r, y, row, block, type, pitch, nearTV = false) {
    const n = Math.floor(((a1 - a0) * D * r) / pitch);
    const da = (a1 - a0) / n;
    for (let k = 0; k < n; k++) {
      const a = (a0 + (k + 0.5) * da + (rand() - 0.5) * da * 0.18) * D, rr = r + (rand() - 0.5) * 0.06;
      if (nearTV && TV.some((t) => Math.abs(a / D - t) < 1.4)) continue;
      const x = Math.sin(a) * rr, z = Math.cos(a) * rr;
      const sh = shadeAt(x, y + 1.0, z, -Math.sin(a) * 0.6, 0.8, -Math.cos(a) * 0.6);
      spots.push({ x, y, z, nx: -Math.sin(a), nz: -Math.cos(a), sun: sh[0], sky: sh[1], block, row, i: Math.round(a / D * 20 + k), type });
    }
  }
  // Now and then someone on the stairs, going for a drink or back to their seat.
  function aisleWalker(a0, a1, rowR, rowY, T, tier) {
    if (rand() > 0.3) return;
    const i = 1 + Math.floor(rand() * (T.rows - 2)), a = (a0 + (a1 - a0) * (0.3 + rand() * 0.4)) * D, r = rowR(i) + T.depth * 0.5;
    const x = Math.sin(a) * r, z = Math.cos(a) * r, y = rowY(i);
    const sh = shadeAt(x, y + 1.3, z, -Math.sin(a) * 0.6, 0.8, -Math.cos(a) * 0.6);
    spots.push({ x, y, z, nx: -Math.sin(a), nz: -Math.cos(a), sun: sh[0], sky: sh[1], block: -1, row: i, i: 0, type: 'stand', team: tier ? 0 : undefined });
  }
  function concourseStanders(a0, a1, block) {
    const r = lowEndR + 0.45, n = Math.floor(((a1 - a0) * D * r) / 0.7);
    for (let k = 0; k < n; k++) {
      const a = (a0 + (k + rand()) * ((a1 - a0) / n)) * D, x = Math.sin(a) * r, z = Math.cos(a) * r;
      const sh = shadeAt(x, lowEndY + 1.3, z, -Math.sin(a) * 0.6, 0.8, -Math.cos(a) * 0.6);
      spots.push({ x, y: lowEndY, z, nx: -Math.sin(a), nz: -Math.cos(a), sun: sh[0], sky: sh[1], block, row: 20, i: k, type: 'stand' });
    }
  }
  function handrail(a, r0, y0, r1, y1) {
    const A = a * D, s = Math.sin(A), c = Math.cos(A);
    B.beam([s * r0, y0 + 0.95, c * r0], [s * r1, y1 + 0.95, c * r1], 0.06, { tint: T(0x9aa1a8) });
  }
  // A vomitory: rows 4-9 cut away down to row 3's tread, dark tunnel mouth at the back.
  function vomitory(a0, a1) {
    const yF = lowRowY(3), rF = lowRowR(4), rBk = lowRowR(10), yTop = lowRowY(9);
    sweep(a0, a1, lowRowR(3), yF, rBk, yF, 'ROW', 0.5, 0.2, {});
    sweep(a0, a1, rBk, yF, rBk, yTop, 'PLAIN', 0.5, 0.5, { tint: T(0x101215), fixed: [0, 0.4] });
    const side = [[rF, yF]];
    for (let i = 4; i <= 9; i++) side.push([lowRowR(i), lowRowY(i)], [lowRowR(i + 1), lowRowY(i)]);
    side.push([rBk, yF]);
    const clean = side.filter((p, k) => k === 0 || p[0] !== side[k - 1][0] || p[1] !== side[k - 1][1]);
    cap(a0, clean, 1, { tint: C.concrete, sky: 0.7 });
    cap(a1, clean, -1, { tint: C.concrete, sky: 0.7 });
    // Railings along the top of the cut.
    for (const a of [a0, a1]) handrail(a, rF, yF + 0.3, rBk, yTop + 0.1);
  }
  // The grass bank: a picket wall, a slope to a terrace with trees, people on rugs.
  function bankBay(a0, a1, bay) {
    const n = 4, w = (a1 - a0) / n;
    for (let k = 0; k < n; k++) {
      const p0 = a0 + k * w, p1 = p0 + w;
      sweep(p0, p1, BOWL.wallR, 0, BOWL.wallR, 0.95, 'PLAIN', 0.5, 0.5, { tint: C.white });
      sweep(p0, p1, BOWL.wallR, 0.95, L.r0, 0.95, 'PLAIN', 0.5, 0.5, { tint: C.white });
      sweep(p0, p1, L.r0, 0.95, L.r0, 0.5, 'PLAIN', 0.5, 0.5, { tint: C.white });
      sweep(p0, p1, L.r0, 0.5, 101, 7.47, 'GRASS', 0.9, 0.1, { tint: C.grass, uScale: 6 });
      sweep(p0, p1, 101, 7.47, 108.5, 7.5, 'GRASS', 0.9, 0.1, { tint: T(0x557f39), uScale: 6 });
      sweep(p0, p1, 108.5, 7.5, 112, 0.5, 'GRASS', 0.1, 0.9, { tint: T(0x4c7334), uScale: 6 });
    }
    // People sitting on the grass in little groups.
    for (let gI = 0; gI < 26; gI++) {
      const ga = a0 + 0.6 + rand() * (a1 - a0 - 1.2), gr = 86 + rand() * 13.5, size = 1 + Math.floor(rand() * 5);
      for (let p = 0; p < size; p++) {
        const a = (ga + (p - size / 2) * 0.42 + (rand() - 0.5) * 0.2) * D, r = gr + (rand() - 0.5) * 0.8;
        const x = Math.sin(a) * r, z = Math.cos(a) * r, y = profileTop('bank', r) - 0.4;
        const sh = shadeAt(x, y + 1, z, -Math.sin(a) * 0.6, 0.8, -Math.cos(a) * 0.6);
        spots.push({ x, y, z, nx: -Math.sin(a), nz: -Math.cos(a), sun: sh[0], sky: sh[1], block: blockOf(bay, 0), row: 0, i: gI, type: 'grass' });
      }
    }
    // Trees along the top.
    for (let k = 0; k < 4; k++) {
      const a = (a0 + 1.5 + k * 2.4 + rand()) * D, r = 104 + rand() * 4;
      tree(Math.sin(a) * r, 7.5, Math.cos(a) * r, 0.8 + rand() * 0.5);
    }
  }
  function tree(x, y, z, k) {
    const m = new THREE.Matrix4();
    B.geom(trunkGeo, m.compose(new THREE.Vector3(x, y + 2 * k, z), new THREE.Quaternion(), new THREE.Vector3(k, k, k)), { tint: T(0x4a3b2c) });
    const greens = [0x2f5a2a, 0x3a6a30, 0x2a4f26, 0x456f35];
    for (let i = 0; i < 3; i++) {
      const s = (2.6 + rand() * 1.4) * k;
      m.compose(new THREE.Vector3(x + (rand() - 0.5) * 2.4 * k, y + (5 + rand() * 2.5) * k, z + (rand() - 0.5) * 2.4 * k), new THREE.Quaternion(), new THREE.Vector3(s, s * 0.85, s));
      B.geom(crownGeo, m, { tint: T(greens[Math.floor(rand() * greens.length)]), sky: 0.9 });
    }
  }

  // ---------------------------------------------------------- roofs
  // Cantilevered from columns behind the stand: a ribbed deck sloping up to a
  // white fascia, trusses on top every 5 degrees, rafters showing below.
  for (const [s0, s1raw] of ROOFS) {
    const s1 = s1raw < s0 ? s1raw + 360 : s1raw;
    const nSeg = Math.ceil((s1 - s0) / 2.5), w = (s1 - s0) / nSeg;
    for (let k = 0; k < nSeg; k++) {
      const a0 = s0 + k * w, a1 = a0 + w, t = ROOF.t;
      sweep(a0, a1, ROOF.rB, ROOF.yB, ROOF.rF, ROOF.yF, 'UNDER', 0.05, 0.95, { tint: C.roofUnder, uScale: 8, sky0: 1.5, sky1: 3.4 });   // lit from below by the sunlit field, darker deep inside
      sweep(a0, a1, ROOF.rF, ROOF.yF + t, ROOF.rB, ROOF.yB + t, 'UNDER', 0.95, 0.05, { tint: C.roofTop, uScale: 8 });
      sweep(a0, a1, ROOF.rF, ROOF.yF - 0.9, ROOF.rF, ROOF.yF + t + 0.6, 'PLAIN', 0.5, 0.5, { tint: C.steel });
      sweep(a0, a1, ROOF.rF, ROOF.yF + t + 0.6, ROOF.rF + 0.5, ROOF.yF + t + 0.6, 'PLAIN', 0.5, 0.5, { tint: C.steel });
      sweep(a0, a1, ROOF.rF + 0.5, ROOF.yF + t + 0.6, ROOF.rF + 0.5, ROOF.yF + t, 'PLAIN', 0.5, 0.5, { tint: C.steel });
      sweep(a0, a1, ROOF.rF + 0.5, ROOF.yF - 0.9, ROOF.rF, ROOF.yF - 0.9, 'PLAIN', 0.5, 0.5, { tint: C.steel, sky: 2.4 });
      sweep(a0, a1, ROOF.rB, ROOF.yB + t, ROOF.rB, ROOF.yB, 'PLAIN', 0.5, 0.5, { tint: C.steel });
      // Cladding between the top of the stand and the roof at the back.
      sweep(a0, a1, BOWL.outerR - 0.05, BOWL.top, BOWL.outerR - 0.05, ROOF.yB, 'CONC', 0.6, 0.1, { tint: T(0x7d858e), uScale: 4, sky: 1.8 });
    }
    // Close the deck and fascia at both ends.
    const endP = [[ROOF.rB, ROOF.yB], [ROOF.rF + 0.5, roofY(ROOF.rF + 0.5)], [ROOF.rF + 0.5, ROOF.yF - 0.9], [ROOF.rF, ROOF.yF - 0.9], [ROOF.rF, ROOF.yF + ROOF.t + 0.6], [ROOF.rF + 0.5, ROOF.yF + ROOF.t + 0.6], [ROOF.rF + 0.5, roofY(ROOF.rF + 0.5) + ROOF.t], [ROOF.rB, ROOF.yB + ROOF.t]];
    cap(s0, endP, -1, { tint: C.steel, band: 'PLAIN' });
    cap(s1, endP, 1, { tint: C.steel, band: 'PLAIN' });
    for (let a = s0 + 2.5; a < s1 - 1; a += 5) truss(a);
    // Flags along the back of the roof.
    for (let a = s0 + 5; a < s1 - 2; a += 10) flagpole(a, ROOF.rB - 0.6, ROOF.yB + ROOF.t, 7);
  }
  function truss(aDeg) {
    const A = aDeg * D, s = Math.sin(A), c = Math.cos(A);
    const P = (r, y) => [s * r, y, c * r];
    const t = ROOF.t, w = 0.32;
    const back = [ROOF.rB - 0.3, ROOF.yB + t], apex = [104.5, 35], front = [ROOF.rF + 0.6, ROOF.yF + t + 0.6];
    const o = { tint: C.steel };
    B.beam(P(...back), P(...apex), w, o); B.beam(P(...apex), P(...front), w * 0.85, o);
    const chord = (r) => (r > apex[0] ? apex[1] + ((r - apex[0]) / (back[0] - apex[0])) * (back[1] - apex[1]) : apex[1] + ((apex[0] - r) / (apex[0] - front[0])) * (front[1] - apex[1]));
    const deck = (r) => roofY(r) + t;
    let prev = null;
    for (const r of [108, apex[0], 100.5, 96.5]) {
      B.beam(P(r, deck(r)), P(r, chord(r)), 0.2, o);
      if (prev != null) B.beam(P(prev, deck(prev)), P(r, chord(r)), 0.16, o);
      prev = r;
    }
    B.beam(P(ROOF.rB - 0.5, ROOF.yB - 0.25), P(ROOF.rF + 0.6, ROOF.yF - 0.25), 0.35, { tint: T(0x8a929a), h: 0.5, sky: 2.4 });
    B.beam(P(ROOF.rB + 0.3, 0), P(ROOF.rB + 0.3, ROOF.yB + t), 0.7, { tint: C.steel });
  }
  function flagpole(aDeg, r, y, h) {
    const A = aDeg * D, x = Math.sin(A) * r, z = Math.cos(A) * r;
    B.beam([x, y, z], [x, y + h, z], 0.09, { tint: C.white });
    const designs = [[0x1f4fa8, 0xffffff, 0xf2c12e, 0], [0xb3221c, 0xffffff, 0xf4f4f4, 0], [0x2d8a57, 0xffffff, 0xf2c12e, 1], [0x14285a, 0xffffff, 0xf2c12e, 1]];
    const d = designs[Math.floor(rand() * designs.length)];
    spots.push({ x, y: y + h - 0.15, z, nx: -Math.sin(A), nz: -Math.cos(A), sun: 1, sky: 1, kind: KIND.POLEFLAG, design: d[3], cols: [0x333333, d[0], d[1], d[2]], scale: 1.3 });
  }

  // ---------------------------------------------------------- pavilion
  // A members' pavilion: three storeys of sash windows in cream render,
  // balconies with white parapets, a green copper roof, a pediment with the
  // clock and a cupola with the flag. Straight-fronted, set in the 80-100 gap.
  {
    const fx = 97, bx = 111.2, zf = Math.tan(10 * D) * fx - 0.25, zb = Math.tan(10 * D) * bx - 0.25;
    const m = new THREE.Matrix4();
    const face = (x0, z0, x1, z1, y0, y1, band, o = {}) => {
      const nx = z1 - z0, nz = -(x1 - x0), nl = Math.hypot(nx, nz);
      const n = [-nx / nl, 0, -nz / nl];
      const len = Math.hypot(x1 - x0, z1 - z0), us = o.uScale ?? 24;
      const va = vOf(band, o.f0 ?? 1), vb = vOf(band, o.f1 ?? 0);
      B.quad([[x0, y0, z0], [x1, y0, z1], [x1, y1, z1], [x0, y1, z0]], o.n ?? n, [[0, va], [len / us, va], [len / us, vb], [0, vb]], o);
    };
    const storeys = [[lowEndY, 11.4], [11.4, 15.6], [15.6, 19.8]];
    for (const [y0, y1] of storeys) face(fx, -zf, fx, zf, y0, y1, 'PAV', { tint: C.cream, n: [-1, 0, 0] });
    face(fx, -zf, fx, zf, 19.8, 20.7, 'PLAIN', { tint: C.white, n: [-1, 0, 0] });
    face(fx, zf, bx, zb, lowEndY, 20.7, 'PAV', { tint: C.cream, uScale: 24 });
    face(bx, -zb, fx, -zf, lowEndY, 20.7, 'PAV', { tint: C.cream, uScale: 24 });
    // Balconies (slab, parapet, its top, the pillars under).
    for (const y of [11.4, 15.6]) {
      B.box([fx - 0.85, y - 0.12, 0], [1.7, 0.24, zf * 2 - 0.2], { tint: C.white });
      B.box([fx - 1.68, y + 0.5, 0], [0.12, 1.0, zf * 2 - 0.2], { tint: C.white });
      for (let z = -zf + 1; z <= zf - 1; z += 4.2) B.box([fx - 1.6, y - 2.2, z], [0.22, 4.1, 0.22], { tint: C.white });
      addBalcony(fx - 1.05, y, zf - 1);
    }
    // Roof: front and back slopes, gable ends; pediment, clock, cupola, flags.
    const eave = 20.7, ridge = 25.6, rx = 104.1;
    const slope = (x0, x1, y0, y1, zz0, zz1) => {
      const dx = x1 - x0, dy = y1 - y0, nl = Math.hypot(dx, dy);
      const nn = x1 > x0 ? [-dy / nl, dx / nl, 0] : [dy / nl, -dx / nl, 0];
      B.quad([[x0, y0, -zz0], [x0, y0, zz0], [x1, y1, zz1], [x1, y1, -zz1]], nn[1] < 0 ? [-nn[0], -nn[1], 0] : nn, [[0, vOf('UNDER', 0.95)], [zz0 / 4, vOf('UNDER', 0.95)], [zz1 / 4, vOf('UNDER', 0.05)], [0, vOf('UNDER', 0.05)]], { tint: C.green });
    };
    const zr = Math.tan(10 * D) * rx - 0.25;
    slope(fx - 0.6, rx, eave, ridge, zf + 0.4, zr);
    slope(bx + 0.4, rx, eave, ridge, zb + 0.4, zr);
    for (const sz of [-1, 1]) {
      const pts = [[fx - 0.6, eave, sz * (zf + 0.4)], [bx + 0.4, eave, sz * (zb + 0.4)], [rx, ridge, sz * zr]];
      B.geom(new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(...p))), m.identity(), { tint: C.cream });
      B.geom(new THREE.BufferGeometry().setFromPoints([pts[0], pts[2], pts[1]].map((p) => new THREE.Vector3(...p))), m.identity(), { tint: C.cream });
    }
    // Pediment with the clock.
    const ped = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(fx - 0.7, 20.7, -6), new THREE.Vector3(fx - 0.7, 20.7, 6), new THREE.Vector3(fx - 0.7, 24.4, 0)]);
    B.geom(ped, m.identity(), { tint: C.white });
    B.geom(new THREE.CylinderGeometry(1.25, 1.25, 0.2, 24), m.compose(new THREE.Vector3(fx - 0.8, 22.1, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2)), new THREE.Vector3(1, 1, 1)), { tint: C.white, sky: 1.2 });
    B.geom(new THREE.TorusGeometry(1.25, 0.12, 6, 24), m.compose(new THREE.Vector3(fx - 0.9, 22.1, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)), new THREE.Vector3(1, 1, 1)), { tint: C.dark });
    B.box([fx - 0.95, 22.4, 0.0], [0.05, 0.7, 0.09], { tint: C.dark });
    B.box([fx - 0.95, 22.1, 0.28], [0.05, 0.08, 0.6], { tint: C.dark });
    // Cupola on the ridge.
    B.geom(new THREE.CylinderGeometry(1.6, 1.8, 3.4, 8), m.makeTranslation(rx, ridge + 1.4, 0), { tint: C.white });
    B.geom(new THREE.CylinderGeometry(1.62, 1.62, 1.2, 8, 1, true), m.makeTranslation(rx, ridge + 1.8, 0), { tint: C.dark, sky: 0.6 });
    B.geom(new THREE.SphereGeometry(1.9, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), m.makeTranslation(rx, ridge + 3.1, 0), { tint: C.green });
    pavFlag(rx, ridge + 4.9, 0, 6);
    for (const sz of [-1, 1]) pavFlag(fx - 0.3, eave + 0.2, sz * (zf - 0.6), 4.5);
    function pavFlag(x, y, z, h) {
      B.beam([x, y, z], [x, y + h, z], 0.1, { tint: C.white });
      spots.push({ x, y: y + h - 0.15, z, nx: -1, nz: 0, sun: 1, sky: 1, kind: KIND.POLEFLAG, design: 1, cols: [0x333333, 0x2d5a3c, 0xffffff, 0xf2c12e], scale: 1.5 });
    }
    // Players' benches and umbrellas in front of the pavilion.
    for (const sz of [-1, 1]) {
      B.box([BOWL.wallR - 3.2, 0.45, sz * 9], [1.0, 0.9, 7], { tint: C.white });
      B.geom(new THREE.ConeGeometry(2.4, 0.9, 10, 1, true), m.makeTranslation(BOWL.wallR - 3.0, 2.9, sz * 9), { tint: sz > 0 ? T(0x1f4fa8) : T(0xb3221c) });
      B.beam([BOWL.wallR - 3.0, 0, sz * 9], [BOWL.wallR - 3.0, 2.6, sz * 9], 0.06, { tint: C.white });
    }
  }
  function addBalcony(x, y, zh) {
    for (let z = -zh; z <= zh; z += 0.75) {
      if (rand() > 0.55) continue;
      const sh = shadeAt(x, y + 1, z, -0.6, 0.8, 0);
      spots.push({ x, y, z, nx: -1, nz: 0, sun: sh[0], sky: sh[1] * 0.85, block: -1, row: 0, i: 0, type: rand() < 0.5 ? 'stand' : 'members', team: 0 });
    }
  }

  // ---------------------------------------------------------- floodlights
  // Lattice masts, a service platform and a banked head of 20 lamps tilted at the pitch.
  for (const ta of TOWERS) {
    const A = ta * D, r = inArc(ta, BANK[0], BANK[1]) ? 106 : BOWL.outerR + 6.5, y0 = inArc(ta, BANK[0], BANK[1]) ? 7.5 : 0;
    const cx = Math.sin(A) * r, cz = Math.cos(A) * r, H = 50, o = { tint: C.tower };
    const half = (y) => 1.7 - ((y - y0) / (H - y0)) * 1.0;
    const corner = (k, y) => { const h = half(y), ca = Math.cos(A), sa = Math.sin(A); const lx = k & 1 ? h : -h, lz = k & 2 ? h : -h; return [cx + lx * ca + lz * sa, y, cz - lx * sa + lz * ca]; };
    for (let k = 0; k < 4; k++) B.beam(corner(k, y0), corner(k, H), 0.3, o);
    const levels = 14;
    for (let l = 0; l < levels; l++) {
      const ya = y0 + ((H - y0) * l) / levels, yb = y0 + ((H - y0) * (l + 1)) / levels;
      for (const [k0, k1] of [[0, 1], [1, 3], [3, 2], [2, 0]]) {
        B.beam(corner(k0, yb), corner(k1, yb), 0.18, o);
        B.beam(corner(k0, ya), corner(k1, yb), 0.15, o);      // not thinner: sub-pixel braces crawl at 120 m
      }
    }
    // Head: frame + lamps, facing the middle and tilted down.
    const head = new THREE.Object3D();
    head.position.set(cx - Math.sin(A) * 1.2, H + 3.6, cz - Math.cos(A) * 1.2);
    head.lookAt(0, 0, 0);
    head.updateMatrixWorld(true);
    const hm = head.matrixWorld, q = head.quaternion;
    const at = (lx, ly, lz) => new THREE.Vector3(lx, ly, lz).applyMatrix4(hm);
    // Four banked rows of six round lamps on bars, a cage frame behind; each row aims a little lower.
    const fo = { tint: T(0x4a5058) };
    for (const sx of [-1, 1]) B.beam(at(sx * 6.4, -3.9, -0.6).toArray(), at(sx * 6.4, 3.9, -0.6).toArray(), 0.3, fo);
    B.beam(at(-6.4, 3.9, -0.6).toArray(), at(6.4, 3.9, -0.6).toArray(), 0.3, fo);
    B.box(at(0, 0, -1.0).toArray(), [12.2, 7.4, 0.25], { quat: q, tint: T(0x30353c) });
    for (let gy = 0; gy < 4; gy++) {
      const ly = (gy - 1.5) * 1.8, lz = (gy - 1.5) * -0.25;
      B.beam(at(-6.4, ly - 0.85, lz - 0.4).toArray(), at(6.4, ly - 0.85, lz - 0.4).toArray(), 0.22, fo);
      const rq = q.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.08 * (1.5 - gy), 0, 0)));
      const n = new THREE.Vector3(0, 0, 1).applyQuaternion(rq);
      for (let gx = 0; gx < 6; gx++) {
        const p = at((gx - 2.5) * 2.05, ly, lz);
        B.geom(lampHousing, new THREE.Matrix4().compose(p, rq.clone().multiply(LAMP_AXIS), ONE), { tint: T(0x2b3036) });
        B.geom(lampFace, new THREE.Matrix4().compose(p.clone().addScaledVector(n, 0.3), rq, ONE), { tint: T(0xfff4d6), emit: 2.4, fixed: [1, 1] });
      }
    }
    B.box([cx, H + 0.1, cz], [4.4, 0.25, 4.4], { tint: C.tower });
  }

  // ---------------------------------------------------------- big screen frame
  // The replay screen (the UI mounts its picture at screen.pos) on a gantry
  // cantilevered from two columns behind the stand.
  const screenPos = new THREE.Vector3();
  const screenLook = new THREE.Vector3();
  {
    const a = -2.08, rr = R0 + 9;
    screenPos.set(Math.sin(a) * rr, BOWL.top + 6, Math.cos(a) * rr);   // local; the caller adds the pitch centre
    screenLook.set(0, screenPos.y - 5, 0);
    const fr = new THREE.Object3D();
    fr.position.copy(screenPos).add(new THREE.Vector3(Math.sin(a), 0, Math.cos(a)).multiplyScalar(0.8));
    fr.lookAt(0, screenPos.y - 4, 0);
    fr.updateMatrixWorld(true);
    const at = (lx, ly, lz) => new THREE.Vector3(lx, ly, lz).applyMatrix4(fr.matrixWorld).toArray();
    B.box(at(0, 0, 0), [26.8, 11.8, 1.2], { quat: fr.quaternion, tint: T(0x1b1f26) });
    B.box(at(0, 6.3, -0.3), [27.4, 0.8, 1.9], { quat: fr.quaternion, tint: T(0x2b3038) });
    B.box(at(0, -6.3, -0.3), [27.4, 0.8, 1.9], { quat: fr.quaternion, tint: T(0x2b3038) });
    const rb = BOWL.outerR + 1.6, sa = Math.sin(a), ca = Math.cos(a), t = new THREE.Vector3(ca, 0, -sa);
    for (const sx of [-8, 8]) {
      const col = [sa * rb + t.x * sx, 0, ca * rb + t.z * sx], top = [col[0], screenPos.y + 6.5, col[2]];
      B.beam(col, top, 0.9, { tint: C.tower });
      B.beam(top, at(sx, 5.9, -0.7), 0.5, { tint: C.tower });
      B.beam([col[0], BOWL.top + 1, col[2]], at(sx, -5.9, -0.7), 0.45, { tint: C.tower });
      B.beam([col[0], screenPos.y + 0.5, col[2]], at(sx * 0.4, 0, -0.7), 0.35, { tint: C.tower });
    }
  }

  // ---------------------------------------------------------- perimeter
  const ledR = CONFIG.field.boundaryRadius + CONFIG.field.boardsOffset, ledH = CONFIG.field.boardsHeight;
  {
    // The boards' frame: a dark back and top, small legs (the lit face is the LED mesh).
    const n = 120;
    for (let k = 0; k < n; k++) {
      const a0 = (k * 360) / n, a1 = ((k + 1) * 360) / n;
      sweep(a0, a1, ledR + 0.22, ledH, ledR + 0.22, 0, 'PLAIN', 0.5, 0.5, { tint: T(0x22262c) });
      sweep(a0, a1, ledR, ledH, ledR + 0.22, ledH, 'PLAIN', 0.5, 0.5, { tint: T(0x2e333a) });
    }
    // Rolled covers and the heavy roller by the rope at square; drinks carts; TV camera
    // towers at the ends and square; photographers and stewards round the edge.
    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    const place = (aDeg, r) => { const A = aDeg * D; return [Math.sin(A) * r, Math.cos(A) * r, A]; };
    for (const [ad, r] of [[262, 73.5], [266.5, 73.5], [271, 73.5]]) {
      const [x, z, A] = place(ad, r);
      q.setFromEuler(new THREE.Euler(0, A + Math.PI / 2, Math.PI / 2));
      B.geom(new THREE.CylinderGeometry(0.62, 0.62, 7.5, 12), m.compose(new THREE.Vector3(x, 0.62, z), q, new THREE.Vector3(1, 1, 1)), { tint: ad === 266.5 ? T(0x2a62b8) : C.white });
    }
    {
      const [x, z, A] = place(96, 72.5);
      q.setFromEuler(new THREE.Euler(0, A, Math.PI / 2));
      B.geom(new THREE.CylinderGeometry(0.75, 0.75, 2.2, 14), m.compose(new THREE.Vector3(x, 0.75, z), q, new THREE.Vector3(1, 1, 1)), { tint: T(0x4f6a3a) });
      B.box([x + 1.6 * Math.sin(A), 1.2, z + 1.6 * Math.cos(A)], [1.4, 1.0, 1.6], { rot: [0, A, 0], tint: T(0x2b3038) });
    }
    for (const [ad, col] of [[72, 0x1f4fa8], [108, 0xb3221c]]) {
      const [x, z, A] = place(ad, 74);
      B.box([x, 0.75, z], [1.3, 0.7, 2.4], { rot: [0, A, 0], tint: T(col) });
      B.box([x, 1.95, z], [1.4, 0.08, 2.6], { rot: [0, A, 0], tint: C.white });
      for (const s of [-1, 1]) for (const f of [-1, 1]) {
        const lx = s * 0.55, lz = f * 1.05, ca = Math.cos(A), sa = Math.sin(A);
        B.beam([x + lx * ca + lz * sa, 1.1, z - lx * sa + lz * ca], [x + lx * ca + lz * sa, 1.95, z - lx * sa + lz * ca], 0.05, { tint: C.white });
        B.geom(new THREE.CylinderGeometry(0.28, 0.28, 0.16, 10), m.compose(new THREE.Vector3(x + lx * ca * 1.15 + lz * sa, 0.28, z - lx * sa * 1.15 + lz * ca), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, A, Math.PI / 2)), new THREE.Vector3(1, 1, 1)), { tint: C.dark });
      }
    }
    // TV camera platforms on the upper tier front (outside the sightscreen wedges) and at square.
    for (const ad of TV) {
      const [x, z, A] = place(ad, BOWL.fasciaR + 1.35), yP = BOWL.fasciaTop + 0.25;
      B.box([x, yP - 0.12, z], [3.4, 0.24, 2.7], { rot: [0, A, 0], tint: T(0x3a4048) });
      B.box([x, yP + 0.45, z], [0.7, 0.55, 1.1], { rot: [0, A, 0], tint: T(0x1d2024) });
      B.box([x - Math.sin(A) * 0.75, yP + 0.5, z - Math.cos(A) * 0.75], [0.35, 0.35, 0.7], { rot: [0, A, 0], tint: T(0x111316) });
      const sh = shadeAt(x, yP + 1, z, -Math.sin(A), 0.6, -Math.cos(A));
      spots.push({ x: x + Math.sin(A) * 0.7, y: yP, z: z + Math.cos(A) * 0.7, nx: -Math.sin(A), nz: -Math.cos(A), sun: sh[0], sky: sh[1], block: -1, row: 0, i: 0, type: 'stand', team: 0 });
    }
    // Photographers by the boards at fine leg / third man, stewards at the front wall facing the crowd.
    for (const ad of [32, 38, 44, 136, 141, 146, 214, 219, 224, 318, 323, 328]) {
      const [x, z, A] = place(ad + (rand() - 0.5), ledR + 1.6 + rand() * 0.8);
      spots.push({ x, y: 0, z, nx: -Math.sin(A), nz: -Math.cos(A), sun: 1, sky: 1, kind: KIND.PHOTO });
    }
    for (let ad = 3; ad < 360; ad += 9) {
      if (wedge(ad) || inArc(ad, PAV[0] - 3, PAV[1] + 3)) continue;
      const [x, z, A] = place(ad + (rand() - 0.5) * 3, BOWL.wallR - 0.8);
      spots.push({ x, y: 0, z, nx: Math.sin(A), nz: Math.cos(A), sun: 1, sky: 1, kind: KIND.STEWARD });
    }
    // Banners on the lower tier front in a few bays.
    for (const ad of [124, 151, 157, 205, 232, 287, 296, 334, 62]) {
      const w = 4.5, A0 = ad * D, A1 = (ad + (w / BOWL.wallR) / D) * D, r = BOWL.wallR - 0.03, k = Math.floor(rand() * 8);
      const P = (a, y) => [Math.sin(a) * r, y, Math.cos(a) * r], N = (a) => [-Math.sin(a), 0, -Math.cos(a)];
      B.quad([P(A0, 0.95), P(A1, 0.95), P(A1, 2.05), P(A0, 2.05)], [N(A0), N(A1), N(A1), N(A0)], [[(k + 1) / 8 - 0.004, vOf('BANNER', 0.95)], [k / 8 + 0.004, vOf('BANNER', 0.95)], [k / 8 + 0.004, vOf('BANNER', 0.05)], [(k + 1) / 8 - 0.004, vOf('BANNER', 0.05)]], {});
    }
  }

  const mat = stadiumMaterial(stadiumAtlas());
  const group = new THREE.Group();
  group.name = 'bowl';
  for (const mesh of B.meshes(mat)) group.add(mesh);

  // ---------------------------------------------------------- LED boards + ribbons
  const led = buildLed(ledR, ledH, (a) => wedge(a) ? 0 : 1, (a) => typeAt(a) === 'stand' && !wedge(a));
  group.add(led.mesh);

  root.add(group);

  return {
    group, spots, blocks, screenPos, screenLook, ledTex: led.tex,
    standTop: BOWL.top, standBack: BOWL.outerR,
    update(t) { led.update(t); },
  };
}

// The LED face of the boards (and the ribbon along the upper tier front): its
// own little shader so the ads can change every half minute with a short
// slide (one uniform), while the panels in front of the sightscreens stay dark.
function buildLed(ledR, ledH, liveAt, ribbonAt) {
  const tex = ledAtlas();
  const uniforms = { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), map: { value: tex }, uFlip: { value: new THREE.Vector2() } };
  const mat = new THREE.ShaderMaterial({
    uniforms, fog: true, toneMapped: false,
    vertexShader: `#include <common>
      #include <fog_pars_vertex>
      uniform vec2 uFlip; attribute vec2 aLed; varying vec2 vUv; varying float vB;
      void main() {
        vUv = uv + vec2(aLed.x > 1.5 ? uFlip.y : aLed.x > 0.5 ? uFlip.x : 0.0, 0.0);
        vB = aLed.y;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `#include <common>
      #include <fog_pars_fragment>
      uniform sampler2D map; varying vec2 vUv; varying float vB;
      void main() {
        gl_FragColor = vec4(texture2D(map, vUv).rgb * vB, 1.0);
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  const pos = [], uv = [], led = [], idx = [];
  const strip = (r, y0, y1, a0, a1, v0, v1, uLen, which, bright) => {
    const A0 = a0 * D, A1 = a1 * D, base = pos.length / 3;
    pos.push(Math.sin(A0) * r, y0, Math.cos(A0) * r, Math.sin(A1) * r, y0, Math.cos(A1) * r, Math.sin(A1) * r, y1, Math.cos(A1) * r, Math.sin(A0) * r, y1, Math.cos(A0) * r);
    const u0 = -(A0 * r) / uLen, u1 = -(A1 * r) / uLen;               // negative: reads left to right from inside
    uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
    for (let k = 0; k < 4; k++) led.push(which, bright);
    idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  for (let k = 0; k < 240; k++) {
    const a0 = k * 1.5, a1 = a0 + 1.5, live = liveAt(a0 + 0.75);
    strip(ledR, 0.03, ledH - 0.02, a0, a1, 0.5, 1.0, 40, live ? 1 : 0, live ? 1 : 0.05);
  }
  for (let k = 0; k < 360; k++) {
    const a0 = k, a1 = a0 + 1;
    if (!ribbonAt(a0 + 0.5)) continue;
    strip(BOWL.fasciaR - 0.1, BOWL.boxTop + 0.35, BOWL.fasciaTop - 0.3, a0, a1, 0.0, 0.5, 48, 2, 0.9);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('aLed', new THREE.Float32BufferAttribute(led, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'led';
  // Every 30 s the ads slide on by one (0.8 s); the ribbon a quarter-cycle later.
  const step = (t, off) => { const c = (t + off) / 30, k = Math.floor(c), f = (c - k) * 30; return (k + smooth(29.2, 30, f)) / 8; };
  return { mesh, tex, update(t) { uniforms.uFlip.value.set(step(t, 0) % 1, step(t, 7.5) % 1); } };
}
