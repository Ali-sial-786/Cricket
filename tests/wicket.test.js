import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhysicsWorld } from '../src/physics/world.js';
import { machineDelivery } from '../src/physics/bowlingMachine.js';

function bowl(settings) {
  const world = new PhysicsWorld();
  const d = machineDelivery(settings);
  world.launch({ pos: d.releasePos, vel: d.vel, spin: d.spin, swing: d.swing, seamDeg: d.seamDeg, seamRandomScale: 0 });
  world.advanceTo(2.0);
  return world.drainEvents();
}

test('full straight ball hits the batting-end stumps', () => {
  for (const paceKmh of [110, 130, 150]) {
    const ev = bowl({ paceKmh, length: 3.5, line: 0.0 });
    const w = ev.find((e) => e.type === 'wicket');
    assert.ok(w, `expected bowled at ${paceKmh}`);
    assert.equal(w.end, 'batting');
  }
});

test('yorker on off stump hits the stumps; wide ball and bouncer miss', () => {
  assert.ok(bowl({ paceKmh: 140, length: 0.7, line: 0.1 }).find((e) => e.type === 'wicket'));
  assert.ok(!bowl({ paceKmh: 140, length: 5, line: 0.5 }).find((e) => e.type === 'wicket'));
  assert.ok(!bowl({ paceKmh: 140, length: 12.5, line: 0.0 }).find((e) => e.type === 'wicket'));
});
