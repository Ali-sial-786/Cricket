// The replay camera's move (src/game/replayFraming.js planCamera) and which
// balls get a replay (clipFor / replayAt): one continuous move from behind the
// bowler that follows the ball, within the comfort limits; every ball bowled
// replayed once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCamera, cameraAt, cameraBase, pathStats, clipFor, replayAt, tailFor, CAM, PRE, TAIL, TAIL_OUT } from '../src/game/replayFraming.js';

const DT = 1 / 90, Z0 = -20.12, FACE = { x: 0, z: -1.2 }, D2R = Math.PI / 180;
const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

// A ball: bowled from the bowler's hand to the bat in 0.6 s, then hit with
// velocity v (gravity, damped bounces, rolling friction); v null: left alone,
// it carries on to the keeper. Samples every DT from PRE s before the release.
function shot(v, { after = 5 } = {}) {
  const pts = [], rel = [0.4, 2.1, -18.9], bat = [-0.2, 0.8, -1.2], fl = 0.6;
  const p = bat.slice(), vel = v ? v.slice() : [0, 0, 0];
  for (let t = -PRE; t < fl + after; t += DT) {
    if (t < 0) pts.push({ x: rel[0], y: rel[1], z: rel[2], vis: false });
    else if (t < fl) { const k = t / fl; pts.push({ x: rel[0] + (bat[0] - rel[0]) * k, y: rel[1] + (bat[1] - rel[1]) * k, z: rel[2] + (bat[2] - rel[2]) * k, vis: true }); }
    else {
      if (v) {
        vel[1] -= 9.81 * DT;
        for (let a = 0; a < 3; a++) p[a] += vel[a] * DT;
        if (p[1] < 0.036) { p[1] = 0.036; vel[1] = Math.abs(vel[1]) * 0.45; vel[0] *= 0.97; vel[2] *= 0.97; if (vel[1] < 0.5) vel[1] = 0; }
        if (p[1] <= 0.04) { vel[0] *= 1 - 0.35 * DT; vel[2] *= 1 - 0.35 * DT; }
      } else { if (p[2] < 6) p[2] += 22 * DT; p[1] = 0.9; }
      pts.push({ x: p[0], y: p[1], z: p[2], vis: true });
    }
  }
  return { pts, key: Math.round((PRE + fl) / DT) };
}

function fly(v, lim = CAM.xr) {
  const { pts, key } = shot(v);
  const base = cameraBase(Z0, 1);
  const path = planCamera({ n: pts.length, dt: DT, ball: (i, o) => { o.x = pts[i].x; o.y = pts[i].y; o.z = pts[i].z; return pts[i].vis; }, key, base, face: FACE, lim });
  const frames = pts.map((b, i) => ({ t: i * DT, x: path.x[i], y: path.y[i], z: path.z[i], yaw: path.yaw[i], bx: b.x, by: b.y, bz: b.z, ball: i >= key }));
  return { pts, key, base, path, frames, s: pathStats(frames) };
}

// Shots that go away from the camera (or square of it), and the ones hit back past it.
const AWAY = { square: [30, 2, 0], cover: [24, 3, -14], pull: [-28, 6, -4], six: [-20, 20, -18], fine: [-6, 1, 20], edge: [9, 3, 18], block: [1, 0.5, -3], leave: null };
const BACK = { straightGround: [0.5, 1, -30], straightLoft: [1, 16, -27], straightFlat: [0.2, 5.2, -34], straightWide: [3, 2, -25] };

test('replay camera: starts high behind the bowler, facing down the pitch, and holds still until the ball reaches the batter', () => {
  const { path, key, base } = fly(AWAY.cover);
  assert.equal(base.z, Z0 - CAM.back);
  for (let i = 0; i < key; i++) {
    assert.ok(Math.hypot(path.x[i] - base.x, path.z[i] - base.z) < 1e-6, `moved before the shot at ${i}`);
    assert.ok(Math.abs(path.yaw[i]) < 1e-6, `turned before the shot at ${i}`);
  }
  for (let i = 0; i < path.n; i++) assert.equal(path.y[i], Math.fround(CAM.height));
});

test('replay camera: one continuous move within the comfort limits, every shot, headset and monitor', () => {
  for (const [lname, lim] of [['xr', CAM.xr], ['desk', CAM.desk]]) {
    for (const [name, v] of Object.entries({ ...AWAY, ...BACK })) {
      const { s } = fly(v, lim), at = `${lname} ${name}`;
      assert.equal(s.cuts, 0, `${at}: cuts`);
      assert.equal(s.maxRise, 0, `${at}: height changed`);
      assert.ok(s.maxSpeed <= lim.vMax * 1.01, `${at}: speed ${s.maxSpeed}`);
      assert.ok(s.maxAccel <= lim.aMax * 1.05 + 0.05, `${at}: accel ${s.maxAccel}`);
      assert.ok(s.maxYawRate <= lim.wMax * 1.01, `${at}: turn rate ${s.maxYawRate / D2R}°/s`);
      assert.ok(s.maxYawAccel <= lim.wAcc * 1.05 + 0.05, `${at}: turn accel ${s.maxYawAccel / D2R}°/s²`);
    }
  }
});

test('replay camera: follows the ball after the shot, inside the comfortable forward view all the way', () => {
  for (const [name, v] of Object.entries(AWAY)) {
    const { s, path, pts } = fly(v);
    assert.equal(s.inCone, 1, `${name}: ball outside ±${CAM.cone / D2R}° (worst ${(s.worstOff / D2R).toFixed(0)}°)`);
    const n = path.n - 1, e = pts[n];
    if (Math.hypot(e.x - path.x[n], e.z - path.z[n]) > 2) {
      const off = Math.abs(wrap(Math.atan2(e.x - path.x[n], e.z - path.z[n]) - path.yaw[n]));
      assert.ok(off < CAM.cone, `${name}: not facing the ball at the end (${(off / D2R).toFixed(0)}°)`);
    }
  }
  // a long hit: it glides after the ball (and stays on its side of the rope)
  const six = fly(AWAY.six), n = six.path.n - 1;
  assert.ok(Math.hypot(six.path.x[n] - six.base.x, six.path.z[n] - six.base.z) > 10, 'did not glide after a six');
  assert.ok(Math.hypot(six.path.x[n], six.path.z[n] + 10.06) < CAM.rim, 'past the rim');
});

test('replay camera: a ball that goes behind the batter (edge, fine leg, a leave) is followed down the pitch, never nearer than CAM.short to his crease', () => {
  for (const name of ['fine', 'edge', 'leave']) {
    const { path, base, s, pts } = fly(AWAY[name]);
    let maxZ = -Infinity;
    for (let i = 0; i < path.n; i++) maxZ = Math.max(maxZ, path.z[i]);
    assert.ok(maxZ <= FACE.z - CAM.short + 0.05, `${name}: ${(maxZ - FACE.z).toFixed(1)} m from the batter's crease`);
    assert.ok(maxZ - base.z > 5, `${name}: did not close in (${(maxZ - base.z).toFixed(1)} m)`);
    assert.equal(s.inCone, 1, name);
    const n = path.n - 1, before = Math.hypot(pts[n].x - base.x, pts[n].z - base.z), after = Math.hypot(pts[n].x - path.x[n], pts[n].z - path.z[n]);
    assert.ok(after < before - 5, `${name}: ${after.toFixed(1)} m from the ball at the end (${before.toFixed(1)} from where it started)`);
  }
});

test('replay camera: after the shot it closes in on a ball in the infield (the pick-up, the throw) and keeps it in view', () => {
  const INFIELD = { push: [6, 0.5, -8], block: AWAY.block, dab: [3, 0.3, 2.5], cover: AWAY.cover };
  for (const [name, v] of Object.entries(INFIELD)) {
    const { path, base, s, pts } = fly(v);
    assert.equal(s.inCone, 1, name);
    const n = path.n - 1, d = Math.hypot(pts[n].x - path.x[n], pts[n].z - path.z[n]), d0 = Math.hypot(pts[n].x - base.x, pts[n].z - base.z);
    assert.ok(d < Math.max(CAM.near + 3, d0 - 8), `${name}: ended ${d.toFixed(1)} m from the ball (started ${d0.toFixed(1)})`);
  }
});

test('replay camera: it does not close in under a skied ball (it would go out of the top of the view)', () => {
  const { path, base, pts, key } = fly([2, 22, -4]);
  for (let i = key; i < path.n; i++) {
    const h = Math.hypot(pts[i].x - path.x[i], pts[i].z - path.z[i]);
    if (h < CAM.near) assert.ok(Math.hypot(path.x[i] - base.x, path.z[i] - base.z) < 1, `moved in under it at ${i}`);
  }
});

test('replay camera: a ball hit straight back past it — side-steps, starts the turn early, picks it up behind', () => {
  // (A ball whipping past cannot be kept in a ±32° view at 75°/s: what is
  // asked is that it passes to one side, the turn is spread round the moment,
  // and the camera is facing it again afterwards.)
  for (const [name, v] of Object.entries(BACK)) {
    const { s, path, pts } = fly(v);
    assert.ok(s.inCone >= 0.7, `${name}: in view ${(s.inCone * 100).toFixed(0)}%`);
    assert.ok(s.worstOff <= 105 * D2R, `${name}: worst ${(s.worstOff / D2R).toFixed(0)}°`);
    assert.ok(s.minBall >= 2, `${name}: ball ${s.minBall.toFixed(1)} m from the camera`);
    const n = path.n - 1, e = pts[n];
    const off = Math.abs(wrap(Math.atan2(e.x - path.x[n], e.z - path.z[n]) - path.yaw[n]));
    assert.ok(off < CAM.cone, `${name}: not facing the ball at the end (${(off / D2R).toFixed(0)}°)`);
  }
});

test('cameraAt: between samples it interpolates, past the ends it holds', () => {
  const p = { n: 3, dt: 0.5, x: [0, 1, 3], y: [3.5, 3.5, 3.5], z: [0, 0, 2], yaw: [0, 0.2, 0.4] };
  assert.deepEqual(cameraAt(p, 0.25), { x: 0.5, y: 3.5, z: 0, yaw: 0.1 });
  assert.deepEqual(cameraAt(p, 0.75), { x: 2, y: 3.5, z: 1, yaw: 0.30000000000000004 });
  assert.deepEqual(cameraAt(p, -1), { x: 0, y: 3.5, z: 0, yaw: 0 });
  assert.deepEqual(cameraAt(p, 9), { x: 3, y: 3.5, z: 2, yaw: 0.4 });
});

test('pathStats: a jump or a snap turn is a cut', () => {
  const f = (t, x, yaw = 0) => ({ t, x, y: 3.5, z: 0, yaw, ball: false });
  assert.equal(pathStats([f(0, 0), f(0.01, 0.05), f(0.02, 0.1)]).cuts, 0);
  assert.equal(pathStats([f(0, 0), f(0.01, 0.05), f(0.02, 3)]).cuts, 1);
  assert.equal(pathStats([f(0, 0), f(0.01, 0, 0.5)]).cuts, 1);
});

// The marks a ball leaves (game s): released at 10, with the tape from 0 to `last`.
const BALLS = {
  leave:     { m: { release: 10, dead: 11.6 }, arrive: 10.62 },
  dot:       { m: { release: 10, hit: 10.6, dead: 12.0 }, arrive: 10.6 },
  single:    { m: { release: 10, hit: 10.6, dead: 15.2 }, arrive: 10.6 },
  four:      { m: { release: 10, hit: 10.6, dead: 13.4 }, arrive: 10.6 },
  six:       { m: { release: 10, hit: 10.6, dead: 13.0 }, arrive: 10.6 },
  bowled:    { m: { release: 10, dead: 10.7 }, arrive: 10.6 },
  lbwReview: { m: { release: 10, pad: 10.58, dead: 10.9 }, arrive: 10.6 },
  runOut:    { m: { release: 10, hit: 10.6, dead: 16.8 }, arrive: 10.6 },
  caught:    { m: { release: 10, hit: 10.6, caught: 13.1, dead: 13.2 }, arrive: 10.6 },
  playerBowled: { m: { release: 10, hit: 10.7, dead: 12.5 }, arrive: 10.7 },
};

test('clipFor: every kind of ball gets a replay, from PRE before the release to TAIL after it was dead, following from the bat / pad / crease', () => {
  for (const [name, { m, arrive }] of Object.entries(BALLS)) {
    const c = clipFor(m, 0, m.dead + 5, arrive);
    assert.ok(c, `${name}: no replay`);
    assert.equal(c.start, m.release - PRE, name);
    assert.equal(c.end, m.dead + tailFor(m), name);
    assert.equal(tailFor(m), m.caught != null || m.break != null ? TAIL_OUT : TAIL, name);
    assert.equal(c.key, Math.min(...[m.hit, m.pad, arrive].filter((t) => t != null)), name);
    assert.ok(c.key > c.release && c.key <= c.end, name);
  }
  // a review: the tape stopped TAIL + 0.2 s after the ball was dead; the replay still has it all
  const r = BALLS.lbwReview.m, c = clipFor(r, 0, r.dead + TAIL + 0.2, 10.6);
  assert.equal(c.end, r.dead + TAIL);
});

test('clipFor: once a ball, only a ball that was bowled and is still on the tape', () => {
  const m = { ...BALLS.four.m };
  assert.equal(clipFor({ ...m, played: true }, 0, 20, 10.6), null);
  assert.equal(clipFor({ dead: 5 }, 0, 20), null);
  assert.equal(clipFor(m, 10.5, 20, 10.6), null);                   // its release has gone off the tape
  const short = clipFor(m, 9, 20, 10.6);                            // less run-up on the tape: starts where it starts
  assert.equal(short.start, 9);
  const early = clipFor({ release: 10, hit: 10.6 }, 0, 12.3, 10.6); // not dead yet: up to the newest frame
  assert.equal(early.end, 12.3);
});

test('replayAt: shortly after the result; after a review, a moment after the verdict', () => {
  assert.equal(replayAt({ dead: 13.4 }, 13.4), 13.4 + TAIL + 0.05);
  assert.equal(replayAt({ dead: 10.9 }, 24.0), 25.0);              // DRS: result 13 s after the ball was dead
  assert.equal(replayAt({}, 7), 7 + TAIL + 0.05);
});

test('clipFor: the whole passage of play: a keeper catch, a catch in the deep and a run-out run on TAIL_OUT s past the moment the ball was dead', () => {
  const plays = {
    keeperCatch: { release: 10, hit: 10.6, caught: 10.95, held: 10.95, dead: 10.96 },
    deepCatch:   { release: 10, hit: 10.6, caught: 13.1, held: 13.1, dead: 13.12 },
    runOut:      { release: 10, hit: 10.6, held: 12.1, break: 13.7, dead: 13.6 },
  };
  for (const [name, m] of Object.entries(plays)) {
    const due = replayAt(m, m.dead);                       // the replay waits for this much tape…
    const c = clipFor(m, 0, due, 10.6);                    // …so when it starts, it is all there
    assert.equal(c.end, m.dead + TAIL_OUT, name);
    assert.equal(c.dead, m.dead, name);
    for (const k of ['caught', 'held', 'break']) if (m[k] != null) assert.ok(m[k] >= c.start && m[k] <= c.end, `${name}: ${k} outside the clip`);
    // started straight after the result (the old "next ball" press), the clip lost the end of the play
    assert.ok(clipFor(m, 0, m.dead + 0.2, 10.6).end < m.dead + TAIL_OUT, name);
  }
  // a dot ball, a four: TAIL
  assert.equal(clipFor({ release: 10, hit: 10.6, dead: 13.4 }, 0, 20, 10.6).end, 14.4);
});

// An edge carried to the keeper (taken 14 m behind the stumps), then, once the ball is dead, lobbed back
// to the bowler's end over the camera's head (what the fielders do with a dead ball).
function keeperTakeThenLob({ lobAt = 0.8, lobTo = { x: 0.5, y: 3.4, z: -27.0 } } = {}) {
  const { pts, key } = shot([1.0, 2.6, 21], { after: 4 });
  const taken = pts.findIndex((p, i) => i > key && p.z >= 14);
  const dead = taken, lob = taken + Math.round(lobAt / DT);
  const at = { ...pts[taken] };
  for (let i = taken; i < pts.length; i++) {
    if (i < lob) { pts[i] = { x: at.x, y: 1.0, z: 14, vis: true }; continue; }
    const k = Math.min(1, (i - lob) * DT / 1.6);
    pts[i] = { x: at.x + (lobTo.x - at.x) * k, y: 1.0 + (lobTo.y - 1.0) * k + 6 * Math.sin(Math.PI * k), z: 14 + (lobTo.z - 14) * k, vis: true };
  }
  return { pts, key, dead, lob };
}
function flyPts({ pts, key, dead }, strikerX = -0.4) {
  const base = cameraBase(Z0, 1);
  const path = planCamera({ n: pts.length, dt: DT, ball: (i, o) => { o.x = pts[i].x; o.y = pts[i].y; o.z = pts[i].z; return pts[i].vis; }, key, dead, strikerX, base, face: FACE });
  return { path, base };
}

test('replay camera: once the ball is dead the framing holds (a ball lobbed back is not chased)', () => {
  const play = keeperTakeThenLob();
  const { path } = flyPts(play);
  const yawAtLob = path.yaw[play.lob];
  for (let i = play.lob; i < path.n; i++) {
    assert.ok(Math.abs(path.yaw[i] - yawAtLob) < 8 * D2R, `turned ${((path.yaw[i] - yawAtLob) / D2R).toFixed(0)}° after the lob at ${i}`);
  }
  // …but it still gets out of the way of a lob coming at it
  let min = Infinity;
  for (let i = play.lob; i < path.n; i++) min = Math.min(min, Math.hypot(play.pts[i].x - path.x[i], play.pts[i].y - path.y[i], play.pts[i].z - path.z[i]));
  assert.ok(min >= 2, `the lob came ${min.toFixed(1)} m from the camera`);
});

test('replay camera: a ball behind the striker is watched from the other side of the stumps, so he does not hide the keeper', () => {
  for (const strikerX of [-0.4, 0.4]) {
    const play = keeperTakeThenLob({ lobAt: 10 });           // (no lob in the clip)
    const { path } = flyPts(play, strikerX);
    const i = play.dead + Math.round(1.5 / DT), x = path.x[Math.min(path.n - 1, i)];
    assert.ok(x * -Math.sign(strikerX) > 1.5, `striker at x ${strikerX}: camera at x ${x.toFixed(2)}`);
    // a second after the take the line of sight to the keeper passes beside the striker (> 0.5 m)
    const j = Math.min(path.n - 1, play.dead + Math.round(1 / DT));
    const c = { x: path.x[j], z: path.z[j] }, k = play.pts[j];
    const u = (FACE.z - c.z) / (k.z - c.z), xs = c.x + (k.x - c.x) * u;
    assert.ok(Math.abs(xs - strikerX) > 0.5, `sight line ${xs.toFixed(2)} m across at the striker (x ${strikerX})`);
  }
});
