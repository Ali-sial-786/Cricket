// Stumps and bails: turned stumps (a spike below the turf, a domed top with
// the bail grooves cut across it), shaped bails (barrel, collars, spigots),
// painted like broadcast LED stumps with an invented sponsor band and, on the
// middle stump, the stump camera. One texture for the set, one LED glow map
// (the base window, the tops and the bails light up when the wicket is broken).
import * as THREE from 'three';
import { PITCH } from '../physics/pitch.js';

const H = PITCH.stumpHeight, R = PITCH.stumpRadius;
export const BAIL_LEN = 0.108, BAIL_R = 0.009;
const VTOP = 0.94;                   // stumps use v 0..VTOP of the texture, the bails the strip above
const TW = 256, TH = 512;

// Lathe profile, bottom to top (r, y): spike, shaft (a touch of taper), domed top.
const STUMP_PROFILE = [[0, -0.065], [0.004, -0.06], [0.0125, -0.02], [R * 0.93, 0], [R * 0.955, 0.25], [R * 0.985, 0.55],
  [R, 0.665], [R, H - 0.018], [R * 0.93, H - 0.008], [R * 0.7, H - 0.002], [R * 0.32, H], [0, H]];
const BAIL_PROFILE = [[0, -0.054], [0.0034, -0.0536], [0.0039, -0.043], [0.0062, -0.041], [0.0068, -0.036], [0.0058, -0.031],
  [0.0082, -0.026], [BAIL_R, -0.008], [BAIL_R, 0.008], [0.0082, 0.026], [0.0058, 0.031], [0.0068, 0.036], [0.0062, 0.041], [0.0039, 0.043], [0.0034, 0.0536], [0, 0.054]];

// middle: the stump-camera design (the right half of the texture); flip: the
// bowler's end (turned to face the other way).
const _stumpGeo = {};
export function stumpGeometry(middle, flip) {
  const k = (middle ? 'm' : 'o') + (flip ? 'f' : '');
  if (_stumpGeo[k]) return _stumpGeo[k];
  const g = new THREE.LatheGeometry(STUMP_PROFILE.map(([r, y]) => new THREE.Vector2(r, y)), 12);
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // the grooves: a slot across the top along x, where the bails sit
    if (y > H - 0.012 && Math.abs(z) < R * 0.55) p.setY(i, y - 0.0045 * (1 - Math.abs(z) / (R * 0.55)));
    uv.setXY(i, (middle ? 0.5 : 0) + uv.getX(i) * 0.5, Math.max(0, Math.min(1, y / H)) * VTOP);
    void x;
  }
  if (flip) g.rotateY(Math.PI);
  g.computeVertexNormals();
  return (_stumpGeo[k] = g);
}

let _bailGeo = null;
export function bailGeometry() {
  if (_bailGeo) return _bailGeo;
  const g = new THREE.LatheGeometry(BAIL_PROFILE.map(([r, y]) => new THREE.Vector2(r, y)), 8);
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, uv.getX(i) * 0.5, VTOP + 0.005 + (p.getY(i) / BAIL_LEN + 0.5) * (1 - VTOP - 0.01));
  g.rotateZ(-Math.PI / 2);                  // long axis along x
  g.computeVertexNormals();
  return (_bailGeo = g);
}

// The hole each stump stands in: three dark, soft discs (one mesh per end).
let _socketMat = null;
export function socketMesh(xs) {
  const parts = [];
  for (const x of xs) {
    const c = new THREE.CircleGeometry(R * 1.6, 12);
    c.rotateX(-Math.PI / 2); c.translate(x, 0.004, 0);
    const n = c.attributes.position.count, col = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { const centre = i === 0; col.set(centre ? [0.16, 0.12, 0.08, 0.85] : [0.3, 0.24, 0.17, 0], i * 4); }
    c.setAttribute('color', new THREE.BufferAttribute(col, 4));
    parts.push(c);
  }
  const g = mergeSimple(parts);
  // (one material for both ends; no fog: never 140 m from a camera)
  _socketMat = _socketMat || new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, fog: false });
  const m = new THREE.Mesh(g, _socketMat);
  m.renderOrder = 1;
  return m;
}
function mergeSimple(parts) {
  let nv = 0, ni = 0;
  for (const p of parts) { nv += p.attributes.position.count; ni += p.index.count; }
  const pos = new Float32Array(nv * 3), col = new Float32Array(nv * 4), idx = [];
  let o = 0;
  for (const p of parts) {
    pos.set(p.attributes.position.array, o * 3); col.set(p.attributes.color.array, o * 4);
    for (let i = 0; i < p.index.count; i++) idx.push(p.index.getX(i) + o);
    o += p.attributes.position.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 4));
  g.setIndex(idx);
  return g;
}

// Texture: left half the outer stumps, right half the middle stump (with the
// camera); rows: y up the stump (v = y / H * VTOP), the bails in the top strip.
// u = 0 faces +z on the lathe (the keeper, at the striker's end); the bowler
// sees u = 0.5.
let _tex = null, _led = null;
export function wicketTextures() {
  if (_tex) return { map: _tex, led: _led };
  const c = document.createElement('canvas'); c.width = TW; c.height = TH;
  const g = c.getContext('2d');
  const e = document.createElement('canvas'); e.width = 64; e.height = 128;
  const l = e.getContext('2d');
  const Y = (y) => (1 - (y / H) * VTOP) * TH;               // canvas row of a height on the stump
  const NAVY = '#16285c', RED = '#c8262c';
  for (const half of [0, 1]) {
    const x0 = half * TW / 2, w = TW / 2, front = x0 + w * 0.5;
    // glossy white plastic, a soft vertical sheen
    const gr = g.createLinearGradient(x0, 0, x0 + w, 0);
    gr.addColorStop(0, '#e9e4d8'); gr.addColorStop(0.5, '#f7f4ec'); gr.addColorStop(1, '#e9e4d8');
    g.fillStyle = gr; g.fillRect(x0, 0, w, TH);
    // the LED window at the foot
    g.fillStyle = '#25282e'; g.fillRect(x0, Y(0.105), w, Y(0.03) - Y(0.105));
    g.fillStyle = 'rgba(255,90,70,0.35)';
    for (let yy = Y(0.1); yy < Y(0.035); yy += 6) for (let xx = x0 + 3; xx < x0 + w; xx += 8) g.fillRect(xx, yy, 2, 2);
    // the spike and the foot: bare dark composite
    g.fillStyle = '#3a3c40'; g.fillRect(x0, Y(0.0), w, TH - Y(0.0));
    // sponsor band: red rule, navy panel with the name up the front, red rule
    g.fillStyle = RED; g.fillRect(x0, Y(0.585), w, Y(0.565) - Y(0.585));
    g.fillStyle = NAVY; g.fillRect(x0, Y(0.555), w, Y(0.30) - Y(0.555));
    g.fillStyle = RED; g.fillRect(x0, Y(0.29), w, Y(0.275) - Y(0.29));
    g.save(); g.translate(front, (Y(0.555) + Y(0.30)) / 2); g.rotate(-Math.PI / 2);
    g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    let fs = 30; g.font = `900 ${fs}px system-ui, Arial, sans-serif`;
    const tw = g.measureText('NIGHTWATCH').width, room = Y(0.30) - Y(0.555) - 10;
    if (tw > room) { fs *= room / tw; g.font = `900 ${Math.floor(fs)}px system-ui, Arial, sans-serif`; }
    g.fillText('NIGHTWATCH', 0, 1);
    g.restore();
    // a small maker's mark under the band
    g.fillStyle = NAVY; g.font = '800 9px system-ui, Arial, sans-serif'; g.textAlign = 'center';
    g.fillText('HALCYON', front, Y(0.23));
    // the top: varnished cap line
    g.fillStyle = 'rgba(160,140,100,0.5)'; g.fillRect(x0, Y(H - 0.02), w, 2);
    if (half === 1) {
      // stump camera: a dark lens housing with a glint, just under the top, facing the bowler
      const cy = Y(0.63);
      g.fillStyle = '#1a1c20'; g.beginPath(); g.ellipse(front, cy, 7, 9, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#3a5f8a'; g.beginPath(); g.ellipse(front, cy, 4, 5, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#e8f2ff'; g.fillRect(front - 2, cy - 3, 2, 2);
      g.fillStyle = '#1a1c20'; g.fillRect(front - 1, Y(0.6), 2, Y(0.4) - Y(0.6));      // (the mic cable groove)
    }
  }
  // the bails' strip: white with a red barrel stripe
  const yb0 = 0, yb1 = (1 - VTOP) * TH;
  g.fillStyle = '#f4f1e8'; g.fillRect(0, yb0, TW, yb1);
  g.fillStyle = RED; g.fillRect(0, yb0 + yb1 * 0.44, TW, yb1 * 0.12);
  // LED glow map: the base window, the tops, the bails
  l.fillStyle = '#000'; l.fillRect(0, 0, 64, 128);
  const Ye = (y) => (1 - (y / H) * VTOP) * 128;
  l.fillStyle = '#fff'; l.fillRect(0, Ye(0.105), 64, Ye(0.03) - Ye(0.105));
  l.fillRect(0, 0, 64, Ye(H - 0.012));
  _tex = new THREE.CanvasTexture(c); _tex.colorSpace = THREE.SRGBColorSpace; _tex.anisotropy = 4;
  _led = new THREE.CanvasTexture(e); _led.colorSpace = THREE.SRGBColorSpace;
  return { map: _tex, led: _led };
}
