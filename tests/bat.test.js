import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3, Quat, Pose } from '../src/physics/math.js';
import { PhysicsWorld, InterpolatedBatProvider } from '../src/physics/world.js';
import { BatGeometry } from '../src/physics/bat.js';
import { CONFIG } from '../src/config.js';
import { cfgWith, kmh } from './helpers.js';

// Bat facing the bowler (face normal -Z), blade vertical: 180° about Y.
const Q_FACE_BOWLER = new Quat(0, 1, 0, 0);

// Analytic bat motion: rotation rate `omega` (rad/s) about the world X axis
// through a fixed hand position, plus a constant linear velocity.
function makeMotion({ hand, omega = 0, linVel = new Vec3(), axis = new Vec3(1, 0, 0) }) {
  const qa = new Quat();
  return {
    pose(t, out) {
      qa.setFromAxisAngle(axis, omega * t);
      out.q.multiplyQuats(qa, Q_FACE_BOWLER);
      out.p.copy(hand).addScaled(linVel, t);
      return out;
    },
    vel(t, lin, ang, grip) {
      lin.copy(linVel);
      ang.copy(axis).scale(omega);
      grip.copy(hand).addScaled(linVel, t);
    },
  };
}

// Provider that evaluates the analytic motion exactly at any time.
class ExactProvider {
  constructor(m) { this.m = m; }
  poseAt(t, out) { return this.m.pose(t, out); }
  velAt(t, l, a, g) { this.m.vel(t, l, a, g); }
}

// Simulate like the game: frames at `fps`, bat pose sampled only at frame
// times and interpolated by the world across physics substeps.
function runFramed({ cfg, motion, fps, tStart, tEnd, launch, phase = 0 }) {
  const world = new PhysicsWorld(cfg);
  const prov = new InterpolatedBatProvider();
  world.addBat('player', prov);
  world.time = tStart;
  const pose = new Pose(), lin = new Vec3(), ang = new Vec3(), grip = new Vec3();
  let t = tStart + phase;
  motion.pose(tStart, pose); motion.vel(tStart, lin, ang, grip);
  prov.push(tStart, pose, grip, lin, ang);
  world.launch(launch);
  const events = [];
  while (t < tEnd) {
    motion.pose(t, pose); motion.vel(t, lin, ang, grip);
    prov.push(t, pose, grip, lin, ang);
    world.advanceTo(t);
    events.push(...world.drainEvents());
    t += 1 / fps;
  }
  return { world, events, bat: events.find((e) => e.type === 'bat') };
}

function runExact({ cfg, motion, tStart, tEnd, launch }) {
  const world = new PhysicsWorld(cfg);
  world.addBat('player', new ExactProvider(motion));
  world.time = tStart;
  world.launch(launch);
  world.advanceTo(tEnd);
  const events = world.drainEvents();
  return { world, events, bat: events.find((e) => e.type === 'bat') };
}

const noGravity = () => cfgWith({ physics: { gravity: 0 } });

test('stationary bat: ball rebounds straight back at the sweet-spot restitution', () => {
  const cfg = noGravity();
  const geom = new BatGeometry(cfg.bat);
  const hand = new Vec3(0, 0.6 - geom.sweetY, -1.5 + geom.faceZ);
  const motion = makeMotion({ hand });
  const v = kmh(130);
  const { bat, world } = runExact({ cfg, motion, tStart: 0, tEnd: 0.6, launch: { pos: new Vec3(0, 0.6, -12), vel: new Vec3(0, 0, v) } });
  assert.ok(bat, 'contact expected');
  assert.ok(bat.quality > 0.95, `quality ${bat.quality}`);
  const out = bat.vel;
  assert.ok(out.z < 0, 'rebounds toward the bowler');
  const expected = cfg.bat.restitutionSweet * bat.speedIn;
  assert.ok(Math.abs(out.length() - expected) < 0.05 * expected, `exit ${out.length()} expected ${expected}`);
  assert.ok(Math.abs(out.x) < 0.01 && Math.abs(out.y) < 0.01);
  assert.ok(world.ball.pos.z < -1.5);
});

test('moving bat adds exit speed; sweet spot beats toe and shoulder', () => {
  const cfg = noGravity();
  const geom = new BatGeometry(cfg.bat);
  const exitAt = (yLocal, batSpeed) => {
    const hand = new Vec3(0, 0.6 - yLocal, -1.5 + geom.faceZ);
    // Move toward the bowler at batSpeed; arrange to meet at t = 0.
    const motion = makeMotion({ hand, linVel: new Vec3(0, 0, -batSpeed) });
    const v = kmh(130);
    const zc = -1.5 - cfg.ball.radius;
    const z0 = zc - v * 0.4;
    const r = runExact({ cfg, motion, tStart: -0.4, tEnd: 0.3, launch: { pos: new Vec3(0, 0.6, z0), vel: new Vec3(0, 0, v) } });
    assert.ok(r.bat, `contact expected at y=${yLocal}`);
    return r.bat.vel.length();
  };
  const still = exitAt(geom.sweetY, 0);
  const moving = exitAt(geom.sweetY, 15);
  assert.ok(moving > still + 15, `moving ${moving} vs still ${still}`);
  const toe = exitAt(geom.toeY + 0.03, 15);
  const shoulder = exitAt(geom.shoulderY - 0.04, 15);
  assert.ok(moving > toe * 1.1, `sweet ${moving} vs toe ${toe}`);
  assert.ok(moving > shoulder * 1.1, `sweet ${moving} vs shoulder ${shoulder}`);
});

test('edge contact deflects the ball sideways and kills pace', () => {
  const cfg = noGravity();
  const geom = new BatGeometry(cfg.bat);
  const hand = new Vec3(0, 0.6 - geom.sweetY, -1.5 + geom.faceZ);
  const motion = makeMotion({ hand });
  const v = kmh(130);
  // Bat local +X is world -X for this pose; offset the ball to the world -X edge.
  const middle = runExact({ cfg, motion, tStart: 0, tEnd: 0.6, launch: { pos: new Vec3(0, 0.6, -12), vel: new Vec3(0, 0, v) } }).bat;
  const edge = runExact({ cfg, motion, tStart: 0, tEnd: 0.6, launch: { pos: new Vec3(-geom.bladeHalf.x * 0.82, 0.6, -12), vel: new Vec3(0, 0, v) } }).bat;
  assert.ok(edge, 'edge contact expected');
  assert.ok(edge.isEdge, 'flagged as edge');
  const dev = Math.asin(Math.abs(edge.vel.x) / edge.vel.length()) * 180 / Math.PI;
  assert.ok(dev > 10, `edge deflection ${dev}°`);
  assert.ok(edge.vel.length() < 0.8 * middle.vel.length(), 'edge is slower');
});

test('no tunnelling: stationary bat across the line, 110–150 km/h, 72/90/120 Hz, many phases', () => {
  const cfg = noGravity();
  const geom = new BatGeometry(cfg.bat);
  const hand = new Vec3(0, 0.6 - geom.sweetY, -1.5 + geom.faceZ);
  const motion = makeMotion({ hand });
  let runs = 0;
  for (const kmhSpeed of [110, 120, 130, 140, 150, 160]) {
    for (const fps of [72, 90, 120]) {
      for (let k = 0; k < 12; k++) {
        const phase = (k / 12) / fps;
        const { bat, world } = runFramed({
          cfg, motion, fps, tStart: 0, tEnd: 0.8, phase,
          launch: { pos: new Vec3(0.005 * (k - 6), 0.5 + 0.04 * k, -12), vel: new Vec3(0, 0, kmh(kmhSpeed)) },
        });
        assert.ok(bat, `missed contact at ${kmhSpeed} km/h, ${fps} Hz, phase ${k}`);
        assert.ok(world.ball.pos.z < -1.5, `ball got behind the bat at ${kmhSpeed} km/h ${fps} Hz`);
        runs++;
      }
    }
  }
  assert.equal(runs, 216);
});

test('no tunnelling: fast swinging bat (25 rad/s, ~14 m/s at the sweet spot) sampled at 72/90/120 Hz', () => {
  const cfg = noGravity();
  const geom = new BatGeometry(cfg.bat);
  const R = cfg.ball.radius;
  const hand = new Vec3(0, 1.15, -1.3);
  const omega = 25;
  const motion = makeMotion({ hand, omega });
  const yc = hand.y + geom.sweetY;
  const zc = hand.z - geom.faceZ - R;
  for (const kmhSpeed of [110, 130, 150]) {
    const v = kmh(kmhSpeed);
    const tStart = -0.35;
    const z0 = zc + v * tStart;
    const launch = { pos: new Vec3(0, yc, z0), vel: new Vec3(0, 0, v) };
    const ref = runExact({ cfg: cfgWith({ physics: { gravity: 0, substepHz: 20000 } }), motion, tStart, tEnd: 0.2, launch });
    assert.ok(ref.bat, 'reference contact');
    for (const fps of [72, 90, 120]) {
      for (let k = 0; k < 10; k++) {
        const { bat } = runFramed({ cfg, motion, fps, tStart, tEnd: 0.2, phase: (k / 10) / fps, launch });
        assert.ok(bat, `swing missed at ${kmhSpeed} km/h ${fps} Hz phase ${k}`);
        assert.ok(Math.abs(bat.local.y - ref.bat.local.y) < 0.03, `contact point drift ${bat.local.y} vs ${ref.bat.local.y}`);
        assert.ok(Math.abs(bat.t - ref.bat.t) < 0.003, `contact time drift ${bat.t} vs ${ref.bat.t}`);
        assert.ok(bat.vel.z < 0, 'ball driven back toward the bowler');
        const exitRatio = bat.vel.length() / ref.bat.vel.length();
        assert.ok(exitRatio > 0.95 && exitRatio < 1.05, `exit speed ratio ${exitRatio}`);
      }
    }
  }
});

test('genuine misses stay misses (ball passes under the toe of a swinging bat)', () => {
  const cfg = noGravity();
  const geom = new BatGeometry(cfg.bat);
  const hand = new Vec3(0, 1.15, -1.3);
  const motion = makeMotion({ hand, omega: 25 });
  const yc = hand.y + geom.toeY - 0.15;
  for (const fps of [72, 90, 120]) {
    const v = kmh(140);
    const { bat } = runFramed({ cfg, motion, fps, tStart: -0.35, tEnd: 0.2, launch: { pos: new Vec3(0, yc, -1.4 - v * 0.35), vel: new Vec3(0, 0, v) } });
    assert.equal(bat, undefined, `phantom contact at ${fps} Hz`);
  }
});

test('interpolated provider lerps position and slerps rotation between frames', () => {
  const prov = new InterpolatedBatProvider();
  const a = new Pose(new Vec3(0, 0, 0), new Quat());
  const b = new Pose(new Vec3(1, 0, 0), new Quat().setFromAxisAngle(new Vec3(0, 1, 0), Math.PI / 2));
  prov.push(0, a, a.p, new Vec3(), new Vec3());
  prov.push(1, b, b.p, new Vec3(), new Vec3());
  const mid = prov.poseAt(0.5, new Pose());
  assert.ok(Math.abs(mid.p.x - 0.5) < 1e-9);
  const expect = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), Math.PI / 4);
  assert.ok(mid.q.angleTo(expect) < 1e-6);
});

test('contact assist: a ball passing just under the toe or beside the blade is still played', async () => {
  const { PhysicsWorld, InterpolatedBatProvider } = await import('../src/physics/world.js');
  const { Pose, Quat } = await import('../src/physics/math.js');
  const cfg = noGravity();
  const geom = new BatGeometry(cfg.bat);
  // Bat hanging still, face to the bowler (+Z of the bat = -Z world).
  const q = new Quat(0, 1, 0, 0);
  const hand = new Vec3(0, 0.95, -1.5);
  const toeY = hand.y + geom.toeY;
  const shot = (pos, assist) => {
    const w = new PhysicsWorld(cfg, 1);
    const prov = new InterpolatedBatProvider();
    const bat = w.addBat('player', prov, geom);
    bat.assist = assist;
    prov.snap(0, new Pose(hand.clone(), q.clone()), hand.clone());
    w.launch({ pos, vel: new Vec3(0, 0, kmh(130)) });
    for (let t = 1 / 90; t < 0.6; t += 1 / 90) { prov.push(t, new Pose(hand.clone(), q.clone()), hand, new Vec3(), new Vec3()); w.advanceTo(t); }
    return w.drainEvents().find((e) => e.type === 'bat');
  };
  const under = new Vec3(0, toeY - 0.036 - 0.03, -12);         // 3 cm under the toe
  const beside = new Vec3(geom.bladeHalf.x + 0.036 + 0.03, 0.6, -12);
  assert.equal(shot(under, null), undefined, 'misses without assist');
  assert.equal(shot(beside, null), undefined, 'misses without assist');
  assert.ok(shot(under, { capture: 0.08, magnet: 0.3 }), 'played with assist');
  assert.ok(shot(beside, { capture: 0.08, magnet: 0.3 }), 'played with assist');
  assert.equal(shot(new Vec3(0, toeY - 0.036 - 0.15, -12), { capture: 0.08, magnet: 0.3 }), undefined, 'a clear miss is still a miss');
});
