// Replays: every frame of play is recorded (ball, every figure's pose, the
// bats, the stumps, your head); after each ball a short replay plays back the
// way television cuts it: the delivery from high behind the bowler, the shot
// close and side-on (slow motion), then a camera that follows the ball. A
// stumping or run-out is shown square-on at the crease. The camera always
// keeps clear of everybody (CLEAR metres from any head or body) and is moved
// so nobody stands between it and the batter. Cuts dip briefly to black; in
// the headset the replay moves you (gently, with a comfort vignette); any
// button skips it (a small label low in the corner says so).
import * as THREE from 'three';
import { Humanoid } from '../render/humanoid.js';
import { computeRigFacing, headForward } from './calibration.js';
import { PITCH, groundDistance } from '../physics/pitch.js';
import { keepClear, badness } from './replayFraming.js';

const RATE = 60;                 // recorded frames per second (max)
const SECONDS = 15;              // ring buffer length
const CAP = RATE * SECONDS;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _w = new THREE.Vector3();
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const FADE = { xr: 0.18, desk: 0.1 };   // real seconds of the dip to black either side of a cut
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
    this.blackout = buildBlackout();
    game.scene.add(this.blackout);
    this.label = buildLabel();
    game.scene.add(this.label);
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
    this.head = 0; this.count = 0;                     // (frames in the old layout can't be read any more)
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
    // Your bat: not when a runner in your kit has taken over (he carries his own;
    // yours would stand on its own at the crease where you are).
    o = put(B, o, g.batMesh.position, g.batMesh.quaternion); B[o++] = g.batMesh.visible && g.batReplayVisible !== false ? 1 : 0;
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

  // Replace figure k's pose in the recorded frame that shows the pose made at
  // game time t (a frame is recorded before the figures are posed, so that is
  // the first frame after t).
  overwrite(k, t, h) {
    let i = this.find(t + 1e-6);
    if (i < 0) return;
    if (this.timeAt(i) <= t + 1e-6) i++;
    if (i >= this.count) return;
    const B = this.buf;
    let o = this.slotAt(i) * this.stride + 7 + 9 + 8 + k * this.hStride;
    o += 1;                                                 // (visibility as recorded)
    const r = h.root;
    o = put(B, o, r.position, r.quaternion); B[o++] = r.scale.x;
    const hp = h.bones.hips.position; B[o++] = hp.x; B[o++] = hp.y; B[o++] = hp.z;
    for (const b of h.boneList) { const q = b.quaternion; B[o++] = q.x; B[o++] = q.y; B[o++] = q.z; B[o++] = q.w; }
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
    // The wicket was broken with a batter near the line (a stumping, a run-out,
    // or a close call): show it square-on from the crease, the way television
    // does — the take, the hands going to the stumps, the bat or boot at the line.
    if (m.break != null) {
      const s0 = Math.max(first, m.break - 1.4), e0 = Math.min(last, m.break + 1.0, endT + 1.0);
      if (e0 - s0 >= 0.8) return { start: s0, end: e0, hit: null, release: m.release, arrive: null, key: m.break, crease: m.breakEnd || 'batting', playerBatting: !!m.playerBatting };
    }
    // An LBW that went to DRS: the review has just shown the ball; no replay of it again.
    if (m.reviewed != null) return null;
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
    if (!this.plan(endT)) return false;
    // The clip itself is cut when it starts, so it includes what happened in the meantime.
    this.pending = { at: this.g.clock + delay, endT };
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
      fov: g.camera.fov,
    };
    this.cam = null; this.yaw = null;
    // Your figure: re-played with the shot as it turned out (src/render/people.js resolve).
    if (clip.playerBatting && g.playerBody && g.playerBody.resolve) {
      const k = this.humans.indexOf(g.playerBody.actor.h);
      if (k >= 0) g.playerBody.resolve(clip.start, clip.end, (t, h) => this.overwrite(k, t, h));
    }
    // A small label low in the corner, never over the action (no big card, no hint panel).
    g.ui.clearHints?.();
    g.ui.prompt('', 0);                                 // (the result stays on the scoreboard; not across the replay)
    setLabel(this.label, clip.crease ? 'REPLAY · at the crease' : 'REPLAY', g.input.xr ? 'any button skips' : 'Space skips');
    this.label.visible = true;
    if (g.ballView.trail) g.ballView.clearTrail?.();
    this.direct();
    this.apply(clip.start);
    this.shotIx = -1; this.fadeIn = 1;
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
    this.blackout.visible = false;
    this.label.visible = false;
    if (!g.input.xr && s.fov != null && g.camera.fov !== s.fov) { g.camera.fov = s.fov; g.camera.updateProjectionMatrix(); }
    if (g.input.xr) g.setRig(g.rigState); else g.placeDesktopCamera();
    g.snapBat = true;
  }

  // Speed of the replay clock: slow motion around the moment that matters.
  speedAt(t) {
    const c = this.clip;
    if (c.crease) return 0.22 + 0.78 * (1 - sstep(c.key - 0.6, c.key - 0.35, t) * (1 - sstep(c.key + 0.3, c.key + 0.6, t)));
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
      if (this.pending) {
        // Only while that ball's aftermath is still on: if play has moved on
        // (next ball requested, a review under way) the replay is dropped.
        const still = g.session && g.session.state === 'settle' && g.state === 'play';
        if (g.settings.replay === 'off' || !still) this.pending = null;
        else if (g.clock >= this.pending.at && !g.ui.menuOpen) { const clip = this.plan(this.pending.endT + 1.5); if (clip) this.start(clip, g.settings.replay); else this.pending = null; }
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

  // ---------------------------------------------------------------- the director
  // The batters' figures (whoever is in the recording): yours, the AI
  // striker / your runner, the non-striker.
  batterIdx() {
    const g = this.g, out = [];
    for (const h of [g.playerBody && g.playerBody.actor && g.playerBody.actor.h, g.batterView && g.batterView.actor && g.batterView.actor.h, g.nonStrikerView && g.nonStrikerView.actor && g.nonStrikerView.actor.h]) {
      const k = h ? this.humans.indexOf(h) : -1;
      if (k >= 0) out.push(k);
    }
    return out;
  }

  // Everybody drawn in the pose last applied: head, hips and the ground under
  // the hips (two segments that cover the body).
  bodies(skip = -1) {
    const out = [];
    this.humans.forEach((h, k) => {
      if (k === skip || !h.root.visible || !h.bones.head) return;
      const a = h.bones.head.getWorldPosition(new THREE.Vector3());
      a.y += 0.12;                                        // the top of the head (helmet)
      const b = h.bones.hips.getWorldPosition(new THREE.Vector3());
      out.push({ k, a, b, c: new THREE.Vector3(b.x, 0.05, b.z) });
    });
    return out;
  }

  // Score a fixed camera over a stretch of the clip (several recorded poses);
  // `subjectAt(t)` gives the point that must stay in view.
  score(pos, subjectAt, t0, t1, skip) {
    let bad = 0;
    for (let i = 0; i <= 5; i++) {
      const t = t0 + (t1 - t0) * (i / 5);
      this.apply(t);
      bad += badness(pos, subjectAt(t), this.bodies(skip));
    }
    return bad;
  }

  // Lay out the clip's shots: [{ kind, t0, pos, look, fov }] (a cut between each).
  direct() {
    const c = this.clip, g = this.g, xr = !!g.input.xr;
    const shots = this.shots = [];
    const bats = this.batterIdx();
    // The point (on a figure) that must stay in view.
    const chest = (k) => (t) => { const h = this.humans[k]; return h && h.root.visible ? h.bones.spine.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(-0.4, 1.0, -1.1); };
    if (c.crease) {
      // Square of the wicket at the crease, far enough back to have the
      // stumps, the line and the batter making his ground all in the frame.
      const zs = c.crease === 'batting' ? PITCH.battingStumpsZ : PITCH.bowlingStumpsZ, dir = c.crease === 'batting' ? -1 : 1;
      const zc = zs + dir * PITCH.poppingOffset;
      this.apply(c.key);
      let who = -1, best = Infinity;
      for (const k of bats) {
        const h = this.humans[k];
        if (!h.root.visible) continue;
        const p = h.bones.hips.getWorldPosition(_w);
        const d = Math.hypot(p.x, p.z - zc);
        if (d < best) { best = d; who = k; }
      }
      let short = 0;
      if (who >= 0) { const p = this.humans[who].bones.hips.getWorldPosition(_w); short = clamp((p.z - zc) * dir, 0, 5); }
      const D = (xr ? 3.4 : 4.4) + 0.8 * short;
      const look = new THREE.Vector3(0, 0.55, zc + dir * (short * 0.45 - 0.3));
      const at = (t) => (who >= 0 && this.humans[who].root.visible ? chest(who)(t) : look);
      let pick = null;
      for (const [sx, y] of [[1, 1.0], [-1, 1.0], [1, 1.8], [-1, 1.8], [1, 2.8], [-1, 2.8]]) {
        const pos = new THREE.Vector3(sx * D, y, zc + dir * short * 0.35);
        const bad = this.score(pos, at, c.start, c.end, who) + this.score(pos, () => new THREE.Vector3(0, 0.4, zc), c.key - 0.3, c.key + 0.2, -1);
        if (!pick || bad < pick.bad) pick = { pos, bad };
        if (bad === 0) break;
      }
      shots.push({ kind: 'fixed', t0: c.start, pos: pick.pos, look, fov: 42 });
      return;
    }
    const K = c.hit ?? c.arrive ?? c.release + 0.75;      // the ball reaches the bat
    // The striker: the batter nearest the batting crease as the ball arrives.
    this.apply(K);
    let sk = -1, sd = Infinity;
    for (const k of bats) {
      const h = this.humans[k];
      if (!h.root.visible) continue;
      const p = h.bones.hips.getWorldPosition(_w);
      const d = Math.hypot(p.x + 0.4, p.z + 1.1);
      if (d < sd) { sd = d; sk = k; }
    }
    if (sd > 4) sk = -1;
    const at = sk >= 0 ? chest(sk) : () => new THREE.Vector3(-0.4, 1.0, -1.1);
    const S = sk >= 0 ? this.humans[sk].bones.hips.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(-0.4, 0.95, -1.1);
    const chaseAt = c.hit != null && c.end - (c.hit + 0.7) > 0.8 ? c.hit + 0.7 : null;
    if (this.view === 'batter') {
      shots.push({ kind: 'eyes', t0: c.start, fov: 70 });
      if (chaseAt != null) shots.push({ kind: 'chase', t0: chaseAt, fov: 60 });
      return;
    }
    // 1. The delivery: high behind the bowler's arm, over the umpire, looking
    //    down the pitch at the batter (raised further if anyone is in the way).
    const cut = K - 0.35;
    if (cut - c.start >= 0.7) {
      let pick = null;
      for (let lift = 0; lift <= 4; lift += 0.75) {
        const pos = xr ? new THREE.Vector3(0.9, 4.3 + lift, PITCH.bowlingStumpsZ - 3.6) : new THREE.Vector3(0.5, 4.4 + lift, PITCH.bowlingStumpsZ - 11);
        const bad = this.score(pos, at, c.start, cut, sk);
        if (!pick || bad < pick.bad) pick = { pos, bad };
        if (bad === 0) break;
      }
      // Framed the television way: the batter in the upper part of the
      // picture, the bowler's crease (and the bowler) in the lower part.
      const pos = pick.pos;
      const d1 = new THREE.Vector3(S.x, S.y + 0.4, S.z).sub(pos).normalize();
      const d2 = new THREE.Vector3(0, 0, PITCH.bowlingStumpsZ + 2.0).sub(pos).normalize();
      const look = pos.clone().addScaledVector(d1.add(d2).normalize(), 20);
      shots.push({ kind: 'fixed', t0: c.start, pos, look, fov: 24 });
    }
    // 2. The shot: close, square of the wicket, facing the batter's chest
    //    (his off side when he stands side-on), slow motion.
    this.apply(Math.max(c.start, K - 0.5));
    let sx = 1;
    if (sk >= 0) {
      const h = this.humans[sk];
      const r = h.bones.shoulderR.getWorldPosition(new THREE.Vector3()), l = h.bones.shoulderL.getWorldPosition(new THREE.Vector3());
      const nx = r.z - l.z;                           // up × (R − L), x part: the way the chest faces
      if (Math.abs(nx) > 0.05) sx = Math.sign(nx);
    }
    const D = xr ? 3.3 : 4.2, t1 = chaseAt ?? c.end;
    let pick = null;
    for (const [side, dz, y] of [[sx, -1.0, 1.35], [sx, -2.0, 1.4], [sx, 0.1, 1.35], [sx, -1.0, 2.3], [sx, -2.2, 2.6], [-sx, -1.0, 1.35], [-sx, -2.0, 2.3]]) {
      const pos = new THREE.Vector3(S.x + side * D, y, S.z + dz);
      const bad = this.score(pos, at, Math.max(c.start, cut), Math.min(t1, K + 0.6), sk);
      if (!pick || bad < pick.bad) pick = { pos, bad };
      if (bad === 0) break;
    }
    shots.push({ kind: 'side', t0: shots.length ? cut : c.start, pos: pick.pos, look: new THREE.Vector3(S.x, 0.95, S.z - 0.45), fov: 40 });
    // 3. Then follow the ball.
    if (chaseAt != null) shots.push({ kind: 'chase', t0: chaseAt, fov: 45 });
  }

  // Seeing it through a batter's eyes (his bat stays drawn though his body is culled).
  get eyesView() { return this.active && !!this.shots && this.shotIx >= 0 && this.shots[this.shotIx].kind === 'eyes'; }

  shotIndexAt(t) {
    let i = 0;
    while (i + 1 < this.shots.length && t >= this.shots[i + 1].t0) i++;
    return i;
  }

  // Where the camera wants to be at replay time t: { pos, look, fov }.
  shot(t) {
    const c = this.clip, S = this.shots[this.shotIndexAt(t)];
    const pos = new THREE.Vector3(), look = new THREE.Vector3();
    if (S.kind === 'eyes') {
      if (c.playerBatting && this.g.input.xr) this.headAt(Math.min(t, c.hit ?? t), pos);
      else pos.set(-0.38, 1.62, -1.1);
      look.set(0.4, 1.4, PITCH.bowlingStumpsZ);
      if (t > c.release) look.lerp(this.ballAt(t, _v2), 0.35);
    } else if (S.kind === 'chase') {
      // Behind the ball and above it, following it out (inside the rope).
      const b = this.ballAt(t, new THREE.Vector3());
      const p0 = this.ballAt(c.hit + 0.02, new THREE.Vector3()), p1 = this.ballAt(c.hit + 0.16, new THREE.Vector3());
      const dir = p1.sub(p0); dir.y = 0;
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
      dir.normalize();
      // Along the ball's line, never nearer the striker's end than 5 m behind
      // where it was hit (so the camera starts high behind the batter, not on him).
      const back = this.g.input.xr ? 9 : 7;
      const along = Math.max((b.x - p0.x) * dir.x + (b.z - p0.z) * dir.z - back, -5);
      pos.set(p0.x + dir.x * along, Math.max(3.6, b.y * 0.5 + 2.6), p0.z + dir.z * along);
      const gd = groundDistance(pos.x, pos.z), lim = 56;
      if (gd > lim) { const cz = PITCH.centerZ, kk = lim / gd; pos.x *= kk; pos.z = cz + (pos.z - cz) * kk; }
      look.copy(b);
    } else {
      pos.copy(S.pos); look.copy(S.look);
      // Keep the ball in the picture: the side-on view turns a little with it after the shot.
      if (S.kind === 'side') {
        const key = c.hit ?? c.arrive;
        if (key != null && t > key) look.lerp(this.ballAt(t, _v2), (c.hit != null ? 0.45 : 0.3) * sstep(key, key + 0.4, t));
      } else if (!c.crease && t > c.release) look.lerp(this.ballAt(t, _v2), 0.15);
    }
    return { pos, look, fov: S.fov };
  }

  moveCamera(t, dt) {
    const g = this.g, xr = !!g.input.xr;
    const ix = this.shotIndexAt(t);
    if (ix !== this.shotIx) {                              // a cut: jump there (while it is dark)
      if (this.shotIx >= 0) this.fadeIn = 1;
      this.shotIx = ix; this.cam = null; this.yaw = null;
    }
    const { pos, look, fov } = this.shot(t);
    const bodies = this.bodies();
    keepClear(pos, bodies);
    // Smooth (critically damped) so the camera never jerks.
    if (!this.cam) this.cam = { p: pos.clone(), v: new THREE.Vector3() };
    const w = this.shots[ix].kind === 'chase' ? (xr ? 3.2 : 7) : 9;
    const c = this.cam;
    _v.copy(pos).sub(c.p).multiplyScalar(w * w).addScaledVector(c.v, -2 * w);
    c.v.addScaledVector(_v, dt);
    c.p.addScaledVector(c.v, dt);
    keepClear(c.p, bodies);                             // (never through anybody on the way)
    const speed = c.v.length();
    // Dip to black either side of a cut.
    const F = xr ? FADE.xr : FADE.desk;
    this.fadeIn = Math.max(0, (this.fadeIn ?? 0) - dt / F);
    let out = 0;
    const next = this.shots[ix + 1];
    if (next) { const left = (next.t0 - t) / Math.max(0.05, this.speedAt(t)); out = clamp(1 - left / F, 0, 1); }
    const bo = this.blackout;
    bo.material.opacity = Math.max(out, this.fadeIn);
    bo.visible = bo.material.opacity > 0.01;
    if (xr) {
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
      if (fov && g.camera.fov !== fov) { g.camera.fov = fov; g.camera.updateProjectionMatrix(); }
      g.camera.position.copy(c.p);
      g.camera.lookAt(look);
      g.camera.updateMatrixWorld(true);
    }
  }

  // Keep the vignette, the dip to black and the label in front of your eyes
  // (after the eye pose is known).
  placeVignette(eye) {
    for (const m of [this.vignette, this.blackout]) {
      if (!m.visible) continue;
      m.position.copy(eye.p);
      m.quaternion.copy(eye.q);
    }
    const L = this.label;
    if (L.visible) {
      // Low and to the left, at the edge of the view; in the headset 0.6 m away,
      // about 20° left and 16° down; on a monitor the same place on the screen.
      const cam = this.g.camera, xr = !!this.g.input.xr;
      const ty = xr ? 0.36 : Math.tan((cam.fov * Math.PI) / 360), tx = xr ? 0.42 : ty * cam.aspect;
      const d = 0.6, k = xr ? 1 : ty / 0.7;
      L.position.set(-tx * d * 0.86 + L.userData.w * k / 2, -ty * d * 0.84 + L.userData.h * k / 2, -d).applyQuaternion(eye.q).add(eye.p);
      L.quaternion.copy(eye.q);
      L.scale.setScalar(k);
    }
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


// A head-locked black screen for the dip to black at a cut.
function buildBlackout() {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, depthTest: false, depthWrite: false, opacity: 0 }));
  m.geometry.translate(0, 0, -0.11);
  m.renderOrder = 21;
  m.frustumCulled = false;
  m.visible = false;
  return m;
}

// The small "REPLAY · any button skips" tag.
function buildLabel() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const w = 0.15, h = w * 96 / 512;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  m.userData = { canvas: c, tex, w, h };
  m.renderOrder = 22;
  m.frustumCulled = false;
  m.visible = false;
  return m;
}
function setLabel(m, title, sub) {
  const { canvas: c, tex } = m.userData, x = c.getContext('2d');
  x.clearRect(0, 0, c.width, c.height);
  x.fillStyle = 'rgba(8,14,24,0.55)';
  const r = 18, W = c.width, H = c.height;
  x.beginPath(); x.moveTo(r, 0); x.arcTo(W, 0, W, H, r); x.arcTo(W, H, 0, H, r); x.arcTo(0, H, 0, 0, r); x.arcTo(0, 0, W, 0, r); x.closePath(); x.fill();
  x.fillStyle = '#7fd3ff'; x.font = 'bold 40px sans-serif'; x.textBaseline = 'middle';
  x.fillText(title, 22, 34);
  x.fillStyle = 'rgba(232,238,245,0.8)'; x.font = '28px sans-serif';
  x.fillText(sub, 22, 72);
  tex.needsUpdate = true;
}
