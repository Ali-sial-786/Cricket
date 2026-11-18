import test from 'node:test';
import assert from 'node:assert/strict';
import { edgeDistance, bestSpot, toLocal } from '../src/xr/playArea.js';

const rect = (x0, z0, x1, z1) => [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];

test('distance to the nearest edge: positive inside, negative outside', () => {
  const r = rect(-1, -2, 2, 1);
  assert.ok(Math.abs(edgeDistance(r, 0, 0) - 1) < 1e-9);
  assert.ok(Math.abs(edgeDistance(r, 1.5, 0) - 0.5) < 1e-9);
  assert.ok(edgeDistance(r, 3, 0) < 0);
});

test('the spot with the most room is the middle of a rectangle, and of an L the fat part', () => {
  const s = bestSpot(rect(0, 0, 3, 2));
  assert.ok(Math.abs(s.x - 1.5) < 0.6 && Math.abs(s.z - 1) < 0.05 && Math.abs(s.room - 1) < 0.05, JSON.stringify(s));
  const L = [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 1 }, { x: 1, z: 1 }, { x: 1, z: 4 }, { x: 0, z: 4 }];
  const sl = bestSpot(L);
  assert.ok(edgeDistance(L, sl.x, sl.z) > 0.45 && sl.x < 1.2 && sl.z < 1.2, JSON.stringify(sl));
  assert.equal(bestSpot([{ x: 0, z: 0 }, { x: 1, z: 0 }]), null);
});

test('bounds go from the bounded-floor space into local-floor', () => {
  // bounded space turned 90 deg about y and moved (2, 0, -1)
  const m = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 2, 0, -1, 1];
  const [p] = toLocal([{ x: 1, z: 0 }], m);
  assert.ok(Math.abs(p.x - 2) < 1e-9 && Math.abs(p.z + 2) < 1e-9, JSON.stringify(p));
});
