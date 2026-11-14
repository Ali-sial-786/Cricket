import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWide, shouldAppeal, heldBallAlpha } from '../src/game/bowlingRules.js';
import { trackLbw } from '../src/game/lbw.js';
import { BallState } from '../src/physics/ball.js';
import { predict } from '../src/physics/trajectory.js';
import { machineDelivery } from '../src/physics/bowlingMachine.js';
import { PITCH } from '../src/physics/pitch.js';
import { CONFIG } from '../src/config.js';

const W = PITCH.wideLineX;

test('wide: beyond the guideline either side (from middle stump), or over head height', () => {
  assert.equal(isWide(W + 0.05, 0.5), true);
  assert.equal(isWide(-W - 0.05, 0.5), true);
  assert.equal(isWide(W - 0.05, 0.5), false);
  assert.equal(isWide(0.4, 0.5), false, 'pitched "wide of off" but passing at 40 cm is no wide');
  assert.equal(isWide(0, CONFIG.match.wideHeight + 0.1), true);
});

test('wide: the line moves with a batter who walks across, never toward him', () => {
  // He moved 0.4 m to the off side: a ball 1.0 m outside off is now within his reach.
  assert.equal(isWide(W + 0.1, 0.5, 0.4), false);
  assert.equal(isWide(W + 0.5, 0.5, 0.4), true);
  // Moving to leg widens the leg-side line, not the off-side one.
  assert.equal(isWide(W + 0.05, 0.5, -0.3), true);
  assert.equal(isWide(-W - 0.1, 0.5, -0.3), false);
});

const base = { pitching: 'in_line', fullToss: false, impact: 'in_line', wickets: 'hitting', pitchPos: { x: 0, z: -5 }, impactPos: { x: 0, y: 0.3, z: -1.2 }, stumpsPos: { x: 0, y: 0.4 }, projectionValid: true };

test('LBW appeal: a plumb one is appealed; no track (unknown) still appeals', () => {
  assert.equal(shouldAppeal(base, { shotOffered: true }), true);
  assert.equal(shouldAppeal(null), true);
});

test('LBW appeal: none when pitched outside leg, or hit outside the line playing a shot, or clearly missing', () => {
  assert.equal(shouldAppeal({ ...base, pitching: 'outside_leg', pitchPos: { x: -0.4, z: -5 } }), false);
  assert.equal(shouldAppeal({ ...base, impact: 'outside_off', impactPos: { x: 0.4, y: 0.3, z: -1.2 } }, { shotOffered: true }), false);
  assert.equal(shouldAppeal({ ...base, impact: 'outside_leg', impactPos: { x: -0.4, y: 0.3, z: -1.2 } }, { shotOffered: false }), false);
  assert.equal(shouldAppeal({ ...base, wickets: 'missing', stumpsPos: { x: 0.6, y: 0.4 } }), false);
});

test('LBW appeal: outside off with no shot offered, hitting = a shout (the Law allows it)', () => {
  assert.equal(shouldAppeal({ ...base, impact: 'outside_off', impactPos: { x: 0.3, y: 0.3, z: -1.2 } }, { shotOffered: false }), true);
});

test('LBW appeal: a real fast yorker angled across, hitting a batter who moved over to off while playing a shot: no shout', () => {
  const d = machineDelivery({ paceKmh: 127, line: 0.55, length: 1.8, swing: 0 });
  const b = new BallState();
  b.active = true; b.pos.copy(d.releasePos); b.vel.copy(d.vel); b.spin.copy(d.spin);
  const pr = predict(b, { maxTime: 3, stop: (s) => s.pos.z >= -1.3 });
  const t = trackLbw({ impactState: pr.final });
  assert.equal(t.impact, 'outside_off');
  assert.equal(shouldAppeal(t, { shotOffered: true }), false);
});

test('held ball: fully drawn at arm\'s length, faded near the face, gone at the eyes', () => {
  const eye = { x: 0, y: 1.6, z: 0 };
  const [n, f] = CONFIG.bowling.heldBallFade;
  assert.equal(heldBallAlpha({ x: 0.3, y: 1.2, z: 0.2 }, eye), 1);
  assert.equal(heldBallAlpha({ x: 0, y: 1.6, z: n - 0.05 }, eye), 0);
  const mid = heldBallAlpha({ x: 0, y: 1.6, z: (n + f) / 2 }, eye);
  assert.ok(mid > 0.3 && mid < 0.7, `mid ${mid}`);
});
