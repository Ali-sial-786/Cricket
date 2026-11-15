// People path round each other: steerAmong() bends round whatever is in the
// way (looking a few metres ahead, keeping right round people on the move), separate() never leaves two fielders (or a fielder and the keeper,
// an umpire, a batter, the stumps) inside each other, and fielders crossing
// the field to the same spot go round the umpire and each other instead of
// popping through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3, makeRng } from '../src/physics/math.js';
import { PITCH } from '../src/physics/pitch.js';
import { Fielding, steerAmong, STUMP_CLEAR, KEEPER_PADS } from '../src/game/fielding.js';

const segHitsCircle = (ax, az, bx, bz, o) => {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = Math.max(0, Math.min(1, ((o.x - ax) * dx + (o.z - az) * dz) / l2));
  return Math.hypot(ax + dx * t - o.x, az + dz * t - o.z) < o.r;
};

test('steerAmong: straight when nothing is in the way', () => {
  const u = steerAmong(0, 0, 0, 10, [{ x: 3, z: 5, r: 0.8 }, null]);
  assert.ok(Math.abs(u.x) < 1e-9 && Math.abs(u.z - 1) < 1e-9);
});

test('steerAmong: bends round what is in the way, and never steers into it', () => {
  const obs = [{ x: 0, z: 8, r: 0.8 }, { x: 0.1, z: 4, r: 0.8 }];
  const u = steerAmong(0, 1.5, 0, 12, obs);
  assert.ok(Math.abs(u.x) > 0.1, 'turned off the straight line');
  // the step it takes clears the nearer circle
  assert.ok(!segHitsCircle(0, 1.5, u.x * 4.5, 1.5 + u.z * 4.5, obs[1]), 'the new heading passes the first circle');
  // far away, it only turns once the circle is within its look-ahead
  const v = steerAmong(0, -6, 0, 12, obs);
  assert.ok(Math.abs(v.x) < 1e-9);
});

test('steerAmong: a goal inside an obstacle is not steered round (he stops at its edge instead)', () => {
  const u = steerAmong(0, 0, 0, 5, [{ x: 0, z: 5.2, r: 0.8 }]);
  assert.ok(Math.abs(u.x) < 1e-9);
});

test('walking a path with steerAmong never enters any circle', () => {
  const obs = [{ x: 0.2, z: 3, r: 0.9 }, { x: -0.6, z: 6, r: 0.8 }, { x: 0.5, z: 9, r: 0.55 }];
  let x = 0, z = 0;
  for (let i = 0; i < 2000; i++) {
    const u = steerAmong(x, z, 0, 12, obs);
    if (Math.hypot(u.x, u.z) < 1e-9) break;
    x += u.x * 0.02; z += u.z * 0.02;
    for (const o of obs) assert.ok(Math.hypot(x - o.x, z - o.z) > o.r - 1e-6, `inside ${JSON.stringify(o)} at ${x.toFixed(2)},${z.toFixed(2)}`);
    if (Math.hypot(x, z - 12) < 0.05) break;
  }
  assert.ok(Math.hypot(x, z - 12) < 0.1, 'got there');
});

test('separate: fielders, the keeper (wider), umpires, batters and the stumps all kept apart', () => {
  const f = new Fielding({ rng: makeRng(3) });
  const F = f.fielders;
  // pile everyone up on one spot next to the keeper, an umpire and the stumps
  // (the AI bowler counts as a fielder's body only while he is out fielding,
  // `out`: the rest of the time his own figure is the body, an obstacle like the umpires)
  for (const p of F) { p.pos.set(0.3 + Math.random() * 0.05, 0, 1.0 + Math.random() * 0.05); p.action = null; p.out = !!p.bowler; }
  f.obstacles = [{ x: 1.2, z: 1.0, r: 0.9 }, { x: -0.8, z: 0.4, r: 0.8 }];
  for (let i = 0; i < 400; i++) f.separate();
  for (let i = 0; i < F.length; i++) {
    for (let j = i + 1; j < F.length; j++) {
      const need = 0.85 + (F[i].keeper || F[j].keeper ? KEEPER_PADS : 0);
      const d = Math.hypot(F[i].pos.x - F[j].pos.x, F[i].pos.z - F[j].pos.z);
      assert.ok(d > need - 0.02, `${F[i].name} / ${F[j].name}: ${d.toFixed(3)} < ${need}`);
    }
    assert.ok(Math.hypot(F[i].pos.x, F[i].pos.z - PITCH.battingStumpsZ) > STUMP_CLEAR - 0.02, `${F[i].name} in the stumps`);
    for (const o of f.obstacles) assert.ok(Math.hypot(F[i].pos.x - o.x, F[i].pos.z - o.z) > o.r - 0.02, `${F[i].name} in an obstacle`);
  }
});

test('separate: the AI bowler\'s idle fielder slot (his own figure is out there) neither pushes nor is pushed', () => {
  const f = new Fielding({ rng: makeRng(3) });
  const bw = f.fielders[f.fielders.length - 1], mid = f.fielders[3];
  assert.ok(bw.bowler && !bw.out);
  bw.pos.set(5, 0, 5); mid.pos.set(5.2, 0, 5);
  f.obstacles = [];
  for (let i = 0; i < 50; i++) f.separate();
  assert.ok(Math.hypot(bw.pos.x - 5, bw.pos.z - 5) < 1e-9, 'the idle slot was moved');
  assert.ok(Math.hypot(mid.pos.x - 5.2, mid.pos.z - 5) < 1e-9, 'a fielder was pushed by the idle slot');
  bw.out = true;
  for (let i = 0; i < 50; i++) f.separate();
  assert.ok(Math.hypot(bw.pos.x - mid.pos.x, bw.pos.z - mid.pos.z) > 0.83, 'once fielding he is kept apart');
});

test('two fielders sent across each other and past an umpire never overlap on the way', () => {
  const f = new Fielding({ rng: makeRng(5) });
  const [a, b] = [f.fielders[2], f.fielders[3]];
  for (const p of f.fielders) { if (p !== a && p !== b) p.pos.set(80, 0, 80 + f.fielders.indexOf(p) * 3); p.home.copy(p.pos); }
  a.pos.set(-10, 0, -10); b.pos.set(10, 0, -10);
  a.state = 'chase'; a.target = new Vec3(10, 0, -10);
  b.state = 'chase'; b.target = new Vec3(-10, 0, -10);
  f.obstacles = [{ x: 0, z: -10.3, r: 0.9 }];                 // an umpire in the middle of both paths
  f.hitT = -10;
  let minAB = Infinity, minU = Infinity;
  for (let t = 0; t < 8; t += 1 / 60) {
    f.update(1 / 60, t, null, null);
    minAB = Math.min(minAB, Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z));
    for (const p of [a, b]) minU = Math.min(minU, Math.hypot(p.pos.x, p.pos.z + 10.3));
  }
  assert.ok(minAB > 0.84, `fielders came within ${minAB.toFixed(2)} m`);
  assert.ok(minU > 0.89, `a fielder came within ${minU.toFixed(2)} m of the umpire`);
  assert.ok(Math.hypot(a.pos.x - 10, a.pos.z + 10) < 1 && Math.hypot(b.pos.x + 10, b.pos.z + 10) < 1, 'both got there');
});
