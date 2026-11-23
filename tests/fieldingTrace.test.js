// The fielding logic gives exactly the same passage of play as it did before
// it was made allocation-free: seeded innings (every kind of hit, running,
// run-outs, overthrows, catches and drops, the huddle, the walk back, balls to
// the keeper), digested frame by frame (tests/fieldTrace.js). The reference
// digests were written from the unmodified code; a change to the logic that
// changes any result, however small, changes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playPassage } from './fieldTrace.js';

const CASES = [
  [{ seed: 1, balls: 14 }, '5b821ac4', 12181],
  [{ seed: 2, balls: 14, spinner: true }, '1e72a912', 11799],
  [{ seed: 3, balls: 14, bowlerFields: false }, 'aa95ef5f', 12050],
  [{ seed: 4, balls: 14, greedy: 2 }, 'f87e3bb8', 12315],
  [{ seed: 5, balls: 14, spinner: true, bowlerFields: false, greedy: 1 }, 'b3df17dc', 12622],
  [{ seed: 6, balls: 14, greedy: 3 }, 'a38b62a7', 13155],
];

for (const [opts, digest, frames] of CASES) {
  test(`a seeded passage of play is unchanged, frame for frame (${JSON.stringify(opts)})`, () => {
    const r = playPassage(opts);
    assert.equal(r.frames, frames);
    assert.equal(r.digest, digest, r.outcomes.join(' | '));
  });
}
