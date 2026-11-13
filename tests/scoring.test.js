import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Innings, chaseTarget } from '../src/game/scoring.js';

test('overs, wides and boundaries are counted correctly', () => {
  const inn = new Innings({ balls: 6, wickets: 2 });
  inn.record({ runs: 4, boundary: 4 });
  inn.record({ runs: 0, wide: true });
  inn.record({ runs: 1 });
  inn.record({ runs: 6, boundary: 6 });
  assert.equal(inn.runs, 12);
  assert.equal(inn.legal, 3);
  assert.equal(inn.overs, '0.3');
  assert.equal(inn.fours, 1);
  assert.equal(inn.sixes, 1);
  inn.record({ wicket: 'bowled' });
  inn.record({ runs: 2 });
  const r = inn.record({ runs: 0 });
  assert.equal(r.overDone, true);
  assert.equal(inn.overs, '1.0');
  assert.ok(inn.complete);
});

test('chase result: won / lost / tied', () => {
  const a = new Innings({ balls: 6, wickets: 3, target: 10 });
  a.record({ runs: 6 }); a.record({ runs: 4 });
  assert.equal(a.chaseResult, 'won');
  const b = new Innings({ balls: 2, wickets: 3, target: 10 });
  b.record({ runs: 4 }); b.record({ runs: 5 });
  assert.equal(b.chaseResult, 'tied');
  const c = new Innings({ balls: 2, wickets: 1, target: 10 });
  c.record({ runs: 1 }); c.record({ wicket: 'caught' });
  assert.equal(c.chaseResult, 'lost');
});

test('chase targets scale with overs and difficulty', () => {
  assert.equal(chaseTarget('medium', 2), Math.round(1.6 * 12));
  assert.ok(chaseTarget('hard', 2) > chaseTarget('easy', 2));
});
