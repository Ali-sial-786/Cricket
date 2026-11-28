// The aim marker is the target: with it on, the ball pitches on it whatever the arm did
// (the owner: "the ball direction is still being controlled physically"); with it off, the arm decides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3, DEG } from '../src/physics/math.js';
import { mapRelease } from '../src/game/bowlingInput.js';
import { PLAYER_BOWLERS } from '../src/game/bowlerTypes.js';

const rel = new Vec3(0.45, 2.0, -19.0);
const none = new Vec3(), fwd = new Vec3(0, 0, 1);
// a release `az` degrees off straight and `elev` degrees up from level
const hand = (az, elev = -8, speed = 12) => new Vec3(Math.sin(az * DEG) * Math.cos(elev * DEG), Math.sin(elev * DEG), Math.cos(az * DEG) * Math.cos(elev * DEG)).scale(speed);
const at = (aim, az, elev, assist = true) => mapRelease({ releasePos: rel, handVel: hand(az, elev), handAngVel: none, palmDir: fwd, aim, assist, bowler: PLAYER_BOWLERS.fast }).target;

test('marker on: a wild arm still pitches the ball within a hand of the marker', () => {
  for (const aim of [{ x: 0.08, z: -6.5 }, { x: -0.6, z: -3 }, { x: 0.7, z: -11 }]) {
    for (const az of [-20, -10, 0, 10, 20]) for (const elev of [-20, -8, 4]) {
      const t = at(aim, az, elev);
      assert.ok(Math.abs(t.x - aim.x) < 0.15, `line ${t.x.toFixed(2)} vs ${aim.x} (arm ${az} deg)`);
      assert.ok(Math.abs(t.z - aim.z) < 0.15, `length ${t.z.toFixed(2)} vs ${aim.z} (elev ${elev} deg)`);
    }
  }
});

test('marker off: the arm decides the line', () => {
  const l = at(null, -12, -8, false), r = at(null, 12, -8, false);
  assert.ok(r.x - l.x > 2, `12 degrees either way moves the ball metres (${l.x.toFixed(2)} .. ${r.x.toFixed(2)})`);
});
