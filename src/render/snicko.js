// Snicko on the DRS screen (drsView.js): the camera frame of the ball next to
// the bat on top, the stump microphone's trace underneath with the frame
// marker, broadcast style. Canvas 2D only, redrawn when the third umpire
// steps a frame (not every video frame).
//
// The camera frame is the front-on camera's (from the bowler's end, a long
// lens: world +X, the off side, is screen left): the bat drawn as it stood in
// that frame (edgeTrack.js keeps its pose with every frame), the ball coming
// up to it — a little bigger while nearer the camera — and hidden by the blade
// once it has gone behind it.
import { frameAt, passOf } from '../game/edgeTrack.js';
import { CONFIG } from '../config.js';

const TELE = 7;             // m: the front-on camera's distance (perspective: a long lens)
const VIEW_W = 0.5;         // m across the picture

export function batDims(cfg = CONFIG) {
  const b = cfg.bat;
  const shoulderY = b.gripFromHandleTop - b.handleLength;
  return {
    hx: b.bladeWidth / 2, hz: b.bladeThickness / 2, toeY: shoulderY - b.bladeLength, shoulderY,
    handleTopY: b.gripFromHandleTop, handleR: b.handleRadius, R: cfg.ball.radius, bladeLength: b.bladeLength,
  };
}

export function snickoLayout(rect) {
  const { x, y, w, h } = rect;
  const camW = Math.round(w * 0.6), camH = Math.round(h * 0.52);
  return {
    cam: { x: x + 16, y: y + 10, w: camW, h: camH },
    info: { x: x + camW + 34, y: y + 10, w: w - camW - 50, h: camH },
    wave: { x: x + 16, y: y + camH + 28, w: w - 32, h: h - camH - 48 },
  };
}

// Where (px) on the waveform a moment falls.
export function traceX(trace, wave, t) { return wave.x + (t - trace.t0) / (trace.t1 - trace.t0) * wave.w; }

// A point given in the bat's frame, in the world, for frame f (its bat pose).
function batPoint(f, lx, ly, lz) {
  const { qx, qy, qz, qw } = f;
  // v + 2 q x (q x v + w v)
  const tx = qy * lz - qz * ly + qw * lx, ty = qz * lx - qx * lz + qw * ly, tz = qx * ly - qy * lx + qw * lz;
  return { x: f.px + lx + 2 * (qy * tz - qz * ty), y: f.py + ly + 2 * (qz * tx - qx * tz), z: f.pz + lz + 2 * (qx * ty - qy * tx) };
}
const batDir = (f, lx, ly, lz) => { const a = batPoint(f, lx, ly, lz), o = batPoint(f, 0, 0, 0); return { x: a.x - o.x, y: a.y - o.y, z: a.z - o.z }; };

// A frame without the bat's pose (old logs, tests): upright, face to the bowler.
function withPose(f) {
  if (!f || f.qw != null) return f;
  const g = { ...f, qx: 0, qy: 1, qz: 0, qw: 0, px: 0, py: 0, pz: 0 };
  const w = batPoint(g, f.lx, f.ly, f.lz);
  return { ...g, px: f.x - w.x, py: f.y - w.y, pz: f.z - w.z };
}

// The front-on camera for this log: centred between the ball as it passes
// and the bat beside it; S px per m; z0 the bat's depth.
export function cameraView(log, trace, cam, dims = batDims()) {
  const S = cam.w / VIEW_W, ox = cam.x + cam.w / 2, oy = cam.y + cam.h / 2;
  const f = log && log.frames.length ? withPose(frameAt(log, trace.tc)) : null;
  if (!f) return { cx: 0, cy: 0.4, z0: -1.2, S, ox, oy };
  const bp = batPoint(f, Math.max(-dims.hx, Math.min(dims.hx, f.lx)), Math.max(dims.toeY + 0.05, Math.min(dims.shoulderY - 0.05, f.ly)), 0);
  return { cx: f.x + (bp.x - f.x) * 0.45, cy: f.y + (bp.y - f.y) * 0.45, z0: bp.z, S, ox, oy };
}

// Where a world point is in the picture: [x, y, scale].
export function project(view, x, y, z) {
  const k = TELE / Math.max(1, TELE + (z - view.z0));
  return [view.ox - (x - view.cx) * view.S * k, view.oy - (y - view.cy) * view.S * k, k];
}

function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

function drawBall(g, x, y, r, alpha = 1) {
  g.save();
  g.globalAlpha = alpha;
  const gr = g.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
  gr.addColorStop(0, '#ff8a7a'); gr.addColorStop(0.55, '#c81e24'); gr.addColorStop(1, '#6e0c10');
  g.fillStyle = gr;
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  if (alpha > 0.9) {
    g.strokeStyle = 'rgba(255,240,220,0.75)'; g.lineWidth = Math.max(1, r * 0.08);
    g.beginPath(); g.ellipse(x, y, r * 0.92, r * 0.3, -0.5, 0, Math.PI * 2); g.stroke();
  }
  g.restore();
}

const FACES = [
  // local normal, the 4 corners (signs of x, y (0 toe / 1 shoulder), z), colour
  { n: [0, 0, 1], c: [[-1, 0, 1], [1, 0, 1], [1, 1, 1], [-1, 1, 1]], col: 'front' },
  { n: [0, 0, -1], c: [[-1, 0, -1], [1, 0, -1], [1, 1, -1], [-1, 1, -1]], col: '#b39462' },
  { n: [1, 0, 0], c: [[1, 0, -1], [1, 0, 1], [1, 1, 1], [1, 1, -1]], col: '#9c7f4e' },
  { n: [-1, 0, 0], c: [[-1, 0, -1], [-1, 0, 1], [-1, 1, 1], [-1, 1, -1]], col: '#9c7f4e' },
  { n: [0, -1, 0], c: [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1]], col: '#806640' },
];

// The bat as the front-on camera saw it in frame f.
function drawBatFront(g, view, f, dims) {
  const { hx, hz, toeY, shoulderY, handleTopY, handleR } = dims;
  const P = (lx, ly, lz) => { const w = batPoint(f, lx, ly, lz); return project(view, w.x, w.y, w.z); };
  // handle and gloves first (behind the top of the blade)
  const a = P(0, shoulderY, 0), b = P(0, handleTopY, 0);
  g.strokeStyle = '#2a2f36'; g.lineCap = 'round'; g.lineWidth = Math.max(3, 2 * handleR * view.S * a[2]);
  g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
  for (const gy of [shoulderY + 0.1, shoulderY + 0.22]) {
    const c = P(0, gy, 0), w = 0.1 * view.S * c[2], h = 0.085 * view.S * c[2];
    g.fillStyle = '#eef2f5'; rr(g, c[0] - w / 2, c[1] - h / 2, w, h, w * 0.3); g.fill();
    g.fillStyle = '#2f6fd6'; g.fillRect(c[0] - w / 2 + 3, c[1] - h * 0.1, w - 6, h * 0.16);
  }
  // the faces of the blade that look toward the camera
  for (const F of FACES) {
    const nw = batDir(f, F.n[0], F.n[1], F.n[2]);
    if (nw.z > -0.03) continue;                       // facing away (the camera looks along +z)
    const pts = F.c.map(([sx, sy, sz]) => P(sx * hx, sy ? shoulderY : toeY, sz * hz));
    g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath();
    if (F.col === 'front') {
      const l = P(-hx, (toeY + shoulderY) / 2, hz), r = P(hx, (toeY + shoulderY) / 2, hz);
      const gr = g.createLinearGradient(l[0], l[1], r[0], r[1]);
      gr.addColorStop(0, '#a88b58'); gr.addColorStop(0.1, '#d8bf8a'); gr.addColorStop(0.5, '#ead6a6'); gr.addColorStop(0.9, '#d8bf8a'); gr.addColorStop(1, '#a88b58');
      g.fillStyle = gr;
    } else g.fillStyle = F.col;
    g.fill();
    g.strokeStyle = 'rgba(60,44,20,0.85)'; g.lineWidth = 2; g.stroke();
    if (F.col === 'front') {
      g.strokeStyle = 'rgba(120,96,56,0.5)'; g.lineWidth = 1.4;
      for (let i = 1; i < 9; i++) {
        const lx = -hx + 2 * hx * (i / 9);
        const u = P(lx, toeY + 0.02, hz), v = P(lx + Math.sin(i) * 0.002, shoulderY - 0.02, hz);
        g.beginPath(); g.moveTo(u[0], u[1]); g.lineTo(v[0], v[1]); g.stroke();
      }
    }
  }
}

// state: { trace, log, k (frame index into trace.frames), dims }
export function drawSnicko(g, rect, { trace, log, k = 0, dims = batDims() }) {
  const L = snickoLayout(rect);
  const fdt = trace.frameDt, frames = trace.frames;
  k = Math.max(0, Math.min(frames.length - 1, k));
  const tNow = frames.length ? frames[k] : trace.tc;
  const rel = Math.round((tNow - trace.tc) / fdt);

  // ---- the camera frame
  const C = L.cam;
  g.save();
  rr(g, C.x, C.y, C.w, C.h, 12); g.clip();
  const bg = g.createLinearGradient(0, C.y, 0, C.y + C.h);
  bg.addColorStop(0, '#3b4a3c'); bg.addColorStop(0.6, '#2a372c'); bg.addColorStop(1, '#1d261f');
  g.fillStyle = bg; g.fillRect(C.x, C.y, C.w, C.h);
  const view = cameraView(log, trace, C, dims);
  const has = log && log.frames.length;
  const f = has ? withPose(frameAt(log, tNow)) : null;
  const ball = (fr, alpha) => {
    const [bx, by, kk] = project(view, fr.x, fr.y, fr.z);
    drawBall(g, bx, by, dims.R * view.S * kk, alpha);
  };
  // ghosts of the last frames (motion), then the ball behind or in front of the blade
  const ghosts = [];
  for (let j = 3; j >= 1; j--) if (k - j >= 0 && has) ghosts.push(frameAt(log, frames[k - j]));
  const behind = f && f.lz < -dims.hz;
  if (f) {
    if (behind) { ghosts.forEach((gf, i) => ball(gf, 0.12 + 0.08 * i)); ball(f, 1); }
    drawBatFront(g, view, f, dims);
    if (!behind) { ghosts.forEach((gf, i) => { if (gf.lz >= -dims.hz) ball(gf, 0.12 + 0.08 * i); }); ball(f, 1); }
  } else {
    g.fillStyle = 'rgba(255,255,255,0.55)'; g.font = '600 30px system-ui, sans-serif'; g.textAlign = 'center';
    g.fillText('NO PICTURES', C.x + C.w / 2, C.y + C.h / 2);
  }
  // broadcast frame furniture
  g.fillStyle = 'rgba(0,0,0,0.55)';
  rr(g, C.x + 12, C.y + 12, 168, 44, 8); g.fill();
  g.fillStyle = '#ffffff'; g.font = '700 26px system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
  g.fillText(`FRAME ${rel > 0 ? '+' : rel < 0 ? '−' : '±'}${Math.abs(rel)}`, C.x + 24, C.y + 35);
  g.restore();
  g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = 2;
  rr(g, C.x, C.y, C.w, C.h, 12); g.stroke();

  // ---- beside it: what the frame is
  const I = L.info;
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.fillStyle = '#ffd34d'; g.font = `800 ${Math.round(I.h * 0.17)}px system-ui, sans-serif`;
  g.fillText('SNICKO', I.x, I.y + I.h * 0.2);
  g.fillStyle = '#9fb2c4'; g.font = `600 ${Math.round(I.h * 0.085)}px system-ui, sans-serif`;
  g.fillText('STUMP MICROPHONE', I.x, I.y + I.h * 0.33);
  const ms = (tNow - trace.tc) * 1000;
  g.fillStyle = '#e8eef5'; g.font = `700 ${Math.round(I.h * 0.12)}px system-ui, sans-serif`;
  g.fillText(`${ms > 0.05 ? '+' : ms < -0.05 ? '−' : ''}${Math.abs(ms).toFixed(0)} ms`, I.x, I.y + I.h * 0.56);
  const atBat = Math.abs(tNow - trace.tc) < fdt * 0.5;
  if (atBat) {
    g.fillStyle = '#ffd34d'; g.font = `800 ${Math.round(I.h * 0.1)}px system-ui, sans-serif`;
    // (touched it, or within a few cm: at the bat; a clear miss: past it, its nearest)
    const pass = log ? passOf(log) : null;
    g.fillText(!pass || pass.contact || pass.d < 0.05 ? 'BALL AT THE BAT' : `BALL PASSES · ${Math.round(pass.d * 100)} cm`, I.x, I.y + I.h * 0.76);
  } else if (f) {
    g.fillStyle = '#9fb2c4'; g.font = `600 ${Math.round(I.h * 0.085)}px system-ui, sans-serif`;
    g.fillText(tNow < trace.tc ? 'BALL COMING TO THE BAT' : 'BALL PAST THE BAT', I.x, I.y + I.h * 0.76);
  }

  // ---- the waveform
  const W = L.wave, cy = W.y + W.h / 2;
  g.fillStyle = '#03060a'; rr(g, W.x, W.y, W.w, W.h, 10); g.fill();
  g.save();
  rr(g, W.x, W.y, W.w, W.h, 10); g.clip();
  // a tick for every camera frame, the frame marker's track
  g.strokeStyle = 'rgba(80,110,140,0.22)'; g.lineWidth = 1;
  for (const ft of frames) { const x = traceX(trace, W, ft); g.beginPath(); g.moveTo(x, W.y); g.lineTo(x, W.y + W.h); g.stroke(); }
  g.strokeStyle = 'rgba(110,140,170,0.45)';
  g.beginPath(); g.moveTo(W.x, cy); g.lineTo(W.x + W.w, cy); g.stroke();
  const xNow = traceX(trace, W, tNow);
  const amp = W.h * 0.46;
  const n = trace.n;
  const path = (from, to) => {
    g.beginPath();
    for (let i = from; i <= to; i++) {
      const x = W.x + (i / (n - 1)) * W.w, y = cy - trace.values[i] * amp;
      if (i === from) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  };
  const iNow = Math.max(0, Math.min(n - 1, Math.round((xNow - W.x) / W.w * (n - 1))));
  g.lineWidth = 1.6; g.strokeStyle = 'rgba(120,160,190,0.35)';
  path(iNow, n - 1);
  g.shadowColor = 'rgba(110,220,255,0.8)'; g.shadowBlur = 8;
  g.lineWidth = 2.2; g.strokeStyle = '#eafaff';
  path(0, iNow);
  g.shadowBlur = 0;
  // the frame marker
  g.strokeStyle = '#ffd34d'; g.lineWidth = 3;
  g.beginPath(); g.moveTo(xNow, W.y); g.lineTo(xNow, W.y + W.h); g.stroke();
  g.fillStyle = '#ffd34d';
  g.beginPath(); g.moveTo(xNow - 9, W.y); g.lineTo(xNow + 9, W.y); g.lineTo(xNow, W.y + 12); g.closePath(); g.fill();
  g.restore();
  g.strokeStyle = 'rgba(255,255,255,0.22)'; g.lineWidth = 2;
  rr(g, W.x, W.y, W.w, W.h, 10); g.stroke();
  g.fillStyle = 'rgba(159,178,196,0.85)'; g.font = '600 18px system-ui, sans-serif'; g.textBaseline = 'top';
  g.textAlign = 'right';
  g.fillText(`1 FRAME = ${Math.round(fdt * 1000)} ms`, W.x + W.w - 10, W.y + 8);
}
