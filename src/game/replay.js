// Replays: every frame of play is recorded (ball, every figure's pose, the
// bats, the stumps, your head); after each ball a short replay plays back
// from the bowler's end or through the batter's eyes, and once the ball is hit
// the camera chases it. In the headset the replay moves you (slowly, with a
// comfort vignette); any button skips it.
import * as THREE from 'three';
import { Humanoid } from '../render/humanoid.js';
import { computeRigFacing, headForward } from './calibration.js';
import { PITCH, groundDistance } from '../physics/pitch.js';

const RATE = 60;                 // recorded frames per second (max)
const SECONDS = 15;              // ring buffer length
const CAP = RATE * SECONDS;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export class Replay {
  constructor(game) {
    this.g = game;
    this.buf = null;
    this.times = new Float64Array(CAP);
    this.head = 0; this.count = 0; this.lastT = -1;
    this.marks = {};
    this.active = false;
    this.pending = null;
    this.vignette = buildVignette();
    game.scene.add(this.vignette);
  }

  // ---------------------------------------------------------------- layout
  layout() {
    const g = this.g;
    this.humans = Humanoid.all.slice();
    this.extras = [];
    for (const h of this.humans) for (const x of h.extras || []) this.extras.push(x);
    this.pieces = [...g.stumps.batting.pieces, ...g.stumps.bowling.pieces].map((p) => p.mesh);
    this.nb = this.humans[0].boneList.length;
    this.hStride = 1 + 3 + 4 + 1 + 3 + this.nb * 4;
    this.stride = 7 + 9 + 8 + this.humans.length * this.hStride + this.extras.length * 8 + this.pieces.length * 7;
    this.buf = new Float32Array(CAP * this.stride);
  }

  // A new delivery is on its way.
  mark(name, t) {
    if (name === 'release') this.marks = {};
    if (this.marks[name] == null) this.marks[name] = t;
  }

  // ---------------------------------------------------------------- record
  record(t) {
    if (this.active) return;
    if (!this.buf) this.layout();
    if (Humanoid.all.length !== this.humans.length) this.layout();
    if (t < this.lastT) { this.count = 0; }            // time went backwards (new game)
    if (this.count && t - this.lastT < 1 / RATE - 1e-4) return;
    this.lastT = t;
    const g = this.g, B = this.buf, S = this.stride;
    const slot = this.head;
    this.head = (this.head + 1) % CAP;
    this.count = Math.min(CAP, this.count + 1);
    this.times[slot] = t;
    let o = slot * S;
    const hp = g.input.headPose;
    B[o++] = hp.p.x; B[o++] = hp.p.y; B[o++] = hp.p.z; B[o++] = hp.q.x; B[o++] = hp.q.y; B[o++] = hp.q.z; B[o++] = hp.q.w;
    const bm = g.ballView.mesh;
    o = put(B, o, bm.position, bm.quaternion); B[o++] = bm.scale.x; B[o++] = g.ballView.visible ? 1 : 0;
    o = put(B, o, g.batMesh.position, g.batMesh.quaternion); B[o++] = g.batMesh.visible ? 1 : 0;
    for (const h of this.humans) {
      const r = h.root;
      B[o++] = (h.replayVisible ?? r.visible) ? 1 : 0;
      o = put(B, o, r.position, r.quaternion); B[o++] = r.scale.x;
      const hp2 = h.bones.hips.position; B[o++] = hp2.x; B[o++] = hp2.y; B[o++] = hp2.z;
      for (const b of h.boneList) { const q = b.quaternion; B[o++] = q.x; B[o++] = q.y; B[o++] = q.z; B[o++] = q.w; }
    }
    for (const x of this.extras) { o = put(B, o, x.position, x.quaternion); B[o++] = x.visible ? 1 : 0; }
    for (const m of this.pieces) o = put(B, o, m.position, m.quaternion);
  }

  // Frame slots in time order.
  slotAt(i) { return (this.head - this.count + i + CAP) % CAP; }
  timeAt(i) { return this.times[this.slotAt(i)]; }
  // Index (into time order) of the last frame at or before t.
  find(t) {
    let lo = 0, hi = this.count - 1;
    if (hi < 0) return -1;
    if (t <= this.timeAt(0)) return 0;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.timeAt(mid) <= t) lo = mid; else hi = mid - 1; }
    return lo;
  }

  // ---------------------------------------------------------------- planning
  // The clip for the ball just finished, or null.
  plan(endT) {
    const m = this.marks;
    if (m.release == null || !this.count) return null;
    const first = this.timeAt(0), last = this.timeAt(this.count - 1);
    const start = Math.max(first, m.release - 1.0);
    let end;
    if (m.hit != null) end = Math.min(m.hit + (m.caught != null ? 1.4 : 3.2), m.held != null && m.held > m.hit ? m.held + 1.0 : Infinity);
    else end = Math.min(m.release + 3.2, (m.held ?? m.wicket ?? m.pad ?? Infinity) + 1.1);
    end = Math.min(end, last, endT + 1.0);
    if (end - start < 1.0) return null;
    // When the ball reaches the batter (for slow motion on a miss).
    let arrive = null;
    for (let i = this.find(m.release); i < this.count; i++) {
      const o = this.slotAt(i) * this.stride + 7;
      if (this.timeAt(i) > m.release + 0.05 && this.buf[o + 8] > 0.5 && this.buf[o + 2] > -1.6) { arrive = this.timeAt(i); break; }
    }
    return { start, end, hit: m.hit ?? null, release: m.release, arrive, playerBatting: !!m.playerBatting };
  }

  // Schedule a replay `delay` real seconds from now.
  schedule(delay, endT) {
    const clip = this.plan(endT);
    if (!clip) return false;
    this.pending = { at: this.g.clock + delay, clip };
    return true;
  }

  // ---------------------------------------------------------------- playback
  start(clip, view) {
    const g = this.g;
    this.clip = clip; this.view = view;
    this.rt = clip.start; this.active = true; this.pending = null;
    // What to put back afterwards.
    this.saved = {
      vis: this.humans.map((h) => h.root.visible),
      extras: this.extras.map((x) => x.visible),
      bat: { v: g.batMesh.visible, p: g.batMesh.position.clone(), q: g.batMesh.quaternion.clone() },
      ball: { v: g.ballView.visible, p: g.ballView.mesh.position.clone(), q: g.ballView.mesh.quaternion.clone(), s: g.ballView.mesh.scale.x },
      pieces: this.pieces.map((m) => [m.position.clone(), m.quaternion.clone()]),
      menuWasOpen: g.ui.menuOpen,
    };
    this.cam = null; this.yaw = null;
    g.ui.prompt('REPLAY', 1.6, '#7fd3ff');
    g.hint([{ hand: 'R', button: 'trigger', label: 'SKIP', sub: 'any button', key: 'Space' }], 2.5);
    if (g.ballView.trail) g.ballView.clearTrail?.();
  }

  stop() {
    if (!this.active) return;
    const g = this.g, s = this.saved;
    this.active = false;
    this.humans.forEach((h, i) => { h.visible = s.vis[i]; });
    this.extras.forEach((x, i) => { x.visible = s.extras[i]; });
    g.batMesh.visible = s.bat.v; g.batMesh.position.copy(s.bat.p); g.batMesh.quaternion.copy(s.bat.q);
    g.ballView.setVisible(s.ball.v); g.ballView.mesh.position.copy(s.ball.p); g.ballView.mesh.quaternion.copy(s.ball.q); g.ballView.mesh.scale.setScalar(s.ball.s);
    this.pieces.forEach((m, i) => { m.position.copy(s.pieces[i][0]); m.quaternion.copy(s.pieces[i][1]); });
    this.vignette.visible = false;
    if (g.input.xr) g.setRig(g.rigState); else g.placeDesktopCamera();
    g.snapBat = true;
  }

  // Speed of the replay clock: slow motion around the moment that matters.
  speedAt(t) {
    const c = this.clip;
    const key = c.hit ?? c.arrive;
    if (key == null) return 1;
    const slow = 1 - sstep(key - 0.45, key - 0.15, t) * (1 - sstep(key + 0.3, key + 0.6, t));
    // In the headset the chase after the shot runs a little slower (comfort).
    const chase = this.g.input.xr && c.hit != null && t > c.hit + 0.6 ? 0.75 : 1;
    return (0.32 + 0.68 * slow) * chase;
  }

  update(dt) {
    const g = this.g;
    if (!this.active) {
      if (this.pending && g.clock >= this.pending.at) {
        if (g.settings.replay === 'off' || g.ui.menuOpen || !g.session) this.pending = null;
        else this.start(this.pending.clip, g.settings.replay);
      }
      return;
    }
    // Any button skips.
    const L = g.input.left, R = g.input.right, D = g.input.desktop;
    const any = (c) => c.buttons.trigger.down || c.buttons.a.down || c.buttons.b.down || c.buttons.squeeze.down;
    if (any(L) || any(R) || D.took('Space') || D.took('Enter') || g.ui.menuOpen) { this.stopReason = 'skip'; this.stop(); return; }
    this.rt += dt * this.speedAt(this.rt);
    if (this.rt >= this.clip.end) { this.stopReason = 'end'; this.stop(); return; }
    this.apply(this.rt);
    this.moveCamera(this.rt, dt);
  }

  // Pose everything as it was at time t.
  apply(t) {
    const g = this.g, B = this.buf, S = this.stride;
    const i0 = this.find(t), i1 = Math.min(this.count - 1, i0 + 1);
    const t0 = this.timeAt(i0), t1 = this.timeAt(i1);
    const k = t1 > t0 ? clamp((t - t0) / (t1 - t0), 0, 1) : 0;
    let a = this.slotAt(i0) * S, b = this.slotAt(i1) * S;
    a += 7; b += 7;
    const bm = g.ballView.mesh;
    lerpTo(B, a, b, k, bm.position, bm.quaternion); bm.scale.setScalar(B[a + 7]);
    g.ballView.setVisible(B[a + 8] > 0.5);
    if (g.ballView.shadow) g.ballView.shadow.position.set(bm.position.x, 0.005, bm.position.z);
    a += 9; b += 9;
    lerpTo(B, a, b, k, g.batMesh.position, g.batMesh.quaternion); g.batMesh.visible = B[a + 7] > 0.5;
    a += 8; b += 8;
    for (const h of this.humans) {
      const vis = B[a] > 0.5;
      h.visible = vis;
      if (vis) {
        const r = h.root;
        lerpTo(B, a + 1, b + 1, k, r.position, r.quaternion);
        r.scale.setScalar(B[a + 8]);
        h.bones.hips.position.set(mix(B[a + 9], B[b + 9], k), mix(B[a + 10], B[b + 10], k), mix(B[a + 11], B[b + 11], k));
        let o = a + 12, p = b + 12;
        for (const bone of h.boneList) {
          _q.set(B[o], B[o + 1], B[o + 2], B[o + 3]); _q2.set(B[p], B[p + 1], B[p + 2], B[p + 3]);
          bone.quaternion.slerpQuaternions(_q, _q2, k);
          o += 4; p += 4;
        }
        r.updateMatrixWorld(true);
        h.syncShadow();
      }
      a += this.hStride; b += this.hStride;
    }
    for (const x of this.extras) { lerpTo(B, a, b, k, x.position, x.quaternion); x.visible = B[a + 7] > 0.5; a += 8; b += 8; }
    for (const m of this.pieces) { lerpTo(B, a, b, k, m.position, m.quaternion); a += 7; b += 7; }
  }

  ballAt(t, out) {
    const i0 = this.find(t), i1 = Math.min(this.count - 1, i0 + 1);
    const t0 = this.timeAt(i0), t1 = this.timeAt(i1);
    const k = t1 > t0 ? clamp((t - t0) / (t1 - t0), 0, 1) : 0;
    const a = this.slotAt(i0) * this.stride + 7, b = this.slotAt(i1) * this.stride + 7;
    return out.set(mix(this.buf[a], this.buf[b], k), mix(this.buf[a + 1], this.buf[b + 1], k), mix(this.buf[a + 2], this.buf[b + 2], k));
  }
  headAt(t, out) {
    const o = this.slotAt(this.find(t)) * this.stride;
    return out.set(this.buf[o], this.buf[o + 1], this.buf[o + 2]);
  }

  // Where the camera wants to be at replay time t: { pos, look }.
  shot(t) {
    const c = this.clip;
    const pos = new THREE.Vector3(), look = new THREE.Vector3();
    // Before the hit: the bowler's end, or the batter's eyes.
    if (this.view === 'batter') {
      if (c.playerBatting && this.g.input.xr) this.headAt(Math.min(t, c.hit ?? t), pos);
      else pos.set(-0.38, 1.62, -1.1);
      look.set(0.4, 1.4, PITCH.bowlingStumpsZ);
    } else {
      // Above the umpire's hat, just wide of the bowler's arm.
      pos.set(0.95, 2.55, PITCH.bowlingStumpsZ - 4.2);
      look.set(0, 0.9, -1.0);
      // A miss: glide down the pitch behind the ball to see what happened.
      if (c.hit == null && c.arrive != null) {
        const k = sstep(c.release + 0.15, c.arrive + 0.1, t);
        pos.z += k * 13.5; pos.y -= k * 0.9; pos.x -= k * 0.5;
      }
    }
    // After the hit: chase the ball.
    if (c.hit != null && t > c.hit) {
      const b = this.ballAt(t, new THREE.Vector3());
      const p0 = this.ballAt(c.hit + 0.02, new THREE.Vector3()), p1 = this.ballAt(c.hit + 0.16, new THREE.Vector3());
      const dir = p1.sub(p0); dir.y = 0;
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
      dir.normalize();
      const chase = new THREE.Vector3(b.x - dir.x * 4.5, Math.max(1.4, b.y * 0.6 + 1.3), b.z - dir.z * 4.5);
      // Stay inside the rope (the ball can go over it; the camera doesn't).
      const gd = groundDistance(chase.x, chase.z), lim = 58;
      if (gd > lim) { const cz = PITCH.centerZ, kk = lim / gd; chase.x *= kk; chase.z = cz + (chase.z - cz) * kk; }
      const k = sstep(c.hit, c.hit + 0.35, t);
      pos.lerp(chase, k);
      look.lerp(b, sstep(c.hit, c.hit + 0.12, t));
    } else if (t > c.release) {
      // Keep the ball in view as it comes down the pitch.
      const b = this.ballAt(t, new THREE.Vector3());
      look.lerp(b, 0.35);
    }
    return { pos, look };
  }

  moveCamera(t, dt) {
    const g = this.g;
    const { pos, look } = this.shot(t);
    // Smooth (critically damped) so the camera never jerks.
    if (!this.cam) this.cam = { p: pos.clone(), v: new THREE.Vector3() };
    const w = 9;
    const c = this.cam;
    _v.copy(pos).sub(c.p).multiplyScalar(w * w).addScaledVector(c.v, -2 * w);
    c.v.addScaledVector(_v, dt);
    c.p.addScaledVector(c.v, dt);
    const speed = c.v.length();
    if (g.input.xr) {
      const dirX = look.x - c.p.x, dirZ = look.z - c.p.z;
      let yaw = Math.atan2(dirX, dirZ);
      if (this.yaw == null) this.yaw = yaw;
      let d = yaw - this.yaw; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      this.yaw += d * Math.min(1, dt * 2.2);                // turn you slowly
      const head = g.input.headRef;
      const r = computeRigFacing(head.p, headForward(head.q), c.p.x, c.p.z, Math.sin(this.yaw), Math.cos(this.yaw));
      g.rig.position.set(r.x, c.p.y - head.p.y, r.z);
      g.rig.rotation.set(0, r.yaw, 0);
      g.rig.updateMatrixWorld(true);
      g.input.refreshHeadWorld();
      // Comfort vignette while the view is moving.
      const vg = this.vignette;
      vg.material.opacity = clamp((speed - 0.8) / 6, 0, 0.85);
      vg.visible = vg.material.opacity > 0.02;
    } else {
      g.camera.position.copy(c.p);
      g.camera.lookAt(look);
      g.camera.updateMatrixWorld(true);
    }
  }

  // Keep the vignette in front of your eyes (after the eye pose is known).
  placeVignette(eye) {
    if (!this.vignette.visible) return;
    this.vignette.position.copy(eye.p);
    this.vignette.quaternion.copy(eye.q);
  }
}

function put(B, o, p, q) {
  B[o++] = p.x; B[o++] = p.y; B[o++] = p.z; B[o++] = q.x; B[o++] = q.y; B[o++] = q.z; B[o++] = q.w;
  return o;
}
function mix(a, b, k) { return a + (b - a) * k; }
function lerpTo(B, a, b, k, pos, quat) {
  pos.set(mix(B[a], B[b], k), mix(B[a + 1], B[b + 1], k), mix(B[a + 2], B[b + 2], k));
  _q.set(B[a + 3], B[a + 4], B[a + 5], B[a + 6]); _q2.set(B[b + 3], B[b + 4], B[b + 5], B[b + 6]);
  quat.slerpQuaternions(_q, _q2, k);
}

// A head-locked dark ring with a clear centre (dims the edges of your view
// while a replay camera moves you).
function buildVignette() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d');
  const gr = x.createRadialGradient(128, 128, 40, 128, 128, 128);
  gr.addColorStop(0, 'rgba(0,0,0,0)');
  gr.addColorStop(0.45, 'rgba(0,0,0,0)');
  gr.addColorStop(1, 'rgba(0,0,0,1)');
  x.fillStyle = gr; x.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, opacity: 0 }));
  m.geometry.translate(0, 0, -0.12);
  m.renderOrder = 20;
  m.frustumCulled = false;
  m.visible = false;
  return m;
}
