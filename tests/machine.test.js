import { test } from 'node:test';
import assert from 'node:assert/strict';
import { machineDelivery } from '../src/physics/bowlingMachine.js';
import { BallState } from '../src/physics/ball.js';
import { firstBounce } from '../src/physics/trajectory.js';

test('machine solver pitches on target across pace / length / line / swing / spin', () => {
  let worst = 0;
  for (const paceKmh of [110, 130, 150]) {
    for (const length of [0.8, 4, 7, 10, 12.5]) {
      for (const line of [-0.2, 0, 0.3]) {
        for (const swing of [-1, 0, 1]) {
          const d = machineDelivery({ paceKmh, length, line, swing });
          const b = new BallState();
          b.active = true;
          b.pos.copy(d.releasePos); b.vel.copy(d.vel); b.spin.copy(d.spin); b.swing = d.swing;
          const hit = firstBounce(b);
          const err = Math.hypot(hit.pos.x - d.target.x, hit.pos.z - d.target.z);
          worst = Math.max(worst, err);
          assert.ok(Math.abs(d.paceKmh - paceKmh) < 0.01);
        }
      }
    }
  }
  assert.ok(worst < 0.02, `worst solver error ${worst} m`);
});

test('spinners also solve accurately', () => {
  for (const spinType of ['off', 'leg']) {
    for (const length of [3, 5, 7]) {
      const d = machineDelivery({ paceKmh: 85, length, line: 0.05, spinType, spinAmount: 1 });
      assert.ok(d.solverError < 0.02, `${spinType} len ${length}: err ${d.solverError}`);
    }
  }
});

test('around the wicket releases from the leg side', () => {
  const d = machineDelivery({ release: 'around' });
  assert.ok(d.releasePos.x < 0);
});
