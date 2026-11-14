import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runs, planRuns } from '../src/game/running.js';
import { CONFIG } from '../src/config.js';

const step = (r, sec) => { for (let i = 0; i < Math.round(sec * 100); i++) r.update(0.01); };

test('a called run completes and the batters then wait for another call', () => {
  const r = new Runs();
  r.begin(0);
  assert.equal(r.call(), true);
  assert.equal(r.call(), false, 'cannot queue a run mid-run');
  step(r, CONFIG.field.runFirst + 1.5);
  assert.equal(r.completed, 1);
  assert.equal(r.running, false);
  step(r, 3);
  assert.equal(r.completed, 1, 'no automatic second run');
  assert.equal(r.call(), true);
  step(r, CONFIG.field.runNext + 0.2);
  assert.equal(r.completed, 2);
});

test('turning back returns to the crease without scoring', () => {
  const r = new Runs();
  r.begin(0); r.call(); step(r, 1.2);
  assert.ok(r.p > 0.1 && r.p < 0.6);
  assert.equal(r.turnBack(), true);
  step(r, 3);
  assert.equal(r.completed, 0);
  assert.equal(r.running, false);
});

test('short of the crease mid-run, home at the end; a dive makes the ground sooner', () => {
  const r = new Runs();
  r.begin(0); r.call(); step(r, 1.5);
  assert.ok(r.shortBy() > 0);
  const a = new Runs(), b = new Runs();
  for (const x of [a, b]) { x.begin(0); x.call(); }
  let ta = 0, tb = 0;
  for (let t = 0; t < 8; t += 0.01) {
    a.update(0.01); b.update(0.01);
    b.dive(t);
    if (!ta && a.shortBy() <= 0) ta = t;
    if (!tb && b.shortBy() <= 0) tb = t;
  }
  assert.ok(tb < ta - 0.1, `dive ${tb} vs run ${ta}`);
});

test('the striker heads for the bowling end on the first run and swaps after it', () => {
  const r = new Runs();
  r.begin(0); r.call(); step(r, 1);
  assert.equal(r.headingTo('bowling'), 'striker');
  assert.equal(r.headingTo('batting'), 'nonStriker');
  step(r, 5);
  assert.equal(r.crossed, true);
  r.call(); step(r, 1);
  assert.equal(r.headingTo('batting'), 'striker');
});

test('AI takes more runs the longer the ball is away', () => {
  const rng = () => 0.5;
  assert.equal(planRuns(2.0, 0.4, rng), 0);
  assert.ok(planRuns(5.5, 0.4, rng) >= 1);
  assert.ok(planRuns(12, 0.4, rng) >= 2);
});

test('holding the dive launches it when the crease is in range, and the batter then has to get up', () => {
  const r = new Runs();
  r.begin(0); r.call();
  r.diveHeld = true;
  let launchedAt = null;
  for (let t = 0; t < 8 && r.running; t += 0.01) { r.update(0.01); if (r.diving && launchedAt == null) launchedAt = r.remaining * 17.68; }
  assert.ok(launchedAt != null && launchedAt <= CONFIG.field.diveFrom + 0.1 && launchedAt > 2, `launched ${launchedAt} m out`);
  assert.equal(r.completed, 1);
  assert.ok(r.down > 0, 'on the ground');
  assert.equal(r.state(true).diving || r.state(false).diving, true);
  assert.equal(r.call(), false, 'cannot set off again while lying there');
  step(r, CONFIG.field.getUp + 0.1);
  assert.equal(r.call(), true);
});

test('when the ball goes dead mid-run the batters carry on moving: nearly home they finish, otherwise they go back', () => {
  const a = new Runs();
  a.begin(0); a.call(); step(a, 1.2);
  const before = a.p;
  a.close();
  assert.deepEqual(a.official, { completed: 0, crossed: false });
  assert.equal(a.call(), false, 'no more runs');
  step(a, 0.2);
  assert.ok(a.p < before, 'trotting back');
  step(a, 4);
  assert.equal(a.running, false);
  assert.equal(a.p, 0);
  const b = new Runs();
  b.begin(0); b.call();
  while (b.remaining > 0.25) b.update(0.01);
  assert.ok(b.running);
  b.close();
  step(b, 3);
  assert.equal(b.p, 1, 'finished the run he was about to complete');
  assert.equal(b.official.completed, 0, 'but it does not count');
  const c = new Runs();
  c.begin(0); c.call(); step(c, 1.5); c.close({ stop: true });
  step(c, 1);
  assert.equal(c.running, false, 'run out: he stops where he is');
});

test('a diver left on the ground when the ball goes dead still gets up', () => {
  const r = new Runs();
  r.begin(0); r.call(); r.diveHeld = true;
  for (let t = 0; t < 8 && r.running; t += 0.01) r.update(0.01);
  r.close();
  assert.ok(r.down > 0);
  step(r, CONFIG.field.getUp + 0.2);
  assert.equal(r.down, 0);
  assert.equal(r.state(true).diving || r.state(false).diving, false);
});
