// Your own body when you bat: the figure seen looking down (see-through),
// from behind, on a monitor and in replays.
//
// Three things are tracked and they are the truth: your head, your bat (the
// dominant controller) and your other hand. The body is solved from them
// every frame; no shot is chosen ahead of time and nothing plays on a clock:
//
//   1. ShotSense (shotSense.js) reads what the bat is doing: the phase of the
//      stroke from the bat's own angle and speed, soft weights over the shots
//      the AI batter has captures of, and how far a stroke is engaged.
//   2. Footwork (footwork.js) keeps planted feet under your head and steps
//      them (never slides them) when your head goes further than a body
//      reaches, with the stroke's footwork on top.
//   3. With no stroke the body is the side-on stance solved from the feet,
//      your head and your hands (BatterActor.solveBody): hips back, trunk to
//      the head, shoulders turned to the hands; right down, it kneels.
//   4. In a stroke the pelvis, trunk, shoulders, knees and back-foot pivot
//      come from the AI batter's captures for the weighted shots at the phase
//      YOUR bat is in (backlift pose when the bat is in the backlift, contact
//      pose at contact, the finish when the bat is there), placed so that the
//      head is on your head and the legs reach the planted feet; blended with
//      (3) by the engagement.
//   5. The gloves are put on the real bat's handle, the head looks where you
//      look, and nothing goes under the turf (Humanoid.groundGuard).
//
// One solver for live play and for replays: every frame's inputs are logged
// (with the solver's state now and then), and a replay re-solves the clip
// from them through the same code (resolve), so it shows the body you had.
import * as THREE from 'three';
import { BatterActor } from './actors.js';
import { ShotSense, FAMILIES, captureTime, SENSE } from './shotSense.js';
import { Footwork } from './footwork.js';
import { liftPole, steadyKnees, kneeWay } from './legs.js';
import { shotByName, shotsReady, poseShot } from './shots.js';
import { sstep, clamp, mix } from './anim.js';
import { PITCH } from '../physics/pitch.js';
import { CONFIG } from '../config.js';

const EYES = 0.11;                 // m: the eyes above the figure's head joint
const SOFT = 0.03;                 // m: the knees are never quite locked (the head joint this far under standing height)
const KNEEL_BAND = [0.11, 0.01];   // m: the head joint this far below an upright kneel's -> right down on the back knee; above (+) -> up
// Blade from its shoulder to its toe, along the bat's +Y from the grip point (m); leg axis to the blade's centre line at least.
const BLADE_TOP = CONFIG.bat.gripFromHandleTop - CONFIG.bat.handleLength, BLADE_TOE = BLADE_TOP - CONFIG.bat.bladeLength, LEG_CLEAR = 0.19;
const HIP_DOWN = 2.5;              // the pelvis moving down costs this many times moving along the ground (reachBoth)
const HAND_TOP = 0.105;            // m up the handle from the bottom hand to the top hand (actors.js HAND_GAP)
const KNEE_LOW = 0.3;              // m: a knee joint lower than this has its pad checked against the turf (kneesUp)
const KNEE_MIN = 0.12;             // knee joint above the turf at least (the pad's knee roll rests on it)
const SNAP_EVERY = 12;             // frames between saved solver states in the log
const LOOK_RATE = 7;               // rad/s: the head turns (and nods) at most this fast
const UPRIGHT = ['forward_defence', 'straight_drive', 'cover_drive', 'lofted_drive'];
const HALF_PI = Math.PI / 2, TAU = Math.PI * 2;
const NO_LEAN = [0, 0], NO_SHIFT = { along: 0, down: 0 };
const NB = 17;
const TRUNK = ['hips', 'spine', 'chest'], TRUNK_RATE = 10;     // rad/s: the captured trunk turns at most this fast (steadyTrunk)
const HIP_TWIST = [-0.6, 0.9];     // rad: the hips' turn from the way the feet point, at most (closed .. open; hipsToFeet)
const KNEE_RATE = 7;               // rad/s: a knee's bend direction turns at most this fast (kneesUp)
const SPINE_TWIST = 0.6;           // rad: of what the hips may not turn, the spine takes at most this much

const _ax = new THREE.Vector3(), _fc = new THREE.Vector3(), _Hj = new THREE.Vector3(), _bp = new THREE.Vector3(), _bq = new THREE.Quaternion();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);
const _P = new THREE.Vector3(), _yp = new THREE.Vector3(), _hf = new THREE.Vector3(), _kp = new THREE.Vector3();
const angDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; };
const yawOf = (q) => { _e.set(0, 0, 1).applyQuaternion(q); return Math.atan2(_e.x, _e.z); };
const v3 = () => new THREE.Vector3(), q4 = () => new THREE.Quaternion();

export class PlayerBodyView {
  constructor(scene) {
    this.actor = new BatterActor(scene, { team: 'home', seed: 3 });
    this.actor.bat.visible = false;     // the real player bat mesh is drawn by the game
    this.actor.stretchArms = true;      // your gloves are on your bat, always
    // A bat beyond the figure's reach (your arms and shoulders are not its): the trunk leans a little
    // after it, the pelvis hardly moves (no crouch you did not make), the arms lengthen for the rest.
    this.actor.leanMax = [0.2, 0.1];
    this.actor.reachLimit = { along: 0.08, down: 0.04 };
    this.sense = new ShotSense();
    this.feet = new Footwork();
    this.log = [];
    this.visible = false;
    this.actor.visible = false;
    this.pat = null;                    // each capture's footwork (see patterns())
    { // hip joints to the head joint, standing (model units)
      const h = this.actor.h; h.reset(); h.update();
      this.actor.trunkUp = (h.worldPos('head', v3()).y - h.worldPos('hipL', v3()).y) / h.root.scale.x;
    }
    // scratch
    this.N = { aL: v3(), aR: v3(), qL: q4(), qR: q4(), pL: v3(), pR: v3() };
    this.M = { H: v3(), hd: v3(), kL: v3(), kR: v3(), aL: v3(), aR: v3(), hL: v3(), hR: v3(), qL: q4(), qR: q4(), tL: v3(), tR: v3(), pL: v3(), pR: v3(), oL: v3(), oR: v3() };
    this.acc = { q: Array.from({ length: NB }, () => new THREE.Quaternion()), p: v3() };
    this.reset();
  }

  // Everything the solver remembers (plain data).
  reset() {
    this.sense.reset(); this.feet.reset();
    this.st = { u: {}, kneel: 0, kneelK: 0, kneelV: 0, toeR: 0, kd: { L: null, R: null }, trunk: null, turn: 0, rel: 0, relOk: false, look: 0, lookP: 0, lookN: 0, desk: null, n: 0, out: null, yield: { L: [0, 0], R: [0, 0] } };
    this.actor._tw = null; this.actor._eb = null;
    this.log.length = 0;
    this.gen = (this.gen || 0) + 1;     // (a replay re-solve begun before this has nothing left to make)
  }
  saveState() {
    const A = this.actor, eb = A._eb;
    return {
      sense: this.sense.save(), feet: this.feet.save(), st: structuredClone(this.st),
      tw: A._tw ? { L: A._tw.L, R: A._tw.R } : null,
      eb: eb ? { L: eb.L.toArray(), R: eb.R.toArray(), okL: eb.okL, okR: eb.okR } : null,
    };
  }
  loadState(s) {
    const A = this.actor;
    this.sense.load(s.sense); this.feet.load(s.feet); this.st = structuredClone(s.st);
    A._tw = s.tw ? { L: s.tw.L, R: s.tw.R } : null;
    A._eb = s.eb ? { L: new THREE.Vector3().fromArray(s.eb.L), R: new THREE.Vector3().fromArray(s.eb.R), okL: s.eb.okL, okR: s.eb.okR } : null;
  }

  // What the body is doing, for the harness and the debug overlay: "state/shot engage".
  shotLabel() {
    const o = this.st.out;
    return o ? (o.leader && o.engage > 0.15 ? o.leader : '-') : '-';
  }

  show(v) { this.visible = v; this.actor.visible = v; this.actor.bat.visible = false; }

  // head: your headset pose {p, q} (VR), or null on a monitor. extra: the
  // batting session's bodyState() ({ sweep, hit, crease }). off: your other
  // controller's position, or null.
  update(dt, t, batPos, batQuat, ball, head = null, extra = null, off = null) {
    const L = this.log, h = this.actor.h;
    if (L.length && t < L[L.length - 1].t) this.reset();
    const e = {
      t, dt, bp: { x: batPos.x, y: batPos.y, z: batPos.z }, bq: { x: batQuat.x, y: batQuat.y, z: batQuat.z, w: batQuat.w },
      head: head ? { p: { x: head.p.x, y: head.p.y, z: head.p.z }, q: { x: head.q.x, y: head.q.y, z: head.q.z, w: head.q.w } } : null,
      off: off ? { x: off.x, y: off.y, z: off.z } : null,
      ball: ball ? { x: ball.x, y: ball.y, z: ball.z } : null,
      extra: extra ? { sweep: extra.sweep || null, hit: extra.hit ? { t: extra.hit.t } : null, crease: extra.crease || null, live: extra.ball ? !!extra.ball.live : extra.live ?? null } : null,
      sc: h.root.scale.x,
    };
    if (this.st.n % SNAP_EVERY === 0 || !L.length) e.state = this.saveState();
    this.solve(e);
    e.arm = this.armsNow();
    L.push(e);
    while (L.length > 1400 || (L.length && t - L[0].t > 16)) L.shift();
    this.actor.bat.visible = false;
  }

  // Re-solve the figure over [t0, t1] for a replay, from the logged head, bat
  // and other-hand tracks, through the same solver (from a saved state, so it
  // is the body you had). write(t, h) stores each pose. The live figure is
  // put back as it was. Returns false if nothing was logged for the clip.
  resolve(t0, t1, write) {
    const job = this.resolveBegin(t0, t1);
    if (!job) return false;
    this.resolveStep(job, Infinity, write);
    this.resolveEnd(job);
    return job.n > 0;
  }
  // The same in slices, so a replay can spread the work over its first frames
  // instead of stopping the picture for it: resolveBegin -> resolveStep (until
  // it returns true) -> resolveEnd. Between begin and end the figure is the
  // replay's, not the live one (only while play is frozen). job.t: the time of
  // the last pose made; job.t0, job.t1: the clip. resolveBegin returns null if
  // nothing was logged for the clip.
  resolveBegin(t0, t1) {
    const L = this.log, A = this.actor, h = A.h;
    // (from the last saved solver state at or before t0)
    let i0 = -1;
    for (let i = 0; i < L.length && L[i].t <= t1; i++) if (L[i].state && (L[i].t <= t0 || i0 < 0)) i0 = i;
    if (i0 < 0) return null;
    const saved = { state: this.saveState(), snap: h.snapshot(), pos: A.pos.clone(), heading: A.heading, footL: A.footL.clone(), footR: A.footR.clone(), root: h.root.position.clone(), rq: h.root.quaternion.clone(), sc: h.root.scale.x, arms: this.armsNow() };
    this.loadState(L[i0].state);
    // (the log is the live one: the re-solve must not log again or shift it)
    return { t0, t1, i: i0, t: -Infinity, n: 0, done: false, saved, gen: this.gen };
  }
  // Make up to `count` more poses (at most `ms` milliseconds of work, if given); write(t, h)
  // stores each one from t0 on. True when all are made.
  resolveStep(job, count, write, ms = Infinity) {
    const L = this.log, h = this.actor.h;
    if (job.done) return true;
    // (the log was cleared since begin: a new game; nothing more to make)
    if (job.gen !== this.gen) { job.done = true; return true; }
    const tEnd = ms < Infinity ? performance.now() + ms : Infinity;
    // (the log moved on since: find the next frame by its time)
    if (job.i > 0 && L[job.i - 1] && L[job.i - 1].t !== job.t && job.t > -Infinity) { job.i = 0; while (job.i < L.length && L[job.i].t <= job.t) job.i++; }
    for (let n = 0; n < count; n++) {
      const e = L[job.i];
      if (!e || e.t > job.t1) { job.done = true; break; }
      job.i++;
      if (e.sc && Math.abs(h.root.scale.x - e.sc) > 1e-6) h.root.scale.setScalar(e.sc);
      this.solve(e);
      job.t = e.t;
      if (e.t >= job.t0) { write(e.t, h); job.n++; }
      if (tEnd < Infinity && performance.now() > tEnd) break;
    }
    return job.done;
  }
  // Put the live figure back as it was.
  resolveEnd(job) {
    const A = this.actor, h = A.h, saved = job.saved;
    if (!saved) return;
    job.done = true; job.saved = null;
    this.loadState(saved.state);
    this.setArms(saved.arms);
    A.pos.copy(saved.pos); A.heading = saved.heading; A.footL.copy(saved.footL); A.footR.copy(saved.footR);
    h.root.scale.setScalar(saved.sc);
    h.root.position.copy(saved.root); h.root.quaternion.copy(saved.rq);
    h.blendFrom(saved.snap, 0);
    h.update();
  }

  // How far each arm is lengthened (the gloves on a bat out of the figure's
  // reach): [left, right], 1 = its own length. Logged every frame, because a
  // replay poses joints only.
  armsNow() {
    const A = this.actor, h = A.h;
    if (!A._stretched) return null;
    return [h.bones.elbowL.position.length() / A.armRest.elbowL.length(), h.bones.elbowR.position.length() / A.armRest.elbowR.length()];
  }
  setArms(k) {
    const A = this.actor, h = A.h;
    A.restArms();
    if (!k) return;
    for (const [i, sd] of [[0, 'L'], [1, 'R']]) {
      if (Math.abs(k[i] - 1) < 1e-6) continue;
      h.bones['elbow' + sd].position.copy(A.armRest['elbow' + sd]).multiplyScalar(k[i]);
      h.bones['hand' + sd].position.copy(A.armRest['hand' + sd]).multiplyScalar(k[i]);
      A._stretched = true;
    }
  }
  // In a replay at game time t: the arms as long as they were in the pose
  // shown then (the replay sets the joints; this, the arms' length), so the
  // gloves are on the bat in the replay as they were live.
  replayArms(t) {
    const L = this.log;
    let lo = 0, hi = L.length - 1;
    if (hi < 0 || L[0].t >= t) { this.setArms(null); return; }
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (L[mid].t < t) lo = mid; else hi = mid - 1; }
    this.setArms(L[lo].arm || null);
  }

  // Each capture's footwork: where its feet are at contact against its own
  // stance (m for the unscaled figure, world axes with the figure side-on)
  // and how far each foot has turned.
  patterns() {
    if (this.pat) return this.pat;
    if (!shotsReady()) return null;
    const A = this.actor, h = A.h, sc = h.root.scale.x, out = {};
    A.heading = HALF_PI; A.apply();
    const get = (s, time) => {
      h.reset(); poseShot(h, s, time); h.update();
      return { L: h.worldPos('ankleL', v3()), R: h.worldPos('ankleR', v3()), yL: yawOf(h.bones.ankleL.getWorldQuaternion(_q)), yR: yawOf(h.bones.ankleR.getWorldQuaternion(_q)) };
    };
    for (const name of FAMILIES) {
      const s = shotByName(name);
      if (!s) continue;
      const a = get(s, 0), c = get(s, s.events.contact);
      out[name] = { Lx: (c.L.x - a.L.x) / sc, Lz: (c.L.z - a.L.z) / sc, Rx: (c.R.x - a.R.x) / sc, Rz: (c.R.z - a.R.z) / sc, yawL: angDiff(a.yL, c.yL), yawR: angDiff(a.yR, c.yR) };
    }
    h.reset();
    return (this.pat = out);
  }

  // The solver: one frame's inputs -> the pose. Live and replay both come through here.
  solve(e) {
    const A = this.actor, h = A.h, sc = h.root.scale.x, st = this.st, dt = e.dt;
    const bp = _bp.set(e.bp.x, e.bp.y, e.bp.z), bq = _bq.set(e.bq.x, e.bq.y, e.bq.z, e.bq.w);
    const standJ = A.headRestY * sc;
    st.n++;
    // ---- your head (on a monitor there is none: one that stands in the stance and goes a little with the bat)
    let hp, hq = null;
    if (e.head) { hp = e.head.p; hq = e.head.q; } else {
      const tx = clamp(-0.08 + 0.25 * (bp.x - 0.1), -0.4, 0.3), tz = clamp(-1.17 + 0.3 * (bp.z + 1.05), -1.6, -0.8);
      const D = st.desk || (st.desk = { x: tx, z: tz }), k = Math.min(1, dt / 0.15);
      D.x += (tx - D.x) * k; D.z += (tz - D.z) * k;
      hp = { x: D.x, y: standJ + EYES - 0.12, z: D.z };
    }
    _ax.set(0, 1, 0).applyQuaternion(bq);
    _fc.set(0, 0, 1).applyQuaternion(bq);
    // ---- what the bat is doing
    const ex = e.extra;
    const o = dt > 5e-4 || !st.out ? this.sense.update(e.t, dt, hp, bp, _ax, e.off, { sweep: ex ? ex.sweep : null, hitT: ex && ex.hit ? ex.hit.t : null, live: ex ? ex.live ?? null : null, face: _fc }) : st.out;
    st.out = { state: o.state, phase: o.phase, engage: o.engage, leader: o.leader, weights: o.weights, quiet: o.quiet, offOn: o.offOn };
    const E = shotsReady() ? o.engage : 0;
    const Hj = _Hj.set(hp.x, Math.min(hp.y - EYES, standJ - SOFT), hp.z);
    const crouch = Math.max(0, standJ - Hj.y);
    // ---- right down: onto the back knee (held the sweep button: sooner)
    const sweepK = ex && ex.sweep ? ex.sweep.k : 0;
    // (as far as the head is below what an upright kneel reaches: getting up begins as soon as
    // a kneeling body could no longer have its head where yours is; held the sweep button: sooner)
    const kneelTop = (A.kneelHipY + A.spineLen) * sc + KNEEL_BAND[1] + 0.1 * sweepK;
    st.kneel = sstep(kneelTop, kneelTop - KNEEL_BAND[0], Hj.y);
    { const om = 11, acc = om * om * (st.kneel - st.kneelK) - 2 * om * st.kneelV; st.kneelV += acc * dt; st.kneelK = clamp(st.kneelK + st.kneelV * dt, 0, 1); }
    // ---- the captures in play: each at the time in it that matches the bat's phase
    const list = this._list || (this._list = []);
    list.length = 0;
    const pats = this.patterns();
    let pat = null, upright = 0;
    if (E > 0.002 && pats) {
      let sum = 0;
      for (let i = 0; i < FAMILIES.length; i++) {
        const name = FAMILIES[i], w = o.weights[i], s = w > 0.03 ? shotByName(name) : null;
        if (!s) { delete st.u[name]; continue; }
        const uT = captureTime(o.phase, s.events);
        let u = st.u[name];
        u = u == null || E < 0.02 ? uT : u + clamp(uT - u, -SENSE.uRate * dt, SENSE.uRate * dt);
        st.u[name] = u;
        list.push({ s, u, w, name }); sum += w;
      }
      if (sum > 0) {
        pat = this._pat || (this._pat = {});
        pat.Lx = pat.Lz = pat.Rx = pat.Rz = pat.yawL = pat.yawR = 0;
        for (const c of list) {
          c.w /= sum;
          const p = pats[c.name];
          for (const k of ['Lx', 'Lz', 'Rx', 'Rz', 'yawL', 'yawR']) pat[k] += p[k] * c.w * (k[0] === 'y' ? 1 : sc);
          if (UPRIGHT.includes(c.name)) upright += c.w;
        }
        // (capped: the head, not the capture, says how far you have gone)
        const cl = (x, z, m) => { const l = Math.hypot(x, z); return l > m ? m / l : 1; };
        let k = cl(pat.Lx, pat.Lz, 0.35); pat.Lx *= k; pat.Lz *= k;
        k = cl(pat.Rx, pat.Rz, 0.2); pat.Rx *= k; pat.Rz *= k;
        // (the captures come from video: their feet's turn is rough, so only some of it)
        pat.yawL = clamp(pat.yawL * 0.6, -0.3, 0.7); pat.yawR = clamp(pat.yawR * 0.5, -0.3, 0.7);
      } else list.length = 0;
    } else { for (const k of Object.keys(st.u)) delete st.u[k]; st.toeR = 0; st.trunk = null; st.turn = 0; st.relOk = false; }
    // ---- the feet
    const cr = ex && ex.crease;
    // (how far apart the legs can put them with the head this high: the hips under an all but upright trunk)
    const legLen = (h.bones.kneeL.position.length() + h.bones.ankleL.position.length()) * sc;
    const hipUp = Hj.y - A.trunkUp * sc * 0.95 - h.ankleHeight * sc;
    const maxStride = 2 * Math.sqrt(Math.max(0, legLen * legLen - hipUp * hipUp));
    const F = this.feet.update(dt, { hx: Hj.x, hz: Hj.z, crouch, quiet: o.quiet, engage: E, pat, turn: list.length ? st.turn * E : 0, kneel: st.kneelK, maxStride, pin: cr && cr.z != null && cr.pin > 0 ? { z: cr.z, k: cr.pin } : null, stumpsZ: PITCH.battingStumpsZ });
    // ---- no stroke: the stance, from the feet, your head and your hands
    A.mode = 'bat'; A.poseKey = 'bat';
    A.bat.position.copy(bp); A.bat.quaternion.copy(bq);
    A.footL.set(F.L.x, F.L.y, F.L.z); A.footR.set(F.R.x, F.R.y, F.R.z);
    const fx = F.L.x - F.R.x, fz = F.L.z - F.R.z, wide = Math.hypot(fx, fz) || 1;
    const weight = clamp(0.5 + ((Hj.x - (F.L.x + F.R.x) / 2) * fx + (Hj.z - (F.L.z + F.R.z) / 2) * fz) / (wide * wide) * 0.9, 0.2, 0.8);
    // (the other hand off the handle: the shoulders go a little its way)
    _yp.copy(bp);
    if (e.off && o.offOn < 0.5) _yp.lerp(_a.set(e.off.x, e.off.y, e.off.z), 0.3 * (1 - 2 * o.offOn));
    const yawL = HALF_PI + F.L.yaw, yawR = HALF_PI + F.R.yaw;
    A.solveBody({ heading: HALF_PI, weight, head: Hj, batPos: bp, batQuat: bq, elbowUp: 0, heel: 0, sweep: st.kneelK > 0.01 ? { k: st.kneelK, planted: true } : null, swing: null, t: e.t, yawL, yawR, noGrip: true, noLegClear: true, yawPoint: _yp });
    // (a leg that cannot reach its foot, e.g. you stood up out of a lunge before the foot has come back: sit until it does)
    if (st.kneelK < 0.01) {
      h.update();
      let drop = 0;
      for (const sd of ['L', 'R']) {
        const hj = h.worldPos('hip' + sd, _a), f = sd === 'L' ? F.L : F.R, T = _b.set(f.x, f.y + h.ankleHeight * sc, f.z);
        const d = hj.distanceTo(T), over = d - legLen * 0.995;
        if (over > 0) drop = Math.max(drop, over * d / Math.max(0.3, hj.y - T.y));
      }
      if (drop > 0) { h.bones.hips.position.y -= Math.min(drop, 0.3) / sc; A.plantFeetYaw(A.footL, A.footR, yawL, yawR); h.update(); h.clearFoot('L', A._poleL); h.clearFoot('R', A._poleR); }
    }
    // ---- a stroke: the AI batter's body for it, at the bat's phase, on your head and your feet
    let elbowUp = 0, poleL = A._poleL, poleR = A._poleR;
    if (list.length) {
      h.update();
      const N = this.N, M = this.M;
      const snapN = this._snapN = h.snapshot(this._snapN);
      h.worldPos('ankleL', N.aL); h.worldPos('ankleR', N.aR);
      h.bones.ankleL.getWorldQuaternion(N.qL); h.bones.ankleR.getWorldQuaternion(N.qR);
      for (const sd of ['L', 'R']) {            // (the way each knee bends)
        const p = N['p' + sd].copy(h.worldPos('knee' + sd, _a)).sub(_b.addVectors(h.worldPos('hip' + sd, _c), N['a' + sd]).multiplyScalar(0.5));
        const yw = sd === 'L' ? yawL : yawR;
        kneeWay(p, yw);
      }
      this.strokeBody(list, F, Hj, bp, bq, yawL, yawR, dt);
      h.update();
      h.worldPos('ankleL', M.aL); h.worldPos('ankleR', M.aR);
      h.bones.ankleL.getWorldQuaternion(M.qL); h.bones.ankleR.getWorldQuaternion(M.qR);
      if (E < 0.999) {
        h.blendFrom(snapN, E);
        // (the blend of two bodies on the same feet: the legs put back on them, knees bending between the two ways)
        h.update();
        for (const sd of ['L', 'R']) {
          const tgt = _a.lerpVectors(N['a' + sd], M['a' + sd], E);
          const mid = h.worldPos('hip' + sd, _c).add(tgt).multiplyScalar(0.5);
          // (turned from one to the other, so two ways that differ a lot never cancel out)
          _q.setFromUnitVectors(N['p' + sd], M['p' + sd]);
          _d.copy(N['p' + sd]).applyQuaternion(_q2.identity().slerp(_q, E));
          h.ikLeg(sd, tgt, M['o' + sd].copy(mid.addScaledVector(_d, 0.6)));
          h.setWorldQuat('ankle' + sd, _q.copy(N['q' + sd]).slerp(M['q' + sd], E));
        }
        h.update(); h.clearFoot('L', M.oL); h.clearFoot('R', M.oR);
        // (the blend of two trunks does not keep the head on yours: aimed at it again)
        this.leanTo(Hj, 0.4);
      }
      poleL = M.oL; poleR = M.oR;
      // front elbow up and leading through an upright-bat front-foot stroke
      elbowUp = E * upright * sstep(1, 1.8, o.phase) * (1 - 0.6 * sstep(2, 2.8, o.phase));
    }
    this.yieldLegs(bp, bq, poleL, poleR, yawL, yawR, dt);
    if (this.debug) { h.update(); this.debug.pre = h.worldPos('head', _a).distanceTo(Hj); }
    // ---- the gloves on the handle; the head looking where you look
    A.gripBat(bp, bq, elbowUp);
    this.kneesUp(dt);
    this.look(hq, e.ball, dt);
    h.syncShadow();
    // (lifted clear of the turf: the gloves go back on the handle; the arms only, the trunk has leant already)
    if (h.guardLift > 0.002) {
      const lm = A.leanMax, rl = A.reachLimit;
      A.leanMax = NO_LEAN; A.reachLimit = NO_SHIFT;
      A.gripBat(bp, bq, elbowUp);
      A.leanMax = lm; A.reachLimit = rl;
    }
  }

  // The weighted captures' body, placed for you: the pelvis where your head
  // (less the capture's trunk) puts it, held over the feet and low enough for
  // the legs to reach them; the trunk leaning the rest of the way to your
  // head; the legs on the planted feet, knees bending the capture's way; the
  // back foot up on its toe when the capture's is; the shoulders turned a
  // little further to the hands if they need it.
  strokeBody(list, F, Hj, bp, bq, yawL, yawR, dt) {
    const A = this.actor, h = A.h, sc = h.root.scale.x, M = this.M, acc = this.acc;
    h.reset();
    A.apply();
    // blend the captures' poses (trunk and legs; the arms are solved onto the bat later)
    let first = true;
    for (const c of list) {
      poseShot(h, c.s, c.u);
      if (first) { for (let k = 0; k < NB; k++) scaleQ(acc.q[k].copy(h.boneList[k].quaternion), c.w); acc.p.copy(h.bones.hips.position).multiplyScalar(c.w); first = false; continue; }
      for (let k = 0; k < NB; k++) {
        const q = h.boneList[k].quaternion, a = acc.q[k], sgn = (a.x * q.x + a.y * q.y + a.z * q.z + a.w * q.w) < 0 ? -c.w : c.w;
        a.x += q.x * sgn; a.y += q.y * sgn; a.z += q.z * sgn; a.w += q.w * sgn;
      }
      acc.p.addScaledVector(h.bones.hips.position, c.w);
    }
    for (let k = 0; k < NB; k++) h.boneList[k].quaternion.copy(acc.q[k]).normalize();
    h.bones.hips.position.copy(acc.p);
    this.steadyTrunk(dt);
    this.hipsToFeet(yawL, yawR);
    h.update();
    h.worldPos('hips', M.H); h.worldPos('head', M.hd);
    for (const sd of ['L', 'R']) {
      h.worldPos('knee' + sd, M['k' + sd]); h.worldPos('ankle' + sd, M['a' + sd]); h.worldPos('hip' + sd, M['h' + sd]);
      h.bones['ankle' + sd].getWorldQuaternion(M['q' + sd]);
      // the way the capture bends this knee
      const p = M['p' + sd].copy(M['k' + sd]).sub(_a.addVectors(M['h' + sd], M['a' + sd]).multiplyScalar(0.5)), yw = sd === 'L' ? yawL : yawR;
      kneeWay(p, yw);
    }
    const ankleY = h.ankleHeight * sc;
    // ankles: on the planted feet; the back foot up on its toe as far as the capture's heel is up
    // (pivoting on the ball of the foot, as plantFeetYaw: the ankle rises and goes forward over the toe)
    const toeLen = h.toeLength * sc, st = this.st;
    const toeT = Math.asin(clamp((M.aR.y - ankleY - 0.012 * sc) / toeLen, 0, 0.75));
    st.toeR += clamp(toeT - st.toeR, -5 * dt, 5 * dt);
    const toe = st.toeR;
    M.tL.set(F.L.x, ankleY + F.L.y, F.L.z);
    M.tR.set(F.R.x + Math.sin(yawR) * toeLen * (1 - Math.cos(toe)), ankleY + F.R.y + toeLen * Math.sin(toe), F.R.z + Math.cos(yawR) * toeLen * (1 - Math.cos(toe)));
    // pelvis: your head less the capture's trunk
    const P = _P.copy(Hj).sub(M.hd).add(M.H);
    // (kept over the feet: along their line from a little behind the back foot to a little ahead of the front, and near it across)
    const lx = F.L.x - F.R.x, lz = F.L.z - F.R.z, ll = Math.hypot(lx, lz) || 1;
    {
      const ux = lx / ll, uz = lz / ll, rx = P.x - F.R.x, rz = P.z - F.R.z;
      const a = clamp(rx * ux + rz * uz, -0.22, ll + 0.22), b = clamp(rx * -uz + rz * ux, -0.3, 0.34);
      P.x = F.R.x + a * ux + b * -uz; P.z = F.R.z + a * uz + b * ux;
    }
    // (where both legs reach their feet: moved the least it can, along the ground
    // before down, so a long stride shifts the weight over the front foot instead of squatting)
    const legLen = (h.bones.kneeL.position.length() + h.bones.ankleL.position.length()) * sc;
    reachBoth(P, _a.subVectors(M.hL, M.H), M.tL, _b.subVectors(M.hR, M.H), M.tR, legLen * 0.985, HIP_DOWN);
    P.y = Math.max(P.y, A.kneelHipY * sc * 0.82);
    h.bones.hips.position.copy(h.bones.hips.parent.worldToLocal(_a.copy(P)));
    h.update();
    // shoulders turned toward the hands where the capture's are turned away
    h.update();
    const ch = h.worldPos('chest', _a);
    h.bones.chest.getWorldQuaternion(_q2);
    _b.set(0, 0, 1).applyQuaternion(_q2);
    const want = Math.atan2(bp.x - ch.x, bp.z - ch.z), have = Math.atan2(_b.x, _b.z);
    // (all the way round to them when they are out of the arms' reach: a turn of the
    // shoulders reaches further than a lean, and does not take the head off yours)
    _c.set(0, HAND_TOP, 0).applyQuaternion(bq).add(bp);
    const reach = A.armLen * sc / A.armScale0 + 0.06;
    const over = Math.max(h.worldPos('shoulderR', _d).distanceTo(bp), h.worldPos('shoulderL', _e).distanceTo(_c)) - reach;
    const dyaw = clamp(angDiff(have, want), -1.2, 1.2) * mix(0.45, 0.9, sstep(0, 0.12, over));
    // (about the trunk's own line, spine to head: a turn of the shoulders does not move the head)
    _yp.subVectors(h.worldPos('head', _d), h.worldPos('spine', _e)).normalize();
    if (_yp.y < 0.2) _yp.copy(_up);
    for (const [b, f] of [['spine', 0.45], ['chest', 0.55]]) {
      h.bones[b].getWorldQuaternion(_q2);
      h.setWorldQuat(b, _q2.premultiply(_q.setFromAxisAngle(_yp, dyaw * f)));
    }
    h.update();
    // the trunk leans the rest of the way to your head (it was clamped, or the legs could not reach)
    this.leanTo(Hj, 0.6);
    h.update();
    for (const sd of ['L', 'R']) {
      const T = M['t' + sd], hip = h.worldPos('hip' + sd, _a);
      const pole = M['o' + sd].addVectors(hip, T).multiplyScalar(0.5).addScaledVector(M['p' + sd], 0.6);
      // (a knee the capture has down that would go into the turf here: it comes up onto its pad)
      liftPole(h, sd, T, pole, KNEE_MIN * sc);
      h.ikLeg(sd, T, pole);
    }
    // feet flat the way they point (the back one tipped onto its toe)
    h.setWorldQuat('ankleL', _q.setFromAxisAngle(_up, yawL));
    h.setWorldQuat('ankleR', _q.setFromAxisAngle(_up, yawR));
    if (toe > 0) h.addRot('ankleR', toe, 0, 0);
    h.update(); h.clearFoot('L', M.oL); h.clearFoot('R', M.oR);
  }

  // The trunk (from the spine joint) turned toward your head, by at most maxAng.
  leanTo(Hj, maxAng) {
    const h = this.actor.h;
    h.update();
    const sp = h.worldPos('spine', _a), hd = h.worldPos('head', _b);
    _c.subVectors(hd, sp).normalize();
    _d.subVectors(Hj, sp).normalize();
    const ang = Math.acos(clamp(_c.dot(_d), -1, 1));
    if (ang < 1e-3) return;
    _e.copy(_c).lerp(_d, Math.min(1, maxAng / ang)).normalize();
    h.bones.spine.getWorldQuaternion(_q2);
    h.setWorldQuat('spine', _q2.premultiply(_q.setFromUnitVectors(_c, _e)));
  }

  // No faster than a body turns: the trunk follows the captures at a limited
  // rate, so a capture that spins (they come from video) or a change of shot
  // never pops it.
  steadyTrunk(dt) {
    const h = this.actor.h, st = this.st, prev = st.trunk, ok = prev && dt > 0 && dt < 0.1, out = [];
    for (let i = 0; i < TRUNK.length; i++) {
      const q = h.bones[TRUNK[i]].quaternion;
      if (ok) {
        _q.fromArray(prev[i]);
        const a = _q.angleTo(q), m = TRUNK_RATE * dt;
        if (a > m) q.copy(_q.slerp(q, m / a));
      }
      out.push(q.toArray());
    }
    st.trunk = out;
  }

  // The hips turn only so far from where the feet point (a capture's hips spin
  // further than planted feet allow: crossed, wrung legs); the rest of the turn
  // goes to the spine, the chest keeps the capture's. How far the capture
  // opens the hips is kept for the feet (the back foot pivots, the front one
  // opens, next frame).
  hipsToFeet(yawL, yawR) {
    const h = this.actor.h, st = this.st;
    h.update();
    h.bones.hips.getWorldQuaternion(_q2);
    const hy = yawOf(_q2), mean = yawL + angDiff(yawL, yawR) / 2;
    // (kept continuous from frame to frame: a capture can spin the hips right round)
    const turn = angDiff(HALF_PI, hy), rel0 = angDiff(mean, hy), go = st.relOk;
    st.turn = go ? st.turn + angDiff(st.turn, turn) : turn;
    const rel = st.rel = go ? st.rel + angDiff(st.rel, rel0) : rel0;
    st.relOk = true;
    const ex = rel - clamp(rel, HIP_TWIST[0], HIP_TWIST[1]);
    if (Math.abs(ex) < 1e-4) return;
    // (the spine takes up to SPINE_TWIST of what the hips may not turn; past that the whole trunk turns less than the capture's)
    const keep = Math.sign(ex) * Math.max(0, Math.abs(ex) - SPINE_TWIST);
    h.bones.chest.getWorldQuaternion(_q).premultiply(_q3.setFromAxisAngle(_up, -keep));
    h.setWorldQuat('hips', _q2.premultiply(_q3.setFromAxisAngle(_up, -ex)));
    h.update();
    h.bones.spine.getWorldQuaternion(_q2);
    h.setWorldQuat('spine', _q2.premultiply(_q3.setFromAxisAngle(_up, (ex - keep) * 0.5)));
    h.setWorldQuat('chest', _q);
  }

  // The bat is where your hands have it: a pad in its way gives, the knee
  // swinging aside about the line from the hip to the planted foot. Gently
  // (the sideways push grows with how far the blade is in, and moves at a
  // limited speed) and only as a knee can: it stays on the side its foot
  // points. A blade deeper in than that goes through the pad.
  yieldLegs(bp, bq, poleL, poleR, yawL, yawR, dt) {
    const h = this.actor.h, sc = h.root.scale.y, Y = this.st.yield;
    h.update();
    _e.set(0, 1, 0).applyQuaternion(bq);
    for (const sd of ['L', 'R']) {
      const hip = h.worldPos('hip' + sd, _a), knee = h.worldPos('knee' + sd, _b), ank = h.worldPos('ankle' + sd, _c);
      let worst = 0, px = 0, pz = 0;
      for (let i = 0; i <= 6; i++) {
        _d.copy(bp).addScaledVector(_e, BLADE_TOP - (BLADE_TOP - BLADE_TOE) * i / 6);
        for (const [s0, s1] of [[hip, knee], [knee, ank]]) {
          const q = closestOnSeg(_d, s0, s1, _P), gap = LEG_CLEAR * sc - _d.distanceTo(q);
          if (gap > worst) { worst = gap; px = q.x - _d.x; pz = q.z - _d.z; }
        }
      }
      const y = Y[sd], pl = Math.hypot(px, pz), amt = pl > 1e-4 ? Math.min(1, worst / 0.1) * 0.3 / pl : 0;
      const tx = px * amt, tz = pz * amt, dx = tx - y[0], dz = tz - y[1], dl = Math.hypot(dx, dz), mv = Math.min(dl, 2.2 * dt);
      if (dl > 1e-6) { y[0] += dx / dl * mv; y[1] += dz / dl * mv; }
      const pole = sd === 'L' ? poleL : poleR;
      if (Math.hypot(y[0], y[1]) < 1e-3 || !pole) continue;
      const yw = sd === 'L' ? yawL : yawR, mid = _P.addVectors(hip, ank).multiplyScalar(0.5);
      _d.copy(pole).sub(mid); _d.x += y[0]; _d.z += y[1];
      const len = _d.length() || 1;
      kneeWay(_d.divideScalar(len), yw, 0);
      h.bones['ankle' + sd].getWorldQuaternion(_q);
      h.ikLeg(sd, ank, mid.addScaledVector(_d, len));
      h.setWorldQuat('ankle' + sd, _q);
    }
  }

  // The knees last: each knee's bend direction (about its hip-ankle line) turns
  // no faster than KNEE_RATE from the last frame's (a nearly straight leg has
  // no clear bend direction, and a capture's or a blend's can swing round in a
  // frame or two), and no knee is in the turf, whatever moved the legs last
  // (the yield, the reach): turned up just as far as it must.
  kneesUp(dt) {
    const sc = this.actor.h.root.scale.x;
    steadyKnees(this.actor.h, this.st.kd, dt, KNEE_RATE, KNEE_MIN * sc, KNEE_LOW * sc);
  }

  // The head looks where you look (the headset's forward), as far as a neck
  // turns; on a monitor at the ball, or down the pitch.
  look(hq, ball, dt) {
    const h = this.actor.h, st = this.st;
    h.update();
    const neck = h.bones.neck;
    neck.parent.getWorldQuaternion(_q).invert();
    if (hq) _hf.set(0, 0, -1).applyQuaternion(_q2.set(hq.x, hq.y, hq.z, hq.w));
    else { neck.getWorldPosition(_a); if (ball) _hf.set(ball.x, ball.y, ball.z).sub(_a); else _hf.set(0.4, 1.9, -18.8).sub(_a); }
    _hf.applyQuaternion(_q);
    let yaw = Math.atan2(_hf.x, _hf.z);
    // (looking right round behind you: the head stays turned the way it was, it does not whip to the other shoulder)
    if (Math.abs(yaw) > 2.2 && yaw * st.look < 0) yaw = Math.sign(st.look) * 1.5;
    yaw = clamp(yaw, -1.5, 1.5);
    let pitch = clamp(Math.atan2(-_hf.y, Math.hypot(_hf.x, _hf.z)), -0.7, 0.8);
    // (never faster than a neck turns: a look that swings round past the shoulder, or the
    // body turning under it, eases the head round instead of popping it)
    if (st.lookN++ > 0) {
      yaw = st.look + clamp(yaw - st.look, -LOOK_RATE * dt, LOOK_RATE * dt);
      pitch = st.lookP + clamp(pitch - st.lookP, -LOOK_RATE * dt, LOOK_RATE * dt);
    }
    st.look = yaw; st.lookP = pitch;
    h.rot('neck', pitch * 0.4, yaw * 0.45, 0, 'YXZ');
    h.rot('head', pitch * 0.6, yaw * 0.55, 0, 'YXZ');
  }
}
// Move P (the pelvis) the least it must so that P + oL is within `reach` of
// TL and P + oR within reach of TR (both legs reach their feet). The distance
// is weighed with going down costing `down` times going along the ground.
// Alternating projections onto the two balls, each along the weighed
// gradient; continuous in its inputs.
const _rd = new THREE.Vector3(), _rg = new THREE.Vector3();
function reachBoth(P, oL, TL, oR, TR, reach, down) {
  const w2 = down * down;
  for (let it = 0; it < 6; it++) {
    let moved = false;
    for (const [o, T] of [[oL, TL], [oR, TR]]) {
      const d = _rd.copy(P).add(o).sub(T), l = d.length();
      if (l <= reach + 1e-5) continue;
      // direction: toward the foot, with its vertical part scaled down (cheap sideways, dear downward)
      _rg.copy(d).multiplyScalar(-1 / l);
      if (_rg.y < 0) _rg.y /= w2;
      _rg.normalize();
      // step t along it so that |d + t g| = reach
      const b = d.dot(_rg), c = l * l - reach * reach, disc = b * b - c;
      const t = disc >= 0 ? -b - Math.sqrt(disc) : -b;
      P.addScaledVector(_rg, Math.max(0, t));
      moved = true;
    }
    if (!moved) break;
  }
  return P;
}
function closestOnSeg(p, a, b, out) {
  out.subVectors(b, a);
  const l2 = out.lengthSq(), t = l2 > 1e-9 ? clamp((p.x - a.x) * out.x + (p.y - a.y) * out.y + (p.z - a.z) * out.z, 0, l2) / l2 : 0;
  return out.multiplyScalar(t).add(a);
}
function scaleQ(q, k) { q.x *= k; q.y *= k; q.z *= k; q.w *= k; return 0; }
