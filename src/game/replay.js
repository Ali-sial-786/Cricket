// Replays: every frame of play is recorded (ball, every figure's pose, the
// bats, the stumps, your head) and the ball just played can be shown again
// while the game is frozen, cut like a broadcast (src/game/replayDirector.js):
//
//   * which balls: Settings -> Replays: highlights (the default: wickets,
//     boundaries, close calls), every ball, or off; any ball can be watched
//     again on demand between balls (right B; X on a monitor);
//   * the cut: a few fixed angles chosen from what happened (behind the arm,
//     on the line of the stumps, side-on at the crease, a tracking spot picked
//     from the ball's flight), each turning to keep the ball near the middle
//     of the view; real speed for the build-up, slow motion through the key
//     moment, a freeze as a run-out's stumps break; cuts go through the view
//     fading down and back in;
//   * the off-hand trigger (the hand without the bat / the ball, see
//     skipHand; Space on a monitor) skips it, and that press does nothing
//     else; nothing but the skip or its own end stops it (an open menu only
//     pauses it);
//   * order with reviews: ball -> appeal / DRS / third umpire (unchanged) ->
//     verdict -> the ball's replay -> the result banner again -> next ball.
//     The recording stops TAIL s into a review, so the ball is still there
//     when the review is over;
//   * in the headset the replay moves you (the rig): position and yaw only,
//     each angle a fixed spot, with a comfort vignette while the view turns;
//     you can look around. The view comes in from dark (ViewFade) when it puts
//     you there, at each cut and when it puts you back, as it does whenever
//     the game moves you.
import * as THREE from 'three';
import { font, rr } from '../ui/theme.js';
import { Humanoid } from '../render/humanoid.js';
import { headForward, yawOfForward, wrapAngle } from './calibration.js';
import { Vec3, hypot2, hypot3 } from '../physics/math.js';
import { PITCH } from '../physics/pitch.js';
import { CONFIG } from '../config.js';
import { pathStats, replayAt, tailFor, TAIL } from './replayFraming.js';
import { classify, direct, planAt, replayMode, wants, missBy, DIRECTOR } from './replayDirector.js';
import { decisionPending } from './quickSkip.js';
export { TAIL, tailFor };

const RATE = 90;                 // recorded frames per second (max): every frame at 72 and 90 Hz
const SECONDS = 24;              // ring buffer length (a ball can be live for 20 s)
const CAP = RATE * SECONDS;
const KEYS = 32;                 // the ball's exact moments (bat, bounce, stumps) kept beside the frames
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _cam = {}, _arms = [1, 1], _o = { x: 0, y: 0, z: 0 };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const FADE_IN = 0.22;            // real seconds the view takes to come in from dark after it was moved
const LABEL_SECS = 1.5, LABEL_FADE = 0.5;   // the REPLAY label: up this long (real s), then fades out over this
// The on-demand replay's card (the first time between balls in a game).
const AGAIN_HINT = { hand: 'R', button: 'b', label: 'REPLAY', sub: 'press B: see it again', key: 'X' };

export class Replay {
  constructor(game) {
    this.g = game;
    this.buf = null;
    this.times = new Float64Array(CAP);
    this.head = 0; this.count = 0; this.lastT = -1;
    this.keyT = new Float64Array(KEYS).fill(-1); this.keyP = new Float32Array(KEYS * 3); this.keyHead = 0;
    this.marks = {};
    this.active = false;
    this.pending = null;
    this.vignette = buildVignette();
    game.scene.add(this.vignette);
    this.fade = new ViewFade(game.scene);
    this.label = buildLabel();
    game.scene.add(this.label);
    this.slowTag = buildSlowTag();
    game.scene.add(this.slowTag);
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

  // A physics event (game.onPhysicsEvent): the ball's exact place at the bat,
  // a bounce or the stumps, kept beside the frames so that slow motion shows
  // the ball touching the bat / the pitch instead of cutting the corner
  // between two frames 1/72 s apart (~0.4 m at 30 m/s); and the moments the
  // director reads (an edge, over the rope).
  event(e) {
    const m = this.marks;
    if (e.type === 'bat' && m.release != null && m.edge == null) m.edge = !!e.isEdge;
    if (e.type === 'boundary' && m.release != null && m.cross == null) m.cross = e.t;
    if ((e.type === 'bat' || e.type === 'bounce' || e.type === 'wicket') && e.pos && !this.active) {
      const k = this.keyHead; this.keyHead = (k + 1) % KEYS;
      this.keyT[k] = e.t; this.keyP[k * 3] = e.pos.x; this.keyP[k * 3 + 1] = e.pos.y; this.keyP[k * 3 + 2] = e.pos.z;
    }
  }

  // While the ball is live (game.recordForReplay): the field's moments the
  // director reads (read only: Fielding's own state).
  observe(ses, t) {
    const m = this.marks;
    if (ses.state === 'review' && m.review == null) m.review = t;
    const L = ses.field && ses.field.logic;
    if (!L) return;
    if (L.dropped && m.dropT == null) m.dropT = t;
    if (L.throwArrived && m.throwAt == null) { m.throwAt = L.throwArrived.t ?? t; m.direct = !!L.throwArrived.direct; }
    if (L.overthrow && m.overthrow == null) m.overthrow = t;
    if (m.diveT == null && m.hit != null) {
      const F = L.fielders;
      for (let i = 0; i < F.length; i++) { const a = F[i].action; if (a && a.dive && a.success && a.t0 > m.hit) { m.diveT = a.t0; break; } }
    }
  }

  // The session's result for the ball (its finish()): what the director needs.
  note(res, outcome) {
    const m = this.marks;
    if (m.release == null || !res) return;
    m.res = { kind: res.kind, runs: res.runs, closeCall: res.closeCall, margin: res.margin, padded: !!res.padded, backInTime: !!res.backInTime, shyMissed: !!res.shyMissed, overthrows: res.overthrows || 0 };
    m.out = { wicket: outcome ? outcome.wicket : null, boundary: outcome ? outcome.boundary || 0 : 0 };
  }

  // ---------------------------------------------------------------- record
  record(t) {
    if (this.active) return;
    if (!this.buf) this.layout();
    if (Humanoid.all.length !== this.humans.length) this.layout();
    if (t < this.lastT) { this.count = 0; this.keyT.fill(-1); }    // time went backwards (new game)
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
    // (indexed loops: ~500 bones a frame, and no iterator garbage when this is not optimised)
    for (let k = 0; k < this.humans.length; k++) {
      const h = this.humans[k], r = h.root, bl = h.boneList;
      B[o++] = (h.replayVisible ?? r.visible) ? 1 : 0;
      o = put(B, o, r.position, r.quaternion); B[o++] = r.scale.x;
      const hp2 = h.bones.hips.position; B[o++] = hp2.x; B[o++] = hp2.y; B[o++] = hp2.z;
      // (THREE.Quaternion's own fields, not its x/y/z/w getters: ~2000 reads a frame, each a call
      // while this runs below the top tier)
      for (let i = 0; i < bl.length; i++) { const q = bl[i].quaternion; B[o++] = q._x; B[o++] = q._y; B[o++] = q._z; B[o++] = q._w; }
    }
    for (let k = 0; k < this.extras.length; k++) { const x = this.extras[k]; o = put(B, o, x.position, x.quaternion); B[o++] = x.visible ? 1 : 0; }
    for (let k = 0; k < this.pieces.length; k++) { const m = this.pieces[k]; o = put(B, o, m.position, m.quaternion); }
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

  // ---------------------------------------------------------------- the story and the cut
  // What happened to the ball just finished (replayDirector.js classify).
  whatHappened() {
    const m = this.marks, r = m.res || {}, o = m.out || {};
    let nearMiss = null, behind = false;
    if (this.count && m.release != null) {
      if (m.hit == null && !r.padded) nearMiss = missBy(this.passAt(m.release));
      if (m.edge && m.hit != null) for (let t = m.hit; t < m.hit + 1.5; t += 0.05) { if (this.tapeBall(t, _o) && _o.z > 1.5) { behind = true; break; } }
    }
    return classify({ res: r, wicket: o.wicket, boundary: o.boundary, review: m.review != null, edge: !!m.edge, behind, nearMiss,
      dropped: m.dropT != null, dive: m.diveT != null, direct: !!m.direct, overthrow: m.overthrow != null, brk: m.break != null });
  }

  // The ball as it passed the batter's stumps (x, y), or null.
  passAt(release) {
    let px = 0, py = 0, pz = -99, ok = false;
    for (let i = Math.max(0, this.find(release)); i < this.count; i++) {
      const o = this.slotAt(i) * this.stride + 7, B = this.buf;
      if (this.timeAt(i) < release + 0.05 || B[o + 8] < 0.5) { ok = false; continue; }
      const x = B[o], y = B[o + 1], z = B[o + 2];
      if (ok && pz < PITCH.battingStumpsZ && z >= PITCH.battingStumpsZ) { const k = (PITCH.battingStumpsZ - pz) / Math.max(1e-6, z - pz); return { x: px + (x - px) * k, y: py + (y - py) * k }; }
      px = x; py = y; pz = z; ok = true;
      if (this.timeAt(i) > release + 2.5) break;
    }
    return null;
  }

  // The cut for the ball just finished (replayDirector.js direct), or null.
  plan() {
    const m = this.marks;
    if (m.release == null || !this.count) return null;
    const first = this.timeAt(0), last = this.timeAt(this.count - 1);
    if (m.release < first || last - m.release < 0.4) return null;
    if (!m.story) { const s = this.whatHappened(); m.story = s.story; m.tier = s.tier; }
    const arrive = this.arrival(m.release);
    const M = { release: m.release, arrive, hit: m.hit, pad: m.pad, wicket: m.wicket, brk: m.break, brkEnd: m.breakEnd, caught: m.caught, held: m.held,
      dropT: m.dropT, diveT: m.diveT, throwAt: m.throwAt, cross: m.cross, dead: m.dead };
    const tape = { first, last, ball: (t, o) => this.tapeBall(t, o), bodies: (t) => this.bodiesAt(t), figure: (k, t, o) => this.figureAt(k, t, o) };
    const p = direct({ story: m.story, tier: m.tier, m: M, tape, xr: !!this.g.input.xr });
    if (p) p.arrive = arrive;
    return p;
  }

  // When the ball first got to the batter's end of the pitch after the release (null: never on the tape).
  arrival(release) {
    for (let i = Math.max(0, this.find(release)); i < this.count; i++) {
      const o = this.slotAt(i) * this.stride + 7, t = this.timeAt(i);
      if (t > release + 0.05 && this.buf[o + 8] > 0.5 && this.buf[o + 2] > -1.6) return t;
    }
    return null;
  }

  // The figures standing at tape time t, as { a: top of the head, b: hips, c: the ground } (for the camera's clearance).
  bodiesAt(t) {
    const out = [], B = this.buf, i = this.find(t);
    if (i < 0) return out;
    let o = this.slotAt(i) * this.stride + 7 + 9 + 8;
    for (let k = 0; k < this.humans.length; k++, o += this.hStride) {
      if (B[o] < 0.5) continue;
      const x = B[o + 1], y = B[o + 2], z = B[o + 3], s = B[o + 8] || 1;
      out.push({ k, a: { x, y: y + 1.85 * s, z }, b: { x, y: y + 0.95 * s, z }, c: { x, y: y + 0.05, z } });
    }
    return out;
  }

  // Figure k's place on the ground at tape time t (between frames), into out {x, y, z}; true if he was drawn.
  figureAt(k, t, out) {
    const i0 = this.find(t), i1 = Math.min(this.count - 1, i0 + 1);
    if (i0 < 0 || k < 0 || k >= this.humans.length) return false;
    const t0 = this.timeAt(i0), t1 = this.timeAt(i1), u = t1 > t0 ? clamp((t - t0) / (t1 - t0), 0, 1) : 0;
    const off = 7 + 9 + 8 + k * this.hStride, a = this.slotAt(i0) * this.stride + off, b = this.slotAt(i1) * this.stride + off, B = this.buf;
    out.x = mix(B[a + 1], B[b + 1], u); out.y = mix(B[a + 2], B[b + 2], u); out.z = mix(B[a + 3], B[b + 3], u);
    return B[a] > 0.5;
  }

  // The ball is dead and its result is up (the session has just gone to
  // 'settle'): what happened decides whether it gets a replay (Settings ->
  // Replays); if it does, it starts once TAIL s of aftermath are on the tape,
  // and a moment after a review's verdict (replayFraming.js replayAt).
  schedule(t) {
    const m = this.marks;
    if (m.release == null || m.played) return false;
    if (m.dead == null) m.dead = t;
    const s = this.whatHappened();
    m.story = s.story; m.tier = s.tier;
    if (!wants(replayMode(this.g.settings), s.tier)) return false;
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

  // The last ball again, on demand: between balls (the result, or batting
  // while the field walks back), never in an appeal / review, a menu or a skip.
  againReady() {
    const g = this.g, s = g.session, m = this.marks;
    if (this.active || this.pending || g.state !== 'play' || !s || s.done || g.ui.menuOpen || (g.quickSkip && g.quickSkip.busy)) return false;
    if (m.release == null || m.dead == null || !this.count || decisionPending(s)) return false;
    return s.state === 'settle' || (!s.isBowling && s.state === 'idle');
  }

  // ---------------------------------------------------------------- playback
  start(plan, again = false) {
    const g = this.g, xr = !!g.input.xr, m = this.marks;
    if (g.viewOverride) g.endViewOverride();           // (a catching view still up: back where you play from first)
    this.path = plan; this.again = again;
    this.clip = { start: plan.start, end: plan.end, release: m.release, key: plan.arrive ?? plan.key ?? m.release + 0.6, dead: m.dead ?? null, playerBatting: !!m.playerBatting };
    this.u = 0; this.rt = plan.T[0]; this.active = true; this.pending = null; this.trailDt = 0;
    this.nextCut = 0; this.slowNow = false; this.shotNow = plan.S[0]; this.cheered = false;
    m.played = true;                                    // (its automatic replay is done; on demand it can be seen again)
    this.stopReason = null;
    // What to put back afterwards.
    this.saved = {
      vis: this.humans.map((h) => h.root.visible),
      extras: this.extras.map((x) => x.visible),
      bat: { v: g.batMesh.visible, p: g.batMesh.position.clone(), q: g.batMesh.quaternion.clone() },
      ball: { v: g.ballView.visible, p: g.ballView.mesh.position.clone(), q: g.ballView.mesh.quaternion.clone(), s: g.ballView.mesh.scale.x },
      pieces: this.pieces.map((p) => [p.position.clone(), p.quaternion.clone()]),
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
    const pb = g.playerBody, clip = this.clip;
    if (clip.playerBatting && pb && pb.resolveBegin) {
      const k = this.humans.indexOf(pb.actor.h);
      const job = k >= 0 ? pb.resolveBegin(Math.min(clip.start + 0.8, clip.key - 0.6), clip.end) : null;
      if (job) this.job = { job, k };
    }
    // Nothing but a small label low in the corner for the first moments (the
    // UI hides its panels while a replay is on). The result banner is kept for
    // after the replay; the stadium screen shows REPLAY meanwhile.
    const ui = g.ui;
    this.banner = !again && ui.promptText && ui.promptUntil - ui.clock > 0.2 ? { text: ui.promptText, color: ui.promptColor } : null;
    ui.clearHints?.();
    ui.prompt('', 0);
    if ('boardSting' in ui) ui.boardSting = null;
    setLabel(this.label, 'REPLAY', xr ? `off-hand (${this.skipHand().hand}) trigger: next ball` : 'Space skips · N: next ball');
    this.label.visible = true; this.label.material.opacity = 1; this.labelT = 0;
    this.slowTag.visible = false; this.slowTag.material.opacity = 0;
    if (g.ballView.trail) g.ballView.clearTrail?.();
    this.trailT = -Infinity;
    // The camera's heading goes to the way you face when you play (the pitch's
    // direction in your room, game.roomForward), not to wherever your head
    // happens to point as the replay starts (still looking at the crease after
    // a dive, or round at the keeper): look where you always look and you see
    // the play. (Before the pitch has a direction in your room: your head.)
    this.ref = xr ? { p: g.input.headRef.p.clone(), f: g.roomForward ? g.roomForward.clone() : heading(g.input.headRef.q) } : null;
    this.look = null; this.camLog = []; this.camPrev = null;
    this.fade.cut(DIRECTOR.inOut);
    g.sample?.('cam_whoosh', { gain: 0.45 });          // (a soft whoosh in: the game's own sounds are not played again)
    planAt(plan, 0, _cam);
    this.apply(this.rt);
    this.moveCamera(0);
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
    this.slowTag.visible = false;
    if (!g.input.xr && s.fov != null && g.camera.fov !== s.fov) { g.camera.fov = s.fov; g.camera.updateProjectionMatrix(); }
    if (g.input.xr) g.setRig(g.rigState); else g.placeDesktopCamera();
    g.snapBat = true;
    this.fade.cut(DIRECTOR.inOut);                      // back where you play from: in from dark (quickly)
    // The result banner after the replay (it played over the start of it); not after a skip.
    if (this.banner && this.stopReason === 'end') { g.ui.prompt('', 0); g.ui.prompt(this.banner.text, 2.0, this.banner.color); }
    this.banner = null;
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
      if (this.againReady()) {
        const b = g.input.right.buttons.b;
        if (b.down) { if (b.swallow) b.swallow(); const p = this.plan(); if (p) { this.start(p, true); return; } }
        // (a card for it, once a game, on a later ball than the skip card's)
        const cs = g.coachSeen;
        if (g.coach && cs && !cs.has('again') && g.session.state === 'settle') {
          if (this.coachSes !== g.session) { this.coachSes = g.session; this.skipCardBall = undefined; }
          if (!cs.has('skip')) this.skipCardBall = undefined;
          else if (this.skipCardBall === undefined) this.skipCardBall = this.marks.release;
          else if (this.skipCardBall !== this.marks.release) g.coach('again', [AGAIN_HINT], 3.5);
        }
      }
      const p = this.pending;
      if (!p) return;
      const ses = g.session;
      if (replayMode(g.settings) === 'off' || !ses || g.state !== 'play') { this.pending = null; return; }
      if (g.ui.menuOpen) return;                        // (paused: it starts when the menu closes)
      // Due — or play is about to move on: it plays first. (A batting session
      // waits between balls, 'idle', for its replay; the due time moves on if
      // the stumps are broken a moment after the result: tailFor.)
      if (g.simTime >= this.dueAt() || (ses.state !== 'settle' && ses.state !== 'idle')) {
        const plan = this.plan();
        if (plan) this.start(plan); else this.pending = null;
      }
      return;
    }
    const fade = this.fade, P = this.path, busy = !!(g.quickSkip && g.quickSkip.busy);
    if (g.ui.menuOpen) { this.trailDt = 0; if (fade.fadingOut && !busy) fade.cut(FADE_IN); this.moveCamera(0); return; }   // paused with the game
    if (this.skipButton().down || g.input.desktop.took('Space') || g.input.desktop.took('Enter')) { this.skip(); return; }
    this.u += dt;
    if (this.u >= P.len) { this.stopReason = 'end'; this.stop(); return; }
    // A cut: down to dark over its last moments, back in on the new angle; the end goes down to dark too.
    if (!busy) {
      const c = P.cuts[this.nextCut];
      if (c != null && this.u >= c * P.du) { fade.cut(DIRECTOR.cutIn); this.nextCut++; this.camPrev = null; }
      // (dark a frame before the cut: the last frame on the old angle is black, not 95%)
      else if (c != null && c * P.du - this.u <= DIRECTOR.cutOut) { if (!fade.fadingOut) fade.fadeOut(Math.max(0.014, c * P.du - this.u - 0.014)); }
      else if (c == null && P.len - this.u <= DIRECTOR.endOut && !fade.fadingOut) fade.fadeOut(Math.max(0.02, P.len - this.u));
    }
    planAt(P, this.u, _cam);
    const was = this.rt;
    this.rt = _cam.t; this.slowNow = _cam.rate < 0.99; this.shotNow = _cam.shot;
    // The trail's clock runs on the tape (its bright head is the last 0.25 s of the ball's flight, slowed
    // with it); a cut that skips part of the flight grows the skipped part first (not a chord across the arc).
    this.trailDt = Math.max(0, Math.min(0.1, this.rt - was));
    if (this.rt - was > 0.05) this.regrowTrail(was, this.rt);
    this.stepJob();
    this.apply(this.rt);
    this.moveCamera(dt);
    // A six: the ground goes up again as it lands in the stands (the look and the swell; no sound is played twice).
    const m = this.marks;
    if (P.story === 'six' && !this.cheered && m.cross != null && this.rt >= m.cross) {
      this.cheered = true;
      try { g.env && g.env.crowdReact && g.env.crowdReact('six', 1, g.ballView.mesh.position); } catch { /* (the stands are optional) */ }
      try { if (g.cheer) g.cheer(0.9); } catch { /* (the crowd's swell is optional) */ }
    }
  }

  // Your figure's shot, a few poses a frame (always ahead of what is on screen;
  // a jump ahead in the cut is caught up a few poses a frame, never all at once).
  stepJob() {
    const J = this.job;
    if (!J) return;
    const pb = this.g.playerBody, write = J.write || (J.write = (t, h) => this.overwrite(J.k, t, h, pb.armsNow()));   // (made once a replay)
    let done = pb.resolveStep(J.job, 4, write), extra = 12;
    while (!done && extra-- > 0 && J.job.t >= J.job.t0 - 0.05 && J.job.t < this.rt + 0.15) done = pb.resolveStep(J.job, 1, write);
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
    this.ballKey(t, t0, t1, B, a, b, bm.position);
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
        const bl = h.boneList;
        for (let j = 0; j < bl.length; j++) {
          _q.set(B[o], B[o + 1], B[o + 2], B[o + 3]); _q2.set(B[p], B[p + 1], B[p + 2], B[p + 3]);
          bl[j].quaternion.slerpQuaternions(_q, _q2, k);
          o += 4; p += 4;
        }
        // (your figure's arms as long as they were, between the same two frames as its joints)
        if (n === this.armK) { _arms[0] = mix(A[sa], A[sb], k); _arms[1] = mix(A[sa + 1], A[sb + 1], k); g.playerBody.setArms(_arms); }
        r.updateMatrixWorld(true);
        h.syncShadow();
      }
      a += this.hStride; b += this.hStride;
    }
    for (let j = 0; j < this.extras.length; j++) { const x = this.extras[j]; lerpTo(B, a, b, k, x.position, x.quaternion); x.visible = B[a + 7] > 0.5; a += 8; b += 8; }
    for (let j = 0; j < this.pieces.length; j++) { lerpTo(B, a, b, k, this.pieces[j].position, this.pieces[j].quaternion); a += 7; b += 7; }
  }

  // The hit ball's trail over tape time (t0, t1), as it grew live (the tape's ball flag 2), at a cut that skips ahead.
  regrowTrail(t0, t1) {
    const g = this.g, tr = g.ballView.trail;
    if (!tr || !tr.add || !(g.settings && g.settings.trail)) return;
    for (let t = t0 + 1 / 90; t < t1; t += 1 / 90) {
      const i = this.find(t);
      if (i < 0 || this.buf[this.slotAt(i) * this.stride + 7 + 8] < 1.5) continue;
      this.tapeBall(t, _o); _v2.set(_o.x, _o.y, _o.z); tr.add(_v2);
    }
  }

  // The ball between two frames that have one of its exact moments between
  // them (a bat, a bounce, the stumps): through that point, not across the corner.
  ballKey(t, t0, t1, B, a, b, out) {
    if (!(t1 > t0) || B[a + 8] < 0.5 || B[b + 8] < 0.5) return false;
    const KT = this.keyT, KP = this.keyP;
    for (let j = 0; j < KEYS; j++) {
      const kt = KT[j];
      if (!(kt > t0 && kt < t1)) continue;
      const x = KP[j * 3], y = KP[j * 3 + 1], z = KP[j * 3 + 2];
      if (t <= kt) { const u = (t - t0) / (kt - t0); out.set(mix(B[a], x, u), mix(B[a + 1], y, u), mix(B[a + 2], z, u)); }
      else { const u = (t - kt) / (t1 - kt); out.set(mix(x, B[b], u), mix(y, B[b + 1], u), mix(z, B[b + 2], u)); }
      return true;
    }
    return false;
  }

  // The ball at tape time t (into out {x, y, z}); true if it was drawn.
  tapeBall(t, out) {
    const i0 = this.find(t), i1 = Math.min(this.count - 1, i0 + 1);
    const t0 = this.timeAt(i0), t1 = this.timeAt(i1);
    const k = t1 > t0 ? clamp((t - t0) / (t1 - t0), 0, 1) : 0;
    const a = this.slotAt(i0) * this.stride + 7, b = this.slotAt(i1) * this.stride + 7, B = this.buf;
    out.x = mix(B[a], B[b], k); out.y = mix(B[a + 1], B[b + 1], k); out.z = mix(B[a + 2], B[b + 2], k);
    if (this.ballKey(t, t0, t1, B, a, b, _v)) { out.x = _v.x; out.y = _v.y; out.z = _v.z; }
    return B[a + 8] > 0.5;
  }
  ballAt(t, out) { this.tapeBall(t, _o); return out.set(_o.x, _o.y, _o.z); }

  // ---------------------------------------------------------------- the camera
  // Put the camera (in the headset: you) where the plan is now (_cam, from planAt).
  moveCamera(dt) {
    const g = this.g, c = _cam;
    const prev = this.camPrev;
    const speed = prev && dt > 0 ? hypot2(c.x - prev.x, c.z - prev.z) / dt : 0;
    const turn = prev && dt > 0 ? Math.abs(c.yaw - prev.yaw) / dt : 0;
    const cp = this.camPrev || (this.camPrev = { x: 0, z: 0, yaw: 0 });          // (no allocation per frame)
    cp.x = c.x; cp.z = c.z; cp.yaw = c.yaw;
    const bm = g.ballView.mesh.position;
    if (g.input.xr) {
      // The rig carries the point of the room your head was at when the replay
      // began to the camera, and turns the way you were facing to its heading;
      // from there your own head moves and looks about as it likes. Level
      // always: position and yaw only.
      // (calibration.js computeRigFacing, inline: nothing made a frame)
      const ref = this.ref, yaw = Math.atan2(-Math.sin(c.yaw), -Math.cos(c.yaw)) - yawOfForward(ref.f), cy = Math.cos(yaw), sy = Math.sin(yaw);
      g.rig.position.set(c.x - (ref.p.x * cy + ref.p.z * sy), c.y - ref.p.y, c.z - (-ref.p.x * sy + ref.p.z * cy));
      g.rig.rotation.set(0, wrapAngle(yaw), 0);
      g.rig.updateMatrixWorld(true);
      g.input.refreshHeadWorld();
      // Comfort vignette while the view is moving or turning.
      const vg = this.vignette;
      vg.material.opacity = clamp(Math.max((speed - 0.8) / 6, (turn - 0.35) / 1.4), 0, 0.8);
      vg.visible = vg.material.opacity > 0.02;
    } else {
      // A monitor's camera also tilts to the ball (eased, in the plan), through each angle's lens.
      const sh = this.path.shots[c.shot], fov = (sh && sh.fov) || DIRECTOR.fov[sh ? sh.kind : 'arm'] || 36;
      if (g.camera.fov !== fov) { g.camera.fov = fov; g.camera.updateProjectionMatrix(); }
      g.camera.position.set(c.x, c.y, c.z);
      const ch = Math.cos(c.pitch);
      g.camera.lookAt(_v2.set(c.x + Math.sin(c.yaw) * ch, c.y + Math.sin(c.pitch), c.z + Math.cos(c.yaw) * ch));
      g.camera.updateMatrixWorld(true);
    }
    // The ball is drawn at least a minimum size from where the camera is (as it is live from where you stand).
    if (g.settings.ballBoost && g.ballView.visible) {
      const d = hypot3(bm.x - c.x, bm.y - c.y, bm.z - c.z);
      g.ballView.mesh.scale.setScalar(clamp(d * Math.tan((CONFIG.render.ballMinAngleDeg * Math.PI) / 360) / CONFIG.ball.radius, 1, 2.2));
    }
    // What the camera did (for the harness and the tests): real time, tape time, the shot.
    // (only when asked for: an object a frame otherwise)
    if (this.logCamera && (dt > 0 || !this.camLog.length)) this.camLog.push({ t: this.u, rt: this.rt, x: c.x, y: c.y, z: c.z, yaw: c.yaw, bx: bm.x, by: bm.y, bz: bm.z, ball: this.rt >= this.clip.release + 0.08 && g.ballView.visible, shot: c.shot, slow: this.slowNow });
  }

  // How the camera moved in the replay that is playing (or the last one; set logCamera first).
  camStats() { return pathStats(this.camLog || []); }

  // Keep the vignette, the label and the slow-motion tag in front of your eyes
  // (after the eye pose is known); the fade needs no pose (it covers the
  // whole view, in clip space). Called every frame, replay or not.
  placeOverlays(eye, dt) {
    this.fade.update(eye, dt);
    const v = this.vignette;
    if (v.visible) { v.position.copy(eye.p); v.quaternion.copy(eye.q); }
    const L = this.label, T = this.slowTag;
    if (L.visible && this.active) {
      // Up for LABEL_SECS, then gone (it would sit over the replayed run-up); the skip still works.
      this.labelT += dt;
      L.material.opacity = clamp(1 - (this.labelT - LABEL_SECS) / LABEL_FADE, 0, 1);
      if (L.material.opacity <= 0) L.visible = false;
    }
    // The slow-motion tag: in while the replay is slowed, out after (eased; no texture work).
    if (this.active || T.visible) {
      const want = this.active && this.slowNow ? 1 : 0;
      T.material.opacity = clamp(T.material.opacity + Math.sign(want - T.material.opacity) * dt * 5, 0, 1);
      T.visible = T.material.opacity > 0.01;
    }
    if (L.visible) this.placeTag(L, eye, 0);
    if (T.visible) this.placeTag(T, eye, L.visible ? L.userData.h * 1.25 : 0);
  }
  // Low and to the left, at the edge of the view; in the headset 0.6 m away,
  // about 20° left and 16° down; on a monitor the same place on the screen. up: m higher.
  placeTag(L, eye, up) {
    const cam = this.g.camera, xr = !!this.g.input.xr;
    const ty = xr ? 0.36 : Math.tan((cam.fov * Math.PI) / 360), tx = xr ? 0.42 : ty * cam.aspect;
    const d = 0.6, k = xr ? 1 : ty / 0.7;
    L.position.set(-tx * d * 0.86 + L.userData.w * k / 2, -ty * d * 0.84 + (L.userData.h / 2 + up) * k, -d).applyQuaternion(eye.q).add(eye.p);
    L.quaternion.copy(eye.q);
    L.scale.setScalar(k);
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
// once (a replay starting, cutting or ending, back to the top of your mark):
// a black screen that clears over `sec` real seconds. (fadeOut: first down to
// dark, for a skip to the next ball, or a replay's cut.) It is drawn in clip
// space, straight over the whole picture of each eye: it needs no eye pose,
// so the frame a replay moves you in is dark everywhere (placed at the eye
// it lagged a frame behind a turned head: a lit wedge).
export class ViewFade {
  constructor(scene) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0 } },
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform float uOpacity; void main() { gl_FragColor = vec4(0.0, 0.0, 0.0, uOpacity); }',
      transparent: true, depthTest: false, depthWrite: false,
    });
    const m = this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
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
    if (m.visible) m.material.uniforms.uOpacity.value = a * a * (3 - 2 * a);
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
  // The broadcast replay tag: the word on a red slash, the skip control under it.
  const { canvas: c, tex } = m.userData, x = c.getContext('2d');
  const W = c.width, H = c.height;
  x.clearRect(0, 0, W, H);
  x.fillStyle = 'rgba(8,14,26,0.66)';
  rr(x, 0, 0, W, H, 18); x.fill();
  x.font = font(900, 38);
  const tw = x.measureText(title).width + 64;
  x.save(); rr(x, 0, 0, W, H, 18); x.clip();
  x.beginPath(); x.moveTo(0, 0); x.lineTo(tw + 14, 0); x.lineTo(tw, 52); x.lineTo(0, 52); x.closePath();
  const gr = x.createLinearGradient(0, 0, tw, 0); gr.addColorStop(0, '#a30f26'); gr.addColorStop(1, '#ef2b45');
  x.fillStyle = gr; x.fill();
  x.restore();
  x.fillStyle = '#ffffff'; x.beginPath(); x.arc(24, 27, 7, 0, Math.PI * 2); x.fill();     // the "live" dot
  x.textBaseline = 'middle'; x.textAlign = 'left';
  x.fillText(title, 40, 28);
  x.fillStyle = 'rgba(232,238,245,0.88)'; x.font = font(600, 28);
  x.fillText(sub, 18, 74);
  tex.needsUpdate = true;
}

// The slow-motion tag, in the replay label's style (drawn once): a small dark
// pill with two red bars and the word, shown while the replay is slowed.
function buildSlowTag() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 48;
  const x = c.getContext('2d');
  x.fillStyle = 'rgba(8,14,26,0.66)'; rr(x, 0, 0, 256, 48, 14); x.fill();
  x.fillStyle = '#ef2b45'; x.fillRect(16, 13, 6, 22); x.fillRect(27, 13, 6, 22);
  x.fillStyle = 'rgba(232,238,245,0.92)'; x.font = font(800, 24); x.textBaseline = 'middle'; x.textAlign = 'left';
  x.fillText('SLOW MOTION', 46, 25);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const w = 0.075, h = w * 48 / 256;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, opacity: 0 }));
  m.userData = { w, h };
  m.renderOrder = 22;
  m.frustumCulled = false;
  m.visible = false;
  return m;
}
