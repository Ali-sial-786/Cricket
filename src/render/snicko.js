// Snicko on the DRS screen (drsView.js): the camera frame of the ball next to
// the bat on top, the stump microphone's trace underneath with the frame
// marker, broadcast style. Canvas 2D only, redrawn when the third umpire
// steps a frame (not every video frame).
//
// The camera frame is drawn in the bat's own frame (edgeTrack.js frames: x
// across the face, y up the bat, z out of the front face), seen from in front
// of the face: the bat stands still and the ball goes past it, bigger while it
// is in front of the face, smaller and hidden by the blade once behind it.
import { frameAt } from '../game/edgeTrack.js';
import { CONFIG } from '../config.js';

const CAM_D = 1.4;          // m: the camera's distance in front of the face (perspective)
const VIEW_W = 0.5;         // m of the bat's frame across the picture

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

// The camera's view centre (bat-local x, y) and scale for this log.
export function cameraView(log, trace, cam, dims = batDims()) {
  const f = log && log.frames.length ? frameAt(log, trace.tc) : null;
  const S = cam.w / VIEW_W;
  let cx = 0, cy = dims.toeY + 0.24;
  if (f) {
    const edge = Math.max(-dims.hx, Math.min(dims.hx, f.lx));
    cx = (edge + Math.max(-dims.hx - 0.16, Math.min(dims.hx + 0.16, f.lx))) / 2;
    const room = (cam.h / S) / 2 - 0.05;
    cy = Math.max(dims.toeY + room - 0.06, Math.min(dims.shoulderY + 0.1 - room, f.ly));
  }
  return { cx, cy, S };
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

function drawBat(g, toScreen, dims, S) {
  const { hx, toeY, shoulderY, handleTopY, handleR } = dims;
  const [x0, y0] = toScreen(-hx, shoulderY), [x1, y1] = toScreen(hx, toeY);
  const bw = x1 - x0, bh = y1 - y0;
  // blade: willow, grain, darker edges
  const gr = g.createLinearGradient(x0, 0, x1, 0);
  gr.addColorStop(0, '#9c8150'); gr.addColorStop(0.1, '#d8bf8a'); gr.addColorStop(0.5, '#e8d3a2'); gr.addColorStop(0.9, '#d8bf8a'); gr.addColorStop(1, '#9c8150');
  g.fillStyle = gr;
  rr(g, x0, y0, bw, bh, Math.min(bw, bh) * 0.08);
  g.fill();
  g.strokeStyle = 'rgba(120,96,56,0.55)'; g.lineWidth = 1.5;
  for (let i = 1; i < 9; i++) {
    const gx = x0 + bw * (i / 9) + Math.sin(i * 2.1) * 2;
    g.beginPath(); g.moveTo(gx, y0 + 6); g.lineTo(gx + Math.sin(i) * 3, y1 - 6); g.stroke();
  }
  g.strokeStyle = 'rgba(60,44,20,0.9)'; g.lineWidth = 2.5;
  rr(g, x0, y0, bw, bh, Math.min(bw, bh) * 0.08); g.stroke();
  // handle and the grip
  const [hx0, hy0] = toScreen(-handleR, handleTopY), [hx1] = toScreen(handleR, handleTopY);
  g.fillStyle = '#2a2f36';
  g.fillRect(hx0, hy0, hx1 - hx0, y0 - hy0);
  g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 1;
  for (let yy = hy0 + 4; yy < y0; yy += 7) { g.beginPath(); g.moveTo(hx0, yy); g.lineTo(hx1, yy + 3); g.stroke(); }
  // gloves on the handle
  const gw = (hx1 - hx0) * 3.4;
  for (const gy of [shoulderY + 0.07, shoulderY + 0.19]) {
    const [, sy] = toScreen(0, gy + 0.055);
    const cx = (hx0 + hx1) / 2;
    g.fillStyle = '#eef2f5';
    rr(g, cx - gw / 2, sy, gw, 0.1 * S, gw * 0.3); g.fill();
    g.fillStyle = '#2f6fd6';
    g.fillRect(cx - gw / 2 + 3, sy + 0.035 * S, gw - 6, 0.012 * S);
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
  const ox = C.x + C.w / 2, oy = C.y + C.h / 2;
  const toScreen = (lx, ly, kk = 1) => [ox + (lx - view.cx) * view.S * kk, oy - (ly - view.cy) * view.S * kk];
  const f = log && log.frames.length ? frameAt(log, tNow) : null;
  const ball = (fr, alpha) => {
    const kk = CAM_D / Math.max(0.3, CAM_D - fr.lz);
    const [bx, by] = toScreen(fr.lx, fr.ly, kk);
    drawBall(g, bx, by, dims.R * view.S * kk, alpha);
  };
  // ghosts of the last frames (motion), then the ball behind or in front of the blade
  const ghosts = [];
  for (let j = 3; j >= 1; j--) if (k - j >= 0 && log && log.frames.length) ghosts.push(frameAt(log, frames[k - j]));
  const behind = f && f.lz < -dims.hz;
  if (behind) { for (const [i, gf] of ghosts.entries()) ball(gf, 0.12 + 0.08 * i); ball(f, 1); }
  drawBat(g, toScreen, dims, view.S);
  if (f && !behind) { for (const [i, gf] of ghosts.entries()) if (gf.lz >= -dims.hz) ball(gf, 0.12 + 0.08 * i); ball(f, 1); }
  if (!f) {
    g.fillStyle = 'rgba(255,255,255,0.55)'; g.font = '600 30px system-ui, sans-serif'; g.textAlign = 'center';
    g.fillText('NO PICTURES', ox, oy);
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
    g.fillText('BALL AT THE BAT', I.x, I.y + I.h * 0.76);
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
