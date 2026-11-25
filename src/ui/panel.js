// In-world UI panel rendered to a canvas texture. Widgets are laid out in
// canvas pixels; hit testing uses the raycast UV. Redraws only when dirty.
//
// Every piece of text is fitted to its box: labels shrink (and, with
// `wrap: true`, word-wrap) until they fit `maxW` x `maxH` (by default the
// room left on the panel from the label's anchor). Anything that still does
// not fit, and any text drawn past the panel's edge (custom widgets too), is
// logged once with console.warn and kept in `UI_OVERFLOW` (window.__uiOverflow).
import * as THREE from 'three';

import { C, font, rr, surface, shadow, vgrad, hgrad, drawIcon, chip } from './theme.js';

export const FONT = font;
export const UI_OVERFLOW = [];
if (typeof window !== 'undefined') window.__uiOverflow = UI_OVERFLOW;
const _seen = new Set();
export function reportOverflow(panel, text, width, box) {
  const key = `${panel}|${text}`;
  if (_seen.has(key)) return;
  _seen.add(key);
  UI_OVERFLOW.push({ panel, text: String(text), width: Math.round(width), box: Math.round(box) });
  console.warn(`[ui] text overflows its box on '${panel}': "${text}" is ${Math.round(width)} px, box ${Math.round(box)} px`);
}

// The canvas fonts the HUD, the prompts, the hints, the cards and the big
// screen use in a match (weight -> px; taken from a batting chase and a
// bowling over). The first time the browser meets a font it builds its
// metrics: 2-6 ms each on a desktop CPU (several times that on the headset),
// and a prompt that shrinks to fit meets four or five at once -- a long
// frame the first time it comes up. prewarmFonts() meets them all at load.
const WARM_FONTS = {
  500: [18, 19, 20, 21, 22, 23, 25, 27],
  600: [19, 21, 22, 23, 24, 25, 26, 27, 28, 29, 31, 32, 34, 36, 38],
  700: [6, 11, 19, 21, 23, 24, 25, 26, 30, 44, 45, 47, 48, 50, 52],
  800: [7, 13, 15, 16, 17, 18, 19, 20, 22, 24, 26, 28, 30, 32, 35, 36, 38, 40, 41, 44, 54, 84],
  900: [19, 24, 25, 26, 27, 28, 30, 31, 32, 38, 39, 40, 42, 45, 46, 48, 49, 51, 52, 54, 64, 66, 74, 76, 80, 96, 140, 197, 210],
};
// Load time (render/warmup.js): returns how many fonts it met. A canvas of its own; nothing is drawn.
export function prewarmFonts() {
  if (typeof document === 'undefined') return 0;
  const g = document.createElement('canvas').getContext('2d');
  if (!g) return 0;
  let n = 0;
  for (const w of Object.keys(WARM_FONTS)) for (const px of WARM_FONTS[w]) { g.font = FONT(+w, px); g.measureText('Ag 0123 OUT — Six!'); n++; }
  return n;
}

// Word-wrap one line of `text` to `maxW` px with the current font. A line
// made of ' · '-separated items breaks between items, not inside one.
export function wrapWords(g, text, maxW) {
  const out = []; let line = '';
  const sep = String(text).includes(' · ') ? ' · ' : ' ';
  for (const word of String(text).split(sep)) {
    const t = line ? line + sep + word : word;
    if (line && g.measureText(t).width > maxW) { out.push(line); line = word; } else line = t;
  }
  out.push(line);
  return out;
}

// Largest font size (<= size, >= min) at which `text` fits maxW x maxH, word-
// wrapped when `wrap`. Leaves g.font set. Returns { size, lines, width, lh, fits }.
export function fitText(g, text, opts) {
  const { size = 30, min = Math.min(size, 14), wrap = false } = opts;
  // Wrapping text: shrink it a little first, wrap only if that is not enough.
  if (wrap) {
    const r = fitOnce(g, text, { ...opts, wrap: false, min: Math.max(min, Math.round(size * 0.82)) });
    if (r.fits) return r;
  }
  return fitOnce(g, text, opts);
}
function fitOnce(g, text, { maxW, maxH = Infinity, size = 30, min = Math.min(size, 14), weight = 500, wrap = false, lineHeight = 1.25 }) {
  let s = size, res;
  for (;;) {
    g.font = FONT(weight, s);
    const lines = String(text).split('\n').flatMap((l) => (wrap ? wrapWords(g, l, maxW) : [l]));
    const width = Math.max(0, ...lines.map((l) => g.measureText(l).width));
    const lh = s * lineHeight, height = s + (lines.length - 1) * lh;
    res = { size: s, lines, width, lh, fits: width <= maxW + 0.5 && height <= maxH + 0.5 };
    if (res.fits || s <= min) return res;
    s = Math.max(min, Math.floor(s * 0.94));
  }
}

// One line of text shrunk to fit `maxW` (custom widgets).
export function fillFit(g, text, x, y, maxW, weight, size, min = Math.min(size, 14), name = 'panel') {
  const r = fitText(g, text, { maxW, size, min, weight });
  if (!r.fits) reportOverflow(name, text, r.width, maxW);
  g.fillText(text, x, y);
  return r.size;
}

// Big panels that change during play (the stadium screen, the HUD) can take `renderer`: their
// redraw is then sent to the GPU through a small GPU canvas, a band at a time (three's own upload
// of the whole CPU canvas cost ~1.5-2 ms of the frame here, several times that on the headset;
// this costs ~0.05 ms), and only one of them is redrawn in any one frame: the other waits a frame
// (both used to change on the same ball). CanvasPanel.tick() (ui.update) counts the frames.
const BAND = 64;
let _frame = 0, _bigFrame = -1;
export class CanvasPanel {
  static tick() { _frame++; }

  constructor({ width = 1.0, height = 0.62, ppm = 700, name = 'panel', bg = 'rgba(14,20,30,0.88)', interactive = true, fog = false, renderer = null } = {}) {
    this.w = width; this.h = height;
    this.renderer = renderer;
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(width * ppm);
    this.canvas.height = Math.round(height * ppm);
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.generateMipmaps = false;
    this.tex.minFilter = THREE.LinearFilter;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, toneMapped: false, fog }),
    );
    // (fog: a panel by the player is never 140 m away, where the haze starts; the stadium screen can be)
    this.mesh.name = name;
    this.mesh.renderOrder = 10;
    this.mesh.userData.panel = this;
    this.bg = bg;
    this.widgets = [];
    this.hover = null;
    this.interactive = interactive;
    this.dirty = true;
    this.title = '';
  }

  get W() { return this.canvas.width; }
  get H() { return this.canvas.height; }

  set(widgets, title = this.title) {
    this.widgets = widgets;
    this.title = title;
    this.dirty = true;
  }

  // Returns {widget, part} for a uv hit, or null.
  hitTest(uv) {
    const x = uv.x * this.W, y = (1 - uv.y) * this.H;
    for (const w of this.widgets) {
      if (!w.id || w.disabled || w.type === 'label') continue;
      if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) {
        let partName = 'main';
        if (w.type === 'stepper') {
          // (a little wider than drawn: easy to hit with the laser)
          const p = stepParts(w);
          if (x >= p.dec - 8 && x <= p.dec + p.b + 8) partName = 'dec';
          else if (x >= p.inc - 8) partName = 'inc';
          else partName = 'mid';
        }
        return { widget: w, part: partName };
      }
    }
    return null;
  }

  setHover(h) {
    const key = h ? `${h.widget.id}:${h.part}` : null;
    if (key !== this.hover) { this.hover = key; this.dirty = true; return true; }
    return false;
  }

  update() {
    if (!this.dirty) return;
    if (this.renderer) {
      if (_bigFrame === _frame) return;            // (another big panel changed this frame: next frame)
      _bigFrame = _frame;
    }
    this.dirty = false;
    this.draw();
    if (!this.renderer || !this.upload()) this.tex.needsUpdate = true;
  }

  // The canvas into the texture already on the GPU, a band at a time through a GPU canvas
  // (copied exactly; the texture rows the same as three's upload). false: not on the GPU yet.
  upload() {
    const R = this.renderer, t = this.tex, p = R.properties.get(t);
    if (!p.__webglTexture || p.__version !== t.version) return false;
    const gl = R.getContext(), W = this.W, H = this.H, B = Math.min(BAND, H);
    if (!this.stage) {
      const c = document.createElement('canvas'); c.width = W; c.height = B;
      this.stage = c.getContext('2d', { willReadFrequently: false });     // (a GPU canvas: the copy to the texture stays on the GPU)
      this.stage.globalCompositeOperation = 'copy';
    }
    R.state.bindTexture(gl.TEXTURE_2D, p.__webglTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, t.flipY);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, t.premultiplyAlpha);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, t.unpackAlignment);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    for (let y0 = 0; y0 < H; y0 += B) {
      const y = Math.min(y0, H - B);
      this.stage.drawImage(this.canvas, 0, y, W, B, 0, 0, W, B);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, t.flipY ? H - y - B : y, gl.RGBA, gl.UNSIGNED_BYTE, this.stage.canvas);
    }
    if (t.generateMipmaps && t.minFilter !== THREE.LinearFilter && t.minFilter !== THREE.NearestFilter) gl.generateMipmap(gl.TEXTURE_2D);
    return true;
  }

  draw() {
    const g = this.ctx, W = this.W, H = this.H;
    // A full reset, not clearRect: some canvas backends (seen with software
    // GL) left the last sting's pixels under a translucent card.
    g.clearRect(0, 0, W, H);
    if (this.bg) drawPanelBg(g, W, H, this.bg, this.title ? this.H * 0.15 : 0);
    // Debug check: any text drawn past the panel's edge is reported.
    const fill = g.fillText, name = this.mesh.name;
    g.fillText = function (text, x, y, maxWidth) {
      const tw = Math.min(this.measureText(text).width, maxWidth || Infinity);
      const a = this.textAlign;
      const x0 = a === 'center' ? x - tw / 2 : a === 'right' || a === 'end' ? x - tw : x;
      if (tw > 0 && (x0 < -0.5 || x0 + tw > W + 0.5 || y < 0 || y > H)) reportOverflow(name, text, tw, a === 'center' ? 2 * Math.min(x, W - x) : a === 'right' || a === 'end' ? x : W - x);
      return fill.call(this, text, x, y, maxWidth);
    };
    try {
      if (this.title) {
        g.fillStyle = C.accent;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        // Leave room for a corner button (Settings: Back).
        fillFitCentered(g, this.title, W / 2, H * 0.08, W - 2 * (this.titleInset || 40), 800, H * 0.075, name);
      }
      for (const w of this.widgets) this.drawWidget(g, w);
    } finally {
      delete g.fillText;
    }
  }

  // Pressed look for a moment after a click (the UI releases it).
  press(key) { this.pressed = key; this.dirty = true; }
  release() { if (this.pressed) { this.pressed = null; this.dirty = true; } }

  drawWidget(g, w) {
    const hov = (p) => this.hover === `${w.id}:${p}`;
    const prs = (p) => this.pressed === `${w.id}:${p}`;
    g.textBaseline = 'middle';
    if (w.type === 'custom') { g.save(); w.draw(g); g.restore(); return; }
    if (w.type === 'label') {
      const align = w.align || 'left', M = PAD, size = w.size || 30;
      const room = align === 'left' ? this.W - M - w.x : align === 'right' ? w.x - M : 2 * Math.min(w.x - M, this.W - M - w.x);
      const maxW = Math.min(w.maxW || Infinity, room);
      const maxH = Math.min(w.maxH || Infinity, this.H - PAD_Y - (w.y - size / 2));
      const r = fitText(g, w.text, { maxW, maxH, size, min: w.min || Math.min(size, 16), weight: w.weight || (w.bold ? 700 : 500), wrap: !!w.wrap });
      if (!r.fits) reportOverflow(this.mesh.name, w.text, r.width, maxW);
      g.fillStyle = w.color || '#e8eef5';
      g.textAlign = align;
      r.lines.forEach((ln, i) => g.fillText(ln, w.x, w.y + i * r.lh));
      return;
    }
    if (w.type === 'button' || w.type === 'toggle') { this.drawButton(g, w, w.disabled ? 'disabled' : prs('main') ? 'pressed' : hov('main') ? 'hover' : 'idle'); return; }
    if (w.type === 'stepper') this.drawStepper(g, w, hov, prs);
  }

  // A button in one of its states: idle / hover (the laser's focus: blue,
  // ringed) / pressed / disabled, each also 'active' (on, selected) or not.
  // Variants: default (raised), 'primary' (green call to action), 'card'
  // (icon, title, one line), 'tab', 'danger'. A `value` makes it a setting
  // row (label left, value right); a toggle is a row with a switch.
  drawButton(g, w, state) {
    const { x, y, h } = w, ww = w.w, v = w.variant || 'default', on = !!w.active;
    const r = w.radius ?? (v === 'tab' ? h * 0.5 : Math.min(18, h * 0.3));
    const hover = state === 'hover', pressed = state === 'pressed', dis = state === 'disabled';
    const oy = pressed ? 2 : 0;
    g.save();
    if (dis) g.globalAlpha = 0.42;
    // Fill.
    let top, bot, border = C.line;
    if (hover || pressed) { top = pressed ? C.focusLo : '#4a97ff'; bot = pressed ? '#174ba8' : C.focusLo; border = C.focusHi; }
    else if (v === 'primary' || (on && v !== 'tab' && w.type !== 'toggle' && w.value == null)) { top = '#25cc87'; bot = C.primaryLo; border = on ? C.primaryHi : 'rgba(255,255,255,0.18)'; }
    else if (v === 'danger') { top = '#3a1f2b'; bot = '#2a1520'; border = 'rgba(255,77,94,0.45)'; }
    else if (v === 'tab') { top = on ? '#24395e' : 'rgba(255,255,255,0.05)'; bot = on ? '#1c2d4b' : 'rgba(255,255,255,0.03)'; border = on ? 'rgba(255,201,60,0.6)' : 'rgba(255,255,255,0.08)'; }
    else { top = v === 'card' ? '#1f3152' : C.raised2; bot = v === 'card' ? '#15233b' : C.raised; }
    if (hover) shadow(g, () => { rr(g, x - 3, y - 3 + oy, ww + 6, h + 6, r + 3); g.fillStyle = C.focus; g.fill(); }, 22, 0, 'rgba(61,139,255,0.8)');
    surface(g, x, y + oy, ww, h, r, { top, bottom: bot, border, lift: !pressed && !dis && v !== 'tab' });
    if (hover) { rr(g, x - 4, y - 4 + oy, ww + 8, h + 8, r + 4); g.strokeStyle = C.focusHi; g.lineWidth = 3; g.stroke(); }
    const lit = hover || pressed;
    const fg = lit ? '#ffffff' : C.text, fg2 = lit ? 'rgba(255,255,255,0.86)' : C.text3;
    const N = this.mesh.name, cy = y + h / 2 + oy;
    if (v === 'card') {
      // Icon in a disc top-left (a tag top-right), the title, a line under it.
      const pad = Math.round(h * 0.13), ic = Math.min(h * 0.32, 46);
      const ix = x + pad + ic * 0.55, iy = y + pad + ic * 0.5 + oy;
      g.beginPath(); g.arc(ix, iy, ic * 0.55, 0, Math.PI * 2);
      g.fillStyle = lit ? 'rgba(255,255,255,0.2)' : on ? 'rgba(63,227,156,0.18)' : 'rgba(255,201,60,0.14)'; g.fill();
      if (w.icon) drawIcon(g, w.icon, ix, iy, ic * 0.7, lit ? '#fff' : on ? C.primaryHi : C.accent);
      if (w.tag) chip(g, w.tag, x + ww - pad, y + pad + oy, 28, { bg: lit ? 'rgba(255,255,255,0.22)' : 'rgba(63,227,156,0.2)', fg: lit ? '#fff' : C.primaryHi, px: 16, align: 'right' });
      const ts = w.size || Math.round(h * 0.21), ss = w.subSize || 23;
      const ty = y + h - pad - ss * 1.15 - ts * 0.55 + oy;
      g.textAlign = 'left'; g.fillStyle = fg;
      fillFit(g, w.text, x + pad, ty, ww - 2 * pad, 800, ts, 18, N);
      if (w.sub) { g.fillStyle = fg2; fillFit(g, w.sub, x + pad, y + h - pad - ss * 0.5 + oy, ww - 2 * pad, 500, ss, 16, N); }
      g.restore();
      return;
    }
    if (w.type === 'toggle' || w.value != null) {
      // Setting row: label on the left, the switch / value on the right.
      const pad = 22;
      let right = x + ww - pad;
      if (w.type === 'toggle') {
        const sh = Math.round(h * 0.5), sw = Math.round(sh * 1.8), sx = right - sw, sy = cy - sh / 2;
        rr(g, sx, sy, sw, sh, sh / 2);
        g.fillStyle = on ? C.primary : 'rgba(255,255,255,0.16)'; g.fill();
        g.strokeStyle = on ? C.primaryHi : 'rgba(255,255,255,0.25)'; g.lineWidth = 2; g.stroke();
        g.beginPath(); g.arc(on ? sx + sw - sh / 2 : sx + sh / 2, cy, sh / 2 - 4, 0, Math.PI * 2);
        g.fillStyle = '#ffffff'; g.fill();
        g.fillStyle = on ? (lit ? '#fff' : C.primaryHi) : fg2; g.textAlign = 'right';
        fillFit(g, on ? 'ON' : 'OFF', sx - 14, cy + 1, 70, 800, Math.round(h * 0.36), 16, N);
        right = sx - 14 - g.measureText(on ? 'ON' : 'OFF').width - 18;
      } else {
        drawIcon(g, 'next', right - 10, cy, 22, lit ? '#fff' : C.text3);
        g.textAlign = 'right'; g.fillStyle = lit ? '#fff' : C.accentHi;
        const vw = Math.min(ww * 0.55, ww - 200);
        const sz = fillFit(g, String(w.value), right - 28, cy + 1, vw, 800, w.size || Math.round(h * 0.4), 16, N);
        g.font = font(800, sz);
        right = right - 28 - Math.min(vw, g.measureText(String(w.value)).width) - 18;
      }
      if (w.icon) { drawIcon(g, w.icon, x + pad + 14, cy, 28, lit ? '#fff' : C.text2); }
      const lx = x + pad + (w.icon ? 42 : 0);
      rowLabel(g, w, lx, cy, Math.max(40, right - lx), lit, N);
      g.restore();
      return;
    }
    // Plain / primary / tab button: optional icon before the text, centred together.
    if (!w.text) { g.restore(); return; }
    const size = w.size || Math.round(h * 0.42);
    const weight = v === 'tab' ? (on ? 800 : 600) : 700;
    const icS = w.icon ? Math.round(Math.min(h * 0.5, size * 1.25)) : 0, gapI = w.icon ? Math.round(size * 0.4) : 0;
    const r2 = fitText(g, w.text, { maxW: ww - 24 - icS - gapI, size, min: Math.min(size, 12), weight });
    if (!r2.fits) reportOverflow(N, w.text, r2.width, ww - 24 - icS - gapI);
    const tw = Math.min(r2.width, ww - 24 - icS - gapI), x0 = x + ww / 2 - (tw + icS + gapI) / 2;
    const col = v === 'tab' ? (lit ? '#fff' : on ? C.accentHi : C.text2) : fg;
    if (w.icon) drawIcon(g, w.icon, x0 + icS / 2, cy, icS, v === 'tab' && on && !lit ? C.accent : col);
    g.fillStyle = col; g.textAlign = 'left';
    g.font = font(weight, r2.size);
    g.fillText(w.text, x0 + icS + gapI, cy + 1);
    if (v === 'tab' && on) { g.fillStyle = C.accent; rr(g, x + ww * 0.3, y + h - 5 + oy, ww * 0.4, 4, 2); g.fill(); }
    g.restore();
  }

  // A stepper row: the label on the left; − value + on the right.
  drawStepper(g, w, hov, prs) {
    const { x, y, h } = w, N = this.mesh.name, p = stepParts(w);
    surface(g, x, y, w.w, h, Math.min(18, h * 0.3), { top: C.raised2, bottom: C.raised, lift: true });
    const cy = y + h / 2;
    for (const [part, bx, t] of [['dec', p.dec, '−'], ['inc', p.inc, '+']]) {
      const hv = hov(part), pr = prs(part);
      g.save();
      if (hv) shadow(g, () => { rr(g, bx - 2, p.by - 2, p.b + 4, p.b + 4, p.b * 0.3); g.fillStyle = C.focus; g.fill(); }, 18, 0, 'rgba(61,139,255,0.8)');
      rr(g, bx, p.by + (pr ? 2 : 0), p.b, p.b, p.b * 0.28);
      g.fillStyle = hv || pr ? vgrad(g, p.by, p.by + p.b, pr ? C.focusLo : '#4a97ff', C.focusLo) : 'rgba(255,255,255,0.1)';
      g.fill();
      g.strokeStyle = hv ? C.focusHi : 'rgba(255,255,255,0.14)'; g.lineWidth = hv ? 3 : 2; g.stroke();
      g.fillStyle = '#fff'; g.textAlign = 'center';
      g.font = font(700, Math.round(p.b * 0.66));
      g.fillText(t, bx + p.b / 2, cy + 2 + (pr ? 2 : 0));
      g.restore();
    }
    const lit = hov('mid');
    g.textAlign = 'center'; g.fillStyle = lit ? C.focusHi : C.accentHi;
    fillFit(g, String(w.value), p.dec + p.b + p.vw / 2, cy + 1, p.vw - 12, 800, w.size || Math.round(h * 0.4), 14, N);
    const lx = x + 22 + (w.icon ? 42 : 0);
    if (w.icon) drawIcon(g, w.icon, x + 36, cy, 28, C.text2);
    rowLabel(g, w, lx, cy, p.dec - lx - 12, lit, N);
  }
}

// A setting row's label, with its one-line description under it if it has one.
function rowLabel(g, w, x, cy, maxW, lit, N) {
  const h = w.h, text = w.label || w.text || '';
  g.textAlign = 'left';
  if (!w.sub) { g.fillStyle = lit ? '#fff' : C.text; fillFit(g, text, x, cy + 1, maxW, 700, w.labelSize || Math.round(h * 0.4), 14, N); return; }
  g.fillStyle = lit ? '#fff' : C.text;
  fillFit(g, text, x, cy - h * 0.16, maxW, 700, w.labelSize || Math.min(28, Math.round(h * 0.38)), 14, N);
  g.fillStyle = lit ? 'rgba(255,255,255,0.85)' : C.text3;
  fillFit(g, w.sub, x, cy + h * 0.23, maxW, 500, Math.min(20, Math.round(h * 0.28)), 13, N);
}

// Where a stepper's − / + sit (drawn and hit-tested the same way): the
// value between them, the cluster at the row's right end.
export function stepParts(w) {
  const b = Math.round(w.h - 12), by = w.y + 6;
  const inc = w.x + w.w - 6 - b;
  const vw = w.vw || Math.max(110, Math.min(260, w.w * 0.36));
  const dec = inc - vw - b;
  return { b, by, inc, dec, vw };
}

// The panel's backing card: the panel colour, a soft top-down sheen, a
// border, a brand stripe along the top; with a title, a header band.
export function drawPanelBg(g, W, H, bg, band = 0) {
  const R = 28;
  rr(g, 4, 4, W - 8, H - 8, R);
  g.fillStyle = bg; g.fill();
  g.save();
  rr(g, 4, 4, W - 8, H - 8, R); g.clip();
  g.fillStyle = vgrad(g, 0, H * 0.55, 'rgba(120,160,220,0.10)', 'rgba(120,160,220,0)');
  g.fillRect(0, 0, W, H);
  if (band) {
    g.fillStyle = vgrad(g, 0, band, 'rgba(255,255,255,0.08)', 'rgba(255,255,255,0.03)');
    g.fillRect(0, 0, W, band);
    g.fillStyle = 'rgba(255,255,255,0.10)'; g.fillRect(0, band, W, 2);
  }
  g.fillStyle = hgrad(g, 0, W, C.primary, C.accent);
  g.fillRect(0, 4, W, 5);
  g.restore();
  rr(g, 4, 4, W - 8, H - 8, R);
  g.strokeStyle = 'rgba(255,255,255,0.2)'; g.lineWidth = 2.5; g.stroke();
}

const PAD = 22;            // text keeps this far from the panel's sides
const PAD_Y = 8;           // ... and from its bottom edge

function fillFitCentered(g, text, x, y, maxW, weight, size, name) {
  g.textAlign = 'center';
  fillFit(g, text, x, y, maxW, weight, size, Math.min(size, 12), name);
}

export const roundRect = rr;

// Grid layout helper: returns widget rects in rows/cols within a region.
export function grid(panel, { top = 0.16, bottom = 0.04, left = 0.05, right = 0.05, cols = 2, rows = 5, gap = 16 }) {
  const W = panel.W, H = panel.H;
  const x0 = W * left, x1 = W * (1 - right), y0 = H * top, y1 = H * (1 - bottom);
  const cw = (x1 - x0 - gap * (cols - 1)) / cols;
  const ch = (y1 - y0 - gap * (rows - 1)) / rows;
  return (c, r, cs = 1, rs = 1) => ({ x: x0 + c * (cw + gap), y: y0 + r * (ch + gap), w: cw * cs + gap * (cs - 1), h: ch * rs + gap * (rs - 1) });
}
