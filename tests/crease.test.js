// In your ground or not (src/game/crease.js): judged on where you really are
// (headset, rig offset, real bat), never on the figure's animated feet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BackFoot, creaseShort, CREASE } from '../src/game/crease.js';
import { battingPoppingZ } from '../src/physics/pitch.js';

const HEAD0 = -1.15;                 // your head in your stance (the figure's feet: -1.43 front, -0.95 back)
const AIR = { y: 1.0, z: -1.6 };     // the bat up in the air, out in front

// Play a head path (room frame) through one BackFoot, 90 frames a second,
// and judge at the end. path: [[t, headZ, rigZ?]...], linear in between.
function play(path, { bat = AIR } = {}) {
  const foot = new BackFoot();
  let r = null;
  const T = path[path.length - 1][0];
  for (let t = 0; t <= T + 1e-9; t += 1 / 90) {
    let i = 0;
    while (i < path.length - 2 && path[i + 1][0] <= t) i++;
    const [t0, h0, g0 = 0] = path[i], [t1, h1, g1 = g0] = path[Math.min(i + 1, path.length - 1)];
    const k = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 1;
    const rigZ = g0 + (g1 - g0) * k, headZ = h0 + (h1 - h0) * k + rigZ;   // world head = room head + rig
    r = creaseShort({ xr: true, headZ, rigZ, foot, bat });
  }
  return r;
}

test('standing in your stance: in', () => {
  const r = play([[0, HEAD0], [1, HEAD0]]);
  assert.ok(r.margin < 0, `margin ${r.margin}`);
  assert.equal(r.by, 'foot');
  assert.ok(Math.abs(r.footZ - (HEAD0 + CREASE.footBack)) < 1e-9);
});

test('a big drive from where you stand (the figure strides, you lean) and back: not out', () => {
  // your head goes 0.45 m forward into the shot and comes back; your feet never moved
  const r = play([[0, HEAD0], [0.4, HEAD0], [0.7, HEAD0 - 0.45], [1.4, HEAD0 - 0.45], [2.0, HEAD0]]);
  assert.ok(r.margin < 0, `margin ${r.margin}`);
  // and at the top of the lean too
  const lean = play([[0, HEAD0], [0.4, HEAD0], [0.7, HEAD0 - 0.45], [1.0, HEAD0 - 0.45]]);
  assert.ok(lean.margin < 0, `margin ${lean.margin}`);
});

test('a full lunge, back heel up on the toe, behind the line: not out', () => {
  // the back foot pivots on its toe as you reach; it stays where it is
  const r = play([[0, HEAD0], [0.5, HEAD0 - 0.7], [1.5, HEAD0 - 0.7]]);
  assert.ok(r.footZ + CREASE.footHalf > battingPoppingZ);
  assert.ok(r.margin < 0, `margin ${r.margin}`);
});

test('really walked out past the line, bat in the air: out', () => {
  const r = play([[0, HEAD0], [0.3, HEAD0], [1.2, HEAD0 - 1.3], [2.0, HEAD0 - 1.3]]);
  assert.ok(r.margin > 0, `margin ${r.margin}`);
  assert.equal(r.by, 'foot');
});

test('feet out but the bat grounded behind the line: not out (the bat counts)', () => {
  const r = play([[0, HEAD0], [1.2, HEAD0 - 1.3], [2.0, HEAD0 - 1.3]], { bat: { y: 0.04, z: battingPoppingZ + 0.1 } });
  assert.ok(r.margin < 0, `margin ${r.margin}`);
  assert.equal(r.by, 'bat');
  // the bat grounded, but still short of the line, does not save you
  const s = play([[0, HEAD0], [1.2, HEAD0 - 1.3], [2.0, HEAD0 - 1.3]], { bat: { y: 0.04, z: battingPoppingZ - 0.1 } });
  assert.ok(s.margin > 0);
  // nor does a bat held up behind the line
  const u = play([[0, HEAD0], [1.2, HEAD0 - 1.3], [2.0, HEAD0 - 1.3]], { bat: { y: 0.6, z: battingPoppingZ + 0.3 } });
  assert.ok(u.margin > 0);
});

test('down the pitch with the trigger and not getting back: out; getting back: in', () => {
  // rig offset -1.6 (CONFIG.bat.advanceDistance); you stand still in the room
  const out = play([[0, HEAD0, 0], [0.45, HEAD0, -1.6], [1.2, HEAD0, -1.6]]);
  assert.ok(out.margin > 1, `margin ${out.margin}`);
  const back = play([[0, HEAD0, 0], [0.45, HEAD0, -1.6], [0.8, HEAD0, -1.6], [1.25, HEAD0, 0], [1.5, HEAD0, 0]]);
  assert.ok(back.margin < 0, `margin ${back.margin}`);
  // halfway back: still short
  const half = play([[0, HEAD0, 0], [0.45, HEAD0, -1.6], [0.8, HEAD0, -1.6], [1.0, HEAD0, -0.8]]);
  assert.ok(half.margin > 0);
});

test('stepping back toward the stumps brings the back foot with you', () => {
  const r = play([[0, HEAD0], [0.5, HEAD0 + 0.3], [1, HEAD0 + 0.3]]);
  assert.ok(Math.abs(r.footZ - (HEAD0 + 0.3 + CREASE.footBack)) < 1e-9);
});

test('no headset: judged on where the legs are (as before)', () => {
  assert.ok(creaseShort({ xr: false, legsZ: -1.05 }).margin < 0);
  assert.ok(creaseShort({ xr: false, legsZ: -1.05 - 1.6 }).margin > 1);
  // the desktop bat does not come into it
  assert.ok(creaseShort({ xr: false, legsZ: -2.65, bat: { y: 0, z: 0 } }).margin > 1);
});
