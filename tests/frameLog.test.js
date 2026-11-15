// The long-frame log: frames over the limit (their own work, or the gap since
// the frame before) and frames with a first use, in a ring buffer, with what
// was going on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameLog } from '../src/game/frameLog.js';

const info = (programs = 37, textures = 44, geometries = 123) => ({ programs, textures, geometries });

test('frame log: steady frames are not logged; a slow frame and a missed frame are, with the context', () => {
  const L = new FrameLog({ limit: 25 });
  let t = 1000;
  for (let i = 0; i < 100; i++) { t += 13.9; assert.equal(L.sample(t, 6, info(), () => ({ state: 'play' })), null); }
  t += 13.9;
  const slow = L.sample(t, 41.2, info(), () => ({ state: 'play', session: 'chase:review' }));
  assert.ok(slow && slow.long && slow.work === 41.2 && slow.session === 'chase:review');
  t += 55.6;                                                     // the headset missed three frames
  const gap = L.sample(t, 5, info(), () => ({ replay: { t: 1.86, phase: 'play' } }));
  assert.ok(gap && gap.long && gap.gap === 55.6 && gap.replay.phase === 'play');
  assert.equal(L.count, 2);
  assert.equal(L.entries.length, 2);
});

test('frame log: a first use (new program / texture / buffer) is logged even when the frame was quick', () => {
  const L = new FrameLog();
  L.sample(0, 5, info());
  const e = L.sample(13.9, 5, info(38, 44, 125));
  assert.deepEqual(e.fresh, { programs: 1, textures: 0, geometries: 2 });
  assert.equal(e.long, false);
  assert.equal(L.count, 0);
});

test('frame log: a ring of the last `cap` entries', () => {
  const L = new FrameLog({ cap: 8 });
  let t = 0;
  for (let i = 0; i < 20; i++) { t += 100; L.sample(t, 30 + i, info()); }
  assert.equal(L.entries.length, 8);
  assert.equal(L.entries[0].work, 42);
  assert.equal(L.entries[7].work, 49);
  assert.equal(L.count, 20);
});
