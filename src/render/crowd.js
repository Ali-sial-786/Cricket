// Spectators. One card per fan (2 triangles, merged into a few meshes by
// sector so the ones behind you are culled), drawn from a mask atlas of 15
// body types x 8 poses plus a column of specials (flags, photographers,
// stewards). The atlas holds no colours: R = form shading, and G/B pick one
// of four per-fan colours (hair-and-trousers, shirt, skin, accent: caps,
// hats, scarves, jersey trim, flags), stored premultiplied so the mips stay
// clean at 90 m. Everything that moves happens in the vertex shader:
//
//   idle life  sway, people standing up, clapping, leaning, waving a flag,
//              each on their own slow cycle
//   reactions  react(kind) sets one event (start time, where it started,
//              how fast it spreads, per-team mode and share of people) and
//              the cards work out their own part from it, so a boundary
//              sends a wave of jumping, arms-up fans round from where the
//              ball went, a wicket lifts one set of fans and puts the
//              other's hands on their heads, a dot gets a ripple of claps
//   uCheer     (game.cheer) the ground rising as the ball flies
//   uWave      the Mexican wave
//
// No per-frame buffer writes: per frame only a handful of uniforms change.
import * as THREE from 'three';

const CW = 64, CH = 128, COLS = 16, ROWS = 8;
const PPM = CH / 1.7;                         // cell = 0.85 m x 1.7 m (75 px/m)
export const CARD = { w: 0.85, h: 1.7, stand: 0.4 };   // a standing card starts 0.4 m up (shins hidden by the row in front)
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function mulberry(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Body types (columns 0-14). sw: half shoulder width (m).
const PEOPLE = [
  { sw: 0.2, hair: 'short', sleeve: 'short' },
  { sw: 0.23, hair: 'short', hat: 'cap', sleeve: 'short', belly: 0.03, shorts: true },
  { sw: 0.165, hair: 'long', sleeve: 'short', female: true },
  { sw: 0.22, hair: 'bald', sleeve: 'long', jersey: true },
  { sw: 0.17, hair: 'bun', sleeve: 'long', female: true, glasses: true },
  { sw: 0.2, hair: 'short', hat: 'sunhat', sleeve: 'long', collar: true },
  { sw: 0.19, hair: 'afro', sleeve: 'short', jersey: true },
  { sw: 0.175, hair: 'long', hat: 'sunhat', sleeve: 'short', female: true },
  { sw: 0.2, hair: 'short', hat: 'cap', sleeve: 'short', child: true, jersey: true, shorts: true },
  { sw: 0.18, hair: 'pigtails', sleeve: 'short', child: true, female: true },
  { sw: 0.24, hair: 'short', hat: 'bucket', sleeve: 'short', belly: 0.06, shorts: true },
  { sw: 0.17, hair: 'bob', hat: 'cap', sleeve: 'short', female: true, jersey: true },
  { sw: 0.21, hair: 'short', sleeve: 'long', scarf: true, glasses: true },
  { sw: 0.21, hair: 'short', hat: 'flat', sleeve: 'long', collar: true },
  { sw: 0.23, hair: 'short', sleeve: 'long', hood: true },
];
export const NPEOPLE = PEOPLE.length;
// Poses (rows). 0-4 seated, 5-7 standing.
const P = { SIT: 0, SIT2: 1, CLAPA: 2, CLAPB: 3, HEAD: 4, STAND: 5, UP: 6, CLAPS: 7 };
// Specials (column 15), by row.
const SPECIAL = { FLAG_A: 0, FLAG_B: 1, PHOTO: 2, STEWARD: 3, POLE_A: 4, POLE_B: 5 };
export const KIND = { FAN: 0, FLAG: 1, POLEFLAG: 2, PHOTO: 3, STEWARD: 4 };
export const TEAM = { NEUTRAL: 0, HOME: 1, AWAY: 2 };
// Reaction modes (uMode: per team, mode + share of people joining in).
const MODE = { NONE: 0, APPLAUD: 1, CELEBRATE: 2, GROAN: 3, OOH: 4, OVATION: 5, RISE: 6 };

// ------------------------------------------------------------------ atlas
// Slots by (G, B): dark (hair / trousers / shoes), shirt, skin, accent.
const SLOT = { dark: [0, 0], shirt: [255, 0], skin: [0, 255], accent: [255, 255] };
function crowdAtlasData() {
  const W = CW * COLS, H = CH * ROWS;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  let ox = 0, oy = 0, base = 0, outline = false;
  const X = (x) => ox + CW / 2 + x * PPM, Y = (y) => oy + CH - (y + base) * PPM;
  const col = (slot, s) => (outline ? 'rgb(38,0,0)' : `rgb(${Math.round(clamp01(s) * 255)},${SLOT[slot][0]},${SLOT[slot][1]})`);
  // Light from the upper left: a diagonal gradient across a part.
  const shade = (slot, x0, y0, x1, y1, s0 = 1, s1 = 0.66) => {
    if (outline) return col(slot, 0);
    const gr = g.createLinearGradient(X(x0), Y(y0), X(x1), Y(y1));
    gr.addColorStop(0, col(slot, s0)); gr.addColorStop(1, col(slot, s1));
    return gr;
  };
  const OL = 2.2;                          // outline width (px)
  const fillPath = (style) => { g.fillStyle = style; g.fill(); if (outline) { g.lineWidth = OL; g.strokeStyle = style; g.stroke(); } };
  const ellipse = (x, y, rx, ry, style, a0 = 0, a1 = Math.PI * 2) => { g.beginPath(); g.ellipse(X(x), Y(y), rx * PPM, ry * PPM, 0, a0, a1); fillPath(style); };
  const poly = (pts, style) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)))); g.closePath(); fillPath(style); };
  const limb = (x0, y0, x1, y1, w, style) => {
    g.lineCap = 'round'; g.strokeStyle = style; g.lineWidth = w * PPM + (outline ? OL : 0);
    g.beginPath(); g.moveTo(X(x0), Y(y0)); g.lineTo(X(x1), Y(y1)); g.stroke();
  };
  const rrect = (x0, y0, x1, y1, r, style) => {        // y0 bottom, y1 top (m)
    const L = X(x0), R = X(x1), T = Y(y1), B = Y(y0), rr = Math.min(r * PPM, (R - L) / 2, (B - T) / 2);
    g.beginPath(); g.moveTo(L + rr, T); g.arcTo(R, T, R, B, rr); g.arcTo(R, B, L, B, rr); g.arcTo(L, B, L, T, rr); g.arcTo(L, T, R, T, rr); g.closePath(); fillPath(style);
  };

  function person(sp, pose, variant) {
    const k = sp.child ? 0.7 : 1, standing = pose >= P.STAND;
    base = standing ? -CARD.stand : 0;
    const lean = pose === P.SIT2 && variant % 3 === 1;
    const drink = pose === P.SIT2 && variant % 3 === 2;
    const hipY = standing ? 0.93 * k : 0.5;
    let shY = hipY + 0.52 * k;
    if (lean) shY -= 0.09;
    const sw = sp.sw * (sp.child ? 0.74 : 1), waist = sw * 0.8 + (sp.belly || 0);
    const headR = 0.102 * (sp.child ? 0.9 : 1), headY = shY + 0.075 * k + headR + (lean ? -0.02 : 0);
    const legSlot = sp.shorts ? 'skin' : 'dark';
    // Long hair behind the shoulders, the hood behind the neck.
    if (sp.hair === 'long') rrect(-headR * 1.05, shY - 0.12, headR * 1.05, headY, 0.05, shade('dark', -0.1, headY, 0.1, shY - 0.1, 0.8, 0.5));
    if (sp.hood) ellipse(0, shY + 0.02, sw * 0.7, 0.08, shade('shirt', -0.2, shY + 0.1, 0.2, shY - 0.06, 0.8, 0.55));
    // Legs.
    if (standing) {
      for (const sx of [-1, 1]) {
        limb(sx * 0.085 * k, hipY - 0.02, sx * 0.095 * k, 0.12 * k, 0.12 * k, shade(sp.shorts ? 'dark' : legSlot, -0.1, hipY, 0.1, 0, 0.75, 0.5));
        if (sp.shorts) limb(sx * 0.093 * k, hipY * 0.55, sx * 0.095 * k, 0.1 * k, 0.085 * k, shade('skin', -0.1, hipY * 0.5, 0.1, 0, 0.9, 0.65));
        ellipse(sx * 0.1 * k, 0.04, 0.06 * k, 0.04, col('dark', 0.25));
      }
    } else {
      for (const sx of [-1, 1]) {
        // Shins down from the knee, thighs coming toward you (foreshortened).
        limb(sx * 0.1 * k, hipY - 0.05, sx * 0.1 * k, 0.1, 0.095 * k, shade(legSlot, -0.1, hipY, 0.1, 0, 0.8, 0.45));
        ellipse(sx * 0.1 * k, 0.05, 0.06 * k, 0.04, col('dark', 0.22));
        ellipse(sx * 0.085 * k, hipY - 0.02, 0.085 * k, 0.07, shade('dark', -0.15, hipY + 0.05, 0.15, hipY - 0.08, 0.9, 0.6));
      }
    }
    // Torso: shoulders to waist, a little narrower at the waist (wider with a belly).
    poly([[-sw, shY - 0.02], [-sw * 0.95, shY + 0.02], [sw * 0.95, shY + 0.02], [sw, shY - 0.02], [waist, hipY - 0.03], [-waist, hipY - 0.03]],
      shade('shirt', -sw, shY, sw, hipY - 0.05, 1, 0.62));
    if (sp.jersey) {                                     // team kit: trim on the shoulders and a band
      poly([[-sw, shY - 0.02], [-sw * 0.95, shY + 0.02], [-sw * 0.5, shY + 0.02], [-sw * 0.75, shY - 0.06]], shade('accent', -sw, shY, 0, shY - 0.06, 0.95, 0.75));
      poly([[sw, shY - 0.02], [sw * 0.95, shY + 0.02], [sw * 0.5, shY + 0.02], [sw * 0.75, shY - 0.06]], shade('accent', 0, shY, sw, shY - 0.06, 0.85, 0.65));
      rrect(-waist * 0.98, hipY + 0.12 * k, waist * 0.98, hipY + 0.16 * k, 0.01, shade('accent', -waist, 0, waist, 0, 0.9, 0.6));
    }
    if (sp.collar) poly([[-0.06, shY + 0.03], [0.06, shY + 0.03], [0, shY - 0.07]], col('skin', 0.95));
    if (sp.scarf) { rrect(-0.08, shY - 0.02, 0.08, shY + 0.05, 0.03, shade('accent', -0.08, shY, 0.08, shY, 1, 0.7)); rrect(0.02, shY - 0.3, 0.09, shY, 0.02, shade('accent', 0, shY, 0.1, shY - 0.3, 0.95, 0.6)); }
    // Arms: [elbow, hand] relative to each shoulder, x outward.
    const S = (sx) => [sx * (sw - 0.02), shY - 0.03];
    const arms = {
      [P.SIT]: [[0.03, -0.28], [-0.08 - sw * 0.2, -0.46]],
      [P.SIT2]: lean ? [[-0.01, -0.36], [-sw + 0.05, -0.12]] : drink ? null : [[0.025, -0.27], [-sw - 0.09, -0.2]],
      [P.CLAPA]: [[0.07, -0.25], [-sw + 0.08, -0.13]],
      [P.CLAPB]: [[0.06, -0.26], [-sw + 0.01, -0.12]],
      [P.HEAD]: [[0.14, 0.12], [-sw + 0.08, headY - shY + headR * 0.7]],
      [P.STAND]: variant % 2 ? [[0.035, -0.29], [0.015, -0.55]] : [[0.05, -0.27], [-0.02, -0.46]],
      [P.UP]: [[0.12, 0.24], [0.19, 0.5]],
      [P.CLAPS]: [[0.13, -0.18], [-sw + 0.01, -0.06]],
    }[pose];
    const forearm = sp.sleeve === 'long' ? 'shirt' : 'skin';
    const drawArm = (sx, el, ha, cup) => {
      const [x0, y0] = S(sx);
      const ex = x0 + sx * el[0] * k, ey = y0 + el[1] * k, hx = x0 + sx * ha[0] * k, hy = y0 + ha[1] * k;
      limb(x0, y0, ex, ey, 0.088 * k, shade('shirt', x0 - 0.05, y0, x0 + 0.05, ey, 0.92, 0.6));
      limb(ex, ey, hx, hy, 0.072 * k, shade(forearm, ex - 0.05, ey, ex + 0.05, hy, 0.95, 0.65));
      ellipse(hx, hy, 0.042 * k, 0.045 * k, shade('skin', hx - 0.04, hy + 0.04, hx + 0.04, hy - 0.04, 1, 0.7));
      if (cup) rrect(hx - 0.03, hy - 0.02, hx + 0.035, hy + 0.09, 0.01, shade('accent', hx - 0.03, hy, hx + 0.03, hy, 1, 0.7));
    };
    if (drink) { drawArm(-1, [0.03, -0.28], [-0.08 - sw * 0.2, -0.46]); drawArm(1, [0.06, -0.25], [-0.1, 0.02], true); }
    else for (const sx of [-1, 1]) drawArm(sx, arms[0], arms[1]);
    // Neck, head, face.
    rrect(-0.045 * k, shY - 0.01, 0.045 * k, shY + 0.09 * k, 0.02, col('skin', 0.72));
    if (sp.hair === 'afro') ellipse(0, headY + headR * 0.25, headR * 1.38, headR * 1.25, shade('dark', -0.1, headY + 0.1, 0.1, headY - 0.05, 0.85, 0.5));
    if (sp.hair === 'pigtails') for (const sx of [-1, 1]) ellipse(sx * headR * 1.25, headY - headR * 0.1, headR * 0.38, headR * 0.5, col('dark', 0.7));
    ellipse(0, headY, headR * 0.86, headR, shade('skin', -headR, headY + headR, headR, headY - headR, 1, 0.66));
    if (!outline) {
      ellipse(0, headY - headR * 0.05, headR * 0.6, headR * 0.12, col('skin', sp.glasses ? 0.18 : 0.62));      // eyes / sunglasses
      ellipse(0, headY - headR * 0.55, headR * 0.28, headR * 0.06, col('skin', 0.55));                          // mouth
    }
    // Hair.
    const hairS = shade('dark', -headR, headY + headR, headR, headY, 0.95, 0.55);
    if (sp.hair === 'short' || sp.hair === 'bob' || sp.hair === 'long' || sp.hair === 'bun' || sp.hair === 'pigtails') {
      ellipse(0, headY + headR * 0.35, headR * 0.92, headR * 0.7, hairS, Math.PI, Math.PI * 2);
      if (sp.hair === 'bob' || sp.hair === 'long') for (const sx of [-1, 1]) rrect(sx > 0 ? headR * 0.55 : -headR * 0.95, headY - headR * (sp.hair === 'long' ? 1.1 : 0.6), sx > 0 ? headR * 0.95 : -headR * 0.55, headY + headR * 0.4, 0.02, hairS);
      if (sp.hair === 'bun') ellipse(0, headY + headR * 1.05, headR * 0.42, headR * 0.34, hairS);
    }
    if (sp.hair === 'afro') ellipse(0, headY + headR * 0.55, headR * 1.15, headR * 0.6, hairS, Math.PI, Math.PI * 2);
    if (sp.hair === 'bald' && !outline) ellipse(-headR * 0.25, headY + headR * 0.55, headR * 0.35, headR * 0.2, col('skin', 1));
    // Headwear (accent).
    const hatS = shade('accent', -headR, headY + headR, headR, headY, 1, 0.65);
    if (sp.hat === 'cap') { ellipse(0, headY + headR * 0.38, headR * 0.96, headR * 0.72, hatS, Math.PI, Math.PI * 2); ellipse(0, headY + headR * 0.32, headR * 1.08, headR * 0.16, col('accent', 0.55)); }
    if (sp.hat === 'flat') { ellipse(0, headY + headR * 0.45, headR * 1.0, headR * 0.5, hatS, Math.PI, Math.PI * 2); ellipse(0, headY + headR * 0.42, headR * 1.08, headR * 0.12, col('accent', 0.5)); }
    if (sp.hat === 'sunhat') { ellipse(0, headY + headR * 0.4, headR * 1.85, headR * 0.3, col('accent', outline ? 0 : 0.8)); ellipse(0, headY + headR * 0.45, headR * 0.85, headR * 0.75, hatS, Math.PI, Math.PI * 2); }
    if (sp.hat === 'bucket') { poly([[-headR * 1.35, headY + headR * 0.15], [-headR * 0.75, headY + headR * 1.05], [headR * 0.75, headY + headR * 1.05], [headR * 1.35, headY + headR * 0.15]], hatS); }
  }

  function special(row) {
    base = 0;
    if (row === SPECIAL.FLAG_A || row === SPECIAL.FLAG_B) {
      // A hand-held flag: the pole up the left edge, the cloth at the top.
      if (!outline) {
        limb(-0.37, 0.12, -0.37, 1.66, 0.035, col('dark', 0.55));
        const x0 = -0.36, x1 = 0.4, y0 = 1.1, y1 = 1.64;
        for (let i = 0; i < 6; i++) {                        // folds: shading stripes along the cloth
          const a = x0 + ((x1 - x0) * i) / 6, b = x0 + ((x1 - x0) * (i + 1)) / 6, s = i % 2 ? 0.78 : 1;
          if (row === SPECIAL.FLAG_A) {
            poly([[a, y0], [b, y0], [b, y0 + 0.18], [a, y0 + 0.18]], col('shirt', s));
            poly([[a, y0 + 0.18], [b, y0 + 0.18], [b, y0 + 0.36], [a, y0 + 0.36]], col('accent', s));
            poly([[a, y0 + 0.36], [b, y0 + 0.36], [b, y1], [a, y1]], col('shirt', s));
          } else {
            const f = (x) => y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
            poly([[a, y0], [b, y0], [b, f(b)], [a, f(a)]], col('shirt', s));
            poly([[a, f(a)], [b, f(b)], [b, y1], [a, y1]], col('accent', s));
          }
        }
        if (row === SPECIAL.FLAG_B) ellipse(0.02, (y0 + y1) / 2, 0.09, 0.09, col('skin', 0.95));
      }
      return;
    }
    if (row === SPECIAL.POLE_A || row === SPECIAL.POLE_B) {
      // Cloth only, filling the cell (the card is stretched to flag shape).
      if (outline) return;
      const x0 = -0.425, x1 = 0.425, y0 = 0, y1 = 1.7;
      for (let i = 0; i < 8; i++) {
        const a = x0 + ((x1 - x0) * i) / 8, b = x0 + ((x1 - x0) * (i + 1)) / 8, s = 0.75 + 0.25 * Math.abs(Math.sin(i * 1.3));
        if (row === SPECIAL.POLE_A) {
          poly([[a, y0], [b, y0], [b, 0.57], [a, 0.57]], col('shirt', s));
          poly([[a, 0.57], [b, 0.57], [b, 1.13], [a, 1.13]], col('skin', s));
          poly([[a, 1.13], [b, 1.13], [b, y1], [a, y1]], col('accent', s));
        } else {
          poly([[a, y0], [b, y0], [b, y1], [a, y1]], col('shirt', s));
          if (i < 3) poly([[a, y0], [b, y0], [b, y1], [a, y1]], col('accent', s));
        }
      }
      if (row === SPECIAL.POLE_B) ellipse(0.1, 0.85, 0.16, 0.32, col('skin', 0.95));
      return;
    }
    if (row === SPECIAL.PHOTO) {
      // A photographer crouched on a stool behind a long lens.
      const sp = { sw: 0.2, sleeve: 'long' };
      ellipse(0, 0.32, 0.16, 0.1, col('dark', 0.35));
      poly([[-0.2, 0.86], [0.2, 0.86], [0.16, 0.4], [-0.16, 0.4]], shade('shirt', -0.2, 0.86, 0.2, 0.4));
      limb(-0.18, 0.84, -0.12, 0.62, 0.08, shade('shirt', -0.2, 0.8, 0, 0.6));
      limb(0.18, 0.84, 0.1, 0.66, 0.08, shade('shirt', 0, 0.8, 0.2, 0.6));
      ellipse(0, 1.01, 0.088, 0.1, shade('skin', -0.09, 1.1, 0.09, 0.9));
      ellipse(0, 1.07, 0.09, 0.06, col('dark', 0.7), Math.PI, Math.PI * 2);
      rrect(-0.09, 0.84, 0.09, 0.98, 0.02, col('dark', 0.3));                 // camera body
      ellipse(0, 0.9, 0.075, 0.075, shade('accent', -0.07, 0.97, 0.07, 0.83, 1, 0.6));   // the lens, end-on
      if (!outline) ellipse(0, 0.9, 0.04, 0.04, col('dark', 0.15));
      void sp;
      return;
    }
    if (row === SPECIAL.STEWARD) {
      // A steward facing the crowd: you see a hi-vis back.
      base = -CARD.stand;
      for (const sx of [-1, 1]) limb(sx * 0.09, 0.9, sx * 0.095, 0.12, 0.12, shade('dark', -0.1, 0.9, 0.1, 0, 0.6, 0.4));
      poly([[-0.21, 1.42], [0.21, 1.42], [0.17, 0.9], [-0.17, 0.9]], shade('accent', -0.21, 1.42, 0.21, 0.9, 1, 0.75));
      if (!outline) rrect(-0.17, 1.12, 0.17, 1.16, 0.005, col('skin', 0.95));       // reflective band
      for (const sx of [-1, 1]) limb(sx * 0.2, 1.4, sx * 0.23, 0.98, 0.08, shade('shirt', -0.2, 1.4, 0.2, 1.0, 0.7, 0.5));
      rrect(-0.04, 1.42, 0.04, 1.5, 0.02, col('skin', 0.6));
      ellipse(0, 1.6, 0.088, 0.1, shade('dark', -0.09, 1.7, 0.09, 1.5, 0.7, 0.45));
    }
  }

  for (let pass = 0; pass < 2; pass++) {
    outline = pass === 0;
    for (let row = 0; row < ROWS; row++) for (let colI = 0; colI < COLS; colI++) {
      ox = colI * CW; oy = row * CH;
      g.save(); g.beginPath(); g.rect(ox + 1, oy + 1, CW - 2, CH - 2); g.clip();    // keep a clear border: no bleeding between cells
      if (colI < NPEOPLE) person(PEOPLE[colI], row, colI); else special(row);
      g.restore();
    }
  }
  // Uploaded premultiplied (as the canvas holds it: no read-back, and the
  // mips average only what is there); the shader divides it out.
  const t = new THREE.CanvasTexture(c);
  t.premultiplyAlpha = true;
  t.flipY = false;                                 // cell rows counted from the top, as drawn
  t.colorSpace = THREE.NoColorSpace;               // a data mask, not colours
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = 2;
  return t;
}

// ------------------------------------------------------------------ shader
const VERT = /* glsl */`
  #include <common>
  #include <fog_pars_vertex>
  uniform float uTime, uCheer, uWave, uWaveOn;
  uniform float uAnim;    // 0: no idle life or sway (quality.js, a low level); they still react to play
  uniform vec4 uEvt;      // start time, origin angle, spread (rad/s), duration
  uniform vec4 uMode;     // home, away, neutral: mode + share joining in (fraction); w: unused
  uniform vec2 uWind;     // flag direction (xz, unit)
  attribute vec4 aFace;   // facing (xz, toward the pitch), card scale, angle round the ground
  attribute vec4 aInfo;   // body type, team, kind, rnd           (bytes)
  attribute vec4 aLight;  // baked light (rgb / 1.6), rnd2        (bytes)
  attribute vec4 aC0; attribute vec4 aC1; attribute vec4 aC2; attribute vec4 aC3;   // dark, shirt, skin, accent (sRGB) + idle data in alpha
  varying vec2 vUv; varying vec3 vC0; varying vec3 vC1; varying vec3 vC2; varying vec3 vC3; varying vec3 vLight;
  float h1(float n) { return fract(sin(n) * 43758.5453); }
  void main() {
    int corner = gl_VertexID & 3;
    float cx = float(corner & 1) * 2.0 - 1.0, cy = float(corner >> 1);
    float body = floor(aInfo.x * 255.0 + 0.5), team = floor(aInfo.y * 255.0 + 0.5), kind = floor(aInfo.z * 255.0 + 0.5);
    float rnd = aInfo.w, rnd2 = aLight.w, idle = floor(aC1.a * 255.0 + 0.5), ph = aC2.a * 6.2832;
    float stander = mod(idle, 2.0), idlePose = floor(idle / 2.0);
    float scale = aFace.z, ang = aFace.w;
    float t = uTime;

    // ---- what this fan is doing
    float pose = stander > 0.5 ? 5.0 : idlePose, lift = 0.0, flagUp = 0.0;
    float clap = step(0.5, fract(t * 3.3 + ph));
    if (uAnim > 0.5) {
    // Idle life: now and then (own period) stand up, clap, change position, wave.
    float per = 15.0 + rnd * 28.0, cyc = t / per + rnd2 * 9.0, ci = floor(cyc);
    float act = h1(ci * 12.9898 + rnd * 78.233);
    if (fract(cyc) < 0.06 + 0.07 * act) {
      if (act < 0.2) pose = 5.0;
      else if (act < 0.45) pose = pose > 4.5 ? 7.0 - 2.0 * clap : 2.0 + clap;
      else if (act < 0.72) pose = pose > 4.5 ? 5.0 : 1.0 - idlePose;
      else if (act < 0.8) { pose = 6.0; flagUp = 1.0; }
      else if (act < 0.86) flagUp = 1.0;
    }
    }
    // The event: each team its own mode; it reaches you after travelling round from where it started.
    float m = team < 0.5 ? uMode.z : (team < 1.5 ? uMode.x : uMode.y);
    float mode = floor(m), share = fract(m) * 1.02;
    float da = abs(mod(ang - uEvt.y + PI, PI2) - PI);
    float te = t - uEvt.x - da / max(uEvt.z, 0.05) - rnd2 * 0.45;
    float on = step(0.0, te) * step(te, uEvt.w * (0.55 + 0.45 * rnd)) * step(rnd, share);
    if (on > 0.5) {
      float jf = fract(t * 1.7 + ph);
      if (mode == 1.0) pose = pose > 4.5 ? 7.0 - 2.0 * clap : 2.0 + clap;
      else if (mode == 2.0) { pose = jf < 0.75 ? 6.0 : 7.0; lift = 0.14 * max(0.0, sin(jf * PI2)) * (0.5 + rnd); flagUp = 1.0; }
      else if (mode == 3.0) pose = te < uEvt.w * 0.45 ? 4.0 : 0.0;
      else if (mode == 4.0) pose = te < 1.6 ? 4.0 : pose;
      else if (mode == 5.0) { pose = 7.0 - 2.0 * clap; flagUp = 1.0; }
      else if (mode == 6.0) pose = 5.0;
    }
    // The ground rising with a big hit, and the Mexican wave.
    if (team != 2.0 && rnd < uCheer * 1.15 - 0.08) { pose = 6.0 + step(0.8, fract(t * 1.9 + ph)); lift = uCheer * 0.15 * abs(sin(t * 6.0 + ph)); flagUp = 1.0; }
    float dw = mod(ang - uWave + PI, PI2) - PI;
    float wave = uWaveOn * exp(-dw * dw * 30.0);
    if (wave > 0.3) { pose = 6.0; lift = wave * 0.28; flagUp = 1.0; }
    float standing = step(4.5, pose);

    // ---- the card: faces the pitch, turned part of the way toward the eye
    vec4 seat = modelMatrix * vec4(position, 1.0);
    vec2 n = aFace.xy;
    vec2 toEye = cameraPosition.xz - seat.xz;
    toEye /= max(length(toEye), 1e-3);
    vec2 n2 = normalize(n + toEye * max(dot(n, toEye), 0.0) * 0.8);
    vec3 right = vec3(n2.y, 0.0, -n2.x);
    float col = body, row = pose;
    vec3 p = seat.xyz;
    float sway = uAnim * (sin(t * 0.8 + ph) * 0.018 + sin(t * 2.3 + ph * 3.0) * 0.006);
    float far = smoothstep(45.0, 100.0, length(cameraPosition - seat.xyz));
    if (kind < 0.5) {
      p += right * (cx * 0.425 * (1.0 + 0.12 * far) + sway) * scale;
      p.y += (cy * 1.7 + standing * 0.4) * scale + lift + 0.006 * sin(t * 1.3 + ph);
    } else if (kind < 1.5) {
      // A flag held up beside its owner: swings about the hands, the free corner flaps.
      col = 15.0; row = mod(body, 2.0);
      float sw = (sin(t * 2.4 + ph) * 0.5 + sin(t * 1.1 + ph * 2.0) * 0.25);
      vec2 q = vec2(cx * 0.425 + 0.37, cy * 1.7 - 0.45);
      q += vec2(0.0, (cx * 0.5 + 0.5) * cy * 0.09 * sin(t * 9.0 + ph));
      float c = cos(sw), s = sin(sw);
      q = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
      p += (right * (q.x + 0.18) + vec3(0.0, q.y + 1.05 + lift / max(scale, 0.1), 0.0)) * scale * flagUp;
    } else if (kind < 2.5) {
      // A flag on a pole round the top of the stands: streams with the wind.
      col = 15.0; row = 4.0 + mod(body, 2.0);
      float u = cx * 0.5 + 0.5;
      vec3 along = vec3(uWind.x, 0.0, uWind.y), side = vec3(-uWind.y, 0.0, uWind.x);
      float fl = sin(t * 5.5 + ph - u * 2.5) * u;
      p += (along * u * 1.9 + side * fl * 0.25 + vec3(0.0, (cy - 1.0) * 1.15 + fl * 0.12, 0.0)) * scale;
      right = along;
    } else {
      col = 15.0; row = kind < 3.5 ? 2.0 : 3.0;
      p += right * cx * 0.425 * scale;
      p.y += (cy * 1.7 + (kind > 3.5 ? 0.4 : 0.0)) * scale;
    }
    vUv = vec2((col + 0.5 + cx * 0.492) / 16.0, (row + 1.0 - cy * 0.996 - 0.002) / 8.0);
    vC0 = pow(aC0.rgb, vec3(2.2)); vC1 = pow(aC1.rgb, vec3(2.2)); vC2 = pow(aC2.rgb, vec3(2.2)); vC3 = pow(aC3.rgb, vec3(2.2));
    vLight = aLight.rgb * 1.6;
    vec4 mvPosition = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const FRAG = /* glsl */`
  #include <common>
  #include <fog_pars_fragment>
  uniform sampler2D map;
  varying vec2 vUv; varying vec3 vC0; varying vec3 vC1; varying vec3 vC2; varying vec3 vC3; varying vec3 vLight;
  void main() {
    vec4 tx = texture2D(map, vUv);
    vec3 m = tx.rgb / max(tx.a, 0.004);
    vec3 c = mix(mix(vC0, vC2, m.b), mix(vC1, vC3, m.b), m.g) * (m.r * vLight);
    float texels = max(fwidth(vUv.x) * 1024.0, fwidth(vUv.y) * 1024.0);
    float th = mix(0.32, 0.2, smoothstep(1.5, 6.0, texels));    // far: mips average a figure with its holes
    float a = smoothstep(th, th + max(fwidth(tx.a), 0.02), tx.a);
    if (a < 0.01) discard;
    gl_FragColor = vec4(c, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

// ------------------------------------------------------------------ palettes
const HEX = new Map();
const hex = (h) => { let v = HEX.get(h); if (!v) HEX.set(h, (v = [(h >> 16) & 255, (h >> 8) & 255, h & 255])); return v; };
const KIT = {
  home: { a: [0x1f4fa8, 0x1d4a9e, 0x2a5cb8, 0x14285a], b: [0xf2c12e, 0xe8b322, 0xffffff] },     // royal blue / gold
  away: { a: [0xb3221c, 0xa51e19, 0xc42b23, 0x7a1712], b: [0xf4f4f4, 0xffffff, 0x1a1a1a] },     // crimson / white
};
const CASUAL = [0xf2f0ea, 0xe8e6e0, 0x2b2f3a, 0x1c2230, 0x3c4a63, 0x7d8a99, 0xb8bec6, 0xd8cdb4, 0x6b6a45, 0x4e5d3a,
  0x8a2f35, 0x5d2a3a, 0xcf7f8a, 0xe2b7b0, 0x9bb7d4, 0x5f86b3, 0xe9d58a, 0xc58b4a, 0x2f6b6a, 0x3a3a3a, 0xffffff, 0x9e4b3c];
const SKINS = [0xf6d7bd, 0xefc6a3, 0xe3b48c, 0xd09c70, 0xb8825a, 0x9a6844, 0x7c5034, 0x5e3a26];
const HAIRS = [0x16110d, 0x241912, 0x3a2a1d, 0x56402c, 0x7a5a3a, 0xa98252, 0xcfae70, 0x8f8f8f, 0xc9c6c0, 0x5c2a18];
const TROUSERS = [0x2a3446, 0x1d2430, 0x3b4f6e, 0x4a4a4a, 0x8c7a5a, 0x22252a, 0x52606e];
const HATS = [0xf4f1e8, 0xe7dcc0, 0xd9c58f, 0x2b3550, 0xffffff, 0x9a3b30, 0x3f5a3a, 0x1c1c1c];

// lights: [{ dir: Vector3 toward the light, color: Color (x intensity) }], hemi: HemisphereLight
function makeLighting(dirs, hemi) {
  const sky = hemi ? hemi.color.clone().multiplyScalar(hemi.intensity) : new THREE.Color(1, 1, 1);
  const ground = hemi ? hemi.groundColor.clone().multiplyScalar(hemi.intensity) : new THREE.Color(0.4, 0.4, 0.4);
  return (nx, ny, nz, sunVis, skyVis, out) => {
    const h = ny * 0.5 + 0.5;
    let r = (ground.r + (sky.r - ground.r) * h) * skyVis, g = (ground.g + (sky.g - ground.g) * h) * skyVis, b = (ground.b + (sky.b - ground.b) * h) * skyVis;
    for (let i = 0; i < dirs.length; i++) {
      const d = dirs[i], k = Math.max(0, nx * d.dir.x + ny * d.dir.y + nz * d.dir.z) * (i === 0 ? sunVis : 0.5 + 0.5 * skyVis);
      r += d.color.r * k; g += d.color.g * k; b += d.color.b * k;
    }
    r += 0.42 * skyVis; g += 0.41 * skyVis; b += 0.38 * skyVis;     // bounce off the sunlit field (as the stands' shader)
    out[0] = r / Math.PI; out[1] = g / Math.PI; out[2] = b / Math.PI;
    return out;
  };
}

// spots: [{ x, y, z (relative to the pitch centre), nx, nz (facing), sun, sky (0..1 visibility),
//           block (seat block id), row, tier, kind: KIND.*, type: 'seat'|'stand'|'grass'|'members', team? }]
// blocks: Map block id -> { home, away, occ, ultras }  (shares of each team, occupancy)
export function buildCrowd(spots, { blocks, lights, maxCount = 26000, sectors = 8, seed = 11, wind = [0.8, -0.6] } = {}) {
  const rand = mulberry(seed);
  const uniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    map: { value: crowdAtlasData() },
    uTime: { value: 0 }, uCheer: { value: 0 }, uWave: { value: 0 }, uWaveOn: { value: 0 }, uAnim: { value: 1 },
    uEvt: { value: new THREE.Vector4(-100, 0, 1, 0) }, uMode: { value: new THREE.Vector4(0, 0, 0, 0) },
    uWind: { value: new THREE.Vector2(wind[0], wind[1]).normalize() },
  };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide, fog: true, alphaToCoverage: true });
  const light = makeLighting(lights.dirs, lights.hemi);
  const L = [0, 0, 0];

  // Who sits where. A block has its own fill and mix of shirts; empty seats
  // come in small clusters (a family gone for food), not as single holes.
  const fans = [];
  const holeSeed = rand() * 100;
  const hole = (b, row, i) => { const v = Math.sin(b * 12.7 + row * 3.1 + Math.floor(i / 5) * 1.71 + holeSeed) * 43758.5453; return v - Math.floor(v); };
  for (let i = 0; i < spots.length; i++) {
    const s = spots[i];
    if (s.kind !== undefined && s.kind !== KIND.FAN) { fans.push(s); continue; }
    const B = blocks.get(s.block) || { home: 0.4, away: 0.1, occ: 0.85 };
    if (hole(s.block, s.row || 0, s.i || i) > B.occ + (rand() - 0.5) * 0.12) continue;
    fans.push(s);
  }
  const stride = Math.max(1, fans.length / maxCount);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const N = Math.floor(fans.length / stride);
  const bySector = Array.from({ length: sectors }, () => []);
  for (let f = 0; f < N; f++) {
    const s = fans[Math.floor(f * stride)];
    const a = Math.atan2(s.x, s.z);
    bySector[Math.floor(((a + Math.PI) / (Math.PI * 2)) * sectors) % sectors].push(s);
    if (s.kind === undefined || s.kind === KIND.FAN) {
      // A few fans in each team block carry a flag: an extra card that shares their timing.
      const B = blocks.get(s.block);
      if (B && (B.ultras ? rand() < 0.05 : rand() < 0.012) && s.type !== 'members') s.flag = true;
    }
  }
  const group = new THREE.Group();
  group.name = 'crowd';
  let total = 0;
  for (const list of bySector) {
    const cards = [];
    for (const s of list) { cards.push(s); if (s.flag) cards.push({ ...s, kind: KIND.FLAG, owner: s }); }
    const n = cards.length, nv = n * 4;
    if (!n) continue;
    const pos = new Float32Array(nv * 3), face = new Float32Array(nv * 4);
    const info = new Uint8Array(nv * 4), lit = new Uint8Array(nv * 4);
    const cA = [new Uint8Array(nv * 4), new Uint8Array(nv * 4), new Uint8Array(nv * 4), new Uint8Array(nv * 4)];
    const index = new Uint32Array(n * 6);
    // Density (quality.js): the cards go into the index in four quarters, each
    // spread through the whole sector (a hash of the seat; a flag with its
    // owner; everyone who is not a fan in the first) and in seat order inside it, so drawing the first 1-3 quarters
    // thins the crowd evenly instead of emptying a block.
    const quarter = new Uint8Array(n), qn = [0, 0, 0, 0];
    cards.forEach((s, ci) => {
      const v = Math.sin(s.x * 12.9898 + s.z * 78.233 + s.y * 37.719) * 43758.5453;
      const k = s.kind ?? KIND.FAN;     // (pole flags, photographers and stewards always stay)
      quarter[ci] = k === KIND.FLAG ? quarter[ci - 1] : k !== KIND.FAN ? 0 : Math.floor((v - Math.floor(v)) * 4);
      qn[quarter[ci]]++;
    });
    const qAt = [0, qn[0], qn[0] + qn[1], qn[0] + qn[1] + qn[2]], slot = qAt.slice();
    let prev = null;
    cards.forEach((s, ci) => {
      const kind = s.kind ?? KIND.FAN;
      let body, team, cols, scale, idle, rnd, rnd2, ph;
      if (kind === KIND.FLAG) {
        // Same timing bytes as its owner, so it goes up when they do.
        ({ team, rnd, rnd2, ph, idle } = prev.d);
        body = Math.floor(rand() * 2); scale = prev.d.scale;
        const kit = team === 2 ? KIT.away : KIT.home;
        cols = [hex(0x3a3a3a), hex(kit.a[0]), hex(0xffffff), hex(kit.b[0])];
      } else if (kind === KIND.POLEFLAG) {
        team = 0; rnd = rand(); rnd2 = rand(); ph = rand(); idle = 0; body = s.design ?? 0; scale = s.scale ?? 1.25;
        cols = s.cols.map(hex);
      } else if (kind === KIND.PHOTO || kind === KIND.STEWARD) {
        team = 0; rnd = rand(); rnd2 = rand(); ph = rand(); idle = 0; body = 0; scale = 1;
        cols = kind === KIND.PHOTO ? [hex(0x15171a), hex(pick([0x2b2f3a, 0x1c2230, 0x6b6a45, 0x3a3a3a])), hex(pick(SKINS)), hex(pick([0xe8e8e2, 0x2a2a2a]))]
          : [hex(0x1d2430), hex(0x1d2430), hex(pick(SKINS)), hex(0xd8f23a)];
      } else {
        const B = blocks.get(s.block) || { home: 0.4, away: 0.1 };
        const r0 = rand();
        const sh = s.home ?? B.home, sa = s.away ?? B.away;      // (a seat near a block's edge has a blended mix)
        team = s.team ?? (r0 < sh ? 1 : r0 < sh + sa ? 2 : 0);
        const kid = s.type !== 'members' && rand() < (s.row != null && s.row < 4 ? 0.12 : 0.05);
        body = kid ? (rand() < 0.5 ? 8 : 9) : pick([0, 1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14]);
        if (s.type === 'members') body = pick([5, 13, 12, 3, 7, 0, 5, 13]);
        const sp = PEOPLE[body];
        const kit = team === 1 ? KIT.home : team === 2 ? KIT.away : null;
        // Team fans mostly wear the shirt (a few just a cap or scarf); everyone else dresses for a day out.
        const inKit = kit && rand() < (B.ultras ? 0.9 : 0.7);
        const shirt = inKit ? pick(kit.a) : s.type === 'members' ? pick([0xf2efe6, 0x2b3550, 0xe8e2d0, 0x1f2a44, 0x9bb7d4, 0xffffff]) : pick(CASUAL);
        let accent;
        if (sp.jersey) accent = inKit ? pick(kit.b) : pick(CASUAL);
        else if (sp.scarf || sp.hat === 'cap') accent = kit ? (rand() < 0.7 ? pick(kit.a.concat(kit.b)) : pick(HATS)) : pick(HATS.concat(CASUAL));
        else accent = s.type === 'members' && sp.hat === 'sunhat' ? 0xe8dcb0 : pick(HATS);
        const hairC = rand() < 0.1 && s.type === 'members' ? 0xbdb9b2 : pick(HAIRS);
        // The dark slot is hair and trousers: a cool dark for most, the hair colour itself for some.
        const dark = rand() < 0.55 ? pick(TROUSERS) : hairC;
        cols = [hex(dark), hex(shirt), hex(pick(SKINS)), hex(accent)];
        scale = (kid ? 1 : 0.93 + rand() * 0.13);
        rnd = rand(); rnd2 = rand(); ph = rand();
        const stander = s.type === 'stand' || (B.ultras && rand() < 0.35) || (s.type === 'grass' ? false : rand() < 0.025);
        const idlePose = rand() < 0.7 ? 0 : 1;
        idle = idlePose * 2 + (stander ? 1 : 0);
      }
      // Baked light: a person is roughly a cylinder facing the pitch, lit from above too.
      const nx = s.nx * 0.78, nz = s.nz * 0.78, ny = 0.62;
      light(nx, ny, nz, s.sun ?? 1, s.sky ?? 1, L);
      const ang = (Math.atan2(s.x, s.z) + Math.PI * 2) % (Math.PI * 2);
      const d = { team, rnd, rnd2, ph, idle, scale };
      if (kind !== KIND.FLAG) prev = { d };
      for (let c = 0; c < 4; c++) {
        const v = ci * 4 + c;
        pos[v * 3] = s.x; pos[v * 3 + 1] = s.y; pos[v * 3 + 2] = s.z;
        face[v * 4] = s.nx; face[v * 4 + 1] = s.nz; face[v * 4 + 2] = scale; face[v * 4 + 3] = ang;
        info[v * 4] = body; info[v * 4 + 1] = team; info[v * 4 + 2] = kind; info[v * 4 + 3] = Math.round(rnd * 255);
        lit[v * 4] = Math.round(clamp01(L[0] / 1.6) * 255); lit[v * 4 + 1] = Math.round(clamp01(L[1] / 1.6) * 255); lit[v * 4 + 2] = Math.round(clamp01(L[2] / 1.6) * 255); lit[v * 4 + 3] = Math.round(rnd2 * 255);
        for (let k = 0; k < 4; k++) { cA[k][v * 4] = cols[k][0]; cA[k][v * 4 + 1] = cols[k][1]; cA[k][v * 4 + 2] = cols[k][2]; }
        cA[0][v * 4 + 3] = 0; cA[1][v * 4 + 3] = idle; cA[2][v * 4 + 3] = Math.round(ph * 255); cA[3][v * 4 + 3] = 0;
      }
      const i6 = slot[quarter[ci]]++ * 6, i4 = ci * 4;
      index[i6] = i4; index[i6 + 1] = i4 + 1; index[i6 + 2] = i4 + 2; index[i6 + 3] = i4 + 2; index[i6 + 4] = i4 + 1; index[i6 + 5] = i4 + 3;
    });
    total += list.length;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aFace', new THREE.BufferAttribute(face, 4));
    geo.setAttribute('aInfo', new THREE.BufferAttribute(info, 4, true));
    geo.setAttribute('aLight', new THREE.BufferAttribute(lit, 4, true));
    cA.forEach((arr, k) => geo.setAttribute('aC' + k, new THREE.BufferAttribute(arr, 4, true)));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeBoundingSphere();
    geo.boundingSphere.radius += 6;               // cards rise, flags fly
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'crowd-sector';
    mesh.userData.quarters = [qAt[1] * 6, qAt[2] * 6, qAt[3] * 6, n * 6];   // index counts drawing 1..4 quarters
    group.add(mesh);
  }
  group.userData.uniforms = uniforms;
  group.userData.count = total;
  group.userData.react = (kind, strength = 1, angle = null) => react(uniforms, kind, strength, angle, rand);
  // Quality hook (render/quality.js): share of the crowd drawn (whole quarters) and whether it moves.
  group.userData.setQuality = (density = 1, anim = true) => {
    const q = Math.max(1, Math.min(4, Math.round(density * 4)));
    for (const m of group.children) if (m.userData.quarters) m.geometry.setDrawRange(0, q === 4 ? Infinity : m.userData.quarters[q - 1]);
    uniforms.uAnim.value = anim ? 1 : 0;
  };
  return group;
}

// ------------------------------------------------------------------ reactions
// What each kind of moment does to each set of fans: [home, away, neutral]
// as [mode, share], how long it lasts and how fast it spreads (rad/s round
// the ground; a boundary starts where the ball went, the rest anywhere).
const M = MODE;
const REACT = {
  four: { h: [M.CELEBRATE, 0.7], a: [M.APPLAUD, 0.25], n: [M.CELEBRATE, 0.45], dur: 4.5, spread: 1.5, fromBall: true },
  six: { h: [M.CELEBRATE, 0.92], a: [M.APPLAUD, 0.35], n: [M.CELEBRATE, 0.7], dur: 6, spread: 1.3, fromBall: true },
  boundaryAgainst: { h: [M.APPLAUD, 0.3], a: [M.CELEBRATE, 0.85], n: [M.APPLAUD, 0.35], dur: 4.5, spread: 1.5, fromBall: true },
  wicketFor: { h: [M.CELEBRATE, 0.95], a: [M.GROAN, 0.8], n: [M.CELEBRATE, 0.6], dur: 6, spread: 3 },
  wicketAgainst: { h: [M.GROAN, 0.85], a: [M.CELEBRATE, 0.95], n: [M.APPLAUD, 0.4], dur: 5, spread: 3 },
  milestone: { h: [M.OVATION, 0.9], a: [M.APPLAUD, 0.5], n: [M.OVATION, 0.7], dur: 6, spread: 2 },
  dot: { h: [M.APPLAUD, 0.22], a: [M.APPLAUD, 0.12], n: [M.APPLAUD, 0.15], dur: 2.4, spread: 0.9 },
  beaten: { h: [M.OOH, 0.45], a: [M.OOH, 0.35], n: [M.OOH, 0.35], dur: 2.2, spread: 6 },
  edge: { h: [M.OOH, 0.55], a: [M.OOH, 0.5], n: [M.OOH, 0.45], dur: 2.2, spread: 6 },
  close: { h: [M.RISE, 0.4], a: [M.RISE, 0.4], n: [M.RISE, 0.3], dur: 2.5, spread: 6 },
  appeal: { h: [M.RISE, 0.3], a: [M.RISE, 0.3], n: [M.RISE, 0.2], dur: 2.5, spread: 6 },
  skied: { h: [M.RISE, 0.55], a: [M.RISE, 0.55], n: [M.RISE, 0.45], dur: 3, spread: 6 },
  dropped: { h: [M.GROAN, 0.7], a: [M.CELEBRATE, 0.5], n: [M.OOH, 0.5], dur: 3.5, spread: 4 },
  miss: { h: [M.OOH, 0.3], a: [M.APPLAUD, 0.2], n: [M.OOH, 0.25], dur: 2, spread: 6 },
};
function react(u, kind, strength, angle, rand) {
  const R = REACT[kind];
  if (!R) return false;
  const s = Math.max(0.2, Math.min(1.2, strength ?? 1));
  const enc = ([mode, share]) => mode + Math.min(0.98, share * s);
  u.uMode.value.set(enc(R.h), enc(R.a), enc(R.n), 0);
  const a = R.fromBall && angle != null ? angle : rand() * Math.PI * 2;
  u.uEvt.value.set(u.uTime.value, a, R.spread, R.dur);
  return true;
}
