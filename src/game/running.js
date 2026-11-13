// Running between the wickets + run-outs. Pure JS.
//
// Progress `p` counts runs: 0 = both batters in their ground at the start,
// 1.0 = one completed run, and so on. A run is only attempted when someone
// calls it (the player with a button, or the AI); the batters stop at the end
// of each run and wait for the next call. They can be sent back mid-run and
// can dive for the line. A throw that reaches an end while a run is still in
// progress runs out the batter heading for that end.
import { CONFIG } from '../config.js';
import { PITCH } from '../physics/pitch.js';

const CREASE_TO_CREASE = PITCH.length - 2 * PITCH.poppingOffset;     // 17.68 m
const Z_BAT = -PITCH.poppingOffset + 0.35, Z_BOWL = PITCH.bowlingStumpsZ + PITCH.poppingOffset - 0.35;
const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class Runs {
  constructor(cfg = CONFIG) { this.cfg = cfg; this.reset(); }

  reset() {
    this.active = false;     // a ball is in play and runs may be taken
    this.p = 0;
    this.target = 0;
    this.rate = 0;           // d(p)/dt this frame (signed)
    this.diving = false;
    this.diveT = -1;
    this.t0 = 0;
    this.sStart = { x: -0.4, z: -1.1 };
    this.nStart = { x: -1.35, z: -18.75 };
    this.closed = false;     // ball dead: no more calls
  }

  begin(t, strikerStart = null, nonStrikerStart = null) {
    this.reset();
    this.active = true;
    this.t0 = t;
    if (strikerStart) this.sStart = { x: strikerStart.x, z: strikerStart.z };
    if (nonStrikerStart) this.nStart = { x: nonStrikerStart.x, z: nonStrikerStart.z };
  }

  get running() { return this.active && Math.abs(this.p - this.target) > 1e-6; }
  get completed() { return Math.floor(this.p + 1e-6); }
  get goingBack() { return this.target < this.p - 1e-6; }
  // Fraction of the current run still to go (0 when standing in the crease).
  get remaining() { return this.running ? Math.abs(this.target - this.p) : 0; }

  // Call a run. Only possible when the batters are in their ground.
  call() {
    if (!this.active || this.closed || this.running) return false;
    this.target = this.completed + 1;
    this.diving = false;
    return true;
  }

  // Send them back (mid-run only).
  turnBack() {
    if (!this.running || this.goingBack) return false;
    this.target = Math.floor(this.p + 1e-6);
    this.diving = false;
    return true;
  }

  // Dive for the line: only near the end of a run. Makes the ground sooner.
  dive(t = 0) {
    if (!this.running || this.diving || this.remaining > 0.3) return false;
    this.diving = true;
    this.diveT = t;
    return true;
  }

  close() { this.closed = true; }

  update(dt) {
    if (!this.active) { this.rate = 0; return; }
    const F = this.cfg.field;
    const prev = this.p;
    if (this.running) {
      const first = this.completed === 0 && !this.goingBack && this.p < 1;
      let rate = 1 / (first ? F.runFirst : F.runNext);
      if (first) rate *= 0.55 + 0.9 * ss(0, 0.35, this.p);            // getting going from a standing start
      if (this.diving) rate *= 1.45;
      const d = this.target - this.p;
      const step = Math.min(Math.abs(d), rate * dt);
      this.p += Math.sign(d) * step;
      if (Math.abs(this.target - this.p) < 1e-6) { this.p = this.target; this.diving = false; }
    }
    this.rate = dt > 0 ? (this.p - prev) / dt : 0;
  }

  // Metres short of the popping crease for the batter heading to either end
  // (both are equally far from their ground at any moment). <= 0: in.
  shortBy() {
    if (!this.running) return 0;
    const reach = this.diving ? 1.9 : 1.0;                            // bat (and body) stretched for the line
    return this.remaining * CREASE_TO_CREASE - reach;
  }

  // Who is heading for `end` ('batting' | 'bowling') right now?
  // Returns 'striker' | 'nonStriker' (as they were at the start of the ball).
  headingTo(end) {
    const k = Math.floor(this.p + 1e-6);
    const forward = !this.goingBack;
    // On an even run index the striker runs batting -> bowling.
    const strikerTo = (k % 2 === 0) === forward ? 'bowling' : 'batting';
    return strikerTo === end ? 'striker' : 'nonStriker';
  }

  // Have the batters swapped ends (odd number of completed runs)?
  get crossed() { return this.completed % 2 === 1; }

  // Render state for one batter.
  state(striker) {
    const p = Math.max(0, this.p);
    let leg = Math.floor(p + 1e-6), f = p - leg;
    if (f < 1e-6 && this.rate < 0) { leg -= 1; f = 1; }
    const fromBat = striker ? leg % 2 === 0 : leg % 2 === 1;
    const z0 = fromBat ? Z_BAT : Z_BOWL, z1 = fromBat ? Z_BOWL : Z_BAT;
    const lane = striker ? -0.85 : 0.85;
    const start = striker ? this.sStart : this.nStart;
    let x = lane, z = z0 + (z1 - z0) * f;
    if (leg === 0) { x = start.x + (lane - start.x) * ss(0, 0.25, f); z = start.z + (z1 - start.z) * f; }
    const moving = Math.abs(this.rate) > 1e-4;
    const dir = Math.sign(z1 - z0) * (this.rate < 0 ? -1 : 1);
    return { x, z, speed: Math.abs(this.rate) * CREASE_TO_CREASE, heading: dir >= 0 ? 0 : Math.PI, moving, diving: this.diving, f };
  }
}

// AI calling: how many runs to attempt given an estimate of when the ball
// will be back at the stumps (seconds after the hit). `boldness` 0..1 trims
// the safety margin (and adds misjudgement).
export function planRuns(estReturn, boldness = 0.4, rng = Math.random, cfg = CONFIG) {
  const F = cfg.field;
  const noise = (rng() - 0.5) * 0.9 * (0.4 + boldness);
  const margin = F.runSafetyMargin + 0.55 * (1 - boldness) - 0.25 * boldness;
  let n = 0;
  while (n < 3 && 0.3 + F.runFirst + n * F.runNext + margin <= estReturn + noise) n++;
  return n;
}
