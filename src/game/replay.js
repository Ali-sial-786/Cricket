// Replays: every frame of play is recorded (ball, every figure's pose, the
// bats, the stumps, your head); after EVERY ball that was bowled its replay
// plays, once, while the game is frozen:
//
//   * one camera, one continuous move (src/game/replayFraming.js): high behind
//     the bowler's arm for the last strides of the run-up, the release and the
//     ball's flight, then it follows the ball (turning, and closing in on it:
//     the keeper's take, the pick-up and throw, the catch) until the ball is
//     dead. No cuts, no second angle, no change of height;
//   * real time, from PRE s before the release to TAIL s after the ball is dead
//     (TAIL_OUT after a catch or the stumps broken; the next ball asked for
//     during the result waits for that much tape: BattingSession.requestNext);
//     the camera's framing holds once the ball is dead (a lob back is not chased);
//   * the off-hand trigger (the hand without the bat / the ball, see
//     skipHand; Space on a monitor) skips it, and that press does nothing
//     else; nothing but the skip or its own end stops it (an open menu only
//     pauses it);
//   * order with reviews: ball -> appeal / DRS / third umpire (unchanged) ->
//     verdict -> the ball's replay -> next ball. The recording stops TAIL s
//     into a review, so the ball is still there when the review is over;
//   * in the headset the replay moves you (the rig): position and yaw only,
//     eased, with a comfort vignette while it moves; you can look around. The
//     view comes in from dark (ViewFade) when it puts you there and when it
//     puts you back, as it does whenever the game moves you.
import * as THREE from 'three';
import { Humanoid } from '../render/humanoid.js';
import { computeRigFacing, headForward } from './calibration.js';
import { Vec3 } from '../physics/math.js';
import { PITCH } from '../physics/pitch.js';
import { CONFIG } from '../config.js';
import { planCamera, cameraAt, cameraBase, pathStats, clipFor, replayAt, tailFor, CAM, PRE, TAIL } from './replayFraming.js';
export { PRE, TAIL, tailFor };

const RATE = 90;                 // recorded frames per second (max): every frame at 72 and 90 Hz
const SECONDS = 24;              // ring buffer length (a ball can be live for 20 s)
const CAP = RATE * SECONDS;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _cam = {}, _arms = [1, 1];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const FADE_IN = 0.22;            // real seconds the view takes to come in from dark after it was moved
const DESK_FOV = 36;             // the replay camera's lens on a monitor (the headset has its own)
const LABEL_SECS = 1.5, LABEL_FADE = 0.5;   // the REPLAY label: up this long (real s), then fades out over this

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
    this.fade = new ViewFade(game.scene);
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
    // your figure's arm lengths (its arms lengthen to keep the gloves on a bat out of its reach), per frame:
    // the joints alone would put the gloves off the handle
    const pb = g.playerBody;
    this.armK = pb && pb.armsNow ? this.humans.indexOf(pb.actor.h) : -1;
    this.arms = new Float32Array(CAP * 2).fill(1);
    this.head = 0; this.count = 0;                     // (frames in the old layout can't be read any more)
  }

  // A new delivery is on its way.
  mark(name, t) {
    if (name === 'release') { this.marks = {}; this.pending = null; }
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
    o = put(B, o, bm.position, bm.quaternion); B[o++] = bm.scale.x; B[o++] = g.ballView.visible ? (g.ballView.trailGrowing ? 2 : 1) : 0;   // (2: its trail growing)
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
    this.putArms(slot, this.armK >= 0 ? g.playerBody.armsNow() : null);
  }
  putArms(slot, a) { this.arms[slot * 2] = a ? a[0] : 1; this.arms[slot * 2 + 1] = a ? a[1] : 1; }

  // Replace figure k's pose in the recorded frame of game time t (Game.frame
  // poses the figures and then records the frame, so a frame holds the pose
  // made at its own time). Only a frame recorded at exactly t is written: a
  // pose made for a frame that was not recorded (frames over RATE are
  // skipped) is not moved into a neighbouring one. arms: your figure's arm
  // lengths for that pose ([left, right], null = their own length).
  overwrite(k, t, h, arms = null) {
    const i = this.find(t);
    if (i < 0 || Math.abs(this.timeAt(i) - t) > 1e-6) return;
    const B = this.buf;
    if (k === this.armK) this.putArms(this.slotAt(i), arms);
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
  // The clip for the ball just finished (replayFraming.js clipFor), or null.
  // key: when the ball reaches the batter (bat, pad or just the crease); the
  // camera follows the ball from then on.
  plan() {
    const m = this.marks;
    if (m.release == null || m.played || !this.count) return null;
    return clipFor(m, this.timeAt(0), this.timeAt(this.count - 1), this.arrival(m.release));
  }

  // When the ball first got to the batter's end of the pitch after the release (null: never on the tape).
  arrival(release) {
    for (let i = Math.max(0, this.find(release)); i < this.count; i++) {
      const o = this.slotAt(i) * this.stride + 7, t = this.timeAt(i);
      if (t > release + 0.05 && this.buf[o + 8] > 0.5 && this.buf[o + 2] > -1.6) return t;
    }
    return null;
  }

  // The ball is dead and its result is up (the session has just gone to
  // 'settle'): its replay starts once TAIL s of aftermath are on the tape,
  // and a moment after a review's verdict (replayFraming.js replayAt).
  schedule(t) {
    const m = this.marks;
    if (m.release == null || m.played) return false;
    if (m.dead == null) m.dead = t;
    this.pending = { at: replayAt(m, t) };
    return true;
  }

  // When the pending replay is due (game s; Infinity if none): its tail of
  // aftermath on the tape, by the marks as they are now.
  dueAt() {
    const p = this.pending, m = this.marks;
    if (!p) return Infinity;
    return m.dead != null ? Math.max(p.at, m.dead + tailFor(m) + 0.05) : p.at;
  }

  // The hand that skips: your off hand, the one without the bat / the ball
  // (game.mainHand names the other; with one controller connected, that one).
  skipHand() {
    const I = this.g.input, main = this.g.mainHand === 'left' ? I.left : I.right, off = main === I.left ? I.right : I.left;
    return off.connected ? off : main;
  }
  skipButton() { return this.skipHand().buttons.trigger; }

  // ---------------------------------------------------------------- playback
  start(clip) {
    const g = this.g, xr = !!g.input.xr;
    if (g.viewOverride) g.endViewOverride();           // (a catching view still up: back where you play from first)
    this.clip = clip;
    this.rt = clip.start; this.active = true; this.pending = null;
    this.marks.played = true;                           // one replay a ball
    this.stopReason = null;
    // What to put back afterwards.
    this.saved = {
      vis: this.humans.map((h) => h.root.visible),
      extras: this.extras.map((x) => x.visible),
      bat: { v: g.batMesh.visible, p: g.batMesh.position.clone(), q: g.batMesh.quaternion.clone() },
      ball: { v: g.ballView.visible, p: g.ballView.mesh.position.clone(), q: g.ballView.mesh.quaternion.clone(), s: g.ballView.mesh.scale.x },
      pieces: this.pieces.map((m) => [m.position.clone(), m.quaternion.clone()]),
      fov: g.camera.fov,
    };
    // Your figure: re-played with the shot as it turned out, a few poses a
    // frame while the camera is still behind the bowler; the first 0.8 s keep
    // the poses that were recorded live. All the replay asks of the body
    // (PlayerBodyView): resolveBegin(t0, t1) -> job | null (it saves the live
    // figure), resolveStep(job, count, write) -> true when done (write(t, h)
    // for each pose from t0 on), resolveEnd(job) (puts the live figure back);
    // it reads job.t0 and job.t (the time of the last pose made).
    this.job = null;
    const pb = g.playerBody;
    if (clip.playerBatting && pb && pb.resolveBegin) {
      const k = this.humans.indexOf(pb.actor.h);
      const job = k >= 0 ? pb.resolveBegin(Math.min(clip.start + 0.8, clip.key - 0.6), clip.end) : null;
      if (job) this.job = { job, k };
    }
    // Nothing but a small label low in the corner for the first moments (the UI hides its panels while a replay is on).
    g.ui.clearHints?.();
    g.ui.prompt('', 0);
    setLabel(this.label, 'REPLAY', xr ? `off-hand (${this.skipHand().hand}) trigger: next ball` : 'Space skips · N: next ball');
    this.label.visible = true; this.label.material.opacity = 1; this.labelT = 0;
    if (g.ballView.trail) g.ballView.clearTrail?.();
    this.trailT = -Infinity;
    // The camera's whole move, and where your head is in the room (it moves the rig under that).
    this.path = this.layoutCamera(clip, xr ? CAM.xr : CAM.desk);
    // The camera's heading goes to the way you face when you play (the pitch's
    // direction in your room, game.roomForward), not to wherever your head
    // happens to point as the replay starts (still looking at the crease after
    // a dive, or round at the keeper): look where you always look and you see
    // the play. (Before the pitch has a direction in your room: your head.)
    this.ref = xr ? { p: g.input.headRef.p.clone(), f: g.roomForward ? g.roomForward.clone() : heading(g.input.headRef.q) } : null;
    this.look = null; this.camLog = []; this.camPrev = null;
    this.fade.cut(FADE_IN);
    this.apply(clip.start);
    this.moveCamera(clip.start, 0);
  }

  stop() {
    if (!this.active) return;
    const g = this.g, s = this.saved;
    this.active = false;
    if (this.job) { g.playerBody.resolveEnd(this.job.job); this.job = null; }
    this.humans.forEach((h, i) => { h.visible = s.vis[i]; });
    this.extras.forEach((x, i) => { x.visible = s.extras[i]; });
    g.batMesh.visible = s.bat.v; g.batMesh.position.copy(s.bat.p); g.batMesh.quaternion.copy(s.bat.q);
    g.ballView.setVisible(s.ball.v); g.ballView.mesh.position.copy(s.ball.p); g.ballView.mesh.quaternion.copy(s.ball.q); g.ballView.mesh.scale.setScalar(s.ball.s);
    this.pieces.forEach((m, i) => { m.position.copy(s.pieces[i][0]); m.quaternion.copy(s.pieces[i][1]); });
    this.vignette.visible = false;
    this.label.visible = false;
    if (!g.input.xr && s.fov != null && g.camera.fov !== s.fov) { g.camera.fov = s.fov; g.camera.updateProjectionMatrix(); }
    if (g.input.xr) g.setRig(g.rigState); else g.placeDesktopCamera();
    g.snapBat = true;
    this.fade.cut(FADE_IN);                             // back where you play from: in from dark
    if (g.session && g.session.afterReplay) g.session.afterReplay();
  }

  // The player skips it: this press of the button does nothing else.
  skip() {
    const b = this.skipButton();
    if (b.swallow) b.swallow();
    this.stopReason = 'skip';
    this.stop();
  }

  update(dt) {
    const g = this.g;
    if (!this.active) {
      const p = this.pending;
      if (!p) return;
      const ses = g.session;
      if (g.settings.replay === 'off' || !ses || g.state !== 'play') { this.pending = null; return; }
      if (g.ui.menuOpen) return;                        // (paused: it starts when the menu closes)
      // Due — or play is about to move on: it plays first. (A batting session
      // waits between balls, 'idle', for its replay; the due time moves on if
      // the stumps are broken a moment after the result: tailFor.)
      if (g.simTime >= this.dueAt() || (ses.state !== 'settle' && ses.state !== 'idle')) {
        const clip = this.plan();
        if (clip) this.start(clip); else this.pending = null;
      }
      return;
    }
    if (g.ui.menuOpen) { this.moveCamera(this.rt, 0); return; }   // paused with the game
    if (this.skipButton().down || g.input.desktop.took('Space') || g.input.desktop.took('Enter')) { this.skip(); return; }
    this.rt += dt;
    if (this.rt >= this.clip.end) { this.stopReason = 'end'; this.stop(); return; }
    this.stepJob();
    this.apply(this.rt);
    this.moveCamera(this.rt, dt);
  }

  // Your figure's shot, a few poses a frame (always ahead of what is on screen).
  stepJob() {
    const J = this.job;
    if (!J) return;
    const pb = this.g.playerBody, write = (t, h) => this.overwrite(J.k, t, h, pb.armsNow());
    let done = pb.resolveStep(J.job, 4, write);
    while (!done && J.job.t >= J.job.t0 - 0.05 && J.job.t < this.rt + 0.15) done = pb.resolveStep(J.job, 1, write);
    if (done) { pb.resolveEnd(J.job); this.job = null; }
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
    g.ballView.placeShadow?.(bm.position);
    // the hit ball's trail grows again with the replayed ball (from nothing if the replay went back)
    if (t < (this.trailT ?? -Infinity)) g.ballView.clearTrail?.();
    this.trailT = t;
    if (B[a + 8] > 1.5 && g.settings && g.settings.trail) g.ballView.trail?.add?.(bm.position);
    a += 9; b += 9;
    lerpTo(B, a, b, k, g.batMesh.position, g.batMesh.quaternion); g.batMesh.visible = B[a + 7] > 0.5;
    a += 8; b += 8;
    const sa = this.slotAt(i0) * 2, sb = this.slotAt(i1) * 2, A = this.arms;
    for (let n = 0; n < this.humans.length; n++) {
      const h = this.humans[n], vis = B[a] > 0.5;
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
        // (your figure's arms as long as they were, between the same two frames as its joints)
        if (n === this.armK) { _arms[0] = mix(A[sa], A[sb], k); _arms[1] = mix(A[sa + 1], A[sb + 1], k); g.playerBody.setArms(_arms); }
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

  // ---------------------------------------------------------------- the camera
  // Lay out the camera's move for the clip from the recorded ball.
  layoutCamera(clip, lim) {
    const dt = 1 / RATE, n = Math.max(2, Math.ceil((clip.end - clip.start) / dt) + 1);
    const base = cameraBase(PITCH.bowlingStumpsZ, 1);
    const ball = (i, o) => {
      const t = Math.min(clip.end, clip.start + i * dt);
      this.ballAt(t, _v);
      o.x = _v.x; o.y = _v.y; o.z = _v.z;
      return this.buf[this.slotAt(this.find(t)) * this.stride + 7 + 8] > 0.5;
    };
    const key = clamp(Math.round((clip.key - clip.start) / dt), 0, n);
    const dead = clip.dead != null ? clamp(Math.round((clip.dead - clip.start) / dt), key, n) : n;
    // the striker's side of the stumps: your head when you bat (recorded), else a right-hander's
    const strikerX = clip.playerBatting ? this.buf[this.slotAt(this.find(clip.key)) * this.stride] : -0.4;
    return planCamera({ n, dt, ball, key, dead, strikerX, base, face: { x: 0, z: PITCH.battingStumpsZ - PITCH.poppingOffset }, centerZ: PITCH.centerZ, lim });
  }

  // Put the camera (in the headset: you) where the path is at replay time t.
  moveCamera(t, dt) {
    const g = this.g, c = cameraAt(this.path, t - this.clip.start, _cam);
    const prev = this.camPrev;
    const speed = prev && dt > 0 ? Math.hypot(c.x - prev.x, c.z - prev.z) / dt : 0;
    const turn = prev && dt > 0 ? Math.abs(c.yaw - prev.yaw) / dt : 0;
    const cp = this.camPrev || (this.camPrev = { x: 0, z: 0, yaw: 0 });          // (no allocation per frame)
    cp.x = c.x; cp.z = c.z; cp.yaw = c.yaw;
    const bm = g.ballView.mesh.position;
    if (g.input.xr) {
      // The rig carries the point of the room your head was at when the replay
      // began to the camera, and turns the way you were facing to its heading;
      // from there your own head moves and looks about as it likes. Level
      // always: position and yaw only.
      const ref = this.ref;
      const r = computeRigFacing(ref.p, ref.f, c.x, c.z, Math.sin(c.yaw), Math.cos(c.yaw));
      g.rig.position.set(r.x, c.y - ref.p.y, r.z);
      g.rig.rotation.set(0, r.yaw, 0);
      g.rig.updateMatrixWorld(true);
      g.input.refreshHeadWorld();
      // Comfort vignette while the view is moving or turning.
      const vg = this.vignette;
      vg.material.opacity = clamp(Math.max((speed - 0.8) / 6, (turn - 0.35) / 1.4), 0, 0.8);
      vg.visible = vg.material.opacity > 0.02;
    } else {
      // A monitor's camera also tilts to the ball (eased), through one lens.
      if (g.camera.fov !== DESK_FOV) { g.camera.fov = DESK_FOV; g.camera.updateProjectionMatrix(); }
      const want = _v.set(0, 1.0, PITCH.battingStumpsZ - PITCH.poppingOffset);
      if (t >= this.clip.key && g.ballView.visible) want.copy(bm);
      const pitch = Math.atan2(want.y - c.y, Math.max(3, Math.hypot(want.x - c.x, want.z - c.z)));
      this.look = this.look == null ? pitch : this.look + (pitch - this.look) * Math.min(1, dt * 5);
      g.camera.position.set(c.x, c.y, c.z);
      const ch = Math.cos(this.look);
      g.camera.lookAt(_v2.set(c.x + Math.sin(c.yaw) * ch, c.y + Math.sin(this.look), c.z + Math.cos(c.yaw) * ch));
      g.camera.updateMatrixWorld(true);
    }
    // The ball is drawn at least a minimum size from where the camera is (as it is live from where you stand).
    if (g.settings.ballBoost && g.ballView.visible) {
      const d = Math.hypot(bm.x - c.x, bm.y - c.y, bm.z - c.z);
      g.ballView.mesh.scale.setScalar(clamp(d * Math.tan((CONFIG.render.ballMinAngleDeg * Math.PI) / 360) / CONFIG.ball.radius, 1, 2.2));
    }
    // What the camera did (for the harness and the tests).
    if (dt > 0 || !this.camLog.length) this.camLog.push({ t: this.rt, x: c.x, y: c.y, z: c.z, yaw: c.yaw, bx: bm.x, by: bm.y, bz: bm.z, ball: t >= this.clip.key && g.ballView.visible });
  }

  // How the camera moved in the replay that is playing (or the last one).
  camStats() { return pathStats(this.camLog || []); }

  // Keep the vignette, the fade and the label in front of your eyes (after
  // the eye pose is known). Called every frame, replay or not.
  placeOverlays(eye, dt) {
    this.fade.update(eye, dt);
    const v = this.vignette;
    if (v.visible) { v.position.copy(eye.p); v.quaternion.copy(eye.q); }
    const L = this.label;
    if (L.visible && this.active) {
      // Up for LABEL_SECS, then gone (it would sit over the replayed run-up); the skip still works.
      this.labelT += dt;
      L.material.opacity = clamp(1 - (this.labelT - LABEL_SECS) / LABEL_FADE, 0, 1);
      if (L.material.opacity <= 0) L.visible = false;
    }
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

// The way a head faces on the ground (unit Vec3), steady even when it looks
// steeply down or up: its forward, plus its crown (which points the same way
// when the chin is down).
function heading(q) {
  const f = new Vec3(0, 0, -1).applyQuat(q), u = new Vec3(0, 1, 0).applyQuat(q);
  const s = f.y < 0 ? 1 : -1;
  const out = new Vec3(f.x + s * u.x, 0, f.z + s * u.z);
  if (out.lengthSq() < 1e-8) return headForward(q);
  return out.normalize();
}

// The view comes in from dark whenever the game moves you somewhere else at
// once (a replay starting or ending, back to the top of your mark): a
// head-locked black screen that clears over `sec` real seconds. (fadeOut:
// first down to dark, for a skip to the next ball.)
export class ViewFade {
  constructor(scene) {
    const m = this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, depthTest: false, depthWrite: false, opacity: 0 }));
    m.geometry.translate(0, 0, -0.11);
    m.renderOrder = 40;
    m.frustumCulled = false;
    m.visible = false;
    scene.add(m);
    this.left = 0; this.sec = 1;
    this.outSec = 0; this.outT = 0;
  }
  cut(sec = FADE_IN) { this.sec = sec; this.left = sec; this.outSec = 0; }
  // The other way: from where it is now to dark over `sec` real seconds, and
  // dark it stays until cut() brings the view back in (a skip to the next
  // ball: everyone is put in place while it is dark).
  fadeOut(sec) { const a = this.level; this.outSec = sec; this.outT = a * sec; }
  get fadingOut() { return this.outSec > 0; }
  get dark() { return this.outSec > 0 && this.outT >= this.outSec; }
  get level() { if (this.outSec > 0) return Math.min(1, this.outT / this.outSec); return this.left > 0 ? this.left / this.sec : 0; }
  update(eye, dt) {
    const m = this.mesh, a = this.level;
    m.visible = a > 0.01;
    if (m.visible) { m.material.opacity = a * a * (3 - 2 * a); m.position.copy(eye.p); m.quaternion.copy(eye.q); }
    if (this.outSec > 0) this.outT = Math.min(this.outSec, this.outT + dt);
    else if (this.left > 0) this.left = Math.max(0, this.left - dt);
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
  // clear out to ~32° from the centre of the view, dark by ~58° (the plane is
  // 4.2 m wide, 1 m away: far enough that both eyes see the same ring; at
  // 0.12 m each eye saw it ~15° toward the other, its dark edge 20° from the
  // centre on the outer side of each eye)
  const gr = x.createRadialGradient(128, 128, 0, 128, 128, 128);
  gr.addColorStop(0, 'rgba(0,0,0,0)');
  gr.addColorStop(0.3, 'rgba(0,0,0,0)');
  gr.addColorStop(0.78, 'rgba(0,0,0,1)');
  gr.addColorStop(1, 'rgba(0,0,0,1)');
  x.fillStyle = gr; x.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.5 / 0.12, 0.5 / 0.12), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, opacity: 0 }));
  m.geometry.translate(0, 0, -1.0);
  m.renderOrder = 20;
  m.frustumCulled = false;
  m.visible = false;
  return m;
}


// The small "REPLAY · off-hand trigger skips" tag.
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
