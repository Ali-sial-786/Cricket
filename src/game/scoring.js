// Innings / match scoring. Pure JS.

export class Innings {
  constructor({ balls = 12, wickets = 3, target = null, batting = 'player', label = '' } = {}) {
    this.ballsLimit = balls;
    this.wicketsLimit = wickets;
    this.target = target;          // runs needed to win (chases), or null
    this.batting = batting;        // 'player' | 'ai'
    this.label = label;
    this.runs = 0;
    this.wickets = 0;
    this.legal = 0;
    this.extras = 0;
    this.fours = 0;
    this.sixes = 0;
    this.log = [];
    this.thisOver = [];
  }

  // Record a delivery. outcome: { runs, wide, wicket: null | 'bowled' | 'caught' | 'lbw' | ..., boundary: 0|4|6 }
  record(outcome) {
    const o = { runs: 0, wide: false, wicket: null, boundary: 0, ...outcome };
    let total = o.runs;
    if (o.wide) { total += 1; this.extras += 1; } else { this.legal++; }
    this.runs += total;
    if (o.boundary === 4) this.fours++;
    if (o.boundary === 6) this.sixes++;
    if (o.wicket) this.wickets++;
    const sym = o.wicket ? 'W' : o.wide ? `${total}wd` : String(total === 0 ? '•' : total);
    this.thisOver.push(sym);
    this.log.push({ ...o, total, sym, over: Math.floor((this.legal - (o.wide ? 0 : 1)) / 6) });
    const overDone = !o.wide && this.legal % 6 === 0;
    const prevOver = overDone ? this.thisOver.slice() : null;
    if (overDone) this.thisOver = [];
    return { total, overDone, prevOver };
  }

  get overs() { return `${Math.floor(this.legal / 6)}.${this.legal % 6}`; }
  get ballsLeft() { return Math.max(0, this.ballsLimit - this.legal); }
  get runsNeeded() { return this.target == null ? null : Math.max(0, this.target - this.runs); }
  get scoreText() { return `${this.runs}/${this.wickets}`; }

  get complete() {
    if (this.target != null && this.runs >= this.target) return true;
    return this.legal >= this.ballsLimit || this.wickets >= this.wicketsLimit;
  }

  // For a chase: 'won' | 'lost' | 'tied' | null (in progress). Without a
  // target: null.
  get chaseResult() {
    if (this.target == null) return null;
    if (this.runs >= this.target) return 'won';
    if (!this.complete) return null;
    return this.runs === this.target - 1 ? 'tied' : 'lost';
  }

  summary() {
    let s = `${this.scoreText} (${this.overs} ov)`;
    if (this.target != null && !this.complete) s += ` · need ${this.runsNeeded} off ${this.ballsLeft}`;
    return s;
  }
}

// Wickets allowed per innings for a given number of overs.
export function wicketsForOvers(overs) { return Math.max(2, Math.min(5, overs + 1)); }

// Run-chase target for difficulty and overs.
export function chaseTarget(difficulty, overs) {
  const perBall = { easy: 1.35, medium: 1.6, hard: 1.9 }[difficulty] || 1.6;
  return Math.round(perBall * overs * 6);
}
