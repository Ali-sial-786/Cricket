import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEVELS, QUALITY_NAMES, fixedLevel, FrameStats, Governor, deviceKey, startLevel } from '../src/render/quality.js';

// Drive the governor with frames at `hz`, each with probability `miss` of having missed one refresh.
function run(gov, stats, { seconds, hz = 90, miss = 0, rng = Math.random, paused = false, t0 = 0, onLevel = null }) {
  let t = t0;
  const p = 1000 / hz;
  for (let i = 0; i < seconds * hz; i++) {
    const m = rng() < miss ? 1 : 0;
    t += p * (1 + m);
    stats.frame(t, 2, 1);
    const before = gov.level;
    gov.update((p * (1 + m)) / 1000, stats.latePct, paused, stats.spanMs >= 900);
    if (onLevel && gov.level !== before) onLevel(gov.level, t);
  }
  return t;
}
function seeded(s) { return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

test('levels: the top level is the game as designed; each lever only goes down', () => {
  const top = LEVELS[0];
  assert.equal(top.foveation, 0.5); assert.equal(top.viewport, 1); assert.equal(top.crowd, 1);
  assert.equal(top.crowdAnim, true); assert.equal(top.shadows, 2); assert.equal(top.detail, true); assert.equal(top.turf, true); assert.equal(top.particles, 1);
  for (let i = 1; i < LEVELS.length; i++) {
    const a = LEVELS[i - 1], b = LEVELS[i];
    assert.ok(b.foveation >= a.foveation && b.viewport <= a.viewport && b.crowd <= a.crowd && b.hz <= a.hz && b.particles <= a.particles && b.lodNear <= a.lodNear && b.shadows <= a.shadows, b.name);
  }
  assert.deepEqual(QUALITY_NAMES, ['auto', 'ultra', 'high', 'medium', 'low', 'minimum']);
  assert.equal(fixedLevel('auto'), -1); assert.equal(fixedLevel('low'), 3);
});

test('frame stats: missed refreshes from the gaps between frames', () => {
  const s = new FrameStats();
  s.setTarget(90);
  let t = 0;
  for (let i = 0; i < 90; i++) { t += 1000 / 90; s.frame(t, 3, 2); }
  assert.equal(s.missedPct, 0);
  assert.ok(Math.abs(s.fps - 90) < 1, String(s.fps));
  // every other frame takes two refreshes: a third of the refreshes are missed
  for (let i = 0; i < 120; i++) { t += (1000 / 90) * (i % 2 ? 2 : 1); s.frame(t, 3, 2); }
  assert.ok(Math.abs(s.missedPct - 33.3) < 3, String(s.missedPct));
  assert.equal(s.bound, 'gpu');                            // 5 ms of CPU work in an 11 ms period
  for (let i = 0; i < 120; i++) { t += 2000 / 90; s.frame(t, 9, 3); }
  assert.equal(s.bound, 'cpu');
  assert.ok(Math.abs(s.updMs - 9) < 1e-3 && Math.abs(s.rendMs - 3) < 1e-3);
  assert.equal(s.latePct, 100);
  // a long hitch counts all the refreshes it covered, but is one late frame
  const s2 = new FrameStats(); s2.setTarget(90); let u = 0;
  for (let i = 0; i < 80; i++) { u += 1000 / 90; s2.frame(u, 3, 2); }
  const before = s2.totalMissed; u += 100; s2.frame(u, 0, 0);
  assert.equal(s2.totalMissed - before, 8);
  assert.ok(s2.latePct < 2 && s2.missedPct > 8, `${s2.latePct} ${s2.missedPct}`);
});

test('frame stats: no target rate (a monitor) learns the period from the gaps', () => {
  const s = new FrameStats();
  let t = 0;
  for (let i = 0; i < 300; i++) { t += 1000 / 144; s.frame(t); }
  assert.ok(Math.abs(s.period - 1000 / 144) < 0.3, String(s.period));
  assert.equal(s.missedPct, 0);
});

test('governor: drops within about a second of missed frames, two levels on a bad stall', () => {
  const g = new Governor({ start: 0 }), s = new FrameStats();
  s.setTarget(90);
  let at = null;
  run(g, s, { seconds: 3, miss: 0 });
  assert.equal(g.level, 0);
  run(g, s, { seconds: 1.6, miss: 0.2, rng: seeded(1), t0: 3000, onLevel: (l, t) => { if (at == null) at = t; } });
  assert.equal(g.level, 1);
  assert.ok(at - 3000 < 1300, `dropped after ${at - 3000} ms`);
  const g2 = new Governor({ start: 0 }), s2 = new FrameStats(); s2.setTarget(90);
  run(g2, s2, { seconds: 3, miss: 0 });
  run(g2, s2, { seconds: 0.8, miss: 0.9, rng: seeded(2), t0: 3000 });   // (~1.5 s: most frames take two refreshes)
  assert.equal(g2.level, 2);
  // one long hitch a second (a GC): never a drop
  const g3 = new Governor({ start: 0 }), s3 = new FrameStats(); s3.setTarget(90);
  let t3 = 0;
  for (let i = 0; i < 90 * 30; i++) { t3 += i % 90 === 0 ? 120 : 1000 / 90; s3.frame(t3, 2, 1); g3.update(1 / 90, s3.latePct, false, s3.spanMs >= 900); }
  assert.equal(g3.level, 0);
});

test('governor: climbs only after ~10 s clean, holds after every change', () => {
  const g = new Governor({ start: 3 }), s = new FrameStats(); s.setTarget(90);
  const ups = [];
  run(g, s, { seconds: 9, miss: 0, onLevel: (l, t) => ups.push([l, t]) });
  assert.equal(g.level, 3, 'no climb before 10 s');
  run(g, s, { seconds: 4, t0: 9000, onLevel: (l, t) => ups.push([l, t]) });
  assert.equal(g.level, 2);
  assert.ok(ups[0][1] >= 10000);
  // the next climb needs its own 10 s (the hold, then the clean spell from zero)
  run(g, s, { seconds: 9, t0: 13000 });
  assert.equal(g.level, 2);
});

test('governor: no oscillation on a level that is just too slow (backoff), nor on noise', () => {
  // Level 0 misses 15% of refreshes, level 1 is clean: it must settle on 1 and try 0 less and less often.
  const g = new Governor({ start: 1 }), s = new FrameStats(); s.setTarget(90);
  const rng = seeded(7); let t = 0, changes = 0;
  const p = 1000 / 90;
  for (let i = 0; i < 90 * 600; i++) {                       // ten minutes
    const m = g.level === 0 && rng() < 0.15 ? 1 : 0;
    t += p * (1 + m); s.frame(t, 2, 1);
    const b = g.level; g.update(p * (1 + m) / 1000, s.latePct, false, s.spanMs >= 900); if (g.level !== b) changes++;
  }
  assert.equal(g.level, 1);
  assert.ok(changes <= 12, `${changes} changes in 10 min`);
  assert.ok(g.climbNeed(0) >= 80, String(g.climbNeed(0)));
  // A noisy signal around the thresholds (0-6% misses at every level) never moves it down, rarely up.
  const g2 = new Governor({ start: 2 }), s2 = new FrameStats(); s2.setTarget(90);
  let c2 = 0; const r2 = seeded(11);
  for (let i = 0; i < 90 * 300; i++) {
    const m = r2() < 0.03 ? 1 : 0; t += p * (1 + m); s2.frame(t, 2, 1);
    const b = g2.level; g2.update(p * (1 + m) / 1000, s2.latePct, false, true); if (g2.level !== b) c2++;
  }
  assert.ok(g2.level >= 1 && c2 <= 2, `level ${g2.level}, ${c2} changes`);
});

test('governor: paused (menus, loading, cuts) never changes the level; fixed overrides', () => {
  const g = new Governor({ start: 0 }), s = new FrameStats(); s.setTarget(90);
  run(g, s, { seconds: 5, miss: 0.5, rng: seeded(3), paused: true });
  assert.equal(g.level, 0);
  g.setFixed(4);
  run(g, s, { seconds: 20, miss: 0, t0: 5000 });
  assert.equal(g.level, 4);
  g.setFixed(-1);
  run(g, s, { seconds: 1, miss: 0, t0: 25000 });
  assert.equal(g.level, 4, 'back to auto: starts from where it was');
});

test('governor: benchmark decides fast (drops in well under a second, climbs after 2 s)', () => {
  const g = new Governor({ start: 2 }), s = new FrameStats(); s.setTarget(90);
  g.benchmark(6);
  run(g, s, { seconds: 3.2, miss: 0, paused: true });         // (menus are open on the safety screen: still measured)
  assert.equal(g.level, 1);
  const g2 = new Governor({ start: 1 }), s2 = new FrameStats(); s2.setTarget(90);
  g2.benchmark(6); let at = null;
  run(g2, s2, { seconds: 2, miss: 0.4, rng: seeded(5), onLevel: (l, t) => { if (at == null) at = t; } });
  assert.ok(g2.level >= 2 && at < 1500, `${g2.level} at ${at}`);
});

test('device key and start level', () => {
  const q = 'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/36.0 Chrome/128 VR Safari/537.36';
  const k1 = deviceKey(q, 'Adreno (TM) 740'), k2 = deviceKey(q, 'Adreno (TM) 740'), k3 = deviceKey(q, 'Adreno (TM) 650');
  assert.equal(k1, k2); assert.notEqual(k1, k3); assert.ok(/^Quest3-/.test(k1), k1);
  assert.equal(startLevel(null, q), 1);
  assert.equal(startLevel(null, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 0);
  assert.equal(startLevel(3, q), 3);
  assert.equal(startLevel(9, q), 1);
});

test('the simulation is fixed-step: the same ball at 72, 90 or a stuttering frame rate', async () => {
  const { PhysicsWorld } = await import('../src/physics/world.js');
  const { machineDelivery, DEFAULT_MACHINE } = await import('../src/physics/bowlingMachine.js');
  const { CONFIG } = await import('../src/config.js');
  const fly = (frameTimes) => {
    const w = new PhysicsWorld(CONFIG, 5), d = machineDelivery(DEFAULT_MACHINE, null);
    w.launch({ pos: d.releasePos, vel: d.vel, spin: d.spin, swing: d.swing, seamDeg: d.seamDeg, seamRandomScale: 0 });
    const ev = [];
    for (const t of frameTimes) { w.advanceTo(t); for (const e of w.drainEvents()) ev.push(`${e.type}@${e.t.toFixed(5)}`); }
    return { p: [w.ball.pos.x, w.ball.pos.y, w.ball.pos.z].map((v) => v.toFixed(9)).join(), ev: ev.join() };
  };
  const at = (hz) => Array.from({ length: Math.ceil(1.5 * hz) }, (_, i) => Math.min(1.5, (i + 1) / hz));
  const r72 = fly(at(72)), r90 = fly(at(90));
  const rng = seeded(9), jit = []; for (let t = 0; t < 1.5;) { t = Math.min(1.5, t + (rng() < 0.2 ? 2 : 1) / 90); jit.push(t); }
  const rj = fly(jit);
  assert.equal(r72.p, r90.p); assert.equal(r72.ev, r90.ev);
  assert.equal(rj.p, r90.p); assert.equal(rj.ev, r90.ev);
});
