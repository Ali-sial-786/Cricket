// Two umpires (bowler's end and square leg) with the standard signals:
// four, six, out, not out, wide, no-ball, free hit, bye, leg bye and "review"
// (the TV square). Between signals the hands are clasped behind the back.
import * as THREE from 'three';
import { Actor } from './actors.js';
import { plantFeet, keys, sstep } from './anim.js';
import { clipsReady } from './clips.js';
import { PITCH } from '../physics/pitch.js';
import { walkTask, stepWalk } from './crew.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _t = new THREE.Vector3(), _f = new THREE.Vector3(), _l = new THREE.Vector3();

class UmpireActor extends Actor {
  constructor(scene, seed) {
    super(scene, { team: 'umpire', headgear: 'hat', seed, vary: true });
    this.sig = null;
  }
  signal(type, now, dur = 2.6) { this.sig = { type, t0: now, dur }; }
  clasp(left, right) {
    const h = this.h;
    h.update();
    this.forward(_f);
    _l.set(_f.z, 0, -_f.x);                        // figure's left
    h.worldPos('hips', _t).addScaledVector(_f, -0.2).add(_c.set(0, 0.06, 0));
    if (left) { _a.copy(_t).addScaledVector(_l, 0.03); h.worldPos('shoulderL', _b).addScaledVector(_l, 0.5).addScaledVector(_f, -0.2); h.ikArm('L', _a, _b); }
    if (right) { _a.copy(_t).addScaledVector(_l, -0.03); h.worldPos('shoulderR', _b).addScaledVector(_l, -0.5).addScaledVector(_f, -0.2); h.ikArm('R', _a, _b); }
  }
  update(dt, now, look) {
    const h = this.h;
    h.reset();
    // Walking to his place (the other side of the stumps, out of your way) or standing.
    const walking = this.speed > 0.25;
    if (walking) { this.gait(dt); this.locomote(now); } else this.idle(now);
    const s = this.sig;
    this.poseKey = walking ? 'move' : s ? s.type : 'idle';
    this.apply();
    if (!this.far) {
      this.footWorld(_a, 0.13, 0.02); this.footWorld(_b, -0.13, 0);
      // (With the idle clip the feet are already planted where it stands them.)
      if (!clipsReady() && !walking) plantFeet(h, _a, s && s.type === 'legbye' ? null : _b, this.forward(_c).multiplyScalar(0.6));
      // Hands clasped behind the back; walking, the arms swing.
      if (!walking) this.clasp(true, true);
    }
    // A signal goes up from wherever the arms are (clasped) and comes back down
    // to them: the arms are posed for the signal in full and slerped in by k.
    if (s) {
      const u = (now - s.t0) / s.dur;
      if (u >= 1) this.sig = null;
      else this.pose(s, now - s.t0, u);
    }
    if (look && !(s && s.type === 'notout')) h.lookAt(look, 0.7);
    if (!this.far) this.smooth(dt);
    h.syncShadow();
  }
  pose(s, tt, u) {
    const h = this.h, B = h.bones, A = this._arm || (this._arm = ARMS.map(() => new THREE.Quaternion()));
    // (a crisp lift with a hint of overshoot, a slower, softer return)
    const k = sstep(0, 0.1, u) * (1 - sstep(0.82, 1, u)), up = Math.min(1, k * (1 + 0.08 * Math.sin(Math.PI * sstep(0.05, 0.16, u))));
    ARMS.forEach((b, i) => A[i].copy(B[b].quaternion));
    let arms = true;
    if (s.type === 'six') {
      h.rot('shoulderL', -3.05, 0, 0.12); h.rot('shoulderR', -3.05, 0, -0.12);
      h.rot('elbowL', -0.05, 0, 0); h.rot('elbowR', -0.05, 0, 0); h.rot('handL', 0, 0, 0); h.rot('handR', 0, 0, 0);
    } else if (s.type === 'four') {
      // the arm waved to and fro across the chest, from his left to well out to his right
      const w = Math.sin(Math.max(0, tt - 0.15) * 6.5);
      h.rot('shoulderR', -1.45, 0, -0.35 + 0.95 * w, 'ZXY'); h.rot('elbowR', -0.15, 0, 0); h.rot('handR', 0, 0, 0);
    } else if (s.type === 'out' || s.type === 'bye') {
      // out: the forearm raised in front, finger up; bye: the open hand straight up over the head
      if (s.type === 'out') { h.rot('shoulderR', -2.55, 0, -0.08); h.rot('elbowR', -0.45, 0, 0); h.rot('handR', 0.2, 0, 0); }
      else { h.rot('shoulderR', -3.08, 0, -0.06); h.rot('elbowR', -0.03, 0, 0); h.rot('handR', 0, 0, 0); }
    } else if (s.type === 'wide') {
      h.rot('shoulderL', 0, 0, 1.52); h.rot('shoulderR', 0, 0, -1.52);
      h.rot('elbowL', 0, 0, 0); h.rot('elbowR', 0, 0, 0); h.rot('handL', 0, 0, 0); h.rot('handR', 0, 0, 0);
    } else if (s.type === 'noball') {           // one arm held straight out
      h.rot('shoulderR', 0, 0, -1.52); h.rot('elbowR', 0, 0, 0); h.rot('handR', 0, 0, 0);
    } else if (s.type === 'freehit') {          // one hand circling above the head
      h.rot('shoulderR', -2.9 + 0.22 * Math.sin(tt * 9), 0, -0.1 + 0.22 * Math.cos(tt * 9));
      h.rot('elbowR', -0.15, 0, 0);
    } else if (s.type === 'review') {
      // drawing the TV screen in the air: from together at the top, out, down and together again
      this.screen(tt);
    } else if (s.type === 'legbye') {           // touching a raised knee
      h.rot('hipR', -1.3 * k, 0, -0.05); h.rot('kneeR', 1.45 * k, 0, 0);
      h.addRot('spine', 0.3 * k, 0, 0);
      h.update();
      this.forward(_f);
      h.worldPos('kneeR', _t).addScaledVector(_f, 0.06).add(_c.set(0, 0.07, 0));
      h.ikArm('R', _t, h.worldPos('shoulderR', _b).addScaledVector(_f, -0.3).add(_c.set(0, -0.2, 0)));
    } else if (s.type === 'notout') {
      arms = false;
      h.rot('head', 0, 0.45 * Math.sin(tt * 8) * k, 0);
    }
    if (arms) ARMS.forEach((b, i) => { _q.copy(B[b].quaternion); B[b].quaternion.copy(A[i]).slerp(_q, up); });
  }
  // The TV screen: both hands trace a rectangle (0.56 x 0.34 m) in front of the face.
  screen(tt) {
    const h = this.h;
    h.update();
    this.forward(_f);
    _l.set(_f.z, 0, -_f.x);
    const p = Math.min(1, Math.max(0, tt - 0.25) / 1.3);           // along the outline
    const x = 0.04 + 0.24 * sstep(0, 0.3, p) * (1 - sstep(0.7, 1, p)), y = -0.34 * sstep(0.3, 0.7, p);
    h.worldPos('neck', _t).addScaledVector(_f, 0.42).add(_c.set(0, 0.12 + y, 0));
    for (const [side, sg] of [['L', 1], ['R', -1]]) {
      _a.copy(_t).addScaledVector(_l, sg * x);
      h.ikArm(side, _a, h.worldPos('shoulder' + side, _b).addScaledVector(_l, sg * 0.6).add(_c.set(0, -0.5, 0)));
    }
  }
}

const ARMS = ['shoulderL', 'elbowL', 'handL', 'shoulderR', 'elbowR', 'handR'];
const _q = new THREE.Quaternion();

export class UmpireView {
  constructor(scene) {
    this.main = new UmpireActor(scene, 41);       // bowler's end
    this.leg = new UmpireActor(scene, 57);        // square leg
    this.visible = false;
    this.place(false);
    this.show(false);
    this.look = new THREE.Vector3(0, 1, -1);
  }
  // Where the umpires stand. The bowler's-end umpire: behind the stumps, on
  // the far side of them from the bowler's run-up (side: which side the
  // bowler runs in on, +1 = +X, i.e. right-arm over the wicket; -1 = around),
  // clear of the bowler's line and of his view of the batter. When you bowl
  // he is a little deeper and wider, so that you run in past him with room
  // to spare and he is never between you and the batter.
  // While the umpires are not on show they are simply stood there; otherwise
  // they WALK to a new place (the bowler changing sides of the wicket).
  place(playerBowling, side = 1) {
    this.side = side;
    const mx = (playerBowling ? -1.2 : -0.95) * side, mz = PITCH.bowlingStumpsZ - (playerBowling ? 2.0 : 1.9);
    const set = (u, x, z, face) => {
      if (!u.mark) { u.mark = new THREE.Vector3(); u.off = new THREE.Vector3(); u.goal = { x, z }; }
      u.mark.set(x, 0, z); u.rest = face;
      if (!this.visible || !u.placed) { u.placed = true; u.task = null; u.speed = 0; u.off.set(0, 0, 0); u.place(x, z, face); u.cut(); }
    };
    set(this.main, mx, mz, 0);
    set(this.leg, -17.5, -1.3, Math.PI / 2);
  }
  // Keep out of the player's space: an umpire whose spot you are standing in
  // (or next to) walks to the edge of it, and back to his mark once you go.
  keepClear(head, dt, r = 1.3) {
    for (const u of [this.main, this.leg]) {
      if (!u.mark) continue;
      let gx = 0, gz = 0;
      if (head) {
        const dx = u.mark.x - head.x, dz = u.mark.z - head.z, d = Math.hypot(dx, dz);
        if (d < r) {
          const ux = d > 1e-3 ? dx / d : (u.mark.x <= head.x ? -1 : 1), uz = d > 1e-3 ? dz / d : 0;
          gx = head.x + ux * r - u.mark.x; gz = head.z + uz * r - u.mark.z;
        }
      }
      u.off.set(gx, 0, gz);
    }
  }
  // Both on their marks at once (out of your way), standing still, no signal
  // left over: a skip to the next ball, while the view is dark.
  settleNow() {
    for (const u of [this.main, this.leg]) {
      if (!u.mark) continue;
      u.goal.x = u.mark.x + u.off.x; u.goal.z = u.mark.z + u.off.z;
      u.task = null; u.speed = 0; u.sig = null;
      u.cut();
      u.place(u.goal.x, u.goal.z, u.rest);
    }
  }
  // Both where they should be, standing still?
  settled() {
    if (!this.visible) return true;
    return [this.main, this.leg].every((u) => !u.task && u.speed < 0.1);
  }
  show(v) { this.visible = v; this.main.visible = v; this.leg.visible = v; }
  // Ground positions (x, z) of both umpires (for the fielders to run round).
  spots() { return [this.main.pos, this.leg.pos]; }
  signal(type, now) { if (!this.visible) return; this.main.signal(type, now); if (type !== 'review') this.leg.signal(type, now, 2.2); }
  setLook(v) { if (v) this.look.copy(v); }
  // obstacles: circles {x, z, r} for a walking umpire to go round (set by the field controller).
  update(dt, now) {
    if (!this.visible) return;
    for (const u of [this.main, this.leg]) {
      if (u.mark) {
        u.goal.x = u.mark.x + u.off.x; u.goal.z = u.mark.z + u.off.z;
        const d = Math.hypot(u.goal.x - u.pos.x, u.goal.z - u.pos.z);
        if (!u.task && dt > 0 && (d > 0.06 || Math.abs(Math.atan2(Math.sin(u.rest - u.heading), Math.cos(u.rest - u.heading))) > 0.08)) u.task = walkTask(u.goal, u.rest, { speed: d > 5 ? 2.6 : 1.3, tol: 0.05 });
        if (u.task && dt > 0) { u.task.to = u.goal; u.task.face = u.rest; if (stepWalk(u, dt, this.obstacles || null)) u.task = null; }
        if (!u.task) u.speed = 0;
      }
      u.update(dt, now, this.look);
    }
  }
}
