// Hot Spot on the DRS screen (drsView.js): the infra-red camera's black-and-
// white picture of the striker's bat and pads as the ball went past, with a
// bright white mark where the ball touched (the bat's edge or face, the pad),
// sized by how hard; nothing where it did not. Two pictures, broadcast style:
// FRONT-ON (from the bowler's end: the pads with the bat in front of them) and
// a close-up of the blade with its edges named. Canvas 2D only.
//
// From the bowler's end a right-hander's off side is on the LEFT of the
// picture (world +X is screen left), so the outside edge is the bat's left
// edge and the front (left) pad is the left one.
import { makeRng } from '../physics/math.js';
import { batDims } from './snicko.js';

const BAT_TOE_Y = 0.03;        // m: the toe off the ground in the picture (the bat as it meets the ball)

export function hotspotLayout(rect, { marks = [], dims = batDims() } = {}) {
  const { x, y, w, h } = rect;
  const capH = Math.round(h * 0.13);
  const main = { x: x + 12, y: y + 10, w: Math.round(w * 0.56), h: h - capH - 22 };
  const zoom = { x: main.x + main.w + 16, y: main.y, w: x + w - (main.x + main.w + 16) - 12, h: main.h };
  const caption = { x: x + 12, y: main.y + main.h + 10, w: w - 24, h: capH };

  // FRONT-ON: px per m so that 0 .. 1.2 m of the batter fills it.
  const S = (main.h - 24) / 1.2, ground = main.y + main.h - 14, cx = main.x + main.w / 2;
  const sy = (m) => ground - m * S;
  const pads = [
    { leg: 'front', x: cx - 0.13 * S, w: 0.17 * S, top: sy(0.68), bottom: sy(0.06) },
    { leg: 'back', x: cx + 0.13 * S, w: 0.17 * S, top: sy(0.68), bottom: sy(0.06) },
  ];
  const bat = { x: cx - 0.03 * S - dims.hx * S, y: sy(BAT_TOE_Y + dims.bladeLength), w: 2 * dims.hx * S, h: dims.bladeLength * S, cx: cx - 0.03 * S };
  bat.handle = { x: bat.cx - dims.handleR * S, w: 2 * dims.handleR * S, top: sy(BAT_TOE_Y + dims.bladeLength + 0.3), bottom: bat.y };

  // the close-up: the blade, big
  const S2 = Math.min((zoom.h - 70) / (dims.bladeLength + 0.12), (zoom.w - 40) / (2 * dims.hx * 2.6));
  const zBat = { x: zoom.x + zoom.w / 2 - dims.hx * S2, y: zoom.y + 40 + 0.1 * S2, w: 2 * dims.hx * S2, h: dims.bladeLength * S2, cx: zoom.x + zoom.w / 2 };
  zBat.handle = { x: zBat.cx - dims.handleR * S2, w: 2 * dims.handleR * S2, top: zoom.y + 40, bottom: zBat.y };

  // the marks: where in each picture
  const spots = [];
  for (const m of marks) {
    if (m.on === 'bat') {
      const wx = worldAcross(m);                        // + = toward the off side
      const vb = m.vBlade != null ? m.vBlade : m.v;
      const r = 0.018 + 0.03 * m.size;
      if (m.where === 'glove' || m.where === 'handle' || vb > 1) {
        // on the handle (gloves): above the blade
        const up = Math.min(0.28, Math.max(0.02, (vb - 1) * dims.bladeLength));
        spots.push({ view: 'main', x: bat.cx - Math.sign(wx) * 0.01 * S, y: bat.y - up * S, r: r * S, heat: m.heat, mark: m });
        spots.push({ view: 'zoom', x: zBat.cx, y: zBat.y - Math.min(0.1, up) * S2, r: r * S2, heat: m.heat, mark: m });
        continue;
      }
      const ax = Math.max(-1.02, Math.min(1.02, wx));
      spots.push({ view: 'main', x: bat.cx - ax * dims.hx * S, y: bat.y + bat.h * (1 - vb), r: r * S, heat: m.heat, mark: m });
      spots.push({ view: 'zoom', x: zBat.cx - ax * dims.hx * S2, y: zBat.y + zBat.h * (1 - vb), r: r * S2, heat: m.heat, mark: m });
    } else {
      const pad = pads[m.leg === 'back' ? 1 : 0];
      const off = Math.max(-0.07, Math.min(0.07, (m.u || 0) * 0.04));
      const r = 0.03 + 0.03 * m.size;
      spots.push({ view: 'main', x: pad.x - off * S, y: sy(Math.max(0.1, Math.min(0.95, m.v))), r: r * S, heat: m.heat, mark: m });
    }
  }
  return { main, zoom, caption, S, S2, ground, cx, pads, bat, zBat, spots };
}

// Across the bat toward the off side (+) or the leg side (-), ±1 = the edges.
function worldAcross(m) {
  const a = Math.abs(m.u ?? 0);
  if (m.edge === 'outside') return Math.max(a, 1);
  if (m.edge === 'inside') return -Math.max(a, 1);
  return (m.u ?? 0) * (Math.sign(m.ax ?? 1) || 1);     // the face: which way the bat's +x points
}

// The caption under the pictures.
export function hotspotCaption(marks, dims = batDims()) {
  const bat = marks.find((m) => m.on === 'bat');
  const pad = marks.find((m) => m.on === 'pad' || m.on === 'body');
  if (bat) {
    const what = bat.label === 'MIDDLE OF THE BAT' ? 'ON THE MIDDLE OF THE BAT' : `ON THE ${bat.label}`;
    const vb = bat.vBlade != null ? bat.vBlade : bat.v;
    const cm = Math.round(vb * dims.bladeLength * 100);
    const where = bat.where === 'glove' || bat.where === 'handle' || vb > 1 ? '' : ` · ${cm} cm FROM THE TOE`;
    return `MARK ${what}${where}${pad ? ' · AND ON THE PAD' : ''}`;
  }
  if (pad) return `NO MARK ON THE BAT · MARK ON THE ${pad.on === 'body' ? 'THIGH PAD' : 'PAD'}`;
  return 'NO MARK ON THE BAT OR PAD';
}

function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

const grey = (v, a = 1) => { const c = Math.round(Math.max(0, Math.min(1, v)) * 255); return `rgba(${c},${c},${c},${a})`; };

// A soft "warm" shape: thermal cameras blur heat at the outlines.
function warm(g, v, blur, draw) {
  g.save();
  g.shadowColor = grey(v, 0.9); g.shadowBlur = blur;
  g.fillStyle = grey(v);
  draw(); g.fill();
  g.restore();
}

function spot(g, s, k = 1) {
  const r = s.r;
  const bloom = g.createRadialGradient(s.x, s.y, 0, s.x, s.y, r * 2.4);
  bloom.addColorStop(0, `rgba(255,255,255,${0.55 * k})`); bloom.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = bloom; g.beginPath(); g.arc(s.x, s.y, r * 2.4, 0, Math.PI * 2); g.fill();
  const core = g.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
  core.addColorStop(0, `rgba(255,255,255,${k})`); core.addColorStop(0.55, `rgba(250,250,250,${0.95 * k})`); core.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = core; g.beginPath(); g.ellipse(s.x, s.y, r * 0.8, r, 0, 0, Math.PI * 2); g.fill();
}

function grain(g, R, rng, n) {
  for (let i = 0; i < n; i++) {
    const v = rng();
    g.fillStyle = v > 0.5 ? `rgba(255,255,255,${0.05 + 0.06 * rng()})` : `rgba(0,0,0,${0.12 + 0.1 * rng()})`;
    g.fillRect(R.x + rng() * R.w, R.y + rng() * R.h, 2, 2);
  }
}

// state: { marks, reveal (0 = the picture only, 1 = the marks in), seed, dims }
export function drawHotspot(g, rect, { marks = [], reveal = 1, seed = 7, dims = batDims() } = {}) {
  const L = hotspotLayout(rect, { marks, dims });
  const rng = makeRng(seed);
  for (const view of [L.main, L.zoom]) {
    g.save();
    rr(g, view.x, view.y, view.w, view.h, 10); g.clip();
    const bg = g.createRadialGradient(view.x + view.w / 2, view.y + view.h * 0.55, 10, view.x + view.w / 2, view.y + view.h / 2, view.w * 0.8);
    bg.addColorStop(0, '#181818'); bg.addColorStop(1, '#050505');
    g.fillStyle = bg; g.fillRect(view.x, view.y, view.w, view.h);
    if (view === L.main) drawFront(g, L, dims);
    else drawZoom(g, L, dims);
    if (reveal > 0) for (const s of L.spots) if (s.view === (view === L.main ? 'main' : 'zoom')) spot(g, s, Math.min(1, reveal) * (0.75 + 0.25 * s.heat));
    grain(g, view, rng, Math.round(view.w * view.h / 260));
    // scan lines
    g.fillStyle = 'rgba(0,0,0,0.12)';
    for (let yy = view.y; yy < view.y + view.h; yy += 4) g.fillRect(view.x, yy, view.w, 1);
    g.restore();
    g.strokeStyle = 'rgba(255,255,255,0.28)'; g.lineWidth = 2;
    rr(g, view.x, view.y, view.w, view.h, 10); g.stroke();
  }
  // labels
  g.textBaseline = 'top'; g.textAlign = 'left';
  g.fillStyle = 'rgba(0,0,0,0.55)'; rr(g, L.main.x + 10, L.main.y + 10, 270, 38, 7); g.fill();
  g.fillStyle = '#ffffff'; g.font = '800 24px system-ui, sans-serif';
  g.fillText('HOT SPOT · FRONT-ON', L.main.x + 20, L.main.y + 17);
  g.fillStyle = 'rgba(0,0,0,0.55)'; rr(g, L.zoom.x + 10, L.zoom.y + 6, Math.min(200, L.zoom.w - 20), 30, 7); g.fill();
  g.fillStyle = '#ffffff'; g.font = '800 20px system-ui, sans-serif';
  g.fillText('THE BAT', L.zoom.x + 20, L.zoom.y + 11);
  const zb = L.zBat;
  g.fillStyle = '#9fb2c4'; g.font = '700 16px system-ui, sans-serif'; g.textBaseline = 'middle';
  g.save(); g.translate(zb.x - 14, zb.y + zb.h * 0.55); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.fillText('OUTSIDE EDGE', 0, 0); g.restore();
  g.save(); g.translate(zb.x + zb.w + 14, zb.y + zb.h * 0.55); g.rotate(Math.PI / 2); g.textAlign = 'center'; g.fillText('INSIDE EDGE', 0, 0); g.restore();
  g.textAlign = 'center'; g.fillText('TOE', zb.cx, zb.y + zb.h + 16);
  // caption
  const C = L.caption, text = reveal > 0 ? hotspotCaption(marks, dims) : 'HOT SPOT';
  g.fillStyle = 'rgba(255,255,255,0.06)'; rr(g, C.x, C.y, C.w, C.h, 10); g.fill();
  const hasMark = reveal > 0 && marks.some((m) => m.on === 'bat');
  g.fillStyle = hasMark ? '#ffffff' : '#c9d6e3';
  let size = Math.round(C.h * 0.46);
  g.font = `800 ${size}px system-ui, sans-serif`;
  while (size > 14 && g.measureText(text).width > C.w - 30) { size -= 2; g.font = `800 ${size}px system-ui, sans-serif`; }
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, C.x + C.w / 2, C.y + C.h / 2 + 1);
  return L;
}

function drawFront(g, L, dims) {
  const { S, ground, cx, pads, bat } = L;
  // thighs and hips (warm), shoes (cool)
  warm(g, 0.62, 22, () => { rr(g, cx - 0.24 * S, ground - 1.18 * S, 0.48 * S, 0.3 * S, 0.08 * S); });
  for (const p of pads) {
    warm(g, 0.6, 18, () => { rr(g, p.x - p.w * 0.45, ground - 0.98 * S, p.w * 0.9, 0.34 * S, p.w * 0.3); });
    warm(g, 0.28, 6, () => { rr(g, p.x - p.w * 0.6, ground - 0.07 * S, p.w * 1.25, 0.07 * S, 0.03 * S); });
    // the pad: cooler than the leg, its vertical bolsters and the knee roll
    warm(g, 0.4, 10, () => { rr(g, p.x - p.w / 2, p.top, p.w, p.bottom - p.top, p.w * 0.35); });
    g.strokeStyle = grey(0.3); g.lineWidth = 2;
    for (const f of [-0.25, 0, 0.25]) { g.beginPath(); g.moveTo(p.x + f * p.w, p.top + 0.14 * S); g.lineTo(p.x + f * p.w, p.bottom - 6); g.stroke(); }
    warm(g, 0.46, 8, () => { rr(g, p.x - p.w * 0.52, p.top + 0.06 * S, p.w * 1.04, 0.08 * S, 0.04 * S); });
  }
  // the bat in front of the pads (cool), the gloves on the handle (warm)
  warm(g, 0.2, 6, () => { rr(g, bat.handle.x, bat.handle.top, bat.handle.w, bat.handle.bottom - bat.handle.top, 3); });
  warm(g, 0.24, 8, () => { rr(g, bat.x, bat.y, bat.w, bat.h, 6); });
  g.strokeStyle = grey(0.36); g.lineWidth = 3; rr(g, bat.x, bat.y, bat.w, bat.h, 6); g.stroke();
  for (const gy of [0.09, 0.2]) warm(g, 0.78, 16, () => { rr(g, bat.cx - 0.055 * S, bat.y - (gy + 0.08) * S, 0.11 * S, 0.1 * S, 0.035 * S); });
}

function drawZoom(g, L) {
  const b = L.zBat;
  warm(g, 0.2, 6, () => { rr(g, b.handle.x, b.handle.top, b.handle.w, b.handle.bottom - b.handle.top, 3); });
  warm(g, 0.24, 10, () => { rr(g, b.x, b.y, b.w, b.h, 10); });
  g.strokeStyle = grey(0.4); g.lineWidth = 4; rr(g, b.x, b.y, b.w, b.h, 10); g.stroke();
  g.strokeStyle = grey(0.3); g.lineWidth = 2;
  for (const f of [0.18, 0.82]) { g.beginPath(); g.moveTo(b.x + b.w * f, b.y + 8); g.lineTo(b.x + b.w * f, b.y + b.h - 8); g.stroke(); }
}
