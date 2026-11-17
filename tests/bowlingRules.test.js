import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWide, shouldAppeal, heldBallAlpha, strikerHeights, isShortPitched, BouncerCount, bouncerCall } from '../src/game/bowlingRules.js';
import { trackLbw } from '../src/game/lbw.js';
import { BallState } from '../src/physics/ball.js';
import { predict } from '../src/physics/trajectory.js';
import { machineDelivery } from '../src/physics/bowlingMachine.js';
import { PITCH } from '../src/physics/pitch.js';
import { CONFIG } from '../src/config.js';

const W = PITCH.wideLineX, LEG = PITCH.legWideX;

test('wide: off side beyond the guideline, leg side outside the marker line, or over his head', () => {
  assert.equal(isWide(W + 0.05, 0.5), true);
  assert.equal(isWide(W - 0.05, 0.5), false);
  assert.equal(isWide(0.4, 0.5), false, 'pitched "wide of off" but passing at 40 cm is no wide');
  // Leg side (ICC ODI/T20I 22): tight - outside the protected-area marker, 1 ft from middle stump.
  assert.ok(Math.abs(LEG - 0.3048) < 1e-9);
  assert.equal(isWide(-LEG - 0.05, 0.5), true, 'just down the leg side, past his legs: wide');
  assert.equal(isWide(-0.2, 0.5), false, 'between leg stump and the marker: not a wide');
  assert.equal(isWide(-0.6, 0.5), true, 'the old 0.89 m line let this one go');
  // Over the head of the striker standing upright at the popping crease.
  const h = CONFIG.match.batterHeight;
  assert.equal(isWide(0, h + 0.05), true);
  assert.equal(isWide(0, h - 0.05), false, 'head-high is not over his head');
  assert.equal(isWide(0, 1.75, { head: 1.7 }), true, 'a shorter striker: over his head');
  assert.equal(isWide(0, 1.75, { head: 1.9 }), false);
});

test('wide: the line moves with a batter who walks across, never toward him', () => {
  // He moved 0.4 m to the off side: a ball 1.0 m outside off is now within his reach.
  assert.equal(isWide(W + 0.1, 0.5, { shiftX: 0.4 }), false);
  assert.equal(isWide(W + 0.5, 0.5, { shiftX: 0.4 }), true);
  // ...and the leg-side line stays where his guard was (he cannot make a fair ball by shuffling).
  assert.equal(isWide(-LEG - 0.05, 0.5, { shiftX: 0.4 }), true);
  assert.equal(isWide(-0.2, 0.5, { shiftX: 0.4 }), false, 'behind a shuffling batter, inside the marker: no wide');
  // Moving to leg widens the leg-side line, not the off-side one.
  assert.equal(isWide(W + 0.05, 0.5, { shiftX: -0.3 }), true);
  assert.equal(isWide(-LEG - 0.1, 0.5, { shiftX: -0.3 }), false);
});

test('striker heights: standard figure, or yours from the headset eye height', () => {
  const s = strikerHeights();
  assert.equal(s.head, CONFIG.match.batterHeight);
  assert.ok(s.shoulder > 1.4 && s.shoulder < 1.55, `shoulder ${s.shoulder}`);
  const you = strikerHeights(1.6);
  assert.ok(Math.abs(you.head - 1.71) < 1e-9);
  assert.ok(you.shoulder < you.head - 0.25);
});

test('short-pitched: pitched and over the shoulder; full tosses and spinners are not', () => {
  assert.equal(isShortPitched({ bounced: true, y: 1.6, shoulder: 1.48 }), true);
  assert.equal(isShortPitched({ bounced: true, y: 1.3, shoulder: 1.48 }), false, 'chest high');
  assert.equal(isShortPitched({ bounced: false, y: 1.6, shoulder: 1.48 }), false, 'a full toss is a beamer question');
  assert.equal(isShortPitched({ bounced: true, y: 1.6, shoulder: 1.48, spinner: true }), false);
});

test('bouncer limit: one an over (T20I); the next is a no-ball; a new over starts again', () => {
  assert.equal(CONFIG.match.bouncersPerOver, 1);
  const c = new BouncerCount();
  const a = c.add(0);
  assert.deepEqual(a, { n: 1, noBall: false });
  assert.match(bouncerCall(a), /one for the over/);
  const b = c.add(0);
  assert.equal(b.noBall, true);
  assert.match(bouncerCall(b), /too many bouncers/);
  assert.equal(c.add(0).noBall, true, 'and every one after it');
  assert.equal(c.count(0), 3);
  assert.deepEqual(c.add(1), { n: 1, noBall: false });
  assert.equal(c.count(0), 0);
  const two = new BouncerCount(2);               // ODI
  assert.equal(two.add(4).noBall, false); assert.equal(two.add(4).noBall, false); assert.equal(two.add(4).noBall, true);
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
