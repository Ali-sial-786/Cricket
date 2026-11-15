// Your shot's power (src/physics/swingLoad.js, powerOf / resolveBatContact):
// exit speed grows with your bat's real speed and with how far back and high
// you took it; a block stays a dead bat, a push is a push, a full flowing
// drive still goes as far as before; the same swing gives the same power at
// every slow-motion scale and refresh rate. Pure JS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3, Quat, Pose } from '../src/physics/math.js';
import { PhysicsWorld, InterpolatedBatProvider } from '../src/physics/world.js';
import { BatGeometry, powerOf } from '../src/physics/bat.js';
import { SwingLoad, loadOf, LOAD } from '../src/physics/swingLoad.js';
import { CONFIG } from '../src/config.js';
import { kmh } from './helpers.js';

const geom = new BatGeometry(CONFIG.bat), R = CONFIG.ball.radius;
const X = new Vec3(1, 0, 0);
// The bat at contact: upright, face to the bowler (-Z), the ball on the middle of it at (0, 0.6, -1.6).
const qc = new Quat(0, 1, 0, 0);
const ballAt = new Vec3(0, 0.6, -1.6);
const Gc = ballAt.clone().sub(new Vec3(0, geom.sweetY, geom.faceZ + R).applyQuat(qc));
const C = Gc.clone().add(new Vec3(0, 0.4, 0));        // the swing turns about a point 40 cm above your hands

// A straight drive: from rest at the top of the backlift (`arc` rad back from contact) round to the ball,
// reaching `w` rad/s at contact. The ball (no gravity) comes at `pace` km/h. ts: slow motion (the game
// clock runs ts x the real one); hz: frames. Returns the bat contact event (load read from the bat's track).
function drive({ arc, w, pace = 130, ts = 1, hz = 72, load = true, hold = 0.3 }) {
  const cfg = structuredClone(CONFIG); cfg.physics.gravity = 0; cfg.ball.dragCoeff = 0; cfg.ball.magnusSlope = 0;
  const world = new PhysicsWorld(cfg);
  for (const wk of world.wickets) wk.enabled = false;             // (the ball comes from far back: through where the far stumps are)
  const prov = new InterpolatedBatProvider();
  const bat = world.addBat('player', prov, geom);
  bat.mods = { faceLed: 0, power: 1, sigmaScale: 1, loftPower: 0 };
  if (load) bat.swing = new SwingLoad(geom.sweetY);
  const v = kmh(pace), D = 2 * arc / w, tc = 1.2, tTop = tc - D;       // real seconds
  const alpha = (tr) => (tr <= tTop ? -arc : tr <= tc ? -arc + w * (tr - tTop) ** 2 / (2 * D) : w * (tr - tc));
  const pose = (tr, out) => {
    // (picked up from hanging at the stance to the top over 0.4 s, held `hold` s)
    let al = alpha(tr);
    if (tr < tTop - hold) al = -arc * Math.min(1, Math.max(0, (tr - (tTop - hold - 0.4)) / 0.4)) + 0.25 * (1 - Math.min(1, Math.max(0, (tr - (tTop - hold - 0.4)) / 0.4)));
    const rq = new Quat().setFromAxisAngle(X, al);
    out.q.multiplyQuats(rq, qc); out.p.copy(Gc).sub(C).applyQuat(rq).add(C);
    return out;
  };
  world.time = 0;
  world.launch({ pos: ballAt.clone().add(new Vec3(0, 0, -v * tc * ts)), vel: new Vec3(0, 0, v), spin: new Vec3(), seamRandomScale: 0 });
  const P = new Pose(), Q = new Pose(), lin = new Vec3(), ang = new Vec3();
  for (let i = 0; i / hz <= tc + 0.3; i++) {
    const tr = i / hz, h = 1e-5;
    pose(tr, P); pose(tr + h, Q);
    lin.copy(Q.p).sub(P.p).scale(1 / h);
    ang.copy(X).scale((alpha(tr + h) - alpha(tr)) / h);
    if (tr < tTop - hold) ang.set(0, 0, 0);
    prov.push(tr * ts, P, P.p, lin, ang);
    if (bat.swing) bat.swing.push(tr * ts, tr, P, null);
    world.advanceTo(tr * ts);
    const e = world.drainEvents().find((x) => x.type === 'bat');
    if (e) return e;
  }
  return null;
}
const KMH = (e) => e.vel.length() * 3.6;

test('power factors: the load counts from 0.45 to all of the bat speed; a gentle bat is held softly', () => {
  const pw = CONFIG.bat.power;
  assert.equal(powerOf(0, 20).P, pw.loadFloor);
  assert.equal(powerOf(1, 20).P, 1);
  assert.equal(powerOf(2, 20).P, 1);
  assert.equal(powerOf(1, 0).H, pw.soft);
  assert.equal(powerOf(1, pw.hands[1]).H, 1);
  for (let i = 0; i < 10; i++) assert.ok(powerOf((i + 1) / 10, 5).P > powerOf(i / 10, 5).P);
  assert.equal(loadOf(0, 0), 0);
  assert.equal(loadOf(LOAD.lift[1], LOAD.travel[1]), 1);
  assert.ok(Math.abs(loadOf(Math.PI / 2, 1.35) - 0.64) < 0.03, `half a backlift: ${loadOf(Math.PI / 2, 1.35).toFixed(2)}`);
});

test('the load is read from the bat: a block ~0, half a backlift ~0.6, a full one 1; the top is where the downswing began', () => {
  const block = drive({ arc: 0.3, w: 2 }), half = drive({ arc: Math.PI / 2 - 0.1, w: 12 }), full = drive({ arc: 2.3, w: 18 });
  assert.ok(block.load < 0.1, `block ${block.load.toFixed(2)}`);
  assert.ok(half.load > 0.45 && half.load < 0.8, `half backlift ${half.load.toFixed(2)} (lift ${half.lift.toFixed(2)} rad, travel ${half.travel.toFixed(2)} m)`);
  assert.ok(full.load > 0.97, `full backlift ${full.load.toFixed(2)}`);
});

test('exit speed grows with bat speed and with the backlift; full backlift + fast = the most', () => {
  const rows = [];
  for (const arc of [0.6, 1.4, 2.3]) for (const w of [4, 10, 18]) rows.push({ arc, w, kmh: KMH(drive({ arc, w })) });
  const at = (arc, w) => rows.find((r) => r.arc === arc && r.w === w).kmh;
  for (const arc of [0.6, 1.4, 2.3]) assert.ok(at(arc, 4) < at(arc, 10) && at(arc, 10) < at(arc, 18), `faster is harder (arc ${arc})`);
  for (const w of [10, 18]) assert.ok(at(0.6, w) < at(1.4, w) && at(1.4, w) < at(2.3, w), `further back is harder (w ${w})`);
  assert.ok(at(2.3, 18) === Math.max(...rows.map((r) => r.kmh)));
  // a short, quick jab is well short of a full swing at the same speed
  assert.ok(at(0.6, 18) < 0.8 * at(2.3, 18), `jab ${at(0.6, 18).toFixed(0)} vs full ${at(2.3, 18).toFixed(0)} km/h`);
});

test('a block stays a dead bat, a slow push is a dab; a full flowing drive goes as hard as it did without the model', () => {
  const block = drive({ arc: 0.25, w: 2 }), dab = drive({ arc: 0.7, w: 4 });
  assert.ok(KMH(block) < 0.3 * 130, `block ${KMH(block).toFixed(0)} km/h off a 130 km/h ball`);
  assert.ok(KMH(dab) < 0.4 * 130, `dab ${KMH(dab).toFixed(0)} km/h`);
  const full = drive({ arc: 2.3, w: 18 }), physics = drive({ arc: 2.3, w: 18, load: false });
  assert.ok(Math.abs(KMH(full) - KMH(physics)) < 0.5, `full drive ${KMH(full).toFixed(1)} vs the bare physics ${KMH(physics).toFixed(1)} km/h`);
  // the bare physics of the block went much harder (the ball's own pace straight back off a firm bat)
  assert.ok(KMH(drive({ arc: 0.25, w: 2, load: false })) > 1.6 * KMH(block));
});

test('the same swing: the same power at every slow-motion scale and refresh rate', () => {
  for (const sw of [{ arc: 0.7, w: 5 }, { arc: 1.4, w: 12 }, { arc: 2.3, w: 18 }]) {
    const ref = drive({ ...sw });
    for (const ts of [0.85, 0.7]) for (const hz of [72, 90, 120]) {
      const e = drive({ ...sw, ts, hz });
      assert.ok(Math.abs(e.load - ref.load) < 0.06, `arc ${sw.arc} at x${ts} ${hz} Hz: load ${e.load.toFixed(3)} vs ${ref.load.toFixed(3)}`);
      assert.ok(Math.abs(KMH(e) - KMH(ref)) / KMH(ref) < 0.05, `arc ${sw.arc} at x${ts} ${hz} Hz: ${KMH(e).toFixed(1)} vs ${KMH(ref).toFixed(1)} km/h`);
    }
  }
});

test('a bat held high, lowered slowly and then pushed is a push (the backlift is where the downswing began)', () => {
  const S = new SwingLoad(geom.sweetY), P = new Pose();
  const put = (t, al, z = 0) => { const rq = new Quat().setFromAxisAngle(X, al); P.q.multiplyQuats(rq, qc); P.p.copy(Gc).sub(C).applyQuat(rq).add(C); P.p.z += z; S.push(t, t, P, null); };
  let t = 0;
  for (; t < 0.4; t += 1 / 72) put(t, -2.3);                                    // up at the top
  for (let k = 0; k <= 1; k += 1 / 72) { put(t, -2.3 + 1.6 * k); t += 1 / 72; } // lowered over a second
  for (let k = 0; k <= 1; k += 1 / 72) { put(t, -0.7); t += 1 / 72; }           // held
  for (let k = 0; k <= 1; k += 1 / 9) { put(t, -0.7 + 0.7 * k * k); t += 1 / 72; }   // pushed at the ball
  const r = S.read(t);
  assert.ok(r.load < 0.3, `read as load ${r.load.toFixed(2)} (lift ${r.lift.toFixed(2)}, travel ${r.travel.toFixed(2)})`);
});

test('the AI batter\'s bat (no load given) is the bare physics', () => {
  const a = drive({ arc: 1.4, w: 12, load: false });
  assert.equal(a.load, null);
  assert.equal(a.power, 1);
  assert.equal(a.hands, 1);
});

test('the AI striker\'s bat keeps the original restitution (his mishits and edges as before)', async () => {
  const { aiBatConfig, contactQuality } = await import('../src/physics/bat.js');
  const ai = new BatGeometry(aiBatConfig()), n = new Vec3(0, 0, 1);
  for (const [x, y] of [[0, ai.sweetY], [0, ai.sweetY + 0.25], [ai.bladeHalf.x * 0.85, ai.sweetY], [ai.bladeHalf.x * 0.7, ai.sweetY - 0.2]]) {
    const q = contactQuality(ai, new Vec3(x, y, ai.faceZ + R), n, 'blade');
    // the original curve: 0.12 + 0.30 x quality
    assert.ok(Math.abs(q.e - (0.12 + 0.3 * q.quality)) < 1e-12, `e ${q.e} at quality ${q.quality}`);
  }
  assert.ok(Math.abs(contactQuality(ai, new Vec3(0, ai.toeY - R, 0), new Vec3(0, -1, 0), 'blade').e - 0.096) < 1e-12, 'off the toe: 0.096');
});
