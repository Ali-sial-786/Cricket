// How loud the ground is, moment to moment: the state machine behind the crowd bed (plain logic,
// tested in tests/audioMix.test.js). The game's cues (the run-up, the release, the shot, the dead
// ball, a review) and the crowd's reactions drive it; crowd.js turns its outputs into gains.
//
//   between balls   the murmur (bed 1), livelier after a big moment (excitement lingers)
//   run-up          building as the bowler comes in, more so in a tight finish
//   release         the held breath: the murmur drops away for a second
//   ball in play    back up; the roar follows the reactions (a six swells and dies over ~8 s)
//   a review        hushed, waiting
//
// outputs (smoothed): bed (x the murmur), roar (0..1 the excited layer), bright (0..1 how much
// top the murmur has), detail (x how often the stands' details happen), hush (0..1: no whistles
// or shouts while the ball is on its way).

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// How far each reaction swells the roar (x strength) and lifts the lingering excitement.
export const SWELL = {
  six: [1, 0.5], four: [0.75, 0.35], wicketFor: [1, 0.55], wicketAgainst: [0.35, -0.3], milestone: [0.8, 0.4],
  win: [1, 0.6], lose: [0.25, -0.3], boundaryAgainst: [0.3, 0], dropped: [0.45, 0.1], close: [0.4, 0.12],
  edge: [0.35, 0.08], beaten: [0.25, 0.05], skied: [0.55, 0.1], appeal: [0.4, 0.05], single: [0.12, 0.02],
  dot: [0.05, 0], miss: [0.15, 0], lastOver: [0.3, 0.2],
};

export class CrowdMood {
  constructor() {
    this.phase = 'idle'; this.phaseT = 0;
    this.excite = 0.25;        // lingers after big moments (0..1)
    this.swell = 0;            // the roar of the last reaction (0..1.2), decays
    this.tension = 0;          // a close finish (0..1), from the situation
    this.reviewing = false; this.reviewT = 0;
    this.practice = false;     // nets: a sparse crowd
    this.menu = false;         // behind the menus: the ground, quietly
    this.out = { bed: 1, roar: 0, bright: 0.4, detail: 1, hush: 0 };
  }

  setPhase(p) { if (p !== this.phase) { this.phase = p; this.phaseT = 0; } }

  /** A game cue (the commentary's match event kinds). */
  cue(kind) {
    switch (kind) {
      case 'runup': this.setPhase('runup'); break;
      case 'release': this.setPhase('release'); break;
      case 'hit': case 'swing': case 'charge': if (this.phase === 'release' || this.phase === 'runup') this.setPhase('live'); break;
      case 'ball': this.setPhase('after'); break;
      case 'review': case 'third_umpire': this.reviewing = true; this.reviewT = 0; break;
      case 'review_result': case 'third_result': this.reviewing = false; break;
      case 'innings_break': case 'result': this.setPhase('idle'); this.reviewing = false; break;
      default:
    }
  }

  react(kind, strength = 1) {
    const s = SWELL[kind];
    if (!s) return;
    const k = clamp(strength, 0.3, 1.3);
    this.swell = Math.max(this.swell, s[0] * k);
    this.excite = clamp(this.excite + s[1] * k, 0.1, 1);
  }

  /**
   * The match situation (commentary.situation): a chase getting close late on, with wickets in
   * hand, is tense; a lost cause or a stroll is not.
   */
  situation(s) {
    if (!s || s.target == null || !s.ballsLimit) { this.tension = 0; return this.tension; }
    const need = s.target - (s.runs || 0), left = s.ballsLimit - (s.balls || 0);
    if (need <= 0 || left <= 0) { this.tension = 0; return 0; }
    const late = sstep(30, 3, left);                         // the last five overs, most in the last
    const rate = need / left;
    const live = rate <= 3 ? sstep(0.25, 0.9, rate) * (1 - sstep(2.2, 3, rate)) : 0;   // gettable, not a stroll
    const wk = s.wickets == null ? 1 : 0.6 + 0.4 * sstep(1, 3, (s.wicketsLimit ?? 10) - s.wickets);
    this.tension = clamp(late * Math.max(live, need <= 6 ? 1 : 0) * wk, 0, 1);
    return this.tension;
  }

  update(dt) {
    this.phaseT += dt; if (this.reviewing) this.reviewT += dt;
    if (this.reviewing && this.reviewT > 30) this.reviewing = false;    // (a review that never told us it ended)
    this.swell *= Math.exp(-dt / 2.6);
    this.excite = Math.max(0.15, this.excite - dt * 0.006);
    const T = this.tension, t = this.phaseT;
    let bed = 1 + 0.25 * this.excite, roar = 0.06 * this.excite + 0.12 * T, hush = 0;
    switch (this.phase) {
      case 'runup': {
        const a = sstep(0, 2.4, t);
        bed *= 1 + a * (0.3 + 0.4 * T); roar += a * (0.08 + 0.3 * T);
        hush = a * 0.6;
        break;
      }
      case 'release':
        bed *= 0.5 - 0.15 * T; roar *= 0.25; hush = 1;
        if (t > 1.6) this.setPhase('live');               // (nothing happened: back to the ball in play)
        break;
      case 'live': bed *= 0.85 + 0.15 * sstep(0, 1, t); hush = 1 - sstep(0.5, 2, t); break;
      case 'after': if (t > 6) this.setPhase('idle'); break;
      default:
    }
    if (this.reviewing) { bed *= 0.55; roar *= 0.3; hush = Math.max(hush, 0.7); }
    roar = Math.max(roar, this.swell);
    if (this.practice) { bed *= 0.45; roar *= 0.4; }
    if (this.menu) { bed *= 0.6; roar *= 0.2; }
    const o = this.out;
    // The hush comes fast (a held breath), the release of it slower; a swell rises in 0.2 s.
    const tb = bed < o.bed ? 0.18 : 0.5, tr = roar > o.roar ? 0.2 : 0.9;
    o.bed += (bed - o.bed) * (1 - Math.exp(-dt / tb));
    o.roar += (roar - o.roar) * (1 - Math.exp(-dt / tr));
    o.bright = clamp(0.35 + 0.5 * o.roar + 0.15 * this.excite, 0, 1);
    o.detail = (0.6 + this.excite) * (this.practice ? 0.3 : 1) * (this.menu ? 0.5 : 1);
    o.hush += (hush - o.hush) * (1 - Math.exp(-dt / 0.2));
    return o;
  }
}
