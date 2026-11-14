// Replay camera geometry (src/game/replayFraming.js): never in anybody, nobody in the way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepClear, blocksSight, badness, nearestOnBody, CLEAR } from '../src/game/replayFraming.js';

// A standing person at (x, z): top of the head 1.9 m, hips 0.95 m.
const person = (x, z, h = 1.9) => ({ a: { x, y: h, z }, b: { x, y: h / 2, z }, c: { x, y: 0.05, z } });
const gap = (p, B) => { const q = nearestOnBody(p, B); return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z); };

test('keepClear: a camera inside a head is pushed out to the clearance', () => {
  const ump = person(0.3, -21.6);
  const p = keepClear({ x: 0.35, y: 1.7, z: -21.5 }, [ump]);
  assert.ok(gap(p, ump) >= CLEAR - 1e-6, `gap ${gap(p, ump)}`);
});

test('keepClear: clear of everybody at once, and never under the grass', () => {
  const bodies = [person(0, 0), person(1.2, 0), person(0.6, 0.9)];
  const p = keepClear({ x: 0.6, y: 0.2, z: 0.3 }, bodies);
  for (const B of bodies) assert.ok(gap(p, B) >= CLEAR - 0.05, `gap ${gap(p, B)}`);
  assert.ok(p.y >= 0.35);
});

test('keepClear: a camera already clear is left alone', () => {
  const p = keepClear({ x: 4, y: 1.4, z: -2 }, [person(-0.4, -1.1)]);
  assert.deepEqual(p, { x: 4, y: 1.4, z: -2 });
});

test('blocksSight: the umpire in front of a low camera behind the bowler blocks the batter', () => {
  const batter = { x: -0.4, y: 1.1, z: -1.1 };
  const ump = person(0.6, -21.8);
  assert.equal(blocksSight({ x: 0.9, y: 1.7, z: -24 }, batter, ump), true);
  // high over his hat the batter is in view
  assert.equal(blocksSight({ x: 0.9, y: 4.3, z: -23.7 }, batter, ump), false);
});

test('badness: counts bodies too close and bodies in the way', () => {
  const at = { x: 0, y: 1, z: 0 };
  assert.equal(badness({ x: 5, y: 1.3, z: 0 }, at, [person(10, 10)]), 0);
  assert.equal(badness({ x: 5, y: 1.3, z: 0 }, at, [person(2.5, 0)]), 1);
  assert.equal(badness({ x: 5, y: 1.3, z: 0 }, at, [person(5.2, 0.1)]), 3);
});
