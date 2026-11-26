// The replay director (src/game/replayDirector.js): which balls get a replay,
// the angles each one is cut from, the tempo and the length; and the timing
// helpers left in src/game/replayFraming.js (pathStats, replayAt, tailFor).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, missBy, direct, planAt, replayMode, wants, segsLength, BUDGET, DIRECTOR, MODES } from '../src/game/replayDirector.js';
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

test('classify: wickets, boundaries and close calls get a replay; leaves, dots and singles do not', () => {
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
  // routine
  for (const f of [{ res: { kind: 'left' } }, { res: { kind: 'runs', runs: 0 } }, { res: { kind: 'runs', runs: 1 } }, { res: { kind: 'beaten', padded: true } },
    { res: { kind: 'beaten' }, nearMiss: 0.4 }, { res: { kind: 'runs', runs: 0 }, edge: true, behind: false }, { res: { kind: 'runs', runs: 1, closeCall: 2.0 } }]) {
    assert.deepEqual(C(f), { story: 'routine', tier: 'routine' }, JSON.stringify(f));
  }
});

test('missBy: a ball that just missed the stumps, and one that hit them or was nowhere near', () => {
  assert.ok(Math.abs(missBy({ x: 0.2, y: 0.4 }) - (0.2 - 0.1143 - 0.036)) < 1e-9);
  assert.ok(missBy({ x: 0, y: 0.8 }) > 0 && missBy({ x: 0, y: 0.8 }) < 0.05, 'just over the bails');
  assert.equal(missBy({ x: 0.05, y: 0.3 }), null, 'hit them');
  assert.equal(missBy(null), null);
});

test('every kind of replay keeps to its length: wicket 6 s, boundary and close call 5 s, a routine ball 2.5 s', () => {
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
    assert.ok(p.cuts.length <= 1, `${story}: ${p.cuts.length} cuts (one dip at most a replay)`);
    assert.equal(Math.abs(segsLength(p.segs) - p.len) < 1e-9, true);
    // the tape only goes forward; nothing past the tape
    for (let i = 1; i < p.n; i++) assert.ok(p.T[i] >= p.T[i - 1] - 1e-9, `${story}: back in time at ${i}`);
    assert.ok(p.T[0] >= T0 - PRE - 1e-9 && p.T[p.n - 1] <= T0 - PRE + (pts.length - 1) * DT + 1e-9, story);
  }
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
      assert.ok(p.cuts.length <= 1, `${at}: ${p.cuts.length} cuts (one dip at most a replay)`);
      for (const sh of p.shots) if (sh.i0 >= 0) {
        assert.ok(Math.hypot(sh.pos.x, sh.pos.z - CZ) <= DIRECTOR.rim + (sh.rope ? 2.5 : 0) + 1e-6, `${at}: ${sh.kind} outside the rim`);
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
    const k = inCone(walk(p, tape));
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
  // the build-up runs at real speed (a bowled: from behind the arm); a boundary or a catch opens on the line camera, bat on ball slowed
  assert.equal(b.segs[0].rate, 1);
  for (const p of [f, c]) assert.equal(p.shots[p.S[0]].kind, 'line');
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

// The last picture of a boundary replay, as the viewer sees it looking at its subject: the central
// 40° x 30° of the view (the subject area), what fills it (replayFraming.js viewShares).
function lastPicture(p, tape, at) {
  const F = walk(p, tape), e = F[F.length - 1], sh = p.shots[p.S[p.n - 1]];
  const pitch = Math.atan2(at.y - sh.pos.y, Math.max(0.5, hypot2(at.x - sh.pos.x, at.z - sh.pos.z)));
  return { e, sh, s: viewShares(sh.pos, e.yaw, pitch, { hfov: 40, vfov: 30, n: 60 }) };
}

test('a six: a crane in front of the stand where it comes down, the view settling on the crowd; never a board', () => {
  for (const [name, v, extra] of [['over mid-wicket', [-17, 17, -14]], ['straight', [1, 18, -24]], ['into the seats (recorded land)', [-18, 19, -14], { landAt: 1 }]]) {
    const pts = shot(v), tape0 = tapeOf(pts);
    // (another branch lets a six fly on into the seats: the tape's own landing time, if the marks carry one, is used)
    const ex = extra && extra.landAt ? { land: tape0.crossAt() + 0.45 } : {};
    const { p, tape } = plan('six', 'boundary', pts, ex);
    const sh = p.shots[p.S[p.n - 1]], F = walk(p, tape), e = F[F.length - 1];
    assert.equal(sh.kind, 'track', name);
    assert.ok(sh.pos.y >= 4, `${name}: ${sh.pos.y} m up`);
    assert.ok(hypot2(sh.pos.x, sh.pos.z - CZ) <= 52 + 1e-6, `${name}: ${hypot2(sh.pos.x, sh.pos.z - CZ).toFixed(1)} m out (too near the boards)`);
    // looking level (the headset's view), the middle of the last picture is the stand, not the boards
    const s = viewShares(sh.pos, e.yaw, 0, { hfov: 40, vfov: 30, n: 60 });
    assert.ok(s.stand >= 0.5 && s.boards <= 0.1, `${name}: stand ${(s.stand * 100).toFixed(0)}%, boards ${(s.boards * 100).toFixed(0)}%`);
    const c = viewShares(sh.pos, e.yaw, 0, { hfov: 2, vfov: 2, n: 4 });
    assert.ok(c.stand === 1, `${name}: the middle of the view is not the crowd`);
    // the arc comes down in view: within the comfort cone while it is followed
    let n = 0, k = 0;
    for (const f of F) if (f.shot === p.S[p.n - 1] && f.t < (ex.land ?? Infinity)) { n++; if (offOf(f) <= 25 * D2R) k++; }
    assert.ok(!n || k / n >= 0.85, `${name}: the ball in view ${(k / Math.max(1, n) * 100).toFixed(0)}%`);
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

test('a four: ends on the ball crossing the rope, turf and rope the picture, the boards a band behind; the fielder chasing in shot, or a crane', () => {
  for (const [name, v, chaser] of [['straight', [3, 1.5, -29]], ['cover', [24, 3, -14]], ['square', [30, 2, 0]], ['fine leg', [-12, 1.5, 24]], ['cover, chased', [24, 3, -14], true], ['fine, chased', [-12, 1.5, 24], true]]) {
    const pts = shot(v), t0 = tapeOf(pts), cross = t0.crossAt(), C = { x: 0, y: 0, z: 0 }; t0.ball(cross, C);
    // a fielder chasing: 5 m inside the rope, beside the ball's line
    const ppl = [person(-0.4, -1.1), person(0.4, -21.6)];
    if (chaser) { const r = hypot2(C.x, C.z - CZ); ppl.push(person(C.x - C.x / r * 5 + 2, C.z - (C.z - CZ) / r * 5)); }
    const { p, tape } = plan('four', 'boundary', pts, {}, true, ppl);
    assert.ok(p.end <= cross + 0.15, `${name}: runs ${(p.end - cross).toFixed(2)} s (tape) past the crossing`);
    const { e, sh, s } = lastPicture(p, tape, { x: C.x, y: 0.1, z: C.z });
    assert.ok(hypot2(sh.pos.x, sh.pos.z - CZ) <= 56 + 1e-6, `${name}: ${hypot2(sh.pos.x, sh.pos.z - CZ).toFixed(1)} m out (too near the boards)`);
    assert.ok(s.boards <= 0.14, `${name}: boards ${(s.boards * 100).toFixed(0)}% of the subject area`);
    assert.ok(s.turf >= 0.35, `${name}: turf ${(s.turf * 100).toFixed(0)}% of the subject area`);
    // the ball at the crossing near the middle of the view
    assert.ok(offOf(e) < DIRECTOR.cone, `${name}: ${(offOf(e) / D2R).toFixed(0)}° off the ball at the end`);
    if (chaser) {
      const F = ppl[2].c, off = Math.abs(wrap(Math.atan2(F.x - sh.pos.x, F.z - sh.pos.z) - e.yaw));
      assert.ok(off < 35 * D2R, `${name}: the fielder ${(off / D2R).toFixed(0)}° off the middle`);
      assert.ok(sh.pos.y <= 2.2, `${name}: ${sh.pos.y} m up`);
    } else assert.ok(sh.pos.y >= 3 && sh.pos.y <= 5, `${name}: no fielder near: a crane, not ${sh.pos.y} m`);
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
