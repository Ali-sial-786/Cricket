// In-world UI panel rendered to a canvas texture. Widgets are laid out in
// canvas pixels; hit testing uses the raycast UV. Redraws only when dirty.
import * as THREE from 'three';

export class CanvasPanel {
  constructor({ width = 1.0, height = 0.62, ppm = 700, name = 'panel', bg = 'rgba(14,20,30,0.88)', interactive = true } = {}) {
    this.w = width; this.h = height;
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
      new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, toneMapped: false }),
    );
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
          if (x < w.x + w.h * 1.1) partName = 'dec';
          else if (x > w.x + w.w - w.h * 1.1) partName = 'inc';
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
    this.dirty = false;
    this.draw();
    this.tex.needsUpdate = true;
  }

  draw() {
    const g = this.ctx, W = this.W, H = this.H;
    g.clearRect(0, 0, W, H);
    if (this.bg) {
      g.fillStyle = this.bg;
      roundRect(g, 4, 4, W - 8, H - 8, 28);
      g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.18)';
      g.lineWidth = 3;
      g.stroke();
    }
    if (this.title) {
      g.fillStyle = '#ffd34d';
      g.font = `700 ${Math.round(H * 0.075)}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(this.title, W / 2, H * 0.08);
    }
    for (const w of this.widgets) this.drawWidget(g, w);
  }

  drawWidget(g, w) {
    const hov = (p) => this.hover === `${w.id}:${p}`;
    g.textBaseline = 'middle';
    if (w.type === 'label') {
      g.fillStyle = w.color || '#e8eef5';
      g.font = `${w.bold ? 700 : 500} ${w.size || 30}px system-ui, sans-serif`;
      g.textAlign = w.align || 'left';
      const lines = String(w.text).split('\n');
      const lh = (w.size || 30) * 1.25;
      lines.forEach((ln, i) => g.fillText(ln, w.x, w.y + i * lh));
      return;
    }
    if (w.type === 'button' || w.type === 'toggle') {
      const active = w.active;
      g.fillStyle = w.disabled ? 'rgba(80,80,80,0.5)' : hov('main') ? '#3d8bfd' : active ? '#2e7d32' : 'rgba(255,255,255,0.12)';
      roundRect(g, w.x, w.y, w.w, w.h, 16);
      g.fill();
      if (active) { g.strokeStyle = '#7dff8a'; g.lineWidth = 4; g.stroke(); }
      g.fillStyle = w.disabled ? '#999' : '#ffffff';
      g.font = `600 ${w.size || Math.round(w.h * 0.42)}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.fillText(w.text, w.x + w.w / 2, w.y + w.h / 2 + 1);
      return;
    }
    if (w.type === 'stepper') {
      const bw = w.h * 1.1;
      g.fillStyle = 'rgba(255,255,255,0.08)';
      roundRect(g, w.x, w.y, w.w, w.h, 14);
      g.fill();
      for (const [p, x, t] of [['dec', w.x, '−'], ['inc', w.x + w.w - bw, '+']]) {
        g.fillStyle = hov(p) ? '#3d8bfd' : 'rgba(255,255,255,0.16)';
        roundRect(g, x, w.y, bw, w.h, 14);
        g.fill();
        g.fillStyle = '#fff';
        g.font = `700 ${Math.round(w.h * 0.6)}px system-ui, sans-serif`;
        g.textAlign = 'center';
        g.fillText(t, x + bw / 2, w.y + w.h / 2 + 2);
      }
      g.fillStyle = '#c9d6e3';
      g.font = `500 ${Math.round(w.h * 0.36)}px system-ui, sans-serif`;
      g.textAlign = 'left';
      g.fillText(w.label, w.x + bw + 16, w.y + w.h / 2);
      g.fillStyle = '#ffffff';
      g.font = `700 ${Math.round(w.h * 0.4)}px system-ui, sans-serif`;
      g.textAlign = 'right';
      g.fillText(w.value, w.x + w.w - bw - 16, w.y + w.h / 2);
    }
  }
}

export function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// Grid layout helper: returns widget rects in rows/cols within a region.
export function grid(panel, { top = 0.16, bottom = 0.04, left = 0.05, right = 0.05, cols = 2, rows = 5, gap = 16 }) {
  const W = panel.W, H = panel.H;
  const x0 = W * left, x1 = W * (1 - right), y0 = H * top, y1 = H * (1 - bottom);
  const cw = (x1 - x0 - gap * (cols - 1)) / cols;
  const ch = (y1 - y0 - gap * (rows - 1)) / rows;
  return (c, r, cs = 1, rs = 1) => ({ x: x0 + c * (cw + gap), y: y0 + r * (ch + gap), w: cw * cs + gap * (cs - 1), h: ch * rs + gap * (rs - 1) });
}
