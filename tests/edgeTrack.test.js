// Edge truth (contact log), Snicko, Hot Spot, the umpire's edge errors and
// the review counts. src/game/edgeTrack.js, src/render/hotspot.js,
// src/game/reviews.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhysicsWorld } from '../src/physics/world.js';
import { BatGeometry } from '../src/physics/bat.js';
import { Vec3, Quat, Pose, makeRng } from '../src/physics/math.js';
import { CONFIG } from '../src/config.js';
import {
  ContactLog, EDGE, edgeTruth, snickoTrace, traceAt, hotspotMarks, umpireCaught, umpireHearsEdge,
  fieldersAppeal, caughtReview, edgeRows, edgeQuestion, aiWillReview, classifyBat, UMPIRE_EDGE, noiseLevel,
} from '../src/game/edgeTrack.js';
import { hotspotLayout, hotspotCaption } from '../src/render/hotspot.js';
import { Reviews } from '../src/game/reviews.js';
import { reviewOutcome, verdictRows } from '../src/game/lbw.js';

const R = CONFIG.ball.radius;
const G = new BatGeometry(CONFIG.bat);
const HX = G.bladeHalf.x;
const BAT_Z = -1.2, GRIP_Y = 0.9;

// A bat standing still (upright, face to the bowler: local +z = world -z).
function staticBat(x = 0, y = GRIP_Y, z = BAT_Z, q = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), Math.PI)) {
  const pose = new Pose(new Vec3(x, y, z), q);
  return {
    pose,
    poseAt(t, out) { return out.copy(pose); },
    velAt(t, lin, ang, grip) { lin.set(0, 0, 0); ang.set(0, 0, 0); grip.copy(pose.p); },
  };
}

// Fly a ball along +Z past the bat at a world x offset from its centre line.
function flyPast(xOff, { y = 0.45, speed = 30, provider = staticBat() } = {}) {
  const w = new PhysicsWorld(CONFIG, 3);
  w.addBat('ai', provider, new BatGeometry(CONFIG.bat), 1);
  const log = new ContactLog(CONFIG).attach(w);
  w.launch({ pos: new Vec3(xOff, y, BAT_Z - 1.6), vel: new Vec3(0, 0.15, speed), spin: new Vec3(0, 0, 0) });
  w.advanceTo(0.25);
  return { w, log };
}

test('contact log: the middle, thick, thin and faint edges, and a miss, from the physics', () => {
  const at = (x) => edgeTruth(flyPast(x).log);
  const mid = at(0);
  assert.equal(mid.touched, true);
  assert.equal(mid.where, 'face');
  assert.equal(mid.thickness, 'full');
  const seq = [0.062, 0.08, 0.097].map(at);
  assert.deepEqual(seq.map((t) => t.where), ['edge', 'edge', 'edge']);
  assert.deepEqual(seq.map((t) => t.thickness), ['thick', 'thin', 'faint']);
  // thinner = weaker, and deflected less
  assert.ok(seq[0].bat.strength > seq[1].bat.strength && seq[1].bat.strength > seq[2].bat.strength);
  assert.ok(seq[2].bat.deflection < seq[0].bat.deflection + 1e-9);
  const miss = at(HX + R + 0.012);
  assert.equal(miss.touched, false);
  assert.equal(miss.bat, null);
  assert.ok(miss.pass && miss.pass.d > 0.004 && miss.pass.d < 0.03, `closest approach ${miss.pass && miss.pass.d}`);
  assert.equal(noiseLevel(miss), 'close');
  // the contact time: when the ball reached the bat (1.6 m at 30 m/s, less the radius / thickness)
  assert.ok(Math.abs(mid.bat.t - (1.6 - R - G.bladeHalf.z) / 30) < 0.004, `bat t ${mid.bat.t}`);
});

test('contact log: which edge — outside (off side) or inside', () => {
  // Face to the bowler: local +x is world -x. The off side is +X.
  const off = edgeTruth(flyPast(0.08).log), leg = edgeTruth(flyPast(-0.08).log);
  assert.equal(off.bat.edge, 'outside');
  assert.equal(leg.bat.edge, 'inside');
  // the bat-local contact is on the edge it names
  assert.ok(off.bat.u < -0.9 && leg.bat.u > 0.9, `u ${off.bat.u} ${leg.bat.u}`);
});

test('contact log: the bat coming down into the turf is logged with its time', () => {
  // A bat dropping at 2 m/s, its toe starting 0.25 m up; the ball well wide.
  const base = staticBat();
  const p0 = base.pose.p.clone();
  const provider = {
    poseAt(t, out) { out.copy(base.pose); out.p.y = p0.y + 0.14 - 2 * t; return out; },
    velAt(t, lin, ang, grip) { lin.set(0, -2, 0); ang.set(0, 0, 0); grip.copy(base.pose.p); },
  };
  const { log } = flyPast(0.6, { provider });
  const g = log.events.filter((e) => e.type === 'ground');
  assert.equal(g.length, 1, 'one strike, not one per step');
  // toe (lowest corner) at y = GRIP_Y + 0.14 + toeY - 2t = EDGE.ground
  const tExp = (GRIP_Y + 0.14 + G.toeY - EDGE.ground) / 2;
  assert.ok(Math.abs(g[0].t - tExp) < 0.003, `ground at ${g[0].t}, expected ${tExp}`);
  assert.ok(g[0].speed > 1.5);
});

test('contact log: a new delivery starts a new log; a snapshot keeps the old one', () => {
  const { w, log } = flyPast(0);
  const snap = log.snapshot();
  assert.equal(snap.events.length, 1);
  w.launch({ pos: new Vec3(0.6, 0.45, BAT_Z - 1.6), vel: new Vec3(0, 0.15, 30) });
  w.advanceTo(w.time + 0.2);
  assert.equal(log.events.filter((e) => e.type === 'bat').length, 0);
  assert.equal(snap.events.length, 1);
});

// Synthetic logs for Snicko: a bat contact of a given thickness at t = 0.5.
function synthLog({ thickness = null, pad = null, ground = null, passD = 0.2, tPass = 0.5 } = {}) {
  const log = new ContactLog(CONFIG);
  log.launchT = 0;
  // frames: the ball passing the bat 4 mm per 0.25 ms … (closest at tPass)
  for (let i = -200; i <= 200; i++) {
    const t = tPass + i / 2000;
    log.frames.push({ t, x: 0.1, y: 0.4, z: -1.2 + 30 * (t - tPass), lx: HX + R + passD, ly: -0.6, lz: -30 * (t - tPass), d: Math.hypot(passD, 30 * (t - tPass)), ax: -1 });
  }
  if (thickness) {
    const x = { faint: HX + 0.9 * R, thin: HX + 0.3 * R, thick: HX * 0.9, full: 0 }[thickness];
    const face = thickness === 'full' || thickness === 'thick' ? 'front' : 'side';
    log.addBat({ t: tPass, face, part: 'blade', local: { x, y: -0.55, z: 0.05 }, speedIn: 30, batId: 'ai' }, G, null, { x: 1, y: 0, z: 0 });
  }
  if (pad) log.addPad({ t: pad, pos: { x: 0.05, y: 0.4, z: -1.1 }, vin: { x: 0, y: 0, z: 30 }, at: { x: 0, z: -1.1, halfX: 0.2 } });
  if (ground) log.addGround({ t: ground, speed: 2.5 });
  return log;
}
const peak = (tr, t0, t1) => {
  let best = { a: 0, t: 0 };
  for (let i = 0; i < tr.n; i++) {
    const t = tr.t0 + (tr.t1 - tr.t0) * i / (tr.n - 1);
    if (t >= t0 && t <= t1 && tr.env[i] > best.a) best = { a: tr.env[i], t };
  }
  return best;
};
const width = (tr, at, level) => {
  // time the envelope stays above `level` around `at`
  let n = 0;
  for (let i = 0; i < tr.n; i++) {
    const t = tr.t0 + (tr.t1 - tr.t0) * i / (tr.n - 1);
    if (Math.abs(t - at) < 0.03 && tr.env[i] > level) n++;
  }
  return n * (tr.t1 - tr.t0) / (tr.n - 1);
};

test('Snicko: the spike is exactly at the contact, taller for a thicker edge, a faint one still clear', () => {
  const amps = {};
  for (const th of ['faint', 'thin', 'thick', 'full']) {
    const log = synthLog({ thickness: th });
    const tr = snickoTrace(log, { seed: 5 });
    const p = peak(tr, tr.t0, tr.t1);
    assert.ok(Math.abs(p.t - 0.5) < 0.0006, `${th}: peak at ${p.t}`);
    amps[th] = p.a;
    // the frames include one exactly on the contact
    assert.ok(tr.frames.some((f) => Math.abs(f - 0.5) < 1e-9));
    assert.equal(tr.spikes[0].kind, 'bat');
  }
  assert.ok(amps.faint < amps.thin && amps.thin < amps.thick && amps.thick <= amps.full, JSON.stringify(amps));
  // noise floor: far from anything
  const quiet = snickoTrace(synthLog({}), { seed: 5 });
  const floor = peak(quiet, quiet.t0, quiet.t1).a;
  assert.ok(floor < 0.1, `noise floor ${floor}`);
  assert.ok(amps.faint > 3 * floor, `faint ${amps.faint} vs floor ${floor}`);
  // deterministic for a seed, different for another
  const a = snickoTrace(synthLog({ thickness: 'thin' }), { seed: 9 }), b = snickoTrace(synthLog({ thickness: 'thin' }), { seed: 9 });
  assert.deepEqual(Array.from(a.values), Array.from(b.values));
  const c = snickoTrace(synthLog({ thickness: 'thin' }), { seed: 10 });
  assert.notDeepEqual(Array.from(a.values), Array.from(c.values));
});

test('Snicko: the pad is a broader, lower bump; the bat on the ground a spike not at the ball', () => {
  const edge = snickoTrace(synthLog({ thickness: 'thin' }), { seed: 3 });
  const pad = snickoTrace(synthLog({ pad: 0.5 }), { seed: 3 });
  const pe = peak(edge, edge.t0, edge.t1), pp = peak(pad, pad.t0, pad.t1);
  assert.ok(pp.a < pe.a, 'lower');
  assert.ok(width(pad, 0.5, pp.a * 0.5) > 4 * width(edge, 0.5, pe.a * 0.5), 'broader');
  assert.equal(pad.spikes[0].kind, 'pad');
  // the bat thuds into the ground 20 ms before the ball goes past (5 cm away)
  const log = synthLog({ ground: 0.48, passD: 0.05 });
  const gr = snickoTrace(log, { seed: 3 });
  const pg = peak(gr, gr.t0, gr.t1);
  assert.ok(Math.abs(pg.t - 0.48) < 0.001, `ground spike at ${pg.t}`);
  assert.ok(pg.a > 0.3, 'a real spike');
  assert.equal(gr.spikes[0].aligned, false);
  assert.ok(traceAt(gr, 0.5) < 0.2, 'nothing as the ball passes');
  const truth = edgeTruth(log);
  assert.equal(truth.touched, false);
  assert.equal(noiseLevel(truth), 'noise');
  // the window stretches to show it
  assert.ok(gr.t0 < 0.48 - 0.01);
});

test('Hot Spot: the mark is where the ball touched; none without a contact', () => {
  const rect = { x: 0, y: 0, w: 920, h: 500 };
  const outside = hotspotMarks(synthLog({ thickness: 'thin' }));
  assert.equal(outside.length, 1);
  assert.equal(outside[0].edge, 'outside');
  let L = hotspotLayout(rect, { marks: outside });
  const main = L.spots.find((s) => s.view === 'main'), zoom = L.spots.find((s) => s.view === 'zoom');
  // the outside edge is the bat's left edge from the bowler's end
  assert.ok(Math.abs(main.x - L.bat.x) < 2, `main x ${main.x} vs bat left ${L.bat.x}`);
  assert.ok(Math.abs(zoom.x - L.zBat.x) < 2);
  // and at its height: 0.55 m below the grip is this far up the blade
  const vb = (-0.55 - G.toeY) / (G.shoulderY - G.toeY);
  assert.ok(Math.abs(main.y - (L.bat.y + L.bat.h * (1 - vb))) < 1);
  // inside edge: the right edge
  const inside = hotspotMarks(synthLog({ thickness: 'thin' }));
  inside[0].edge = 'inside';
  L = hotspotLayout(rect, { marks: inside });
  assert.ok(Math.abs(L.spots[0].x - (L.bat.x + L.bat.w)) < 2);
  // size by strength
  const faint = hotspotLayout(rect, { marks: hotspotMarks(synthLog({ thickness: 'faint' })) }).spots[0];
  const thick = hotspotLayout(rect, { marks: hotspotMarks(synthLog({ thickness: 'thick' })) }).spots[0];
  assert.ok(faint.r < thick.r);
  // the pad: on the pad of that leg, at its height
  const padM = hotspotMarks(synthLog({ pad: 0.5 }));
  assert.equal(padM[0].on, 'pad');
  L = hotspotLayout(rect, { marks: padM });
  const front = L.pads.find((p) => p.leg === 'front');
  assert.ok(Math.abs(L.spots[0].x - front.x) < front.w / 2);
  assert.ok(Math.abs(L.spots[0].y - (L.ground - 0.4 * L.S)) < 1);
  // nothing touched: nothing on the picture
  assert.equal(hotspotLayout(rect, { marks: hotspotMarks(synthLog({ ground: 0.48 })) }).spots.length, 0);
  assert.match(hotspotCaption(outside), /OUTSIDE EDGE · \d+ cm FROM THE TOE/);
  assert.equal(hotspotCaption([]), 'NO MARK ON THE BAT OR PAD');
});

test('umpire: thick edges almost always right, faint ones often missed, noise sometimes given', () => {
  const rate = (truth, opts = {}, n = 6000) => {
    const rng = makeRng(17);
    let outs = 0;
    for (let i = 0; i < n; i++) if (umpireCaught(truth, { rng, ...opts })) outs++;
    return outs / n;
  };
  const tr = (th) => edgeTruth(synthLog({ thickness: th }));
  const pThick = rate(tr('thick')), pThin = rate(tr('thin')), pFaint = rate(tr('faint'));
  assert.ok(pThick > 0.96, `thick ${pThick}`);
  assert.ok(Math.abs(pThin - (1 - UMPIRE_EDGE.miss.thin)) < 0.025, `thin ${pThin}`);
  assert.ok(Math.abs(pFaint - (1 - UMPIRE_EDGE.miss.faint)) < 0.025, `faint ${pFaint}`);
  // no edge: given out only on a noise / a close one
  const noise = edgeTruth(synthLog({ ground: 0.49, passD: 0.04 }));
  const close = edgeTruth(synthLog({ passD: 0.03 }));
  const clear = edgeTruth(synthLog({ passD: 0.25 }));
  assert.equal(noise.noise, 'noise'); assert.equal(close.noise, 'close'); assert.equal(clear.noise, 'clear');
  const pNoise = rate(noise), pClose = rate(close), pClear = rate(clear);
  assert.ok(Math.abs(pNoise - UMPIRE_EDGE.phantom.noise) < 0.025, `noise ${pNoise}`);
  assert.ok(pClose < pNoise && pClear < pClose && pClear < 0.02, `${pClose} ${pClear}`);
  // a better umpire (hard) errs less, a worse one (easy) more
  assert.ok(rate(tr('faint'), { accuracy: 0.92 }) > pFaint && rate(tr('faint'), { accuracy: 0.8 }) < pFaint);
  // LBW: the inside edge heard (or not) at the same rates; no edge, nothing to hear
  const rng = makeRng(4);
  let heard = 0;
  for (let i = 0; i < 6000; i++) if (umpireHearsEdge(tr('faint'), { rng })) heard++;
  assert.ok(Math.abs(heard / 6000 - (1 - UMPIRE_EDGE.miss.faint)) < 0.025);
  assert.equal(umpireHearsEdge(clear, { rng: () => 0 }), false);
  // fielders: always up for a caught thick edge, mostly for a faint one, never for nothing
  assert.equal(fieldersAppeal(tr('thick'), { rng: () => 0.999, catchTaken: true }), true);
  assert.equal(fieldersAppeal(clear, { rng: () => 0 }), false);
});

test('caught reviews: decided by the edge; overturned keeps the review, upheld loses it', () => {
  const faint = edgeTruth(synthLog({ thickness: 'faint' }));
  const none = edgeTruth(synthLog({ ground: 0.49, passD: 0.04 }));
  let o = caughtReview(faint, { onFieldOut: true });          // given out, batter reviews: upheld
  assert.deepEqual([o.out, o.overturned, o.reviewKept, o.umpiresCall], [true, false, false, false]);
  o = caughtReview(none, { onFieldOut: true });               // given out wrongly: overturned
  assert.deepEqual([o.out, o.overturned, o.reviewKept], [false, true, true]);
  assert.deepEqual(o.rows.map((r) => `${r.label}:${r.text}:${r.colour}`), ['SNICKO:SPIKE NOT AT BAT:red', 'HOT SPOT:NO MARK:red']);
  o = caughtReview(faint, { onFieldOut: false });             // missed, fielders review: overturned
  assert.deepEqual([o.out, o.reviewKept], [true, true]);
  assert.deepEqual(o.rows.map((r) => r.colour), ['green', 'green']);
  assert.equal(o.rows[0].text, 'FAINT SPIKE AT BAT');
  assert.equal(o.rows[1].text, 'MARK ON OUTSIDE EDGE');
  // edge questions: an edge or bat-pad yes; the middle of the bat, or a thick edge to the deep, no
  assert.equal(edgeQuestion(faint, { catchDist: 40 }), true);
  assert.equal(edgeQuestion(edgeTruth(synthLog({ thickness: 'full' })), { catchDist: 15 }), false);
  assert.equal(edgeQuestion(edgeTruth(synthLog({ thickness: 'thick' })), { catchDist: 15 }), true);
  assert.equal(edgeQuestion(edgeTruth(synthLog({ thickness: 'thick' })), { catchDist: 60 }), false);
  assert.equal(edgeQuestion(edgeTruth(synthLog({ thickness: 'full', pad: 0.52 })), { catchDist: 8 }), true);
});

test('LBW: an inside edge onto the pad is NOT OUT on review, from the edge truth', () => {
  const log = synthLog({ thickness: 'thin', pad: 0.505 });
  const truth = edgeTruth(log);
  assert.equal(truth.batFirst, true);
  assert.equal(truth.batPad, true);
  const plumb = { fullToss: false, pitching: 'in_line', impact: 'in_line', wickets: 'hitting', impactPos: { x: 0, y: 0.4, z: -1.3 }, stumpsPos: { x: 0, y: 0.3 }, projectionValid: true };
  const rows = edgeRows(truth, { review: 'lbw' });
  assert.deepEqual(rows.map((r) => r.colour), ['red', 'red']);   // (law colours: the condition for OUT is not met)
  const o = reviewOutcome(plumb, { onFieldOut: true, batFirst: true, edgeRows: rows, batText: 'OUTSIDE EDGE FIRST' });
  assert.deepEqual([o.out, o.overturned, o.reviewKept], [false, true, true]);
  assert.ok(o.rows.some((r) => r.label === 'BAT' && r.text === 'OUTSIDE EDGE FIRST'));
  // no edge (the bat near, a pad bump only): the edge rows count for OUT, tracking decides
  const pad = edgeTruth(synthLog({ pad: 0.5, passD: 0.1 }));
  const r2 = edgeRows(pad, { review: 'lbw' });
  assert.deepEqual(r2.map((r) => `${r.text}:${r.colour}`), ['PAD, NO BAT:green', 'MARK ON PAD ONLY:green']);
  const o2 = reviewOutcome(plumb, { onFieldOut: false, batFirst: false, edgeRows: r2 });
  assert.deepEqual([o2.out, o2.overturned], [true, true]);
  // the old call (no edge rows) is unchanged
  assert.deepEqual(verdictRows(plumb).map((r) => r.label), ['PITCHING', 'IMPACT', 'WICKETS']);
});

test('reviews: 2 per side per innings; lost on failure, kept on umpire\'s call or overturn', () => {
  const r = new Reviews(CONFIG.match.reviews);
  assert.equal(CONFIG.match.reviews, 2);
  assert.deepEqual([r.player, r.ai], [2, 2]);
  assert.equal(r.settle('player', { reviewKept: true }), 2);     // overturned / umpire's call
  assert.equal(r.settle('player', { reviewKept: false }), 1);    // failed
  assert.equal(r.settle('player', { reviewKept: false }), 0);
  assert.equal(r.can('player'), false);
  assert.equal(r.settle('player', { reviewKept: false }), 0, 'never below 0');
  assert.equal(r.ai, 2, 'the other side keeps its own');
  assert.match(r.text(), /you 0 · them 2/);
  // a new innings: a new count
  assert.deepEqual([new Reviews(2).player, new Reviews(2).ai], [2, 2]);
  r.reset(); assert.deepEqual([r.player, r.ai], [2, 2]);
  // umpire's call keeps it (ICC): from the LBW review rule
  const clip = { fullToss: false, pitching: 'in_line', impact: 'in_line', wickets: 'umpires_call', impactPos: { x: 0, y: 0.4, z: -1.3 }, stumpsPos: { x: 0.1, y: 0.3 }, projectionValid: true };
  const o = reviewOutcome(clip, { onFieldOut: false });
  assert.deepEqual([o.out, o.umpiresCall, o.reviewKept], [false, true, true]);
  assert.equal(r.settle('ai', o), 2);
  const upheld = reviewOutcome({ ...clip, wickets: 'missing' }, { onFieldOut: false });
  assert.equal(r.settle('ai', upheld), 1);
});

test('AI reviews: mostly when the call is wrong, now and then a wasted one', () => {
  const rate = (o, n = 5000) => { const rng = makeRng(23); let k = 0; for (let i = 0; i < n; i++) if (aiWillReview({ ...o, rng })) k++; return k / n; };
  assert.ok(Math.abs(rate({ kind: 'lbw', onFieldOut: true, truthOut: false }) - 0.7) < 0.03);
  const waste = rate({ kind: 'lbw', onFieldOut: true, truthOut: true });
  assert.ok(waste > 0.03 && waste < 0.12, `wasted ${waste}`);
  assert.ok(rate({ kind: 'caught', aiBatting: true, onFieldOut: true, truthOut: false }) > 0.85);
  assert.equal(aiWillReview({ kind: 'lbw', onFieldOut: true, truthOut: false, left: 0, rng: () => 0 }), false);
});

test('classifyBat: the glove on the handle counts as bat', () => {
  const c = classifyBat({ part: 'handle', face: 'handle', local: { x: 0, y: G.shoulderY + 0.12, z: 0.02 } }, G);
  assert.equal(c.where, 'glove');
  const h = classifyBat({ part: 'handle', face: 'handle', local: { x: 0, y: G.shoulderY + 0.01, z: 0.02 } }, G);
  assert.equal(h.where, 'handle');
});
