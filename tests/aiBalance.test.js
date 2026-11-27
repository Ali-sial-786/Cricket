// The AI batter against accurate bowling (you bowl, the aim marker on: the
// ball pitches where you aim it). Seeded balls, headless (tests/aiBalance.js:
// the game's deliveries, the AI's plan and swing in the physics world, the
// session's pad check and LBW judging, the field). A competent batter (medium)
// is out about once in 20 balls or so, rarely LBW; full straight balls are
// blocked or driven, not padded; the levels stay well apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bowlAt, AIMS } from './aiBalance.js';

const outs = (c) => c.bowled + c.lbw + c.caught;
const sum = (list, f) => list.reduce((a, c) => a + f(c), 0);

test('medium: about a wicket in 20 balls at any accurate line and length, LBW a small share of them', () => {
  const N = 200, all = [];
  for (const kind of ['fast', 'spin']) for (const aim of Object.keys(AIMS)) {
    const c = bowlAt({ aim, kind, difficulty: 'medium', n: N, seed: 21 });
    all.push(c);
    const o = outs(c);
    assert.ok(o / N <= 0.16, `${kind} ${aim}: out ${o} of ${N}`);
    // full and straight, or a yorker: blocked, dug out or driven -- hardly ever into the pads
    if (aim === 'fullMiddle' || aim === 'yorker') assert.ok(c.lbw / N <= 0.03 && c.appeals / N <= 0.06, `${kind} ${aim}: lbw ${c.lbw}, pad hits ${c.appeals} of ${N}`);
  }
  const balls = all.length * N, w = sum(all, outs), lbw = sum(all, (c) => c.lbw);
  assert.ok(balls / w >= 13 && balls / w <= 32, `a wicket every ${(balls / w).toFixed(1)} balls`);
  assert.ok(lbw / w <= 0.25, `lbw ${lbw} of ${w} dismissals`);
});

test('the levels stay apart: easy is out far more often than medium, medium than hard', () => {
  const rate = (difficulty) => {
    let w = 0, n = 0;
    for (const [kind, aim] of [['fast', 'goodOff'], ['fast', 'fullMiddle'], ['spin', 'goodOff'], ['fast', 'yorker']]) {
      const c = bowlAt({ aim, kind, difficulty, n: 150, seed: 33 });
      w += outs(c); n += 150;
    }
    return n / Math.max(1, w);
  };
  const easy = rate('easy'), medium = rate('medium'), hard = rate('hard');
  assert.ok(easy * 1.6 < medium && medium * 1.15 < hard, `balls a wicket: easy ${easy.toFixed(1)}, medium ${medium.toFixed(1)}, hard ${hard.toFixed(1)}`);
});
