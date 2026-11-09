// AI bowler: picks machine-style settings for each ball (pure JS).
// Odd overs: seamer; even overs: spinner (variety in short chases).
import { clamp } from '../physics/math.js';
import { CONFIG } from '../config.js';

export class AIBowler {
  constructor(difficulty = 'medium', rng = Math.random) {
    this.d = CONFIG.bowlerAI[difficulty] || CONFIG.bowlerAI.medium;
    this.difficulty = difficulty;
    this.rng = rng;
    this.overType = null;
    this.over = -1;
    this.spinSide = 'off';
  }

  r() { return this.rng(); }
  pick(list) {
    let x = this.r() * list.reduce((a, b) => a + b[0], 0);
    for (const [w, v] of list) { if ((x -= w) <= 0) return v; }
    return list[list.length - 1][1];
  }

  typeForOver(over) { return over % 2 === 1 ? 'spin' : 'pace'; }

  next(innings) {
    const legal = innings ? innings.legal : 0;
    const over = Math.floor(legal / 6);
    if (over !== this.over) {
      this.over = over;
      this.overType = this.typeForOver(over);
      this.spinSide = this.r() < 0.5 ? 'off' : 'leg';
      this.swingDir = this.r() < 0.5 ? 1 : -1;
    }
    const death = innings && innings.ballsLeft <= 6;
    const acc = this.d.accuracy, varn = this.d.variation;
    const noise = (s) => (this.r() - 0.5) * 2 * s * (1.4 - acc);
    if (this.overType === 'spin') {
      const length = clamp(this.pick([[6, 5.0], [2, 3.5], [2, 6.5], [1, 2.2]]) + noise(1.0), 1.5, 9);
      return {
        paceKmh: 78 + this.r() * 14,
        line: clamp(this.pick([[5, 0.08], [3, 0.0], [2, 0.2]]) + noise(0.12), -0.4, 0.6),
        length, swing: 0, seam: 0,
        spinType: this.spinSide, spinAmount: 0.55 + this.r() * 0.4 * (0.5 + varn),
        release: 'over', variation: 0,
      };
    }
    const [lo, hi] = this.d.paceKmh;
    const choice = death
      ? this.pick([[4, 'yorker'], [3, 'good'], [2, 'full'], [1, 'bouncer'], [1, 'short']])
      : this.pick([[7, 'good'], [2, 'full'], [2, 'short'], [1, 'bouncer'], [1, 'yorker']]);
    const lengths = { yorker: 0.8, full: 3.5, good: 6.4, short: 9.8, bouncer: 12.0 };
    return {
      paceKmh: lo + this.r() * (hi - lo),
      line: clamp(this.pick([[6, 0.14], [3, 0.03], [2, 0.28], [1, -0.12]]) + noise(0.15), -0.5, 0.7),
      length: clamp(lengths[choice] + noise(1.2), 0.3, 13),
      swing: this.r() < 0.6 * varn ? this.swingDir * (0.3 + this.r() * 0.5) : 0,
      seam: this.r() < 0.6 ? (this.r() - 0.5) * 2 * varn * 0.8 : 0,
      spinType: 'none', spinAmount: 0, release: this.r() < 0.85 ? 'over' : 'around', variation: 0,
    };
  }

  describe(s) {
    if (s.spinType !== 'none') return `Spinner · ${s.spinType}-break · ${Math.round(s.paceKmh)} km/h`;
    return `Seamer · ${Math.round(s.paceKmh)} km/h${s.swing ? (s.swing > 0 ? ' · swinging away' : ' · swinging in') : ''}`;
  }
}
