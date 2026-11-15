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
    super(scene, { team: 'umpire', headgear: 'hat', seed });
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
    let busyL = false, busyR = false;          // arms the current signal uses
    if (s) {
      const u = (now - s.t0) / s.dur;
      if (u >= 1) this.sig = null;
      else {
        const k = sstep(0, 0.12, u) * (1 - sstep(0.85, 1, u));
        const tt = now - s.t0;
        busyR = s.type !== 'notout';
        busyL = s.type === 'six' || s.type === 'wide' || s.type === 'review';
        if (s.type === 'six') {
          h.rot('shoulderL', -3.05 * k, 0, 0.12 * k); h.rot('shoulderR', -3.05 * k, 0, -0.12 * k);
          h.rot('elbowL', -0.05, 0, 0); h.rot('elbowR', -0.05, 0, 0);
        } else if (s.type === 'four') {
          const w = Math.sin(tt * 7);
          h.rot('shoulderR', -1.45 * k, 0, (-0.25 + 0.75 * w) * k, 'ZXY');
          h.rot('elbowR', -0.1, 0, 0);
        } else if (s.type === 'out') {
          h.rot('shoulderR', -2.75 * k, 0, -0.1 * k);
          h.rot('elbowR', -0.25 * k, 0, 0);
        } else if (s.type === 'wide') {
          h.rot('shoulderL', 0, 0, 1.5 * k); h.rot('shoulderR', 0, 0, -1.5 * k);
          h.rot('elbowL', 0, 0, 0); h.rot('elbowR', 0, 0, 0);
        } else if (s.type === 'notout') {
          h.rot('head', 0, 0.45 * Math.sin(tt * 8) * k, 0);
        } else if (s.type === 'review') {            // drawing the TV screen
          const ph = keys([[0, 0], [0.5, 1], [1, 0]], (tt * 1.2) % 1);
          h.rot('shoulderL', -1.5 * k, 0, (0.1 + 0.5 * ph) * k); h.rot('shoulderR', -1.5 * k, 0, -(0.1 + 0.5 * ph) * k);
          h.rot('elbowL', -0.6 * k, 0, 0); h.rot('elbowR', -0.6 * k, 0, 0);
        } else if (s.type === 'noball') {           // one arm held straight out
          h.rot('shoulderR', 0, 0, -1.5 * k); h.rot('elbowR', 0, 0, 0);
        } else if (s.type === 'freehit') {          // one hand circling above the head
          h.rot('shoulderR', (-2.9 + 0.22 * Math.sin(tt * 9)) * k, 0, (-0.1 + 0.22 * Math.cos(tt * 9)) * k);
          h.rot('elbowR', -0.15, 0, 0);
        } else if (s.type === 'bye') {             // open hand raised above the head
          h.rot('shoulderR', -3.0 * k, 0, -0.1);
        } else if (s.type === 'legbye') {          // touching a raised knee
          h.rot('hipR', -1.05 * k, 0, -0.05); h.rot('kneeR', 1.25 * k, 0, 0);
          h.rot('spine', 0.25 * k, 0, 0);
          h.rot('shoulderR', -0.55 * k, 0, -0.05); h.rot('elbowR', -0.2 * k, 0, 0);
        }
      }
    }
    this.apply();
    if (!this.far) {
      this.footWorld(_a, 0.13, 0.02); this.footWorld(_b, -0.13, 0);
      // (With the idle clip the feet are already planted where it stands them.)
      const legBye = s && s.type === 'legbye';
      if (!clipsReady() && !walking) plantFeet(h, _a, legBye ? null : _b, this.forward(_c).multiplyScalar(0.6));
      // Hands clasped behind the back (whichever hands the signal is not using); walking, the arms swing.
      if ((!busyL || !busyR) && !walking) this.clasp(!busyL, !busyR);
    }
    if (look && !(s && s.type === 'notout')) h.lookAt(look, 0.7);
    if (!this.far) this.smooth(dt);
    h.syncShadow();
  }
}

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
