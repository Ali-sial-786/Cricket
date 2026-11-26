// The replay director (src/game/replayDirector.js): which balls get a replay,
// the angles each one is cut from, the tempo and the length; and the timing
// helpers left in src/game/replayFraming.js (pathStats, replayAt, tailFor).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, missBy, direct, planAt, replayMode, wants, segsLength, takeOK, BUDGET, DIRECTOR, MODES, CANON } from '../src/game/replayDirector.js';
import { pathStats, replayAt, tailFor, TAIL, TAIL_OUT, nearestOnBody, CLEAR, viewShares } from '../src/game/replayFraming.js';
import { hypot2 } from '../src/physics/math.js';

const DT = 1 / 90, PRE = 2, T0 = 100, D2R = Math.PI / 180, CZ = -10.06;
const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

// A ball on the tape: in the bowler's hand, bowled to the bat in 0.6 s, then
// hit with velocity v (gravity, damped bounces, rolling friction, stopped by
// the boards 68 m from the middle); v null: left alone, on to the keeper.
function shot(v, { after = 5 } = {}) {
  const pts = [], rel = [0.4, 2.1, -18.9], bat = [-0.2, 0.8, -1.2], fl = 0.6;
  const p = bat.slice(), vel = v ? v.slice() : [0, 0, 0];
  for (let t = -PRE; t < fl + after; t += DT) {
    if (t < 0) pts.push({ x: rel[0], y: rel[1], z: rel[2], vis: true });
    else if (t < fl) { const k = t / fl; pts.push({ x: rel[0] + (bat[0] - rel[0]) * k, y: rel[1] + (bat[1] - rel[1]) * k, z: rel[2] + (bat[2] - rel[2]) * k, vis: true }); }
    else {
      if (v) {
        if (vel[0] || vel[1] || vel[2]) vel[1] -= 9.81 * DT;
        for (let a = 0; a < 3; a++) p[a] += vel[a] * DT;
        if (p[1] < 0.036) { p[1] = 0.036; vel[1] = Math.abs(vel[1]) * 0.45; if (vel[1] < 0.5) vel[1] = 0; }
        if (p[1] <= 0.04) { vel[0] *= 1 - 0.35 * DT; vel[2] *= 1 - 0.35 * DT; }
        const r = Math.hypot(p[0], p[2] - CZ);
        if (r > 68 && r < 70 && p[1] < 1) { p[0] *= 68 / r; p[2] = CZ + (p[2] - CZ) * 68 / r; vel[0] = vel[2] = 0; }   // (the boards)
        else if (r >= 70 && p[1] < 1 + (r - 70) * 0.6) vel[0] = vel[1] = vel[2] = 0;                                    // (into the raked seats)
      } else { if (p[2] < 6) p[2] += 22 * DT; p[1] = 0.9; }
      pts.push({ x: p[0], y: p[1], z: p[2], vis: true });
    }
  }
  return pts;
}
const person = (x, z) => ({ a: { x, y: 1.9, z }, b: { x, y: 0.95, z }, c: { x, y: 0.05, z } });
function tapeOf(pts, people = [person(-0.4, -1.1), person(0.4, -21.6), person(0.9, 5)]) {
  const first = T0 - PRE, last = first + (pts.length - 1) * DT;
  const at = (t) => Math.max(0, Math.min(pts.length - 1, (t - first) / DT));
  return {
    first, last, pts,
    ball: (t, o) => { const f = at(t), i = Math.min(pts.length - 2, Math.floor(f)), k = f - i, a = pts[i], b = pts[i + 1]; o.x = a.x + (b.x - a.x) * k; o.y = a.y + (b.y - a.y) * k; o.z = a.z + (b.z - a.z) * k; return a.vis; },
    bodies: () => people.map((p, k) => ({ k, a: { ...p.a }, b: { ...p.b }, c: { ...p.c } })),
    figure: (k, t, o) => { const p = people[k]; if (!p) return false; o.x = p.c.x; o.y = 0; o.z = p.c.z; return true; },
    // the first time the ball is past the rope, and where it was caught (it stops there)
    crossAt() { for (let i = 0; i < pts.length; i++) if (Math.hypot(pts[i].x, pts[i].z - CZ) > 65) return first + i * DT; return null; },
  };
}
// A catch: the ball's flight from the bat ends in a fielder's hands at `at` s after the hit.
function caughtAt(v, at) {
  const pts = shot(v), i = Math.round((PRE + 0.6 + at) / DT), c = { ...pts[i] };
  for (let j = i; j < pts.length; j++) pts[j] = { x: c.x, y: 1.2, z: c.z, vis: true };
  return { pts, catcher: c };
}

// A run-out: pushed to a fielder at `f` (there 2 s after the hit), held, thrown at the stumps at `end`, there at T0 + 0.6 + 3.2.
function thrown(f, end = 'bowling') {
  const pts = shot(null), sz = end === 'bowling' ? -20.12 : 0, iHit = Math.round((PRE + 0.6) / DT);
  for (let i = iHit; i < pts.length; i++) {
    const t = (i - iHit) * DT;
    if (t < 2) { const k = t / 2; pts[i] = { x: -0.2 + (f.x + 0.2) * k, y: 0.05, z: -1.2 + (f.z + 1.2) * k, vis: true }; }
    else if (t < 2.6) pts[i] = { x: f.x, y: 1.4, z: f.z, vis: true };
    else if (t < 3.2) { const k = (t - 2.6) / 0.6; pts[i] = { x: f.x + (0 - f.x) * k, y: 1.4 - 0.6 * k + 1.2 * Math.sin(Math.PI * k), z: f.z + (sz - f.z) * k, vis: true }; }
    else pts[i] = { x: 0.1, y: 0.4, z: sz, vis: true };
  }
  return pts;
}

function plan(story, tier, pts, extra = {}, xr = true, people) {
  const tape = tapeOf(pts, people);
  const cross = tape.crossAt();
  const m = { release: T0, arrive: T0 + 0.6, hit: extra.noHit ? null : T0 + 0.6, cross, dead: cross != null ? cross + 0.02 : tape.last - 1.0, ...extra };
  return { p: direct({ story, tier, m, tape, xr }), tape, m };
}
// Walk a plan at 72 Hz (real time): the camera, the ball, the shot.
function walk(p, tape) {
  const out = [], o = {}, b = { x: 0, y: 0, z: 0 };
  for (let u = 0; u <= p.len + 1e-9; u += 1 / 72) {
    planAt(p, u, o); tape.ball(o.t, b);
    out.push({ u, t: o.t, x: o.x, y: o.y, z: o.z, yaw: o.yaw, pitch: o.pitch, shot: o.shot, rate: o.rate, bx: b.x, by: b.y, bz: b.z });
  }
  return out;
}
const offOf = (f) => Math.abs(wrap(Math.atan2(f.bx - f.x, f.bz - f.z) - f.yaw));
const inCone = (frames, from = T0 + 0.1) => { let n = 0, k = 0; for (const f of frames) { if (f.t < from || Math.hypot(f.bx - f.x, f.bz - f.z) < 0.5) continue; n++; if (offOf(f) <= DIRECTOR.cone) k++; } return n ? k / n : 1; };

const HITS = { cover: [24, 3, -14], square: [30, 2, 0], pull: [-26, 5, -6], drive: [6, 2, -30], fine: [-6, 1, 20], push: [6, 0.5, -8] };

test('replayMode: highlights by default and for old saves ("bowler" meant on); every ball and off as chosen', () => {
  assert.equal(replayMode({}), 'highlights');
  assert.equal(replayMode({ replay: 'bowler' }), 'highlights');
  assert.equal(replayMode({ replay: 'every' }), 'every');
  assert.equal(replayMode({ replay: 'off' }), 'off');
  assert.deepEqual(MODES.slice().sort(), ['every', 'highlights', 'off']);
  assert.equal(wants('highlights', 'routine'), false);
  for (const t of ['wicket', 'boundary', 'close']) assert.equal(wants('highlights', t), true, t);
  assert.equal(wants('every', 'routine'), true);
  for (const t of ['wicket', 'boundary', 'close', 'routine']) assert.equal(wants('off', t), false, t);
});

test('classify: wickets, boundaries, close calls and every moment a viewer would want again get a replay; leaves well wide, dots and singles do not', () => {
  const C = (f) => classify(f);
  const W = (kind, wicket) => C({ res: { kind }, wicket });
  assert.deepEqual(W('bowled', 'bowled'), { story: 'bowled', tier: 'wicket' });
  assert.deepEqual(W('lbw', 'lbw'), { story: 'lbw', tier: 'wicket' });
  assert.deepEqual(W('caught', 'caught'), { story: 'caught', tier: 'wicket' });
  assert.deepEqual(W('runout', 'run out'), { story: 'runout', tier: 'wicket' });
  assert.deepEqual(W('stumped', 'stumped'), { story: 'stumped', tier: 'wicket' });
  assert.deepEqual(C({ res: { kind: 'bowled' }, wicket: null }), { story: 'bowled', tier: 'close' }, 'bowled off a no-ball: still worth a look');
  assert.deepEqual(C({ res: { kind: 'boundary', runs: 6 }, boundary: 6 }), { story: 'six', tier: 'boundary' });
  assert.deepEqual(C({ res: { kind: 'boundary', runs: 4 }, boundary: 4 }), { story: 'four', tier: 'boundary' });
  assert.deepEqual(C({ res: { kind: 'boundary', runs: 4 }, boundary: 0 }), { story: 'four', tier: 'boundary' }, 'four byes');
  assert.equal(C({ res: { kind: 'boundary', runs: 6, overthrows: 4 } }).story, 'misfield', 'overthrows to the rope');
  // close calls
  assert.deepEqual(C({ res: { kind: 'runs', runs: 1, closeCall: 0.2 }, review: true, brk: true }), { story: 'runout', tier: 'close' }, 'third umpire: not out');
  assert.deepEqual(C({ res: { kind: 'runs', runs: 1, closeCall: 0.5 }, brk: true }), { story: 'runout', tier: 'close' }, 'just home');
  assert.deepEqual(C({ res: { kind: 'beaten', backInTime: true } }), { story: 'stumped', tier: 'close' });
  assert.deepEqual(C({ res: { kind: 'runs', runs: 2 }, dropped: true }), { story: 'dropped', tier: 'close' });
  assert.deepEqual(C({ res: { kind: 'beaten', padded: true }, review: true }), { story: 'lbw', tier: 'close' }, 'an lbw shout');
  assert.deepEqual(C({ res: { kind: 'runs', runs: 0 }, edge: true, behind: true }), { story: 'edge', tier: 'close' });
  assert.deepEqual(C({ res: { kind: 'beaten' }, nearMiss: 0.05 }), { story: 'beaten', tier: 'close' });
  assert.deepEqual(C({ res: { kind: 'beaten' }, nearMiss: 0.094 }), { story: 'beaten', tier: 'close' }, 'played and missed by 9 cm');
  assert.deepEqual(C({ res: { kind: 'left' }, nearMiss: 0.094 }), { story: 'routine', tier: 'routine' }, 'left alone, 9 cm outside off stump (review 4, bug 2)');
  assert.deepEqual(C({ res: { kind: 'left' }, nearMiss: 0.03 }), { story: 'leave', tier: 'close' }, 'left alone, shaving the stumps');
  assert.deepEqual(C({ res: { kind: 'runs', runs: 1 }, direct: true, brk: true }), { story: 'direct', tier: 'close' });
  assert.deepEqual(C({ res: { kind: 'runs', runs: 1 }, dive: true }), { story: 'dive', tier: 'close' });
  assert.deepEqual(C({ res: { kind: 'runs', runs: 3, overthrows: 1 } }), { story: 'misfield', tier: 'close' });
  // what a viewer expects to see again (DIRECTOR's thresholds)
  assert.deepEqual(C({ res: { kind: 'runs', runs: 0 }, edge: true, behind: false }), { story: 'edge', tier: 'close' }, 'an edge anywhere (into the ground, past gully)');
  assert.deepEqual(C({ res: { kind: 'runs', runs: 0 }, review: true }), { story: 'appeal', tier: 'close' }, 'an appeal turned down');
  assert.deepEqual(C({ res: { kind: 'runs', runs: 1, closeCall: 1.0 } }), { story: 'runout', tier: 'close' }, 'a run-out chance, the stumps not broken');
  assert.deepEqual(C({ res: { kind: 'beaten' }, nearMiss: 0.2 }), { story: 'beaten', tier: 'close' }, 'played and missed by 20 cm');
  assert.deepEqual(C({ res: { kind: 'beaten' }, nearMiss: 0.5, batGap: 0.06 }), { story: 'beaten', tier: 'close' }, 'past the edge');
  assert.deepEqual(C({ res: { kind: 'left' }, headGap: 0.2 }), { story: 'bouncer', tier: 'close' }, 'a bouncer past the helmet');
  assert.deepEqual(C({ res: { kind: 'runs', runs: 1 }, safe: true }), { story: 'safe', tier: 'close' }, 'lofted, down safe by a fielder');
  assert.deepEqual(C({ res: { kind: 'runs', runs: 2 }, saved: true }), { story: 'saved', tier: 'close' }, 'hit hard, stopped before the rope');
  // routine
  for (const f of [{ res: { kind: 'left' } }, { res: { kind: 'runs', runs: 0 } }, { res: { kind: 'runs', runs: 1 } }, { res: { kind: 'beaten', padded: true } },
    { res: { kind: 'beaten' }, nearMiss: 0.4 }, { res: { kind: 'beaten' }, nearMiss: 0.3, batGap: 0.25 }, { res: { kind: 'left' }, nearMiss: 0.2 }, { res: { kind: 'left' }, headGap: 0.6 },
    { res: { kind: 'runs', runs: 1, closeCall: 2.0 } }]) {
    assert.deepEqual(C(f), { story: 'routine', tier: 'routine' }, JSON.stringify(f));
  }
});

test('missBy: a ball that just missed the stumps, and one that hit them or was nowhere near', () => {
  assert.ok(Math.abs(missBy({ x: 0.2, y: 0.4 }) - (0.2 - 0.1143 - 0.036)) < 1e-9);
  assert.ok(missBy({ x: 0, y: 0.8 }) > 0 && missBy({ x: 0, y: 0.8 }) < 0.05, 'just over the bails');
  assert.equal(missBy({ x: 0.05, y: 0.3 }), null, 'hit them');
  assert.equal(missBy(null), null);
});

test('every replay is a sequence of whole takes: take 1 at most 5 s (a routine ball 2.5 s), each later take at most 4 s, one dip between takes', () => {
  const cases = [
    ['routine', 'routine', shot(HITS.push)], ['routine', 'routine', shot(null), { noHit: true }],
    ['bowled', 'wicket', shot(null), { noHit: true, wicket: T0 + 0.62 }], ['lbw', 'wicket', shot(null), { noHit: true, pad: T0 + 0.58 }],
    ['beaten', 'close', shot(null), { noHit: true }], ['edge', 'close', shot(HITS.fine)],
    ['four', 'boundary', shot(HITS.cover)], ['four', 'boundary', shot(HITS.square)], ['six', 'boundary', shot([-17, 17, -14])], ['six', 'boundary', shot([1, 18, -24])],
    ['caught', 'wicket', caughtAt([-12, 14, -10], 2.4).pts, { caught: T0 + 0.6 + 2.4 }], ['caught', 'wicket', caughtAt([1, 2, 20], 0.5).pts, { caught: T0 + 1.1 }],
    ['dropped', 'close', shot([-12, 14, -10]), { dropT: T0 + 3.0 }],
    ['runout', 'wicket', shot(HITS.push), { brk: T0 + 3.4, brkEnd: 'bowling' }], ['runout', 'close', shot(HITS.push), { brk: T0 + 4.4, brkEnd: 'batting' }],
    ['stumped', 'wicket', shot(null), { noHit: true, brk: T0 + 1.2, brkEnd: 'batting' }],
    ['dive', 'close', shot(HITS.push), { diveT: T0 + 1.6 }], ['misfield', 'close', shot(HITS.drive)],
  ];
  for (const [story, tier, pts, extra] of cases) {
    const { p } = plan(story, tier, pts, extra);
    assert.ok(p, `${story}: no plan`);
    assert.ok(p.len <= BUDGET[tier] + 1e-6, `${story} (${tier}): ${p.len.toFixed(2)} s`);
    assert.ok(p.len > 1.5, `${story}: ${p.len.toFixed(2)} s is too short to show anything`);
    assert.ok(p.takes.length >= 1 && p.takes.length <= (tier === 'wicket' ? 3 : 2), `${story}: ${p.takes.length} takes`);
    assert.equal(p.cuts.length, p.takes.length - 1, `${story}: a cut only between takes`);
    assert.equal(Math.abs(segsLength(p.segs) - p.len) < 1e-9, true);
    for (let j = 0; j < p.takes.length; j++) {
      const i0 = p.takes[j].i, i1 = j + 1 < p.takes.length ? p.takes[j + 1].i : p.n, secs = (i1 - i0) * p.du;
      assert.ok(secs <= (j ? DIRECTOR.takes.later : tier === 'routine' ? BUDGET.routine : DIRECTOR.takes.first) + 0.02, `${story}: take ${j + 1} ${secs.toFixed(2)} s`);
      // within a take the tape only goes forward (a later take goes back to show it again)
      for (let i = i0 + 1; i < i1; i++) assert.ok(p.T[i] >= p.T[i - 1] - 1e-9, `${story}: back in time inside take ${j + 1}`);
    }
    if (tier === 'routine') assert.equal(p.takes.length, 1, `${story}: a routine ball gets take 1 only`);
    assert.ok(p.T[0] >= T0 - PRE - 1e-9 && p.T[p.n - 1] <= T0 - PRE + (pts.length - 1) * DT + 1e-9, story);
  }
});

// Recorded balls of every story, for the takes' tests.
const BALLS = () => [
  ['routine', 'routine', shot(HITS.push)], ['routine', 'routine', shot(HITS.pull)], ['routine', 'routine', shot(null), { noHit: true }],
  ['bowled', 'wicket', shot(null), { noHit: true, wicket: T0 + 0.62 }], ['lbw', 'wicket', shot(null), { noHit: true, pad: T0 + 0.58 }], ['lbw', 'close', shot(null), { noHit: true, pad: T0 + 0.58 }],
  ['beaten', 'close', shot(null), { noHit: true }], ['edge', 'close', shot(HITS.fine)], ['appeal', 'close', shot(null), { noHit: true }], ['bouncer', 'close', shot(null), { noHit: true }],
  ['four', 'boundary', shot(HITS.cover)], ['four', 'boundary', shot(HITS.square)], ['four', 'boundary', shot([0.5, 1.2, -29])], ['four', 'boundary', shot([-6, 1, 30])],
  ['six', 'boundary', shot([-17, 17, -14])], ['six', 'boundary', shot([1, 18, -24])],
  ['caught', 'wicket', caughtAt([-12, 14, -10], 2.4).pts, { caught: T0 + 3.0 }], ['caught', 'wicket', caughtAt([1, 2, 20], 0.5).pts, { caught: T0 + 1.1 }],
  ['dropped', 'close', shot([-12, 14, -10]), { dropT: T0 + 3.0 }], ['dive', 'close', shot(HITS.push), { diveT: T0 + 1.6 }],
  ['runout', 'wicket', thrown({ x: 14, z: -32 }, 'bowling'), { brk: T0 + 3.8, brkEnd: 'bowling' }], ['runout', 'close', thrown({ x: -12, z: 4 }, 'batting'), { brk: T0 + 3.8, brkEnd: 'batting' }],
  ['stumped', 'wicket', shot(null), { noHit: true, brk: T0 + 1.2, brkEnd: 'batting' }], ['misfield', 'close', shot(HITS.drive)], ['misfield', 'close', shot(HITS.push)],
];

test('take 1, always: from the bowler\'s end, one continuous shot from the last strides through the key moment, turning gently, slowed through it', () => {
  for (const xr of [true, false]) for (const [story, tier, pts, extra] of BALLS()) {
    const { p, tape } = plan(story, tier, pts, extra, xr), at = `${xr ? 'xr' : 'desk'} ${story}`;
    assert.ok(p, `${at}: no replay`);
    const t1 = p.takes[0], sh = p.shots[t1.shot], i1 = p.takes.length > 1 ? p.takes[1].i : p.n;
    assert.equal(sh.kind, 'arm', at);
    assert.equal(t1.i, 0, at);
    for (let i = 0; i < i1; i++) assert.equal(p.S[i], t1.shot, `${at}: a cut inside take 1`);
    assert.ok(p.T[0] <= T0 - 0.2, `${at}: take 1 starts ${(T0 - p.T[0]).toFixed(2)} s before the release (the last strides)`);
    assert.ok(p.T[i1 - 1] >= T0 + 0.6 + 0.3, `${at}: take 1 ends before what happened at the bat`);
    for (let i = 0; i < i1; i++) assert.ok(Math.abs(wrap(p.W[i])) <= DIRECTOR.arm.yawLim + 1e-6, `${at}: take 1 turned ${(p.W[i] / D2R).toFixed(0)}° off the pitch`);
    if (tier !== 'routine') assert.ok(p.segs.some((g) => g.shot === t1.shot && g.rate < 0.6), `${at}: take 1 not slowed anywhere`);
    else assert.ok(p.segs.every((g) => g.rate === 1), `${at}: a routine ball at real speed`);
  }
});

test('every later take comes from the broadcast positions (CANON) and passes the checks; one that would not is left out', () => {
  const seen = new Set();
  for (const xr of [true, false]) for (const [story, tier, pts, extra] of BALLS()) {
    const { p, tape } = plan(story, tier, pts, extra, xr), at = `${xr ? 'xr' : 'desk'} ${story}`;
    for (let j = 1; j < p.takes.length; j++) {
      const sh = p.shots[p.takes[j].shot];
      assert.ok(CANON[sh.canon] && sh.canon !== 'arm', `${at}: take ${j + 1} from ${sh.canon}`);
      const r = takeOK(p, j, tape);
      assert.ok(r.ok, `${at}: take ${j + 1} (${sh.canon}): ${r.why}`);
      for (let i = p.takes[j].i + 1; i < (j + 1 < p.takes.length ? p.takes[j + 1].i : p.n); i++) assert.equal(p.S[i], p.takes[j].shot, `${at}: a cut inside take ${j + 1}`);
      seen.add(`${story}:${sh.canon}`);
    }
    // what each story's second take is
    const want = { bowled: 'line', lbw: 'line', four: 'rope', six: 'crowd', caught: 'catch', dropped: 'catch', dive: 'catch', runout: 'square', stumped: 'square' }[story];
    if (want) assert.ok(p.takes.length >= 2 && p.shots[p.takes[1].shot].canon === want, `${at}: take 2 ${p.takes[1] ? p.shots[p.takes[1].shot].canon : 'none'} (want ${want})`);
    if (['routine', 'beaten', 'edge', 'bouncer'].includes(story)) assert.equal(p.takes.length, 1, `${at}: take 1 only`);
  }
  assert.ok(seen.size >= 8, [...seen].join(' '));
  // a camera moved into the catcher fails: inside a figure; one turned off its subject fails
  const { pts, catcher } = caughtAt([-12, 14, -10], 2.4), C = person(catcher.x + 0.3, catcher.z);
  const { p, tape } = plan('caught', 'wicket', pts, { caught: T0 + 3.0 }, true, [person(-0.4, -1.1), person(0.4, -21.6), C]);
  const sh = p.shots[p.takes[1].shot];
  assert.ok(takeOK(p, 1, tape).ok);
  const keep = { ...sh.pos };
  sh.pos.x = C.c.x + 0.6; sh.pos.z = C.c.z;
  assert.match(takeOK(p, 1, tape).why, /figure/);
  Object.assign(sh.pos, keep); sh.canon = 'somewhere';
  assert.match(takeOK(p, 1, tape).why, /broadcast/);
});

test('the angles: fixed spots (no flying), level, turning within the comfort limits; cuts only between angles', () => {
  for (const [xr, lim] of [[true, DIRECTOR.xr], [false, DIRECTOR.desk]]) {
    for (const [story, tier, pts, extra] of [['four', 'boundary', shot(HITS.cover)], ['six', 'boundary', shot([-17, 17, -14])], ['caught', 'wicket', caughtAt([-12, 14, -10], 2.4).pts, { caught: T0 + 3.0 }],
      ['bowled', 'wicket', shot(null), { noHit: true, wicket: T0 + 0.62 }], ['routine', 'routine', shot(HITS.pull)], ['misfield', 'close', shot(HITS.drive)]]) {
      const { p, tape } = plan(story, tier, pts, extra, xr), at = `${xr ? 'xr' : 'desk'} ${story}`;
      const F = walk(p, tape);
      let cuts = 0;
      for (let i = 1; i < F.length; i++) {
        const a = F[i - 1], b = F[i], du = b.u - a.u;
        if (a.shot !== b.shot) { cuts++; continue; }
        assert.ok(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) < 1e-6, `${at}: the camera moved within a shot at ${b.u.toFixed(2)}`);
        assert.ok(Math.abs(wrap(b.yaw - a.yaw)) / du <= lim.wMax * 1.02, `${at}: turn ${(Math.abs(wrap(b.yaw - a.yaw)) / du / D2R).toFixed(0)}°/s`);
      }
      assert.equal(cuts, p.cuts.length, at);
      assert.ok(p.cuts.length <= 2 && p.cuts.length === p.takes.length - 1, `${at}: ${p.cuts.length} cuts (one dip between takes)`);
      for (const sh of p.shots) if (sh.i0 >= 0) {
        assert.ok(Math.hypot(sh.pos.x, sh.pos.z - CZ) <= (sh.seats ? 80 : DIRECTOR.rim + (sh.rope ? 3.7 : 0)) + 1e-6, `${at}: ${sh.kind} outside the rim (or, a six coming down behind the boards, the apron in front of the seats)`);
        assert.ok(sh.pos.y >= 1.3 && sh.pos.y <= 6.5, `${at}: ${sh.kind} at ${sh.pos.y} m`);
      }
      if (!xr) for (const f of F) assert.ok(Math.abs(f.pitch) <= 50 * D2R + 1e-6, `${at}: tilted ${f.pitch / D2R}°`);
    }
  }
});

test('the ball stays near the middle of the view (±20°) while it is followed: boundaries, catches, misfields, every-ball replays', () => {
  const cases = {
    'four through cover': ['four', 'boundary', shot(HITS.cover)], 'four square': ['four', 'boundary', shot(HITS.square)],
    'six over mid-wicket': ['six', 'boundary', shot([-17, 17, -14])], 'six straight': ['six', 'boundary', shot([1, 18, -24])],
    'catch in the deep': ['caught', 'wicket', caughtAt([-12, 14, -10], 2.4).pts, { caught: T0 + 3.0 }], 'catch at slip': ['caught', 'wicket', caughtAt([1, 2, 20], 0.5).pts, { caught: T0 + 1.1 }],
    'overthrows': ['misfield', 'close', shot(HITS.drive)], 'every ball: a pull': ['routine', 'routine', shot(HITS.pull)], 'every ball: a push': ['routine', 'routine', shot(HITS.push)],
  };
  for (const [name, [story, tier, pts, extra]] of Object.entries(cases)) {
    const { p, tape } = plan(story, tier, pts, extra);
    // (a catch is watched on the catcher, not the ball; the rope camera stands 6-11 m from where the ball ends,
    // so the ball's last moments turn the view at its comfort limit: 85% for a boundary)
    if (story === 'caught') continue;
    // (a six's view leaves the ball once it has come down, for the crowd: counted up to the landing)
    // (take 1 from the bowler's end follows only as far as its gentle reach: a ball beyond it ends that take)
    const reach = DIRECTOR.arm.yawLim + DIRECTOR.cone;
    const k = inCone(walk(p, tape).filter((f) => (story !== 'six' || f.t <= p.focus + 0.05) && !(p.shots[f.shot].kind === 'arm' && Math.abs(Math.atan2(f.bx - f.x, f.bz - f.z)) > reach)));
    assert.ok(k >= (tier === 'boundary' ? 0.85 : 0.9), `${name}: ball inside ±20° on ${(k * 100).toFixed(0)}% of the frames`);
  }
});

test('slow motion through the key moment: the stumps, bat on ball, the catch; a freeze as a run-out\'s stumps break', () => {
  const slowAt = (p, t) => p.segs.some((s) => s.rate < 0.6 && t >= s.a - 1e-6 && t <= s.b + 1e-6);
  const b = plan('bowled', 'wicket', shot(null), { noHit: true, wicket: T0 + 0.62 }).p;
  assert.ok(slowAt(b, T0 + 0.62), 'bowled: the stumps breaking');
  assert.equal(b.shots[b.S[b.n - 1]].kind, 'line', 'bowled: seen down the line of the stumps');
  const f = plan('four', 'boundary', shot(HITS.cover)).p;
  assert.ok(slowAt(f, T0 + 0.6), 'four: bat on ball');
  const c = plan('caught', 'wicket', caughtAt([-12, 14, -10], 2.4).pts, { caught: T0 + 3.0 }).p;
  assert.ok(slowAt(c, T0 + 3.0), 'catch: the take');
  const r = plan('runout', 'wicket', shot(HITS.push), { brk: T0 + 3.4, brkEnd: 'bowling' }).p;
  assert.ok(r.segs.some((s) => s.rate === 0 && Math.abs(s.a - (T0 + 3.4)) < 1e-9 && s.dur >= 0.3), 'run-out: a freeze at the break');
  assert.ok(slowAt(r, T0 + 3.3) && slowAt(r, T0 + 3.5), 'run-out: slowed either side of it');
  // the build-up runs at real speed; every replay opens from the bowler's end, bat on ball slowed there
  for (const p of [b, f, c, r]) { assert.equal(p.segs[0].rate, 1); assert.equal(p.shots[p.S[0]].kind, 'arm'); }
  // a routine ball: real speed throughout
  assert.ok(plan('routine', 'routine', shot(HITS.push)).p.segs.every((s) => s.rate === 1));
});

test('a run-out is judged side-on at the popping crease, on the side the throw comes from, the view held still', () => {
  for (const [end, cz] of [['bowling', -18.9], ['batting', -1.22]]) {
    const { p } = plan('runout', 'wicket', thrown({ x: 14, z: -32 }, end), { brk: T0 + 3.8, brkEnd: end });
    const sh = p.shots.find((s) => s.kind === 'crease');
    assert.ok(sh && sh.i0 >= 0, end);
    assert.ok(Math.abs(sh.pos.z - cz) < 1e-6, `${end}: z ${sh.pos.z} (crease ${cz})`);
    assert.ok(Math.abs(sh.pos.x) >= DIRECTOR.crease.d - 1e-6, `${end}: x ${sh.pos.x}`);
    for (let i = sh.i0 + 1; i <= sh.i1; i++) assert.ok(Math.abs(p.W[i] - p.W[sh.i0]) < 1e-6, `${end}: the view turned`);
    assert.ok(Math.abs(Math.abs(wrap(p.W[sh.i0])) - Math.PI / 2) < 0.12, `${end}: not side-on (${(p.W[sh.i0] / D2R).toFixed(0)}°)`);
  }
  // the throw from the off side (+x): the camera on that side; from square (it would pass the camera): the other side
  const { p } = plan('runout', 'wicket', thrown({ x: 14, z: -32 }), { brk: T0 + 3.8, brkEnd: 'bowling' });
  assert.ok(p.shots.find((s) => s.kind === 'crease').pos.x > 0);
  const { p: q, tape } = plan('runout', 'wicket', thrown({ x: 15, z: -21.4 }), { brk: T0 + 3.8, brkEnd: 'bowling' });
  const sh = q.shots.find((s) => s.kind === 'crease'), o = { x: 0, y: 0, z: 0 };
  for (let t = T0 + 2.8; t <= T0 + 4.2; t += 0.02) { tape.ball(t, o); assert.ok(Math.hypot(o.x - sh.pos.x, o.y - sh.pos.y, o.z - sh.pos.z) >= 3.9, `the throw ${Math.hypot(o.x - sh.pos.x, o.y - sh.pos.y, o.z - sh.pos.z).toFixed(1)} m from the camera`); }
});

// The last picture of a boundary replay, looked at level (a headset viewer's head): the middle 40° x 30°
// (replayFraming.js viewShares), and the ball's size there at the headset's ~20 px a degree.
const PXDEG = 20, BALL_R = 0.036;
const ballPx = (d) => 2 * Math.atan(BALL_R / Math.max(0.1, d)) / D2R * PXDEG;
const NONE = (s) => s.screen + s.bigscreen + s.pavilion;     // what a picture must never be made of

test('a six: the subject is the crowd where it lands, the ball coming down into the picture; never a sightscreen, the big screen or the pavilion', () => {
  for (const [name, v, extra] of [['over mid-wicket', [-17, 17, -14]], ['straight', [1, 18, -24]], ['square (off side, by the pavilion)', [19, 16, -8]], ['square (leg side)', [-19, 16, -8]],
    ['into the seats (recorded land)', [-18, 19, -14], { landAt: 1 }]]) {
    const pts = shot(v), tape0 = tapeOf(pts);
    // (another branch lets a six fly on into the seats: the tape's own landing time, if the marks carry one, is used)
    const ex = extra && extra.landAt ? { land: tape0.crossAt() + 0.45 } : {};
    const { p, tape } = plan('six', 'boundary', pts, ex);
    const sh = p.shots[p.S[p.n - 1]], F = walk(p, tape), e = F[F.length - 1], land = p.focus;
    assert.equal(sh.kind, 'track', name);
    assert.ok(sh.pos.y >= 2 && sh.pos.y <= 3, `${name}: ${sh.pos.y} m up`);
    const dl = hypot2(sh.subj.x - sh.pos.x, sh.subj.z - sh.pos.z);
    // (8-12 m; one that comes down up in the seats a little further, or the ball's last half second is
    // more than 40° above a camera at 2-3 m)
    assert.ok(dl >= 7.5 && dl <= 14 + Math.max(0, sh.subj.y - 3) * 1.2, `${name}: ${dl.toFixed(1)} m from where it comes down (${sh.subj.y.toFixed(1)} m up)`);
    // the last picture: the people at least half of the middle, none of the things nobody watches
    const s = viewShares(sh.pos, e.yaw, 0, { hfov: 40, vfov: 30, n: 60 });
    assert.ok(s.stand >= 0.5, `${name}: crowd ${(s.stand * 100).toFixed(0)}% of the middle of the last picture`);
    assert.ok(NONE(s) <= 0.1 && s.sky <= 0.1, `${name}: sightscreen ${(s.screen * 100).toFixed(0)}%, big screen ${(s.bigscreen * 100).toFixed(0)}%, pavilion ${(s.pavilion * 100).toFixed(0)}%, sky ${(s.sky * 100).toFixed(0)}%`);
    // the ball's last half second before it lands inside the headset's picture (±45° across, ±40° up)
    for (const f of F) if (f.t >= land - 0.5 && f.t <= land) {
      const across = offOf(f), up = Math.atan2(f.by - f.y, Math.max(0.5, hypot2(f.bx - f.x, f.bz - f.z)));
      assert.ok(across <= 45 * D2R && Math.abs(up) <= 40 * D2R, `${name}: the ball out of the picture ${(land - f.t).toFixed(2)} s before it lands (${(across / D2R).toFixed(0)}° across, ${(up / D2R).toFixed(0)}° up)`);
    }
  }
  // the catch: the last angle is near the catcher, nobody too close to the camera
  const { pts: cp, catcher } = caughtAt([-12, 14, -10], 2.4);
  const c = plan('caught', 'wicket', cp, { caught: T0 + 3.0 }, true, [person(-0.4, -1.1), person(0.4, -21.6), person(catcher.x + 0.5, catcher.z)]).p;
  const k = c.shots[c.S[c.n - 1]], d = Math.hypot(k.pos.x - catcher.x, k.pos.z - catcher.z);
  assert.ok(d >= 5 && d <= 13, `ended ${d.toFixed(1)} m from the catch`);
  const q = nearestOnBody(k.pos, person(catcher.x + 0.5, catcher.z));
  assert.ok(Math.hypot(k.pos.x - q.x, k.pos.y - q.y, k.pos.z - q.z) >= CLEAR - 1e-6, 'inside the fielder');
});

test('the ball never comes close to the camera on a tracking shot, and the line camera joins only once the ball is past it', () => {
  for (const [story, tier, pts, extra] of [['four', 'boundary', shot(HITS.cover)], ['four', 'boundary', shot(HITS.drive)], ['six', 'boundary', shot([1, 18, -24])], ['misfield', 'close', shot(HITS.drive)]]) {
    const { p, tape } = plan(story, tier, pts, extra);
    for (const f of walk(p, tape)) {
      const sh = p.shots[f.shot];
      if (sh.kind === 'track' || sh.kind === 'line') assert.ok(Math.hypot(f.bx - f.x, f.by - f.y, f.bz - f.z) >= 2.5, `${story}: ball ${Math.hypot(f.bx - f.x, f.by - f.y, f.bz - f.z).toFixed(1)} m from the ${sh.kind} camera`);
    }
  }
});

test('a ball knocked back off the stumps toward the line camera: the replay ends before it gets near', () => {
  // bowled: into the stumps at T0 + 0.62, then back down the pitch at 9 m/s
  const pts = shot(null), iw = Math.round((PRE + 0.62) / DT);
  for (let i = iw; i < pts.length; i++) { const t = (i - iw) * DT; pts[i] = { x: 0, y: 0.4, z: -0.1 - 9 * t, vis: true }; }
  const { p, tape } = plan('bowled', 'wicket', pts, { noHit: true, wicket: T0 + 0.62 });
  for (const f of walk(p, tape)) if (p.shots[f.shot].kind === 'line') assert.ok(Math.hypot(f.bx - f.x, f.by - f.y, f.bz - f.z) >= 2.9, `ball ${Math.hypot(f.bx - f.x, f.by - f.y, f.bz - f.z).toFixed(1)} m from the line camera`);
  assert.ok(p.segs.some((s) => s.rate < 0.6 && T0 + 0.62 >= s.a && T0 + 0.62 <= s.b), 'still slowed through the stumps breaking');
});

test('a catch: 5-8 m from the catcher, chest high, three-quarter on, there before the ball, slowed through the take, a beat on him after', () => {
  for (const [name, v, at] of [['deep', [-12, 14, -10], 2.4], ['keeper', [0.3, 1.2, 14], 0.45], ['slip', [3, 1.4, 15], 0.5]]) {
    const { pts, catcher } = caughtAt(v, at), C = person(catcher.x + 0.3, catcher.z);
    const { p, tape } = plan('caught', 'wicket', pts, { caught: T0 + 0.6 + at }, true, [person(-0.4, -1.1), person(0.4, -21.6), C]);
    const ct = T0 + 0.6 + at, sh = p.shots[p.S[p.n - 1]];
    assert.equal(sh.kind, 'catch', name);
    const d = hypot2(sh.pos.x - C.c.x, sh.pos.z - C.c.z);
    assert.ok(d >= 5 && d <= 8.6, `${name}: ${d.toFixed(1)} m from the catcher`);
    assert.ok(sh.pos.y >= 1.1 && sh.pos.y <= 1.6, `${name}: ${sh.pos.y} m up`);
    // three-quarter on: 20-60° off the line the ball comes in on
    const q = { x: 0, y: 0, z: 0 }; tape.ball(ct - 0.35, q);
    const off = Math.abs(wrap(Math.atan2(sh.pos.x - C.c.x, sh.pos.z - C.c.z) - Math.atan2(q.x - C.c.x, q.z - C.c.z))) / D2R;
    assert.ok(off >= 20 && off <= 60, `${name}: ${off.toFixed(0)}° off the ball's line`);
    // there before the ball (a second of real time at least), slowed through the take, a beat after
    let first = null, slowAtCt = false, after = 0;
    for (const f of walk(p, tape)) {
      if (f.shot !== p.S[p.n - 1]) continue;
      if (first == null) first = f;
      if (Math.abs(f.t - ct) < 0.02 && f.rate < 0.6) slowAtCt = true;
      if (f.t > ct + 0.25) after += 1 / 72;
      // the catcher in the middle of the view
      assert.ok(Math.abs(wrap(Math.atan2(C.c.x - f.x, C.c.z - f.z) - f.yaw)) < 20 * D2R, `${name}: the catcher off the middle of the view`);
    }
    assert.ok((ct - first.t) / 0.3 >= 0.9 || first.u <= p.len - 3, `${name}: in place only ${(ct - first.t).toFixed(2)} s (tape) before the take`);
    assert.ok(slowAtCt, `${name}: not slowed through the take`);
    assert.ok(after >= 0.4, `${name}: ${after.toFixed(2)} s on him after`);
  }
});

test('a four: ends on the ball into the rope with a subject: the fielder chasing it, or the ball itself close and in the middle; never a sightscreen, the big screen or the pavilion', () => {
  for (const [name, v, chaser] of [['straight', [3, 1.5, -29]], ['straight, lofted', [0.5, 7, -30]], ['straight behind', [0.5, 1.5, 30]], ['cover', [24, 3, -14]],
    ['square', [30, 2, 0]], ['fine', [-12, 1.5, 24]], ['fine (finer)', [-6, 1, 30]], ['cover, chased', [24, 3, -14], true], ['fine, chased', [-12, 1.5, 24], true]]) {
    const pts = shot(v), t0 = tapeOf(pts), cross = t0.crossAt(), C = { x: 0, y: 0, z: 0 }; t0.ball(cross, C);
    // a fielder chasing: 5 m inside the rope, beside the ball's line
    const ppl = [person(-0.4, -1.1), person(0.4, -21.6)];
    if (chaser) { const r = hypot2(C.x, C.z - CZ); ppl.push(person(C.x - C.x / r * 5 + 2, C.z - (C.z - CZ) / r * 5)); }
    const { p, tape } = plan('four', 'boundary', pts, {}, true, ppl);
    assert.ok(p.end <= cross + 0.25, `${name}: runs ${(p.end - cross).toFixed(2)} s (tape) past the crossing`);
    const F = walk(p, tape), e = F[F.length - 1], sh = p.shots[p.S[p.n - 1]];
    const s = viewShares(sh.pos, e.yaw, 0, { hfov: 40, vfov: 30, n: 60 });
    assert.ok(NONE(s) <= 0.1, `${name}: sightscreen ${(s.screen * 100).toFixed(0)}%, big screen ${(s.bigscreen * 100).toFixed(0)}%, pavilion ${(s.pavilion * 100).toFixed(0)}% of the middle of the last picture`);
    // the ball as it crosses the rope: near the middle of the view, and big enough to see
    let at = F[0]; for (const f of F) if (Math.abs(f.t - cross) < Math.abs(at.t - cross)) at = f;
    const dB = Math.hypot(at.bx - at.x, at.by - at.y, at.bz - at.z);
    assert.ok(offOf(at) < DIRECTOR.cone, `${name}: ${(offOf(at) / D2R).toFixed(0)}° off the ball as it crosses`);
    if (chaser) {
      const Fd = ppl[2].c, off = Math.abs(wrap(Math.atan2(Fd.x - sh.pos.x, Fd.z - sh.pos.z) - e.yaw)), dF = hypot2(Fd.x - sh.pos.x, Fd.z - sh.pos.z);
      assert.ok(off < 30 * D2R, `${name}: the fielder ${(off / D2R).toFixed(0)}° off the middle`);
      assert.ok(2 * Math.atan(0.9 / dF) / D2R * PXDEG >= 100, `${name}: the fielder ${dF.toFixed(1)} m away`);
    } else {
      assert.ok(ballPx(dB) >= 6, `${name}: the ball ${ballPx(dB).toFixed(1)} px (${dB.toFixed(1)} m) as it crosses`);
      assert.ok(sh.pos.y >= 1.4 && sh.pos.y <= 1.8, `${name}: a low camera by the rope, not ${sh.pos.y} m up`);
      assert.ok(hypot2(sh.pos.x, sh.pos.z - CZ) >= 61.5, `${name}: just inside the rope, not ${hypot2(sh.pos.x, sh.pos.z - CZ).toFixed(1)} m out`);
    }
  }
});

test('planAt: between samples it interpolates; across a cut it does not blend the two angles', () => {
  const p = { n: 4, du: 0.5, T: [0, 0.5, 1, 1.5], X: [0, 1, 10, 11], Y: [3, 3, 2, 2], Z: [0, 0, 0, 0], W: [0, 0.2, 1, 1], P: [0, 0, 0, 0], S: [0, 0, 1, 1], R: [1, 1, 1, 1] };
  const o = {};
  planAt(p, 0.25, o); assert.equal(o.x, 0.5); assert.ok(Math.abs(o.yaw - 0.1) < 1e-9); assert.equal(o.shot, 0);
  planAt(p, 0.75, o); assert.equal(o.x, 1); assert.equal(o.shot, 0);     // (held on the first angle until the cut)
  planAt(p, 1.0, o); assert.equal(o.x, 10); assert.equal(o.shot, 1);
  planAt(p, 9, o); assert.equal(o.x, 11);
});

test('pathStats: a jump or a snap turn is a cut', () => {
  const f = (t, x, yaw = 0) => ({ t, x, y: 3.5, z: 0, yaw, ball: false });
  assert.equal(pathStats([f(0, 0), f(0.01, 0.05), f(0.02, 0.1)]).cuts, 0);
  assert.equal(pathStats([f(0, 0), f(0.01, 0.05), f(0.02, 3)]).cuts, 1);
  assert.equal(pathStats([f(0, 0), f(0.01, 0, 0.5)]).cuts, 1);
});

test('replayAt / tailFor: shortly after the result once the aftermath is on the tape; after a review, a moment after the verdict', () => {
  assert.equal(replayAt({ dead: 13.4 }, 13.4), 13.4 + TAIL + 0.05);
  assert.equal(replayAt({ dead: 10.9 }, 24.0), 25.0);              // DRS: result 13 s after the ball was dead
  assert.equal(replayAt({}, 7), 7 + TAIL + 0.05);
  assert.equal(tailFor({ caught: 3 }), TAIL_OUT);
  assert.equal(tailFor({ break: 3 }), TAIL_OUT);
  assert.equal(tailFor({}), TAIL);
});

test('settings: old saves ("bowler", the old default and the only "on") become highlights once; off stays off; a choice made since is kept', async () => {
  const { loadSettings, defaultSettings } = await import('../src/game/settings.js');
  const store = {};
  const prev = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } };
  try {
    const save = (o) => { store['creasevr.settings.v2'] = JSON.stringify(o); };
    assert.equal(defaultSettings().replay, 'highlights');
    save({ replay: 'bowler' }); assert.equal(loadSettings().replay, 'highlights');
    save({ replay: 'off' }); assert.equal(loadSettings().replay, 'off');
    save({ replay: 'every', replayV: 2 }); assert.equal(loadSettings().replay, 'every');
    save({ replay: 'off', replayV: 2 }); assert.equal(loadSettings().replay, 'off');
    save({ replay: 'bowler', replayV: 2 }); assert.equal(loadSettings().replay, 'highlights');
    delete store['creasevr.settings.v2']; assert.equal(loadSettings().replay, 'highlights');
  } finally { globalThis.localStorage = prev; }
});
