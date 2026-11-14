// Run-up: how far you are from the bowling crease and how fast you are going.
// Pure JS (no three.js), driven by BowlingSession once a frame:
//
//   'mark'       standing at the top of your mark, waiting
//   'running'    the run button is held: accelerate toward the crease
//   'pulled'     let go before the commit point: brake to a stop where you are
//                (never past the commit point). Press again within resumeWindow
//                and you carry on from there; otherwise back to your mark.
//   'committed'  inside the commit zone: the run carries on by itself (button or
//                not) into the delivery stride and stops at the crease
//   'crease'     stopped at the crease; creaseWindow s to let the ball go
//   'dead'       nothing bowled in time: a dead ball (the session resets)
//
// update() returns an event when something changes: 'start' | 'resume' |
// 'pullout' | 'commit' | 'crease' | 'backToMark' | 'deadBall' (or null).
// With the run-up switched off you are always at the crease, with no time limit
// and no momentum penalty.

import { CONFIG } from '../config.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class RunUp {
  // spec: { length, top, accel, commit, stand } (CONFIG.bowling.runUp[type]).
  constructor(spec, { enabled = true, opts = CONFIG.bowling.runUp } = {}) {
    this.spec = spec;
    this.opts = opts;
    this.enabled = enabled;
    this.reset();
  }

  reset() {
    this.state = this.enabled ? 'mark' : 'crease';
    this.dist = this.enabled ? this.spec.length : 0;   // m to the crease
    this.speed = 0;
    this.best = 0;                                     // fastest this run-up
    this.timer = 0;
    this.bowled = false;
  }

  get started() { return this.state !== 'mark'; }
  get atMark() { return this.state === 'mark'; }
  // The ball may only leave the hand in the delivery stride or at the crease.
  get canRelease() { return this.state === 'committed' || this.state === 'crease'; }
  // Pace multiplier from the best speed reached this run-up.
  get paceFactor() {
    if (!this.enabled) return 1;
    const s = this.spec.stand;
    return s + (1 - s) * clamp(this.best / this.spec.top, 0, 1);
  }
  // How far along the run you are, 0 (mark) .. 1 (crease).
  get progress() { return this.enabled ? 1 - this.dist / this.spec.length : 1; }

  // The ball has gone: no dead ball at the crease any more.
  released() { this.bowled = true; }

  update(dt, held) {
    if (!this.enabled || dt <= 0) return null;
    const S = this.spec, O = this.opts;
    let ev = null;
    switch (this.state) {
      case 'mark':
        if (held) { this.state = 'running'; ev = 'start'; }
        break;
      case 'pulled':
        this.timer += dt;
        if (held && this.timer <= O.resumeWindow) { this.state = 'running'; ev = 'resume'; break; }
        this.speed = Math.max(0, this.speed - O.pullOutBrake * dt);
        this.dist -= this.speed * dt;
        if (this.dist <= S.commit + 0.01) { this.dist = S.commit + 0.01; this.speed = 0; }
        if (this.timer > O.resumeWindow && this.speed === 0) { this.reset(); return 'backToMark'; }
        return null;
      case 'committed': case 'crease': case 'dead':
        break;
    }
    if (this.state === 'running') {
      if (!held && this.dist > S.commit) { this.state = 'pulled'; this.timer = 0; return 'pullout'; }
      this.speed = Math.min(S.top, this.speed + S.accel * dt);
      this.best = Math.max(this.best, this.speed);
      this.dist -= this.speed * dt;
      if (this.dist <= S.commit) { this.state = 'committed'; ev = ev || 'commit'; }
    } else if (this.state === 'committed') {
      // Carries on by itself; holding the button still adds speed.
      if (held) this.speed = Math.min(S.top, this.speed + S.accel * dt);
      this.best = Math.max(this.best, this.speed);
      this.speed = Math.max(this.speed, O.carrySpeed);           // (the carry alone earns no pace)
      // Delivery stride: brake so you stop at the crease (never over it).
      this.speed = Math.max(Math.min(this.speed, Math.sqrt(2 * O.strideBrake * Math.max(0, this.dist))), 0.6);
      this.dist -= this.speed * dt;
      if (this.dist <= 0) { this.dist = 0; this.speed = 0; this.state = 'crease'; this.timer = 0; return 'crease'; }
    } else if (this.state === 'crease') {
      this.timer += dt;
      if (!this.bowled && this.timer > O.creaseWindow) { this.state = 'dead'; return 'deadBall'; }
    }
    return ev;
  }
}
