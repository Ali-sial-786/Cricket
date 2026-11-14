// Two umpires (bowler's end and square leg) with the standard signals:
// four, six, out, not out, wide, and "review" (the TV square).
import * as THREE from 'three';
import { Actor } from './actors.js';
import { poseIdle, plantFeet, keys, sstep } from './anim.js';
import { PITCH } from '../physics/pitch.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();

class UmpireActor extends Actor {
  constructor(scene, seed) {
    super(scene, { team: 'umpire', headgear: 'hat', seed });
    this.sig = null;
  }
  signal(type, now, dur = 2.6) { this.sig = { type, t0: now, dur }; }
  update(dt, now, look) {
    const h = this.h;
    h.reset();
    poseIdle(h, now, 1);
    // Hands clasped behind the back by default.
    h.rot('shoulderL', 0.35, 0, 0.12); h.rot('elbowL', 0.5, 0, 0);
    h.rot('shoulderR', 0.35, 0, -0.12); h.rot('elbowR', 0.5, 0, 0);
    const s = this.sig;
    if (s) {
      const u = (now - s.t0) / s.dur;
      if (u >= 1) this.sig = null;
      else {
        const k = sstep(0, 0.12, u) * (1 - sstep(0.85, 1, u));
        const tt = now - s.t0;
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
        } else if (s.type === 'bye') {
          h.rot('shoulderR', -3.0 * k, 0, -0.1);
        }
      }
    }
    this.apply();
    if (!this.far) {
      this.footWorld(_a, 0.13, 0.02); this.footWorld(_b, -0.13, 0);
      plantFeet(h, _a, _b, this.forward(_c).multiplyScalar(0.6));
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
  // When the player bowls, the bowler's-end umpire stands a little wider so he is in view.
  // side: which side of the stumps the bowler runs in on (+1 = +X, i.e. right-arm
  // over the wicket; -1 = around). The umpire stands on the other side.
  place(playerBowling, side = 1) {
    this.side = side;
    this.main.place(playerBowling ? -1.9 * side : -0.95 * side, PITCH.bowlingStumpsZ - (playerBowling ? 0.6 : 1.9), 0);
    this.leg.place(-17.5, -1.3, Math.PI / 2);
  }
  show(v) { this.visible = v; this.main.visible = v; this.leg.visible = v; }
  // Ground positions (x, z) of both umpires (for the fielders to run round).
  spots() { return [this.main.pos, this.leg.pos]; }
  signal(type, now) { if (!this.visible) return; this.main.signal(type, now); if (type !== 'review') this.leg.signal(type, now, 2.2); }
  setLook(v) { if (v) this.look.copy(v); }
  update(dt, now) {
    if (!this.visible) return;
    this.main.update(dt, now, this.look);
    this.leg.update(dt, now, this.look);
  }
}
