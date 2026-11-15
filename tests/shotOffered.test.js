// Did you play at the ball? (src/game/shotOffered.js and the batting
// session's result / LBW path): read from the middle of the bat, so a wristy
// swing counts and lifting the bat out of the way does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShotEvidence, OFFER, pointVelocity, intoSpeed } from '../src/game/shotOffered.js';
import { Vec3, Quat, Pose } from '../src/physics/math.js';
import { BallState } from '../src/physics/ball.js';

const SWEET = 0.62;                 // m from your hand down the blade to its middle
const HZ = 72, T = 0.35;            // the delivery's last 0.35 s, as checkLive sees it
const head = { x: -0.25, z: -1.05 };

// Feed a scripted bat: pose(t) -> { p: hand, toe: unit (hand -> toe) }; velocities from the motion (as XR gives them).
function evidence(pose) {
  const E = new ShotEvidence(), dt = 1 / HZ, lin = new Vec3(), ang = new Vec3(), lever = new Vec3(), v = new Vec3(), mid = new Vec3();
  for (let i = 0; i * dt <= T; i++) {
    const t = i * dt, a = pose(t), b = pose(t + 1e-4);
    lin.set((b.p.x - a.p.x) / 1e-4, (b.p.y - a.p.y) / 1e-4, (b.p.z - a.p.z) / 1e-4);
    // angular velocity of the blade's direction: toe x dtoe/dt
    const dx = (b.toe.x - a.toe.x) / 1e-4, dy = (b.toe.y - a.toe.y) / 1e-4, dz = (b.toe.z - a.toe.z) / 1e-4;
    ang.set(a.toe.y * dz - a.toe.z * dy, a.toe.z * dx - a.toe.x * dz, a.toe.x * dy - a.toe.y * dx);
    lever.set(a.toe.x * SWEET, a.toe.y * SWEET, a.toe.z * SWEET);
    mid.copy(a.p).add(lever);
    E.add(pointVelocity(v, lin, ang, lever), mid, head, dt);
  }
  return E;
}
const hang = { x: 0.1, y: -0.95, z: 0.28 };
const norm = (v) => { const l = Math.hypot(v.x, v.y, v.z); return { x: v.x / l, y: v.y / l, z: v.z / l }; };
const still = () => ({ p: { x: 0.02, y: 0.8, z: -0.98 }, toe: norm(hang) });

test('the middle of the bat: lever arm x turning + the hand; up and back do not count', () => {
  const v = pointVelocity(new Vec3(), new Vec3(), new Vec3(10, 0, 0), new Vec3(0, -0.55, 0));
  assert.ok(Math.abs(v.length() - 5.5) < 1e-9 && v.z < 0, 'turning 10 rad/s, 0.55 m down the blade: 5.5 m/s toward the bowler');
  assert.equal(intoSpeed({ x: 0, y: 3, z: 2 }), 0, 'lifting the bat up and back is not at the ball');
  assert.equal(intoSpeed({ x: 0, y: -3, z: 0 }), 3);
});

test('a quiet leave, a leave with the bat lifted high, a waggle: no shot offered', () => {
  const quiet = evidence(still);
  // shouldering arms: the bat taken up over the shoulder, fast
  const lift = evidence((t) => { const k = Math.min(1, t / 0.2), a = 2.4 * k * k * (3 - 2 * k); return { p: { x: 0.02, y: 0.8 + 0.45 * k, z: -0.98 + 0.1 * k }, toe: norm({ x: 0.1, y: -Math.cos(a), z: Math.sin(a) }) }; });
  // tapping the bat up and down, 2.5 a second, 12 cm
  const waggle = evidence((t) => ({ p: { x: 0.02, y: 0.86 + 0.06 * Math.cos(t * 2.5 * 2 * Math.PI), z: -0.98 }, toe: norm(hang) }));
  for (const [n, E] of [['quiet', quiet], ['lift', lift], ['waggle', waggle]]) {
    assert.equal(E.offered, false, `${n}: read as a shot (peak ${E.peak.toFixed(2)} m/s, reach ${(E.s.reach * 100).toFixed(0)} cm)`);
    assert.equal(E.wild, false);
  }
});

test('a slow block, a wristy swing and miss, a full swing: shots offered (only the full swing is wild)', () => {
  // the bat brought forward to the ball, 1.2 m/s
  const block = evidence((t) => ({ p: { x: 0.02, y: 0.8 - 0.1 * t, z: -0.98 - 1.2 * t }, toe: norm(hang) }));
  // the hand still, the blade whipped round by the wrists at 10 rad/s (the old grip-speed reading saw 0)
  const wrist = evidence((t) => { const a = 1.2 - 10 * Math.max(0, t - 0.1); return { p: { x: 0.02, y: 0.95, z: -0.98 }, toe: norm({ x: 0.1, y: -Math.cos(a), z: Math.sin(a) }) }; });
  // a full drive: the bat round from the top at 20 rad/s, the hands coming through
  const drive = evidence((t) => { const a = 2.3 - 20 * Math.max(0, t - 0.15); return { p: { x: 0.02, y: 1.2 - 0.6 * Math.max(0, t - 0.15), z: -0.9 - 2 * Math.max(0, t - 0.15) }, toe: norm({ x: 0.1, y: -Math.cos(a), z: Math.sin(a) }) }; });
  assert.ok(block.offered && !block.wild, `block: peak ${block.peak.toFixed(2)} m/s, reach ${(block.s.reach * 100).toFixed(0)} cm`);
  assert.ok(wrist.offered && !wrist.wild, `wristy swing: peak ${wrist.peak.toFixed(2)} m/s`);
  assert.ok(drive.offered && drive.wild, `drive: peak ${drive.peak.toFixed(2)} m/s`);
  assert.ok(wrist.peak > OFFER.fast);
});

// The session's own path (checkLive), the way the review probe drove it: a missed nets ball and an LBW appeal.
let BattingSession = null;
try {
  const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => ({ addColorStop() {} })), set: (o, k, v) => { o[k] = v; return true; } });
  globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, style: {} }) };
  ({ BattingSession } = await import('../src/game/batting.js'));
} catch { BattingSession = null; }

test('the session: a wristy swing and miss is "beaten" and offers a shot to an LBW; a still bat is "left alone"', { skip: BattingSession ? false : 'three.js is not installed (npm install)' }, () => {
  const run = (angVel, padded) => {
    const ball = new BallState();
    ball.active = true; ball.pos.set(0, 0.3, -4); ball.vel.set(0, -1, 30);
    let result = null, lbw = null;
    const pose = new Pose(new Vec3(0.02, 0.95, -0.98), new Quat(0, 1, 0, 0));
    const g = { world: { ball }, realDt: 1 / HZ, rng: () => 0.5, diff: { lbwAgainstPlayer: true },
      input: { xr: true, headPose: { p: new Vec3(-0.25, 1.56, -1.05) }, right: { connected: true, linVel: new Vec3(), angVel } },
      playerBatProvider: { curr: { pose } }, batDistance: () => 1 };
    const s = Object.create(BattingSession.prototype);
    Object.assign(s, { game: g, path: [], offer: new ShotEvidence(), crossedCrease: true, hit: null, noBall: false, freeHit: false,
      field: padded ? { result: () => null } : null, lbw: { start: (o) => { lbw = o; } }, finish: (r) => { result = r; }, body: () => ({ x: -0.25, z: -1.05 }) });
    // the ball comes on through the last 7 m (a missed nets ball runs on past the stumps; an LBW one hits the pad)
    for (let z = -6.9; z < 0.5 && !lbw && !result; z += 0.4) { ball.pos.z = z; s.checkLive(z); }
    if (!padded) { ball.pos.z = 3; s.checkLive(1); }
    else { ball.pos.set(-0.25, 0.3, -1.0); s.checkLive(1); }
    return { result, lbw };
  };
  assert.deepEqual(run(new Vec3(10, 0, 0), false).result, { kind: 'beaten' });
  assert.deepEqual(run(new Vec3(0, 0, 0), false).result, { kind: 'left' });
  const a = run(new Vec3(10, 0, 0), true), b = run(new Vec3(0, 0, 0), true);
  assert.ok(a.lbw && a.lbw.shotOffered === true, 'wristy swing: shot offered to the LBW');
  assert.ok(b.lbw && b.lbw.shotOffered === false, 'still bat: no shot offered');
});
