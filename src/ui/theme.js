// The look shared by every canvas panel: colours, type, the wordmark, icons
// (drawn as canvas paths: no emoji, no image files), team colours and the
// small broadcast pieces (chips, ball dots, bands). Pure canvas 2D; nothing
// here touches three.js, so a panel redraw costs one canvas paint + upload.
//
// Sizes are canvas pixels; the panels keep text at least as big (in degrees)
// as before: on a Quest 3S ~20 px a degree, body text >= ~1.5°.

// System fonts only (the page loads no web fonts): Roboto on the Quest,
// Segoe UI / SF on desktops.
export const FONT_STACK = 'system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
export const font = (weight, px) => `${weight} ${Math.round(px)}px ${FONT_STACK}`;

// Colour system: a deep navy neutral ramp, pitch green as the primary (go,
// on, selected), floodlight gold as the accent (titles, the brand), a bright
// blue for the laser-pointer focus. Event colours match what the sessions
// already pass (FOUR blue, SIX magenta, OUT red).
export const C = {
  ink: '#070c16', base: '#0c1424', panel: '#111c30', raised: '#18263f', raised2: '#1f3050', line: 'rgba(255,255,255,0.12)', lineHi: 'rgba(255,255,255,0.22)',
  text: '#f3f6fb', text2: '#c3cfdd', text3: '#8a9bb0', mute: '#5f7189',
  primary: '#1db978', primaryHi: '#3fe39c', primaryLo: '#0f7a4f',
  accent: '#ffc93c', accentHi: '#ffe08a', accentLo: '#c7901a',
  focus: '#3d8bff', focusHi: '#9cc8ff', focusLo: '#1f5fd1',
  danger: '#ff4d5e', warn: '#ffb347', ok: '#3fe39c', info: '#7fd3ff',
  four: '#2fb8ff', six: '#e85cf2', wicket: '#ff4d5e',
};

// Fictional sides (src/game/squad.js): the batting side's colour on the
// score bug and the big screen. Home in blue, away in red, as their kit.
export const TEAMS = {
  HK: { name: 'Harbour Kings', short: 'HK', c1: '#1f5fd1', c2: '#3d8bff', ink: '#ffffff' },
  SS: { name: 'Summit Stars', short: 'SS', c1: '#b3122f', c2: '#ff4d5e', ink: '#ffffff' },
  NETS: { name: 'Nets', short: 'NETS', c1: '#0f7a4f', c2: '#1db978', ink: '#ffffff' },
};
export function teamByName(name) {
  for (const t of Object.values(TEAMS)) if (t.name === name || t.short === name) return t;
  const s = String(name || '').split(/\s+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 3).toUpperCase();
  return { name: name || '', short: s || '—', c1: '#3a4a66', c2: '#6c7f9f', ink: '#ffffff' };
}

export function rr(g, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// A parallelogram (the broadcast "slash" shape): the right edge leans by k px.
export function slant(g, x, y, w, h, k) {
  g.beginPath();
  g.moveTo(x + k, y); g.lineTo(x + w, y); g.lineTo(x + w - k, y + h); g.lineTo(x, y + h); g.closePath();
}

export function vgrad(g, y0, y1, c0, c1) {
  const gr = g.createLinearGradient(0, y0, 0, y1);
  gr.addColorStop(0, c0); gr.addColorStop(1, c1);
  return gr;
}
export function hgrad(g, x0, x1, c0, c1) {
  const gr = g.createLinearGradient(x0, 0, x1, 0);
  gr.addColorStop(0, c0); gr.addColorStop(1, c1);
  return gr;
}

// Soft drop shadow for whatever fn() fills. Fill opaque inside it: a shadowed
// translucent fill showed the panel's previous drawing through (Skia, software GL).
export function shadow(g, fn, blur = 14, dy = 5, color = 'rgba(0,0,0,0.45)') {
  g.save();
  g.shadowColor = color; g.shadowBlur = blur; g.shadowOffsetY = dy;
  fn();
  g.restore();
}

// A raised surface: a vertical gradient, a hairline top highlight and a border.
export function surface(g, x, y, w, h, r, { top = C.raised2, bottom = C.raised, border = C.line, lift = true } = {}) {
  if (lift) shadow(g, () => { rr(g, x, y, w, h, r); g.fillStyle = bottom; g.fill(); }, 12, 4, 'rgba(0,0,0,0.38)');
  rr(g, x, y, w, h, r);
  g.fillStyle = vgrad(g, y, y + h, top, bottom);
  g.fill();
  if (border) { g.strokeStyle = border; g.lineWidth = 2; g.stroke(); }
  g.save();
  rr(g, x, y, w, h, r); g.clip();
  g.fillStyle = 'rgba(255,255,255,0.07)';
  g.fillRect(x, y, w, 2);
  g.restore();
}

// Tracked capitals (labels, small headings).
export function caps(g, text, x, y, px, color, { weight = 800, align = 'left', track = 0.08, maxW = Infinity } = {}) {
  g.save();
  g.font = font(weight, px);
  const has = 'letterSpacing' in g;
  if (has) g.letterSpacing = `${(px * track).toFixed(1)}px`;
  let w = g.measureText(text).width;
  if (w > maxW) {            // shrink to fit, tracking off first
    if (has) g.letterSpacing = '0px';
    let s = px;
    while ((w = g.measureText(text).width) > maxW && s > px * 0.6) { s = Math.floor(s * 0.94); g.font = font(weight, s); }
  }
  g.fillStyle = color; g.textAlign = align; g.textBaseline = 'middle';
  g.fillText(text, x, y);
  g.restore();
  return w;
}

// A filled pill with text; returns its width. (x is the left edge, or the
// right edge with align 'right'.)
export function chip(g, text, x, y, h, { bg = C.raised2, fg = C.text, px = h * 0.58, weight = 800, pad = h * 0.42, align = 'left', r = h * 0.28 } = {}) {
  g.save();
  g.font = font(weight, px);
  const w = g.measureText(text).width + pad * 2, x0 = align === 'right' ? x - w : x;
  rr(g, x0, y, w, h, r);
  g.fillStyle = bg; g.fill();
  g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, x0 + w / 2, y + h / 2 + 1);
  g.restore();
  return w;
}

// A team block: the side's colours, its short name.
export function teamBlock(g, team, x, y, w, h, px = h * 0.46) {
  g.save();
  slant(g, x, y, w, h, h * 0.18);
  g.fillStyle = hgrad(g, x, x + w, team.c1, team.c2);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.16)';
  g.fillRect(x + h * 0.18, y, w - h * 0.18, 3);
  g.fillStyle = team.ink; g.font = font(900, px);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  let s = px;
  while (g.measureText(team.short).width > w - h * 0.5 && s > 10) { s -= 2; g.font = font(900, s); }
  g.fillText(team.short, x + w / 2, y + h / 2 + 1);
  g.restore();
}

// One ball of the over: a dot, coloured by what happened.
export function ballStyle(sym) {
  const s = String(sym);
  if (s === 'W') return { bg: C.wicket, fg: '#fff', t: 'W' };
  if (s === '6') return { bg: C.six, fg: '#fff', t: '6' };
  if (s === '4') return { bg: C.four, fg: '#06121f', t: '4' };
  if (/wd|nb/.test(s)) return { bg: C.warn, fg: '#1a1205', t: s.replace('wd', 'w').replace('nb', 'nb') };
  if (s === '•' || s === '0') return { bg: 'rgba(255,255,255,0.12)', fg: C.text3, t: '•' };
  return { bg: '#e9eef5', fg: '#0b1220', t: s };
}
export function ballDot(g, cx, cy, r, sym) {
  const st = ballStyle(sym);
  g.save();
  const wide = st.t.length > 1;
  const w = wide ? r * (1.1 + st.t.length * 0.42) : r;
  rr(g, cx - w, cy - r, w * 2, r * 2, r);
  g.fillStyle = st.bg; g.fill();
  g.fillStyle = st.fg; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = font(900, st.t === '•' ? r * 1.5 : r * (wide ? 1.0 : 1.18));
  g.fillText(st.t, cx, cy + r * 0.06);
  g.restore();
  return w * 2;
}

// ------------------------------------------------------------- wordmark
// "CREASE VR": three stumps and bails, the name in a heavy forward-leaning
// cut on a white crease line, VR on a gold tab. h = cap height-ish box.
// Returns the width drawn. (x, y) = left, vertical centre.
export function drawWordmark(g, x, y, h, { color = C.text, accent = C.accent, crease = true } = {}) {
  g.save();
  const s = h;
  // Stumps: three uprights, two bails, leaning with the type.
  const sk = 0.16;
  g.save();
  g.translate(x, y);
  g.transform(1, 0, -sk, 1, 0, 0);
  g.fillStyle = accent;
  const sw = s * 0.09, gap = s * 0.075, top = -s * 0.5, bot = s * 0.5;
  for (let i = 0; i < 3; i++) { rr(g, i * (sw + gap) + s * 0.02, top + s * 0.14, sw, bot - top - s * 0.14, sw * 0.4); g.fill(); }
  rr(g, 0, top, sw * 1.5 + gap * 0.9 + s * 0.02, s * 0.075, s * 0.03); g.fill();
  rr(g, sw * 1.5 + gap * 1.1 + s * 0.02, top, sw * 1.5 + gap * 0.9, s * 0.075, s * 0.03); g.fill();
  g.restore();
  let cx = x + 3 * sw + 2 * gap + s * 0.26;
  // CREASE
  g.font = font(900, s * 1.02);
  g.textBaseline = 'middle'; g.textAlign = 'left';
  const wC = g.measureText('CREASE').width;
  g.save();
  g.translate(cx, y);
  g.transform(1, 0, -sk, 1, 0, 0);
  g.fillStyle = color;
  if ('letterSpacing' in g) g.letterSpacing = `${(s * 0.02).toFixed(1)}px`;
  g.fillText('CREASE', 0, s * 0.04);
  g.restore();
  cx += wC + s * 0.06 + s * 0.12;
  // VR tab
  g.font = font(900, s * 0.62);
  const wV = g.measureText('VR').width + s * 0.34;
  g.save();
  g.translate(cx, y);
  slant(g, 0, -s * 0.42, wV, s * 0.84, s * 0.14);
  g.fillStyle = accent; g.fill();
  g.fillStyle = '#10141c'; g.textAlign = 'center';
  g.fillText('VR', wV / 2, s * 0.03);
  g.restore();
  const total = cx + wV - x;
  // The popping crease: a white line under the name, a return crease tick.
  if (crease) {
    g.fillStyle = color;
    g.globalAlpha = 0.9;
    g.fillRect(x - s * 0.08, y + s * 0.64, total + s * 0.16, Math.max(2, s * 0.05));
    g.fillRect(x + total * 0.18, y + s * 0.56, Math.max(2, s * 0.05), s * 0.2);
    g.globalAlpha = 1;
  }
  g.restore();
  return total;
}

// ------------------------------------------------------------- icons
// Line icons on a 24-unit grid, drawn at size s centred on (cx, cy).
export function drawIcon(g, name, cx, cy, s, color = C.text, { weight = 2.2 } = {}) {
  const k = s / 24;
  g.save();
  g.translate(cx - 12 * k, cy - 12 * k);
  g.scale(k, k);
  g.strokeStyle = color; g.fillStyle = color;
  g.lineWidth = weight; g.lineCap = 'round'; g.lineJoin = 'round';
  const P = (fn) => { g.beginPath(); fn(); g.stroke(); };
  const F = (fn) => { g.beginPath(); fn(); g.fill(); };
  const circ = (x, y, r) => g.arc(x, y, r, 0, Math.PI * 2);
  switch (name) {
    case 'bat':
      g.save(); g.translate(12, 12); g.rotate(-Math.PI / 4);
      P(() => { rrPath(g, -3.2, -2, 6.4, 13, 2.6); });
      P(() => { g.moveTo(0, -2); g.lineTo(0, -10); });
      F(() => { rrPath(g, -1.4, -11.5, 2.8, 4, 1); });
      g.restore();
      F(() => circ(5.5, 18.5, 2.2));
      break;
    case 'ball':
      P(() => circ(12, 12, 8.5));
      P(() => { g.moveTo(8.6, 4.2); g.bezierCurveTo(11.2, 9, 11.2, 15, 8.6, 19.8); });
      P(() => { g.moveTo(15.4, 4.2); g.bezierCurveTo(12.8, 9, 12.8, 15, 15.4, 19.8); });
      break;
    case 'stumps':
      for (const x of [7, 12, 17]) P(() => { g.moveTo(x, 6.5); g.lineTo(x, 21); });
      P(() => { g.moveTo(5.5, 4); g.lineTo(11, 4); g.moveTo(13, 4); g.lineTo(18.5, 4); });
      break;
    case 'target':
      P(() => circ(12, 12, 8.5)); P(() => circ(12, 12, 4.6)); F(() => circ(12, 12, 1.6));
      P(() => { g.moveTo(17, 7); g.lineTo(21.5, 2.5); g.moveTo(18, 2.5); g.lineTo(21.5, 2.5); g.lineTo(21.5, 6); });
      break;
    case 'over':                  // six balls in an arc
      for (let i = 0; i < 6; i++) { const a = Math.PI * (1.08 + i * 0.168); F(() => circ(12 + Math.cos(a) * 8.5, 15 + Math.sin(a) * 8.5, 1.9)); }
      P(() => { g.moveTo(5, 19.5); g.lineTo(19, 19.5); });
      break;
    case 'trophy':
      P(() => { g.moveTo(7, 4); g.lineTo(17, 4); g.lineTo(17, 9); g.bezierCurveTo(17, 13, 14.5, 15, 12, 15); g.bezierCurveTo(9.5, 15, 7, 13, 7, 9); g.closePath(); });
      P(() => { g.moveTo(7, 6); g.bezierCurveTo(3, 6, 3, 11, 7.6, 11.6); g.moveTo(17, 6); g.bezierCurveTo(21, 6, 21, 11, 16.4, 11.6); });
      P(() => { g.moveTo(12, 15); g.lineTo(12, 18.5); g.moveTo(8, 20.5); g.lineTo(16, 20.5); g.moveTo(9.5, 18.5); g.lineTo(14.5, 18.5); });
      break;
    case 'machine':               // a feeder: box, wheel, chute, ball
      P(() => { rrPath(g, 3.5, 9, 11, 9, 2); });
      P(() => circ(9, 13.5, 2.6));
      P(() => { g.moveTo(14.5, 11); g.lineTo(20, 8); });
      F(() => circ(20.5, 5, 1.9));
      P(() => { g.moveTo(5.5, 18); g.lineTo(4, 21.5); g.moveTo(12.5, 18); g.lineTo(14, 21.5); });
      break;
    case 'help':
      P(() => circ(12, 12, 9));
      P(() => { g.moveTo(9.2, 9.4); g.bezierCurveTo(9.2, 5.6, 15, 5.6, 15, 9.2); g.bezierCurveTo(15, 11.6, 12, 11.8, 12, 14.2); });
      F(() => circ(12, 17.4, 1.3));
      break;
    case 'gear': {
      g.beginPath();
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2, r = i % 2 ? 7.2 : 9.6;
        const a0 = a - 0.18, a1 = a + 0.18;
        g.lineTo(12 + Math.cos(a0) * r, 12 + Math.sin(a0) * r); g.lineTo(12 + Math.cos(a1) * r, 12 + Math.sin(a1) * r);
      }
      g.closePath(); g.stroke();
      P(() => circ(12, 12, 3.2));
      break;
    }
    case 'calibrate':             // bat upright in a crosshair
      P(() => { g.moveTo(12, 2.5); g.lineTo(12, 6); g.moveTo(12, 18); g.lineTo(12, 21.5); g.moveTo(2.5, 12); g.lineTo(6, 12); g.moveTo(18, 12); g.lineTo(21.5, 12); });
      P(() => circ(12, 12, 6.5));
      F(() => circ(12, 12, 1.8));
      break;
    case 'recenter':
      P(() => { g.arc(12, 12, 8, -Math.PI * 0.35, Math.PI * 1.25); });
      P(() => { g.moveTo(16.6, 1.8); g.lineTo(17.4, 5.6); g.lineTo(13.6, 6.4); });
      F(() => circ(12, 12, 2.2));
      break;
    case 'face':                  // you, and the way you face
      P(() => circ(12, 15, 5.5));
      P(() => { g.moveTo(12, 9.5); g.lineTo(12, 2.5); g.moveTo(8.8, 5.6); g.lineTo(12, 2.4); g.lineTo(15.2, 5.6); });
      break;
    case 'mr':                    // a headset
      P(() => { rrPath(g, 2.5, 7.5, 19, 10, 4); });
      P(() => { g.moveTo(10, 17.5); g.bezierCurveTo(10.5, 14.5, 13.5, 14.5, 14, 17.5); });
      P(() => { g.moveTo(2.5, 11); g.lineTo(0.8, 11); g.moveTo(21.5, 11); g.lineTo(23.2, 11); });
      break;
    case 'play':
      F(() => { g.moveTo(8, 5); g.lineTo(19, 12); g.lineTo(8, 19); g.closePath(); });
      break;
    case 'exit':
      P(() => { g.moveTo(14, 4); g.lineTo(5, 4); g.lineTo(5, 20); g.lineTo(14, 20); });
      P(() => { g.moveTo(10, 12); g.lineTo(21, 12); g.moveTo(17, 8); g.lineTo(21, 12); g.lineTo(17, 16); });
      break;
    case 'back':
      P(() => { g.moveTo(14.5, 5); g.lineTo(7.5, 12); g.lineTo(14.5, 19); });
      break;
    case 'next':
      P(() => { g.moveTo(9.5, 5); g.lineTo(16.5, 12); g.lineTo(9.5, 19); });
      break;
    case 'home':
      P(() => { g.moveTo(3.5, 11.5); g.lineTo(12, 4); g.lineTo(20.5, 11.5); });
      P(() => { g.moveTo(6, 10); g.lineTo(6, 20); g.lineTo(18, 20); g.lineTo(18, 10); });
      break;
    case 'refresh':
      P(() => { g.arc(12, 12, 8, Math.PI * 0.15, Math.PI * 1.75); });
      P(() => { g.moveTo(19.8, 3.8); g.lineTo(19.6, 8.4); g.lineTo(15, 8.2); });
      break;
    case 'eye':
      P(() => { g.moveTo(2, 12); g.bezierCurveTo(6, 5, 18, 5, 22, 12); g.bezierCurveTo(18, 19, 6, 19, 2, 12); });
      P(() => circ(12, 12, 3.4));
      break;
    case 'speaker':
      F(() => { g.moveTo(3, 9); g.lineTo(7, 9); g.lineTo(12, 4.5); g.lineTo(12, 19.5); g.lineTo(7, 15); g.lineTo(3, 15); g.closePath(); });
      P(() => { g.arc(12, 12, 4.6, -0.8, 0.8); });
      P(() => { g.arc(12, 12, 8.4, -0.85, 0.85); });
      break;
    case 'sliders':
      P(() => { g.moveTo(4, 7); g.lineTo(20, 7); g.moveTo(4, 17); g.lineTo(20, 17); });
      F(() => circ(9, 7, 2.6)); F(() => circ(15.5, 17, 2.6));
      break;
    case 'swap':
      P(() => { g.moveTo(4, 8); g.lineTo(19, 8); g.moveTo(15.5, 4.5); g.lineTo(19, 8); g.lineTo(15.5, 11.5); });
      P(() => { g.moveTo(20, 16); g.lineTo(5, 16); g.moveTo(8.5, 12.5); g.lineTo(5, 16); g.lineTo(8.5, 19.5); });
      break;
    case 'check':
      P(() => { g.moveTo(5, 12.5); g.lineTo(10, 17.5); g.lineTo(19.5, 6.5); });
      break;
    case 'replay':
      P(() => { g.arc(12, 12, 8.5, Math.PI * 0.9, Math.PI * 2.6); });
      P(() => { g.moveTo(2.2, 8.8); g.lineTo(3.6, 13.4); g.lineTo(7.9, 11.4); });
      F(() => { g.moveTo(10, 8.5); g.lineTo(15.5, 12); g.lineTo(10, 15.5); g.closePath(); });
      break;
    case 'run':                   // two creases and an arrow between
      P(() => { g.moveTo(4, 4); g.lineTo(4, 20); g.moveTo(20, 4); g.lineTo(20, 20); });
      P(() => { g.moveTo(7.5, 12); g.lineTo(16.5, 12); g.moveTo(13, 8.5); g.lineTo(16.5, 12); g.lineTo(13, 15.5); });
      break;
    case 'glove':                 // a fielder's hand
      P(() => { g.moveTo(7, 20); g.lineTo(7, 9); g.bezierCurveTo(7, 7, 10, 7, 10, 9); g.lineTo(10, 5.5); g.bezierCurveTo(10, 3.5, 13, 3.5, 13, 5.5); g.lineTo(13, 9); g.lineTo(13, 6.5); g.bezierCurveTo(13, 4.5, 16, 4.5, 16, 6.5); g.lineTo(16, 12); g.bezierCurveTo(17, 9.5, 20.5, 10.5, 19, 13); g.lineTo(15.5, 20); g.closePath(); });
      break;
    case 'lock':
      P(() => { rrPath(g, 5, 10.5, 14, 10, 2); });
      P(() => { g.moveTo(8, 10.5); g.lineTo(8, 7.5); g.bezierCurveTo(8, 2.5, 16, 2.5, 16, 7.5); g.lineTo(16, 10.5); });
      break;
    default:
      P(() => circ(12, 12, 8));
  }
  g.restore();
}
function rrPath(g, x, y, w, h, r) {
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
