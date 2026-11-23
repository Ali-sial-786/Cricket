// Gameplay objects: bat, ball (+ blob shadow + trail), stumps (breakable),
// bowling machine with release-cue lights, pitch markers.
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { hypot3 } from '../physics/math.js';
import { PITCH, STUMP_X } from '../physics/pitch.js';
import { vertexColorMat, toV3 } from './util.js';
import { buildBatMesh, addBatMark } from './batModel.js';
import { ballGeometry, ballMaterial } from './ballModel.js';
import { stumpGeometry, bailGeometry, socketMesh, wicketTextures, BAIL_LEN, BAIL_R } from './wicketModel.js';
import { machineGeometry } from './machineModel.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ballShadowMesh, placeBallShadow } from './shadows.js';

// ---------------------------------------------------------------- Bat
// The bat (yours and the AI striker's) is built in batModel.js: the physics
// shape exactly, an English-willow profile, one mesh, one texture.
export { buildBatMesh, addBatMark };

// ---------------------------------------------------------------- Ball
// kind: 'white' (the game's limited-overs ball) or 'red'. The seam lies in the
// mesh's XZ plane (ballModel.js).
export class BallView {
  constructor(scene, kind = 'white') {
    const r = CONFIG.ball.radius;
    this.mesh = new THREE.Mesh(ballGeometry(r), ballMaterial(kind));
    this.mesh.name = 'ball';
    scene.add(this.mesh);

    // Its sun shadow (render/shadows.js): down the sun's rays, so it leaves the ball as it climbs.
    this.shadow = ballShadowMesh();
    scene.add(this.shadow);

    // Trail for hit balls: a thin line along the flight from the bat (BallTrail).
    this.trail = new BallTrail(scene);
    this.trailEnabled = true;
    this.spinAngle = 0;
    this.visible = true;
    this.fade = 1;
  }

  setVisible(v) {
    this.visible = v;
    this.mesh.visible = v && this.fade > 0.02;
    this.shadow.visible = v;
    if (!v) this.trail.clear();
  }

  // Opacity 0..1 (the ball in your hand fades out as it nears your eyes). 1 = the usual solid ball.
  setFade(a) {
    a = a > 1 ? 1 : a < 0 ? 0 : a;
    if (a === this.fade) return;
    this.fade = a;
    const m = this.mesh.material, see = a < 1;
    // (Still writes depth, and is drawn after the floating panels: a ball in
    // front of a panel is never painted over by it.)
    if (m.transparent !== see) { m.transparent = see; m.needsUpdate = true; this.mesh.renderOrder = see ? 12 : 0; }
    m.opacity = a;
    this.mesh.visible = this.visible && a > 0.02;
  }

  // pos: physics Vec3 (or three Vector3); spin: rad/s vector for visual rotation.
  update(pos, dt, spin = null, showTrail = false) {
    toV3(this.mesh.position, pos);
    if (spin && dt > 0) {
      const w = hypot3(spin.x, spin.y, spin.z);
      if (w > 1e-3) {
        _axis.set(spin.x / w, spin.y / w, spin.z / w);
        _q.setFromAxisAngle(_axis, w * dt);
        this.mesh.quaternion.premultiply(_q);
      }
    }
    this.placeShadow(pos);

    if (showTrail && this.trailEnabled) this.trail.add(pos);
  }
  placeShadow(pos) { placeBallShadow(this.shadow, pos, CONFIG.ball.radius); }
  clearTrail() { this.trail.clear(); }
  // 0 new .. 1 very old: the rough half's scuffing and loss of shine.
  setWear(k) { this.mesh.material.userData.wear.value = Math.max(0, Math.min(1, k)); }
  get trailOn() { return this.trail.count > 0; }
  // Each frame, after the ball has moved: the line turned to face your eyes (dt: game time, 0 paused).
  faceTrail(eye, dt) { this.trail.face(eye, dt); }
}

// The hit ball's path, drawn as a thin line you can follow, never a ribbon in your face: a few
// pixels wide at any distance (its width is an angle, clamped both ways), a bright comet head over
// the last ~0.25 s of flight and a faint thin line for the path before it. It comes in over the
// first metres from the bat and is gone within a few metres of your eyes; a ball along the ground
// leaves only a short-lived line; a couple of seconds after the ball stops moving it fades away.
// It is turned to face you every frame. The finder's arrow, halo and landing ring
// (render/ballFinder.js) still point to the ball itself.
const PX = 0.0009;                         // one headset pixel, in radians (~19 px a degree)
export class BallTrail {
  constructor(scene, { max = 480, step = 0.25, head = 0.25, color = 0xfffbec, tail = 0xffe48f } = {}) {
    this.max = max; this.step = this.baseStep = step; this.head = head;
    this.pts = new Float32Array(max * 3);
    this.len = new Float32Array(max);      // path length from the bat to each point
    this.tim = new Float32Array(max);      // when the ball was there (the trail's own clock)
    this.count = 0; this.t = 0; this.still = 0; this.fade = 1;
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(max * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.col = new THREE.BufferAttribute(new Float32Array(max * 2 * 4), 4).setUsage(THREE.DynamicDrawUsage);
    const uv = new Float32Array(max * 2 * 2);
    for (let i = 0; i < max; i++) { uv[i * 4 + 1] = 0; uv[i * 4 + 3] = 1; }
    const idx = [];
    for (let i = 0; i < max - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    geo.setAttribute('position', this.pos); geo.setAttribute('color', this.col); geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx); geo.setDrawRange(0, 0);
    this.geo = geo;
    const c = new THREE.Color(color), d = new THREE.Color(tail);
    this.rgb = [c.r, c.g, c.b]; this.rgbTail = [d.r, d.g, d.b];
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: edgeTexture(), vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    this.mesh.name = 'ballTrail';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  get visible() { return this.mesh.visible; }
  set visible(v) { this.mesh.visible = v; }

  clear() { this.count = 0; this.step = this.baseStep; this.still = 0; this.fade = 1; this.mesh.visible = false; this.geo.setDrawRange(0, 0); }

  // The ball is at p: a new point every `step` m (the newest always follows the ball).
  add(p) {
    const P = this.pts, L = this.len, T = this.tim;
    let n = this.count;
    const y = Math.max(p.y, 0.03);
    if (n >= 1) {
      const j = (n - 1) * 3, moved = hypot3(p.x - P[j], y - P[j + 1], p.z - P[j + 2]);
      if (moved > 0.004) { this.still = 0; this.fade = 1; }          // (still moving: not dead yet)
    }
    if (n >= 2) {
      const i = (n - 2) * 3, d = hypot3(p.x - P[i], y - P[i + 1], p.z - P[i + 2]);
      if (d < this.step) { const j = (n - 1) * 3; P[j] = p.x; P[j + 1] = y; P[j + 2] = p.z; L[n - 1] = L[n - 2] + d; T[n - 1] = this.t; return; }
    }
    if (n >= this.max) {                       // full: keep every other point (the shape stays; the spacing doubles)
      let w = 0;
      for (let r = 0; r < n; r += 2) { P[w * 3] = P[r * 3]; P[w * 3 + 1] = P[r * 3 + 1]; P[w * 3 + 2] = P[r * 3 + 2]; L[w] = L[r]; T[w] = T[r]; w++; }
      n = w; this.step *= 2;
    }
    const j = (n - 1) * 3;
    L[n] = n ? L[n - 1] + hypot3(p.x - P[j], y - P[j + 1], p.z - P[j + 2]) : 0;
    P[n * 3] = p.x; P[n * 3 + 1] = y; P[n * 3 + 2] = p.z; T[n] = this.t;
    this.count = n + 1;
    this.mesh.visible = this.count >= 2 && this.fade > 0;
  }

  // Each frame (dt: the trail's clock, 0 while paused). Two vertices a point, across the path as you see it.
  face(eye, dt = 0) {
    const n = this.count;
    if (n < 2) return;
    this.t += dt; this.still += dt;
    // dead a moment (nothing moved): hold ~1.6 s, then fade out over ~0.9 s
    if (this.still > 1.6) { this.fade = Math.max(0, 1 - (this.still - 1.6) / 0.9); if (this.fade <= 0) { this.mesh.visible = false; return; } }
    if (!this.mesh.visible) return;
    const P = this.pts, L = this.len, T = this.tim, V = this.pos.array, C = this.col.array;
    // (indexed, not destructured: no iterators made every frame below the top tier)
    const RGB = this.rgb, TAIL = this.rgbTail, r1 = RGB[0], g1 = RGB[1], b1 = RGB[2], r0 = TAIL[0], g0 = TAIL[1], b0 = TAIL[2], now = this.t, H = this.head, F = this.fade;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1) * 3, c = Math.min(n - 1, i + 1) * 3, o = i * 3;
      const tx = P[c] - P[a], ty = P[c + 1] - P[a + 1], tz = P[c + 2] - P[a + 2];
      const ex = eye.x - P[o], ey = eye.y - P[o + 1], ez = eye.z - P[o + 2];
      let sx = ty * ez - tz * ey, sy = tz * ex - tx * ez, sz = tx * ey - ty * ex;
      const sl = hypot3(sx, sy, sz) || 1, dist = hypot3(ex, ey, ez);
      // the head: 1 at the ball, 0 by `head` seconds back along the path
      const age = now - T[i], h = age < H ? 1 - age / H : 0, hh = h * h;
      // width as an angle: ~5 px at the head down to ~2 px for the old path (a ball-width line far away, never more)
      const ang = Math.min((2.2 + 2.8 * hh) * PX, Math.max(2 * PX, 0.07 / Math.max(dist, 1)));
      const k = 0.5 * dist * ang / sl;
      sx *= k; sy *= k; sz *= k;
      V[i * 6] = P[o] - sx; V[i * 6 + 1] = P[o + 1] - sy; V[i * 6 + 2] = P[o + 2] - sz;
      V[i * 6 + 3] = P[o] + sx; V[i * 6 + 4] = P[o + 1] + sy; V[i * 6 + 5] = P[o + 2] + sz;
      // faint old path, bright head; in over the first 2-5 m from the bat, out within ~4 m of your eyes;
      // along the ground (a ball rolling or skidding) only a second's line
      let al = 0.5 + 0.5 * hh;                                      // (warm yellow-white: reads on blue sky, the stands and the green)
      al *= sstep(1.5, 5, L[i]) * sstep(2, 4.5, dist);
      if (P[o + 1] < 0.12) al *= 1 - sstep(0.5, 1.3, age);
      al *= F;
      if (i === n - 1) al *= 0.7;                                   // (soft where the ball is)
      C[i * 8] = C[i * 8 + 4] = r0 + (r1 - r0) * h; C[i * 8 + 1] = C[i * 8 + 5] = g0 + (g1 - g0) * h; C[i * 8 + 2] = C[i * 8 + 6] = b0 + (b1 - b0) * h;
      C[i * 8 + 3] = C[i * 8 + 7] = al;
    }
    this.pos.needsUpdate = true; this.col.needsUpdate = true;
    this.pos.addUpdateRange?.(0, n * 6); this.col.addUpdateRange?.(0, n * 8);
    this.geo.setDrawRange(0, (n - 1) * 6);
  }
}
const sstep = (a, b, x) => { const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a); return t * t * (3 - 2 * t); };

// Across the ribbon: solid in the middle, soft at the edges.
let _edgeTex = null;
function edgeTexture() {
  if (_edgeTex) return _edgeTex;
  const c = document.createElement('canvas'); c.width = 4; c.height = 64;
  const x = c.getContext('2d'), gr = x.createLinearGradient(0, 0, 0, 64);
  gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.3, 'rgba(255,255,255,0.85)'); gr.addColorStop(0.5, 'rgba(255,255,255,1)');
  gr.addColorStop(0.7, 'rgba(255,255,255,0.85)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 4, 64);
  _edgeTex = new THREE.CanvasTexture(c);
  return _edgeTex;
}

const _axis = new THREE.Vector3(), _q = new THREE.Quaternion();

// ---------------------------------------------------------------- Stumps
// Three stumps and two bails (wicketModel.js), each its own mesh: replays move
// them by reference (`pieces[i].mesh`). Broken: the bails fly spinning about
// their length and tumbling, bounce and come to rest lying flat; the stump hit
// goes back on a damped spring (or cartwheels out of the ground when hit
// hard), the others are jolted and wobble; the LED tops, base and bails flash.
const _qa = new THREE.Quaternion(), _va = new THREE.Vector3(), _vb = new THREE.Vector3(), _ax = new THREE.Vector3();
const FLASH_SEC = 3.2;
export class StumpsView {
  constructor(parent, z) {
    this.group = new THREE.Group();
    this.group.position.z = z;
    parent.add(this.group);
    const T = wicketTextures();
    // (each end its own material: its LEDs flash on their own)
    this.mat = new THREE.MeshLambertMaterial({ map: T.map, emissiveMap: T.led, emissive: 0x000000 });
    this.pieces = [];
    const h = PITCH.stumpHeight, r = PITCH.stumpRadius, flip = z < -10;
    STUMP_X.forEach((x, i) => {
      const m = new THREE.Mesh(stumpGeometry(i === 1, flip), this.mat);
      m.position.set(x, 0, 0);
      m.name = 'stump';
      this.group.add(m);
      this.pieces.push({ mesh: m, home: m.position.clone(), vel: new THREE.Vector3(), ang: new THREE.Vector3(), kind: 'stump',
        c: new THREE.Vector3(), half: new THREE.Vector3(0, h / 2, 0), ends: [new THREE.Vector3(0, -0.06, 0), new THREE.Vector3(0, h, 0)], rad: r, axis: new THREE.Vector3(0, 1, 0) });
    });
    for (const x of [(STUMP_X[0] + STUMP_X[1]) / 2, (STUMP_X[1] + STUMP_X[2]) / 2]) {
      const m = new THREE.Mesh(bailGeometry(), this.mat);
      m.position.set(x, h + 0.006, 0);
      m.name = 'bail';
      this.group.add(m);
      this.pieces.push({ mesh: m, home: m.position.clone(), vel: new THREE.Vector3(), ang: new THREE.Vector3(), kind: 'bail',
        c: new THREE.Vector3(), half: new THREE.Vector3(), ends: [new THREE.Vector3(-BAIL_LEN / 2, 0, 0), new THREE.Vector3(BAIL_LEN / 2, 0, 0)], rad: BAIL_R * 0.7, axis: new THREE.Vector3(1, 0, 0) });
    }
    this.group.add(socketMesh(STUMP_X));
    this.broken = false;
    this.flash = 0;
    this.t = 0;
  }

  break(ballVel, stumpIndex = 1) {
    if (this.broken) return;
    this.broken = true;
    this.flash = FLASH_SEC;
    const sp = Math.min(40, hypot3(ballVel.x, ballVel.y, ballVel.z));
    const dirZ = Math.sign(ballVel.z) || 1;
    const R = Math.random;
    for (let i = 0; i < this.pieces.length; i++) {
      const p = this.pieces[i];
      p.c.copy(p.home).add(p.half);
      p.rest = false;
      if (p.kind === 'bail') {
        // the bail over the stump that was hit goes highest; both fly away from the ball's side
        const near = (i === 3 && stumpIndex <= 1) || (i === 4 && stumpIndex >= 1);
        const side = i === 3 ? -1 : 1;
        p.vel.set(side * (0.3 + R() * 0.9) + (R() - 0.5) * 0.6, (near ? 1.6 : 1.0) + R() * 1.2 + sp * 0.1, dirZ * (0.6 + sp * 0.16 + R() * 0.6));
        p.ang.set((R() < 0.5 ? -1 : 1) * (14 + R() * 10 + sp * 0.5), (R() - 0.5) * (6 + sp * 0.3), (R() - 0.5) * (6 + sp * 0.3));
        p.flying = true;
      } else {
        const hit = i === stumpIndex;
        if (hit && sp > 25) {                              // out of the ground, cartwheeling back
          p.vel.set((R() - 0.5) * 1.6, 1.2 + R() * 1.2, dirZ * sp * 0.12);
          p.ang.set(dirZ * (9 + R() * 6), (R() - 0.5) * 4, (R() - 0.5) * 6);
          p.flying = true;
        } else {
          // lean back on a spring: the hit stump a long way (it stays there), the others jolted
          const toward = hit ? 1 : 0.25 + 0.15 * R();
          p.tilt = { axis: new THREE.Vector3(dirZ, 0, (R() - 0.5) * (hit ? 0.5 : 0.8)).normalize(), angle: 0,
            w: (hit ? 3 + sp * 0.2 : 1.2 + sp * 0.06) * toward, target: hit ? Math.min(1.1, 0.35 + sp * 0.025) : 0.02 + 0.06 * R(), k: hit ? 45 : 160, c: hit ? 12 : 6 };
        }
      }
    }
  }

  update(dt) {
    if (!this.broken) return;
    this.t += dt;
    // LEDs: a red strobe that fades out
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt);
      const on = Math.sin(this.t * Math.PI * 2 * 4.5) > -0.2 ? 1 : 0.18;
      const k = on * Math.min(1, this.flash / 0.6);
      this.mat.emissive.setRGB(1.0 * k, 0.1 * k, 0.06 * k);
    }
    for (const p of this.pieces) {
      const m = p.mesh;
      if (p.flying) {
        p.vel.y -= 9.81 * dt;
        p.c.addScaledVector(p.vel, dt);
        const w = p.ang.length();
        if (w > 1e-4) { _qa.setFromAxisAngle(_ax.copy(p.ang).divideScalar(w), w * dt); m.quaternion.premultiply(_qa); }
        const low = this.lowest(p);
        if (low < p.rad) {
          p.c.y += p.rad - low;
          if (p.vel.y < 0) {
            p.vel.y = -p.vel.y * (p.kind === 'bail' ? 0.38 : 0.25);
            p.vel.x *= 0.55; p.vel.z *= 0.55;
            p.ang.multiplyScalar(0.5);
            if (p.kind === 'bail') p.ang.x += (Math.random() - 0.5) * 6;
          }
          if (p.vel.lengthSq() < 0.12 && p.vel.y < 0.5) { p.flying = false; p.rest = true; p.vel.set(0, 0, 0); }
        }
      } else if (p.rest) {
        // settle lying flat: turn the long axis level, then sit on the turf
        _va.copy(p.axis).applyQuaternion(m.quaternion);
        _vb.set(_va.x, 0, _va.z);
        if (_vb.lengthSq() < 1e-6) _vb.set(0, 0, 1);
        _vb.normalize();
        _qa.setFromUnitVectors(_va, _vb);
        if (Math.abs(_va.y) > 1e-3) { _qa.slerp(_qId, 1 - Math.min(1, dt * 7)); m.quaternion.premultiply(_qa); }
        else p.rest = false;
        p.c.y += p.rad - this.lowest(p);
      } else if (p.tilt) {
        const T = p.tilt;
        T.w += (T.k * (T.target - T.angle) - T.c * T.w) * dt;
        T.angle = Math.min(1.45, Math.max(-0.3, T.angle + T.w * dt));
        m.quaternion.setFromAxisAngle(T.axis, T.angle);
        continue;
      } else continue;
      // the mesh's origin from its centre
      m.position.copy(p.half).applyQuaternion(m.quaternion).multiplyScalar(-1).add(p.c);
    }
  }

  // The lowest point of a piece (its two ends), in the group's frame.
  lowest(p) {
    let low = Infinity;
    for (const e of p.ends) { _va.copy(e).sub(p.half).applyQuaternion(p.mesh.quaternion); low = Math.min(low, _va.y + p.c.y); }
    return low;
  }

  reset() {
    this.broken = false;
    this.flash = 0;
    this.mat.emissive.setRGB(0, 0, 0);
    for (const p of this.pieces) {
      p.mesh.position.copy(p.home);
      p.mesh.quaternion.identity();
      p.vel.set(0, 0, 0); p.ang.set(0, 0, 0);
      p.flying = false; p.tilt = null; p.rest = false;
    }
  }
}
const _qId = new THREE.Quaternion();

// ---------------------------------------------------------------- Machine
// A two-wheel bowling machine on a tripod (machineModel.js), positioned so the
// gap between its wheels is at the release point, with three cue lights on a
// hooded board above it (red -> amber -> green = release).
export class MachineView {
  constructor(parent) {
    this.group = new THREE.Group();
    parent.add(this.group);
    const outletY = CONFIG.machine.releaseHeight;
    this.group.add(new THREE.Mesh(machineGeometry(outletY), vertexColorMat()));
    // Cue lights on a mast above the machine (visible against the sightscreen).
    this.lights = [];
    const colors = [0xff2a1a, 0xffb000, 0x22ff55];
    const by = outletY + 0.9;
    const board = new THREE.Mesh(boardGeometry(), new THREE.MeshLambertMaterial({ color: 0x15171b }));
    board.position.set(0, by, -0.36);
    this.group.add(board);
    const lens = new THREE.SphereGeometry(0.105, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55);
    lens.rotateX(Math.PI / 2);
    for (let i = 0; i < 3; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x222222 });
      const l = new THREE.Mesh(lens, mat);
      l.position.set(-0.31 + i * 0.31, by, -0.335);
      l.userData.on = colors[i];
      this.group.add(l);
      this.lights.push(l);
    }
    this.setCue(0);
    this.setRelease('over');
  }
  setRelease(side) {
    const m = CONFIG.machine;
    this.group.position.set((side === 'around' ? -1 : 1) * m.releaseX, 0, m.releaseZ);
  }
  // stage: 0 off, 1 red, 2 amber, 3 green
  setCue(stage) {
    for (let i = 0; i < 3; i++) {
      const l = this.lights[i];
      l.material.color.setHex(stage === i + 1 ? l.userData.on : 0x26282c);
    }
  }
  setVisible(v) { this.group.visible = v; }
}

// The light board: a rounded case with a hood over each lamp.
function boardGeometry() {
  const parts = [new THREE.BoxGeometry(1.0, 0.34, 0.06)];
  for (let i = 0; i < 3; i++) {
    const hood = new THREE.CylinderGeometry(0.135, 0.135, 0.09, 14, 1, true, -Math.PI * 0.55, Math.PI * 1.1);
    hood.rotateX(Math.PI / 2); hood.translate(-0.31 + i * 0.31, 0, 0.06);
    parts.push(hood.toNonIndexed());
  }
  parts[0] = parts[0].toNonIndexed();
  for (const g of parts) { g.deleteAttribute('uv'); }
  return mergeGeometries(parts, false);
}

// ---------------------------------------------------------------- Markers
// A floor target: a coloured ring with a dark outline and a centre dot, drawn
// in one textured quad (crisp and mipmapped at any distance).
const _ringTex = new Map();
function ringMarkerTexture(color, dotColor) {
  const key = color + ':' + dotColor;
  if (_ringTex.has(key)) return _ringTex.get(key);
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'), m = S / 2;
  const css = (h) => '#' + new THREE.Color(h).getHexString();
  g.fillStyle = 'rgba(255,255,255,0.08)'; g.beginPath(); g.arc(m, m, m * 0.72, 0, Math.PI * 2); g.fill();
  g.lineWidth = m * 0.34; g.strokeStyle = 'rgba(10,14,20,0.55)'; g.beginPath(); g.arc(m, m, m * 0.84, 0, Math.PI * 2); g.stroke();
  g.lineWidth = m * 0.22; g.strokeStyle = css(color); g.beginPath(); g.arc(m, m, m * 0.84, 0, Math.PI * 2); g.stroke();
  g.lineWidth = m * 0.03; g.strokeStyle = 'rgba(255,255,255,0.7)'; g.beginPath(); g.arc(m, m, m * 0.9, 0, Math.PI * 2); g.stroke();
  g.fillStyle = 'rgba(10,14,20,0.55)'; g.beginPath(); g.arc(m, m, m * 0.24, 0, Math.PI * 2); g.fill();
  g.fillStyle = css(dotColor); g.beginPath(); g.arc(m, m, m * 0.17, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  _ringTex.set(key, t);
  return t;
}
export function buildRingMarker(color = 0xffe14d, radius = 0.22, dotColor = color) {
  const g = new THREE.Group();
  const q = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2.2, radius * 2.2),
    new THREE.MeshBasicMaterial({ map: ringMarkerTexture(color, dotColor), transparent: true, depthWrite: false, toneMapped: false }));
  q.rotation.x = -Math.PI / 2;
  q.position.y = 0.01;
  q.renderOrder = 2;
  g.add(q);
  g.renderOrder = 2;
  return g;
}

// Where the last ball pitched: a scuffed oval along the ball's line (pressed
// darker in the middle, a ring of disturbed dust round it). Lasts ~6 s.
let _scuffTex = null;
function scuffTexture() {
  if (_scuffTex) return _scuffTex;
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  let seed = 5; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  // (the canvas is stretched to 0.15 x 0.25 m: circles drawn here are ovals along the ball's line)
  // a halo of disturbed dust, thrown forward (toward the bottom of the canvas = +z)
  const halo = g.createRadialGradient(64, 70, 8, 64, 70, 50);
  halo.addColorStop(0, 'rgba(150,122,80,0.55)'); halo.addColorStop(0.55, 'rgba(160,132,90,0.28)'); halo.addColorStop(1, 'rgba(160,132,90,0)');
  g.fillStyle = halo; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 140; i++) {
    const a = (rnd() - 0.5) * 1.4, d = 22 + rnd() * 26;
    g.fillStyle = `rgba(${rnd() < 0.65 ? '120,98,66' : '214,200,166'},${0.2 + rnd() * 0.3})`;
    g.fillRect(64 + Math.sin(a) * d - 1, 60 + Math.cos(a) * d - 1, 1.5 + rnd() * 2, 1.5 + rnd() * 2);
  }
  // the pressed, darker scuff where the ball hit, and its seam's line across it
  const core = g.createRadialGradient(64, 56, 3, 64, 56, 34);
  core.addColorStop(0, 'rgba(88,66,38,0.95)'); core.addColorStop(0.55, 'rgba(104,80,48,0.8)'); core.addColorStop(1, 'rgba(110,86,52,0)');
  g.fillStyle = core; g.beginPath(); g.arc(64, 56, 34, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(52,38,20,0.6)'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(44, 52); g.lineTo(84, 60); g.stroke();
  // Nothing reaches the quad's edge: everything fades out by 0.42 of the canvas from its middle
  // (no edge and no mip bleed at any distance; what filtering pulls in from the transparent
  // texels is at an alpha too low to see).
  g.globalCompositeOperation = 'destination-in';
  const mask = g.createRadialGradient(64, 62, 30, 64, 62, 56);
  mask.addColorStop(0, 'rgba(0,0,0,1)'); mask.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = mask; g.fillRect(0, 0, S, S);
  _scuffTex = new THREE.CanvasTexture(c); _scuffTex.colorSpace = THREE.SRGBColorSpace; _scuffTex.anisotropy = 4;
  return _scuffTex;
}
export class PitchMark {
  constructor(scene) {
    const geo = new THREE.PlaneGeometry(0.15, 0.25);
    geo.rotateX(-Math.PI / 2);                   // (the dust thrown toward +z: turned to the ball's line in show())
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: scuffTexture(), transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.age = 99;
  }
  // vel: the ball's velocity off the pitch (optional: straight down the pitch otherwise).
  show(pos, vel = null) {
    this.mesh.position.set(pos.x, 0.009, pos.z);
    const vx = vel ? vel.x : 0, vz = vel ? vel.z : 1;
    this.mesh.rotation.y = Math.atan2(vx, vz);
    this.age = 0;
    this.mesh.visible = true;
  }
  update(dt) {
    this.age += dt;
    const a = this.age < 6 ? Math.min(1, this.age * 12) * (this.age < 4 ? 1 : 1 - (this.age - 4) / 2) : 0;
    this.mesh.material.opacity = a * 0.9;
    this.mesh.visible = a > 0.01;
  }
}
