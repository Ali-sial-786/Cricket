// How the figures look beyond their shape: the two (fictional) teams' kits,
// the shared detail textures every figure samples, and the per-player
// variation (skin, hair, beard, build, sleeves, little extras) that keeps
// eleven team-mates from being one man eleven times.
//
// Two textures, built once at load and shared by every figure's material
// (so one shader program, one draw call per figure as before):
//  * the face map (256 x 512, linear RGBA, painted per texel from the model's own
//    landmarks): R shading (creases, sockets, nostrils; 0.5 = none),
//    G beard field (how central to a beard a point is), B liner (< 0.5: lash
//    line, brows, painted iris) / eye white (> 0.5: only for the distant
//    model, which has no eyeballs), A lips. Projected from the front of the
//    head in bind space, so it rides on the skinned face.
//  * the decal atlas (1024², sRGB canvas): lettering glyphs (fill in R,
//    outline in G), the team crests, chest sponsors and the kit maker's mark.
// Both are sampled at most once per fragment (textureGrad with derivatives
// taken outside the branch, so region edges never pick a blurred mip).
import * as THREE from 'three';

// ------------------------------------------------------------------ teams
// Kit slots: kit1 shirt, kit2 trim / lettering, kit3 headgear, kit4 trousers,
// panel = shoulder yoke, sleeve pattern; band = cap / helmet stripe.
export const TEAMS = {
  home: { name: 'HARBOUR KESTRELS', crest: 0, sponsor: 0,
    kit1: 0x1d4fb0, kit2: 0xf3c331, kit3: 0x10275e, kit4: 0x14306e, panel: 0x16408f },
  away: { name: 'REDFIELD FOXES', crest: 1, sponsor: 1,
    kit1: 0xb5231d, kit2: 0xf6f3ea, kit3: 0x5a100d, kit4: 0x761611, panel: 0x8e1813 },
  umpire: { name: '', crest: 2, sponsor: -1,
    kit1: 0xf1eee4, kit2: 0x232838, kit3: 0xf2efe2, kit4: 0x272d3d, panel: 0xe6e2d6 },
};

// Skin tones (sRGB) from fair to deep, and hair colours.
export const SKIN_TONES = [0xf1cfb1, 0xe6b893, 0xd9a47c, 0xc68e62, 0xae7650, 0x94603e, 0x7a4b2f, 0x5e3a25];
export const HAIR = [0x17110d, 0x2b1e15, 0x45311f, 0x0b0b0b, 0x6b4a2c, 0x8f6a3e, 0x3a3532, 0x9a9089];
const IRIS = [0x3b2414, 0x4d2f18, 0x2a1a10, 0x5b4128, 0x3f5468, 0x4e6448, 0x1c120c];
// Invented surnames for the backs of the shirts.
const NAMES = ['ALDERTON', 'BRANDT', 'CASWELL', 'DESAI', 'ELLERY', 'FARROW', 'GUNASENA', 'HOLLOWAY', 'IQBAL', 'JARVIS',
  'KHUMALO', 'LARKIN', 'MORLEY', 'NAIDU', 'OKAFOR', 'PEMBRY', 'QUINLAN', 'RATHORE', 'SELBY', 'THORNE', 'UPTON', 'VANCE',
  'WICKRAM', 'YATES', 'ZAIDI', 'BAPTISTE', 'CORNISH', 'DALTON', 'FERREIRA', 'GRAYSON', 'HUSSAIN', 'MCKAY', 'PATEL', 'ROWE'];

// ------------------------------------------------------------------ per-player look
// Deterministic from the seed: the same man looks the same every session.
// role: 'player' | 'umpire' | 'self' (your own body: no extras on the arms you look at).
export function lookFor(seed, team, role = 'player') {
  let s = (seed * 2654435761) >>> 0;
  const r = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  for (let i = 0; i < 3; i++) r();
  const pick = (a) => a[Math.floor(r() * a.length)];
  const skinIx = Math.floor(r() * SKIN_TONES.length);
  // (fair-skinned men more often have lighter hair; most hair is dark)
  const hair = skinIx <= 1 && r() < 0.45 ? pick([0x45311f, 0x6b4a2c, 0x8f6a3e, 0x2b1e15]) : pick([0x17110d, 0x2b1e15, 0x0b0b0b, 0x17110d, 0x45311f]);
  const older = role === 'umpire' && r() < 0.6;
  const beardRoll = r();
  const L = {
    skin: SKIN_TONES[skinIx],
    hair: older ? pick([0x6b6560, 0x9a9089, 0x3a3532]) : hair,
    iris: skinIx <= 1 ? pick(IRIS) : pick([IRIS[0], IRIS[1], IRIS[2], IRIS[6]]),
    build: (r() - 0.35) * 0.012,                     // m of girth added to the cloth and arms (-4 .. +8 mm)
    hairVol: r() * 0.006,                            // m: hair standing off the scalp below the cap
    hairCut: 0.35 + r() * 0.65,                      // 0.35 cropped .. 1 full
    beard: beardRoll < 0.16 ? 0.5 + r() * 0.5 : beardRoll < 0.24 ? 0.22 : 0,    // a beard (short .. full) / goatee / none
    stubble: r() * 0.7,
    sleeves: role === 'umpire' ? 1 : role === 'player' && r() < 0.22 ? 1 : 0,
    sweatband: role === 'player' && r() < 0.3 ? 1 : 0,
    zinc: role === 'player' && r() < 0.05 ? 1 : 0,
    shades: role === 'player' && r() < 0.2,
    scale: role === 'self' ? 1 : 0.955 + r() * 0.09, // height (only where the caller lets it vary)
    name: pick(NAMES),
  };
  if (role === 'self') { L.sweatband = 0; L.sleeves = 0; L.build = 0; }
  return L;
}

// ------------------------------------------------------------------ decal atlas layout
// Rectangles in canvas pixels (x, y, w, h), y down; converted to uv rects for the shader.
const AT = 1024;
export const GLYPH = { x: 0, y: 0, w: 64, h: 96, cols: 16 };
const CREST = [[0, 288, 256, 256], [256, 288, 256, 256], [512, 288, 256, 256]];
const MAKER = [768, 288, 256, 128];
const SPONSOR = [[0, 544, 512, 128], [512, 544, 512, 128]];
export const glyphOf = (ch) => (ch >= '0' && ch <= '9' ? ch.charCodeAt(0) - 48 : ch >= 'A' && ch <= 'Z' ? 10 + ch.charCodeAt(0) - 65 : ch === '-' ? 36 : ch === '.' ? 37 : -1);
// uv rect (u0, v0, du, dv) of a canvas rect (canvas textures are flipped: v = 1 - y)
const uvRect = ([x, y, w, h]) => new THREE.Vector4(x / AT, 1 - (y + h) / AT, w / AT, h / AT);
export const ATLAS = {
  crest: CREST.map(uvRect), maker: uvRect(MAKER), sponsor: SPONSOR.map(uvRect),
  glyph: new THREE.Vector4(GLYPH.w / AT, GLYPH.h / AT, GLYPH.cols, 0),
};

function drawAtlas() {
  const c = document.createElement('canvas');
  c.width = c.height = AT;
  const g = c.getContext('2d');
  if (!g || !g.fillRect) return c;
  g.clearRect(0, 0, AT, AT);
  // Lettering: heavy, slightly condensed block characters. Fill in red, the
  // outline (fill + a rim) in green, so the shader picks both colours.
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-.';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let i = 0; i < chars.length; i++) {
    const cx = (i % GLYPH.cols) * GLYPH.w + GLYPH.w / 2, cy = Math.floor(i / GLYPH.cols) * GLYPH.h + GLYPH.h / 2;
    g.save();
    g.translate(cx, cy + 2);
    g.scale(0.74, 1);
    g.font = '900 86px "Arial Black", "Roboto Black", Impact, "Helvetica Neue", Arial, sans-serif';
    g.lineJoin = 'round';
    g.strokeStyle = 'rgb(0,255,0)'; g.lineWidth = 11; g.strokeText(chars[i], 0, 0);
    g.fillStyle = 'rgb(0,255,0)'; g.fillText(chars[i], 0, 0);
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = 'rgb(255,0,0)'; g.fillText(chars[i], 0, 0);
    g.restore();
  }
  crestKestrel(g, ...CREST[0]);
  crestFox(g, ...CREST[1]);
  crestUmpire(g, ...CREST[2]);
  maker(g, ...MAKER);
  sponsor(g, SPONSOR[0], 'VANTARO', '#ffffff', '#f3c331');
  sponsor(g, SPONSOR[1], 'ODELLA', '#ffffff', '#1a1a1a');
  return c;
}
// Harbour Kestrels: a gold-rimmed navy shield, a stooping kestrel's wings over waves.
function crestKestrel(g, x, y, w, h) {
  g.save(); g.translate(x + w / 2, y + h / 2); g.scale(w / 256, h / 256);
  const shield = () => { g.beginPath(); g.moveTo(-92, -104); g.lineTo(92, -104); g.lineTo(92, 10); g.quadraticCurveTo(88, 78, 0, 116); g.quadraticCurveTo(-88, 78, -92, 10); g.closePath(); };
  shield(); g.fillStyle = '#f3c331'; g.fill();
  g.save(); g.scale(0.86, 0.86); g.translate(0, -4); shield(); g.fillStyle = '#10275e'; g.fill(); g.restore();
  // waves
  g.strokeStyle = '#3a78d6'; g.lineWidth = 9;
  for (const yy of [48, 70]) { g.beginPath(); for (let k = -70; k <= 70; k += 4) g.lineTo(k, yy + 7 * Math.sin(k * 0.09)); g.stroke(); }
  // the bird: body, two swept wings, tail
  g.fillStyle = '#f3c331';
  g.beginPath(); g.moveTo(0, -70); g.quadraticCurveTo(14, -40, 6, 10); g.lineTo(0, 30); g.lineTo(-6, 10); g.quadraticCurveTo(-14, -40, 0, -70); g.fill();
  for (const sx of [-1, 1]) { g.beginPath(); g.moveTo(sx * 6, -36); g.quadraticCurveTo(sx * 50, -64, sx * 80, -40); g.quadraticCurveTo(sx * 48, -30, sx * 30, -6); g.quadraticCurveTo(sx * 18, -14, sx * 6, -14); g.fill(); }
  g.fillStyle = '#ffffff'; g.font = '900 30px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('HK', 0, -88 + 4);
  g.restore();
}
// Redfield Foxes: a white roundel, a red fox's head in profile, a gold ring.
function crestFox(g, x, y, w, h) {
  g.save(); g.translate(x + w / 2, y + h / 2); g.scale(w / 256, h / 256);
  g.beginPath(); g.arc(0, 0, 112, 0, Math.PI * 2); g.fillStyle = '#e9c45a'; g.fill();
  g.beginPath(); g.arc(0, 0, 100, 0, Math.PI * 2); g.fillStyle = '#f6f3ea'; g.fill();
  g.beginPath(); g.arc(0, 0, 84, 0, Math.PI * 2); g.fillStyle = '#7a1410'; g.fill();
  // fox head: ears, cheeks, snout
  g.fillStyle = '#e8562a';
  g.beginPath(); g.moveTo(-44, -10); g.lineTo(-40, -66); g.lineTo(-12, -30); g.lineTo(12, -30); g.lineTo(40, -66); g.lineTo(44, -10); g.quadraticCurveTo(46, 20, 0, 58); g.quadraticCurveTo(-46, 20, -44, -10); g.fill();
  g.fillStyle = '#f6f3ea';
  for (const sx of [-1, 1]) { g.beginPath(); g.moveTo(sx * 44, -6); g.quadraticCurveTo(sx * 30, 26, 0, 58); g.quadraticCurveTo(sx * 14, 20, sx * 10, 6); g.closePath(); g.fill(); }
  g.fillStyle = '#1a1a1a';
  g.beginPath(); g.arc(0, 52, 7, 0, Math.PI * 2); g.fill();
  for (const sx of [-1, 1]) { g.beginPath(); g.ellipse(sx * 18, -6, 6, 4, sx * 0.4, 0, Math.PI * 2); g.fill(); }
  g.restore();
}
// The officials' badge (an invented cricket board's): navy shield, crossed stumps.
function crestUmpire(g, x, y, w, h) {
  g.save(); g.translate(x + w / 2, y + h / 2); g.scale(w / 256, h / 256);
  g.beginPath(); g.moveTo(-80, -96); g.lineTo(80, -96); g.lineTo(80, 20); g.quadraticCurveTo(70, 80, 0, 108); g.quadraticCurveTo(-70, 80, -80, 20); g.closePath();
  g.fillStyle = '#232838'; g.fill(); g.lineWidth = 10; g.strokeStyle = '#c9a54a'; g.stroke();
  g.fillStyle = '#e8e2cf';
  for (const dx of [-22, 0, 22]) g.fillRect(dx - 5, -50, 10, 100);
  g.fillRect(-30, -58, 60, 8);
  g.restore();
}
// Kit maker: an invented chevron mark.
function maker(g, x, y, w, h) {
  g.save(); g.translate(x + w / 2, y + h / 2);
  g.fillStyle = '#ffffff';
  g.beginPath(); g.moveTo(-90, 30); g.lineTo(-30, -40); g.lineTo(0, -10); g.lineTo(30, -40); g.lineTo(90, 30); g.lineTo(55, 30); g.lineTo(30, 0); g.lineTo(0, 30); g.lineTo(-30, 0); g.lineTo(-55, 30); g.closePath(); g.fill();
  g.restore();
}
function sponsor(g, [x, y, w, h], text, col, accent) {
  g.save(); g.translate(x + w / 2, y + h / 2);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = 'italic 900 96px "Arial Black", "Roboto Black", Impact, Arial, sans-serif';
  g.scale(Math.min(1, (w * 0.86) / Math.max(1, g.measureText ? g.measureText(text).width || w : w)), 1);
  g.lineJoin = 'round'; g.lineWidth = 10; g.strokeStyle = 'rgba(0,0,0,0.35)'; g.strokeText(text, 0, 4);
  g.fillStyle = col; g.fillText(text, 0, 4);
  g.restore();
  // an accent swash under the word
  g.save(); g.translate(x + w / 2, y + h - 14);
  g.fillStyle = accent; g.beginPath(); g.moveTo(-w * 0.36, 2); g.quadraticCurveTo(0, -12, w * 0.38, -2); g.quadraticCurveTo(0, -4, -w * 0.36, 2); g.fill();
  g.restore();
}

// ------------------------------------------------------------------ face map
// F: landmarks in bind space (metres): eyes [x, y] (the +x eye), eyeR (iris radius),
// mouth [halfWidth, y], nose [y], brow [y], chin y, rect {x0, y0, w, h}.
export const FACE_W = 256, FACE_H = 512;    // (0.8 mm across, 0.6 mm down: finer than a headset pixel on a face at 1.5 m)
function paintFace(F) {
  const N = FACE_W, M = FACE_H, data = new Uint8Array(N * M * 4);
  const { x0, y0, w, h } = F.rect;
  const ex = F.eye[0], ey = F.eye[1], er = F.irisR, my = F.mouth[1], mw = F.mouth[0], ny = F.nose, by = F.brow, cy = F.chin;
  const sq = (v) => v * v, sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const ss = (a, b, v) => { const t = sat((v - a) / (b - a)); return t * t * (3 - 2 * t); };
  const ell = (x, y, cx, cy2, ax, ay) => Math.sqrt(sq((x - cx) / ax) + sq((y - cy2) / ay));
  // the lid opening: an almond, wider at the outer corner
  const ow = er * 1.75, oh = er * 0.82;
  // (symmetric: the +x half is painted and mirrored; each feature only where it can reach)
  for (let j = 0; j < M; j++) {
    const y = y0 + (j + 0.5) / M * h;
    if (y > by + 0.025 || y < cy - 0.03) {                 // (no features: neutral)
      for (let i = 0; i < N; i++) { const k = (j * N + i) * 4; data[k] = 128; data[k + 1] = 0; data[k + 2] = 128; data[k + 3] = 0; }
      continue;
    }
    for (let i = N >> 1; i < N; i++) {
      const x = x0 + (i + 0.5) / N * w, ax = Math.abs(x);
      let shade = 0, beard = 0, liner = 0, white = 0, lips = 0;
      // --- eyes: socket shadow, upper lid crease, lash line, lower lid
      const dxE = ax - ex, dyE = y - ey;
      if (Math.abs(dxE) < ow * 2.2 && Math.abs(dyE) < oh * 5) {
      const tilt = dyE - dxE * 0.12;                                  // outer corners slightly up
      const open = Math.sqrt(sq(dxE / ow) + sq(tilt / (oh * (dxE > 0 ? 0.95 : 1.05))));
      shade -= 0.16 * Math.exp(-sq(ell(ax, y, ex - 0.002, ey + 0.002, ow * 1.55, oh * 2.6) / 1.0) * 1.2);      // socket
      // upper lid: a dark lash band just above the opening, thicker toward the outer corner
      const upper = tilt > 0 ? 1 : 0;
      const lashW = 0.0011 + 0.0011 * ss(-ow, ow, dxE);
      liner = Math.max(liner, upper * Math.exp(-sq((open - 1) * oh / lashW)) * ss(1.25, 0.6, Math.abs(dxE) / ow));
      liner = Math.max(liner, (1 - upper) * 0.45 * Math.exp(-sq((open - 1) * oh / 0.0007)) * ss(1.1, 0.5, Math.abs(dxE) / ow));
      // lid crease above
      shade -= 0.12 * upper * Math.exp(-sq(((open - 1.75) * oh) / 0.0016)) * ss(1.3, 0.6, Math.abs(dxE) / ow);
      // inside the opening: eye white with a painted iris (only seen on the eyeball-less far model)
      if (open < 1) {
        const ir = Math.hypot(dxE, dyE) / er;
        if (ir < 1) liner = Math.max(liner, ir < 0.45 ? 1 : 0.8);
        else white = Math.max(white, ss(1, 0.85, open));
      }
      }
      // --- brows: a tapered arc over each eye
      if (Math.abs(y - by) < 0.02) {
        const t = (ax - (ex - ow * 1.15)) / (ow * 2.5);              // 0 inner .. 1 outer
        if (t > -0.1 && t < 1.1) {
          const arcY = by + 0.004 * Math.sin(Math.PI * sat(t) * 0.9) - 0.003 * t;
          const thick = 0.0034 * (1 - 0.55 * sat(t)) + 0.0008;
          const d = Math.abs(y - arcY) / thick;
          liner = Math.max(liner, 0.85 * ss(1.15, 0.55, d) * ss(-0.1, 0.06, t) * ss(1.1, 0.9, t));
          shade -= 0.05 * Math.exp(-sq((y - arcY + 0.008) / 0.006)) * ss(-0.1, 0.2, t) * ss(1.2, 0.8, t);  // brow ridge shadow under it
        }
      }
      // --- nose: shadowed sides, nostrils, a lit bridge
      if (ax < 0.035 && y > ny - 0.025 && y < ey + 0.01) {
        const nw = 0.0105 + 0.006 * ss(ey, ny, y);                     // half width, wider at the wings
        shade -= 0.1 * Math.exp(-sq((ax - nw) / 0.0035)) * ss(ey + 0.004, ey - 0.012, y) * ss(ny - 0.012, ny + 0.002, y);
        shade += 0.07 * Math.exp(-sq(ax / 0.0045)) * ss(ey - 0.004, ny + 0.01, y) * ss(ny - 0.004, ny + 0.012, y);
        const nost = ell(ax, y, 0.0085, ny - 0.0045, 0.0042, 0.0022);
        shade -= 0.4 * ss(1.2, 0.5, nost);
        // wing crease round the nostril
        shade -= 0.14 * Math.exp(-sq((ell(ax, y, 0.011, ny - 0.002, 0.0085, 0.0065) - 1) / 0.25));
        // under the nose
        shade -= 0.08 * Math.exp(-sq((y - (ny - 0.0095)) / 0.003)) * Math.exp(-sq(ax / 0.012));
      }
      // --- smile lines: from the nose wings to past the mouth corners
      if (ax < mw + 0.03 && y < ny + 0.004 && y > my - 0.02) {
        const t = sat((ny - 0.004 - y) / (ny - my + 0.008));
        const lx = 0.016 + (mw + 0.008 - 0.016) * t + 0.004 * Math.sin(Math.PI * t);
        shade -= 0.1 * Math.exp(-sq((ax - lx) / 0.0028)) * ss(0, 0.15, t) * ss(1.15, 0.8, t);
      }
      // --- mouth: lips (upper darker, lower fuller), the parting line, philtrum, chin dimple
      if (Math.abs(y - my) < 0.03 && ax < mw * 1.6) {
        const ux = ax / (mw * 1.08);
        if (ux < 1.15) {
          const bow = 0.0012 * Math.cos(Math.min(1, ux) * Math.PI * 1.6) ;   // cupid's bow
          const up = (y - my) > 0;
          const top = 0.0062 * Math.sqrt(Math.max(0, 1 - ux * ux)) + bow * 0.6, bot = -0.0078 * Math.sqrt(Math.max(0, 1 - ux * ux));
          const inLip = up ? ss(top + 0.0008, top - 0.0008, y - my) : ss(bot - 0.0009, bot + 0.0009, y - my);
          lips = Math.max(lips, inLip * (up ? 1 : 0.8));
          shade -= 0.38 * Math.exp(-sq((y - my - 0.0004 * ux * ux) / 0.0009)) * ss(1.05, 0.7, ux);        // the parting
          shade -= 0.12 * ss(0.0018, 0, Math.abs(ux - 1)) * Math.exp(-sq((y - my) / 0.003));                  // corners
          shade -= 0.05 * up * inLip;
          shade += 0.06 * (1 - up ? 1 : 0) * Math.exp(-sq((y - my + 0.0045) / 0.002)) * ss(0.8, 0.2, ux);   // lower lip highlight
        }
        shade -= 0.06 * Math.exp(-sq(ax / 0.0035)) * ss(my + 0.006, my + 0.009, y) * ss(ny - 0.006, ny - 0.011, y);   // philtrum groove
        shade -= 0.1 * Math.exp(-sq((y - (my - 0.0125)) / 0.004)) * Math.exp(-sq(ax / 0.016));                       // under the lower lip
      }
      // --- cheekbones catch light; temples and jaw sides fall off
      if (Math.abs(y - ey + 0.024) < 0.05) shade += 0.05 * Math.exp(-sq(ell(ax, y, ex + 0.008, ey - 0.024, 0.02, 0.014)));
      // --- beard field: jaw, chin, moustache; the centre of a beard first (goatee), cheeks last
      if (y < ny + 0.01 && y > cy - 0.02 && ax < 0.11) {
        const jaw = ss(ny - 0.004, my - 0.014, y) * ss(cy - 0.014, cy + 0.006, y);              // below the cheeks (a soft upper edge), down to the chin
        const cheekLine = ss(ny - 0.03, ny + 0.004, y) * ss(0.08, 0.05, ax) * ss(ny + 0.012, ny - 0.01, y);
        const tache = Math.exp(-sq((y - (my + 0.0095)) / 0.0042)) * ss(mw + 0.012, mw - 0.004, ax) * ss(ny - 0.002, ny - 0.008, y);
        const goatee = Math.exp(-sq(ax / (0.016 + 0.4 * Math.max(0, my - 0.01 - y)))) * ss(my - 0.003, my - 0.012, y) * ss(cy - 0.01, cy + 0.008, y);
        const full = Math.max(jaw * ss(0.11, 0.06, ax), cheekLine * 0.6) * (1 - 0.6 * lips) * (1 - ss(0.6, 1, lips));
        beard = Math.max(0.55 * full, 0.95 * goatee, 0.85 * tache);
        beard *= 1 - ss(0.7, 0.95, lips);
        if (Math.abs(y - my) < 0.0035 && ax < mw) beard *= 0.2;      // not across the lips
      }
      shade = 0.5 + shade;
      const k = (j * N + i) * 4, m = (j * N + N - 1 - i) * 4;
      data[k] = data[m] = Math.round(sat(shade) * 255);
      data[k + 1] = data[m + 1] = Math.round(sat(beard) * 255);
      data[k + 2] = data[m + 2] = Math.round(sat(0.5 - 0.5 * sat(liner) + 0.5 * sat(white) * (1 - sat(liner))) * 255);
      data[k + 3] = data[m + 3] = Math.round(sat(lips) * 255);
    }
  }
  return data;
}

let TEX = null;
export function lookTextures(F) {
  if (TEX) return TEX;
  const face = new THREE.DataTexture(paintFace(F), FACE_W, FACE_H, THREE.RGBAFormat, THREE.UnsignedByteType);
  face.colorSpace = THREE.NoColorSpace;
  face.wrapS = face.wrapT = THREE.ClampToEdgeWrapping;
  face.magFilter = THREE.LinearFilter; face.minFilter = THREE.LinearMipmapLinearFilter;
  face.generateMipmaps = true; face.anisotropy = 4;
  face.needsUpdate = true;
  const decal = new THREE.CanvasTexture(drawAtlas());
  decal.colorSpace = THREE.SRGBColorSpace;
  decal.minFilter = THREE.LinearMipmapLinearFilter; decal.anisotropy = 4;
  decal.wrapS = decal.wrapT = THREE.ClampToEdgeWrapping;
  TEX = { face, decal };
  return TEX;
}
