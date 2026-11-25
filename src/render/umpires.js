// Two umpires (bowler's end and square leg) with the standard signals:
// four, six, out, not out, wide, no-ball, free hit, bye, leg bye, dead ball and "review"
// (the TV square). Between signals the hands are clasped behind the back.
import * as THREE from 'three';
import { Actor } from './actors.js';
import { plantFeet, keys, sstep, nm, SIDE_SG, hyp } from './anim.js';
import { hash01, envelope } from './gestures.js';
import { clipsReady } from './clips.js';
import { poseEvery } from './humanoid.js';
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
  // (ceremonies: still = standing square, hands behind his back, eyes on what he is shown -- no idling, no dodging; nod(now): a nod)
  nod(now) { this.nodAt = now; }
  // The hands while he stands: clasped behind his back, and now and then
  // (idleHands) clasped in front, in his trouser pockets, or the right hand
  // at his waist counting the balls of the over -- always by way of behind the
  // back, the hands moving there over most of a second.
  clasp(left, right, now = 0) {
    const h = this.h, sc = h.root.scale.y;
    h.update();
    this.forward(_f);
    _l.set(_f.z, 0, -_f.x);                        // figure's left
    const T = now + this.idleOff, slot = Math.floor(T / UMP_SLOT), mode = this.still ? 'front' : UMP_HANDS[Math.floor(hash01(this.seed, slot) * UMP_HANDS.length)];
    // (a ceremony -- the toss: standing square, hands clasped in front of him, all the time)
    const w = this.still ? 1 : mode ? envelope(T - slot * UMP_SLOT, UMP_SLOT, 0.8, 0.8) : 0;
    for (let n = 0; n < 2; n++) {
      const side = n ? 'R' : 'L', sg = n ? -1 : 1, on = n ? right : left;
      if (!on) continue;
      h.worldPos('hips', _t).addScaledVector(_f, -0.2).add(_c.set(0, 0.06, 0)).addScaledVector(_l, sg * 0.03);
      h.worldPos(nm('shoulder', side), _b).addScaledVector(_l, sg * 0.5).addScaledVector(_f, -0.2);
      if (w > 0.001 && !(mode === 'count' && side === 'L')) {
        if (mode === 'front') h.worldPos('hips', _a).addScaledVector(_f, 0.2 * sc).add(_c.set(0, 0.03 * sc, 0)).addScaledVector(_l, sg * 0.035);
        else if (mode === 'pockets') h.worldPos(nm('hip', side), _a).addScaledVector(_f, 0.07 * sc).addScaledVector(_l, sg * 0.03).add(_c.set(0, -0.02 * sc, 0));
        else h.worldPos('hips', _a).addScaledVector(_f, 0.24 * sc).add(_c.set(0, (0.12 + 0.015 * Math.sin(now * 7)) * sc, 0)).addScaledVector(_l, -0.07);   // (count: fingers at the waist)
        _t.lerp(_a, w);
        _b.addScaledVector(_f, 0.3 * w);
      }
      h.ikArm(side, _t, _b);
    }
  }
  // Out of the way of a ball hit straight at him (look: the ball, each frame):
  // weight 0..1 of a sway away from it, and which way (the figure's left = +1).
  dodge(look, dt) {
    const D = this._dodge || (this._dodge = { p: new THREE.Vector3(), ok: false, e: 0, side: 1 });
    let want = 0;
    if (look && D.ok && dt > 0) {
      const vx = (look.x - D.p.x) / dt, vz = (look.z - D.p.z) / dt, px = look.x - this.pos.x, pz = look.z - this.pos.z;
      const v2 = vx * vx + vz * vz, tc = -(px * vx + pz * vz) / Math.max(1e-6, v2);
      // (a ball hit away from the striker -- not the delivery leaving the bowler's hand beside him)
      const away = look.x * vx + (look.z - PITCH.battingStumpsZ) * vz > 0;
      if (away && v2 > 64 && tc > 0 && tc < 0.7 && look.y < 2.3) {
        const cx = px + vx * tc, cz = pz + vz * tc;                     // closest the ball comes (relative to him)
        if (hyp(cx, cz) < 1.1) { want = 1; this.forward(_f); D.side = (cx * _f.z - cz * _f.x) >= 0 ? -1 : 1; }
      }
    }
    if (look) { D.p.copy(look); D.ok = true; } else D.ok = false;
    D.e = want > D.e ? Math.min(want, D.e + dt * 5) : Math.max(0, D.e - dt * 1.4);       // (quick out of the way, but never in one frame)
    return D;
  }
  // Pose LOD (humanoid.js ANIM_LOD): far from your eyes (the bowler's-end umpire and the
  // square-leg umpire are 20 m and more away when you bowl) and calm -- standing, no
  // signal, no nod, not dodging, not a ceremony -- his pose is made every 2nd / 3rd frame
  // a frame or two ahead and shown between; his place every frame.
  update(dt, now, look) {
    const D = this._dodge, calm = !this.sig && this.speed <= 0.25 && !this.still && !(D && D.e > 0) && !(this.nodAt != null && now - this.nodAt < 1);
    const div = poseEvery(this.pos, calm), tk = this.lodNext(div, this.seed % 3, now, dt);
    if (div > 1 && tk === null) { this.apply(); this.lodShow(now); return; }
    if (div > 1) {
      this.lodBefore(now, dt);
      this.posePlain(Math.max(1e-4, tk - (this._poseT ?? now - dt)), tk, look);
      this.lodKey(tk, now);
      return;
    }
    this.posePlain(this._lod.was ? Math.max(1e-4, now - (this._poseT ?? now - dt)) : dt, now, look);
  }
  posePlain(dt, now, look) {
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
      // Hands clasped behind the back (or in front, in his pockets, counting); walking, the arms swing.
      if (!walking) this.clasp(true, true, now);
    }
    // A ball hit straight at him: he sways out of its way, arms in (visual: his mark is where it was).
    const D = this.dodge(this.still ? null : look, dt), e = D.e > 0 ? sstep(0, 1, D.e) : 0;
    if (e > 0.001) {
      this.forward(_f);
      h.addRot('spine', 0.2 * e, 0, D.side * 0.35 * e); h.addRot('chest', 0, -D.side * 0.3 * e, 0);
      h.root.position.x += _f.z * D.side * 0.4 * e; h.root.position.z += -_f.x * D.side * 0.4 * e;
    }
    // A signal goes up from wherever the arms are (clasped) and comes back down
    // to them: the arms are posed for the signal in full and slerped in by k.
    if (s) {
      const u = (now - s.t0) / s.dur;
      if (u >= 1) this.sig = null;
      else this.pose(s, now - s.t0, u);
    }
    // (a ceremony: upright, not the idle's easy slouch)
    if (this.still) { h.addRot('spine', -0.07, 0, 0); h.addRot('chest', -0.04, 0, 0); }
    if (look && !(s && s.type === 'notout')) h.lookAt(look, 0.7);
    // a nod (nodAt: when it began, on his clock)
    const nu = this.nodAt != null ? now - this.nodAt : -1;
    if (nu > 0 && nu < 0.9) { const k = Math.sin(Math.PI * 2 * nu / 0.45) * (1 - sstep(0.5, 0.9, nu)) * sstep(0, 0.08, nu); h.addRot('neck', 0.15 * k, 0, 0); h.addRot('head', 0.1 * k, 0, 0); }
    if (!this.far) this.smooth(dt);
    h.syncShadow();
    this.posed(now);
  }
  pose(s, tt, u) {
    const h = this.h, B = h.bones, A = this._arm || (this._arm = ARMS.map(() => new THREE.Quaternion()));
    // (a crisp lift with a hint of overshoot, a slower, softer return)
    const k = sstep(0, 0.1, u) * (1 - sstep(0.82, 1, u)), up = Math.min(1, k * (1 + 0.08 * Math.sin(Math.PI * sstep(0.05, 0.16, u))));
    for (let i = 0; i < 6; i++) A[i].copy(B[ARMS[i]].quaternion);
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
    } else if (s.type === 'deadball') {
      // dead ball: the wrists crossed and uncrossed below the waist
      h.update();
      this.forward(_f);
      _l.set(_f.z, 0, -_f.x);
      const x = 0.09 * Math.cos(tt * 7.5);
      for (const [side, sg] of SIDE_SG) {
        h.worldPos('hips', _t).addScaledVector(_f, 0.3).add(_c.set(0, -0.12 + (side === 'L' ? 0.02 : 0), 0)).addScaledVector(_l, -sg * x);
        h.ikArm(side, _t, h.worldPos(nm('shoulder', side), _b).addScaledVector(_l, sg * 0.6).add(_c.set(0, -0.3, 0)));
      }
    } else if (s.type === 'notout') {
      arms = false;
      h.rot('head', 0, 0.45 * Math.sin(tt * 8) * k, 0);
    }
    if (arms) for (let i = 0; i < 6; i++) { const q = B[ARMS[i]].quaternion; _q.copy(q); q.copy(A[i]).slerp(_q, up); }
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
    for (const [side, sg] of SIDE_SG) {
      _a.copy(_t).addScaledVector(_l, sg * x);
      h.ikArm(side, _a, h.worldPos(nm('shoulder', side), _b).addScaledVector(_l, sg * 0.6).add(_c.set(0, -0.5, 0)));
    }
  }
}

const ARMS = ['shoulderL', 'elbowL', 'handL', 'shoulderR', 'elbowR', 'handR'];
// Standing about (clasp): slots of UMP_SLOT s, each with one of these for his hands (null: behind his back).
const UMP_SLOT = 6.5, UMP_HANDS = [null, null, 'front', 'pockets', 'count', null, 'front'];
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
        const dx = u.mark.x - head.x, dz = u.mark.z - head.z, d = hyp(dx, dz);
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
    for (let n = 0; n < 2; n++) {
      const u = n ? this.leg : this.main;
      if (u.mark) {
        u.goal.x = u.mark.x + u.off.x; u.goal.z = u.mark.z + u.off.z;
        const d = hyp(u.goal.x - u.pos.x, u.goal.z - u.pos.z);
        if (!u.task && dt > 0 && (d > 0.06 || Math.abs(Math.atan2(Math.sin(u.rest - u.heading), Math.cos(u.rest - u.heading))) > 0.08)) u.task = walkTask(u.goal, u.rest, { speed: d > 5 ? 2.6 : 1.3, tol: 0.05 });
        if (u.task && dt > 0) { u.task.to = u.goal; u.task.face = u.rest; if (stepWalk(u, dt, this.obstacles || null)) u.task = null; }
        if (!u.task) u.speed = 0;
      }
      u.update(dt, now, this.look);
    }
  }
}
