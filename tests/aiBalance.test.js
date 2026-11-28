// The AI batter's balance when you bowl, the owner-facing numbers: seeded balls, headless
// (tests/aiBalance.js: the game's deliveries as the auto run-up bowls them, the AI's plan and
// swing in the physics world, the session's pad check and LBW judging, the field and the runs the
// AI batters take). A sensible bowler's mix (60% good length on or just outside off, 20% full and
// straight, 10% short, 10% yorkers) from the fast bowler, at the batting side's first-innings
// intent (aggression 0.5, modes.js). At medium: a wicket every 10-14 balls or so, a boundary every
// 5-8, about four balls in ten dots, caught the commonest way out, LBW a regular one (and the
// likeliest off full straight balls and yorkers). The levels stay apart; chasing hard means more
// runs and more wickets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bowlAt } from './aiBalance.js';

const outs = (c) => c.bowled + c.lbw + c.caught;
const runs = (c) => c.r1 + 2 * c.r2 + 3 * c.r3 + 4 * c.r4 + 6 * c.r6;
const mix = (difficulty, n, seed, aggression = 0.5) => {
  const c = bowlAt({ aim: 'mix', kind: 'fast', difficulty, n, seed, aggression, auto: true });
  const w = outs(c);
  return { c, w, bpw: n / Math.max(1, w), rpo: 6 * runs(c) / n, bpb: n / Math.max(1, c.r4 + c.r6), dots: (c.r0 + c.beaten + c.left) / n };
};
const f1 = (x) => x.toFixed(1);

test('medium, a sensible mix: a wicket every 10-15 balls, 5.5-9 an over, a boundary every 4.5-8.5, dots 35-50%; caught the commonest dismissal, LBW 15-30%', () => {
  const N = 1500, m = mix('medium', N, 21), { c, w } = m;
  const say = `rpo ${f1(m.rpo)}, a wicket every ${f1(m.bpw)}, a boundary every ${f1(m.bpb)}, dots ${(100 * m.dots).toFixed(0)}%, out b/lbw/c ${c.bowled}/${c.lbw}/${c.caught}`;
  assert.ok(m.bpw >= 10 && m.bpw <= 15, say);
  assert.ok(m.rpo >= 5.5 && m.rpo <= 9, say);
  assert.ok(m.bpb >= 4.5 && m.bpb <= 8.5, say);
  assert.ok(m.dots >= 0.35 && m.dots <= 0.5, say);
  assert.ok(c.lbw / w >= 0.15 && c.lbw / w <= 0.3, say);
  assert.ok(c.bowled / w >= 0.1 && c.bowled / w <= 0.3, say);
  assert.ok(c.caught > c.lbw && c.caught > c.bowled, say);
});

test('full and straight, or a yorker on the stumps: a plumb LBW shout every 10-22 balls at medium, LBW the likeliest way out, close ones too; more at easy, fewer at hard', () => {
  const N = 400;
  const at = (difficulty) => {
    const t = { n: 0, appeals: 0, plumb: 0, lbw: 0, bowled: 0, caught: 0 };
    for (const aim of ['fullMiddle', 'yorker']) {
      const c = bowlAt({ aim, kind: 'fast', difficulty, n: N, seed: 27, aggression: 0.5, auto: true });
      t.n += N; t.appeals += c.appeals; t.plumb += c.plumb; t.lbw += c.lbw; t.bowled += c.bowled; t.caught += c.caught;
    }
    return t;
  };
  const e = at('easy'), m = at('medium'), h = at('hard');
  const say = (t) => `a plumb shout every ${f1(t.n / Math.max(1, t.plumb))} balls (${t.appeals} appeals), out lbw/b/c ${t.lbw}/${t.bowled}/${t.caught}`;
  assert.ok(m.n / m.plumb >= 10 && m.n / m.plumb <= 22, say(m));
  assert.ok(m.appeals > m.plumb, `some close ones and not-outs as well: ${say(m)}`);
  assert.ok(m.lbw >= m.caught && m.lbw >= m.bowled, say(m));
  assert.ok(e.plumb > 1.5 * m.plumb && m.plumb > 1.5 * h.plumb, `easy: ${say(e)}; medium: ${say(m)}; hard: ${say(h)}`);
});

test('the levels stay apart (easy out every 5-9.5 balls, hard 15 or more; each scores faster than the one below) and chasing hard brings more runs and more wickets', () => {
  const N = 1200, e = mix('easy', N, 33), m = mix('medium', N, 33), h = mix('hard', N, 33);
  const say = `balls a wicket / an over: easy ${f1(e.bpw)} / ${f1(e.rpo)}, medium ${f1(m.bpw)} / ${f1(m.rpo)}, hard ${f1(h.bpw)} / ${f1(h.rpo)}`;
  assert.ok(e.bpw >= 5 && e.bpw <= 9.5 && h.bpw >= 15, say);
  assert.ok(e.bpw * 1.25 < m.bpw && m.bpw * 1.25 < h.bpw, say);
  assert.ok(e.rpo < m.rpo && m.rpo < h.rpo, say);
  // (aggressionNow in a chase: 0.85 needing well over a run a ball, 0.3 with time in hand)
  const hot = mix('medium', N, 33, 0.85), calm = mix('medium', N, 33, 0.3);
  assert.ok(hot.rpo > calm.rpo + 1.5 && hot.bpw < calm.bpw * 0.8, `chasing: ${f1(hot.rpo)} an over, out every ${f1(hot.bpw)}; in no hurry: ${f1(calm.rpo)}, every ${f1(calm.bpw)}`);
});
