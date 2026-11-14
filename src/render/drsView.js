// The Decision Review System presentation: TV-style ball tracking for an LBW
// review and the third umpire's line call for run-outs / stumpings. World
// space, VR friendly: a handful of unlit meshes and one canvas board; no
// post-processing, no per-frame allocation.
//
//   const drs = new DRSView(scene);
//   drs.startLbw({ track, deliveryPath, onFieldOut, outcome, viewerPos });
//   // or drs.startThird({ kind: 'run_out', end: 'batting', margin, viewerPos });
//   each frame: drs.update(dt); for (const cue of drs.takeCues()) …
//   when drs.done: read drs.result, then drs.hide().
//
// Everything lives under one group that is only in the scene between start*()
// and hide(). Frame: config.js (batting stumps at the origin, ball travels +Z).

import * as THREE from 'three';
import { CanvasPanel, roundRect } from '../ui/panel.js';
import { PITCH, battingPoppingZ, bowlingPoppingZ } from '../physics/pitch.js';
import { CONFIG } from '../config.js';
import { verdictRows } from '../game/lbw.js';
import { radialTexture } from './util.js';

const HEX = { green: 0x39e07a, red: 0xff4d5e, amber: 0xffb547, white: 0xffffff, blue: 0x3d8bff };
const CSS = { green: '#39e07a', red: '#ff4d5e', amber: '#ffb547', white: '#f2f5f9' };

// Timeline (seconds at speed 1).
const LBW_T = {
  onField: 0.5,       // the ON-FIELD CALL row
  extras: 0.9,        // NO BALL / BAT FIRST rows, if any
  track: 1.4,         // the delivery starts drawing…
  toImpact: 2.3,      // …and takes this long to reach the pad
  rowAfter: 0.2,      // a verdict row comes up this long into its phase
  hold: 1.1,          // 'pitching' and 'impact' phases
  project: 1.3,       // the projection from the pad to the stumps
  wicketsRow: 0.2,    // after the projection arrives
  decideAfter: 1.0,
  showDecision: 2.2,
};
const THIRD_T = { check: 1.0, freeze: 2.8, decide: 3.8, end: 6.0 };
const PAST_STUMPS = 1.0;      // m a missing projection is drawn on past the stumps

const SIDES = 8;
const MAX_DELIVERY = 128;     // rings in the delivery tube
const MAX_PROJECTION = 40;
const EMPTY = Object.freeze([]);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// CanvasPanel plus a filled 'bar' widget (the coloured verdict pills).
class Board extends CanvasPanel {
  drawWidget(g, w) {
    if (w.type === 'bar') {
      g.fillStyle = w.color;
      roundRect(g, w.x, w.y, w.w, w.h, w.radius ?? 12);
      g.fill();
      return;
    }
    super.drawWidget(g, w);
  }
}

function basic(color, opacity = 1, extra = {}) {
  return new THREE.MeshBasicMaterial({
    color, opacity, transparent: opacity < 1, depthWrite: opacity >= 1,
    side: THREE.DoubleSide, toneMapped: false, fog: false, ...extra,
  });
}

// A preallocated tube along a polyline, revealed by arc length.
function makeTube(maxRings, material) {
  const pos = new Float32Array(maxRings * SIDES * 3);
  const geom = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(pos, 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute('position', attr);
  const idx = new Uint16Array((maxRings - 1) * SIDES * 6);
  let o = 0;
  for (let i = 0; i < maxRings - 1; i++) {
    for (let k = 0; k < SIDES; k++) {
      const a = i * SIDES + k, b = i * SIDES + ((k + 1) % SIDES), c = a + SIDES, d = b + SIDES;
      idx[o++] = a; idx[o++] = c; idx[o++] = b;
      idx[o++] = b; idx[o++] = c; idx[o++] = d;
    }
  }
  geom.setIndex(new THREE.BufferAttribute(idx, 1));
  geom.setDrawRange(0, 0);
  const mesh = new THREE.Mesh(geom, material);
  mesh.frustumCulled = false;
  return {
    mesh, geom, attr, pos,
    src: new Float32Array(pos.length),      // the full tube's rings
    ctr: new Float32Array(maxRings * 3),    // centre line
    len: new Float32Array(maxRings),        // cumulative arc length
    max: maxRings, n: 0, total: 0, live: -1, seg: 0, s: -1,
  };
}

// Lay the tube along pts[0..n-1] ({x,y,z}); nothing is shown until growTube.
function fillTube(tube, pts, n, radius) {
  n = Math.min(n, tube.max);
  tube.n = n; tube.live = -1; tube.seg = 0; tube.s = -1; tube.total = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i], a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, n - 1)];
    let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    let l = Math.hypot(dx, dy, dz);
    if (l < 1e-6) { dx = 0; dy = 0; dz = 1; l = 1; }
    dx /= l; dy /= l; dz /= l;
    // side = dir x up (horizontal), up2 = side x dir.
    let sx = -dz, sz = dx;
    const sl = Math.hypot(sx, sz);
    if (sl < 1e-4) { sx = 1; sz = 0; } else { sx /= sl; sz /= sl; }
    const ux = -sz * dy, uy = sz * dx - sx * dz, uz = sx * dy;
    for (let k = 0; k < SIDES; k++) {
      const ang = (k / SIDES) * Math.PI * 2, c = Math.cos(ang) * radius, s = Math.sin(ang) * radius;
      const o = (i * SIDES + k) * 3;
      tube.src[o] = p.x + sx * c + ux * s;
      tube.src[o + 1] = p.y + uy * s;
      tube.src[o + 2] = p.z + sz * c + uz * s;
    }
    tube.ctr[i * 3] = p.x; tube.ctr[i * 3 + 1] = p.y; tube.ctr[i * 3 + 2] = p.z;
    if (i > 0) {
      const q = pts[i - 1];
      tube.total += Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
    }
    tube.len[i] = tube.total;
  }
  tube.pos.set(tube.src);
  tube.attr.needsUpdate = true;
  tube.geom.setDrawRange(0, 0);
}

// Show the tube up to arc length s; writes the tip into `head` (Vector3).
function growTube(tube, s, head) {
  const n = tube.n;
  if (n < 2) return;
  s = s < 0 ? 0 : s > tube.total ? tube.total : s;
  if (Math.abs(s - tube.s) < 1e-6) return;
  tube.s = s;
  const len = tube.len;
  let i = tube.seg;
  while (i < n - 2 && len[i + 1] < s) i++;
  while (i > 0 && len[i] > s) i--;
  tube.seg = i;
  const span = len[i + 1] - len[i];
  const f = span > 1e-9 ? (s - len[i]) / span : 1;
  const pos = tube.pos, src = tube.src, ring = i + 1, W = SIDES * 3;
  // Put back the ring that was the moving tip, then slide the new tip ring.
  if (tube.live >= 0 && tube.live !== ring) {
    const o = tube.live * W;
    for (let k = 0; k < W; k++) pos[o + k] = src[o + k];
  }
  const a = i * W, b = ring * W;
  for (let k = 0; k < W; k++) pos[b + k] = src[a + k] + (src[b + k] - src[a + k]) * f;
  tube.live = ring;
  tube.attr.needsUpdate = true;
  tube.geom.setDrawRange(0, s > 0 ? ring * SIDES * 6 : 0);
  const c = tube.ctr, ca = i * 3, cb = ring * 3;
  head.set(c[ca] + (c[cb] - c[ca]) * f, c[ca + 1] + (c[cb + 1] - c[ca + 1]) * f, c[ca + 2] + (c[cb + 2] - c[ca + 2]) * f);
}

// Arc length along the tube's centre line nearest to a z plane crossing.
function arcAtZ(tube, z) {
  const c = tube.ctr;
  for (let i = 1; i < tube.n; i++) {
    const za = c[(i - 1) * 3 + 2], zb = c[i * 3 + 2];
    if (za <= z && zb >= z) {
      const f = zb > za ? (z - za) / (zb - za) : 0;
      return tube.len[i - 1] + (tube.len[i] - tube.len[i - 1]) * f;
    }
  }
  return z < c[2] ? 0 : tube.total;
}

export class DRSView {
  constructor(scene, { speed = 1 } = {}) {
    this.scene = scene;
    this.speed = speed;              // playback rate of the whole sequence
    this.result = null;              // { kind, out, umpiresCall, reviewKept } once done
    this.phase = 'done';             // 'intro'|'tracking'|'pitching'|'impact'|'wickets'|'decision'|'done'
    this.group = new THREE.Group();
    this.group.name = 'DRS';
    this._built = false;
    this._kind = null;               // 'lbw' | 'run_out' | 'stumping' while shown
    this._active = false;
    this._done = false;
    this._t = 0;                     // sequence clock (scaled by speed)
    this._clock = 0;                 // wall clock for pulses
    this._events = [];
    this._ev = 0;
    this._cues = [];
    this._rows = [];
    this._shown = 0;
    this._decided = false;
    this._note = '';
    this._dots = -1;
    this._title = '';
    this._outcome = null;
    this._tProject = 0;
    this._pitchS = -1;
    this._markScale = 1;
    this._hasPitch = false;
    this._hasStumps = false;
    this._head = new THREE.Vector3();
    this._viewer = new THREE.Vector3(0, 1.6, 1);
    this._pts = [];                  // scratch polyline (rebuilt per review, not per frame)
    this._dirty = false;
    this._tipAtStumps = false;
    this._tipHidden = false;
  }

  get active() { return this._active; }
  get done() { return this._done; }
  // The board's mesh (to re-parent or tweak).
  get board() { this._build(); return this._panel.mesh; }

  // ------------------------------------------------------------------ build

  _build() {
    if (this._built) return;
    this._built = true;
    const g = this.group;
    const R = CONFIG.ball.radius;
    const half = PITCH.wicketHalfWidth, top = PITCH.stumpHeight + PITCH.bailRise;
    const flat = (geom) => geom.rotateX(-Math.PI / 2);
    const add = (mesh, order, name) => { mesh.name = name; mesh.renderOrder = order; mesh.visible = false; g.add(mesh); return mesh; };
    const ground = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 };

    // Board.
    this._panel = new Board({ width: 2.2, height: 1.45, ppm: 400, name: 'drs-board', bg: 'rgba(8,13,22,0.94)', interactive: false });
    this._panel.mesh.material.fog = false;
    this._panel.mesh.material.side = THREE.DoubleSide;
    g.add(this._panel.mesh);

    // Stump-to-stump corridor.
    this._corridor = add(new THREE.Mesh(flat(new THREE.PlaneGeometry(half * 2, PITCH.length)), basic(HEX.blue, 0.32, ground)), 1, 'drs-corridor');
    this._corridor.position.set(0, 0.012, (PITCH.battingStumpsZ + PITCH.bowlingStumpsZ) / 2);

    // Delivery (solid) and projection (pale, see-through) tubes.
    this._delivery = makeTube(MAX_DELIVERY, basic(0xff3b4e));
    this._projection = makeTube(MAX_PROJECTION, basic(0x8fd4ff, 0.62));
    add(this._delivery.mesh, 0, 'drs-delivery');
    add(this._projection.mesh, 6, 'drs-projection');

    // The ball at the tip, with a soft halo.
    this._ball = add(new THREE.Mesh(new THREE.SphereGeometry(R * 1.1, 16, 12), basic(0xff6a5c)), 0, 'drs-ball');
    this._haloTex = radialTexture(64, 'rgba(255,130,110,0.85)', 'rgba(255,130,110,0)');
    this._halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._haloTex, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false }));
    this._halo.scale.setScalar(0.34);
    this._ball.add(this._halo);

    // Pitching spot, impact ring.
    this._pitchMark = add(new THREE.Mesh(flat(new THREE.CircleGeometry(0.11, 28)), basic(HEX.white, 0.92, ground)), 3, 'drs-pitching');
    this._impactMark = add(new THREE.Mesh(new THREE.TorusGeometry(0.105, 0.016, 8, 32), basic(HEX.white, 0.95)), 7, 'drs-impact');

    // Wicket zone: the umpire's-call margin around the exact zone.
    this._zone = add(new THREE.Mesh(new THREE.BoxGeometry(half * 2 + R * 2, top + R, 0.05), basic(HEX.blue, 0.26)), 4, 'drs-zone');
    this._zone.position.set(0, (top + R) / 2, PITCH.battingStumpsZ);
    this._zoneInner = add(new THREE.Mesh(new THREE.BoxGeometry(half * 2, top, 0.062), basic(HEX.white, 0.2)), 5, 'drs-zone-inner');
    this._zoneInner.position.set(0, top / 2, PITCH.battingStumpsZ);
    this._zoneEdges = add(new THREE.LineSegments(new THREE.EdgesGeometry(this._zoneInner.geometry),
      new THREE.LineBasicMaterial({ color: HEX.white, transparent: true, opacity: 0.85, toneMapped: false, fog: false })), 5, 'drs-zone-edges');
    this._zoneEdges.position.copy(this._zoneInner.position);
    // Where the ball would have been in the plane of the stumps.
    this._stumpsBall = add(new THREE.Mesh(new THREE.SphereGeometry(R, 20, 14), basic(HEX.white)), 0, 'drs-stumps-ball');

    // Third umpire: the popping crease, the gap to the bat, the bat's line.
    this._crease = add(new THREE.Mesh(flat(new THREE.PlaneGeometry(PITCH.poppingHalfLength * 2, 0.07)), basic(0xfff27a, 0.95, ground)), 2, 'drs-crease');
    this._gap = add(new THREE.Mesh(flat(new THREE.PlaneGeometry(2.0, 1)), basic(HEX.green, 0.6, ground)), 2, 'drs-gap');
    this._batLine = add(new THREE.Mesh(flat(new THREE.PlaneGeometry(2.0, 0.03)), basic(HEX.white, 0.95, ground)), 3, 'drs-bat');

    this._lbwParts = [this._corridor, this._delivery.mesh, this._projection.mesh, this._ball, this._pitchMark,
      this._impactMark, this._zone, this._zoneInner, this._zoneEdges, this._stumpsBall];
    this._thirdParts = [this._crease, this._gap, this._batLine];
  }

  // ------------------------------------------------------------------ board

  // Put the board beside the pitch, a few metres from the viewer along it,
  // facing them. viewerPos: head (or feet) position. side: +1 off side (+X),
  // -1 leg side, 0 = automatic. Call again any time to re-place it.
  placeBoard(viewerPos, { distance = 5, side = 0, offsetX = 2.6, height = 2.7, scale = 1 } = {}) {
    this._build();
    if (viewerPos) this._viewer.copy(viewerPos);
    const v = this._viewer;
    const eyeY = v.y > 0.5 ? v.y : 1.6;
    const along = v.z > PITCH.centerZ ? -1 : 1;            // toward the middle of the pitch
    const sx = side || (v.x > 0.5 ? -1 : 1);
    const m = this._panel.mesh;
    m.position.set(sx * offsetX, height, v.z + along * distance);
    m.scale.setScalar(scale);
    m.lookAt(v.x, eyeY, v.z);
    return m;
  }

  // Explicit placement: position, a point to face, uniform scale.
  setBoardTransform(position, faceToward, scale = 1) {
    this._build();
    const m = this._panel.mesh;
    m.position.copy(position);
    m.scale.setScalar(scale);
    if (faceToward) m.lookAt(faceToward.x, faceToward.y, faceToward.z);
    return m;
  }

  _drawBoard() {
    const p = this._panel, W = p.W, H = p.H;
    const w = [];
    const rows = this._rows;
    const top = H * 0.16, bottom = H * 0.71;
    const pitch = (bottom - top) / Math.max(rows.length, 4), h = pitch - 8;
    const fs = Math.round(Math.min(h * 0.5, H * 0.062));
    const pillX = W * 0.44, pillW = W * 0.56 - 30;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], y = top + i * pitch, shown = i < this._shown;
      w.push({ type: 'bar', x: 24, y, w: W - 48, h, color: 'rgba(255,255,255,0.07)' });
      w.push({ type: 'label', text: r.label, x: 44, y: y + h / 2 + 1, size: fs, bold: true, color: shown ? '#e8eef5' : 'rgba(232,238,245,0.32)' });
      if (shown) {
        w.push({ type: 'bar', x: pillX, y: y + 5, w: pillW, h: h - 10, color: CSS[r.colour] || CSS.white, radius: 10 });
        w.push({ type: 'label', text: r.text, x: pillX + pillW / 2, y: y + h / 2 + 1, size: fs, bold: true, align: 'center', color: '#0a0f16' });
      }
    }
    const dy = H * 0.735, dh = H * 0.235;
    if (this._decided) {
      const o = this._outcome;
      w.push({ type: 'bar', x: 24, y: dy, w: W - 48, h: dh, color: o.out ? '#d7263d' : '#17a655', radius: 18 });
      w.push({ type: 'label', text: o.out ? 'OUT' : 'NOT OUT', x: W / 2, y: dy + dh * (o.sub ? 0.4 : 0.52), size: Math.round(dh * 0.56), bold: true, align: 'center', color: '#ffffff' });
      if (o.sub) w.push({ type: 'label', text: o.sub, x: W / 2, y: dy + dh * 0.82, size: Math.round(dh * 0.19), bold: true, align: 'center', color: o.umpiresCall ? '#ffe9a8' : '#ffffff' });
    } else if (this._note) {
      const dots = this._dots >= 0 ? '.'.repeat(this._dots + 1) : '';
      w.push({ type: 'label', text: this._note + dots, x: W / 2, y: dy + dh * 0.5, size: Math.round(dh * 0.3), bold: true, align: 'center', color: 'rgba(255,211,77,0.9)' });
    }
    p.set(w, this._title);
  }

  // ------------------------------------------------------------------ start

  _begin(kind, viewerPos) {
    this._build();
    this.hide();
    this._kind = kind;
    this._active = true;
    this._done = false;
    this.result = null;
    this.phase = 'intro';
    this._t = 0; this._clock = 0; this._ev = 0;
    this._events.length = 0;
    this._cues.length = 0;
    this._shown = 0;
    this._decided = false;
    this._note = '';
    this._dots = -1;
    this.placeBoard(viewerPos);
    this._cues.push('stinger');
    this.scene.add(this.group);
    this.group.visible = true;
  }

  _at(t, type, arg) { this._events.push({ t, type, arg }); }

  // track: trackLbw()'s result. deliveryPath: the real flight, release ->
  // impact, [{x,y,z}]. outcome: reviewOutcome()'s result.
  startLbw({ track, deliveryPath = null, onFieldOut = false, outcome = null, viewerPos = null } = {}) {
    this._begin('lbw', viewerPos);
    const R = CONFIG.ball.radius;
    const verdicts = (outcome && outcome.rows) || verdictRows(track);
    const out = outcome ? !!outcome.out : false;
    const umpiresCall = outcome ? !!outcome.umpiresCall : false;
    const reviewKept = outcome ? !!outcome.reviewKept : true;
    const stands = out === !!onFieldOut;
    this._outcome = {
      kind: 'lbw', out, umpiresCall, reviewKept,
      sub: `${umpiresCall ? "UMPIRE'S CALL" : stands ? 'DECISION STANDS' : 'DECISION OVERTURNED'}  ·  ${reviewKept ? 'REVIEW RETAINED' : 'REVIEW LOST'}`,
    };
    this._title = 'DECISION REVIEW';
    this._rows = [{ label: 'ON-FIELD CALL', text: onFieldOut ? 'OUT' : 'NOT OUT', colour: 'white' }, ...verdicts];

    // --- geometry
    const impact = track.impactPos;
    const pts = this._pts;
    pts.length = 0;
    const src = deliveryPath || [];
    let last = -1;
    for (let i = 0; i < src.length; i++) if (src[i].z < impact.z - 0.02) last = i;
    if (last >= 1) {
      const n = Math.min(last + 1, MAX_DELIVERY - 2);     // room for the pitching point and the impact
      for (let k = 0; k < n; k++) pts.push(src[n > 1 ? Math.round(k * last / (n - 1)) : 0]);
    } else {
      // No recorded flight: the machine's release point, straight to the pitch.
      const m = CONFIG.machine;
      pts.push({ x: m.releaseX, y: m.releaseHeight, z: m.releaseZ });
    }
    // The exact pitching point, so the kink touches the ground.
    this._hasPitch = !!track.pitchPos;
    if (this._hasPitch) {
      const pp = { x: track.pitchPos.x, y: R, z: track.pitchPos.z };
      let near = -1, best = 0.35;
      for (let i = 1; i < pts.length; i++) {
        const d = Math.abs(pts[i].z - pp.z);
        if (d < best) { best = d; near = i; }
      }
      if (near >= 0) pts[near] = pp;
      else {
        let at = pts.length;
        for (let i = 0; i < pts.length; i++) if (pts[i].z > pp.z) { at = i; break; }
        if (at > 0) pts.splice(at, 0, pp);
      }
    }
    pts.push(impact);
    fillTube(this._delivery, pts, pts.length, R);
    this._pitchS = this._hasPitch ? arcAtZ(this._delivery, track.pitchPos.z) : -1;

    // Projection: impact -> stumps (drawn on past them when it is missing).
    pts.length = 0;
    const path = track.path || [];
    const pn = Math.min(path.length, MAX_PROJECTION - 1);
    for (let k = 0; k < pn; k++) pts.push(path[pn > 1 ? Math.round(k * (path.length - 1) / (pn - 1)) : 0]);
    if (pts.length < 2) { pts.length = 0; pts.push(impact, { x: impact.x, y: impact.y, z: PITCH.battingStumpsZ }); }
    this._hasStumps = track.projectionValid !== false && Number.isFinite(track.stumpsPos.x) && Number.isFinite(track.stumpsPos.y);
    if (track.wickets === 'missing' && this._hasStumps) {
      const a = pts[pts.length - 2], b = pts[pts.length - 1];
      const l = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      if (l > 1e-4 && b.z > a.z) {
        const k = PAST_STUMPS / l;
        pts.push({ x: b.x + (b.x - a.x) * k, y: Math.max(R, b.y + (b.y - a.y) * k), z: b.z + (b.z - a.z) * k });
      }
    }
    fillTube(this._projection, pts, pts.length, R);
    pts.length = 0;
    this._tipAtStumps = track.wickets !== 'missing';
    this._tipHidden = false;

    // --- marks
    const dist = Math.hypot(this._viewer.x - impact.x, this._viewer.z - impact.z);
    this._markScale = Math.min(2.4, Math.max(1, dist / 8));
    for (const part of this._lbwParts) part.visible = false;
    this._corridor.visible = true;
    this._corridor.material.opacity = 0;
    this._zone.visible = this._zoneInner.visible = this._zoneEdges.visible = true;
    this._zone.material.color.setHex(HEX.blue);
    this._delivery.mesh.visible = this._projection.mesh.visible = true;
    if (this._hasPitch) this._pitchMark.position.set(track.pitchPos.x, 0.02, track.pitchPos.z);
    this._pitchMark.material.color.setHex(HEX.white);
    this._impactMark.position.set(impact.x, impact.y, impact.z);
    this._impactMark.material.color.setHex(HEX.white);
    if (this._hasStumps) this._stumpsBall.position.set(track.stumpsPos.x, track.stumpsPos.y, PITCH.battingStumpsZ);
    this._ball.position.set(this._delivery.ctr[0], this._delivery.ctr[1], this._delivery.ctr[2]);

    // --- timeline
    const T = LBW_T;
    const tPitching = T.track + T.toImpact;
    const tImpact = tPitching + T.hold;
    const tWickets = tImpact + T.hold;
    const tWicketsRow = tWickets + T.project + T.wicketsRow;
    const tDecision = tWicketsRow + T.decideAfter;
    this._tProject = tWickets;
    this._at(T.track, 'phase', 'tracking');
    this._at(tPitching, 'phase', 'pitching');
    this._at(tImpact, 'phase', 'impact');
    this._at(tWickets, 'phase', 'wickets');
    for (let i = 0; i < this._rows.length; i++) {
      const label = this._rows[i].label;
      const t = i === 0 ? T.onField
        : label === 'PITCHING' ? tPitching + T.rowAfter
        : label === 'IMPACT' ? tImpact + T.rowAfter
        : label === 'WICKETS' ? tWicketsRow
        : T.extras;
      this._at(t, 'row', i);
    }
    this._at(tDecision, 'decision', null);
    this._at(tDecision + T.showDecision, 'done', null);
    this._events.sort((a, b) => a.t - b.t);
    this._drawBoard();
  }

  // kind: 'run_out' | 'stumping'. end: 'batting' | 'bowling'. margin (m): how
  // far the bat / foot was SHORT of the popping crease when the wicket was
  // broken: > 0 short (OUT), 0 on the line (OUT: the line belongs to the
  // umpire), < 0 grounded behind it (NOT OUT). `out` overrides that.
  startThird({ kind = 'run_out', end = 'batting', margin = 0, viewerPos = null, out = null, by = null } = {}) {
    kind = kind === 'stumping' ? 'stumping' : 'run_out';
    this._begin(kind, viewerPos);
    const isOut = out == null ? margin > -1e-6 : !!out;
    this._outcome = { kind, out: isOut, umpiresCall: false, reviewKept: true, sub: '' };
    this._title = `THIRD UMPIRE — ${kind === 'run_out' ? 'RUN OUT' : 'STUMPING'}`;
    const cm = Math.max(1, Math.round(Math.abs(margin) * 100));
    const grounding = Math.abs(margin) <= 1e-6 ? 'ON THE LINE' : margin > 0 ? `SHORT BY ${cm} cm` : `IN BY ${cm} cm`;
    this._rows = [
      { label: 'CHECKING', text: end === 'bowling' ? "BOWLER'S END" : "STRIKER'S END", colour: 'white' },
      { label: 'GROUNDING', text: grounding, colour: isOut ? 'red' : 'green' },
    ];
    // what the margin was measured to (by: 'bat' | 'foot', the one that counted)
    if (by === 'bat' || by === 'foot') this._rows.push({ label: 'JUDGED ON', text: by === 'bat' ? 'THE BAT' : 'BACK FOOT', colour: 'white' });

    const batting = end !== 'bowling';
    const creaseZ = batting ? battingPoppingZ : bowlingPoppingZ;
    const toGround = batting ? 1 : -1;                 // +Z is home at the batting end
    const batZ = creaseZ - toGround * margin;
    for (const part of this._thirdParts) part.visible = false;
    this._crease.position.set(0, 0.014, creaseZ);
    this._crease.visible = true;
    const gap = Math.max(Math.abs(margin), 0.012);
    this._gap.scale.set(1, 1, gap);
    this._gap.position.set(0, 0.016, (creaseZ + batZ) / 2);
    this._gap.material.color.setHex(isOut ? HEX.red : HEX.green);
    this._batLine.position.set(0, 0.018, batZ);
    this._markScale = 1;

    const T = THIRD_T;
    this._at(0.3, 'row', 0);
    this._at(T.check, 'phase', 'tracking');
    this._at(T.freeze, 'row', 1);
    if (this._rows.length > 2) this._at(T.freeze + 0.3, 'row', 2);
    this._at(T.decide, 'decision', null);
    this._at(T.end, 'done', null);
    this._drawBoard();
  }

  // ------------------------------------------------------------------ run

  _fire(e) {
    if (e.type === 'phase') {
      this.phase = e.arg;
      if (this._kind === 'lbw') { if (e.arg === 'tracking') this._note = 'BALL TRACKING'; }
      else if (e.arg === 'tracking') { this._note = 'CHECKING'; this._dots = 0; }
    } else if (e.type === 'row') {
      this._shown = Math.max(this._shown, e.arg + 1);
      const row = this._rows[e.arg];
      if (row.colour !== 'white') this._cues.push(`chime:${row.colour}`);
      const hex = HEX[row.colour] ?? HEX.white;
      if (this._kind === 'lbw') {
        if (row.label === 'PITCHING') this._pitchMark.material.color.setHex(hex);
        else if (row.label === 'IMPACT') this._impactMark.material.color.setHex(hex);
        else if (row.label === 'WICKETS') {
          this._zone.material.color.setHex(hex);
          this._stumpsBall.material.color.setHex(hex);
          this._stumpsBall.visible = this._hasStumps;
          // The tip has arrived there: the verdict-coloured ball replaces it
          // (a missing one has flown on past the stumps and stays).
          if (this._hasStumps && this._tipAtStumps) this._tipHidden = true;
        }
      } else if (row.label === 'GROUNDING') {
        this._gap.visible = true;
        this._batLine.visible = true;
      }
    } else if (e.type === 'decision') {
      this.phase = 'decision';
      this._decided = true;
      this._dots = -1;
      this._cues.push(this._outcome.out ? 'out' : 'not_out');
    } else if (e.type === 'done') {
      this.phase = 'done';
      this._active = false;
      this._done = true;
      const o = this._outcome;
      this.result = { kind: o.kind, out: o.out, umpiresCall: o.umpiresCall, reviewKept: o.reviewKept };
    }
    this._dirty = true;
  }

  update(dt) {
    if (!this._kind) return;
    this._clock += dt;
    if (this._active) {
      this._t += dt * this.speed;
      const ev = this._events;
      this._dirty = false;
      while (this._ev < ev.length && this._t >= ev[this._ev].t) this._fire(ev[this._ev++]);
      // "CHECKING..." ticks (a board redraw only when the dot count changes).
      if (this._dots >= 0) {
        const d = Math.floor(this._clock * 2.5) % 3;
        if (d !== this._dots) { this._dots = d; this._dirty = true; }
      }
      if (this._dirty) this._drawBoard();
    }
    if (this._kind === 'lbw') this._animateLbw();
    else this._animateThird();
    this._panel.update();
  }

  _animateLbw() {
    const T = LBW_T, t = this._t;
    const pulse = 1 + 0.08 * Math.sin(this._clock * 9);
    this._corridor.material.opacity = 0.32 * clamp01(t / 0.8);

    // The delivery, eased so it settles into the pad.
    const u = clamp01((t - T.track) / T.toImpact);
    const d = this._delivery;
    const s = d.total * u * (1.15 - 0.15 * u);
    const u2 = clamp01((t - this._tProject) / T.project);
    const p = this._projection;
    growTube(d, s, this._head);
    if (u2 > 0) growTube(p, p.total * u2 * (2 - u2), this._head);
    this._ball.visible = t >= T.track && !this._tipHidden;
    if (this._ball.visible && (u2 > 0 || u > 0)) this._ball.position.copy(this._head);

    const k = this._markScale * pulse;
    this._pitchMark.visible = this._hasPitch && t >= T.track && s >= this._pitchS;
    if (this._pitchMark.visible) this._pitchMark.scale.set(k, 1, k);
    this._impactMark.visible = u >= 1;
    if (this._impactMark.visible) this._impactMark.scale.setScalar(k);
    this._zone.material.opacity = 0.26 + 0.06 * Math.sin(this._clock * 5);
  }

  _animateThird() {
    this._crease.material.opacity = 0.7 + 0.28 * Math.sin(this._clock * 8);
    if (this._gap.visible) this._gap.material.opacity = 0.55 + 0.15 * Math.sin(this._clock * 8);
  }

  // Jump straight to the result (a person skips the replay).
  skip() {
    if (!this._active) return;
    const ev = this._events;
    while (this._ev < ev.length) this._fire(ev[this._ev++]);
    // Only the result is announced: no backlog of chimes.
    this._cues = this._cues.filter((c) => !c.startsWith('chime:'));
    this._t = ev.length ? ev[ev.length - 1].t : 0;
    this._drawBoard();
    this.update(0);
  }

  // Cues since the last call: 'stinger', 'chime:green|red|amber', 'out', 'not_out'.
  takeCues() {
    if (this._cues.length === 0) return EMPTY;
    const out = this._cues;
    this._cues = [];
    return out;
  }

  // Take everything out of the scene. `result` stays readable; `done` and
  // `active` go false.
  hide() {
    this._active = false;
    this._done = false;
    this._kind = null;
    this.phase = 'done';
    this.group.visible = false;
    if (this.group.parent) this.group.parent.remove(this.group);
    if (this._built) {
      for (const part of this._lbwParts) part.visible = false;
      for (const part of this._thirdParts) part.visible = false;
    }
  }

  dispose() {
    this.hide();
    if (!this._built) return;
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this._panel.tex.dispose();
    this._haloTex.dispose();
    this.group.clear();
    this._built = false;
  }
}
