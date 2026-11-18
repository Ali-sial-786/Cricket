// Your pads when you bat in the headset: the legs you see (not a box under your eyes),
// and the bat gets its go at a ball that has met them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BallState } from '../src/physics/ball.js';
import { Vec3, Quat, Pose } from '../src/physics/math.js';
import { ShotEvidence } from '../src/game/shotOffered.js';

let BattingSession = null;
try {
  const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => ({ addColorStop() {} })), set: (o, k, v) => { o[k] = v; return true; } });
  globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, style: {} }) };
  ({ BattingSession } = await import('../src/game/batting.js'));
} catch { BattingSession = null; }
const skip = BattingSession ? false : 'three.js is not installed (npm install)';

// head at (hx, -1.05); the feet planted `leg` m to its leg side; the bat `batD` m from the ball
function setup({ hx = 0, leg = 0.3, batD = 0.5, feet = true } = {}) {
  const ball = new BallState();
  ball.active = true; ball.vel.set(0, -1, 30);
  const out = { lbw: null, result: null };
  const S = { init: true, L: { x: hx - leg + 0.03, z: -1.15 }, R: { x: hx - leg, z: -0.79 } };
  const g = { world: { ball }, realDt: 1 / 72, rng: () => 0.5, diff: { lbwAgainstPlayer: true },
    input: { xr: true, headPose: { p: new Vec3(hx, 1.45, -1.05) }, right: { connected: true, linVel: new Vec3(), angVel: new Vec3() } },
    playerBatProvider: { curr: { pose: new Pose(new Vec3(hx + 0.3, 0.95, -1.0), new Quat(0, 1, 0, 0)) } },
    playerBody: feet ? { feet: { s: S } } : null, batD, batDistance: () => g.batD };
  const s = Object.create(BattingSession.prototype);
  Object.assign(s, { game: g, path: [], offer: new ShotEvidence(), crossedCrease: true, hit: null, noBall: false, freeHit: false,
    field: { result: () => null, keeperHold: false, keeperMissed: false }, lbw: { start: (o) => { out.lbw = o; } }, finish: (r) => { out.result = r; }, launchT: 0 });
  const at = (x, z, t) => { ball.pos.set(x, 0.3, z); s.checkLive(t); };
  return { s, g, ball, out, at };
}

test('your pads are the two legs your figure stands on; without a figure, the box under your stance', { skip }, () => {
  const a = setup({ hx: 0, leg: 0.3 });
  const P = a.s.pads();
  assert.equal(P.length, 2);
  assert.ok(Math.abs(P[0].x + 0.27) < 1e-9 && P[0].z === -1.15 && P[1].z === -0.79, JSON.stringify(P));
  const b = setup({ feet: false });
  b.s.body = () => ({ x: -0.2, z: -1.05 });
  assert.equal(b.s.pads().length, 1);
});

test('a ball under your eyes, your legs 0.3 m to the leg side of them: no pad in its way', { skip }, () => {
  const { at, out, s } = setup({ hx: 0, leg: 0.3 });
  for (let z = -1.6, t = 1; z < -0.72; z += 0.1, t += 0.01) at(0, z, t);
  assert.equal(out.lbw, null); assert.ok(!s.padPending);
});

test('a ball into your front leg with the bat playing at it: the bat gets its go, and a hit means it never touched the pad', { skip }, () => {
  const { at, out, s, ball } = setup({ hx: 0, leg: 0.3, batD: 0.5 });
  at(-0.27, -1.5, 1); at(-0.27, -1.2, 1.01);
  assert.ok(s.padPending, 'waiting on the bat'); assert.equal(out.lbw, null); assert.equal(ball.padded, false);
  ball.batted = true; s.hit = { t: 1.015 };                // the bat gets there, 10 cm on
  at(-0.27, -1.1, 1.02);
  assert.ok(!s.padPending); assert.equal(out.lbw, null);
});

test('the bat misses it: the ball goes back to where it struck the pad, and that is the LBW shout', { skip }, () => {
  const { at, out, s, ball } = setup({ hx: 0, leg: 0.3, batD: 0.5 });
  at(-0.27, -1.5, 1); at(-0.27, -1.2, 1.01); at(-0.27, -0.9, 1.02);
  assert.equal(out.lbw, null, 'still the bat\'s go');
  at(-0.27, -0.6, 1.03);                                   // past where a late bat could reach (and well short of the stumps)
  assert.ok(out.lbw, 'given to the pad');
  assert.ok(Math.abs(out.lbw.impactState.pos.z + 1.2) < 1e-9, 'impact where it met the pad');
  assert.ok(ball.padded && Math.abs(ball.pos.z + 1.2) < 1e-9 && ball.vel.z < 0, 'the ball comes off the pad there');
});

test('a bat nowhere near (a leave): the pad at once', { skip }, () => {
  const { at, out, ball } = setup({ hx: 0, leg: 0.3, batD: 1.5 });
  at(-0.27, -1.5, 1); at(-0.27, -1.2, 1.01);
  assert.ok(out.lbw && ball.padded);
});

test('the bat right on the ball all the way through: it goes on (no pad), as before', { skip }, () => {
  const { at, out, s } = setup({ hx: 0, leg: 0.3, batD: 0.2 });
  at(-0.27, -1.5, 1); at(-0.27, -1.2, 1.01); at(-0.27, -0.9, 1.02); at(-0.27, -0.6, 1.03);
  assert.equal(out.lbw, null); assert.ok(!s.padPending);
});
