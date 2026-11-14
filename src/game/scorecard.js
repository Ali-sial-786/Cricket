// Who made the runs and who took the wickets. Pure JS.
//
// The Innings keeps the totals; the Scorecard keeps the batters (runs, balls,
// how out), the strike, the bowlers' figures, the fall of wickets and the
// partnership.

const overs = (balls) => `${Math.floor(balls / 6)}.${balls % 6}`;

export class Scorecard {
  constructor(names = [], { team = '' } = {}) {
    this.team = team;
    this.batters = names.map((name, i) => ({ name, position: i, runs: 0, balls: 0, fours: 0, sixes: 0, out: null, batted: i < 2 }));
    this.striker = 0;
    this.nonStriker = this.batters.length > 1 ? 1 : -1;
    this.nextIn = 2;
    this.bowlers = [];
    this.bowler = null;
    this.fow = [];
    this.extras = { wides: 0, noBalls: 0, byes: 0 };
    this.partnership = 0;
  }

  setBowler(name, label = '') {
    let b = this.bowlers.find((x) => x.name === name);
    if (!b) { b = { name, label, balls: 0, runs: 0, wickets: 0 }; this.bowlers.push(b); }
    this.bowler = b;
    return b;
  }

  get onStrike() { return this.batters[this.striker] || null; }
  get offStrike() { return this.batters[this.nonStriker] || null; }
  swap() { if (this.nonStriker >= 0) { const s = this.striker; this.striker = this.nonStriker; this.nonStriker = s; } }

  // outcome: { runs, wide, noBall, wicket, boundary, who: 'striker' | 'nonStriker', fielder }
  // info: { overDone, score ("23/1"), overs ("2.3") }
  // Returns { dismissed, newBatter, milestones: [{ type: 'fifty' | 'twentyfive', name }] }.
  record(o, info = {}) {
    const s0 = this.striker, n0 = this.nonStriker;
    const s = this.batters[s0], bw = this.bowler;
    const out = { dismissed: null, newBatter: null, milestones: [] };
    if (!s) return out;
    const extra = o.wide || o.noBall ? 1 : 0;
    if (o.wide) {
      this.extras.wides += 1 + (o.runs || 0);
    } else {
      if (o.noBall) this.extras.noBalls++;
      else if (bw) bw.balls++;
      s.balls++;
      const before = s.runs;
      if (o.byes) this.extras.byes += o.runs || 0; else s.runs += o.runs || 0;
      if (o.boundary === 4) s.fours++;
      if (o.boundary === 6) s.sixes++;
      for (const [mark, type] of [[25, 'twentyfive'], [50, 'fifty'], [100, 'hundred']]) if (before < mark && s.runs >= mark) out.milestones.push({ type, name: s.name, runs: s.runs });
    }
    if (bw) bw.runs += (o.byes ? 0 : o.runs || 0) + extra;        // byes are not the bowler's fault
    this.partnership += (o.runs || 0) + extra;
    // Odd runs that were run (not a boundary) change the strike.
    if (!o.boundary && (o.runs || 0) % 2 === 1) this.swap();
    if (o.wicket) {
      const idx = o.who === 'nonStriker' && n0 >= 0 ? n0 : s0;
      const b = this.batters[idx];
      const by = bw ? bw.name : '';
      b.out = o.wicket === 'bowled' ? `b ${by}`
        : o.wicket === 'caught' ? `c ${o.fielder && o.fielder !== 'you' ? o.fielder : by === 'You' || o.fielder === 'you' ? 'You' : 'fielder'} b ${by}`
        : o.wicket === 'lbw' ? `lbw b ${by}`
        : o.wicket === 'stumped' ? `st Keeper b ${by}`
        : 'run out';
      if (bw && o.wicket !== 'run out') bw.wickets++;
      this.fow.push({ wicket: this.fow.length + 1, score: info.score || '', name: b.name, overs: info.overs || '' });
      this.partnership = 0;
      out.dismissed = b;
      const nb = this.batters[this.nextIn] || null;
      const slot = this.striker === idx ? 'striker' : 'nonStriker';
      if (nb) { nb.batted = true; this[slot] = this.nextIn; this.nextIn++; out.newBatter = nb; } else this[slot] = -1;
      if (this.striker < 0 && this.nonStriker >= 0) { this.striker = this.nonStriker; this.nonStriker = -1; }
    }
    if (info.overDone) this.swap();
    return out;
  }

  // ---- text for the HUD, the big screen and the result page ----
  batterText(b, notOutStar = true) { return b ? `${b.name} ${b.runs}${!b.out && notOutStar ? '*' : ''} (${b.balls})` : ''; }
  pairText() { return [this.onStrike, this.offStrike].filter(Boolean).map((b, i) => (i === 0 ? '▸ ' : '') + this.batterText(b)).join('   '); }
  bowlerText(b = this.bowler) { return b ? `${b.name} ${overs(b.balls)}-${b.runs}-${b.wickets}` : ''; }
  topBatters(n = 3) {
    return this.batters.filter((b) => b.batted && (b.balls > 0 || b.out)).sort((a, b) => b.runs - a.runs || a.balls - b.balls).slice(0, n).map((b) => this.batterText(b));
  }
  topBowlers(n = 2) {
    return this.bowlers.filter((b) => b.balls > 0).sort((a, b) => b.wickets - a.wickets || a.runs / Math.max(1, a.balls) - b.runs / Math.max(1, b.balls)).slice(0, n).map((b) => `${b.name} ${b.wickets}/${b.runs} (${overs(b.balls)})`);
  }
  extrasText() { const e = this.extras; return e.wides + e.noBalls + e.byes ? `Extras ${e.wides + e.noBalls + e.byes} (b ${e.byes}, w ${e.wides}, nb ${e.noBalls})` : ''; }
  // Full card lines (for a result page).
  lines(maxBatters = 3, maxBowlers = 2) {
    const out = [];
    const bats = this.topBatters(maxBatters);
    if (bats.length) out.push(bats.join(' · '));
    const bowls = this.topBowlers(maxBowlers);
    if (bowls.length) out.push(bowls.join(' · '));
    return out;
  }
}
