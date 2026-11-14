import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunUp } from '../src/game/runup.js';
import { CONFIG } from '../src/config.js';

const R = CONFIG.bowling.runUp;
const DT = 1 / 72;
// Step until `until(run, ev)` is true (or a time limit); returns the events seen.
function run(r, held, secs, until = null) {
  const evs = [];
  for (let t = 0; t < secs; t += DT) {
    const h = typeof held === 'function' ? held(r, t) : held;
    const ev = r.update(DT, h);
    if (ev) evs.push(ev);
    if (until && until(r, ev)) break;
  }
  return evs;
}

test('every bowler type has a run-up; quicks run further and faster than spinners', () => {
  for (const k of ['fast', 'medium', 'offspin', 'legspin']) {
    const s = R[k];
    assert.ok(s.length > s.commit && s.top > 0 && s.accel > 0 && s.stand > 0 && s.stand < 1, k);
  }
  assert.ok(R.fast.length > R.medium.length && R.medium.length > R.offspin.length);
  assert.ok(R.fast.top > R.medium.top && R.medium.top > R.offspin.top);
  assert.ok(R.fast.stand < R.offspin.stand, 'a standstill costs a quick more pace');
});

test('holding the button runs you in: you commit, then stop exactly at the crease', () => {
  const r = new RunUp(R.fast);
  assert.equal(r.state, 'mark'); assert.equal(r.dist, R.fast.length); assert.equal(r.canRelease, false);
  const evs = run(r, true, 10, (x) => x.state === 'crease');
  assert.deepEqual(evs, ['start', 'commit', 'crease']);
  assert.equal(r.dist, 0); assert.equal(r.speed, 0);
  assert.ok(r.canRelease);
  assert.ok(r.best > R.fast.top * 0.95, `best ${r.best}`);
  assert.ok(Math.abs(r.paceFactor - 1) < 0.02);
});

test('letting go before the commit point pulls you out: you stop short of the commit line', () => {
  const r = new RunUp(R.fast);
  run(r, true, 10, (x) => x.dist < 6);
  const where = r.dist;
  const ev = r.update(DT, false);
  assert.equal(ev, 'pullout'); assert.equal(r.state, 'pulled');
  run(r, false, 0.8);
  assert.equal(r.speed, 0);
  assert.ok(r.dist < where && r.dist > R.fast.commit, `stopped at ${r.dist}`);
  assert.equal(r.canRelease, false);
});

test('pressing again quickly after pulling out carries on from where you stopped', () => {
  const r = new RunUp(R.medium);
  run(r, true, 10, (x) => x.dist < 6);
  run(r, false, 1.0);
  const stopped = r.dist;
  const ev = r.update(DT, true);
  assert.equal(ev, 'resume'); assert.equal(r.state, 'running');
  run(r, true, 0.2);
  assert.ok(r.dist < stopped);
});

test('pulling out and waiting puts you back on your mark', () => {
  const r = new RunUp(R.fast);
  run(r, true, 10, (x) => x.dist < 8);
  const evs = run(r, false, 4);
  assert.deepEqual(evs, ['pullout', 'backToMark']);
  assert.equal(r.state, 'mark'); assert.equal(r.dist, R.fast.length); assert.equal(r.best, 0);
});

test('inside the commit zone you are committed: letting go still takes you to the crease', () => {
  const r = new RunUp(R.fast);
  run(r, true, 10, (x) => x.state === 'committed');
  const evs = run(r, false, 3, (x) => x.state === 'crease');
  assert.deepEqual(evs, ['crease']);
  assert.equal(r.dist, 0);
});

test('the run never carries you past the crease, even when the button stays held', () => {
  for (const k of ['fast', 'medium', 'offspin', 'legspin']) {
    const r = new RunUp(R[k]);
    let min = Infinity;
    run(r, (x) => { min = Math.min(min, x.dist); return true; }, 8);
    assert.ok(min >= 0, k); assert.equal(r.dist, 0, k);
  }
});

test('no ball at the crease in time is a dead ball; a ball released in time is not', () => {
  const r = new RunUp(R.offspin);
  run(r, true, 10, (x) => x.state === 'crease');
  const evs = run(r, false, R.creaseWindow + 0.5);
  assert.deepEqual(evs, ['deadBall']); assert.equal(r.state, 'dead');
  const r2 = new RunUp(R.offspin);
  run(r2, true, 10, (x) => x.state === 'crease');
  r2.released();
  assert.deepEqual(run(r2, false, R.creaseWindow + 0.5), []);
});

test('momentum: a standstill costs pace, a full run does not', () => {
  const r = new RunUp(R.fast);
  assert.ok(Math.abs(r.paceFactor - R.fast.stand) < 1e-9);
  // Creep in: tap the button, pull out, resume from a standstill near the commit line.
  run(r, (x, t) => t < 0.35, 1);
  const slow = r.paceFactor;
  assert.ok(slow > R.fast.stand && slow < 0.95, `slow ${slow}`);
  const spin = new RunUp(R.legspin);
  assert.ok(spin.paceFactor >= 0.94);
});

test('with the run-up off you are at the crease with no time limit and no penalty', () => {
  const r = new RunUp(R.fast, { enabled: false });
  assert.equal(r.state, 'crease'); assert.equal(r.dist, 0);
  assert.ok(r.canRelease); assert.equal(r.paceFactor, 1);
  assert.deepEqual(run(r, false, 10), []);
  assert.deepEqual(run(r, true, 1), []);
});
