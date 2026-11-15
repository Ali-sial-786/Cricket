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
const F_GETUP = (r) => r.cfg.field.getUp;
const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Lanes either side of the pitch, and how wide of the player's head a runner passes.
const LANE = 0.85;
const LIE = 0.25;            // s a diver lies where he stopped before he starts to get up
const DIVE_PUSH = 20;        // m/s^2: the push into a dive, up to the dive's speed
export const RUNNER_CLEAR = 1.4;

export class Runs {
  constructor(cfg = CONFIG) {
    this.cfg = cfg;
    // The player's head on the ground {x, z, r, striker}: nobody runs within r
    // of it. striker: the player is the striker (his runner is his own body,
    // and the non-striker takes the lane on the far side of him).
    this.keepOut = null;
    this.reset();
  }

  reset() {
    this.active = false;     // a ball is in play and runs may be taken
    this.p = 0;
    this.target = 0;
    this.rate = 0;           // d(p)/dt this frame (signed)
    this.diving = false;     // in the air / sliding for the line
    this.diveT = 0;          // s since the dive was launched
    this.diveV = 0;          // m/s along the pitch during the dive
    this.diveHeld = false;   // the dive button is down: dive as soon as the crease is in range
    this.diveWanted = false; // (a tap) dive when in range on this run
    this.diveWho = null;     // 'striker' | 'nonStriker': which batter is diving
    this.diveEnd = null;     // the end to dive for ('batting' | 'bowling'); null = the striker's
    this.down = 0;           // s left on the ground after a dive
    this.rest = 0;           // s since the diver came to rest
    this.stay = false;       // stay down for now (the third umpire is looking at it): set by the controller
    this.safe = false;       // the run in progress was judged safe (makeGround): it is being finished off
    this.diveStarted = false;// set on the frame a dive launches (cleared by whoever reads it)
    this.t0 = 0;
    this.sStart = { x: -0.4, z: -1.1 };
    this.nStart = { x: -1.35, z: -18.75 };
    this.closed = false;     // ball dead: no more calls
    this.boundary = false;   // closed by a boundary
    this.official = null;    // { completed, crossed } as they stood when the ball went dead
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
    if (!this.active || this.closed || this.running || this.down > 0.3) return false;   // still getting up
    this.target = this.completed + 1;
    this.diving = false; this.diveWanted = false; this.down = 0;
    return true;
  }

  // Send them back (mid-run only).
  turnBack() {
    if (!this.running || this.goingBack) return false;
    this.target = Math.floor(this.p + 1e-6);
    this.diving = false; this.diveWanted = false;
    return true;
  }

  // Dive for the line. Hold the button (diveHeld) or tap it (dive()): the
  // batter launches full length, bat stretched out in front, as soon as the
  // crease is within range, slides in, and then needs a moment to get up.
  dive() {
    if (!this.running || this.diving) return false;
    this.diveWanted = true;
    return true;
  }

  // The ball is dead. The score is fixed as it stands (`official`), but the
  // batters do not freeze where they are: one who is nearly home finishes the
  // run, anyone else trots back to the crease he left, a diver gets up. `stop`
  // (a run-out) leaves them standing where they are.
  // `boundary`: the ball has gone for four or six; they pull up at once and
  // walk back to the crease they left (unless all but home). `to`: the run
  // in progress counts all the same (overthrows to the rope, crossed when the
  // throw was made): they finish it.
  close({ stop = false, boundary = false, to = null } = {}) {
    if (this.closed) return;
    this.closed = true;
    this.boundary = boundary;
    this.official = { completed: this.completed, crossed: this.crossed };
    this.diveWanted = false; this.diveHeld = false;
    if (!this.running || this.diving) return;
    if (to != null && !this.goingBack && Math.ceil(this.p - 1e-6) === to) { this.target = to; return; }
    if (stop) this.target = this.p;
    else if (this.remaining > (boundary ? 0.12 : 0.3) && !this.goingBack) this.target = Math.floor(this.p + 1e-6);
  }

  // The throw has arrived and the batters were home (or near enough to be
  // given in): the run counts. They are not moved: they run (or slide) the
  // last of it as they were going. Returns the runs completed, this one included.
  makeGround() {
    const runs = this.running ? Math.round(this.target) : this.completed;
    if (this.running) this.safe = true;
    this.closed = true; this.boundary = false;
    this.diveWanted = false; this.diveHeld = false;
    this.official = { completed: runs, crossed: runs % 2 === 1 };
    return runs;
  }

  update(dt) {
    if (!this.active) { this.rate = 0; return; }
    const F = this.cfg.field;
    const prev = this.p;
    if (this.down > 0 && !this.running) {
      this.rest += dt;
      // (lying where he landed while the third umpire looks at it; then up)
      if (!(this.stay && this.down >= F.getUp - LIE)) this.down = Math.max(0, this.down - dt);
    }
    if (this.running) {
      const first = this.completed === 0 && !this.goingBack && this.p < 1;
      let rate = 1 / (first ? F.runFirst : F.runNext);
      if (first) rate *= 0.55 + 0.9 * ss(0, 0.35, this.p);            // getting going from a standing start
      if (this.closed && !this.safe) rate *= this.boundary ? 0.4 : 0.6;   // ball dead: easing up (walking, after a boundary)
      const left = this.remaining * CREASE_TO_CREASE;
      if (!this.diving && !this.closed && (this.diveHeld || this.diveWanted) && left <= F.diveFrom && left > 0.4) {
        this.diving = true; this.diveStarted = true; this.diveT = 0;
        this.diveV = rate * CREASE_TO_CREASE;                 // (leaves the ground at the speed he was running: no jump in speed)
        const end = this.diveEnd || (this.headingTo('bowling') === 'striker' ? 'bowling' : 'batting');
        this.diveWho = this.headingTo(end);
      }
      if (this.diving) {
        this.diveT += dt;
        if (this.diveT > 0.3) this.diveV = Math.max(2.5, this.diveV - F.diveSlide * dt);    // down and sliding
        else if (this.diveV < F.diveSpeed) this.diveV = Math.min(F.diveSpeed, this.diveV + DIVE_PUSH * dt);   // the push off the ground
        rate = this.diveV / CREASE_TO_CREASE;
      }
      const d = this.target - this.p;
      const step = Math.min(Math.abs(d), rate * dt);
      this.p += Math.sign(d) * step;
      if (Math.abs(this.target - this.p) < 1e-6) {
        this.p = this.target;
        if (this.diving) { this.down = F.getUp; this.rest = 0; }
        this.diving = false; this.diveWanted = false;
      }
    }
    this.rate = dt > 0 ? (this.p - prev) / dt : 0;
  }

  // Metres short of the popping crease for the batter heading to either end
  // (both are equally far from their ground at any moment). <= 0: in.
  shortBy() {
    if (!this.running) return 0;
    const F = this.cfg.field;
    const reach = this.diving ? 1.0 + (F.diveReach - 1.0) * ss(0.05, 0.3, this.diveT) : 1.0;   // bat (and body) stretched for the line
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

  // The x each batter runs along. The striker on -X, the non-striker on +X;
  // when the player is in the way, the AI runner's lane passes him wide (on
  // the far side of him from the striker when he is the striker).
  lane(striker) {
    const ko = this.keepOut;
    let lane = striker ? -LANE : LANE;
    if (!ko || (striker && ko.striker)) return lane;
    const r = ko.r ?? RUNNER_CLEAR;
    if (ko.striker) return ko.x > 0 ? Math.min(-LANE, ko.x - r) : Math.max(LANE, ko.x + r);
    if (Math.abs(lane - ko.x) < r) lane = ko.x + (lane - ko.x >= 0 ? r : -r);
    return lane;
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
    const lane = this.lane(striker);
    const start = striker ? this.sStart : this.nStart;
    let x = lane, z = z0 + (z1 - z0) * f;
    if (leg === 0) { x = start.x + (lane - start.x) * ss(0, 0.25, f); z = start.z + (z1 - start.z) * f; }
    // Never through the player: pushed out to the edge of his space.
    const ko = this.keepOut;
    if (ko && !(striker && ko.striker)) {
      const dx = x - ko.x, dz = z - ko.z, d = Math.hypot(dx, dz), r = ko.r ?? RUNNER_CLEAR;
      if (d < r) {
        const ux = d > 1e-6 ? dx / d : (lane >= ko.x ? 1 : -1), uz = d > 1e-6 ? dz / d : 0;
        x = ko.x + ux * r; z = ko.z + uz * r;
      }
    }
    const moving = Math.abs(this.rate) > 1e-4;
    const dir = Math.sign(z1 - z0) * (this.rate < 0 ? -1 : 1);
    // The dive (and the moment on the ground after it) belongs to one batter.
    const mine = (striker ? 'striker' : 'nonStriker') === this.diveWho;
    // dive: { t: s since the launch, down: s since he came to rest (0: still moving), up: 0..1 getting up }
    const G = F_GETUP(this);
    const dive = mine && this.diving ? { t: this.diveT, down: 0, up: 0 }
      : mine && this.down > 0 ? { t: this.diveT, down: Math.max(1e-3, this.rest), up: Math.min(1, Math.max(0, (G - this.down - LIE) / Math.max(1e-3, G - LIE))) } : null;
    const heading = (dive && !this.diving ? this.diveDir : dir) >= 0 ? 0 : Math.PI;
    if (this.diving) this.diveDir = dir;
    return { x, z, speed: Math.abs(this.rate) * CREASE_TO_CREASE, heading, moving, diving: !!dive, dive, f };
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

// More runs off a ball that has got away again (an overthrow): `est` s from
// now until it should be back at the stumps. The run in progress is finished
// first; each further run is called from the crease. Returns how many more to
// call (0..3). A ball nobody will reach before the rope (Infinity): two.
export function planMoreRuns(est, runs = null, boldness = 0.4, rng = Math.random, cfg = CONFIG) {
  const F = cfg.field;
  if (est === Infinity) return 2;
  if (!(est > 0)) return 0;
  const noise = (rng() - 0.5) * 0.9 * (0.4 + boldness);
  const margin = F.runSafetyMargin + 0.55 * (1 - boldness) - 0.25 * boldness;
  const running = runs && runs.running;
  const finish = running ? runs.remaining * (runs.completed === 0 && !runs.goingBack ? F.runFirst : F.runNext) : 0;
  const first = runs && (runs.completed > 0 || running) ? F.runNext : F.runFirst;
  let n = 0;
  while (n < 3 && finish + 0.25 + first + n * F.runNext + margin <= est + noise) n++;
  return n;
}
