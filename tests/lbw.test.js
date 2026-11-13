import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng } from '../src/physics/math.js';
import { BallState } from '../src/physics/ball.js';
import { predict } from '../src/physics/trajectory.js';
import { machineDelivery } from '../src/physics/bowlingMachine.js';
import { PITCH } from '../src/physics/pitch.js';
import { CONFIG } from '../src/config.js';
import {
  trackLbw, reviewOutcome, umpireDecision, lbwDecision, lawOut, isMarginal,
  isLbwCandidate, wicketZone, fractionHitting, verdictRows,
} from '../src/game/lbw.js';

const HALF = PITCH.wicketHalfWidth;
const R = CONFIG.ball.radius;
const TOP = PITCH.stumpHeight + PITCH.bailRise;

// Fly a machine delivery to the pad's plane (z = padZ): the BallState there is
// what the game captures at pad impact (velocity before any deflection).
function impactState(settings, padZ = -1.3) {
  const d = machineDelivery(settings);
  const b = new BallState();
  b.active = true;
  b.pos.copy(d.releasePos);
  b.vel.copy(d.vel);
  b.spin.copy(d.spin);
  b.swing = d.swing;
  b.seamDeg = d.seamDeg;
  const pr = predict(b, { maxTime: 3, stop: (s) => s.pos.z >= padZ });
  assert.equal(pr.end, 'stop', 'delivery reached the pad');
  return pr.final;
}
const track = (settings, padZ) => trackLbw({ impactState: impactState(settings, padZ) });

// First line (x at the stumps) in a scan whose track satisfies `want`.
function scan(base, from, to, step, want, padZ) {
  for (let i = 0; i <= Math.round((to - from) / step); i++) {
    const t = track({ ...base, line: from + i * step }, padZ);
    if (want(t)) return t;
  }
  return null;
}

const PLUMB = { paceKmh: 135, length: 4.5, line: 0.0 };

test('plumb: pitched in line, hit in line, hitting middle => out', () => {
  const t = track(PLUMB);
  assert.equal(t.pitching, 'in_line');
  assert.equal(t.fullToss, false);
  assert.equal(t.impact, 'in_line');
  assert.equal(t.wickets, 'hitting');
  assert.ok(Math.abs(t.stumpsPos.x) < 0.04, `middle stump, x=${t.stumpsPos.x}`);
  assert.ok(t.stumpsPos.y > R && t.stumpsPos.y < PITCH.stumpHeight);
  assert.ok(t.fractionOfBallHitting > 0.99);
  assert.ok(Math.abs(t.impactPos.z + 1.3) < 0.08 && Math.abs(t.pitchPos.z + 4.5) < 0.05);

  // The projected path: impact -> the plane of the stumps, about 20 points.
  assert.ok(t.path.length >= 18 && t.path.length <= 24, `path points ${t.path.length}`);
  assert.deepEqual(t.path[0], t.impactPos);
  const last = t.path[t.path.length - 1];
  assert.equal(last.z, 0);
  assert.equal(last.x, t.stumpsPos.x);
  for (let i = 1; i < t.path.length; i++) assert.ok(t.path[i].z > t.path[i - 1].z, 'path runs toward the stumps');

  assert.equal(lbwDecision(t, { shotOffered: true }), 'out');
  // Given not out on the field: overturned, review kept.
  let o = reviewOutcome(t, { onFieldOut: false, shotOffered: true });
  assert.deepEqual([o.out, o.umpiresCall, o.reviewKept], [true, false, true]);
  assert.equal(typeof o.reason, 'string');
  // Given out and reviewed by the batter: stays out, review lost.
  o = reviewOutcome(t, { onFieldOut: true, shotOffered: true });
  assert.deepEqual([o.out, o.umpiresCall, o.reviewKept], [true, false, false]);
  assert.deepEqual(o.rows.map((r) => r.colour), ['green', 'green', 'green']);
});

test('pitched outside leg => not out regardless', () => {
  // Around the wicket, angling in to hit middle-and-leg.
  const t = track({ paceKmh: 135, length: 5.0, line: -0.05, release: 'around' });
  assert.equal(t.pitching, 'outside_leg');
  assert.ok(t.pitchPos.x < -HALF, 'leg side is -X');
  assert.equal(t.impact, 'in_line');
  assert.equal(t.wickets, 'hitting');
  for (const onFieldOut of [true, false]) {
    for (const shotOffered of [true, false]) {
      const o = reviewOutcome(t, { onFieldOut, shotOffered });
      assert.equal(o.out, false);
      assert.equal(o.umpiresCall, false);
      assert.equal(o.reviewKept, onFieldOut, 'kept only when it overturned an OUT');
      assert.match(o.reason, /outside leg/);
    }
  }
  assert.equal(lawOut(t, { shotOffered: false }), false);
});

test('pitching outside off is fine (no umpire\'s call for pitching)', () => {
  const t = track({ paceKmh: 130, length: 6, line: 0.25, seam: -1 });
  assert.equal(t.pitching, 'outside_off');
  assert.ok(t.pitchPos.x > HALF, 'off side is +X');
  assert.equal(t.impact, 'in_line');
  assert.equal(t.wickets, 'hitting');
  assert.equal(reviewOutcome(t, { onFieldOut: false, shotOffered: true }).out, true);
});

test('impact outside off: not out with a shot offered, can be out without one', () => {
  // A big off-break from wide of off, met well forward, turning back to hit.
  const base = { paceKmh: 85, length: 4.5, spinType: 'off', spinAmount: 1 };
  const t = scan(base, 0.24, 0.40, 0.01, (k) => k.impact === 'outside_off' && k.wickets === 'hitting', -2.0);
  assert.ok(t, 'found an off-break hitting outside the line and going on to hit');
  assert.ok(t.impactPos.x > HALF + R);

  let o = reviewOutcome(t, { onFieldOut: true, shotOffered: true });
  assert.deepEqual([o.out, o.reviewKept], [false, true]);
  assert.match(o.reason, /outside off/);
  assert.equal(o.rows.find((r) => r.label === 'IMPACT').colour, 'red');

  o = reviewOutcome(t, { onFieldOut: false, shotOffered: false });
  assert.deepEqual([o.out, o.umpiresCall, o.reviewKept], [true, false, true]);
  assert.equal(o.rows.find((r) => r.label === 'IMPACT').colour, 'green');
  assert.equal(lawOut(t, { shotOffered: false }), true);
  assert.equal(lawOut(t, { shotOffered: true }), false);
});

test('impact outside leg => not out even with no shot', () => {
  // A full toss from wide of leg stump swinging across to hit middle.
  const b = new BallState();
  b.active = true;
  b.pos.set(-0.22, 0.45, -1.3);
  b.vel.set(4.6, -0.5, 30);
  const t = trackLbw({ impactState: b });
  assert.equal(t.fullToss, true);
  assert.equal(t.impact, 'outside_leg');
  assert.equal(t.wickets, 'hitting');
  assert.equal(reviewOutcome(t, { onFieldOut: true, shotOffered: false }).out, false);
});

test('clipping the outside of leg stump => umpire\'s call keeps the decision and the review', () => {
  const t = scan({ paceKmh: 135, length: 4.5 }, -0.09, -0.16, -0.005,
    (k) => k.wickets === 'umpires_call' && k.impact === 'in_line' && k.pitching === 'in_line');
  assert.ok(t, 'found a delivery clipping leg stump');
  assert.ok(t.stumpsPos.x < -HALF && t.stumpsPos.x > -HALF - R, `centre just outside leg stump, x=${t.stumpsPos.x}`);
  assert.ok(t.fractionOfBallHitting > 0 && t.fractionOfBallHitting < 0.5);
  assert.equal(lbwDecision(t, { shotOffered: true }), 'umpires_call');
  assert.equal(isMarginal(t), true);
  for (const onFieldOut of [true, false]) {
    const o = reviewOutcome(t, { onFieldOut, shotOffered: true });
    assert.equal(o.out, onFieldOut, 'on-field decision stands');
    assert.equal(o.umpiresCall, true);
    assert.equal(o.reviewKept, true);
    assert.equal(o.rows.find((r) => r.label === 'WICKETS').colour, 'amber');
  }
  // The Law itself (the on-field umpire's yardstick): clipping counts.
  assert.equal(lawOut(t, { shotOffered: true }), true);
});

test('impact umpire\'s call: half the ball outside the line', () => {
  const t = scan({ paceKmh: 130, length: 6, seam: -1 }, 0.30, 0.40, 0.005,
    (k) => k.impact === 'umpires_call' && k.wickets === 'hitting');
  assert.ok(t, 'found an impact on the off-stump line');
  assert.ok(t.impactPos.x > HALF && t.impactPos.x <= HALF + R);
  // Shot offered: amber. No shot: outside off does not matter, so it is out.
  let o = reviewOutcome(t, { onFieldOut: false, shotOffered: true });
  assert.deepEqual([o.out, o.umpiresCall, o.reviewKept], [false, true, true]);
  o = reviewOutcome(t, { onFieldOut: false, shotOffered: false });
  assert.deepEqual([o.out, o.umpiresCall, o.reviewKept], [true, false, true]);
});

test('missing over the top => not out', () => {
  const t = track({ paceKmh: 145, length: 9.5, line: 0.0 });
  assert.equal(t.impact, 'in_line');
  assert.equal(t.wickets, 'missing');
  assert.ok(t.stumpsPos.y > TOP + R, `over the bails, y=${t.stumpsPos.y}`);
  assert.equal(t.fractionOfBallHitting, 0);
  for (const onFieldOut of [true, false]) {
    const o = reviewOutcome(t, { onFieldOut, shotOffered: true });
    assert.equal(o.out, false);
    assert.equal(o.reviewKept, onFieldOut);
    assert.match(o.reason, /missing/);
  }
});

test('full toss: the pitching rule does not apply', () => {
  // A yorker-length ball that hits the boot before it pitches.
  const st = impactState({ paceKmh: 140, length: 0.3, line: 0.0 });
  assert.equal(st.bounces, 0);
  const t = trackLbw({ impactState: st });
  assert.equal(t.fullToss, true);
  assert.equal(t.pitching, 'in_line');
  assert.equal(t.pitchPos, null);
  assert.equal(t.impact, 'in_line');
  assert.equal(t.wickets, 'hitting');
  const o = reviewOutcome(t, { onFieldOut: false, shotOffered: true });
  assert.equal(o.out, true);
  assert.equal(o.rows[0].text, 'FULL TOSS');
  // A pitch point beyond the impact (it would have pitched later) is ignored.
  const t2 = trackLbw({ impactState: st, pitchPos: { x: -0.5, y: R, z: -0.3 } });
  assert.equal(t2.fullToss, true);
  assert.equal(t2.pitching, 'in_line');
});

test('an explicit pitchPos overrides the state\'s first bounce', () => {
  const st = impactState(PLUMB);
  const t = trackLbw({ impactState: st, pitchPos: { x: -0.3, y: R, z: -5 } });
  assert.equal(t.pitching, 'outside_leg');
  assert.deepEqual(t.pitchPos, { x: -0.3, y: R, z: -5 });
});

test('the long-distance rule: 3 m or more from the stumps is umpire\'s call', () => {
  const t = track({ paceKmh: 135, length: 5.0, line: 0.0 }, -3.3);
  assert.ok(t.distance >= 3);
  assert.equal(t.wickets, 'umpires_call');
  assert.ok(t.fractionOfBallHitting > 0.99, 'the projection itself is hitting');
  assert.equal(reviewOutcome(t, { onFieldOut: false, shotOffered: true }).out, false);
  assert.equal(reviewOutcome(t, { onFieldOut: true, shotOffered: true }).out, true);
});

test('bat first and no-ball are decisive', () => {
  const t = track(PLUMB);
  let o = reviewOutcome(t, { onFieldOut: true, shotOffered: true, batFirst: true });
  assert.deepEqual([o.out, o.umpiresCall, o.reviewKept], [false, false, true]);
  assert.match(o.reason, /bat first/);
  o = reviewOutcome(t, { onFieldOut: true, shotOffered: true, noBall: true });
  assert.equal(o.out, false);
  assert.equal(verdictRows(t, { batFirst: true })[0].colour, 'red');
});

test('wicket zone: circle against the rectangle, to the top of the bails', () => {
  assert.equal(wicketZone(0, 0.4), 'hitting');
  assert.equal(wicketZone(HALF + R * 0.5, 0.4), 'umpires_call');
  assert.equal(wicketZone(-HALF - R * 0.5, 0.4), 'umpires_call');
  assert.equal(wicketZone(HALF + R * 1.1, 0.4), 'missing');
  assert.equal(wicketZone(0, TOP - 0.001), 'hitting');
  assert.equal(wicketZone(0, TOP + R * 0.9), 'umpires_call');
  assert.equal(wicketZone(0, TOP + R * 1.1), 'missing');
  // Diagonally past the top corner: inside the expanded rectangle, but missing.
  assert.equal(wicketZone(HALF + R * 0.8, TOP + R * 0.8), 'missing');
  assert.equal(wicketZone(NaN, 0.4), 'missing');
  assert.ok(Math.abs(fractionHitting(HALF, 0.4) - 0.5) < 0.01);
  assert.ok(Math.abs(fractionHitting(0, 0.4) - 1) < 0.01);
  assert.equal(fractionHitting(HALF + R, 0.4), 0);
});

test('on-field umpire: right on the clear ones, errs on the marginal ones', () => {
  const rate = (t, opts, n = 4000) => {
    const rng = makeRng(11);
    let outs = 0;
    for (let i = 0; i < n; i++) if (umpireDecision(t, { ...opts, rng })) outs++;
    return outs / n;
  };
  const plumb = track(PLUMB);
  const over = track({ paceKmh: 145, length: 9.5, line: 0.0 });
  const clip = scan({ paceKmh: 135, length: 4.5 }, -0.09, -0.16, -0.005, (k) => k.wickets === 'umpires_call' && k.impact === 'in_line');
  assert.equal(isMarginal(plumb), false);
  assert.equal(isMarginal(over), false);

  const pPlumb = rate(plumb, { shotOffered: true });
  const pOver = rate(over, { shotOffered: true });
  const pClip = rate(clip, { shotOffered: true });
  assert.ok(pPlumb > 0.95, `plumb given ${pPlumb}`);
  assert.ok(pOver < 0.05, `going over given ${pOver}`);
  // Clipping is out by the Law; the umpire misses it far more often.
  assert.ok(pClip > 0.4 && pClip < 0.8, `clipping given ${pClip}`);
  assert.ok(1 - pClip > 5 * (1 - pPlumb));

  // Perfect accuracy = the Law; rng extremes are deterministic.
  assert.equal(umpireDecision(clip, { shotOffered: true, accuracy: 1 }), true);
  assert.equal(umpireDecision(plumb, { shotOffered: true, rng: () => 0.999 }), true);
  assert.equal(umpireDecision(plumb, { shotOffered: true, rng: () => 0 }), false);
  assert.equal(umpireDecision(over, { shotOffered: true, rng: () => 0.999 }), false);
  assert.equal(umpireDecision(plumb, { shotOffered: true, noBall: true, rng: () => 0.999 }), false);
  // courtside's "lbw_given": a true LBW is given exactly that often.
  const pGiven = rate(plumb, { shotOffered: true, givenRate: 0.6 });
  assert.ok(Math.abs(pGiven - 0.6) < 0.04, `givenRate ${pGiven}`);
});

test('isLbwCandidate: a delivery striking the pad in front of the stumps', () => {
  const st = impactState(PLUMB);
  assert.equal(isLbwCandidate(st), true);
  assert.equal(isLbwCandidate(st, { batFirst: true }), false);
  assert.equal(isLbwCandidate(st, { noBall: true }), false);
  const hit = st.clone();
  hit.batted = true;
  assert.equal(isLbwCandidate(hit), false);
  const back = st.clone();
  back.vel.z = -10;
  assert.equal(isLbwCandidate(back), false);
});

test('trackLbw does not mutate the captured state', () => {
  const st = impactState(PLUMB);
  const before = JSON.stringify(st);
  trackLbw({ impactState: st });
  assert.equal(JSON.stringify(st), before);
});
