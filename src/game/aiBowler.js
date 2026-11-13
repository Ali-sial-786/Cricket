// AI bowling attack (pure JS). Five bowler types, each with its own pace
// band and repertoire of named deliveries; one bowler per over, rotating.
// next() returns machine-style settings (+ name / bowler info) for the solver.
import { clamp } from '../physics/math.js';
import { CONFIG } from '../config.js';

// length: metres from the batter's stumps; line: x at the stumps (+ = off side).
const D = (name, weight, o) => ({ name, weight, ...o });
export const BOWLER_TYPES = {
  fast: {
    label: 'Fast', pace: [136, 150], runup: 'long',
    deliveries: [
      D('good length', 6, { length: 6.6, line: 0.14 }),
      D('back of a length', 3, { length: 8.6, line: 0.12 }),
      D('bouncer', 2, { length: 12.2, line: 0.0, pace: 1.0 }),
      D('yorker', 2, { length: 0.9, line: 0.02 }),
      D('full outside off', 2, { length: 3.6, line: 0.3 }),
      D('slower ball', 1, { length: 6.0, line: 0.1, pace: 0.8 }),
    ],
  },
  swing: {
    label: 'Swing', pace: [126, 138], runup: 'long',
    deliveries: [
      D('outswinger', 5, { length: 5.6, line: 0.16, swing: 0.8 }),
      D('inswinger', 4, { length: 5.2, line: 0.1, swing: -0.8 }),
      D('full outswinger', 2, { length: 3.4, line: 0.22, swing: 0.9 }),
      D('inswinging yorker', 2, { length: 1.0, line: 0.0, swing: -0.9 }),
      D('wobble seam', 2, { length: 6.6, line: 0.12, seam: 0.5 }),
      D('bouncer', 1, { length: 11.8, line: 0.0 }),
    ],
  },
  seam: {
    label: 'Medium-pace seam', pace: [114, 127], runup: 'medium',
    deliveries: [
      D('seamer, nipping away', 4, { length: 6.4, line: 0.14, seam: 0.8 }),
      D('seamer, nipping back', 4, { length: 6.4, line: 0.18, seam: -0.8 }),
      D('off-cutter', 2, { length: 6.0, line: 0.16, seam: -1.0, pace: 0.9 }),
      D('leg-cutter', 2, { length: 6.0, line: 0.06, seam: 1.0, pace: 0.9 }),
      D('slower ball', 2, { length: 5.5, line: 0.1, pace: 0.78 }),
      D('yorker', 1, { length: 1.0, line: 0.04 }),
    ],
  },
  offspin: {
    label: 'Off-spin', pace: [78, 92], runup: 'short', spinner: true,
    deliveries: [
      D('off-break', 6, { length: 4.8, line: 0.2, spinType: 'off', spinAmount: 0.8 }),
      D('flighted off-break', 2, { length: 3.6, line: 0.22, spinType: 'off', spinAmount: 0.9, pace: 0.9 }),
      D('arm ball', 2, { length: 5.2, line: 0.1, spinType: 'off', spinAmount: 0.1, pace: 1.06 }),
      D('doosra', 2, { length: 5.0, line: 0.08, spinType: 'leg', spinAmount: 0.6 }),
      D('quicker one', 1, { length: 6.0, line: 0.06, spinType: 'off', spinAmount: 0.4, pace: 1.12 }),
    ],
  },
  legspin: {
    label: 'Leg-spin', pace: [74, 89], runup: 'short', spinner: true,
    deliveries: [
      D('leg-break', 6, { length: 4.8, line: -0.02, spinType: 'leg', spinAmount: 0.85 }),
      D('googly', 3, { length: 4.8, line: 0.16, spinType: 'off', spinAmount: 0.7 }),
      D('top-spinner', 2, { length: 5.4, line: 0.06, spinType: 'leg', spinAmount: 0.15, pace: 1.04 }),
      D('flipper', 1, { length: 6.4, line: 0.04, spinType: 'none', pace: 1.14 }),
      D('tossed-up leg-break', 2, { length: 3.4, line: 0.0, spinType: 'leg', spinAmount: 1.0, pace: 0.9 }),
    ],
  },
};

const NAMES = {
  fast: ['R. Thunder', 'J. Vance', 'M. Okoro'], swing: ['T. Hale', 'S. Whitby', 'A. Renner'], seam: ['D. Marsh', 'P. Castell', 'K. Nduka'],
  offspin: ['N. Sato', 'H. Banerjee', 'L. Adeyemi'], legspin: ['C. Warrick', 'Y. Farouk', 'I. Lindqvist'],
};
// One bowler per over; a five-over innings sees every type.
const ROTATION = ['swing', 'fast', 'offspin', 'seam', 'legspin'];

export class AIBowler {
  constructor(difficulty = 'medium', rng = Math.random) {
    this.q = CONFIG.bowlerAI[difficulty] || CONFIG.bowlerAI.medium;
    this.paceScale = (CONFIG.difficulty[difficulty] || CONFIG.difficulty.medium).paceScale;
    this.difficulty = difficulty;
    this.rng = rng;
    this.over = -1;
    this.offset = Math.floor(rng() * ROTATION.length);
    this.attack = ROTATION.map((type) => ({ type, name: NAMES[type][Math.floor(rng() * NAMES[type].length)], ...BOWLER_TYPES[type] }));
    this.current = this.attack[0];
    this.lastName = '';
  }

  pick(list) {
    let x = this.rng() * list.reduce((a, d) => a + d.weight, 0);
    for (const d of list) { if ((x -= d.weight) <= 0) return d; }
    return list[list.length - 1];
  }

  bowlerForOver(over) { return this.attack[(over + this.offset) % this.attack.length]; }

  // Returns true when a new bowler has just come on.
  startOver(over) {
    if (over === this.over) return false;
    this.over = over;
    this.current = this.bowlerForOver(over);
    return true;
  }

  next(innings) {
    const legal = innings ? innings.legal : 0;
    const newBowler = this.startOver(Math.floor(legal / 6));
    const b = this.current;
    const death = innings && innings.ballsLeft <= 6 && !b.spinner;
    let list = b.deliveries;
    if (death) list = list.map((d) => ({ ...d, weight: d.weight * (d.name.includes('yorker') ? 3 : d.name.includes('slower') ? 2 : 1) }));
    let d = this.pick(list);
    if (d.name === this.lastName && this.rng() < 0.6) d = this.pick(list);   // avoid obvious repeats
    this.lastName = d.name;
    const acc = this.q.accuracy;
    const noise = (s) => (this.rng() - 0.5) * 2 * s * (1.45 - acc);
    const [lo, hi] = b.pace;
    const paceKmh = (lo + this.rng() * (hi - lo)) * (d.pace || 1) * this.paceScale;
    return {
      paceKmh,
      line: clamp(d.line + noise(0.16), -0.5, 0.75),
      length: clamp(d.length + noise(d.length < 2 ? 0.7 : 1.2), 0.3, 13),
      swing: (d.swing || 0) * (0.5 + 0.5 * this.q.variation + 0.3 * this.rng()),
      seam: clamp((d.seam || 0) * (0.5 + 0.5 * this.q.variation), -1, 1),
      spinType: d.spinType || 'none',
      spinAmount: d.spinAmount || 0,
      release: b.spinner || this.rng() < 0.85 ? 'over' : 'around',
      variation: 0,
      // info for the HUD / commentary / figure
      name: d.name, bowler: b.name, bowlerType: b.type, bowlerLabel: b.label, runup: b.runup, spinner: !!b.spinner, newBowler,
    };
  }

  describe(s) { return `${s.bowler} · ${s.bowlerLabel}`; }
}
